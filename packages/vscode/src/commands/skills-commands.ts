import * as vscode from "vscode";
import { linkSummaryChanged } from "@avenic/core";
import * as skills from "../services/skills.ts";
import type { Scope } from "../services/skills.ts";
import { defaultSpec as catalogDefaultSpec } from "../services/catalog.ts";
import { sentence, type TextKey } from "../i18n/text.ts";
import { MutationQueue, runMutation } from "../ui/mutation-queue.ts";
import { assertIdle, pickManyOrNotify } from "../ui/flows.ts";
import { pickScope, scopeCwd } from "../ui/scope.ts";
import { showError } from "./errors.ts";
import { withProgress } from "./progress.ts";

export interface SkillsDeps {
  // 决议 1：项目作用域操作须经异步 resolveRoot 引导项目根（多根场景经 pickProjectRoot 选定）；
  // 全局作用域不接触项目根——core 全局上下文无视 cwd，root 即用户主目录。
  resolveRoot: () => Promise<string | null>;
  queue: MutationQueue;
  refresh: () => void;
}

export function registerSkillsCommands(context: vscode.ExtensionContext, deps: SkillsDeps): void {
  // 决议 3：try/catch 覆盖整个命令体（交互与队列内拒绝同样经 showError）；
  // 交互在队列外，仅 mutation 服务调用进 deps.queue.run——避免嵌套入队死锁；
  // runMutation 保证成功/失败都 refresh；busy 守卫在命令体最前（spec §6）；
  // 零候选经 pickManyOrNotify 警告并返回，绝不弹空 picker（T9 残余）；directList 只读不排队不刷新。
  const register = (id: string, fn: () => Promise<void>) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, async () => {
      try { await fn(); }
      catch (err) { await showError(err); }
    }));

  // 编辑器是哪种语言，一次读完：命令体里每一句话都经它说出口，而它只有重启编辑器才会变。
  const language = vscode.env.language;
  const busy = () => !assertIdle(deps.queue, (key) => void vscode.window.showWarningMessage(sentence(language, key)));
  const warnNoOptions = (key: TextKey = "flow.no-options") => void vscode.window.showWarningMessage(sentence(language, key));

  register("avenic.skills.installPacks", async () => {
    if (busy()) return;
    const scope = await pickScope();
    if (scope === null) return;
    const cwd = await scopeCwd(scope, deps.resolveRoot);
    if (cwd === null) return;
    if ((await catalogDefaultSpec()) === null) { await vscode.window.showWarningMessage(sentence(language, "catalog.no-default-hint")); return; }
    const all = await skills.availablePacks(scope, cwd);
    const installed = await skills.installedPackIds(scope, cwd);
    // 只列举未安装的 Pack；描述兜底 id
    const candidates = Array.from(all.values()).filter((p) => !(installed ?? []).includes(p.id)).map((p) => ({ label: p.name, description: p.description ?? p.id, id: p.id }));
    const chosen = await pickManyOrNotify(candidates, async (items) => vscode.window.showQuickPick(items, { canPickMany: true }), warnNoOptions);
    if (chosen.length === 0) return;
    await runMutation(deps.queue, () => withProgress(sentence(language, "catalog.installing"), async (report) => { report(sentence(language, "skills.installing-packs", { count: chosen.length })); return skills.installPacks(scope, chosen.map((c) => c.id), cwd); }), () => deps.refresh());
  });

  register("avenic.skills.uninstallPacks", async () => {
    if (busy()) return;
    const scope = await pickScope();
    if (scope === null) return;
    const cwd = await scopeCwd(scope, deps.resolveRoot);
    if (cwd === null) return;
    // common 永驻不可卸（core normalizePackIds 注入、uninstallPacks 跳过 common——与 CLI 语义一致，spec §5.3）
    const installed = ((await skills.installedPackIds(scope, cwd)) ?? []).filter((id) => id !== "common");
    const chosen = await pickManyOrNotify(installed.map((id) => ({ label: id })), async (items) => vscode.window.showQuickPick(items, { canPickMany: true }), warnNoOptions);
    if (chosen.length === 0) return;
    await runMutation(deps.queue, () => withProgress(sentence(language, "skills.uninstalling"), async (report) => { report(sentence(language, "skills.uninstalling-packs", { count: chosen.length })); return skills.uninstallPacks(scope, chosen.map((c) => c.label), cwd); }), () => deps.refresh());
  });

  register("avenic.skills.addDirect", async () => {
    if (busy()) return;
    const scope = await pickScope();
    if (scope === null) return;
    const cwd = await scopeCwd(scope, deps.resolveRoot);
    if (cwd === null) return;
    const repo = await vscode.window.showInputBox({ prompt: sentence(language, "skills.repo-prompt") });
    if (repo === undefined || repo.trim() === "") return;
    const result = await runMutation(deps.queue, () => withProgress(sentence(language, "skills.add-direct"), async (report) => { report(sentence(language, "skills.discovering")); return skills.addDirect(scope, repo.trim(), [], cwd); }), () => deps.refresh());
    await vscode.window.showInformationMessage(sentence(language, "skills.added-direct", { count: result.names.length, names: result.names.join(", ") }));
  });

  register("avenic.skills.removeDirect", async () => {
    if (busy()) return;
    const scope = await pickScope();
    if (scope === null) return;
    const cwd = await scopeCwd(scope, deps.resolveRoot);
    if (cwd === null) return;
    const state = await skills.directSkills(scope, cwd);
    const direct = state.directSources.flatMap((s) => s.skills);
    const chosen = await pickManyOrNotify(direct.map((n) => ({ label: n })), async (items) => vscode.window.showQuickPick(items, { canPickMany: true }), warnNoOptions);
    if (chosen.length === 0) return;
    await runMutation(deps.queue, () => withProgress(sentence(language, "skills.remove-direct"), async (report) => { report(sentence(language, "skills.removing", { count: chosen.length })); return skills.removeDirect(scope, chosen.map((c) => c.label), cwd); }), () => deps.refresh());
  });

  // 只读命令：直接展示直装来源 → Skill 列表（空时提示），不排队、不 refresh
  register("avenic.skills.directList", async () => {
    const scope = await pickScope();
    if (scope === null) return;
    const cwd = await scopeCwd(scope, deps.resolveRoot);
    if (cwd === null) return;
    const state = await skills.directSkills(scope, cwd);
    const lines = state.directSources.map((s) => `${s.id} → ${s.skills.join(", ")}`);
    if (lines.length === 0) { await vscode.window.showInformationMessage(sentence(language, "skills.no-direct")); return; }
    await vscode.window.showInformationMessage(lines.join("\n"));
  });

  // 托管磁盘上未托管的 Skills（旧版/外部工具安装、手工拷贝）：先做 Pack 识别计划（只读覆盖度
  // ≥0.8 视为旧包安装），给用户「识别为 Pack 并补齐」与「仅托管现有 Skill」两条路径；
  // core 补齐缺失 target 并写入 lock.adopted（或完整 Pack 元数据）。树的"检测到 N 个 Skill
  // （未托管）"行携带具体 scope 参数；命令面板调用回退为交互选择。零候选 → 警告而非空操作。
  register("avenic.skills.adopt", async (arg?: unknown) => {
    if (busy()) return;
    // 右键行 → arg 为带 avenicScope 的 TreeItem（provider 挂载）；命令面板调用 → 交互选择
    const scope = (arg as { avenicScope?: Scope } | undefined)?.avenicScope ?? (await pickScope());
    if (scope === null) return;
    const cwd = await scopeCwd(scope, deps.resolveRoot);
    if (cwd === null) return;
    const names = await skills.detected(scope, cwd);
    if (names.length === 0) { warnNoOptions(); return; }
    const plan = await skills.planAdopt(scope, names, cwd);
    const candidates = (plan.candidates ?? []).filter((c) => c.coverage >= 0.8);
    let packId: string | null = null;
    if (candidates.length > 0) {
      const items = candidates.map((c) => ({
        label: sentence(language, "skills.adopt-as-pack-entry", { pack: c.packName, count: c.missing }),
        description: sentence(language, "skills.coverage", { matched: c.matched.length, total: names.length, percent: Math.round(c.coverage * 100) }),
        id: c.packId,
      }));
      items.push({ label: sentence(language, "skills.adopt-plain"), description: sentence(language, "skills.adopt-plain-note"), id: "__plain__" });
      const choice = await vscode.window.showQuickPick(items, {
        canPickMany: false,
        placeHolder: sentence(language, "skills.adopt-detected", { count: names.length }),
      });
      if (choice === undefined) return;
      packId = choice.id === "__plain__" ? null : choice.id!;
    }
    if (packId === null) {
      const result = await runMutation(deps.queue, () => withProgress(sentence(language, "skills.adopt"), async (report) => { report(sentence(language, "skills.adopting", { count: names.length })); return skills.adopt(scope, names, cwd); }), () => deps.refresh());
      await vscode.window.showInformationMessage(sentence(language, "skills.adopted", { count: result.adopted.length, placed: result.placed }));
    } else {
      const result = await runMutation(deps.queue, () => withProgress(sentence(language, "skills.takeover", { pack: packId }), async (report) => { report(sentence(language, "skills.takeover-installing", { pack: packId })); return skills.adoptPacked(scope, names, packId, cwd); }), () => deps.refresh());
      await vscode.window.showInformationMessage(sentence(language, "skills.took-over", { pack: packId, count: result.names.length }));
    }
  });

  // 已托管但无 Pack 记录的 Skill（旧版包残留 → lock.adopted 场景）：整批识别为 Pack 接管
  // （补全缺失 Skill + 写完整 Pack/sources 元数据，先前记录保留）。树的"adopted"行携带
  // 具体 scope；命令面板调用回退为交互选择。
  register("avenic.skills.adoptPack", async (arg?: unknown) => {
    if (busy()) return;
    const scope = (arg as { avenicScope?: Scope } | undefined)?.avenicScope ?? (await pickScope());
    if (scope === null) return;
    const cwd = await scopeCwd(scope, deps.resolveRoot);
    if (cwd === null) return;
    const names = await skills.adoptedOnlyNames(scope, cwd);
    if (names.length === 0) { await vscode.window.showInformationMessage(sentence(language, "skills.no-adopted")); return; }
    const plan = await skills.planAdopt(scope, names, cwd);
    const candidates = (plan.candidates ?? []).filter((c) => c.coverage >= 0.8);
    if (candidates.length === 0) { await vscode.window.showInformationMessage(sentence(language, "skills.no-covering-pack", { count: names.length })); return; }
    const items = candidates.map((c) => ({
      label: sentence(language, "skills.adopt-as-pack-entry", { pack: c.packName, count: c.missing }),
      description: sentence(language, "skills.coverage", { matched: c.matched.length, total: names.length, percent: Math.round(c.coverage * 100) }),
      id: c.packId,
    }));
    const choice = await vscode.window.showQuickPick(items, { canPickMany: false, placeHolder: sentence(language, "skills.takeover-pick", { count: names.length }) });
    if (choice === undefined) return;
    const packId = choice.id!;
    const result = await runMutation(deps.queue, () => withProgress(sentence(language, "skills.takeover", { pack: packId }), async (report) => { report(sentence(language, "skills.takeover-installing", { pack: packId })); return skills.adoptPacked(scope, names, packId, cwd); }), () => deps.refresh());
    await vscode.window.showInformationMessage(sentence(language, "skills.took-over-short", { pack: packId, count: result.names.length }));
  });

  // Pack 行键位（Installed Packs 树的 pack 行，viewItem == pack，行带 packId + scope）：
  // 卸载整包 / 重装整包。命令面板调用回退为交互选择已安装 Pack。
  // 共同决策：卸载走 core uninstallPacks（common 永驻跳过；会被其他 Pack 选用的 Skill 不删）；
  // 重装走 core installPacks（与「安装包」同语义：重跑 resolve + copy + 合并锁记录）。
  const pickInstalledPack = async (scope: Scope, cwd: string | undefined, excludeCommon: boolean): Promise<string | null> => {
    const installed = ((await skills.installedPackIds(scope, cwd)) ?? []).filter((id) => !(excludeCommon && id === "common"));
    if (installed.length === 0) { warnNoOptions(); return null; }
    const choice = await vscode.window.showQuickPick(installed.map((id) => ({ label: id })), { canPickMany: false, placeHolder: sentence(language, "skills.pick-installed") });
    return choice?.label ?? null;
  };

  register("avenic.skills.uninstallPack", async (arg?: unknown) => {
    if (busy()) return;
    const scope = (arg as { avenicScope?: Scope } | undefined)?.avenicScope ?? (await pickScope());
    if (scope === null) return;
    const cwd = await scopeCwd(scope, deps.resolveRoot);
    if (cwd === null) return;
    const packId = (arg as { avenicPackId?: string } | undefined)?.avenicPackId ?? (await pickInstalledPack(scope, cwd, true));
    if (packId === null) return;
    const uninstall = sentence(language, "skills.uninstall");
    const confirmed = await vscode.window.showWarningMessage(sentence(language, "skills.uninstall-confirm", { pack: packId }), { modal: true }, uninstall);
    if (confirmed !== uninstall) return;
    const result = await runMutation(deps.queue, () => withProgress(sentence(language, "skills.uninstall-pack"), async (report) => { report(sentence(language, "skills.uninstalling-pack", { pack: packId })); return skills.uninstallPacks(scope, [packId], cwd); }), () => deps.refresh());
    const removal = result.removed.length > 0 ? sentence(language, "skills.removal-suffix", { count: result.removed.length }) : "";
    await vscode.window.showInformationMessage(sentence(language, "skills.uninstalled", { pack: packId }) + removal);
  });

  register("avenic.skills.reinstallPack", async (arg?: unknown) => {
    if (busy()) return;
    const scope = (arg as { avenicScope?: Scope } | undefined)?.avenicScope ?? (await pickScope());
    if (scope === null) return;
    const cwd = await scopeCwd(scope, deps.resolveRoot);
    if (cwd === null) return;
    const packId = (arg as { avenicPackId?: string } | undefined)?.avenicPackId ?? (await pickInstalledPack(scope, cwd, false));
    if (packId === null) return;
    const result = await runMutation(deps.queue, () => withProgress(sentence(language, "skills.reinstall"), async (report) => { report(sentence(language, "skills.reinstalling", { pack: packId })); return skills.installPacks(scope, [packId], cwd); }), () => deps.refresh());
    await vscode.window.showInformationMessage(sentence(language, "skills.reinstalled", { pack: packId, count: result.resolvedPacks?.names.length ?? 0 }));
  });

  // 共享链接修复：与安装/启动同一套 core 逻辑，插件只负责作用域选择与提示。
  register("avenic.skills.repairLinks", async () => {
    if (busy()) return;
    const scope = await pickScope();
    if (scope === null) return;
    const cwd = await scopeCwd(scope, deps.resolveRoot);
    if (cwd === null) return;
    const result = await runMutation(deps.queue, () => withProgress(sentence(language, "skills.repair"), async () => skills.repairLinks(scope, cwd)), () => deps.refresh());
    const { counts, conflicts } = result;
    await vscode.window.showInformationMessage(
      !linkSummaryChanged(counts)
        ? sentence(language, "skills.links-ok")
        : sentence(language, "skills.links-summary", { linked: counts.linked, migrated: counts.migrated, fallback: counts.fallback, conflicts: conflicts.length }),
    );
  });
}
