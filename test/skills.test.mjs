import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createInstallContext, ensureSkillLinks, installPacks, installedPackIds, resolveInstallSource, setDefaultCatalogSpec, skillsInstallationStatus, unmanagedSkillNames, uninstallPacks } from "../packages/core/src/index.mjs";
import { readJson, writeJson } from "../packages/core/src/util/json.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agentBin = path.join(packageRoot, "packages", "cli", "scripts", "skills.mjs");

function runAgent(cwd, argumentsList, environment = {}) {
  return spawnSync(process.execPath, [agentBin, ...argumentsList], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, ...environment },
  });
}

function gitQuiet(cwd, argumentsList) {
  const result = spawnSync("git", ["-C", cwd, ...argumentsList], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function withTempDirectory(prefix, run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
    // Some tests git-clone the fixture into the sibling `<dir>-work` (git clone refuses an
    // existing target). mkdtemp never created that one, so remove it here or every run leaks it.
    await rm(`${directory}-work`, { recursive: true, force: true });
  }
}

async function commitAll(root, message) {
  await gitQuiet(root, ["init", "--quiet", "-b", "main"]);
  await gitQuiet(root, ["add", "-A"]);
  await gitQuiet(root, ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", message]);
}

async function createCatalogFixture(root) {
  await mkdir(path.join(root, "packs"), { recursive: true });
  await mkdir(path.join(root, "licenses"), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "fixture-catalog", version: "1.0.0", private: true, agentSkills: { packageSpec: "fixture#main" } }, null, 2)}\n`,
  );
  await writeFile(
    path.join(root, "sources.lock.json"),
    `${JSON.stringify({ schemaVersion: 1, sources: [{ id: "test-source", name: "Test Source", repository: "https://github.com/example/test.git", skillRoot: "skills", revision: "a".repeat(40), skillPaths: { beta: "nested/beta" }, licenseFile: "licenses/test-source-LICENSE" }] }, null, 2)}\n`,
  );
  await writeFile(path.join(root, "licenses", "test-source-LICENSE"), "license\n");
  for (const skillName of ["alpha", "beta", "gamma"]) {
    const directory = path.join(root, "skills", "test-source", skillName);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "SKILL.md"), `---\nname: ${skillName}\n---\n`);
  }
  const common = { schemaVersion: 1, id: "common", name: "Common", sources: [{ source: "test-source", skills: ["alpha"] }] };
  const development = { schemaVersion: 1, id: "development", name: "Development", sources: [{ source: "test-source", skills: ["beta", "gamma"] }] };
  await writeFile(path.join(root, "packs", "common.json"), `${JSON.stringify(common, null, 2)}\n`);
  await writeFile(path.join(root, "packs", "development.json"), `${JSON.stringify(development, null, 2)}\n`);
  await commitAll(root, "fixture catalog");
}

function catalogEnvironment(catalogRoot, stateRoot) {
  return { AVENIC_CATALOG_SPEC: catalogRoot, AVENIC_STATE_DIR: stateRoot };
}

test("Pack uninstall prunes only Skills no longer selected", async () => {
  await withTempDirectory("avenic-skills-", async (projectRoot) => {
    await withTempDirectory("avenic-catalog-", async (catalogRoot) => {
      await withTempDirectory("avenic-state-", async (stateRoot) => {
        await createCatalogFixture(catalogRoot);
        const environment = catalogEnvironment(catalogRoot, stateRoot);
        const installed = runAgent(projectRoot, ["skills", "development"], environment);
        assert.equal(installed.status, 0, installed.stderr);

        const protectedSkill = runAgent(projectRoot, ["skills", "remove", "beta"], environment);
        assert.equal(protectedSkill.status, 1);
        assert.match(protectedSkill.stderr, /Managed by configured Packs/);
        assert.equal(existsSync(path.join(projectRoot, ".agents", "skills", "beta")), true);

        const removed = runAgent(projectRoot, ["skills", "uninstall", "development"], environment);
        assert.equal(removed.status, 0, removed.stderr);
        const config = JSON.parse(await readFile(path.join(projectRoot, ".avenic.json"), "utf8"));
        assert.deepEqual(config.packs, ["common"]);
        assert.equal(existsSync(path.join(projectRoot, ".agents", "skills", "beta")), false);
        assert.equal(existsSync(path.join(projectRoot, ".agents", "skills", "gamma")), false);
        assert.equal(existsSync(path.join(projectRoot, ".agents", "skills", "alpha")), true);

        const before = await readFile(path.join(projectRoot, ".avenic.json"), "utf8");
        const repeated = runAgent(projectRoot, ["skills", "uninstall", "development"], environment);
        assert.equal(repeated.status, 0, repeated.stderr);
        assert.match(repeated.stdout, /Already absent: development/);
        assert.equal(await readFile(path.join(projectRoot, ".avenic.json"), "utf8"), before);
      });
    });
  });
});

test("External Skill uninstall is multi-value and idempotent", async () => {
  await withTempDirectory("avenic-external-", async (projectRoot) => {
    for (const root of [".claude", ".agents"]) {
      for (const skillName of ["external-one", "external-two"]) {
        const directory = path.join(projectRoot, root, "skills", skillName);
        await mkdir(directory, { recursive: true });
        await writeFile(path.join(directory, "SKILL.md"), "external\n");
      }
    }
    const removed = runAgent(projectRoot, ["skills", "remove", "external-one", "external-two"]);
    assert.equal(removed.status, 0, removed.stderr);
    assert.match(removed.stdout, /Removed external Skills/);
    assert.equal(existsSync(path.join(projectRoot, ".agents", "skills", "external-one")), false);
    assert.equal(existsSync(path.join(projectRoot, ".claude", "skills", "external-two")), false);

    const repeated = runAgent(projectRoot, ["skills", "remove", "external-one", "external-two"]);
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.match(repeated.stdout, /Already absent/);
  });
});

test("Skills uninstall without Packs removes all managed state", async () => {
  await withTempDirectory("avenic-project-", async (projectRoot) => {
    await withTempDirectory("avenic-catalog-", async (catalogRoot) => {
      await withTempDirectory("avenic-state-", async (stateRoot) => {
        await createCatalogFixture(catalogRoot);
        const environment = catalogEnvironment(catalogRoot, stateRoot);
        const installed = runAgent(projectRoot, ["skills", "common"], environment);
        assert.equal(installed.status, 0, installed.stderr);
        const external = path.join(projectRoot, ".agents", "skills", "external", "SKILL.md");
        await mkdir(path.dirname(external), { recursive: true });
        await writeFile(external, "external\n");

        const removed = runAgent(projectRoot, ["skills", "uninstall"], environment);
        assert.equal(removed.status, 0, removed.stderr);
        assert.equal(existsSync(path.join(projectRoot, ".avenic.json")), false);
        assert.equal(existsSync(path.join(projectRoot, ".avenic.lock.json")), false);
        assert.equal(existsSync(path.join(projectRoot, ".agents", "skills", "alpha")), false);
        assert.equal(existsSync(external), true);

        const repeated = runAgent(projectRoot, ["skills", "uninstall"], environment);
        assert.equal(repeated.status, 0, repeated.stderr);
        assert.match(repeated.stdout, /No managed project Skills installation found/);
      });
    });
  });
});

test("Catalog removes multiple Skills and Packs without orphan files", async () => {
  await withTempDirectory("avenic-catalog-", async (catalogRoot) => {
    await createCatalogFixture(catalogRoot);
    const cloneRoot = `${catalogRoot}-work`;
    await gitQuiet(catalogRoot, ["clone", "--quiet", catalogRoot, cloneRoot]);
    const before = await readFile(path.join(cloneRoot, "packs", "development.json"), "utf8");
    const invalid = runAgent(cloneRoot, ["catalog", "remove", "test-source", "beta", "--park", "development"]);
    assert.equal(invalid.status, 1);
    assert.equal(await readFile(path.join(cloneRoot, "packs", "development.json"), "utf8"), before);
    assert.equal(existsSync(path.join(cloneRoot, "skills", "test-source", "beta")), true);

    const removed = runAgent(cloneRoot, ["catalog", "remove", "test-source", "beta", "gamma", "--pack", "development"]);
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(existsSync(path.join(cloneRoot, "skills", "test-source", "beta")), false);
    assert.equal(existsSync(path.join(cloneRoot, "skills", "test-source", "gamma")), false);
    assert.equal(existsSync(path.join(cloneRoot, "skills", "test-source", "alpha")), true);
    const sourceConfig = JSON.parse(await readFile(path.join(cloneRoot, "sources.lock.json"), "utf8"));
    assert.equal(sourceConfig.sources[0].skillPaths, undefined);

    const repeated = runAgent(cloneRoot, ["catalog", "remove", "test-source", "beta", "gamma", "--pack", "development"]);
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.match(repeated.stdout, /Already absent/);

    const protectedPack = runAgent(cloneRoot, ["catalog", "pack-remove", "common", "development"]);
    assert.equal(protectedPack.status, 1);
    assert.equal(existsSync(path.join(cloneRoot, "packs", "development.json")), true);

    const packRemoved = runAgent(cloneRoot, ["catalog", "pack-remove", "development"]);
    assert.equal(packRemoved.status, 0, packRemoved.stderr);
    assert.equal(existsSync(path.join(cloneRoot, "packs", "development.json")), false);
    const packRepeated = runAgent(cloneRoot, ["catalog", "pack-remove", "development"]);
    assert.equal(packRepeated.status, 0, packRepeated.stderr);
    assert.match(packRepeated.stdout, /Already absent/);
  });
});

test("skillsInstallationStatus reports manifest packs and target presence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skills-status-"));
  try {
    const context = createInstallContext(false, { cwd: root, environment: process.env });
    assert.equal(await skillsInstallationStatus(context), null);
    await writeJson(context.lockFile, {
      schemaVersion: 3,
      packs: [{ id: "common", name: "Common" }],
      sources: [{ id: "s-source", name: "S", repository: "https://github.com/example/s.git", revision: "a".repeat(40), skills: ["s"] }],
    });
    // 目标顺序是 [claude(share), agents(canonical)]；先只补 canonical：
    // canonical 完整但 share 缺席 → 可用性 incomplete（旧语义会误报 share complete）。
    await mkdir(path.join(context.targets[1].destination, "s"), { recursive: true });
    await writeFile(path.join(context.targets[1].destination, "s", "SKILL.md"), "---\nname: s\n---\n");
    const missing = await skillsInstallationStatus(context);
    assert.equal(missing.names.length, 1);
    assert.equal(missing.packs[0].id, "common");
    assert.equal(missing.targets[1].complete, true);
    assert.equal(missing.targets[1].state, "canonical");
    assert.equal(missing.targets[0].complete, false, "canonical 完整但 share 条目缺席 = 不可用");
    assert.equal(missing.targets[0].state, "missing");
    assert.equal(missing.operational, false);
    assert.equal(missing.incomplete, true);

    // 补一份内容一致的真实副本 → fallback（可用但未共享）：operational + degraded。
    const sharePath = path.join(context.targets[0].destination, "s");
    await mkdir(sharePath, { recursive: true });
    await writeFile(path.join(sharePath, "SKILL.md"), "---\nname: s\n---\n");
    const degraded = await skillsInstallationStatus(context);
    assert.equal(degraded.targets[0].state, "fallback");
    assert.equal(degraded.targets[0].counts.fallback, 1);
    assert.equal(degraded.targets[0].complete, true, "canonical 完整 + share 有可用副本 = operational");
    assert.equal(degraded.operational, true);
    assert.equal(degraded.degraded, true);
    assert.equal(degraded.optimized, false);

    // 迁移为链接 → optimized（磁盘上确实只有一份）。
    await ensureSkillLinks(context, ["s"]);
    const optimized = await skillsInstallationStatus(context);
    assert.equal(optimized.targets[0].state, "linked");
    assert.equal(optimized.targets[0].counts.linked, 1);
    assert.equal(optimized.targets[0].counts.fallback, 0);
    assert.equal(optimized.operational, true);
    assert.equal(optimized.state, "optimized");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 未托管 = 磁盘上有、受管集合里没有。受管集合（Pack + adopted + 直装）与展示用
// names（Pack + adopted）不是同一个集合：主机自己用 names 做减法，会把 Avenic 直装的
// 技能报成「未托管」，让用户去接管自己刚装上的东西。
test("unmanaged detection subtracts the managed set, not the display set", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "skills-unmanaged-"));
  try {
    const context = createInstallContext(false, { cwd: root, environment: process.env });
    await writeJson(context.lockFile, {
      schemaVersion: 3,
      packs: [],
      sources: [],
      adopted: ["adopted-skill"],
      directSources: [{ id: "d-1", name: "Direct", skills: ["direct-skill"] }],
    });
    const status = await skillsInstallationStatus(context);
    assert.deepEqual(status.names, ["adopted-skill"], "展示集合只含 Pack + adopted");
    assert.deepEqual(status.managedNames.sort(), ["adopted-skill", "direct-skill"]);
    assert.deepEqual(unmanagedSkillNames(status, ["adopted-skill", "direct-skill", "stray"]), ["stray"]);
    // 没有安装记录时，磁盘上的一切都属于「未托管」
    assert.deepEqual(unmanagedSkillNames(null, ["stray", "other"]), ["stray", "other"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function fixtureCatalog(root) {
  // Catalog layout: vendored Skills live in skills/<source-id>/<skill-name>/;
  // buildCatalog walks the directories inside skills/<source-id>.
  await mkdir(path.join(root, "skills", "s", "s"), { recursive: true });
  await mkdir(path.join(root, "skills", "s", "s2"), { recursive: true });
  await mkdir(path.join(root, "packs"), { recursive: true });
  await writeFile(path.join(root, "skills", "s", "s", "SKILL.md"), "---\nname: s\n---\nv1\n");
  await writeFile(path.join(root, "skills", "s", "s2", "SKILL.md"), "---\nname: s2\n---\nv1\n");
  await writeFile(path.join(root, "packs", "common.json"), `${JSON.stringify({ schemaVersion: 1, id: "common", name: "Common", sources: [{ source: "s", skills: ["s"] }] })}\n`);
  await writeFile(path.join(root, "packs", "development.json"), `${JSON.stringify({ schemaVersion: 1, id: "development", name: "Development", sources: [{ source: "s", skills: ["s2"] }] })}\n`);
  await writeFile(path.join(root, "sources.lock.json"), `${JSON.stringify({ schemaVersion: 1, sources: [{ id: "s", name: "S", repository: "https://github.com/example/s.git", skillRoot: "skills", revision: "a".repeat(40) }] })}\n`);
  await gitQuiet(root, ["init", "--quiet", "-b", "main"]);
  await gitQuiet(root, ["add", "-A"]);
  await gitQuiet(root, ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "--quiet", "-m", "one"]);
}

test("resolveInstallSource pins the lock revision unless refreshing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "resolve-source-"));
  try {
    const state = path.join(root, "state");
    const catalog = path.join(root, "catalog");
    await fixtureCatalog(catalog);
    const environment = { ...process.env, AVENIC_STATE_DIR: state };
    await setDefaultCatalogSpec(environment, catalog);
    const first = await resolveInstallSource({ cwd: root, environment }, {});
    assert.equal(first.revision.length, 40);
    await writeFile(path.join(catalog, "skills", "s", "SKILL.md"), "---\nname: s\n---\nv2\n");
    await gitQuiet(catalog, ["add", "-A"]);
    await gitQuiet(catalog, ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "--quiet", "-m", "two"]);
    await writeJson(path.join(root, ".avenic.lock.json"), {
      schemaVersion: 3,
      catalog: { repository: catalog, revision: first.revision },
    });
    const pinned = await resolveInstallSource({ cwd: root, environment }, {});
    assert.equal(pinned.revision, first.revision);
    const refreshed = await resolveInstallSource({ cwd: root, environment }, { refresh: true });
    assert.notEqual(refreshed.revision, first.revision);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installPacks installs the resolved packs and writes metadata", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "install-packs-"));
  try {
    const state = path.join(root, "state");
    const catalog = path.join(root, "catalog");
    await fixtureCatalog(catalog);
    const environment = { ...process.env, AVENIC_STATE_DIR: state };
    await setDefaultCatalogSpec(environment, catalog);
    const context = createInstallContext(false, { cwd: root, environment });
    const planned = [];
    const result = await installPacks(context, [], { io: { log() {} }, onPlan: (resolved) => planned.push(resolved.names.length) });
    assert.equal(result.resolvedPacks.names[0], "s");
    assert.deepEqual(planned, [1]);
    assert.equal(existsSync(path.join(context.targets[0].destination, "s", "SKILL.md")), true);
    const lock = await readJson(context.lockFile);
    assert.equal(lock.catalog.revision.length, 40);
    assert.equal(lock.packs[0].id, "common");
    await assert.rejects(() => installPacks(createInstallContext(false, { cwd: catalog, environment }), [], { io: { log() {} } }), /not from the Avenic Hub/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uninstallPacks keeps common and reinstalls remaining packs", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "uninstall-packs-"));
  try {
    const state = path.join(root, "state");
    const catalog = path.join(root, "catalog");
    await fixtureCatalog(catalog);
    const environment = { ...process.env, AVENIC_STATE_DIR: state };
    await setDefaultCatalogSpec(environment, catalog);
    const context = createInstallContext(false, { cwd: root, environment });
    await installPacks(context, ["development"], { io: { log() {} } });
    assert.equal((await installedPackIds(context)).includes("development"), true);

    const nothing = await uninstallPacks(context, ["common"], { io: { log() {} } });
    assert.equal(nothing.changed, false);
    assert.equal(nothing.skippedCommon, true);
    const missing = await uninstallPacks(context, ["unknown-pack"], { io: { log() {} } });
    assert.equal(missing.changed, false);
    assert.deepEqual(missing.absent, ["unknown-pack"]);

    const result = await uninstallPacks(context, ["development"], { io: { log() {} } });
    assert.equal(result.changed, true);
    assert.deepEqual(result.removed, ["development"]);
    const lock = await readJson(context.lockFile);
    assert.deepEqual(lock.packs.map((pack) => pack.id), ["common"]);
    assert.equal(existsSync(path.join(context.targets[0].destination, "s2")), false);
    assert.equal(existsSync(path.join(context.targets[0].destination, "s", "SKILL.md")), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
