import assert from "node:assert/strict";
import test from "node:test";
import { agentsToViewModels, catalogPackSkillsToViewModels, catalogPacksToViewModels, catalogSourceGroupsToViewModels, catalogToViewModels, GLOBAL_EMPTY_HINT, PROJECT_EMPTY_HINT, skillsToViewModels } from "../src/views/view-models.ts";

import type { EffectiveAgentConfig, InstallStatus, InstallTargetStatus } from "@avenic/core";

const effective: EffectiveAgentConfig = { enabled: true, auth: "global", sessions: "project", configuredAuth: "global", localAuth: null };
const agent = { id: "claude", displayName: "Claude Code", executable: "claude" };
const cli = (installed: string | null, latest: string | null) => ({ installed, latest, updateAvailable: installed !== null && latest !== null && latest > installed });

// core 1.1.0 起 InstallStatus 增加 state/operational/optimized/degraded/incomplete、target 增加
// id/state/counts。这些用例只关心展示字段，用夹具补齐类型必需字段，不改断言语义。
const statusFixture = (partial: Pick<InstallStatus, "names"> & Partial<InstallStatus>): InstallStatus => ({
  groups: [],
  packs: [],
  targets: [],
  // 受管集合默认为展示集合；直装等「受管但不在 names」的场景在用例里显式给出
  managedNames: partial.names,
  state: "optimized",
  operational: true,
  optimized: true,
  degraded: false,
  incomplete: false,
  ...partial,
});
const targetFixture = (partial: Pick<InstallTargetStatus, "agents" | "label" | "destination" | "present" | "total" | "complete"> & Partial<InstallTargetStatus>): InstallTargetStatus => ({
  id: "agents",
  state: "canonical",
  counts: {},
  ...partial,
});

test("uninitialized agent with CLI missing renders bootstrap row", () => {
  const items = agentsToViewModels([{ agent, executableAvailable: false, effective: null, cli: cli(null, "2.1.238") }]);
  assert.deepEqual(items[0], { id: "claude", label: "Claude Code", description: "未初始化 · CLI 未安装", tooltip: "claude · CLI 不可用 · 未初始化", iconHint: "circle-outline", active: false, state: "bootstrap" });
});

test("uninitialized agent with CLI present renders inactive row", () => {
  const items = agentsToViewModels([{ agent, executableAvailable: true, effective: null, cli: cli("2.1.238", "2.1.238") }]);
  assert.deepEqual(items[0], { id: "claude", label: "Claude Code", description: "未初始化", tooltip: "claude · CLI 可用 · v2.1.238 · 未初始化", iconHint: "circle-outline", active: false, state: "inactive" });
});

test("initialized agent with CLI present renders active row with version", () => {
  const items = agentsToViewModels([{ agent, executableAvailable: true, effective, cli: cli("2.1.238", "2.1.238") }]);
  assert.deepEqual(items[0], { id: "claude", label: "Claude Code", description: "已初始化 · v2.1.238", tooltip: "claude · CLI 可用 · v2.1.238 · auth: global, sessions: project", iconHint: "pass-filled", active: true, state: "active" });
});

test("updatable agent renders update row with version arrow", () => {
  const items = agentsToViewModels([{ agent, executableAvailable: true, effective, cli: cli("2.1.238", "2.2.0") }]);
  assert.deepEqual(items[0], { id: "claude", label: "Claude Code", description: "已初始化 · v2.1.238 → v2.2.0", tooltip: "claude · CLI 可用 · v2.1.238 → v2.2.0 · auth: global, sessions: project", iconHint: "pass-filled", active: true, state: "update" });
});

test("initialized agent with CLI missing renders missing row", () => {
  const items = agentsToViewModels([{ agent, executableAvailable: false, effective, cli: cli(null, null) }]);
  assert.deepEqual(items[0], { id: "claude", label: "Claude Code", description: "已初始化 · CLI 未安装", tooltip: "claude · CLI 不可用 · auth: global, sessions: project", iconHint: "pass-filled", active: true, state: "missing" });
});

test("catalog list marks current default", () => {
  const items = catalogToViewModels("Echo-Kang-hub/SkillsHub#main", [
    { name: "Avenic Catalog", spec: "Echo-Kang-hub/SkillsHub#main" },
    { name: "Other", spec: "Echo-Kang-hub/other#main" },
  ]);
  // 模型无 dead tooltip 字段：规则守源码观感，TreeItem 只展示 label
  assert.deepEqual(items[0], { kind: "current", label: "Echo-Kang-hub/SkillsHub#main", description: "Avenic Catalog" });
  assert.equal(items[1].kind, "entry");
});

