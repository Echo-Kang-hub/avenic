import * as vscode from "vscode";
import { linkSummaryChanged } from "@avenic/core";
import * as skills from "../services/skills.ts";
import type { Scope } from "../services/skills.ts";
import { defaultSpec as catalogDefaultSpec } from "../services/catalog.ts";
import { MutationQueue, runMutation } from "../ui/mutation-queue.ts";
import { assertIdle, NO_CANDIDATES_WARNING, pickManyOrNotify } from "../ui/flows.ts";
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

  const busy = () => !assertIdle(deps.queue, (message) => void vscode.window.showWarningMessage(message));
  const warnNoOptions = () => void vscode.window.showWarningMessage(NO_CANDIDATES_WARNING);

  register("avenic.skills.installPacks", async () => {
    if (busy()) return;
    const scope = await pickScope();
    if (scope === null) return;
    const cwd = await scopeCwd(scope, deps.resolveRoot);
    if (cwd === null) return;
    if ((await catalogDefaultSpec()) === null) { await vscode.window.showWarningMessage("尚未选择默认 Hub，请先执行 Avenic: 添加 Hub"); return; }
    const all = await skills.availablePacks(scope, cwd);
    const installed = await skills.installedPackIds(scope, cwd);
    // 只列举未安装的 Pack；描述兜底 id
    const candidates = Array.from(all.values()).filter((p) => !(installed ?? []).includes(p.id)).map((p) => ({ label: p.name, description: p.description ?? p.id, id: p.id }));
    const chosen = await pickManyOrNotify(candidates, async (items) => vscode.window.showQuickPick(items, { canPickMany: true }), warnNoOptions);
    if (chosen.length === 0) return;
    await runMutation(deps.queue, () => withProgress("安装 Packs", async (report) => { report(`安装 ${chosen.length} 个 Pack…`); return skills.installPacks(scope, chosen.map((c) => c.id), cwd); }), () => deps.refresh());
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
    await runMutation(deps.queue, () => withProgress("卸载 Packs", async (report) => { report(`卸载 ${chosen.length} 个 Pack…`); return skills.uninstallPacks(scope, chosen.map((c) => c.label), cwd); }), () => deps.refresh());
  });

  register("avenic.skills.addDirect", async () => {
    if (busy()) return;
    const scope = await pickScope();
    if (scope === null) return;
    const cwd = await scopeCwd(scope, deps.resolveRoot);
    if (cwd === null) return;
    const repo = await vscode.window.showInputBox({ prompt: "owner/repo 或仓库 URL" });
    if (repo === undefined || repo.trim() === "") return;
    const result = await runMutation(deps.queue, () => withProgress("添加直装 Skills", async (report) => { report("发现 Skills…"); return skills.addDirect(scope, repo.trim(), [], cwd); }), () => deps.refresh());
    await vscode.window.showInformationMessage(`已添加 ${result.names.length} 个 Skills：${result.names.join(", ")}`);
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
    await runMutation(deps.queue, () => withProgress("移除直装 Skills", async (report) => { report(`移除 ${chosen.length} 个 Skill…`); return skills.removeDirect(scope, chosen.map((c) => c.label), cwd); }), () => deps.refresh());
  });

  // 只读命令：直接展示直装来源 → Skill 列表（空时提示），不排队、不 refresh
  register("avenic.skills.directList", async () => {
    const scope = await pickScope();
    if (scope === null) return;
    const cwd = await scopeCwd(scope, deps.resolveRoot);
    if (cwd === null) return;
    const state = await skills.directSkills(scope, cwd);
    const lines = state.directSources.map((s) => `${s.id} → ${s.skills.join(", ")}`);
    if (lines.length === 0) { await vscode.window.showInformationMessage("暂无直装 Skills"); return; }
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
        label: `识别为 Pack「${c.packName}」并补齐 ${c.missing} 个缺失 Skill`,
        description: `覆盖 ${c.matched.length}/${names.length}（${Math.round(c.coverage * 100)}%）`,
        id: c.packId,
      }));
      items.push({ label: "仅托管现有 Skill（不关联 Pack）", description: "保持磁盘内容不变", id: "__plain__" });
      const choice = await vscode.window.showQuickPick(items, {
        canPickMany: false,
        placeHolder: `检测到 ${names.length} 个未托管 Skill`,
      });
      if (choice === undefined) return;
      packId = choice.id === "__plain__" ? null : choice.id!;
    }
    if (packId === null) {
      const result = await runMutation(deps.queue, () => withProgress("托管磁盘 Skills", async (report) => { report(`托管 ${names.length} 个 Skill…`); return skills.adopt(scope, names, cwd); }), () => deps.refresh());
      await vscode.window.showInformationMessage(`已托管 ${result.adopted.length} 个 Skills（补齐 ${result.placed} 处目标）`);
    } else {
      const result = await runMutation(deps.queue, () => withProgress("识别为 Pack 接管", async (report) => { report(`安装 Pack「${packId}」（补齐缺失 Skill）…`); return skills.adoptPacked(scope, names, packId, cwd); }), () => deps.refresh());
      await vscode.window.showInformationMessage(`已识别为 Pack「${packId}」并安装 ${result.names.length} 个 Skills`);
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
    if (names.length === 0) { await vscode.window.showInformationMessage("没有已托管但未关联 Pack 的 Skill"); return; }
    const plan = await skills.planAdopt(scope, names, cwd);
    const candidates = (plan.candidates ?? []).filter((c) => c.coverage >= 0.8);
    if (candidates.length === 0) { await vscode.window.showInformationMessage(`默认 Hub 中未找到覆盖 ${names.length} 个 Skill 的 Pack（≥80% 匹配）`); return; }
    const items = candidates.map((c) => ({
      label: `识别为 Pack「${c.packName}」并补齐 ${c.missing} 个缺失 Skill`,
      description: `覆盖 ${c.matched.length}/${names.length}（${Math.round(c.coverage * 100)}%）`,
      id: c.packId,
    }));
    const choice = await vscode.window.showQuickPick(items, { canPickMany: false, placeHolder: `识别 ${names.length} 个已托管 Skill 为 Pack` });
    if (choice === undefined) return;
    const packId = choice.id!;
    const result = await runMutation(deps.queue, () => withProgress(`识别为 Pack「${packId}」`, async (report) => { report(`安装 Pack「${packId}」（补齐缺失 Skill）…`); return skills.adoptPacked(scope, names, packId, cwd); }), () => deps.refresh());
    await vscode.window.showInformationMessage(`已识别为 Pack「${packId}」：${result.names.length} 个 Skill`);
  });

  // Pack 行键位（Installed Packs 树的 pack 行，viewItem == pack，行带 packId + scope）：
  // 卸载整包 / 重装整包。命令面板调用回退为交互选择已安装 Pack。
  // 共同决策：卸载走 core uninstallPacks（common 永驻跳过；会被其他 Pack 选用的 Skill 不删）；
  // 重装走 core installPacks（与「安装包」同语义：重跑 resolve + copy + 合并锁记录）。
  const pickInstalledPack = async (scope: Scope, cwd: string | undefined, excludeCommon: boolean): Promise<string | null> => {
    const installed = ((await skills.installedPackIds(scope, cwd)) ?? []).filter((id) => !(excludeCommon && id === "common"));
    if (installed.length === 0) { warnNoOptions(); return null; }
    const choice = await vscode.window.showQuickPick(installed.map((id) => ({ label: id })), { canPickMany: false, placeHolder: "选择已安装 Pack" });
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
    const confirmed = await vscode.window.showWarningMessage(`卸载 Pack「${packId}」？其独占的 Skill 将一并移除（被其他 Pack 选用的保留）`, { modal: true }, "卸载");
    if (confirmed !== "卸载") return;
    const result = await runMutation(deps.queue, () => withProgress("卸载 Pack", async (report) => { report(`卸载 Pack「${packId}」…`); return skills.uninstallPacks(scope, [packId], cwd); }), () => deps.refresh());
    const removal = result.removed.length > 0 ? `，移除 ${result.removed.length} 个 Skill` : "";
    await vscode.window.showInformationMessage(`已卸载 Pack「${packId}」${removal}`);
  });

  register("avenic.skills.reinstallPack", async (arg?: unknown) => {
    if (busy()) return;
    const scope = (arg as { avenicScope?: Scope } | undefined)?.avenicScope ?? (await pickScope());
    if (scope === null) return;
    const cwd = await scopeCwd(scope, deps.resolveRoot);
    if (cwd === null) return;
    const packId = (arg as { avenicPackId?: string } | undefined)?.avenicPackId ?? (await pickInstalledPack(scope, cwd, false));
    if (packId === null) return;
    const result = await runMutation(deps.queue, () => withProgress("重装 Pack", async (report) => { report(`重装 Pack「${packId}」…`); return skills.installPacks(scope, [packId], cwd); }), () => deps.refresh());
    await vscode.window.showInformationMessage(`已重装 Pack「${packId}」：${result.resolvedPacks?.names.length ?? 0} 个 Skill`);
  });

  // 共享链接修复：与安装/启动同一套 core 逻辑，插件只负责作用域选择与提示。
  register("avenic.skills.repairLinks", async () => {
    if (busy()) return;
    const scope = await pickScope();
    if (scope === null) return;
    const cwd = await scopeCwd(scope, deps.resolveRoot);
    if (cwd === null) return;
    const result = await runMutation(deps.queue, () => withProgress("修复 Skills 链接", async () => skills.repairLinks(scope, cwd)), () => deps.refresh());
    const { counts, conflicts } = result;
    await vscode.window.showInformationMessage(
      !linkSummaryChanged(counts)
        ? "Skills 链接已是最新"
        : `链接 ${counts.linked} · 迁移 ${counts.migrated} · 降级 ${counts.fallback} · 冲突 ${conflicts.length}`,
    );
  });
}
