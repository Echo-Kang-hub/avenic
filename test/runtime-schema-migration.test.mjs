import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  configureProject,
  effectiveAgentConfig,
  loadRuntime,
  projectConfig,
  resolveEffectiveAgentRuntime,
  runtimePaths,
} from "../packages/core/src/index.mjs";

// The released 1.8.x schema stored one `auth: "global"|"project"` per agent and a
// project-level `sessionInterop`. The converged model splits authentication from
// model configuration and names every axis. These tests pin the one-time
// migration, which must never guess when the old file does not say, and must
// never delete what the user already has on disk.

async function legacyProject(t, { runtime, local = null, overlays = {} }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-schema-migration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = runtimePaths(root);
  await mkdir(path.dirname(paths.runtimeFile), { recursive: true });
  await writeFile(paths.runtimeFile, `${JSON.stringify(runtime, null, 2)}\n`);
  if (local) {
    await mkdir(path.dirname(paths.localRuntimeFile), { recursive: true });
    await writeFile(paths.localRuntimeFile, `${JSON.stringify(local, null, 2)}\n`);
  }
  // The projection of a released version lived in Claude's own project settings
  // — written here by its literal path, not by asking the product where it
  // would write it, so a product that moved the path would fail this test
  // instead of moving the fixture with it.
  for (const value of Object.values(overlays)) {
    const file = path.join(root, ".claude", "settings.local.json");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
  }
  return root;
}

const legacyRuntime = (agents, sessionInterop = "shared") => ({
  schemaVersion: 2,
  agents,
  sessionInterop,
});

const overlay = {
  env: {
    ANTHROPIC_BASE_URL: "https://provider.fixture.invalid/anthropic",
    ANTHROPIC_AUTH_TOKEN: "fixture-token-not-a-secret",
    ANTHROPIC_MODEL: "fixture-model",
  },
};

test("legacy project auth with its overlay migrates to API configuration in project scope", async (t) => {
  const root = await legacyProject(t, {
    runtime: legacyRuntime({
      claude: { enabled: true, auth: "project", sessions: "global" },
      codex: { enabled: true, auth: "global", sessions: "project" },
    }, "isolated"),
    overlays: { claude: overlay },
  });
  const state = await loadRuntime(root);
  assert.deepEqual(projectConfig(state), {
    agents: {
      claude: { authMethod: "api", configScope: "project", sessionScope: "global" },
      codex: { authMethod: "account", accountScope: "global", sessionScope: "project" },
    },
    historyMode: "isolated",
  });

  // The old keys are gone from the file — after migration there is one schema.
  const stored = JSON.parse(await readFile(state.paths.runtimeFile, "utf8"));
  assert.equal(stored.schemaVersion, 3);
  assert.equal(stored.historyMode, "isolated");
  assert.equal(stored.sessionInterop, undefined);
  assert.equal(stored.agents.claude.auth, undefined);
  assert.equal(stored.agents.claude.sessions, undefined);

  // The migrated project can launch: the entry is a whole answer, not a scope
  // with the method missing — which is what a wrong projection path produced.
  const runtime = await resolveEffectiveAgentRuntime(root, "claude", { environment: {} });
  assert.equal(runtime.authMethod, "api");
  assert.equal(runtime.scope, "project");

  // The user's own overlay file is not ours to delete.
  const kept = JSON.parse(await readFile(path.join(root, ".claude", "settings.local.json"), "utf8"));
  assert.equal(kept.env.ANTHROPIC_BASE_URL, overlay.env.ANTHROPIC_BASE_URL);
});

test("legacy global auth is the machine's own account", async (t) => {
  const root = await legacyProject(t, {
    runtime: legacyRuntime({ claude: { enabled: true, auth: "global", sessions: "project" } }),
  });
  const state = await loadRuntime(root);
  assert.deepEqual(projectConfig(state).agents.claude, {
    authMethod: "account", accountScope: "global", sessionScope: "project",
  });
  // Which is the answer the released version ran under: the machine's own
  // account and its own configuration home, environment untouched.
  const environment = { PATH: "/fixture/bin" };
  const runtime = await resolveEffectiveAgentRuntime(root, "claude", { environment });
  assert.equal(runtime.environment, environment);
});

