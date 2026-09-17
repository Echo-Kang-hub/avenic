import assert from "node:assert/strict";
import test from "node:test";
import { cliVersionStatus, compareVersions, invalidateCliVersionCache, npmPackage, parseVersion, updateCommandForInstallation } from "../src/services/agent-versions.ts";

test("parseVersion extracts the first semver from CLI version outputs", () => {
  assert.equal(parseVersion("2.1.238 (Claude Code)"), "2.1.238");
  assert.equal(parseVersion("codex-cli 0.150.1"), "0.150.1");
  assert.equal(parseVersion("0.15.13\n"), "0.15.13");
  assert.equal(parseVersion("not-a-version"), null);
  assert.equal(parseVersion(""), null);
});

test("compareVersions compares semantic versions numerically", () => {
  assert.equal(compareVersions("2.1.238", "2.1.238"), 0);
  assert.equal(compareVersions("2.2.0", "2.1.238"), 1); // 逐段数值比较，非字典序
  assert.equal(compareVersions("0.150.1", "0.9.0"), 1);
  assert.equal(compareVersions("2.1.238", "2.2.0"), -1);
});

test("npmPackage maps known agents to their npm packages", () => {
  assert.equal(npmPackage("claude"), "@anthropic-ai/claude-code");
  assert.equal(npmPackage("codex"), "@openai/codex");
  assert.equal(npmPackage("opencode"), "opencode-ai");
  assert.throws(() => npmPackage("nope"), /Unknown npm package/);
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
