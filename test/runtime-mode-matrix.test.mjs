import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  configureProject,
  effectiveAgentConfig,
  getAgentRuntimeMode,
  initializeAgent,
  loadRuntime,
  projectConfig,
  runtimePaths,
  listCanonicalSessions,
  setSessionInteropMode,
  setLocalAuth,
  clearLocalAuth,
} from "../packages/core/src/index.mjs";

test("auth and session modes are independent and all four combinations are reversible", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-runtime-matrix-"));
  try {
    for (const agent of ["claude", "codex"]) {
      for (const auth of ["global", "project"]) {
        for (const sessions of ["global", "project"]) {
          await initializeAgent(root, agent, auth, sessions);
          const mode = await getAgentRuntimeMode(root, agent);
          assert.deepEqual(mode, {
            auth: { default: auth, localOverride: null, effective: auth },
            sessions: { mode: sessions },
          });
        }
      }
      await initializeAgent(root, agent, "global", "project");
      await setLocalAuth(root, agent, "project");
      assert.deepEqual((await getAgentRuntimeMode(root, agent)).auth, {
        default: "global", localOverride: "project", effective: "project",
      });
      await initializeAgent(root, agent, "project", "global");
      assert.deepEqual(await getAgentRuntimeMode(root, agent), {
        auth: { default: "project", localOverride: "project", effective: "project" },
        sessions: { mode: "global" },
      });
      await clearLocalAuth(root, agent);
      assert.equal((await getAgentRuntimeMode(root, agent)).auth.effective, "project");
      await initializeAgent(root, agent, "project", "project");
      const paths = runtimePaths(root);
      assert.ok(await readFile(paths.runtimeFile, "utf8"));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project configuration keeps auth, storage, and interop mode independent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-project-config-"));
  try {
    await configureProject(root, {
      agents: {
        claude: { auth: "project", sessions: "global" },
        codex: { auth: "global", sessions: "project" },
      },
      sessionInterop: "isolated",
    });
    let state = await loadRuntime(root);
    assert.deepEqual(projectConfig(state), {
      agents: {
        claude: { auth: "project", sessions: "global" },
        codex: { auth: "global", sessions: "project" },
      },
      sessionInterop: "isolated",
    });

    await configureProject(root, { sessionInterop: "shared" });
    state = await loadRuntime(root);
    assert.equal(projectConfig(state).sessionInterop, "shared");
    assert.equal(effectiveAgentConfig(state, "claude").auth, "project");
    assert.equal(effectiveAgentConfig(state, "claude").sessions, "global");
    assert.equal(effectiveAgentConfig(state, "codex").auth, "global");
    assert.equal(effectiveAgentConfig(state, "codex").sessions, "project");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("isolated to shared imports native histories without joining unrelated sessions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-isolated-shared-"));
  const claudeHome = await mkdtemp(path.join(os.tmpdir(), "avenic-claude-history-"));
  try {
    await configureProject(root, { agents: { claude: { auth: "global", sessions: "project" } }, sessionInterop: "isolated" });
    const key = path.resolve(root).replace(/[^a-zA-Z0-9]/g, "-");
    const native = path.join(claudeHome, "projects", key, "history.jsonl");
    await mkdir(path.dirname(native), { recursive: true });
    await writeFile(native, `${JSON.stringify({ type: "user", uuid: "u", sessionId: "native-claude", cwd: root, timestamp: "2026-09-17T00:00:00.000Z", message: { role: "user", content: "isolated history" } })}\n`);

    const transitioned = await setSessionInteropMode(root, "shared", {
      environmentForAgent: () => ({ ...process.env, CLAUDE_CONFIG_DIR: claudeHome }),
    });
    assert.equal(transitioned.previous, "isolated");
    assert.equal(transitioned.mode, "shared");
    assert.equal((await listCanonicalSessions(root)).length, 1);
    assert.equal((await loadRuntime(root)).runtime.sessionInterop, "shared");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(claudeHome, { recursive: true, force: true });
  }
});
