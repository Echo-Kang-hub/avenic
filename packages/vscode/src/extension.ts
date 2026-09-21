import * as vscode from "vscode";
import { registerAgentsCommands } from "./commands/agents-commands.ts";
import { registerCatalogCommands } from "./commands/catalog-commands.ts";
import { registerDashboardCommands } from "./commands/dashboard-commands.ts";
import { registerSkillsCommands } from "./commands/skills-commands.ts";
import { projectRootForActiveEditor, rememberedProjectRoot, resolveProjectRoot } from "./project.ts";
import { pickProjectRoot } from "./ui/flows.ts";
import { MutationQueue } from "./ui/mutation-queue.ts";
import { DashboardPanel } from "./dashboard/panel.ts";
import { ActivityLog } from "./ui/activity.ts";
import { LauncherView } from "./views/launcher-view.ts";
import { DASHBOARD_VIEW_ID } from "./views/view-ids.ts";
import { LEGACY_COMMAND_ALIASES } from "./views/legacy.ts";
import { STARTUP_FAILED, reportDashboardFailure, reportFailure, type FailureUi } from "./views/dashboard-failure.ts";
import { markPerformance } from "./ui/performance.ts";
import { invalidateSkillsSnapshot } from "./services/skills.ts";
import { invalidateAgentStatusCache } from "./services/agents.ts";
import { avenicCliVersion, cachedAvenicCliVersion } from "./services/agent-versions.ts";

// VS Code 自己的动作，不是 Avenic 的：重新加载窗口是版本错配（原地升级后仍在跑旧代码）
// 唯一真正能修好的那一步，所以它出现在失败通知里而不是被我们模仿一遍。
const RELOAD_WINDOW_COMMAND = "workbench.action.reloadWindow";

export function activate(context: vscode.ExtensionContext): void {
  const activationStartedAt = performance.now();
  // 第一件事就是活动栏图标下那一行。它前面每多一步，那一步抛错时用户看到的就是
  // VS Code 自己的 "No view is registered with id: avenic.launcher"——一句既没有原因
  // 也没有动作的话。挂载失败也不 return：仪表盘面板不依赖这棵树，下面注册的命令才是
  // 用户还能把面板打开的那条路。异步读取（CLI 版本、项目根）本来就不 await。
  const launcher = new LauncherView();
  const viewError = mountLauncher(context, launcher);
  try {
    const failureUi = startShell(context, launcher, activationStartedAt);
    if (viewError !== null) void reportDashboardFailure(viewError, failureUi);
  } catch (error) {
    // 激活体里任何一步失败都不带走上面那一行。真实原因先落进扩展主机日志——那是这条
    // 路径上最后一处还能留下它的地方。
    console.error("[avenic] activation failed", error);
    void reportFailure(STARTUP_FAILED, error, fallbackUi(context));
  }
}

// 挂入口行。返回失败原因（null 表示挂上了）而不是抛：调用方还要继续激活。
function mountLauncher(context: vscode.ExtensionContext, launcher: LauncherView): unknown | null {
  context.subscriptions.push(launcher);
  try {
    context.subscriptions.push(vscode.window.createTreeView(DASHBOARD_VIEW_ID, { treeDataProvider: launcher }));
    return null;
  } catch (error) {
    return error;
  }
}

