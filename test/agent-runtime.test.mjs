import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeAgent, resolveEffectiveAgentRuntime } from "../packages/core/src/index.mjs";

test("effective runtime resolution preserves the normal environment and does not invent a model", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-runtime-resolution-"));
  try {
    await initializeAgent(root, "claude", "global", "project");
    const environment = { PATH: "C:\\agents", ANTHROPIC_BASE_URL: "https://provider.invalid", ANTHROPIC_MODEL: "provider-model" };
    const runtime = await resolveEffectiveAgentRuntime(root, "claude", { environment, argumentsList: ["--resume", "native"] });
    assert.equal(runtime.authScope, "global");
    assert.equal(runtime.provider, null);
    assert.equal(runtime.model, null);
    assert.deepEqual(runtime.argumentsList, ["--resume", "native"]);
    assert.equal(runtime.environment.ANTHROPIC_MODEL, "provider-model");
    assert.equal(runtime.environment.ANTHROPIC_BASE_URL, "https://provider.invalid");
  } finally {
    await (await import("node:fs/promises")).rm(root, { recursive: true, force: true });
  }
});