test("catalog model renders entries without a project root (global/state-dir domain)", () => {
  // 无项目根 + 无默认 spec：仅凭注册列表即可渲染数据（W1 根门禁移除）
  const items = catalogToViewModels(null, [{ name: "Avenic Catalog", spec: "Echo-Kang-hub/SkillsHub#main" }]);
  assert.deepEqual(items, [{ kind: "entry", label: "Echo-Kang-hub/SkillsHub#main", description: "Avenic Catalog" }]);
});

test("catalog model is empty only when genuinely nothing to show", () => {
  assert.deepEqual(catalogToViewModels(null, []), []); // 无默认 spec 且无注册 → 视图显示提示行
  assert.equal(catalogToViewModels("Echo-Kang-hub/SkillsHub#main", []).length, 1); // 有默认 spec → 仍有数据
});

test("skills empty-state copy is scope-aware", () => {
  const groups = skillsToViewModels(null, [], PROJECT_EMPTY_HINT);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].item.description, "打开一个新项目根后安装 Pack");
  assert.equal(groups[0].item.label, "尚未安装 Skills");
  const global = skillsToViewModels(null, [], GLOBAL_EMPTY_HINT);
  assert.equal(global[0].item.description, "全局域 Pack 请从命令面板安装");
});

test("skills status maps to grouped items", () => {
  const items = skillsToViewModels(statusFixture({ names: ["pack-a"], packs: [{ id: "pack-a", name: "Pack A" }] }));
  assert.ok(items.length >= 1); // 分组（Installed Packs / Catalog Packs）
  assert.equal(items[0].item.kind, "group");
  // Installed Packs 组可展开：无 source 分组兜底时，仅托管记录的行按 adopted 呈现（可识别为 Pack）
  assert.deepEqual(items[0].children?.map((c) => c.label), ["pack-a"]);
  assert.equal(items[0].children?.[0].kind, "adopted");
});

test("installed packs children fall back to merged source rows without layers", () => {
  const group = (id: string, name: string, skills: string[]) => {
    const source = { id, name, repository: `https://github.com/${id}`, revision: "a".repeat(40) };
    return { source, skills: skills.map((skill) => ({ name: skill, directory: skill, source })) };
  };
  const items = skillsToViewModels(statusFixture({
    groups: [
      group("superpowers", "Superpowers", ["writing-plans", "debugging"]),
      group("anthropic", "Anthropic", ["docx"]),
    ],
    names: ["writing-plans", "debugging", "docx", "legacy-one"],
    packs: [{ id: "development", name: "Development" }],
  }));
  const children = items[0].children!;
  // 两个 source 分组行 + 一个 adopted 兜底行（层次数据缺失时的锁文件合并视图）
  assert.deepEqual(children.map((c) => c.kind), ["source", "source", "adopted"]);
  assert.equal(children[0].label, "Superpowers");
  assert.equal(children[0].description, "2 个 Skill");
  assert.deepEqual(children[0].children?.map((s) => s.label), ["writing-plans", "debugging"]);
  assert.equal(children[0].children?.[1].kind, "skill");
  assert.equal(children[2].label, "legacy-one");
  assert.equal(children[2].kind, "adopted");
  // Hub Packs 保持为纯信息行（「完整性」分组已移除，完成度并入 Installed Packs 描述）
  assert.equal(items[1].item.label, "Hub Packs");
  assert.equal(items.length, 2);
});

test("installed packs children layer as pack rows (Pack → source → skill)", () => {
  const layers = [{
    packId: "development", packName: "Development",
    groups: [
      { sourceId: "superpowers", sourceName: "Superpowers", skills: ["writing-plans", "debugging"] },
      { sourceId: "anthropic", sourceName: "Anthropic", skills: ["docx"] },
    ],
  }];
  const items = skillsToViewModels(statusFixture({
    groups: [],
    names: ["writing-plans", "debugging", "docx", "legacy-one"],
    packs: [{ id: "development", name: "Development" }],
    targets: [targetFixture({ id: "claude", agents: ["claude-code"], label: "Claude Code", destination: "", present: 3, total: 3, complete: true })],
  }), [], PROJECT_EMPTY_HINT, layers);
  const children = items[0].children!;
  // 一个 Pack 行 + 一个 adopted 兜底行（legacy-one 不在任何 Pack 层内）
  assert.deepEqual(children.map((c) => c.kind), ["pack", "adopted"]);
  assert.equal(children[0].label, "Development");
  assert.equal(children[0].description, "3 个 Skill");
  assert.deepEqual(children[0].children?.map((s) => s.kind), ["source", "source"]);
  assert.deepEqual(children[0].children?.map((s) => s.label), ["Superpowers", "Anthropic"]);
  assert.deepEqual(children[0].children?.[0].children?.map((s) => s.label), ["writing-plans", "debugging"]);
  assert.equal(children[0].children?.[0].children?.[1].kind, "skill");
  assert.equal(children[0].children?.[0].children?.[1].description, "superpowers");
  assert.equal(children[1].label, "legacy-one");
  assert.equal(children[1].kind, "adopted");
  // 完成度并入 Installed Packs 描述，不再单独成组
  assert.match(items[0].item.description, /安装目标 1\/1/);
});

