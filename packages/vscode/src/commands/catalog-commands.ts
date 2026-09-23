import * as vscode from "vscode";
import * as catalog from "../services/catalog.ts";
import * as skills from "../services/skills.ts";
import { sentence } from "../i18n/text.ts";
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

  const busy = () => !assertIdle(deps.queue, (key) => void vscode.window.showWarningMessage(sentence(vscode.env.language, key)));

  register("avenic.catalog.add", async () => {
    if (busy()) return;
    const spec = await vscode.window.showInputBox({ prompt: sentence(vscode.env.language, "catalog.spec-prompt"), value: "Echo-Kang-hub/SkillsHub#main" });
    if (spec === undefined || spec.trim() === "") return;
    // runMutation：失败/预览失败后同样 refresh——注册状态已变更，树与 Dashboard 不得停留在旧数据（T8 Minor A）
    const result = await runMutation(deps.queue, () => withProgress(sentence(vscode.env.language, "catalog.add"), async (report) => { report(sentence(vscode.env.language, "catalog.saving")); return catalog.add(spec.trim()); }), () => deps.refresh());
    if (result.previewFailed) await vscode.window.showWarningMessage(sentence(vscode.env.language, "catalog.preview-failed"));
    else await vscode.window.showInformationMessage(sentence(vscode.env.language, "catalog.added", { count: result.packs.length }));
  });

  register("avenic.catalog.select", async () => {
    if (busy()) return;
    const known = await catalog.listKnown();
    if (known.length === 0) { await vscode.window.showInformationMessage(sentence(vscode.env.language, "catalog.no-hubs")); return; }
    const picked = await pickOne(known.map((k) => ({ label: k.spec, description: k.name })), async (items) => vscode.window.showQuickPick(items));
    if (picked === undefined) return;
    await runMutation(deps.queue, () => catalog.select(picked.label), () => deps.refresh());
  });

  // 只读命令（仅读 defaultSpec + 提示），不排队；「修改」内联触发 select（select 自行排队，无嵌套等待）；
  // 仍带 busy 守卫：select 是 mutation，进行中不重复触发。
  register("avenic.catalog.default", async () => {
    if (busy()) return;
    const current = await catalog.defaultSpec();
    const change = sentence(vscode.env.language, "catalog.change");
    const info = await vscode.window.showInformationMessage(
      sentence(vscode.env.language, "catalog.current-default", { spec: current ?? sentence(vscode.env.language, "catalog.not-set") }),
      change,
    );
    if (info === undefined) return;
    await vscode.commands.executeCommand("avenic.catalog.select");
  });

  register("avenic.catalog.sync", async () => {
    if (busy()) return;
    const spec = await catalog.defaultSpec();
    if (spec === null) { await vscode.window.showWarningMessage(sentence(vscode.env.language, "catalog.no-default")); return; }
    const info = await runMutation(deps.queue, () => withProgress(sentence(vscode.env.language, "catalog.sync"), async (report) => { report(sentence(vscode.env.language, "catalog.syncing")); return catalog.sync(spec); }), () => deps.refresh());
    await vscode.window.showInformationMessage(catalog.syncSummary(info));
  });

  // Pack 安装只有一条路：一个 Pack 从哪来（arg 里的行）或用户挑了哪一个，两种入口
  // 都走同一段写盘。Catalog 树删掉之后命令面板成了唯一入口，而它没有 arg——那时
  // 让人自己挑一个，而不是指着一棵不存在的树说「去那儿右键」。清单读的是已经同步
  // 下来的那份缓存：点一下不该顺手发一次网络请求（要拉新的就 Sync）。
  register("avenic.catalog.installPack", async (arg?: unknown) => {
    if (busy()) return;
    // packSpec 与 catalogSpec 均可能承载来源 spec（provider 挂 packSpec；兼容早期命名）
    const { packId, catalogSpec, packSpec } = (arg ?? {}) as { packId?: string; catalogSpec?: string; packSpec?: string };
    const current = await catalog.defaultSpec();
    if (current === null) { await vscode.window.showWarningMessage(sentence(vscode.env.language, "catalog.no-default-hint")); return; }
    const sourceSpec = catalogSpec ?? packSpec;
    if (sourceSpec !== undefined && sourceSpec !== current) {
      await vscode.window.showWarningMessage(sentence(vscode.env.language, "catalog.foreign-hub")); return;
    }
    let target = packId;
    if (target === undefined) {
      const packs = (await catalog.packsFor(current, undefined, { cachedOnly: true })) ?? new Map<string, { id: string; name: string; description?: string }>();
      if (packs.size === 0) {
        await vscode.window.showWarningMessage(sentence(vscode.env.language, "catalog.no-manifest"));
        return;
      }
      const picked = await pickOne(Array.from(packs.values()).map((pack) => ({ label: pack.name, description: pack.description ?? pack.id, id: pack.id })), async (items) => vscode.window.showQuickPick(items));
      if (picked === undefined) return;
      target = picked.id;
    }
    const scope = await pickScope();
    if (scope === null) return;
    const cwd = await scopeCwd(scope, deps.resolveRoot);
    if (cwd === null) return;
    const language = vscode.env.language;
    const result = await runMutation(deps.queue, () => withProgress(sentence(language, "catalog.installing"), async (report) => { report(sentence(language, "catalog.installing-pack", { pack: target })); return skills.installPacks(scope, [target], cwd); }), () => deps.refresh());
    await vscode.window.showInformationMessage(sentence(language, "catalog.installed", { pack: target, packs: result.resolvedPacks.names.join(", ") }));
  });
}
