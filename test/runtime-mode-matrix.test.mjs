import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  getAgentRuntimeMode,
  initializeAgent,
  loadRuntime,
  runtimePaths,
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
    await (await import("node:fs/promises")).rm(root, { recursive: true, force: true });
  }
});