function startShell(context: vscode.ExtensionContext, launcher: LauncherView, activationStartedAt: number): FailureUi {
  // 多根：resolveProjectRoot 返回 null，此时优先 active editor 所属的文件夹（B6：用户正在编辑哪个项目
  // 就是哪个项目），再回退到记忆根（经当前文件夹列表校验）；无记忆则 null → 视图提示行。
  const root = () => {
    const live = vscode.workspace.workspaceFolders ?? [];
    return (
      resolveProjectRoot(live)
      ?? projectRootForActiveEditor(live, vscode.window.activeTextEditor?.document.uri.fsPath)
      ?? rememberedProjectRoot(live, context.workspaceState)
    );
  };
  const activity = new ActivityLog({ sink: vscode.window.createOutputChannel("Avenic") });
  context.subscriptions.push(activity);
  const queue = new MutationQueue();
  const failureUi: FailureUi = {
    // 「Dashboard could not be opened」也进最近活动：下一次面板打开时，上一回为什么
    // 没开就在它自己的列表里。真正的原因（内部那句话）在同一行的通道里。
    record: (line) => activity.record(line, "muted"),
    show: () => activity.show(),
    notify: (message, ...actions) => vscode.window.showErrorMessage(message, ...actions),
    reload: reloadWindow,
  };
  // 底部那一行的版本是这台机器真正在用的 Avenic CLI：激活与刷新时各看一眼，都不
  // await —— 激活与首帧不为一次 spawn 等待。答案落地后只有它真的和面板上正显示的
  // 那个不同才重画（服务里有十分钟窗口，窗口内的刷新连进程都不会起）。
  const showCliVersion = (): void => {
    const shown = cachedAvenicCliVersion();
    void avenicCliVersion().then((version) => {
      if (version !== null && version !== shown) DashboardPanel.current?.refresh();
    });
  };
  // 数据单向：任何变更后视图/仪表盘重读真实状态（设计 §3），不反向写 core
  let refreshPending = false;
  const refresh = () => {
    // Multiple mutation callbacks commonly arrive in one event-loop turn.
    // Coalescing prevents every visible view from repeating its filesystem
    // reads for the same final state.
    if (refreshPending) return;
    refreshPending = true;
    queueMicrotask(() => {
      refreshPending = false;
      invalidateSkillsSnapshot();
      invalidateAgentStatusCache();
      launcher.refresh();
      DashboardPanel.current?.refresh();
      showCliVersion();
    });
  };
  // 同步根解析：单根直接返回；多根/null 时经 T6 pickProjectRoot 引导用户选定（workspaceFolders 实时读取，避免激活期闭包过期）
  const resolveRoot = async (): Promise<string | null> => {
    const r = root();
    if (r !== null) return r;
    const picked = await pickProjectRoot([...(vscode.workspace.workspaceFolders ?? [])], context.workspaceState, async (candidates) => vscode.window.showQuickPick(candidates));
    if (picked !== null) refresh(); // 选定后让入口行从「打开项目文件夹」提示刷新为真实数据
    return picked;
  };
  registerDashboardCommands({ context, root, queue, refresh, activity, failure: failureUi });
  registerAgentsCommands(context, { queue, resolveRoot, refresh });
  registerCatalogCommands(context, { queue, refresh, resolveRoot });
  registerSkillsCommands(context, { queue, resolveRoot, refresh });
  // 0.5.5 之前那三条入口的别名（见 views/legacy.ts）：一行 registerCommand，O(1)，
  // 不探测旧状态、不读盘、不起进程。旧 id 不进清单，所以命令面板里看不到它们。
  for (const [legacy, target] of Object.entries(LEGACY_COMMAND_ALIASES)) {
    context.subscriptions.push(vscode.commands.registerCommand(legacy, () => vscode.commands.executeCommand(target)));
  }
  showCliVersion();
  markPerformance("extension.activate", activationStartedAt);
  return failureUi;
}

// 启动失败那条路径上手边可能还没有通道（失败正好发生在建它的时候）：现开一个，开不出来
// 就只给 [Reload Window]，不摆一个打不开日志的按钮。
function fallbackUi(context: vscode.ExtensionContext): FailureUi {
  const ui: FailureUi = {
    notify: (message, ...actions) => vscode.window.showErrorMessage(message, ...actions),
    reload: reloadWindow,
  };
  try {
    const channel = vscode.window.createOutputChannel("Avenic");
    context.subscriptions.push(channel);
    ui.record = (line) => channel.appendLine(line);
    ui.show = () => channel.show(true);
  } catch { /* 通道开不出来：原因已经在扩展主机日志里了 */ }
  return ui;
}

function reloadWindow(): void {
  void vscode.commands.executeCommand(RELOAD_WINDOW_COMMAND);
}

export function deactivate(): void {}
