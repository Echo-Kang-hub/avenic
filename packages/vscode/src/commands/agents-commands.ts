import * as vscode from "vscode";
import { applyProjectDraft, formatSessionDiagnostics, modelConfigPresence, projectDraft, projectWizardSteps } from "@avenic/core";
import { releaseSummary } from "../services/agents.ts";
import type { ProjectDraft } from "@avenic/core";
import * as agents from "../services/agents.ts";
import { updateCommandForInstallation } from "../services/agent-versions.ts";
import { en, sentence } from "../i18n/text.ts";
import { MutationQueue, runMutation } from "../ui/mutation-queue.ts";
import { assertIdle } from "../ui/flows.ts";
import { runProjectWizard } from "../ui/project-wizard.ts";
import { quickPickHost } from "../ui/quickpick-wizard.ts";
import { showError } from "./errors.ts";
import { watchRun } from "./run-lifecycle.ts";
import { withProgress } from "./progress.ts";

export interface AgentDeps {
  // 同步根解析：单根直接返回，多根/未选时经 T6 pickProjectRoot 引导用户选择（决议 1）
  resolveRoot: () => Promise<string | null>;
  queue: MutationQueue;
  refresh: () => void;
}

export function registerAgentsCommands(context: vscode.ExtensionContext, deps: AgentDeps): void {
  // 决议 1：交互（resolveRoot / 选择）在队列外，仅 mutation 服务调用进 queue.run；
  // 决议 2：busy 守卫在命令体最前（spec §6 进行中时相关命令禁用），提示并返回不入队；
  // runMutation 保证成功/失败都 refresh（T8 Minor A）。
  // 命令体的返回值原样交回给调用方：`executeCommand<boolean>("avenic.agents.launch")`
  // 就是靠它知道这一次到底跑起来没有（仪表盘据此决定活动日志写不写），所以包装层
  // 不能把答案吃掉——它只负责把抛出的错误翻译成提示。
  const register = (id: string, fn: (treeItem?: vscode.TreeItem) => Promise<unknown>) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, async (treeItem?: vscode.TreeItem): Promise<unknown> => {
      try {
        // try/catch 覆盖整个命令体：resolveRoot / QuickPick 的拒绝同样经 showError 呈现
        return await fn(treeItem);
      } catch (err) { await showError(err); return undefined; }
    }));

  const busy = () => !assertIdle(deps.queue, (key) => void vscode.window.showWarningMessage(sentence(vscode.env.language, key)));

  // 树节点触发时 args[0] 是 T5 的 TreeItem（item.id 已设为 agent id）；命令面板触发时走 QuickPick
  const agentTarget = async (treeItem?: vscode.TreeItem): Promise<{ root: string; id: string } | null> => {
    const root = await deps.resolveRoot();
    if (root === null) { await vscode.window.showWarningMessage(sentence(vscode.env.language, "ui.no-folder")); return null; }
    const id = treeItem?.id ?? (await vscode.window.showQuickPick(agents.listAgents().map((a) => ({ label: a.displayName, id: a.id }))))?.id;
    return id === undefined ? null : { root, id };
  };

  // 初始化与配置是同一场问答的两种模式：目录还没配过就是初始化（第一步标题
  // "Select agents"），配过就是修改（"Select enabled agents"，各步预选当前值）。问题与
  // 写盘都来自 core，VS Code 只负责画 —— 与 `avenic init` / `avenic change` 同一份步骤。
  // 逐行的「切换认证」「切换会话」不另做一套问题：方法、作用域、会话都在这一场里答。
  register("avenic.agents.configureProject", async () => {
    if (busy()) return;
    const root = await deps.resolveRoot();
    if (root === null) {
      // 活动栏那一行正是在没有文件夹的时候画出来的，所以这一击必须给出下一步，
      // 不能静默返回（否则就是一行点了没反应的入口）。多根工作区里按下 Esc 是
      // 另一种情况：那是用户自己取消的，不再追问。
      if ((vscode.workspace.workspaceFolders ?? []).length === 0) {
        const open = en("shell.open-folder");
        const answer = await vscode.window.showWarningMessage(sentence(vscode.env.language, "agents.configure-nofolder"), open);
        if (answer === open) await vscode.commands.executeCommand("workbench.action.files.openFolder");
      }
      return;
    }
    const current = await agents.readProjectConfiguration(root);
    const editing = Object.keys(current.agents).length > 0;
    // 修改时每一步都预选当前值。API 那一侧带上的是文件本身在不在、是不是 Avenic
    // 创建且没人动过 —— 「换了答案之后旧文件怎么办」这一问只对这样的文件存在。
    const draft = projectDraft(current, { files: await modelConfigPresence(root, current.agents) });
    const host = quickPickHost<ProjectDraft>();
    try {
      // 整轮问答在队列外；只有提交那一刻的写入进队列（决议 1 / W2a）。
      const outcome = await runProjectWizard(
        draft,
        (unfinished: ProjectDraft) => projectWizardSteps(unfinished, editing),
        host,
        async (finished) => {
          // 删除旧配置的二次确认是问卷里的一步（core 的 switch-confirm），不再在写盘
          // 期间弹模态：写盘一旦开始，取消就够不着它了，而同一按键也不该同时决定两帧。
          return runMutation(deps.queue, () => withProgress("Avenic project configuration", (report) =>
            applyProjectDraft(root, finished).then((result) => { report("Completed"); return result; }),
          ), () => deps.refresh());
        },
      );
      if (!outcome.applied || outcome.result === null) return;
      // 一句话说清这一轮到底改了什么，尤其是「旧配置留着还是删了」——以及给不回来
      // 的那种键（组成在 services/releaseSummary，与 CLI 说同一组事实）。
      const detail = releaseSummary(outcome.result.released ?? [], vscode.env.language);
      const what = sentence(vscode.env.language, editing ? "agents.config-updated" : "agents.initialized");
      await vscode.window.showInformationMessage(`Avenic ${what}${detail ? ` · ${detail}` : ""} · ${root}`);
    } finally {
      host.dispose();
    }
  });

  // 安装/升级官方 Agent CLI（npm @latest）：集成终端实时输出 npm 进度（无文字按钮，
  // 键位图标区分：安装 cloud-download / 升级 arrow-up）。两条命令共用同一 npm line；
  // 终端关闭后作废版本缓存并刷新，让「可升级」/「CLI 未安装」态即时退场。
  const runCliInstall = async (treeItem?: vscode.TreeItem) => {
    if (busy()) return;
    const target = await agentTarget(treeItem);
    if (target === null) return;
    const command = updateCommandForInstallation(target.id, await agents.detectInstallation(target.id));
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

  // 返回值是「这一次真的跑起来了吗」：调用它的人（仪表盘）要用这个答案决定活动日志
  // 里写不写「会话已开始」。树视图不看返回值，命令面板也不看——只有面板需要知道。
  register("avenic.agents.launch", async (treeItem) => {
    if (busy()) return false;
    const target = await agentTarget(treeItem);
    if (target === null) return false;
    const status = await agents.agentStatus(target.root, target.id);
    if (!status.initialized) {
      // 与 prepareAgentLaunch 抛的是同一个键：这是同一件事，两处各写一遍就会各说各的。
      await vscode.window.showWarningMessage(sentence(vscode.env.language, "agent.not-initialized", { agent: status.agent.displayName }));
      return false;
    }
    if (!status.executableAvailable) {
      await vscode.window.showWarningMessage(sentence(vscode.env.language, "agent.no-executable", { agent: status.agent.displayName, executable: status.agent.executable }));
      return false;
    }
    const prepared = await runMutation(deps.queue, () => agents.prepareAgentLaunch(target.root, target.id, { language: vscode.env.language }), () => deps.refresh());
    const { definition, finishRun } = prepared;
    if (definition.note !== null) {
      // core 说了这次启动为什么和配置不一样（还没有认证方式、API 配置还没写入、
      // 凭据要从你自己的环境里读）——启动照常进行，但原因必须让用户看见，不静默跳过。
      void vscode.window.showWarningMessage(definition.note);
    }
    const terminal = vscode.window.createTerminal({ name: definition.name, cwd: definition.cwd, env: definition.environment });
    // 一次运行结束在命令跑完的那一刻，不在标签页被关掉的那一刻：用户在 CLI 里退出、
    // 终端留在提示符上，是这里最常见的样子。收尾之后会话、投影和同步状态都变了，
    // 无论成功还是失败，树视图和仪表盘都该重新读一遍。
    watchRun(vscode.window, terminal, definition.command, () => {
      void finishRun().catch((error) => showError(error)).finally(() => deps.refresh());
    });
    terminal.show();
    terminal.sendText(definition.command);
    return true;
  });

  register("avenic.agents.deinit", async (treeItem) => {
    if (busy()) return;
    const target = await agentTarget(treeItem);
    if (target === null) return;
    const language = vscode.env.language;
    const result = await runMutation(deps.queue, () => withProgress(sentence(language, "agents.operation"), (report) => agents.deinitialize(target.root, target.id).then((r) => { report(sentence(language, "flow.done")); return r; })), () => deps.refresh());
    // 与 `avenic <agent> deinit` 说同一组事实：设置移除了没有、数据留没留、还剩几个
    // Agent 配着。什么都没改更要说——否则点下去只剩一个消失的进度条，用户不知道是
    // 做完了还是没做事。
    const who = agents.listAgents().find((a) => a.id === target.id)?.displayName ?? target.id;
    await vscode.window.showInformationMessage(sentence(language, result.changed ? "agent.deinit-removed" : "agent.deinit-absent", { agent: who, remaining: result.remaining }));
  });

  register("avenic.agents.sessionsImport", async (treeItem) => {
    if (busy()) return;
    const target = await agentTarget(treeItem);
    if (target === null) return;
    const result = await runMutation(deps.queue, () => withProgress(sentence(vscode.env.language, "agents.operation"), (report) => agents.importSessions(target.root, target.id).then((r) => { report(sentence(vscode.env.language, "flow.done")); return r; })), () => deps.refresh());
    const message = sentence(vscode.env.language, "sessions.import-summary", {
      discovered: result.discovered, imported: result.imported, unchanged: result.unchanged, failed: result.failed,
    });
    // core 的同一个格式化器也服务于 CLI：原生历史的每一类问题只有一处措辞，
    // 且诊断对象永远不会被直接拼进消息（那只会打印 [object Object]）。
    const { warnings, notes } = formatSessionDiagnostics(result.diagnostics);
    const detail = [...warnings, ...notes].join(" ");
    if (warnings.length > 0 || (result.discovered === 0 && detail.length > 0)) await vscode.window.showWarningMessage(`${message} ${detail}`);
    else await vscode.window.showInformationMessage(message);
  });

  register("avenic.agents.sessionsWriteback", async (treeItem) => {
    if (busy()) return;
    const target = await agentTarget(treeItem);
    if (target === null) return;
    const result = await runMutation(deps.queue, () => withProgress(sentence(vscode.env.language, "agents.operation"), (report) => agents.writebackSessions(target.root, target.id).then((r) => { report(sentence(vscode.env.language, "flow.done")); return r; })), () => deps.refresh());
    await vscode.window.showInformationMessage(sentence(vscode.env.language, "sessions.writeback", { count: result.count }));
  });
}
