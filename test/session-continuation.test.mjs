import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
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
  ensureNativeProjection,
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

// A mapping names a conversation, and the projection layer refuses to resume
// one that exists in no store — that ghost is exactly what answers "No
// conversation found with session ID". These tests stub the materializer, so
// the rollout a real capture would have written has to be written by hand:
// otherwise the mapping they set up names a conversation that does not exist,
// and the guard correctly ignores it.
async function holdCodexThread(projectRoot, id) {
  const rollout = path.join(projectRoot, ".agents", "sessions", "codex", "sessions", "2026", "09", "16", `rollout-${id}.jsonl`);
  await mkdir(path.dirname(rollout), { recursive: true });
  await writeFile(rollout, `${JSON.stringify({ type: "session_meta", payload: { id, cwd: projectRoot } })}\n`);
}

test("a projection is launched by the agent that prepared it, and one that is already current costs no projection", async () => {
  await withProject(async (projectRoot) => {
    await createCanonicalSession(projectRoot, { id: "shared" });
    await appendCanonicalEvents(projectRoot, "shared", [event("a", "user", "A")]);
    let calls = 0;
    const first = await ensureNativeProjection({
      projectRoot, canonicalId: "shared", targetAgent: "codex", intent: "resume-catalog",
      materialize: async ({ mapping }) => {
        calls += 1;
        assert.equal(mapping, null, "the first projection has no mapping to continue");
        return { nativeSessionId: "thread-1", materialized: true, projection: { lastEventId: "a", hash: "h1" }, launch: { argumentsList: ["resume", "thread-1"] } };
      },
    });
    // The first projection created thread-1; the run's capture is what puts it
    // in the project's own store, and a mapping is only current while the
    // conversation it names is held somewhere real.
    await holdCodexThread(projectRoot, "thread-1");
    const second = await ensureNativeProjection({
      projectRoot, canonicalId: "shared", targetAgent: "codex", intent: "resume-catalog",
      materialize: async () => { calls += 1; return { nativeSessionId: "thread-2" }; },
    });
    assert.equal(first.status, "materialized");
    assert.deepEqual(first.launch.argumentsList, ["resume", "thread-1"]);
    // Nothing new since the last switch: the mapping is current and no
    // projection is asked for at all.
    assert.equal(second.status, "current");
    assert.equal(second.nativeSessionId, "thread-1");
    assert.equal(second.launch, null);
    assert.equal(calls, 1);
  });
});

test("continuation launch arguments use official resume commands and handoff as an explicit prompt", () => {
  const handoff = { markdown: "# Avenic continuation\nNew shared events since your last sync:\n- assistant: D" };
  const prompt = "# Avenic continuation New shared events since your last sync: - assistant: D";
  // A projection launches itself: the adapter decided between resuming a native
  // session, resuming one it just built, and opening a fresh one.
  const projected = continuationLaunchArguments({
    agentId: "codex", mode: "resume", nativeSessionId: "thread-1",
    launch: { argumentsList: ["resume", "thread-1"] }, handoff,
  });
  assert.deepEqual(projected.argumentsList, ["resume", "thread-1"]);
  // The prompt path is the fallback for an agent with no projection at all.
  const claude = continuationLaunchArguments({ agentId: "claude", mode: "resume", nativeSessionId: "123e4567-e89b-12d3-a456-426614174000", handoff });
  assert.deepEqual(claude.argumentsList, ["--resume", "123e4567-e89b-12d3-a456-426614174000", prompt]);
  assert.equal(claude.input, undefined);
  const codex = continuationLaunchArguments({ agentId: "codex", mode: "resume", nativeSessionId: "thread-1", handoff });
  assert.deepEqual(codex.argumentsList, ["resume", "thread-1", prompt]);
  // OpenCode names the conversation with a flag and takes the handoff as a
  // prompt; a bootstrap is a fresh official session that opens with it.
  const opencode = continuationLaunchArguments({ agentId: "opencode", mode: "resume", nativeSessionId: "ses_one", handoff });
  assert.deepEqual(opencode.argumentsList, ["--session", "ses_one", "--prompt", prompt]);
  assert.deepEqual(continuationLaunchArguments({ agentId: "opencode", mode: "bootstrap", nativeSessionId: null, handoff }).argumentsList, ["--prompt", prompt]);
  const newClaude = continuationLaunchArguments({ agentId: "claude", mode: "bootstrap", handoff, nativeSessionId: "123e4567-e89b-12d3-a456-426614174001" });
  assert.deepEqual(newClaude.argumentsList, ["--session-id", "123e4567-e89b-12d3-a456-426614174001", prompt]);
  assert.throws(() => continuationLaunchArguments({ agentId: "codex", mode: "resume" }), /projection or a handoff/);
});

