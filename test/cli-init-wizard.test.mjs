import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadRuntime, projectConfig } from "../packages/core/src/index.mjs";
import { runCli } from "../packages/cli/src/cli/dispatcher.mjs";
import { FakeTTY, fakeStdout, keys, visible } from "./helpers/fake-tty.mjs";
import { keepingHostProject } from "./helpers/host-project.mjs";

// `avenic init` and `avenic change` on a terminal are the wizard a user meets
// first: pick the agents, then each agent's auth and session storage, then the
// history mode, then confirm. The prompted values must be exactly what gets
// written, so the wizard is driven here key by key, in a project whose agent
// storage is an empty temp home (never the machine running the tests).

async function waitFor(condition, description, timeout = 8000) {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeout) {
      throw new Error(`timeout waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function withWizardProject(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-init-wizard-"));
  const projectRoot = path.join(root, "project");
  const home = path.join(root, "home");
  const logged = [];
  const realLog = console.log;
  const patched = ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "AVENIC_STATE_DIR"];
  const saved = Object.fromEntries(patched.map((name) => [name, process.env[name]]));
  try {
    await mkdir(projectRoot, { recursive: true });
    await mkdir(path.join(home, ".claude"), { recursive: true });
    await mkdir(path.join(home, ".codex"), { recursive: true });
    Object.assign(process.env, {
      HOME: home,
      USERPROFILE: home,
      CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
      CODEX_HOME: path.join(home, ".codex"),
      AVENIC_STATE_DIR: path.join(root, "state"),
    });
    console.log = (...parts) => logged.push(parts.join(" "));
    await keepingHostProject(() => run({
      projectRoot,
      logged,
      /** The wizard as a terminal presents it: a TTY on both ends. */
      wizard(command) {
        const stdin = new FakeTTY();
        const stdout = fakeStdout();
        return { stdin, stdout, promise: runCli({ argumentsList: [command], prompts: { stdin, stdout }, projectRootOverride: projectRoot }) };
      },
      async config() {
        return projectConfig(await loadRuntime(projectRoot));
      },
    }));
  } finally {
    console.log = realLog;
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
}

test("avenic init writes exactly what the wizard asked for", async () => {
  await withWizardProject(async ({ projectRoot, logged, wizard, config }) => {
    const { stdin, stdout, promise } = wizard("init");
    await waitFor(() => /◆ {2}Select agents/.test(visible(stdout.text())), "the agent picker");
    keys(stdin, " ", "\x1b[B", " ", "\r"); // Claude Code, then Codex
    for (const title of ["Claude Code authentication", "Claude Code session storage", "Codex authentication", "Codex session storage", "Session history"]) {
      await waitFor(() => new RegExp(`◆ {2}${title}`).test(visible(stdout.text())), title);
      keys(stdin, "\r"); // the offered default: Global auth, project sessions, shared history
    }
    await waitFor(() => /◆ {2}Apply configuration\?/.test(visible(stdout.text())), "the confirmation");
    keys(stdin, "y");
    assert.equal(await promise, 0);

    const written = await config();
    assert.deepEqual(Object.keys(written.agents).sort(), ["claude", "codex"]);
    assert.deepEqual(written.agents.claude, { auth: "global", sessions: "project" });
    assert.deepEqual(written.agents.codex, { auth: "global", sessions: "project" });
    assert.equal(written.sessionInterop, "shared");
    // The result is a page of the same terminal layer the wizard drew: a ◇
    // History section with the mode under it, not a hand-written summary line.
    assert.ok(logged.some((line) => /◇ {2}History/.test(line)), `the result must have a History section: ${JSON.stringify(logged)}`);
    assert.ok(logged.some((line) => /│ {2}Mode\s+shared/.test(line)), `the summary must state the mode: ${JSON.stringify(logged)}`);
    assert.ok(logged.some((line) => line.includes("Avenic project initialized")), `the run must say what it did: ${JSON.stringify(logged)}`);
    assert.ok(existsSync(path.join(projectRoot, ".agents", "runtime.json")), "the project config is on disk");
  });
});

test("a wizard that is cancelled leaves no half-written configuration", async () => {
  await withWizardProject(async ({ projectRoot, wizard }) => {
    const configPath = path.join(projectRoot, ".agents", "runtime.json");
    // Esc while choosing agents.
    const escaped = wizard("init");
    await waitFor(() => /◆ {2}Select agents/.test(visible(escaped.stdout.text())), "the agent picker");
    keys(escaped.stdin, " ", "\x1b");
    assert.equal(await escaped.promise, 0);
    assert.ok(!existsSync(configPath), "cancelling mid-wizard writes nothing");

    // Esc at the confirmation, after every question was answered.
    const declined = wizard("init");
    await waitFor(() => /◆ {2}Select agents/.test(visible(declined.stdout.text())), "the agent picker");
    keys(declined.stdin, " ", "\r");
    for (const title of ["Claude Code authentication", "Claude Code session storage", "Session history"]) {
      await waitFor(() => new RegExp(`◆ {2}${title}`).test(visible(declined.stdout.text())), title);
      keys(declined.stdin, "\r");
    }
    await waitFor(() => /◆ {2}Apply configuration\?/.test(visible(declined.stdout.text())), "the confirmation");
    keys(declined.stdin, "n");
    assert.equal(await declined.promise, 0);
    assert.ok(!existsSync(configPath), "declining the confirmation writes nothing");
  });
});

test("avenic change adds an agent and switches history mode from the wizard", async () => {
  await withWizardProject(async ({ projectRoot, logged, wizard, config }) => {
    const initialized = await runCli({
      argumentsList: ["init", "--agents", "claude,codex", "--auth", "global", "--sessions", "project", "--history", "shared"],
      projectRootOverride: projectRoot,
    });
    assert.equal(initialized, 0);

    const { stdin, stdout, promise } = wizard("change");
    await waitFor(() => /◆ {2}Select enabled agents/.test(visible(stdout.text())), "the enabled-agent picker");
    keys(stdin, "\x1b[B", "\x1b[B", " ", "\r"); // cursor starts on the two enabled agents, add OpenCode
    for (const title of ["Claude Code authentication", "Claude Code session storage", "Codex authentication", "Codex session storage", "OpenCode authentication", "OpenCode session storage"]) {
      await waitFor(() => new RegExp(`◆ {2}${title}`).test(visible(stdout.text())), title);
      keys(stdin, "\r");
    }
    await waitFor(() => /◆ {2}Session history/.test(visible(stdout.text())), "the history mode");
    keys(stdin, "\x1b[B", "\r"); // Shared → Isolated
    await waitFor(() => /◆ {2}Apply configuration\?/.test(visible(stdout.text())), "the confirmation");
    keys(stdin, "y");
    assert.equal(await promise, 0);

    const written = await config();
    assert.deepEqual(Object.keys(written.agents).sort(), ["claude", "codex", "opencode"]);
    assert.equal(written.sessionInterop, "isolated");
    assert.ok(logged.some((line) => /│ {2}Mode\s+isolated/.test(line)), JSON.stringify(logged));
    assert.ok(logged.some((line) => line.includes("Avenic project updated")), JSON.stringify(logged));
  });
});
