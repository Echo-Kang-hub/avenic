import * as vscode from "vscode";
import { getAgent, readCanonicalSessionRecord, setActiveCanonicalSession } from "@avenic/core";
import { AGENT_IDS, type AgentId, type DashboardAction, type DashboardSection } from "../dashboard/protocol.ts";
import { DashboardPanel } from "../dashboard/panel.ts";
import { projectStatus } from "../services/agents.ts";
import * as skills from "../services/skills.ts";
import { defaultSpec, sync } from "../services/catalog.ts";
import { continueSession } from "../services/continue.ts";
import { MutationQueue, runMutation } from "../ui/mutation-queue.ts";
import { importSkillsFlow, type ImportUi } from "../ui/skill-import.ts";
import type { ActivityLog } from "../ui/activity.ts";
import { showError } from "./errors.ts";
import { withProgress } from "./progress.ts";

// 面板上每一个按钮落到哪里。面板自己不认识业务，这一层也不重写业务：能对应一条已有
// 命令的就调那条命令（启动走 avenic.agents.launch，配置走 avenic.agents.configureProject），
// 只有面板新带来的动作才在这里实现，而且每一种都说得出它问的是谁。Import Skill 是后
// 一类里最新的一条：它走的不是命令面板里那条一次装完整仓的旧命令（avenic.skills.addDirect），
// 而是下面 importUi + importSkillsFlow 那场与 CLI 的 Add 同序、同问题的问答。两条入口
// 问的问题因此不同，这是有意的——面板问全，旧命令保持它原本的行为；业务两边都只有
// core 的那一份 installer。

export interface DashboardDeps {
  context: vscode.ExtensionContext;
  root: () => string | null;
  queue: MutationQueue;
  refresh: () => void;
  activity: ActivityLog;
}

