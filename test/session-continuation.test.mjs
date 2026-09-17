import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendCanonicalEvents,
  continueCanonicalSession,
  completeCanonicalContinuation,
  createCanonicalSession,
  continuationLaunchArguments,
  prepareCanonicalContinuation,
  readCanonicalSession,
  getActiveCanonicalSessionId,
  setActiveCanonicalSession,
  reconcileCanonicalSession,
} from "../packages/core/src/index.mjs";

async function withProject(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-continuation-"));
  try { await run(root); } finally { await (await import("node:fs/promises")).rm(root, { recursive: true, force: true }); }
}

const event = (id, role, value) => ({
  id,
  role,
  createdAt: "2026-09-15T00:00:00.000Z",
  content: [{ type: "text", text: value }],
});

test("continuation launch arguments use official resume commands and handoff as an explicit prompt", () => {
  const handoff = { markdown: "# Avenic continuation\nNew shared events since your last sync:\n- assistant: D" };
  const claude = continuationLaunchArguments({ agentId: "claude", mode: "resume", nativeSessionId: "123e4567-e89b-12d3-a456-426614174000", handoff });
  assert.deepEqual(claude.argumentsList, ["-p", "--output-format", "json", "--resume", "123e4567-e89b-12d3-a456-426614174000"]);
  assert.equal(claude.input, handoff.markdown);
  const codex = continuationLaunchArguments({ agentId: "codex", mode: "resume", nativeSessionId: "thread-1", handoff });
  assert.deepEqual(codex.argumentsList, ["exec", "resume", "thread-1", "-"]);
  const newClaude = continuationLaunchArguments({ agentId: "claude", mode: "bootstrap", handoff, nativeSessionId: "123e4567-e89b-12d3-a456-426614174001" });
  assert.deepEqual(newClaude.argumentsList, ["-p", "--output-format", "json", "--session-id", "123e4567-e89b-12d3-a456-426614174001"]);
});

test("native capture metadata does not erase the continuation cursor", async () => {
  await withProject(async (projectRoot) => {
    await createCanonicalSession(projectRoot, { id: "cursor" });
    await appendCanonicalEvents(projectRoot, "cursor", [event("a", "user", "A")]);
    await completeCanonicalContinuation(projectRoot, "cursor", "claude", { nativeSessionId: "native-1", projectionHash: "handoff" });
    const { syncNativeMapping } = await import("../packages/core/src/index.mjs");
    await syncNativeMapping(projectRoot, "cursor", { agentId: "claude", nativeSessionId: "native-1", nativeRevision: "new" });
    const stored = await readCanonicalSession(projectRoot, "cursor");
    assert.equal(stored.mappings.projections.claude.lastCanonicalEventId, "a");
    assert.equal(stored.mappings.projections.claude.projectionHash, "handoff");
  });
});

test("active canonical pointer is durable and recovery reconciliation is safe with no mappings", async () => {
  await withProject(async (projectRoot) => {
    await createCanonicalSession(projectRoot, { id: "active" });
    await setActiveCanonicalSession(projectRoot, "active");
    assert.equal(await getActiveCanonicalSessionId(projectRoot), "active");
    assert.deepEqual(await reconcileCanonicalSession(projectRoot, "active"), []);
  });
});

test("startup reconciliation captures native messages left behind by an abrupt exit", async () => {
  await withProject(async (projectRoot) => {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), "avenic-crash-codex-"));
    try {
      await createCanonicalSession(projectRoot, { id: "crash" });
      await appendCanonicalEvents(projectRoot, "crash", [event("a", "user", "A"), event("b", "assistant", "B")]);
      const rollout = path.join(codexHome, "sessions", "2026", "09", "16", "rollout-crash.jsonl");
      await mkdir(path.dirname(rollout), { recursive: true });
      const record = (id, role, text) => JSON.stringify({ timestamp: "2026-09-16T00:00:00Z", type: "response_item", payload: { id, type: "message", role, content: [{ type: "input_text", text }] } });
      await writeFile(rollout, [
        JSON.stringify({ timestamp: "2026-09-16T00:00:00Z", type: "session_meta", payload: { id: "crash-thread", cwd: projectRoot } }),
        record("c", "user", "C"), record("d", "assistant", "D"),
      ].join("\n") + "\n");
      const { syncNativeMapping } = await import("../packages/core/src/index.mjs");
      await syncNativeMapping(projectRoot, "crash", { agentId: "codex", nativeSessionId: "crash-thread", lastCanonicalEventId: "b" });
      const result = await reconcileCanonicalSession(projectRoot, "crash", { environment: { ...process.env, CODEX_HOME: codexHome } });
      const stored = await readCanonicalSession(projectRoot, "crash");
      assert.equal(result[0].agentId, "codex");
      assert.equal(stored.events.length, 4);
      assert.deepEqual(stored.events.slice(-2).map((item) => item.content[0].text), ["C", "D"]);
    } finally {
      await (await import("node:fs/promises")).rm(codexHome, { recursive: true, force: true });
    }
  });
});