test("legacy project auth without a projection is the project's own sign-in", async (t) => {
  const root = await legacyProject(t, {
    runtime: legacyRuntime({ claude: { enabled: true, auth: "project", sessions: "project" } }),
  });
  const state = await loadRuntime(root);
  assert.deepEqual(projectConfig(state).agents.claude, {
    authMethod: "account", accountScope: "project", sessionScope: "project",
  });
  const runtime = await resolveEffectiveAgentRuntime(root, "claude", { environment: {} });
  assert.equal(runtime.environment.CLAUDE_CONFIG_DIR, path.join(root, ".agents", "local", "claude"));
});

test("an empty legacy projection is not content, so the axis stands", async (t) => {
  const root = await legacyProject(t, {
    runtime: legacyRuntime({ claude: { enabled: true, auth: "project", sessions: "project" } }),
    overlays: { claude: { env: {} } },
  });
  const state = await loadRuntime(root);
  assert.equal(projectConfig(state).agents.claude.authMethod, "account");
  assert.equal(projectConfig(state).agents.claude.accountScope, "project");
});

test("migration runs once: a second read changes nothing on disk", async (t) => {
  const root = await legacyProject(t, {
    runtime: legacyRuntime({ claude: { enabled: true, auth: "project", sessions: "project" } }),
    overlays: { claude: overlay },
  });
  const first = await loadRuntime(root);
  const after = await stat(first.paths.runtimeFile);
  const content = await readFile(first.paths.runtimeFile, "utf8");
  // A migrated file must look canonical on its own: schemaVersion 3, no
  // leftover legacy keys — otherwise the check would re-run forever.
  assert.equal(JSON.parse(content).schemaVersion, 3);
  await loadRuntime(root);
  await loadRuntime(root);
  const again = await stat(first.paths.runtimeFile);
  assert.equal(await readFile(first.paths.runtimeFile, "utf8"), content);
  assert.equal(again.mtimeMs, after.mtimeMs);
});

test("a local override migrates under the same rules and stays effective", async (t) => {
  const root = await legacyProject(t, {
    runtime: legacyRuntime({ claude: { enabled: true, auth: "global", sessions: "project" } }),
    local: { schemaVersion: 1, agents: { claude: { auth: "project" } } },
    overlays: { claude: overlay },
  });
  const state = await loadRuntime(root);
  const effective = effectiveAgentConfig(state, "claude");
  assert.equal(effective.authMethod, "api");
  assert.equal(effective.configScope, "project");
  assert.equal(effective.sessionScope, "project");
  assert.equal(effective.local?.authMethod, "api");
  const storedLocal = JSON.parse(await readFile(state.paths.localRuntimeFile, "utf8"));
  assert.equal(storedLocal.schemaVersion, 3);
  assert.equal(storedLocal.agents.claude.auth, undefined);
});

test("the canonical file holds the chosen fields and no derived ones", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-schema-canonical-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await configureProject(root, {
    agents: {
      claude: { authMethod: "account", accountScope: "project", sessionScope: "project" },
      codex: { authMethod: "api", configScope: "global", sessionScope: "global" },
      opencode: { sessionScope: "project" },
    },
    historyMode: "shared",
  });
  const state = await loadRuntime(root);
  const stored = JSON.parse(await readFile(state.paths.runtimeFile, "utf8"));
  assert.deepEqual(stored.agents.claude, {
    enabled: true, authMethod: "account", accountScope: "project", sessionScope: "project",
  });
  assert.deepEqual(stored.agents.codex, {
    enabled: true, authMethod: "api", configScope: "global", sessionScope: "global",
  });
  // OpenCode's auth and provider are its own: Avenic stores a session choice only.
  assert.deepEqual(stored.agents.opencode, { enabled: true, sessionScope: "project" });
});
