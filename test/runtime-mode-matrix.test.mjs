import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  configureProject,
  effectiveAgentConfig,
  getAgentRuntimeMode,
  importProjectSessions,
  initializeAgent,
  loadRuntime,
  projectConfig,
  runtimePaths,
  listCanonicalSessions,
  readCanonicalSession,
  setHistoryMode,
  setLocalAuth,
  clearLocalAuth,
} from "../packages/core/src/index.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The full matrix the model must hold for: each agent, each authentication
// method, that method's own scope, and each session scope — eight combinations
// per agent, and every one of them reversible without disturbing the others.
test("every authentication method and scope holds together with session scope", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-runtime-matrix-"));
  try {
    for (const agent of ["claude", "codex"]) {
      for (const authMethod of ["account", "api"]) {
        for (const scope of ["global", "project"]) {
          for (const sessionScope of ["global", "project"]) {
            const scopeField = authMethod === "account" ? "accountScope" : "configScope";
            await initializeAgent(root, agent, { authMethod, [scopeField]: scope, sessionScope });
            assert.deepEqual(await getAgentRuntimeMode(root, agent), {
              auth: { method: authMethod, scope, source: "project" },
              sessions: { scope: sessionScope },
            }, `${agent}: ${authMethod}/${scope}/${sessionScope}`);
          }
        }
      }
      // The per-developer override answers the method question for this
      // checkout only, and clearing it falls back to the project's own answer.
      await initializeAgent(root, agent, { authMethod: "account", accountScope: "global", sessionScope: "project" });
      await setLocalAuth(root, agent, { authMethod: "api", configScope: "project" });
      assert.deepEqual((await getAgentRuntimeMode(root, agent)).auth, { method: "api", scope: "project", source: "local" });
      await initializeAgent(root, agent, { authMethod: "api", configScope: "project", sessionScope: "global" });
      assert.deepEqual((await getAgentRuntimeMode(root, agent)).auth, { method: "api", scope: "project", source: "local" });
      await clearLocalAuth(root, agent);
      assert.deepEqual((await getAgentRuntimeMode(root, agent)).auth, { method: "api", scope: "project", source: "project" });
      await initializeAgent(root, agent, { authMethod: "account", accountScope: "project", sessionScope: "project" });
      const paths = runtimePaths(root);
      assert.ok(await readFile(paths.runtimeFile, "utf8"));
      // The method's own scope is the only one on disk: switching methods does
      // not leave the other method's answer behind as a second truth.
      const stored = JSON.parse(await readFile(paths.runtimeFile, "utf8")).agents[agent];
      assert.equal(stored.configScope, undefined, `${agent} keeps no API scope after answering Account`);
      assert.deepEqual(
        { authMethod: stored.authMethod, accountScope: stored.accountScope, sessionScope: stored.sessionScope },
        { authMethod: "account", accountScope: "project", sessionScope: "project" },
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project configuration keeps authentication, session storage and history independent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-project-config-"));
  try {
    await configureProject(root, {
      agents: {
        claude: { authMethod: "api", configScope: "project", sessionScope: "global" },
        codex: { authMethod: "account", accountScope: "global", sessionScope: "project" },
      },
      historyMode: "isolated",
    });
    let state = await loadRuntime(root);
    assert.deepEqual(projectConfig(state), {
      agents: {
        claude: { authMethod: "api", configScope: "project", sessionScope: "global" },
        codex: { authMethod: "account", accountScope: "global", sessionScope: "project" },
      },
      historyMode: "isolated",
    });

    await configureProject(root, { historyMode: "shared" });
    state = await loadRuntime(root);
    assert.equal(projectConfig(state).historyMode, "shared");
    assert.equal(effectiveAgentConfig(state, "claude").authMethod, "api");
    assert.equal(effectiveAgentConfig(state, "claude").configScope, "project");
    assert.equal(effectiveAgentConfig(state, "claude").sessionScope, "global");
    assert.equal(effectiveAgentConfig(state, "codex").authMethod, "account");
    assert.equal(effectiveAgentConfig(state, "codex").accountScope, "global");
    assert.equal(effectiveAgentConfig(state, "codex").sessionScope, "project");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("isolated to shared imports native histories without joining unrelated sessions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-isolated-shared-"));
  const claudeHome = await mkdtemp(path.join(os.tmpdir(), "avenic-claude-history-"));
  try {
    await configureProject(root, { agents: { claude: { authMethod: "account", accountScope: "global", sessionScope: "project" } }, historyMode: "isolated" });
    const key = path.resolve(root).replace(/[^a-zA-Z0-9]/g, "-");
    const native = path.join(claudeHome, "projects", key, "history.jsonl");
    await mkdir(path.dirname(native), { recursive: true });
    await writeFile(native, `${JSON.stringify({ type: "user", uuid: "u", sessionId: "native-claude", cwd: root, timestamp: "2026-09-17T00:00:00.000Z", message: { role: "user", content: "isolated history" } })}\n`);

    const transitioned = await setHistoryMode(root, "shared", {
      environmentForAgent: () => ({ ...process.env, CLAUDE_CONFIG_DIR: claudeHome }),
    });
    assert.equal(transitioned.previous, "isolated");
    assert.equal(transitioned.mode, "shared");
    assert.equal((await listCanonicalSessions(root)).length, 1);
    assert.equal((await loadRuntime(root)).runtime.historyMode, "shared");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(claudeHome, { recursive: true, force: true });
  }
});

test("a shared import under Account · Project reads the project's own home", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-project-home-import-"));
  const machineHome = await mkdtemp(path.join(os.tmpdir(), "avenic-machine-history-"));
  try {
    // Account · Project hands the agent the project's own home, so that is
    // where its runs write. The import on a mode change must read the home the
    // agent runs under: this machine's root holds other workspaces' — and
    // other answers' — conversations, and importing those would put a
    // stranger's history into this project's canonical store.
    await configureProject(root, {
      agents: { claude: { authMethod: "account", accountScope: "project", sessionScope: "project" } },
      historyMode: "isolated",
    });
    const key = path.resolve(root).replace(/[^a-zA-Z0-9]/g, "-");
    const record = (content) => `${JSON.stringify({ type: "user", uuid: "u", sessionId: "native-claude", cwd: root, timestamp: "2026-09-17T00:00:00.000Z", message: { role: "user", content } })}\n`;
    const inProject = path.join(root, ".agents", "local", "claude", "projects", key, "history.jsonl");
    await mkdir(path.dirname(inProject), { recursive: true });
    await writeFile(inProject, record("project home"));
    const onMachine = path.join(machineHome, "projects", key, "history.jsonl");
    await mkdir(path.dirname(onMachine), { recursive: true });
    await writeFile(onMachine, record("machine home"));

    const transitioned = await setHistoryMode(root, "shared", {
      environmentForAgent: () => ({ ...process.env, CLAUDE_CONFIG_DIR: machineHome }),
    });
    assert.equal(transitioned.imported[0].imported, 1);
    const sessions = await listCanonicalSessions(root);
    assert.equal(sessions.length, 1);
    const stored = await readCanonicalSession(root, sessions[0].id);
    assert.deepEqual(
      stored.events.map((event) => event.content[0]?.text),
      ["project home"],
      "the capture read the home the agent runs under, not the machine's",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(machineHome, { recursive: true, force: true });
  }
});

test("shared to isolated preserves canonical history and rejoining captures the isolated delta", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-shared-isolated-shared-"));
  const claudeHome = await mkdtemp(path.join(os.tmpdir(), "avenic-claude-delta-"));
  try {
    const environment = { ...process.env, CLAUDE_CONFIG_DIR: claudeHome };
    await configureProject(root, { agents: { claude: { authMethod: "account", accountScope: "global", sessionScope: "project" } }, historyMode: "shared" });
    const key = path.resolve(root).replace(/[^a-zA-Z0-9]/g, "-");
    const native = path.join(claudeHome, "projects", key, "history.jsonl");
    await mkdir(path.dirname(native), { recursive: true });
    const record = (id, content) => JSON.stringify({ type: "user", uuid: id, sessionId: "stable-native", cwd: root, timestamp: `2026-09-17T00:00:0${id}.000Z`, message: { role: "user", content } });
    await writeFile(native, `${record("1", "before isolation")}\n`);
    await setHistoryMode(root, "isolated", { environmentForAgent: () => environment });
    const first = await setHistoryMode(root, "shared", { environmentForAgent: () => environment });
    assert.equal(first.imported[0].imported, 1);
    const canonicalId = (await listCanonicalSessions(root))[0].id;
    assert.equal((await readCanonicalSession(root, canonicalId)).events.length, 1);

    await setHistoryMode(root, "isolated", { environmentForAgent: () => environment });
    await writeFile(native, `${record("1", "before isolation")}\n${record("2", "while isolated")}\n`);
    const rejoined = await setHistoryMode(root, "shared", { environmentForAgent: () => environment });
    assert.equal(rejoined.imported[0].failed, 0);
    const stored = await readCanonicalSession(root, canonicalId);
    assert.deepEqual(stored.events.map((event) => event.content[0]?.text), ["before isolation", "while isolated"]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(claudeHome, { recursive: true, force: true });
  }
});

// A caller that hands the import this process's own environment — `avenic
// sessions sync` does exactly that — still gets the home the project's runs
// write to. The test above passes because it composes the environment itself;
// this one holds when nobody does, which is the failure the real CLI had.
async function plantBothHomes(root, machineHome) {
  const key = path.resolve(root).replace(/[^a-zA-Z0-9]/g, "-");
  const record = (content) => `${JSON.stringify({ type: "user", uuid: "u", sessionId: "native-claude", cwd: root, timestamp: "2026-09-17T00:00:00.000Z", message: { role: "user", content } })}\n`;
  const inProject = path.join(root, ".agents", "local", "claude", "projects", key, "history.jsonl");
  await mkdir(path.dirname(inProject), { recursive: true });
  await writeFile(inProject, record("project home"));
  // The machine's agent root is `~/.claude`, which a redirected HOME moves:
  // nothing here sets CLAUDE_CONFIG_DIR, so this is where the host's world is
  // read from when the composition is missing.
  const onMachine = path.join(machineHome, ".claude", "projects", key, "history.jsonl");
  await mkdir(path.dirname(onMachine), { recursive: true });
  await writeFile(onMachine, record("machine home"));
}

async function assertProjectHomeImported(root) {
  const sessions = await listCanonicalSessions(root);
  assert.equal(sessions.length, 1, "one conversation");
  const stored = await readCanonicalSession(root, sessions[0].id);
  assert.deepEqual(
    stored.events.map((event) => event.content[0]?.text),
    ["project home"],
    "read the home the project's runs write to, not the machine's",
  );
}

test("an import handed only the machine's environment still reads the project's own home", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-sync-machine-env-"));
  const machineHome = await mkdtemp(path.join(os.tmpdir(), "avenic-sync-machine-home-"));
  try {
    await configureProject(root, {
      agents: { claude: { authMethod: "account", accountScope: "project", sessionScope: "project" } },
      historyMode: "shared",
    });
    await plantBothHomes(root, machineHome);
    const base = { ...process.env, USERPROFILE: machineHome, HOME: machineHome };
    delete base.CLAUDE_CONFIG_DIR;
    delete base.CODEX_HOME;
    const result = await importProjectSessions(root, "claude", { environment: base });
    assert.equal(result.imported, 1);
    await assertProjectHomeImported(root);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(machineHome, { recursive: true, force: true });
  }
});

test("avenic sessions sync in a real process reads the project's own home", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-sync-cli-"));
  const machineHome = await mkdtemp(path.join(os.tmpdir(), "avenic-sync-cli-home-"));
  try {
    await configureProject(root, {
      agents: { claude: { authMethod: "account", accountScope: "project", sessionScope: "project" } },
      historyMode: "shared",
    });
    await plantBothHomes(root, machineHome);
    const environment = { ...process.env, USERPROFILE: machineHome, HOME: machineHome };
    delete environment.CLAUDE_CONFIG_DIR;
    delete environment.CODEX_HOME;
    const synced = spawnSync(process.execPath, [path.join(packageRoot, "packages", "cli", "scripts", "skills.mjs"), "sessions", "sync"], {
      cwd: root,
      encoding: "utf8",
      env: environment,
      windowsHide: true,
    });
    assert.equal(synced.status, 0, synced.stderr || synced.stdout);
    assert.match(synced.stdout, /Synced 1 native session/);
    await assertProjectHomeImported(root);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(machineHome, { recursive: true, force: true });
  }
});