test("prepare and complete continuation maintain an agent cursor without changing launch environment", async () => {
  await withProject(async (projectRoot) => {
    await createCanonicalSession(projectRoot, { id: "shared", source: "claude" });
    await appendCanonicalEvents(projectRoot, "shared", [event("a", "user", "A"), event("b", "assistant", "B")]);

    const first = await prepareCanonicalContinuation(projectRoot, "shared", "codex");
    assert.equal(first.mode, "bootstrap");
    assert.deepEqual(first.handoff.delta.map((item) => item.id), ["a", "b"]);
    assert.equal("environment" in first, false, "auth/runtime environment belongs to the caller");

    await completeCanonicalContinuation(projectRoot, "shared", "codex", {
      nativeSessionId: "thread-1",
      nativeRevision: "native-1",
      projectionHash: first.handoff.hash,
    });
    await appendCanonicalEvents(projectRoot, "shared", [event("c", "user", "C"), event("d", "assistant", "D")]);

    const resumed = await prepareCanonicalContinuation(projectRoot, "shared", "codex");
    assert.equal(resumed.mode, "resume");
    assert.equal(resumed.nativeSessionId, "thread-1");
    assert.deepEqual(resumed.handoff.delta.map((item) => item.id), ["c", "d"]);

    const stored = await readCanonicalSession(projectRoot, "shared");
    assert.equal(stored.mappings.projections.codex.lastCanonicalEventId, "b");
    assert.equal(stored.mappings.projections.codex.projectionHash, first.handoff.hash);
  });
});

test("one continuation entry captures, launches, captures again, and advances one mapping cursor", async () => {
  await withProject(async (projectRoot) => {
    await createCanonicalSession(projectRoot, { id: "pipeline" });
    await appendCanonicalEvents(projectRoot, "pipeline", [event("a", "user", "A")]);
    const calls = [];
    const result = await continueCanonicalSession({
      projectRoot,
      canonicalId: "pipeline",
      targetAgent: "codex",
      capture: async (stage) => {
        calls.push(`capture:${stage}`);
        return stage === "after" ? { nativeSessionId: "thread-1", events: [event("b", "assistant", "B")], nativeRevision: "r2" } : null;
      },
      launch: async (continuation) => {
        calls.push(`${continuation.mode}:${continuation.handoff.delta.map((item) => item.id).join(",")}`);
        return { nativeSessionId: "thread-1", projectionHash: continuation.handoff.hash };
      },
    });
    assert.deepEqual(calls, ["capture:before", "bootstrap:a", "capture:after"]);
    assert.equal(result.mapping.nativeSessionId, "thread-1");
    assert.equal(result.mapping.lastCanonicalEventId, "b");
    assert.deepEqual((await readCanonicalSession(projectRoot, "pipeline")).events.map((item) => item.id), ["a", "b"]);
  });
});

test("continuation captures known source projections before preparing the target delta", async () => {
  await withProject(async (projectRoot) => {
    await createCanonicalSession(projectRoot, { id: "known-source" });
    const calls = [];
    await continueCanonicalSession({
      projectRoot,
      canonicalId: "known-source",
      targetAgent: "codex",
      captureKnown: async () => {
        calls.push("known");
        await appendCanonicalEvents(projectRoot, "known-source", [event("a", "user", "A")]);
      },
      capture: async (stage) => {
        calls.push(`capture:${stage}`);
        return stage === "after" ? { nativeSessionId: "thread-1", events: [] } : null;
      },
      launch: async (continuation) => {
        calls.push(`launch:${continuation.handoff.delta.map((item) => item.id).join(",")}`);
        return { nativeSessionId: "thread-1" };
      },
    });
    assert.deepEqual(calls, ["known", "capture:before", "launch:a", "capture:after"]);
  });
});