test("pack layers show only skills actually installed (catalog may lead the lock)", () => {
  const layers = [{
    packId: "development", packName: "Development",
    groups: [{ sourceId: "demo", sourceName: "Demo", skills: ["alpha", "future-skill"] }],
  }];
  const items = skillsToViewModels(statusFixture({
    groups: [],
    names: ["alpha"],
    packs: [{ id: "development", name: "Development" }],
  }), [], PROJECT_EMPTY_HINT, layers);
  const pack = items[0].children![0];
  assert.equal(pack.label, "Development");
  assert.deepEqual(pack.children?.[0].children?.map((s) => s.label), ["alpha"]); // future-skill 被过滤
});

test("skills null with untracked on-disk skills shows only the detected group (no contradictory empty hint)", () => {
  // 矛盾修复：已有「检测到 N 个（未托管）」时不得再出现「尚未安装 Skills」空态
  const groups = skillsToViewModels(null, ["alpha", "beta"], PROJECT_EMPTY_HINT);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].item.kind, "detected");
  assert.equal(groups[0].item.label, "检测到 2 个 Skill（未托管）");
  assert.deepEqual(groups[0].children?.map((c) => c.label), ["alpha", "beta"]);
  assert.equal(groups[0].children?.[0].kind, "detected");
});

test("skills status with stray files shows detected-untracked group first", () => {
  const status = statusFixture({ names: ["managed-one"], packs: [{ id: "pack-a", name: "Pack A" }] });
  const groups = skillsToViewModels(status, ["managed-one", "stray"], PROJECT_EMPTY_HINT);
  assert.equal(groups.length, 3);
  assert.equal(groups[0].item.kind, "detected");
  assert.equal(groups[0].item.label, "检测到 1 个 Skill（未托管）");
  assert.deepEqual(groups[0].children?.map((c) => c.label), ["stray"]);
});

test("fully managed status adds no detected group", () => {
  const status = statusFixture({ names: ["managed-one"] });
  const groups = skillsToViewModels(status, ["managed-one"], PROJECT_EMPTY_HINT);
  assert.equal(groups.length, 2);
  assert.ok(groups.every((g) => g.item.kind === "group"));
});

// 直装（avenic skills add <源>）的 Skill 在受管集合里、但不在 names 展示集合里。
// 用 names 做减法会把它报成「未托管」，等于让用户去接管自己刚装上的技能。
test("a directly installed skill is never reported as unmanaged", () => {
  const status = statusFixture({ names: ["pack-skill"], managedNames: ["pack-skill", "direct-skill"] });
  const groups = skillsToViewModels(status, ["pack-skill", "direct-skill"], PROJECT_EMPTY_HINT);
  assert.equal(groups.some((group) => group.item.kind === "detected"), false);
});

test("catalog packs map to sorted pack rows with id", () => {
  const rows = catalogPacksToViewModels([
    { id: "extra", name: "Extra", sources: [] },
    { id: "common", name: "Common", sources: [] },
  ]);
  assert.deepEqual(rows.map((r) => r.id), ["common", "extra"]);
  assert.equal(rows[0].kind, "pack");
  assert.equal(rows[0].label, "Common");
});

test("catalog pack expands to deduped skill rows keeping source order", () => {
  const rows = catalogPackSkillsToViewModels({
    id: "common", name: "Common",
    sources: [
      { source: "demo", skills: ["alpha", "beta"] },
      { source: "other", skills: ["beta", "gamma"] },
    ],
  });
  assert.deepEqual(rows.map((r) => r.label), ["alpha", "beta", "gamma"]); // 同名 beta 只出现一次
  assert.equal(rows[2].description, "other"); // 描述标来源 source id
  assert.ok(rows.every((r) => r.kind === "skill"));
});

test("catalog source groups map to layered rows preserving pack.sources order", () => {
  const rows = catalogSourceGroupsToViewModels({
    groups: [
      { source: { id: "superpowers", name: "Superpowers" }, skills: [{ name: "writing-plans" }, { name: "debugging" }] },
      { source: { id: "othmanadi", name: "Othmanadi" }, skills: [{ name: "planning" }] },
    ],
  });
  assert.deepEqual(rows.map((r) => [r.label, r.skills]), [
    ["Superpowers", ["writing-plans", "debugging"]],
    ["Othmanadi", ["planning"]],
  ]);
  assert.equal(rows[0].description, "2 个 Skill");
});
