import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { agentStatus, authText, listAgents } from "../src/services/agents.ts";
import { defaultSpec, listKnown } from "../src/services/catalog.ts";
import { status as skillsStatus } from "../src/services/skills.ts";
import { testEnv } from "./helpers.ts";

test("agents service lists the three ecosystem agents", () => {
  assert.deepEqual(listAgents().map((a) => a.id).sort(), ["claude", "codex", "opencode"]);
});

test("agents service reports an unconfigured agent on a fresh project", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "avenic-ext-"));
  try {
    const status = await agentStatus(dir, "claude");
    // 没有 runtime.json：没配过，因此既没有初始化也没有认证答案 —— 「未配置」与
    // 「配了 Account」是两种状态，只有后者能在启动时不提问。
    assert.equal(status.initialized, false);
    assert.equal(status.auth, null);
    assert.equal(status.sessions, null);
    assert.equal(typeof status.executableAvailable, "boolean");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("auth wording names all four states: account, api, native, and not yet chosen", () => {
  // 四种状态，四句话：树视图和仪表盘共用这一个措辞来源。漏掉哪一种，用户看到的
  // 就是一句空话（曾经是 ", sessions: —"）或者一句不对的话（把已初始化的 agent 说成
  // 未初始化，把 OpenCode 的自管认证说成没选）。
  assert.match(authText({ method: "account", scope: "project", source: "project", home: ".agents/local/claude", status: "signed-in", configuration: null }), /^认证 Account · 项目（\.agents\/local\/claude）/);
  assert.match(authText({ method: "account", scope: "global", source: null, home: null, status: "not-signed-in", configuration: null }), /本机账号 · 未登录/);
  assert.match(authText({ method: "api", scope: "project", source: "project", home: null, status: null, configuration: null }), /^认证 API · 项目（—）/);
  assert.equal(authText(null), "认证 未选择 · 启动时会询问");
  assert.equal(authText(null, "native"), "认证 Native（OpenCode 自己管理）");
  // 自管的 agent 即使带着一份 auth 也说自管：那才是它启动时会做的事。
  assert.equal(authText({ method: "api", scope: "project", source: null, home: null, status: null, configuration: null }, "native"), "认证 Native（OpenCode 自己管理）");
});

test("catalog service default spec is null on isolated state dir", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "avenic-ext-"));
  try {
    const env = testEnv(dir); // 剥离宿主 Avenic 变量（含两代 CATALOG_SPEC 旧名），仅注入隔离 STATE_DIR
    assert.equal(await defaultSpec(env), null);
    assert.ok(Array.isArray(await listKnown(env)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("catalog service default spec honors legacy AGENTHOME_CATALOG_SPEC", async (t) => {
  t.mock.method(console, "warn", () => {}); // core 对旧名打印 deprecation 警告，测试输出保持无噪声
  const dir = await mkdtemp(path.join(os.tmpdir(), "avenic-ext-"));
  try {
    const env = testEnv(dir);
    env.AGENTHOME_CATALOG_SPEC = "some/repo#main";
    assert.equal(await defaultSpec(env), "some/repo#main");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("catalog service default spec treats empty primary as unset like core", async (t) => {
  t.mock.method(console, "warn", () => {}); // core 对旧名打印 deprecation 警告，测试输出保持无噪声
  const dir = await mkdtemp(path.join(os.tmpdir(), "avenic-ext-"));
  try {
    const env = testEnv(dir);
    env.AVENIC_CATALOG_SPEC = "";
    env.AGENTHOME_CATALOG_SPEC = "some/repo#main";
    assert.equal(await defaultSpec(env), "some/repo#main");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("skills service status is null on fresh project root", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "avenic-ext-"));
  try {
    const env = testEnv(dir);
    assert.equal(await skillsStatus("project", dir, env), null);
    assert.equal(await skillsStatus("global", undefined, env), null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
