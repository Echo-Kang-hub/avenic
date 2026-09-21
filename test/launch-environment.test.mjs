import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { durableEnvironment } from "../packages/core/src/index.mjs";
import { environmentHome } from "../packages/core/src/runtime/environment.mjs";
import { claudeProjectKey, hasProjectCopy as hasClaudeCopy } from "../packages/core/src/runtime/adapters/claude.mjs";
import { hasProjectCopy as hasCodexCopy } from "../packages/core/src/runtime/adapters/codex.mjs";
import { watchdogState } from "../packages/cli/src/cli/watchdog.mjs";

// A launch hands its own environment to a detached process by way of a file in
// the temp directory, which then sits there for as long as the launch group
// lives — hours, on a long agent run. The environment a user launches with is
// the one that pays for the agent, so what reaches that file is decided by an
// allow-list of the variables that resolve native storage and home, never by
// copying the environment across.

const LAUNCH_ENVIRONMENT = {
  PATH: "C:\\bin;C:\\Windows",
  Path: "C:\\bin;C:\\Windows",
  HOME: "C:\\Users\\someone",
  USERPROFILE: "C:\\Users\\someone",
  TEMP: "C:\\Users\\someone\\AppData\\Local\\Temp",
  CLAUDE_CONFIG_DIR: "C:\\Users\\someone\\.claude",
  CODEX_HOME: "C:\\Users\\someone\\.codex",
  XDG_CONFIG_HOME: "C:\\Users\\someone\\.config",
  // Everything below is present in a real launch and is what must not be
  // written down: a token, a key, and a projected model config that carries one.
  ANTHROPIC_AUTH_TOKEN: "sk-ant-live-0000000000000000",
  ANTHROPIC_API_KEY: "sk-ant-key-0000000000000000",
  OPENAI_API_KEY: "sk-openai-0000000000000000",
  GITHUB_TOKEN: "ghp_00000000000000000000000000000000000000",
  AWS_SECRET_ACCESS_KEY: "aws-secret",
  MY_PASSWORD: "hunter2",
  CODEX_ASKPASS: "C:\\helper.exe",
  OPENCODE_CONFIG_CONTENT: '{"provider":{"options":{"apiKey":"sk-projected-0000"}}}',
  // Not secret, simply not needed by the process that reads the file.
  NODE_OPTIONS: "--max-old-space-size=8192",
  npm_config_registry: "https://registry.example.invalid/",
};

test("the launch environment keeps what finds an agent's storage, and nothing else", () => {
  const kept = durableEnvironment(LAUNCH_ENVIRONMENT);
  assert.deepEqual(Object.keys(kept).sort(), [
    "CLAUDE_CONFIG_DIR", "CODEX_HOME", "HOME", "PATH", "Path", "TEMP", "USERPROFILE", "XDG_CONFIG_HOME",
  ]);
  assert.equal(kept.Path, LAUNCH_ENVIRONMENT.Path, "the inheritance spelling is the one the agent's launcher will see");
});

test("a credential is refused even if a later allow-list entry names it", () => {
  // The rule is two-sided on purpose: the list says what a detached capture
  // needs, and a name that reads like a credential is refused regardless — so
  // widening the list cannot quietly widen what reaches the disk.
  assert.deepEqual(durableEnvironment({ CLAUDE_CONFIG_DIR_TOKEN: "x", PATH: "/bin" }), { PATH: "/bin" });
});

test("the watchdog state file carries no credential and no environment wholesale", () => {
  const state = watchdogState("claude", "C:\\project", "4242-1-0", LAUNCH_ENVIRONMENT, 1000, 4242);
  const written = JSON.stringify(state);
  for (const secret of [
    LAUNCH_ENVIRONMENT.ANTHROPIC_AUTH_TOKEN,
    LAUNCH_ENVIRONMENT.ANTHROPIC_API_KEY,
    LAUNCH_ENVIRONMENT.OPENAI_API_KEY,
    LAUNCH_ENVIRONMENT.GITHUB_TOKEN,
    LAUNCH_ENVIRONMENT.AWS_SECRET_ACCESS_KEY,
    LAUNCH_ENVIRONMENT.MY_PASSWORD,
    LAUNCH_ENVIRONMENT.CODEX_ASKPASS,
    "sk-projected-0000",
  ]) {
    assert.equal(written.includes(secret), false, `${secret} must not be written to the launch state`);
  }
  assert.equal(state.environment.PATH, LAUNCH_ENVIRONMENT.PATH, "a detached capture still finds the agent's CLI");
  assert.equal(state.environment.CLAUDE_CONFIG_DIR, LAUNCH_ENVIRONMENT.CLAUDE_CONFIG_DIR);
  assert.equal(state.parentPid, 4242);
  assert.equal(state.member, "4242-1-0");
});

test("an environment with nothing durable in it yields an empty object, not the whole environment", () => {
  assert.deepEqual(durableEnvironment({ ANTHROPIC_AUTH_TOKEN: "sk-x", TERM: "xterm" }), {});
  assert.deepEqual(durableEnvironment(undefined ?? {}), {});
});

test("an adapter finds native storage through the home the environment names", async () => {
  // Snapshot, capture and revert resolve CLAUDE_CONFIG_DIR / CODEX_HOME — and,
  // absent those, the home — from the environment they are handed. A fallback
  // to this process's own homedir would read and write the developer's root
  // during a run that used the fixture's.
  const home = await mkdtemp(path.join(os.tmpdir(), "avenic-adapter-home-"));
  try {
    const projectRoot = path.join(home, "project");
    await mkdir(projectRoot, { recursive: true });
    const environment = { HOME: home, USERPROFILE: home };
    const sessionId = "11111111-2222-3333-4444-000000000001";

    const claudeDir = path.join(home, ".claude", "projects", claudeProjectKey(projectRoot));
    await mkdir(claudeDir, { recursive: true });
    await writeFile(path.join(claudeDir, `${sessionId}.jsonl`), "{}\n");
    assert.equal(await hasClaudeCopy(projectRoot, sessionId, { environment }), true);

    const codexDir = path.join(home, ".codex", "sessions", "2026", "09", "18");
    await mkdir(codexDir, { recursive: true });
    const meta = JSON.stringify({ type: "session_meta", payload: { id: sessionId, cwd: projectRoot, model_provider: "openai" } });
    await writeFile(path.join(codexDir, `rollout-${sessionId}.jsonl`), `${meta}\n`);
    assert.equal(await hasCodexCopy(projectRoot, sessionId, { environment }), true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("the machine's home is read from the environment it is given", () => {
  // A host that only sets `HOME` has still said where home is — on either
  // platform — and the answer must never be this process's own home.
  assert.equal(environmentHome({ HOME: "/tmp/fixture-home" }), "/tmp/fixture-home");
  // Where both names are present, the platform's own decides.
  const both = { HOME: "/tmp/fixture-home", USERPROFILE: "/tmp/fixture-user" };
  assert.equal(environmentHome(both), process.platform === "win32" ? "/tmp/fixture-user" : "/tmp/fixture-home");
});