export function registerDashboardCommands(deps: DashboardDeps): void {
  const { context, activity, queue, refresh } = deps;
  const panel = (section?: DashboardSection) => DashboardPanel.show(context, { root: deps.root, dispatch: (action) => void handle(action) }, () => activity.rows(), section);
  const register = (id: string, fn: () => void) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  // 两个入口进的是同一块面板，只是落点不同：「Avenic」从概览开始，「Sessions」直接
  // 停在会话分区。命令名各自写全（不走前缀模板），因为这是两个不同的命名空间。
  register("avenic.dashboard.open", () => {
    panel();
    activity.record("Dashboard opened");
  });
  register("avenic.sessions.open", () => {
    panel("sessions");
    activity.record("Dashboard opened");
  });
  // 刷新由 deps.refresh 统一做（它清缓存、刷每个可见视图，面板也在这条链上）。

  const projectRoot = async (): Promise<string | null> => {
    const root = deps.root();
    if (root === null) await vscode.window.showWarningMessage("Open a project folder first.");
    return root;
  };

  // 继续一条会话：接手的 agent 由映射回答（谁在这条对话里出现过），多于一个才问。
  const continueWith = async (canonicalId: string, agentId: string): Promise<void> => {
    const root = await projectRoot();
    if (root === null) return;
    const name = getAgent(agentId).displayName;
    await runMutation(queue, () => withProgress(`Avenic · Continuing with ${name}`, () => continueSession(root, canonicalId, agentId, {
      run: (definition) => runInTerminal(definition.name, definition.cwd, definition.environment, definition.command),
      log: (line) => activity.record(line, "muted"),
    })), () => refresh());
    activity.record(`${name} session continued`);
  };

  const successors = async (root: string, canonicalId: string): Promise<AgentId[]> => {
    try {
      const { mappings } = await readCanonicalSessionRecord(root, canonicalId);
      return AGENT_IDS.filter((agent) => typeof mappings.projections?.[agent]?.nativeSessionId === "string");
    } catch {
      return [];
    }
  };

  const handle = async (action: DashboardAction): Promise<void> => {
    try {
      const root = deps.root();
      switch (action.action) {
        case "launch": {
          // 活动日志记在事情真的发生之后：这条命令自己知道它有没有跑起来（CLI 没装、
          // 没配置都挡在它前面），面板不能在它回答之前就写下「会话已开始」。
          const started = await vscode.commands.executeCommand<boolean>("avenic.agents.launch", { id: action.agent });
          if (started === true) activity.record(`${getAgent(action.agent).displayName} session started`);
          return;
        }
        case "reconfigure":
        case "change":
        case "initialize":
        case "switchHistory":
          // 修改、初始化与切换历史模式是同一场问答的不同入口：问题与写盘都在 core
          // 的 projectDraft/applyProjectDraft 里，插件不另做一套。
          await vscode.commands.executeCommand("avenic.agents.configureProject");
          return;
        case "openConfig":
          await openAgentConfiguration(root, action.agent);
          return;
        case "continueNative":
          await continueWith(action.id, action.agent);
          return;
        case "continueShared": {
          if (root === null) return;
          const candidates = await successors(root, action.id);
          if (candidates.length === 0) {
            await vscode.window.showWarningMessage("No agent has a session for this conversation yet. Launch one first.");
            return;
          }
          const chosen = candidates.length === 1
            ? candidates[0]
            : (await vscode.window.showQuickPick(candidates.map((id) => ({ label: getAgent(id).displayName, id })), { title: "Continue with" }))?.id;
          if (chosen === undefined) return;
          await continueWith(action.id, chosen);
          return;
        }
        case "viewSession":
          await panel().open(action.id);
          return;
        case "setActive": {
          if (root === null) return;
          await setActiveCanonicalSession(root, action.id);
          refresh();
          return;
        }
        case "importSkill":
          await importSkill(root);
          return;
        case "installPack":
          await installPack(root, action.pack);
          return;
        case "syncHub":
          await syncHub();
          return;
        case "manageSkills":
          await vscode.commands.executeCommand("avenic.skills.installPacks");
          return;
        case "viewLogs":
          activity.show();
          return;
        case "openDocs":
          // 随包 README 就是这份插件的文档：不在运行时去取远程页面，VSIX 里有的
          // 东西才保证「点开就有」。
          await vscode.commands.executeCommand("markdown.showPreview", vscode.Uri.joinPath(context.extensionUri, "README.md"));
          return;
        case "openSettings":
          await vscode.commands.executeCommand("workbench.action.openSettings", `@ext:${context.extension.id}`);
          return;
        case "openFolder":
          if (root === null) return;
          await reveal(vscode.Uri.file(root), { pick: ".agents", fallback: "skills" });
          return;
        case "revealProject":
          // 标题栏路径后面那个箭头：它指着这个项目，所以打开的是这个项目本身。
          if (root === null) return;
          await reveal(vscode.Uri.file(root), { pick: null, fallback: null });
          return;
        case "openProject":
          // 一个项目都没打开的时候，「初始化」要打开的那场问答没有目录可写。让 VS Code
          // 自己去问要打开哪个文件夹——打开之后扩展会被重新激活，这一页也跟着重读。
          await vscode.commands.executeCommand("workbench.action.files.openFolder");
          return;
        case "openInTerminal":
          if (root === null) return;
          vscode.window.createTerminal({ name: "Avenic", cwd: root }).show();
          return;
        default:
          return;
      }
    } catch (error) {
      await showError(error);
    }
  };

  // 面板上的技能导入是 CLI 那场 Add 问答（来源 → 发现 → 多选 → Install to → Scope →
  // 确认）在编辑器里的同一份实现：顺序、问题与每一步的后果在 ui/skill-import.ts 里，
  // 这里只把宿主接上去——提示走 VS Code 自己的输入框/多选/确认，长活走同一个 mutation
  // 队列与进度条，业务仍然是 core 的那一份（services/skills.ts 的 importService）。
  // 默认作用域是项目：按钮就长在这个项目的面板里，但全局也是 CLI 认的一个作用域，所以
  // 它作为一个选项存在，而不是由插件替用户假定。
  const importUi = (): ImportUi => ({
    askSource: async () => vscode.window.showInputBox({ prompt: "owner/repo or repository URL", placeHolder: "owner/repo" }),
    pickMany: async (title, items) => (await vscode.window.showQuickPick(items, { title, canPickMany: true }))?.map((item) => item.value),
    pickOne: async (title, items) => (await vscode.window.showQuickPick(items, { title }))?.value,
    confirm: async (title, summary) => (await vscode.window.showWarningMessage(title, {
      modal: true,
      detail: [
        `Source: ${summary.source}`,
        `Skills: ${summary.skills}`,
        `Targets: ${summary.targets}`,
        `Scope: ${summary.scope}`,
        `Config: ${summary.config}`,
      ].join("\n"),
    }, "Install")) === "Install",
    info: (message) => void vscode.window.showInformationMessage(message),
    warn: (message) => void vscode.window.showWarningMessage(message),
    progress: (title, work) => runMutation(queue, () => withProgress(title, work), () => refresh()),
  });

  async function importSkill(root: string | null): Promise<void> {
    if (root === null) return;
    const outcome = await importSkillsFlow(skills.importService(root), importUi());
    if (outcome.kind === "cancelled") return;
    activity.record(outcome.kind === "installed"
      ? `Imported ${outcome.names.length} skill(s) from ${outcome.repo} · ${outcome.label}`
      : `Already installed: ${outcome.repo}`);
  }

  // 面板上那一行 Pack 说的是「装这个」：用户已经点过的那一步不该再问一遍，所以安装
  // 不再走命令面板那条会先问作用域的命令，而是走它内部用的同一个实现——作用域仍然是
  // 这个项目，理由与 Import Skill 一样（按钮就长在这个项目的面板里）。
  async function installPack(root: string | null, packId: string): Promise<void> {
    if (root === null) return;
    const result = await runMutation(queue, () => withProgress("Avenic · Installing pack", () => skills.installPacks("project", [packId], root)), () => refresh());
    activity.record(`Pack installed: ${result.resolvedPacks.names.join(", ")}`);
  }

  // Registry 是 state 目录里的一份 checkout：同步是去拉它，与项目无关，但拉完要更新
  // 的正是这个面板（Packs 列表从这里来），所以它也在这条链上。
  async function syncHub(): Promise<void> {
    const spec = await defaultSpec();
    if (spec === null) {
      await vscode.window.showWarningMessage("No registry is configured for this project.");
      return;
    }
    await runMutation(queue, () => withProgress("Avenic · Syncing registry", async (report) => {
      report("Fetching the registry…");
      return sync(spec);
    }), () => refresh());
    activity.record(`Registry synced: ${spec}`);
  }

  // 打开一个 agent 自己的配置：路径由 core 给出（API 配置说的就是那个文件，Account
  // 说的是它自己的 home）。core 说不出路径时，那句话本身就是回答——不猜一个。
  async function openAgentConfiguration(root: string | null, agentId: AgentId): Promise<void> {
    if (root === null) return;
    const status = await projectStatus(root);
    const row = status.agents.find((agent) => agent.id === agentId);
    const configuration = row?.auth?.configuration ?? null;
    if (configuration?.relative) {
      const file = vscode.Uri.file(`${root}/${configuration.relative}`);
      if (await exists(file)) { await vscode.window.showTextDocument(file); return; }
      await reveal(file, { pick: null, fallback: null });
      return;
    }
    const home = row?.auth?.home ?? null;
    if (home !== null) { await reveal(vscode.Uri.file(resolveHome(home, root)), { pick: null, fallback: null }); return; }
    // OpenCode：它的认证与 provider 都在自己手里，core 没有（也不该有）一条 Avenic
    // 能指向的路径。项目里若确实有它的配置文件，就打开那个；没有就直说。
    for (const candidate of ["opencode.json", ".opencode"]) {
      const target = vscode.Uri.file(`${root}/${candidate}`);
      if (await exists(target)) { await reveal(target, { pick: null, fallback: null }); return; }
    }
    void vscode.window.showInformationMessage(`${getAgent(agentId).displayName} keeps its own authentication and provider configuration; Avenic has no file of its own to open.`);
  }

  function resolveHome(home: string, root: string): string {
    return home.startsWith("~") ? home.replace(/^~/, process.env.USERPROFILE ?? process.env.HOME ?? root) : `${root}/${home}`;
  }

  async function exists(uri: vscode.Uri): Promise<boolean> {
    try { await vscode.workspace.fs.stat(uri); return true; } catch { return false; }
  }

  // 先在文件管理器里选中目标，再退回打开它所在的目录：Windows 上 revealFileInOS
  // 只能选中文件，目录会抛错——两种情况都要给出同一个可见结果。
  async function reveal(uri: vscode.Uri, fallback: { pick: string | null; fallback: string | null }): Promise<void> {
    try {
      await vscode.commands.executeCommand("revealFileInOS", uri);
      return;
    } catch { /* 目录或路径不存在 */ }
    let directory = uri;
    for (const part of [fallback.pick, fallback.fallback]) {
      if (part === null) continue;
      const candidate = vscode.Uri.joinPath(directory, part);
      if (await exists(candidate)) { directory = candidate; break; }
    }
    try { await vscode.env.openExternal(directory); } catch { /* 打不开就算了，动作本身不承诺 */ }
  }

  // 一次启动：终端里跑官方 CLI，关闭时把退出码交回给调用方。面板里的「继续」靠它
  // 才知道这一次到底跑起来了没有（跑不成就不写映射）。
  function runInTerminal(name: string, cwd: string, environment: Record<string, string>, command: string): Promise<number | null> {
    return new Promise((resolve) => {
      const terminal = vscode.window.createTerminal({ name, cwd, env: environment });
      const closeListener = vscode.window.onDidCloseTerminal((closed) => {
        if (closed !== terminal) return;
        closeListener.dispose();
        resolve(closed.exitStatus?.code ?? null);
      });
      terminal.show();
      terminal.sendText(command);
    });
  }
}
