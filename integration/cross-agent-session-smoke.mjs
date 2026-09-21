// Live smoke: isolate only project/canonical state; inherit active agent auth.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendCanonicalEvents, continueCanonicalSession, createCanonicalSession, initializeAgent, readCanonicalSession, resolveEffectiveAgentRuntime } from "../packages/core/src/index.mjs";
import * as claude from "../packages/core/src/runtime/adapters/claude.mjs";
import * as codex from "../packages/core/src/runtime/adapters/codex.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "avenic-cross-agent-"));
const project = path.join(root, "project");
const marker = `AVENIC_SMOKE_${randomUUID().slice(0, 8)}`;
const claudeId = randomUUID();
await mkdir(project, { recursive: true });
await initializeAgent(project, "claude", { authMethod: "account", accountScope: "global", sessionScope: "project" });
await initializeAgent(project, "codex", { authMethod: "account", accountScope: "global", sessionScope: "project" });

async function run(agentId, args) {
  const runtime = await resolveEffectiveAgentRuntime(project, agentId, { argumentsList: args });
  const result = spawnSync(runtime.executable, runtime.argumentsList, { cwd: project, env: runtime.environment, encoding: "utf8", windowsHide: true, timeout: 300000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}
async function mapping(agentId) {
  return (await readCanonicalSession(project, "cross")).mappings.projections[agentId];
}
async function capture(adapter, agentId, context) {
  const id = context.launched?.nativeSessionId ?? context.continuation?.nativeSessionId ?? (await mapping(agentId))?.nativeSessionId;
  return id ? adapter.readCanonical(project, id) : null;
}

await createCanonicalSession(project, { id: "cross", source: "claude", title: marker });
const firstClaude = await continueCanonicalSession({
  projectRoot: project, canonicalId: "cross", targetAgent: "claude",
  capture: (stage, context = {}) => capture(claude, "claude", context),
  launch: async (continuation) => {
    const output = JSON.parse(await run("claude", ["-p", "--output-format", "json", "--session-id", claudeId,
      `${continuation.handoff.markdown}\n\nUser A ${marker}; reply with ${marker} and B.`]));
    assert.match(output.result, new RegExp(marker));
    assert.equal(output.session_id, claudeId);
    return { nativeSessionId: claudeId, projectionHash: continuation.handoff.hash };
  },
});
assert.equal(firstClaude.continuation.mode, "bootstrap");

const codexLaunch = await continueCanonicalSession({
  projectRoot: project, canonicalId: "cross", targetAgent: "codex",
  captureKnown: async () => {
    const current = await mapping("claude");
    if (current?.nativeSessionId) await appendCanonicalEvents(project, "cross", (await claude.readCanonical(project, current.nativeSessionId)).events);
  },
  capture: (stage, context = {}) => capture(codex, "codex", context),
  launch: async (continuation) => {
    assert.ok(continuation.handoff.markdown.includes(marker), "Codex must receive Claude context");
    const output = await run("codex", ["exec", "--json", "--skip-git-repo-check", `${continuation.handoff.markdown}\n\nUser C ${marker}; reply with ${marker} and D.`]);
    const started = output.split(/\r?\n/).find((line) => line.includes('"thread.started"'));
    assert.ok(started, output);
    return { nativeSessionId: JSON.parse(started).thread_id, projectionHash: continuation.handoff.hash };
  },
});
assert.equal(codexLaunch.continuation.mode, "bootstrap");

const resumedClaude = await continueCanonicalSession({
  projectRoot: project, canonicalId: "cross", targetAgent: "claude",
  captureKnown: async () => {
    const current = await mapping("codex");
    if (current?.nativeSessionId) await appendCanonicalEvents(project, "cross", (await codex.readCanonical(project, current.nativeSessionId)).events);
  },
  capture: (stage, context = {}) => capture(claude, "claude", context),
  launch: async (continuation) => {
    assert.equal(continuation.mode, "resume");
    assert.equal(continuation.nativeSessionId, claudeId);
    const initialIds = new Set(firstClaude.captured.events.map((event) => event.id));
    assert.ok(continuation.handoff.delta.length >= 2);
    assert.ok(continuation.handoff.delta.every((event) => !initialIds.has(event.id)), "Claude delta must not repeat A/B");
    const output = JSON.parse(await run("claude", ["-p", "--output-format", "json", "--resume", claudeId,
      `${continuation.handoff.markdown}\n\nUser E ${marker}; reply with ${marker} and F.`]));
    assert.equal(output.session_id, claudeId);
    assert.match(output.result, new RegExp(marker));
    return { nativeSessionId: claudeId, projectionHash: continuation.handoff.hash };
  },
});

const final = await readCanonicalSession(project, "cross");
const repeated = await appendCanonicalEvents(project, "cross", (await claude.readCanonical(project, claudeId)).events);
assert.equal(repeated.added, 0);
assert.equal(new Set(final.events.map((event) => event.id)).size, final.events.length);
assert.equal(final.mappings.projections.claude.nativeSessionId, claudeId);
assert.equal(final.mappings.projections.codex.nativeSessionId, codexLaunch.launched.nativeSessionId);
assert.equal(resumedClaude.mapping.nativeSessionId, claudeId);
assert.ok(final.events.some((event) => event.content.some((part) => part.text?.includes(marker))));
console.log(`PASS marker=${marker} claude=${claudeId} codex=${codexLaunch.launched.nativeSessionId} events=${final.events.length} delta=${resumedClaude.continuation.handoff.delta.length} repeatedAdded=${repeated.added}`);
