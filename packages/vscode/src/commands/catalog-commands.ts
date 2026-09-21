import * as vscode from "vscode";
import * as catalog from "../services/catalog.ts";
import * as skills from "../services/skills.ts";
import { MutationQueue, runMutation } from "../ui/mutation-queue.ts";
import { assertIdle, pickOne } from "../ui/flows.ts";
import { pickScope, scopeCwd } from "../ui/scope.ts";
import { showError } from "./errors.ts";
import { withProgress } from "./progress.ts";

export interface CatalogDeps {
  // 决议 1：交互（InputBox/QuickPick/消息）在队列外，变更（add/select/sync/installPack）在队列内；
  // catalog 操作为 core 全局 / state-dir 域，与项目根无关（故无 resolveRoot）；唯独从 Catalog
  // 安装 Pack 需写入某作用域 → resolveRoot 仅在 installPack 路径用于引导项目根。
  queue: MutationQueue;
  refresh: () => void;
  resolveRoot: () => Promise<string | null>;
}

export function registerCatalogCommands(context: vscode.ExtensionContext, deps: CatalogDeps): void {
  // 决议 2：busy 守卫在命令体最前（spec §6 进行中时相关命令禁用）；runMutation 保证成功/失败都 refresh。
  const register = (id: string, fn: (arg?: unknown) => Promise<void>) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, async (arg?: unknown) => {
      try {
        // try/catch 覆盖整个命令体：交互与队列内的拒绝同样经 showError 呈现
        await fn(arg);
      } catch (err) { await showError(err); }
    }));

  const busy = () => !assertIdle(deps.queue, (message) => void vscode.window.showWarningMessage(message));

  register("avenic.catalog.add", async () => {
    if (busy()) return;
    const spec = await vscode.window.showInputBox({ prompt: "Hub spec（owner/repo、URL 或本地路径）", value: "Echo-Kang-hub/SkillsHub#main" });
    if (spec === undefined || spec.trim() === "") return;
    // runMutation：失败/预览失败后同样 refresh——注册状态已变更，树与 Dashboard 不得停留在旧数据（T8 Minor A）
    const result = await runMutation(deps.queue, () => withProgress("添加 Hub", async (report) => { report("保存并预览…"); return catalog.add(spec.trim()); }), () => deps.refresh());
    if (result.previewFailed) await vscode.window.showWarningMessage("已保存，可 sync 重试（Preview 失败不致命）");
    else await vscode.window.showInformationMessage(`Hub 已添加并预览 ${result.packs.length} 个 Pack`);
  });

  register("avenic.catalog.select", async () => {
    if (busy()) return;
    const known = await catalog.listKnown();
    if (known.length === 0) { await vscode.window.showInformationMessage("暂无已注册 Hub，先执行 Avenic: 添加 Hub"); return; }
    const picked = await pickOne(known.map((k) => ({ label: k.spec, description: k.name })), async (items) => vscode.window.showQuickPick(items));
    if (picked === undefined) return;
    await runMutation(deps.queue, () => catalog.select(picked.label), () => deps.refresh());
  });

  // 只读命令（仅读 defaultSpec + 提示），不排队；「修改」内联触发 select（select 自行排队，无嵌套等待）；
  // 仍带 busy 守卫：select 是 mutation，进行中不重复触发。
  register("avenic.catalog.default", async () => {
    if (busy()) return;
    const current = await catalog.defaultSpec();
    const info = await vscode.window.showInformationMessage(`当前默认 Hub：${current ?? "未设置"}`, "修改");
    if (info === undefined) return;
    await vscode.commands.executeCommand("avenic.catalog.select");
  });

  register("avenic.catalog.sync", async () => {
    if (busy()) return;
    const spec = await catalog.defaultSpec();
    if (spec === null) { await vscode.window.showWarningMessage("未选择默认 Hub"); return; }
    const info = await runMutation(deps.queue, () => withProgress("同步 Hub", async (report) => { report("拉取并解析…"); return catalog.sync(spec); }), () => deps.refresh());
    await vscode.window.showInformationMessage(catalog.syncSummary(info));
  });

  // Catalog 树 Pack 行 → 一键安装：arg 为行 TreeItem（packId/catalogSpec 由 provider 挂载）。
  // core 按默认 Catalog spec 解析 Pack → 非默认 Catalog 的 Pack 必须先选中；作用域经交互选择。
  register("avenic.catalog.installPack", async (arg?: unknown) => {
    if (busy()) return;
    // packSpec 与 catalogSpec 均可能承载来源 spec（provider 挂 packSpec；兼容早期命名）
    const { packId, catalogSpec, packSpec } = (arg ?? {}) as { packId?: string; catalogSpec?: string; packSpec?: string };
    if (packId === undefined) { await vscode.window.showWarningMessage("请在 Hub 树中右键 Pack 行安装"); return; }
    const current = await catalog.defaultSpec();
    if (current === null) { await vscode.window.showWarningMessage("尚未选择默认 Hub，请先执行 Avenic: 添加 Hub"); return; }
    const sourceSpec = catalogSpec ?? packSpec;
    if (sourceSpec !== undefined && sourceSpec !== current) {
      await vscode.window.showWarningMessage("该 Pack 属于非默认 Hub，先执行 Avenic: 选择 Hub 再安装"); return;
    }
    const scope = await pickScope();
    if (scope === null) return;
    const cwd = await scopeCwd(scope, deps.resolveRoot);
    if (cwd === null) return;
    const result = await runMutation(deps.queue, () => withProgress("安装 Packs", async (report) => { report(`安装 Pack ${packId}…`); return skills.installPacks(scope, [packId], cwd); }), () => deps.refresh());
    await vscode.window.showInformationMessage(`Pack ${packId} 已安装：${result.resolvedPacks.names.join(", ")}`);
  });
}
