import * as vscode from "vscode";
import * as agents from "../services/agents.ts";
import { updateCommandForInstallation } from "../services/agent-versions.ts";
import { MutationQueue, runMutation } from "../ui/mutation-queue.ts";
import { assertIdle, pickOne } from "../ui/flows.ts";
import { showError } from "./errors.ts";
import { withProgress } from "./progress.ts";

export interface AgentDeps {
  // 同步根解析：单根直接返回，多根/未选时经 T6 pickProjectRoot 引导用户选择（决议 1）
  resolveRoot: () => Promise<string | null>;
  queue: MutationQueue;
  refresh: () => void;
}

// 初始化只选一次作用域：auth 与 sessions 是两个独立维度，但用户视角里两次"global/project"
// 选择题是同一个问题被问两遍（且后一次显得"才生效"）。合并为一次 QuickPick，每个选项是
// 一个完整组合；之后需要混合或调整时再分别走 switchAuth / switchSessions。
const INIT_MODES = [
  { label: "项目域（认证 + 会话）", description: "认证存在项目内（被 gitignore），会话随项目入库，可迁移", value: { auth: "project", sessions: "project" } },
  { label: "全局域（认证 + 会话）", description: "认证与会话都走系统级目录，项目只留运行时配置", value: { auth: "global", sessions: "global" } },
  { label: "认证全局 / 会话项目", description: "认证走系统级目录；会话随项目入库", value: { auth: "global", sessions: "project" } },
  { label: "认证项目 / 会话全局", description: "项目内放临时认证；会话走系统级目录", value: { auth: "project", sessions: "global" } },
] as const;

