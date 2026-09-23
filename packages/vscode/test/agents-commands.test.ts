import assert from "node:assert/strict";
import { existsSync, lstatSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { listCanonicalSessions } from "@avenic/core";
import { agentStatus, deinitialize, initialize, prepareAgentLaunch, releaseSummary } from "../src/services/agents.ts";
import { select } from "../src/services/catalog.ts";
import { installPacks, repairLinks } from "../src/services/skills.ts";
import { makeCatalogFixture, testEnv, withAgentHomes } from "./helpers.ts";

test("init → reconfigure → deinit round-trip on real core", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "avenic-ext-"));
  try {
    await initialize(dir, "claude", { authMethod: "account", accountScope: "global", sessionScope: "project" });
    let status = await agentStatus(dir, "claude");
    assert.equal(status.auth?.method, "account");
    assert.equal(status.auth?.scope, "global");
    assert.equal(status.sessions, "project");
    // 同一场问答的第二次：方法、作用域、会话各自换一个答案，写的是同一份 schema。
    await initialize(dir, "claude", { authMethod: "api", configScope: "project", sessionScope: "global" });
    status = await agentStatus(dir, "claude");
    assert.equal(status.auth?.method, "api");
    assert.equal(status.auth?.scope, "project");
    assert.equal(status.auth?.configuration?.relative, ".claude/settings.local.json");
    assert.equal(status.sessions, "global");
    await deinitialize(dir, "claude");
    const after = await agentStatus(dir, "claude");
    assert.equal(after.initialized, false);
    assert.equal(after.auth, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("manifest registers the agent command ids, one wizard for init and change", async () => {
  const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = JSON.parse(await readFile(path.join(pkgDir, "package.json"), "utf8"));
  const ids = manifest.contributes?.commands ?? [];
  for (const id of ["avenic.agents.configureProject", "avenic.agents.launch", "avenic.agents.install", "avenic.agents.update", "avenic.agents.deinit", "avenic.agents.sessionsImport", "avenic.agents.sessionsWriteback"]) {
    assert.ok(ids.some((c: { command: string }) => c.command === id), id);
  }
  // 逐行切换的老入口必须消失：方法与作用域只在一场问答里回答，命令面板里
  // 不该再有第二条通往上一次写盘的路。
  for (const gone of ["avenic.agents.init", "avenic.agents.switchAuth", "avenic.agents.switchSessions"]) {
    assert.equal(ids.some((c: { command: string }) => c.command === gone), false, gone);
  }
});

// 启动准备复用 core 原语（与 `avenic claude` 同语义），而配置根的去留正是两种方法的
// 分界：Account·Project 把子进程的配置根指向项目自己的 home（登录是 agent 自己做的，
// Avenic 不发明凭据格式）；API 模式则一个字都不改——配置写在 agent 自己的原生文件里，
// 环境必须照常被发现。project sessions → 快照/恢复租赁；finishRun 幂等。未初始化 → 拒绝启动。
test("prepareAgentLaunch redirects the config root for a Project account and never for API", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-launch-"));
  const dir = path.join(root, "project");
  try {
    await mkdir(dir, { recursive: true });
    await withAgentHomes(path.join(root, "home"), async () => {
      await assert.rejects(() => prepareAgentLaunch(dir, "claude"), /尚未初始化/);
      await initialize(dir, "claude", { authMethod: "api", configScope: "project", sessionScope: "project" });
      const api = await prepareAgentLaunch(dir, "claude");
      assert.equal(api.definition.cwd, dir);
      assert.equal(api.definition.command, "claude");
      // 终端名字是 Avenic 自己的：Claude Code 扩展给它的终端起的名字就是 "Claude Code"，
      // 重名会让用户在终端列表里分不清哪个终端里跑着哪个 Agent。
      assert.match(api.definition.name, /^Avenic · Claude Code$/);
      assert.equal(api.definition.environment.CLAUDE_CONFIG_DIR, process.env.CLAUDE_CONFIG_DIR, "API 模式不得重定向配置根");
      assert.doesNotMatch(
        JSON.stringify(api.definition.environment),
        /\.agents[\\/]local/,
        "API 模式下环境里不该出现指向项目内的配置根",
      );
      await api.finishRun();
      await api.finishRun(); // 幂等：第二次 no-op

      await initialize(dir, "claude", { authMethod: "account", accountScope: "project", sessionScope: "project" });
      const account = await prepareAgentLaunch(dir, "claude");
      assert.equal(
        account.definition.environment.CLAUDE_CONFIG_DIR,
        path.join(dir, ".agents", "local", "claude"),
        "Account·Project 的项目隔离就是配置根本身",
      );
      assert.notEqual(process.env.CLAUDE_CONFIG_DIR, path.join(dir, ".agents", "local", "claude"), "不得改写调用方自己的环境");
      await account.finishRun();
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// P5 的不变量：Avenic 只给启动加生命周期，从不改变 VS Code 呈现 Agent 的方式。
// 「另一个 VS Code 窗口里出现一个『正在使用』的 Agent CLI 终端」的来源是 Claude Code
// 扩展自己——它用 `claude-vscode.terminal.open` 创建名为 "Claude Code" 的 transient 终端
// （默认落在 ViewColumn.Beside），"window" 形态还会用 workbench.action.moveEditorToNewWindow
// 把这个终端搬进新窗口，并在 onDidEndTerminalShellExecution 上销毁它（关掉＝杀掉里面的 Agent）。
// 那是它的界面和它的命令空间；Avenic 既不调用，也不替它调用。
test("a launch names its own terminal and never drives another extension's", async () => {
  const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const sources: string[] = [];
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.name.endsWith(".ts") || entry.name.endsWith(".js")) sources.push(target);
    }
  };
  await walk(path.join(pkgDir, "src"));
  await walk(path.join(pkgDir, "media"));
  assert.ok(sources.length > 0, "the scan must have looked at real files");
  for (const file of sources) {
    const source = await readFile(file, "utf8");
    const relative = path.relative(pkgDir, file);
    assert.equal(source.includes("claude-vscode."), false, `${relative} must not drive the Claude Code extension's own commands`);
    assert.equal(source.includes("moveEditorToNewWindow"), false, `${relative} must not move terminals between windows`);
  }
});

test("prepareAgentLaunch commits a Shared native session through core on exit", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-shared-launch-"));
  const dir = path.join(root, "project");
  try {
    await mkdir(dir, { recursive: true });
    await withAgentHomes(path.join(root, "home"), async () => {
      await initialize(dir, "claude", { authMethod: "account", accountScope: "project", sessionScope: "project" });
      const sessionId = "11111111-1111-4111-8111-111111111111";
      // 原生存储住在这次启动真正使用的配置根里 —— Account·Project 下就是项目自己的
      // `.agents/local/claude`，与启动注入的那个变量同一个答案。
      const configRoot = path.join(dir, ".agents", "local", "claude");
      const native = path.join(
        configRoot,
        "projects",
        path.resolve(dir).replace(/[^a-zA-Z0-9]/g, "-"),
        `${sessionId}.jsonl`,
      );
      await mkdir(path.dirname(native), { recursive: true });
      await writeFile(native, `${JSON.stringify({ type: "user", uuid: "u", sessionId, cwd: dir, timestamp: "2026-09-18T00:00:00.000Z", message: { role: "user", content: "A" } })}\n`);
      const prepared = await prepareAgentLaunch(dir, "claude");
      assert.equal(prepared.definition.environment.CLAUDE_CONFIG_DIR, configRoot, "夹具路径必须就是启动注入的配置根");
      await prepared.finishRun();
      assert.deepEqual((await listCanonicalSessions(dir)).map((session) => session.id), [`claude-${sessionId}`]);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
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
    await withAgentHomes(path.join(root, "home"), async () => {
      await initialize(dir, "claude", { authMethod: "account", accountScope: "project", sessionScope: "project" });
      await installPacks("project", ["common"], dir, env);
      const shared = path.join(dir, ".claude", "skills", "alpha");
      assert.equal(lstatSync(shared).isSymbolicLink(), true, "安装后共享目标是链接");
      await rm(shared, { recursive: true, force: true });
      assert.equal(existsSync(shared), false, "共享链接已删除");
      const prepared = await prepareAgentLaunch(dir, "claude");
      assert.equal(lstatSync(shared).isSymbolicLink(), true, "启动前补齐共享链接");
      await prepared.finishRun();
    });
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
    await withAgentHomes(path.join(root, "home"), async () => {
      await initialize(dir, "claude", { authMethod: "account", accountScope: "project", sessionScope: "project" });
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
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 释放的总结句：删除数不是全部事实。一个键的原值 Avenic 只存过 hash（用户自己
// 写过、被 Avenic 覆盖），它给不回来——用户必须被告知，否则他以为一切都恢复了。
test("a release summary names the keys that cannot be given back", () => {
  const entry = { agentId: "claude", method: "api" as const, relative: ".claude/settings.json", home: null, conflicts: 0, deleted: false };
  const summary = releaseSummary([{ ...entry, removed: 2, kept: 1 }]);
  assert.match(summary, /已删除 .*2 个键/);
  assert.match(summary, /1 个键的原值.*无法恢复/);
  // 没有这种键时不多说一句，也不改变既有的两句。
  const clean = releaseSummary([{ ...entry, removed: 2, kept: 0 }]);
  assert.match(clean, /已删除 .*2 个键/);
  assert.doesNotMatch(clean, /无法恢复/);
});
