import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listAgents } from "../src/services/agents.ts";
import { defaultSpec, listKnown } from "../src/services/catalog.ts";
import { status as skillsStatus } from "../src/services/skills.ts";
import { agentRow, testEnv } from "./helpers.ts";

test("agents service lists the three ecosystem agents", () => {
  assert.deepEqual(listAgents().map((a) => a.id).sort(), ["claude", "codex", "opencode"]);
});

test("agents service reports an unconfigured agent on a fresh project", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "avenic-ext-"));
  try {
    const status = await agentRow(dir, "claude");
    // 没有 runtime.json：没配过，因此既没有初始化也没有认证答案 —— 「未配置」与
    // 「配了 Account」是两种状态，只有后者能在启动时不提问。
    assert.equal(status.initialized, false);
    assert.equal(status.auth, null);
    assert.equal(status.sessions, null);
    assert.equal(typeof status.available, "boolean");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