test("continuation prompt keeps untrusted cmd metacharacters out of Windows shim arguments", () => {
  const handoff = { markdown: "User text: A & B \"quoted\" %PATH% | cmd < input > output ^ ! (test)" };
  const prompt = continuationLaunchArguments({ agentId: "codex", mode: "bootstrap", handoff }).argumentsList[0];
  assert.doesNotMatch(prompt, /[&|^<>()%!\"]/);
  assert.match(prompt, /User text: A/);
  assert.match(prompt, /quoted/);
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
    const projected = [];
    const materialize = async ({ events, mapping }) => {
      projected.push({ ids: events.map((item) => item.id), mapping: mapping?.nativeSessionId ?? null });
      return {
        kind: "native-history",
        nativeSessionId: "thread-1",
        materialized: !mapping,
        projection: { lastEventId: events.at(-1)?.id ?? null, hash: `h${projected.length}` },
        launch: { argumentsList: ["resume", "thread-1"] },
      };
    };

    const first = await prepareCanonicalContinuation(projectRoot, "shared", "codex", { materialize });
    assert.equal(first.mode, "bootstrap");
    assert.equal(first.kind, "native-history");
    assert.equal("environment" in first, false, "auth/runtime environment belongs to the caller");
    assert.deepEqual(first.launch.argumentsList, ["resume", "thread-1"]);
    // A projection carries the turns themselves; the compatibility prompt is not
    // written when one exists.
    assert.equal(existsSync(path.join(projectRoot, ".agents", "sessions", "canonical", "shared", "handoff.md")), false);
    // What the run's capture would have stored: thread-1 now lives in the
    // project, so the mapping it wrote still names a resumable conversation.
    await holdCodexThread(projectRoot, "thread-1");

    await completeCanonicalContinuation(projectRoot, "shared", "codex", {
      nativeSessionId: "thread-1",
      nativeRevision: "native-1",
      projectionHash: first.projection.hash,
    });
    await appendCanonicalEvents(projectRoot, "shared", [event("c", "user", "C"), event("d", "assistant", "D")]);

    const resumed = await prepareCanonicalContinuation(projectRoot, "shared", "codex", { materialize });
    assert.equal(resumed.mode, "resume");
    assert.equal(resumed.nativeSessionId, "thread-1");
    assert.deepEqual(projected.map((entry) => entry.ids), [["a", "b"], ["a", "b", "c", "d"]]);
    // The second projection continues the native session the first one made.
    assert.deepEqual(projected.map((entry) => entry.mapping), [null, "thread-1"]);

    const stored = await readCanonicalSession(projectRoot, "shared");
    assert.equal(stored.mappings.projections.codex.lastCanonicalEventId, "d");
    assert.equal(stored.mappings.projections.codex.projectionHash, "h2");
  });
});

// One projection per continuation, in the order the pipeline asks for it: the
// target's own session first, then the delta it is missing.
function testMaterializer(trace) {
  return async ({ events, mapping }) => {
    trace.push({ ids: events.map((item) => item.id), mapping: mapping?.nativeSessionId ?? null });
    return {
      nativeSessionId: trace.at(-1).mapping ?? `thread-${trace.length}`,
      materialized: !mapping,
      projection: { lastEventId: events.at(-1)?.id ?? null, hash: `h${trace.length}` },
      launch: { argumentsList: ["resume", trace.at(-1).mapping ?? `thread-${trace.length}`] },
    };
  };
}

test("one continuation entry captures, launches, captures again, and advances one mapping cursor", async () => {
  await withProject(async (projectRoot) => {
    await createCanonicalSession(projectRoot, { id: "pipeline" });
    await appendCanonicalEvents(projectRoot, "pipeline", [event("a", "user", "A")]);
    const calls = [];
    const projections = [];
    const result = await continueCanonicalSession({
      projectRoot,
      canonicalId: "pipeline",
      targetAgent: "codex",
      materialize: testMaterializer(projections),
      capture: async (stage) => {
        calls.push(`capture:${stage}`);
        return stage === "after" ? { nativeSessionId: "thread-1", events: [event("b", "assistant", "B")], nativeRevision: "r2" } : null;
      },
      launch: async (continuation) => {
        calls.push(`${continuation.mode}:${continuation.launch.argumentsList.join(" ")}`);
        return { nativeSessionId: continuation.nativeSessionId, projectionHash: continuation.projection?.hash };
      },
    });
    assert.deepEqual(calls, ["capture:before", "bootstrap:resume thread-1", "capture:after"]);
    assert.deepEqual(projections.map((entry) => entry.ids), [["a"]]);
    assert.equal(result.mapping.nativeSessionId, "thread-1");
    assert.equal(result.mapping.lastCanonicalEventId, "b");
    assert.deepEqual((await readCanonicalSession(projectRoot, "pipeline")).events.map((item) => item.id), ["a", "b"]);
  });
});