test("a stale native mapping rehydrates from canonical history without advancing its cursor early", async () => {
  await withProject(async (projectRoot) => {
    await createCanonicalSession(projectRoot, { id: "stale" });
    await appendCanonicalEvents(projectRoot, "stale", [event("a", "user", "A"), event("b", "assistant", "B")]);
    await completeCanonicalContinuation(projectRoot, "stale", "claude", { nativeSessionId: "missing-session" });
    const calls = [];
    const result = await continueCanonicalSession({
      projectRoot,
      canonicalId: "stale",
      targetAgent: "claude",
      capture: async (stage) => {
        calls.push(`capture:${stage}`);
        if (stage === "before") throw new Error("Claude native session is unavailable: missing-session");
        return { nativeSessionId: "rehydrated-session", events: [event("c", "assistant", "C")], nativeRevision: "r3" };
      },
      launch: async (continuation) => {
        calls.push(`${continuation.mode}:${continuation.handoff.delta.map((item) => item.id).join(",")}`);
        return { nativeSessionId: "rehydrated-session", projectionHash: continuation.handoff.hash };
      },
    });
    assert.deepEqual(calls, ["capture:before", "bootstrap:a,b", "capture:after"]);
    assert.equal(result.mapping.nativeSessionId, "rehydrated-session");
    assert.equal(result.mapping.lastCanonicalEventId, "c");
  });
});

test("a stale Codex rollout rehydrates without changing canonical history", async () => {
  await withProject(async (projectRoot) => {
    await createCanonicalSession(projectRoot, { id: "stale-codex" });
    await appendCanonicalEvents(projectRoot, "stale-codex", [event("a", "user", "A"), event("b", "assistant", "B")]);
    await completeCanonicalContinuation(projectRoot, "stale-codex", "codex", { nativeSessionId: "missing-rollout" });
    const calls = [];
    const result = await continueCanonicalSession({
      projectRoot,
      canonicalId: "stale-codex",
      targetAgent: "codex",
      capture: async (stage) => {
        calls.push(`capture:${stage}`);
        if (stage === "before") throw new Error("Codex native session is unavailable: missing-rollout");
        return { nativeSessionId: "new-thread", events: [event("c", "assistant", "C")], nativeRevision: "r2" };
      },
      launch: async (continuation) => {
        calls.push(`${continuation.mode}:${continuation.handoff.delta.map((item) => item.id).join(",")}`);
        return { nativeSessionId: "new-thread", projectionHash: continuation.handoff.hash };
      },
    });
    assert.deepEqual(calls, ["capture:before", "bootstrap:a,b", "capture:after"]);
    assert.equal(result.mapping.nativeSessionId, "new-thread");
    assert.match(result.diagnostics[0], /restored from shared Avenic history/);
    const stored = await readCanonicalSession(projectRoot, "stale-codex");
    assert.deepEqual(stored.events.map((item) => item.id), ["a", "b", "c"]);
  });
});

test("Codex v2 sub-agent mappings resolve to their resumable parent thread", async () => {
  await withProject(async (projectRoot) => {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), "avenic-v2-codex-"));
    try {
      const rollout = path.join(codexHome, "sessions", "2026", "09", "17", "rollout-child.jsonl");
      await mkdir(path.dirname(rollout), { recursive: true });
      await writeFile(rollout, `${JSON.stringify({ type: "session_meta", payload: { id: "child", parent_thread_id: "parent", multi_agent_version: 2, cwd: projectRoot } })}\n`);
      const { resolveResumableSession } = await import("../packages/core/src/runtime/adapters/codex.mjs");
      assert.equal(await resolveResumableSession(projectRoot, "child", { environment: { CODEX_HOME: codexHome } }), "parent");
      await createCanonicalSession(projectRoot, { id: "v2" });
      await completeCanonicalContinuation(projectRoot, "v2", "codex", { nativeSessionId: "child" });
      const continuation = await prepareCanonicalContinuation(projectRoot, "v2", "codex", { environment: { CODEX_HOME: codexHome } });
      assert.equal(continuation.mode, "resume");
      assert.equal(continuation.nativeSessionId, "parent");
    } finally {
      await (await import("node:fs/promises")).rm(codexHome, { recursive: true, force: true });
    }
  });
});
