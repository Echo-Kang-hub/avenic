import assert from "node:assert/strict";
import { existsSync, lstatSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { listCanonicalSessions } from "@avenic/core";
import { agentStatus, deinitialize, initialize, prepareAgentLaunch, setAuthMode, setSessionsMode } from "../src/services/agents.ts";
import { select } from "../src/services/catalog.ts";
import { installPacks, repairLinks } from "../src/services/skills.ts";
import { makeCatalogFixture, testEnv } from "./helpers.ts";

test("init → auth switch → sessions switch → deinit round-trip on real core", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "avenic-ext-"));
  try {
    await initialize(dir, "claude", "global", "project");
    let status = await agentStatus(dir, "claude");
    assert.equal(status.effective?.auth, "global");
    assert.equal(status.effective?.sessions, "project");
    await setAuthMode(dir, "claude", "project");
    status = await agentStatus(dir, "claude");
    assert.equal(status.effective?.auth, "project");
    await setSessionsMode(dir, "claude", "global");
    status = await agentStatus(dir, "claude");
    assert.equal(status.effective?.sessions, "global");
    await deinitialize(dir, "claude");
    assert.equal((await agentStatus(dir, "claude")).effective, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("manifest registers the nine agent command ids", async () => {
  const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = JSON.parse(await readFile(path.join(pkgDir, "package.json"), "utf8"));
  const ids = manifest.contributes?.commands ?? [];
  for (const id of ["avenic.agents.init", "avenic.agents.launch", "avenic.agents.install", "avenic.agents.update", "avenic.agents.deinit", "avenic.agents.switchAuth", "avenic.agents.switchSessions", "avenic.agents.sessionsImport", "avenic.agents.sessionsWriteback"]) {
    assert.ok(ids.some((c: { command: string }) => c.command === id), id);
  }
});

// 启动准备复用 core 原语（与 `avenic claude` 同语义）：project auth → CLAUDE_CONFIG_DIR 指入
// 项目内 .agents/local/claude（原生存储随项目走=测试隔离在临时目录）；project sessions →
// 快照/恢复租赁；finishRun 收官回写并保证幂等。未初始化 → 拒绝启动。
test("prepareAgentLaunch returns avenic runtime environment and scoped sessions", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "avenic-launch-"));
  try {
    await assert.rejects(() => prepareAgentLaunch(dir, "claude"), /尚未初始化/);
    await initialize(dir, "claude", "project", "project");
    const prepared = await prepareAgentLaunch(dir, "claude");
    assert.equal(prepared.definition.cwd, dir);
    assert.equal(prepared.definition.command, "claude");
    assert.ok(prepared.definition.name.includes("Claude Code"));
    const configDir = prepared.definition.environment.CLAUDE_CONFIG_DIR;
    assert.equal(!!configDir, true);
    assert.equal(path.resolve(configDir!), path.resolve(dir, ".agents", "local", "claude"), "项目域认证环境指向项目内目录");
    await prepared.finishRun();
    await prepared.finishRun(); // 幂等：第二次 no-op
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("prepareAgentLaunch commits a Shared native session through core on exit", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "avenic-shared-launch-"));
  try {
    await initialize(dir, "claude", "project", "project");
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const native = path.join(
      dir,
      ".agents",
      "local",
      "claude",
      "projects",
      path.resolve(dir).replace(/[^a-zA-Z0-9]/g, "-"),
      `${sessionId}.jsonl`,
    );
    await mkdir(path.dirname(native), { recursive: true });
    await writeFile(native, `${JSON.stringify({ type: "user", uuid: "u", sessionId, cwd: dir, timestamp: "2026-09-18T00:00:00.000Z", message: { role: "user", content: "A" } })}\n`);
    const prepared = await prepareAgentLaunch(dir, "claude");
    await prepared.finishRun();
    assert.deepEqual((await listCanonicalSessions(dir)).map((session) => session.id), [`claude-${sessionId}`]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 启动补齐共享链接（尽力而为）：安装后链接被删 → 启动前自动重建，用户无感。
test("prepareAgentLaunch repairs missing shared skill links before launch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-launch-links-"));
  try {
    const catalogDir = path.join(root, "catalog");
    const dir = path.join(root, "project");
    const env = testEnv(path.join(root, "state"));
    await mkdir(dir, { recursive: true });
    await makeCatalogFixture(catalogDir);
    await select(catalogDir, env);
    await initialize(dir, "claude", "project", "project");
    await installPacks("project", ["common"], dir, env);
    const shared = path.join(dir, ".claude", "skills", "alpha");
    assert.equal(lstatSync(shared).isSymbolicLink(), true, "安装后共享目标是链接");
    await rm(shared, { recursive: true, force: true });
    assert.equal(existsSync(shared), false, "共享链接已删除");
    const prepared = await prepareAgentLaunch(dir, "claude");
    assert.equal(lstatSync(shared).isSymbolicLink(), true, "启动前补齐共享链接");
    await prepared.finishRun();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 反例（先实测构造确实让 repairLinks 抛错，见 assert.rejects）：补齐失败必须被吞掉，
// prepareAgentLaunch 仍然 resolve——启动绝不因链接修复而阻断。
test("prepareAgentLaunch resolves even when repairLinks throws", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-launch-repair-fail-"));
  try {
    const catalogDir = path.join(root, "catalog");
    const dir = path.join(root, "project");
    const env = testEnv(path.join(root, "state"));
    await mkdir(dir, { recursive: true });
    await makeCatalogFixture(catalogDir);
    await select(catalogDir, env);
    await initialize(dir, "claude", "project", "project");
    await installPacks("project", ["common"], dir, env);
    await writeFile(path.join(dir, ".avenic.lock.json"), "{ not json "); // 锁文件损坏 → managedSkillNames 必然抛
    await assert.rejects(
      () => repairLinks("project", dir, env),
      /Cannot parse JSON/,
      "构造必须真的让 repairLinks 抛错，否则本用例失去区分力",
    );
    const prepared = await prepareAgentLaunch(dir, "claude");
    assert.equal(prepared.definition.cwd, dir);
    await prepared.finishRun();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
