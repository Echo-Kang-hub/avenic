import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { select } from "../src/services/catalog.ts";
import { adopt, addDirect, adoptedOnlyNames, adoptPacked, detected, directSkills, installedPackIds, installPacks, invalidateSkillsSnapshot, planAdopt, readSkillsSnapshot, removeDirect, repairLinks, status, uninstallPacks } from "../src/services/skills.ts";
import { makeCatalogFixture, testEnv } from "./helpers.ts";

test("skills snapshot shares one read until an explicit refresh invalidates it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-skills-snapshot-"));
  try {
    const env = testEnv(path.join(root, "state"));
    const cwd = path.join(root, "project");
    await mkdir(cwd, { recursive: true });
    const first = readSkillsSnapshot("project", cwd, env);
    assert.strictEqual(first, readSkillsSnapshot("project", cwd, env));
    await first;
    invalidateSkillsSnapshot();
    assert.notStrictEqual(first, readSkillsSnapshot("project", cwd, env));
  } finally {
    invalidateSkillsSnapshot();
    await rm(root, { recursive: true, force: true });
  }
});

test("pack install → status → uninstall round-trip in project scope", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-skills-"));
  try {
    const catalogDir = path.join(root, "catalog");
    const cwd = path.join(root, "project");
    const env = testEnv(path.join(root, "state"));
    await mkdir(cwd, { recursive: true });
    await makeCatalogFixture(catalogDir);
    await select(catalogDir, env);
    assert.equal(await status("project", cwd, env), null);
    const result = await installPacks("project", ["common", "extra"], cwd, env);
    assert.equal(result.packIds.includes("common"), true);
    assert.equal(result.packIds.includes("extra"), true);
    const installed = await installedPackIds("project", cwd, env);
    assert.equal(installed?.includes("common"), true);
    assert.equal(installed?.includes("extra"), true);
    assert.ok((await status("project", cwd, env)) !== null, "安装后 lock 存在 → status 非 null");
    expectSkillDirs(cwd, ["alpha", "beta"], true, "installed");
    const removed = await uninstallPacks("project", ["extra"], cwd, env);
    assert.equal(removed.removed.includes("extra"), true);
    const remaining = await installedPackIds("project", cwd, env);
    assert.equal(remaining?.includes("extra"), false);
    assert.equal(remaining?.includes("common"), true, "core 语义：common 永驻，卸载只移除其余 pack — lock 保留，status 不会回到 null");
    expectSkillDirs(cwd, ["alpha"], true, "remaining");
    expectSkillDirs(cwd, ["beta"], false, "removed");
    // Pack 行「重装」语义：installPacks(packId) 恢复独占 Skill（alpha 保留、beta 回来）
    await installPacks("project", ["extra"], cwd, env);
    expectSkillDirs(cwd, ["alpha", "beta"], true, "reinstalled");
    assert.equal(await installedPackIds("project", cwd, env).then((ids) => ids?.includes("extra")), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("direct add/remove round-trip on local git repo", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-direct-"));
  try {
    const cwd = path.join(root, "project");
    const repo = path.join(root, "repo");
    const env = testEnv(path.join(root, "state"));
    await mkdir(cwd, { recursive: true });
    await mkdir(path.join(repo, "skills", "manual"), { recursive: true });
    await writeFile(path.join(repo, "skills", "manual", "SKILL.md"), "---\nname: manual\n---\n");
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e", "add", "-A"], { cwd: repo });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-qm", "one"], { cwd: repo });
    const added = await addDirect("project", repo, [], cwd, env);
    assert.equal(added.names.includes("manual"), true);
    const state = await directSkills("project", cwd, env);
    assert.equal(state.directSources.flatMap((s) => s.skills).includes("manual"), true);
    expectSkillDirs(cwd, ["manual"], true, "added");
    const removed = await removeDirect("project", ["manual"], cwd, env);
    assert.equal(removed.includes("manual"), true);
    expectSkillDirs(cwd, ["manual"], false, "removed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 决议 8：全局只读测试——全新隔离 state dir：status null、directSkills 空形状；证明全局
// 上下文完全由 env state dir 隔离。禁止任何全局写测试：全局安装目标直指用户主目录
// (GLOBAL_TARGETS: ~/.claude/skills 等)，写入即污染真机。
test("global scope is env-state-isolated and read-only safe", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-global-"));
  try {
    const env = testEnv(path.join(root, "state"));
    assert.equal(await status("global", undefined, env), null);
    const direct = await directSkills("global", undefined, env);
    assert.equal(direct.directSources.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 启动补齐/手动修复同一入口：只处理 lock 记录的受管技能。删除共享链接后一次 repair 重建，
// 且不产生额外条目——若实现退化成枚举 .agents/skills 后连链，outsider 之类未受管目录会被带进来。
test("repairLinks recreates a missing shared link from the managed set only", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-repair-"));
  try {
    const catalogDir = path.join(root, "catalog");
    const cwd = path.join(root, "project");
    const env = testEnv(path.join(root, "state"));
    await mkdir(cwd, { recursive: true });
    await makeCatalogFixture(catalogDir);
    await select(catalogDir, env);
    await installPacks("project", ["common"], cwd, env);
    const shared = path.join(cwd, ".claude", "skills", "alpha");
    assert.equal(lstatSync(shared).isSymbolicLink(), true, "安装后共享目标是链接");
    await rm(shared, { recursive: true, force: true });
    assert.equal(existsSync(shared), false, "共享链接已删除");
    assert.equal(existsSync(path.join(cwd, ".agents", "skills", "alpha", "SKILL.md")), true, "canonical 拷贝保留");
    // 未受管技能：只在磁盘上、不在 lock 里（其它工具/手工放入）——任何目录枚举式实现都会把它连进来
    const outsiderSkill = path.join(cwd, ".agents", "skills", "outsider", "SKILL.md");
    const outsiderBody = "---\nname: outsider\n---\n# not managed by avenic\n";
    await mkdir(path.dirname(outsiderSkill), { recursive: true });
    await writeFile(outsiderSkill, outsiderBody);

    const result = await repairLinks("project", cwd, env);
    assert.ok(result.counts.linked >= 1, `重建缺失共享链接（counts=${JSON.stringify(result.counts)}）`);
    assert.equal(lstatSync(shared).isSymbolicLink(), true, "共享链接已重建");
    // 受管集合只来自 lock：未受管技能绝不建链、绝不被删/被改写
    assert.equal(existsSync(path.join(cwd, ".claude", "skills", "outsider")), false, "未受管技能不得被链接");
    assert.equal(existsSync(outsiderSkill), true, "未受管技能不得被删除");
    assert.equal(await readFile(outsiderSkill, "utf8"), outsiderBody, "未受管技能内容不得被改写");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// silent：core 的失败/冲突日志绝不冒泡到扩展输出。构造：.claude/skills 被占位成普通文件，
// 建链与拷贝都放不下 → core 记 unplaceable conflict（非 silent 时会打印 ⚠ Cannot place）。
test("repairLinks stays silent when core reports conflicts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-repair-silent-"));
  try {
    const catalogDir = path.join(root, "catalog");
    const cwd = path.join(root, "project");
    const env = testEnv(path.join(root, "state"));
    await mkdir(cwd, { recursive: true });
    await makeCatalogFixture(catalogDir);
    await select(catalogDir, env);
    await installPacks("project", ["common"], cwd, env);
    const canonicalSkill = path.join(cwd, ".agents", "skills", "alpha", "SKILL.md");
    const claudeSkills = path.join(cwd, ".claude", "skills");
    assert.equal(existsSync(canonicalSkill), true, "canonical 在");
    await rm(claudeSkills, { recursive: true, force: true });
    assert.equal(existsSync(canonicalSkill), true, "删共享目录不伤 canonical");
    await writeFile(claudeSkills, "not a directory"); // 链接与拷贝都无法放置

    const { value, output } = await captureWrites(() => repairLinks("project", cwd, env));
    assert.ok(value.conflicts.length >= 1, "构造必须真的走到 core 的冲突汇报路径");
    assert.equal(value.conflicts[0].reason, "unplaceable");
    assert.doesNotMatch(output, /Cannot place|neither a link nor a copy could be placed|Cannot create shared link/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 空受管集合：early return，零副作用。目录枚举式实现会在这里凭空建出 .claude/skills。
test("repairLinks is a no-op with zero side effects when nothing is managed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-repair-empty-"));
  try {
    const cwd = path.join(root, "project");
    const env = testEnv(path.join(root, "state"));
    await mkdir(cwd, { recursive: true });
    const result = await repairLinks("project", cwd, env);
    assert.deepEqual(result.counts, { linked: 0, repaired: 0, migrated: 0, fallback: 0, conflict: 0, unchanged: 0, skipped: 0 });
    assert.deepEqual(result.conflicts, []);
    assert.deepEqual(result.targets, {});
    assert.equal(existsSync(path.join(cwd, ".claude", "skills")), false, "不创建共享目标目录");
    assert.equal(existsSync(path.join(cwd, ".agents", "skills")), false, "不创建 canonical 目录");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("manifest declares the ten skills command ids", async () => {
  // 这十条以前挂在 Skills 树的每行上；树没了，命令还在（面板的 Skills 卡与命令面板
  // 用的是同一批实现）。命令↔注册的双向校验在 manifest.test.ts，这里只钉这一组名字。
  const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = JSON.parse(await readFile(path.join(pkgDir, "package.json"), "utf8"));
  const ids = manifest.contributes?.commands ?? [];
  const ids9 = ["avenic.skills.installPacks", "avenic.skills.uninstallPacks", "avenic.skills.addDirect", "avenic.skills.removeDirect", "avenic.skills.directList", "avenic.skills.adopt", "avenic.skills.adoptPack", "avenic.skills.uninstallPack", "avenic.skills.reinstallPack", "avenic.skills.repairLinks"];
  for (const id of ids9) {
    assert.ok(ids.some((c: { command: string }) => c.command === id), id);
  }
});

test("adopt round-trip: detected → adopt → managed status, missing target filled", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-adopt-"));
  try {
    const cwd = path.join(root, "project");
    const env = testEnv(path.join(root, "state"));
    await mkdir(path.join(cwd, ".agents", "skills", "beta"), { recursive: true });
    await writeFile(path.join(cwd, ".agents", "skills", "beta", "SKILL.md"), "# beta");
    // 托管前：磁盘存在但 status null → 未托管检测报出（services 层与 core 层同源）
    assert.deepEqual(await detected("project", cwd, env), ["beta"]);
    assert.equal(await status("project", cwd, env), null);
    const result = await adopt("project", ["beta"], cwd, env);
    assert.deepEqual(result.adopted, ["beta"]);
    assert.equal(result.placed, 1, ".claude/skills 缺失 → 生成 1 份拷贝");
    const state = await status("project", cwd, env);
    assert.ok(state !== null);
    assert.deepEqual(state.names, ["beta"]);
    assert.ok(state.targets.every((t: { complete: boolean }) => t.complete));
    // 检测是磁盘扫描（含已托管），未托管 = detected - managed；托管后闭环 → 无残留未托管项
    const untracked = (await detected("project", cwd, env)).filter((n: string) => !state.names.includes(n));
    assert.deepEqual(untracked, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 旧版包识别：磁盘上的 Skill 集合（非精确匹配，允许差异）→ 覆盖度计划按匹配比例排序
test("planAdopt ranks the old-install pack first by coverage (not exact-set match)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-plan-"));
  try {
    const catalogDir = path.join(root, "catalog");
    const cwd = path.join(root, "project");
    const env = testEnv(path.join(root, "state"));
    await mkdir(cwd, { recursive: true });
    await makeCatalogFixture(catalogDir);
    await select(catalogDir, env);
    // 磁盘仅 .agents/skills/beta：extra 覆盖 1.0，common 覆盖 0 → best = extra
    await mkdir(path.join(cwd, ".agents", "skills", "beta"), { recursive: true });
    await writeFile(path.join(cwd, ".agents", "skills", "beta", "SKILL.md"), "# beta");
    const plan = await planAdopt("project", ["beta"], cwd, env);
    assert.equal(plan.best?.packId, "extra");
    assert.equal(plan.best?.coverage, 1);
    assert.equal(plan.best?.missing, 0);
    assert.ok(plan.candidates.every((c) => c.packId === "extra"), "zero-coverage packs 不列入候选");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// adoptPacked：识别为 Pack 后补齐缺失 target、写 Pack 元数据、不再出现在未托管检测里
test("adoptPacked round-trip fills every target and stops showing untracked", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-adoptpack-"));
  try {
    const catalogDir = path.join(root, "catalog");
    const cwd = path.join(root, "project");
    const env = testEnv(path.join(root, "state"));
    await mkdir(cwd, { recursive: true });
    await makeCatalogFixture(catalogDir);
    await select(catalogDir, env);
    await mkdir(path.join(cwd, ".agents", "skills", "beta"), { recursive: true });
    await writeFile(path.join(cwd, ".agents", "skills", "beta", "SKILL.md"), "# beta");
    const result = await adoptPacked("project", ["beta"], "extra", cwd, env);
    assert.equal(result.packId, "extra");
    assert.deepEqual(result.names, ["beta"]);
    expectSkillDirs(cwd, ["beta"], true, "adopt-packed");
    const state = await status("project", cwd, env);
    assert.ok(state !== null);
    assert.deepEqual(state.names, ["beta"]);
    assert.deepEqual(state.packs.map((p) => (typeof p === "string" ? p : p.id)), ["extra"], "lock.packs 记录被识别的 Pack");
    const untracked = (await detected("project", cwd, env)).filter((n: string) => !state.names.includes(n));
    assert.deepEqual(untracked, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// adoptedOnlyNames：普通 adopt 后（lock.adopted，无 source 分组）→ 报告为「可识别为 Pack」候选
test("adoptedOnlyNames lists packless managed skills after plain adopt", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-adopted-"));
  try {
    const cwd = path.join(root, "project");
    const env = testEnv(path.join(root, "state"));
    await mkdir(path.join(cwd, ".agents", "skills", "manual"), { recursive: true });
    await writeFile(path.join(cwd, ".agents", "skills", "manual", "SKILL.md"), "# manual");
    assert.deepEqual(await adoptedOnlyNames("project", cwd, env), []);
    await adopt("project", ["manual"], cwd, env);
    assert.deepEqual(await adoptedOnlyNames("project", cwd, env), ["manual"], "adopt 记录的 Skill 无 source 分组 → 可识别为 Pack");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 临时接管 stdout/stderr（core 的 io.log 走 console → process.stdout.write），
// 用于断言 repairLinks 的 silent 契约；finally 还原，避免污染测试运行器输出。
async function captureWrites<T>(fn: () => Promise<T>): Promise<{ value: T; output: string }> {
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  let output = "";
  const sink = (chunk: unknown): boolean => { output += String(chunk); return true; };
  process.stdout.write = sink as unknown as typeof process.stdout.write;
  process.stderr.write = sink as unknown as typeof process.stderr.write;
  try {
    return { value: await fn(), output };
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
}

// 目标目录断言辅助：项目作用域目标两处（.claude/skills + .agents/skills）
function expectSkillDirs(cwd: string, skills: string[], present: boolean, phase: string): void {
  for (const skill of skills) {
    const targets = [path.join(cwd, ".claude", "skills", skill), path.join(cwd, ".agents", "skills", skill)];
    for (const target of targets) {
      assert.equal(existsSync(target), present, `期望 ${target} ${present ? "存在" : "已删除"}（${phase}）`);
    }
  }
}