export function registerAgentsCommands(context: vscode.ExtensionContext, deps: AgentDeps): void {
  // 决议 1：交互（resolveRoot / 选择）在队列外，仅 mutation 服务调用进 queue.run；
  // 决议 2：busy 守卫在命令体最前（spec §6 进行中时相关命令禁用），提示并返回不入队；
  // runMutation 保证成功/失败都 refresh（T8 Minor A）。
  const register = (id: string, fn: (treeItem?: vscode.TreeItem) => Promise<void>) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, async (treeItem?: vscode.TreeItem) => {
      try {
        // try/catch 覆盖整个命令体：resolveRoot / QuickPick 的拒绝同样经 showError 呈现
        await fn(treeItem);
      } catch (err) { await showError(err); }
    }));

  const busy = () => !assertIdle(deps.queue, (message) => void vscode.window.showWarningMessage(message));

  // 树节点触发时 args[0] 是 T5 的 TreeItem（item.id 已设为 agent id）；命令面板触发时走 QuickPick
  const agentTarget = async (treeItem?: vscode.TreeItem): Promise<{ root: string; id: string } | null> => {
    const root = await deps.resolveRoot();
    if (root === null) { await vscode.window.showWarningMessage("未选择项目文件夹"); return null; }
    const id = treeItem?.id ?? (await vscode.window.showQuickPick(agents.listAgents().map((a) => ({ label: a.displayName, id: a.id }))))?.id;
    return id === undefined ? null : { root, id };
  };

  register("avenic.agents.init", async (treeItem) => {
    if (busy()) return;
    const target = await agentTarget(treeItem);
    if (target === null) return;
    // 交互（作用域组合一次选择）在队列外完成；仅 initialize 突变进队列（W2a）
    const mode = await pickOne([...INIT_MODES], async (items) => vscode.window.showQuickPick(items));
    if (mode === undefined) return;
    await runMutation(deps.queue, () => withProgress("Avenic Agent 操作", (report) => agents.initialize(target.root, target.id, mode.value.auth, mode.value.sessions).then(() => { report("完成"); })), () => deps.refresh());
  });

  register("avenic.agents.configureProject", async () => {
    if (busy()) return;
    const root = await deps.resolveRoot();
    if (root === null) return;
    const current = await agents.readProjectConfiguration(root);
    const selected = await vscode.window.showQuickPick(
      agents.listAgents().map((agent) => ({ label: agent.displayName, id: agent.id, picked: Object.hasOwn(current.agents, agent.id) })),
      { canPickMany: true, title: "Avenic: Select agents" },
    );
    if (selected === undefined || selected.length === 0) return;
    const draft: agents.ProjectAgentSettings = {};
    for (const selectedAgent of selected) {
      const previous = current.agents[selectedAgent.id] ?? { auth: "global", sessions: "project" };
      const auth = await vscode.window.showQuickPick(["global", "project"], { title: `${selectedAgent.label}: Authentication (current: ${previous.auth})` });
      if (auth === undefined) return;
      const sessions = await vscode.window.showQuickPick(["global", "project"], { title: `${selectedAgent.label}: Session storage (current: ${previous.sessions})` });
      if (sessions === undefined) return;
      draft[selectedAgent.id] = { auth: auth as "global" | "project", sessions: sessions as "global" | "project" };
    }
    const history = await vscode.window.showQuickPick([
      { label: "Shared", value: "shared" as const, description: "Selected agents can continue the same Avenic history" },
      { label: "Isolated", value: "isolated" as const, description: "Each agent keeps independent histories" },
    ], { title: `Avenic: Session history (current: ${current.sessionInterop})` });
    if (history === undefined) return;
    await runMutation(deps.queue, () => withProgress("Avenic project configuration", (report) =>
      agents.configureProjectRuntime(root, draft, history.value).then(() => { report("Completed"); }),
    ), () => deps.refresh());
  });

  // 安装/升级官方 Agent CLI（npm @latest）：集成终端实时输出 npm 进度（无文字按钮，
  // 键位图标区分：安装 cloud-download / 升级 arrow-up）。两条命令共用同一 npm line；
  // 终端关闭后作废版本缓存并刷新，让「可升级」/「CLI 未安装」态即时退场。
  const runCliInstall = async (treeItem?: vscode.TreeItem) => {
    if (busy()) return;
    const target = await agentTarget(treeItem);
    if (target === null) return;
    const command = updateCommandForInstallation(target.id, agents.detectInstallation(target.id));
    if (command === null) {
      await vscode.window.showWarningMessage(`Avenic detected a manual or unknown ${target.id} installation. It will not update a different npm copy; use that installation's updater.`);
      return;
    }
    const terminal = vscode.window.createTerminal({ name: `Avenic · ${target.id}` });
    const closeListener = vscode.window.onDidCloseTerminal((closed) => {
      if (closed !== terminal) return;
      closeListener.dispose();
      agents.invalidateCliVersionCache(target.id);
      deps.refresh();
    });
    terminal.show();
    terminal.sendText(command);
  };
  register("avenic.agents.install", runCliInstall);
  register("avenic.agents.update", runCliInstall);

  register("avenic.agents.launch", async (treeItem) => {
    if (busy()) return;
    const target = await agentTarget(treeItem);
    if (target === null) return;
    const status = await agents.agentStatus(target.root, target.id);
    if (status.effective === null) {
      await vscode.window.showWarningMessage(`${status.agent.displayName} 尚未初始化，请先执行「Avenic: 初始化 Agent」`);
      return;
    }
    if (!status.executableAvailable) {
      await vscode.window.showWarningMessage(`未找到 ${status.agent.displayName} 官方可执行文件（${status.agent.executable}），请先安装官方 CLI`);
      return;
    }
    const prepared = await runMutation(deps.queue, () => agents.prepareAgentLaunch(target.root, target.id), () => deps.refresh());
    const { definition, finishRun } = prepared;
    if (definition.note !== null) {
      // 模型配置没能生效（spec §13：不静默跳过）——启动照常进行，但必须让用户看见原因。
      void vscode.window.showWarningMessage(definition.note);
    }
    const terminal = vscode.window.createTerminal({ name: definition.name, cwd: definition.cwd, env: definition.environment });
    const closeListener = vscode.window.onDidCloseTerminal((closed) => {
      if (closed !== terminal) return;
      closeListener.dispose();
      void finishRun().catch((error) => showError(error));
    });
    terminal.show();
    terminal.sendText(definition.command);
  });

  register("avenic.agents.deinit", async (treeItem) => {
    if (busy()) return;
    const target = await agentTarget(treeItem);
    if (target === null) return;
    await runMutation(deps.queue, () => withProgress("Avenic Agent 操作", (report) => agents.deinitialize(target.root, target.id).then(() => { report("完成"); })), () => deps.refresh());
  });

  register("avenic.agents.switchAuth", async (treeItem) => {
    if (busy()) return;
    const target = await agentTarget(treeItem);
    if (target === null) return;
    const status = await agents.agentStatus(target.root, target.id);
    const currentLabel = status.effective?.auth ?? "未配置";
    const chosen = await vscode.window.showQuickPick([{ label: currentLabel, description: "当前" }, { label: "global" }, { label: "project" }, { label: "reset" }]);
    if (chosen === undefined || chosen.label === currentLabel) return;
    await runMutation(deps.queue, () => withProgress("Avenic Agent 操作", (report) => agents.setAuthMode(target.root, target.id, chosen.label as "global" | "project" | "reset").then(() => { report("完成"); })), () => deps.refresh());
  });

  register("avenic.agents.switchSessions", async (treeItem) => {
    if (busy()) return;
    const target = await agentTarget(treeItem);
    if (target === null) return;
    const status = await agents.agentStatus(target.root, target.id);
    const currentLabel = status.effective?.sessions ?? "未配置";
    const chosen = await pickOne([{ label: currentLabel, description: "当前" }, { label: "global" }, { label: "project" }], async (items) => vscode.window.showQuickPick(items));
    if (chosen === undefined || chosen.label === currentLabel) return;
    await runMutation(deps.queue, () => withProgress("Avenic Agent 操作", (report) => agents.setSessionsMode(target.root, target.id, chosen.label as "global" | "project").then(() => { report("完成"); })), () => deps.refresh());
  });

  register("avenic.agents.sessionsImport", async (treeItem) => {
    if (busy()) return;
    const target = await agentTarget(treeItem);
    if (target === null) return;
    const result = await runMutation(deps.queue, () => withProgress("Avenic Agent 操作", (report) => agents.importSessions(target.root, target.id).then((r) => { report("完成"); return r; })), () => deps.refresh());
    const message = `发现 ${result.discovered} 个会话；导入 ${result.imported} 个；未变更 ${result.unchanged} 个；失败 ${result.failed} 个。`;
    if ((result.discovered === 0 || result.failed > 0) && result.diagnostics.length > 0) await vscode.window.showWarningMessage(`${message} ${result.diagnostics[0]}`);
    else await vscode.window.showInformationMessage(message);
  });

  register("avenic.agents.sessionsWriteback", async (treeItem) => {
    if (busy()) return;
    const target = await agentTarget(treeItem);
    if (target === null) return;
    const result = await runMutation(deps.queue, () => withProgress("Avenic Agent 操作", (report) => agents.writebackSessions(target.root, target.id).then((r) => { report("完成"); return r; })), () => deps.refresh());
    await vscode.window.showInformationMessage(`已写回 ${result.count} 个会话`);
  });
}
