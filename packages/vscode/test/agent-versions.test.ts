import assert from "node:assert/strict";
import test from "node:test";
import { avenicCliVersion, cachedAvenicCliVersion, cliVersionStatus, invalidateCliVersionCache, updateCommandForInstallation } from "../src/services/agent-versions.ts";

// 未检测到 CLI 时没有「现有安装的升级命令」可用，唯一入口是 registry 上的官方
// npm 包；包名来自 core，面板不再自带一份包名表。
test("an undetected CLI is installed from the registry package core names", () => {
  assert.equal(updateCommandForInstallation("claude", null), "npm install --global @anthropic-ai/claude-code@latest");
  assert.equal(updateCommandForInstallation("opencode", {
    executable: null,
    resolvedExecutable: null,
    version: null,
    installMethod: "unknown",
    packageManager: null,
    updateStrategy: { kind: "manual", command: null },
  }), "npm install --global opencode-ai@latest");
});

test("Codex update commands follow the active installation provenance", () => {
  assert.equal(updateCommandForInstallation("codex", {
    executable: "/home/avenic/.local/bin/codex",
    resolvedExecutable: "/home/avenic/.codex/packages/standalone/current/codex",
    version: "0.150.1",
    installMethod: "standalone",
    packageManager: null,
    updateStrategy: { kind: "standalone", command: "curl -fsSL https://chatgpt.com/codex/install.sh | sh" },
  }), "curl -fsSL https://chatgpt.com/codex/install.sh | sh");
  assert.equal(updateCommandForInstallation("codex", {
    executable: "/usr/local/bin/codex",
    resolvedExecutable: "/usr/local/bin/codex",
    version: "0.150.1",
    installMethod: "binary",
    packageManager: null,
    updateStrategy: { kind: "manual", command: null },
  }), null);
});

test("update commands use the installation strategy for every detected agent", () => {
  assert.equal(updateCommandForInstallation("claude", {
    executable: "/workspace/claude/target/release/claude",
    resolvedExecutable: "/workspace/claude/target/release/claude",
    version: "2.1.238",
    installMethod: "source",
    packageManager: null,
    updateStrategy: { kind: "manual", command: null },
  }), null);
  assert.equal(updateCommandForInstallation("opencode", {
    executable: "/workspace/node_modules/.bin/opencode",
    resolvedExecutable: "/workspace/node_modules/opencode-ai/bin/opencode.js",
    version: "1.18.30",
    installMethod: "npm-local",
    packageManager: "npm",
    updateStrategy: { kind: "npm-local", command: "npm install opencode-ai@latest" },
  }), "npm install opencode-ai@latest");
});

test("cliVersionStatus computes updateAvailable and caches within TTL", async () => {
  const agent = { id: "claude", displayName: "Claude Code", executable: "claude" };
  const probes = {
    probeInstalled: async () => "2.1.238",
    probeLatest: async () => "2.2.0",
  };
  let calls = 0;
  const counting = {
    ...probes,
    probeLatest: async () => { calls += 1; return "2.2.0"; },
  };
  // 起始清缓存（模块级缓存跨测试复用）
  invalidateCliVersionCache("claude");
  const first = await cliVersionStatus("claude", agent, counting);
  assert.deepEqual(first, { installed: "2.1.238", latest: "2.2.0", updateAvailable: true });
  const second = await cliVersionStatus("claude", agent, counting);
  assert.deepEqual(second, first);
  assert.equal(calls, 1, "TTL 内应命中缓存，不再探测 npm");
  assert.deepEqual(await cliVersionStatus("opencode-up-to-date", agent, { probeInstalled: async () => "0.5.1", probeLatest: async () => "0.5.1" }), { installed: "0.5.1", latest: "0.5.1", updateAvailable: false });
  assert.deepEqual(await cliVersionStatus("opencode-unparsable", agent, { probeInstalled: async () => null, probeLatest: async () => "0.5.1" }), { installed: null, latest: "0.5.1", updateAvailable: false });
});

// 底部那一行「Avenic v…」说的是这台机器上真正在用的那份 CLI：探一次就够（服务里
// 有十分钟窗口），探不到就不给版本号——只写「Avenic」的页面仍然是诚实的，编一个不是。
test("the Avenic CLI version is probed once, cached, and absent rather than invented", async () => {
  let calls = 0;
  const probe = async () => { calls += 1; return "1.8.4"; };
  assert.equal(await avenicCliVersion(probe, { refresh: true }), "1.8.4");
  assert.equal(cachedAvenicCliVersion(), "1.8.4", "探到之后，渲染读的是缓存");
  await avenicCliVersion(probe);
  assert.equal(calls, 1, "窗口内的第二次调用不再起进程");
  await avenicCliVersion(probe, { refresh: true });
  assert.equal(calls, 2, "只有显式刷新才重新探");

  const failing = async () => { throw new Error("avenic is not on PATH"); };
  assert.equal(await avenicCliVersion(failing, { refresh: true }), null);
  assert.equal(cachedAvenicCliVersion(), null, "探不到就是 null，不是空串");
});

test("a probe already in flight is the answer, not a second process", async () => {
  let calls = 0;
  let release: (value: string) => void = () => {};
  const slow = () => {
    calls += 1;
    return new Promise<string | null>((resolve) => { release = resolve; });
  };
  const first = avenicCliVersion(slow, { refresh: true });
  const second = avenicCliVersion(slow, { refresh: true });
  release("1.8.4");
  assert.deepEqual(await Promise.all([first, second]), ["1.8.4", "1.8.4"]);
  assert.equal(calls, 1, "同时到达的两次刷新等的是同一次探测");
});
