import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { detectAgentInstallation } from "../packages/core/src/index.mjs";

function probe(options) {
  const files = new Set(options.files ?? []);
  const links = options.links ?? {};
  return detectAgentInstallation("codex", {
    platform: "linux",
    environment: { PATH: options.path ?? "" },
    cwd: options.cwd ?? "/workspace/project",
    home: "/home/avenic",
    fileExists: (file) => files.has(file),
    realpath: (file) => links[file] ?? file,
    runVersion: () => "codex-cli 0.150.1",
  });
}

function probeAgent(agentId, options) {
  const files = new Set(options.files ?? []);
  const links = options.links ?? {};
  return detectAgentInstallation(agentId, {
    platform: "linux",
    environment: { PATH: options.path ?? "" },
    cwd: options.cwd ?? "/workspace/project",
    fileExists: (file) => files.has(file),
    realpath: (file) => links[file] ?? file,
    runVersion: () => "1.2.3",
  });
}

test("detectAgentInstallation follows the first active Codex binary on PATH", () => {
  const installation = probe({
    path: "/home/avenic/.local/bin:/usr/local/bin",
    files: ["/home/avenic/.local/bin/codex", "/usr/local/bin/codex"],
    links: { "/home/avenic/.local/bin/codex": "/home/avenic/.codex/packages/standalone/0.150.1/codex" },
  });

  assert.equal(installation.executable, "/home/avenic/.local/bin/codex");
  assert.equal(installation.resolvedExecutable, "/home/avenic/.codex/packages/standalone/0.150.1/codex");
  assert.equal(installation.installMethod, "standalone");
  assert.equal(installation.updateStrategy.kind, "standalone");
});

test("detectAgentInstallation distinguishes global and project-local npm Codex", () => {
  const global = probe({
    path: "/opt/npm/bin",
    files: ["/opt/npm/bin/codex"],
    links: { "/opt/npm/bin/codex": "/opt/npm/lib/node_modules/@openai/codex/bin/codex.js" },
  });
  assert.equal(global.installMethod, "npm-global");
  assert.equal(global.packageManager, "npm");
  assert.match(global.updateStrategy.command, /^npm install --global @openai\/codex@latest$/);

  const local = probe({
    path: "/workspace/project/node_modules/.bin",
    files: ["/workspace/project/node_modules/.bin/codex"],
    links: { "/workspace/project/node_modules/.bin/codex": "/workspace/project/node_modules/@openai/codex/bin/codex.js" },
  });
  assert.equal(local.installMethod, "npm-local");
  assert.equal(local.packageManager, "npm");
  assert.match(local.updateStrategy.command, /^npm install @openai\/codex@latest$/);
});

test("detectAgentInstallation identifies Homebrew and leaves unknown binaries untouched", () => {
  const brew = probe({
    path: "/opt/homebrew/bin",
    files: ["/opt/homebrew/bin/codex"],
    links: { "/opt/homebrew/bin/codex": "/opt/homebrew/Cellar/codex/0.150.1/bin/codex" },
  });
  assert.equal(brew.installMethod, "brew");
  assert.equal(brew.updateStrategy.command, "brew upgrade --cask codex");

  const unknown = probe({ path: "/usr/local/bin", files: ["/usr/local/bin/codex"] });
  assert.equal(unknown.installMethod, "binary");
  assert.equal(unknown.updateStrategy.kind, "manual");
  assert.equal(unknown.updateStrategy.command, null);
});

test("detectAgentInstallation recognizes a Codex source build without choosing an updater", () => {
  const installation = probe({
    path: "/workspace/codex/target/release",
    files: ["/workspace/codex/target/release/codex", "/workspace/codex/.git"],
    links: { "/workspace/codex/target/release/codex": "/workspace/codex/codex-cli/target/release/codex" },
  });
  assert.equal(installation.installMethod, "source");
  assert.equal(installation.updateStrategy.kind, "manual");
});

test("detectAgentInstallation reports a missing executable without assuming npm", () => {
  const installation = probe({});
  assert.equal(installation.executable, null);
  assert.equal(installation.resolvedExecutable, null);
  assert.equal(installation.version, null);
  assert.equal(installation.installMethod, "unknown");
  assert.equal(installation.updateStrategy.kind, "manual");
});

test("detectAgentInstallation uses each agent's package metadata instead of a Codex branch", () => {
  const claude = probeAgent("claude", {
    path: "/workspace/project/node_modules/.bin",
    files: ["/workspace/project/node_modules/.bin/claude"],
    links: { "/workspace/project/node_modules/.bin/claude": "/workspace/project/node_modules/@anthropic-ai/claude-code/cli.js" },
  });
  assert.equal(claude.installMethod, "npm-local");
  assert.equal(claude.updateStrategy.command, "npm install @anthropic-ai/claude-code@latest");

  const opencode = probeAgent("opencode", {
    path: "/opt/npm/bin",
    files: ["/opt/npm/bin/opencode"],
    links: { "/opt/npm/bin/opencode": "/opt/npm/lib/node_modules/opencode-ai/bin/opencode.js" },
  });
  assert.equal(opencode.installMethod, "npm-global");
  assert.equal(opencode.updateStrategy.command, "npm install --global opencode-ai@latest");
});