test("continuation captures known source projections before preparing the target delta", async () => {
  await withProject(async (projectRoot) => {
    await createCanonicalSession(projectRoot, { id: "known-source" });
    const calls = [];
    const projections = [];
    await continueCanonicalSession({
      projectRoot,
      canonicalId: "known-source",
      targetAgent: "codex",
      materialize: testMaterializer(projections),
      captureKnown: async () => {
        calls.push("known");
        await appendCanonicalEvents(projectRoot, "known-source", [event("a", "user", "A")]);
      },
      capture: async (stage) => {
        calls.push(`capture:${stage}`);
        return stage === "after" ? { nativeSessionId: "thread-1", events: [] } : null;
      },
      launch: async () => {
        calls.push(`launch:${projections.at(-1).ids.join(",")}`);
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
    const projections = [];
    const result = await continueCanonicalSession({
      projectRoot,
      canonicalId: "stale",
      targetAgent: "claude",
      materialize: testMaterializer(projections),
      capture: async (stage) => {
        calls.push(`capture:${stage}`);
        if (stage === "before") throw new Error("Claude native session is unavailable: missing-session");
        return { nativeSessionId: "rehydrated-session", events: [event("c", "assistant", "C")], nativeRevision: "r3" };
      },
      launch: async (continuation) => {
        calls.push(`${continuation.mode}:${projections.at(-1).ids.join(",")}`);
        return { nativeSessionId: continuation.nativeSessionId, projectionHash: continuation.projection?.hash };
      },
    });
    // The dead session is gone, so the whole history is projected again — as a
    // native session, never as a prompt.
    assert.deepEqual(calls, ["capture:before", "bootstrap:a,b", "capture:after"]);
    assert.deepEqual(projections.map((entry) => entry.mapping), [null]);
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
    const projections = [];
    const result = await continueCanonicalSession({
      projectRoot,
      canonicalId: "stale-codex",
      targetAgent: "codex",
      materialize: testMaterializer(projections),
      capture: async (stage) => {
        calls.push(`capture:${stage}`);
        if (stage === "before") throw new Error("Codex native session is unavailable: missing-rollout");
        return { nativeSessionId: "new-thread", events: [event("c", "assistant", "C")], nativeRevision: "r2" };
      },
      launch: async (continuation) => {
        calls.push(`${continuation.mode}:${projections.at(-1).ids.join(",")}`);
        return { nativeSessionId: continuation.nativeSessionId, projectionHash: continuation.projection?.hash };
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
      assert.deepEqual(continuationLaunchArguments(continuation).argumentsList.slice(0, 2), ["resume", "parent"]);
    } finally {
      await (await import("node:fs/promises")).rm(codexHome, { recursive: true, force: true });
    }
  });
});

test("Codex v2 nested sub-agent mappings resolve the resumable root without looping", async () => {
  await withProject(async (projectRoot) => {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), "avenic-v2-codex-chain-"));
    try {
      const directory = path.join(codexHome, "sessions", "2026", "09", "18");
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "parent.jsonl"), `${JSON.stringify({ type: "session_meta", payload: { id: "parent", cwd: projectRoot } })}\n`);
      await writeFile(path.join(directory, "child.jsonl"), `${JSON.stringify({ type: "session_meta", payload: { id: "child", parent_thread_id: "parent", multi_agent_version: "v2", cwd: projectRoot } })}\n`);
      await writeFile(path.join(directory, "grandchild.jsonl"), `${JSON.stringify({ type: "session_meta", payload: { id: "grandchild", parent_thread_id: "child", multi_agent_version: "v2", cwd: projectRoot } })}\n`);
      const { resolveResumableSession } = await import("../packages/core/src/runtime/adapters/codex.mjs");
      assert.equal(await resolveResumableSession(projectRoot, "grandchild", { environment: { CODEX_HOME: codexHome } }), "parent");
    } finally {
      await (await import("node:fs/promises")).rm(codexHome, { recursive: true, force: true });
    }
  });
});

test("Codex capture never imports a mapped rollout from another project", async () => {
  await withProject(async (projectRoot) => {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), "avenic-codex-cwd-"));
    const otherProject = await mkdtemp(path.join(os.tmpdir(), "avenic-codex-other-"));
    try {
      const rollout = path.join(codexHome, "sessions", "2026", "09", "17", "rollout-foreign.jsonl");
      await mkdir(path.dirname(rollout), { recursive: true });
      await writeFile(rollout, `${JSON.stringify({ type: "session_meta", payload: { id: "foreign", cwd: otherProject } })}\n`);
      const { readCanonical } = await import("../packages/core/src/runtime/adapters/codex.mjs");
      await assert.rejects(
        readCanonical(projectRoot, "foreign", { environment: { CODEX_HOME: codexHome } }),
        /Codex native session is unavailable/,
      );
    } finally {
      const { rm } = await import("node:fs/promises");
      await rm(codexHome, { recursive: true, force: true });
      await rm(otherProject, { recursive: true, force: true });
    }
  });
});
