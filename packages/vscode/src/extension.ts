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
import { markPerformance } from "./ui/performance.ts";
import { invalidateSkillsSnapshot } from "./services/skills.ts";
import { invalidateAgentStatusCache } from "./services/agents.ts";

export function activate(context: vscode.ExtensionContext): void {
  const activationStartedAt = performance.now();
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
  const launcher = new LauncherView();
  context.subscriptions.push(vscode.window.createTreeView("avenic.launcher", { treeDataProvider: launcher }));
  context.subscriptions.push(launcher);
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
  registerDashboardCommands({ context, root, queue, refresh, activity });
  registerAgentsCommands(context, { queue, resolveRoot, refresh });
  registerCatalogCommands(context, { queue, refresh, resolveRoot });
  registerSkillsCommands(context, { queue, resolveRoot, refresh });
  markPerformance("extension.activate", activationStartedAt);
}

export function deactivate(): void {}
