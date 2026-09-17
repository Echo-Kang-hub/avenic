import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendCanonicalEvents,
  createCanonicalSession,
  getSessionAdapter,
  importProjectSessions,
  readCanonicalSession,
  syncNativeMapping,
} from "../packages/core/src/index.mjs";

async function withStore(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-canonical-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("canonical store creates a versioned session and filters credential-like metadata", async () => {
  await withStore(async (projectRoot) => {
    const created = await createCanonicalSession(projectRoot, {
      title: "Interop fixture",
      source: "claude",
      metadata: { apiKey: "must-not-persist", safe: "kept" },
    });
    assert.match(created.id, /^[0-9a-f-]{36}$/);
    const stored = await readCanonicalSession(projectRoot, created.id);
    assert.equal(stored.session.schemaVersion, 1);
    assert.deepEqual(stored.state, {
      schemaVersion: 1,
      goal: null,
      currentTask: null,
      completed: [],
      pending: null,
      decisions: [],
      relevantFiles: [],
      blockers: [],
      warnings: [],
    });
    assert.equal(stored.session.title, "Interop fixture");
    assert.equal(stored.session.metadata.safe, "kept");
    assert.equal("apiKey" in stored.session.metadata, false);
  });
});

test("canonical event append is deterministic, idempotent, and preserves unknown native fields", async () => {
  await withStore(async (projectRoot) => {
    const { id } = await createCanonicalSession(projectRoot, { source: "codex" });
    const event = {
      id: "codex:message-1",
      role: "assistant",
      createdAt: "2026-09-14T00:00:00.000Z",
      content: [{ type: "text", text: "B" }],
      extensions: { codex: { future_field: { retained: true } } },
    };
    assert.deepEqual(await appendCanonicalEvents(projectRoot, id, [event]), { added: 1, duplicate: 0 });
    assert.deepEqual(await appendCanonicalEvents(projectRoot, id, [event]), { added: 0, duplicate: 1 });
    const stored = await readCanonicalSession(projectRoot, id);
    assert.deepEqual(stored.events, [event]);
  });
});

test("native mappings retain stable projection identity and revision hashes", async () => {
  await withStore(async (projectRoot) => {
    const { id } = await createCanonicalSession(projectRoot, { source: "opencode" });
    await syncNativeMapping(projectRoot, id, {
      agentId: "opencode",
      nativeSessionId: "ses_123",
      nativeRevision: "native-hash",
      canonicalRevision: "canonical-hash",
    });
    await syncNativeMapping(projectRoot, id, {
      agentId: "opencode",
      nativeSessionId: "ses_123",
      nativeRevision: "native-hash-2",
      canonicalRevision: "canonical-hash-2",
    });
    const stored = await readCanonicalSession(projectRoot, id);
    assert.equal(stored.mappings.projections.opencode.nativeSessionId, "ses_123");
    assert.equal(stored.mappings.projections.opencode.nativeRevision, "native-hash-2");
    assert.equal(Object.keys(stored.mappings.projections).length, 1);
  });
});

test("canonical files stay inside the canonical session root", async () => {
  await withStore(async (projectRoot) => {
    await assert.rejects(() => createCanonicalSession(projectRoot, { id: "../escape" }), /safe session id/i);
    const canonicalRoot = path.join(projectRoot, ".agents", "sessions", "canonical");
    const entries = await readFile(path.join(canonicalRoot, "..", "..", "runtime.json"), "utf8").catch(() => null);
    assert.equal(entries, null);
  });
});

test("project native import creates a canonical mapping and stays idempotent", async () => {
  await withStore(async (projectRoot) => {
    const claudeHome = path.join(projectRoot, "claude-config");
    const native = path.join(claudeHome, "projects", getSessionAdapter("claude").claudeProjectKey(projectRoot), "legacy-claude.jsonl");
    await (await import("node:fs/promises")).mkdir(path.dirname(native), { recursive: true });
    await (await import("node:fs/promises")).writeFile(native, `${JSON.stringify({ type: "user", uuid: "u", sessionId: "legacy-claude", cwd: projectRoot, timestamp: "2026-09-16T00:00:00.000Z", message: { role: "user", content: "legacy" } })}\n`);

    const first = await importProjectSessions(projectRoot, "claude", { environment: { CLAUDE_CONFIG_DIR: claudeHome } });
    const second = await importProjectSessions(projectRoot, "claude", { environment: { CLAUDE_CONFIG_DIR: claudeHome } });
    const stored = await readCanonicalSession(projectRoot, "claude-legacy-claude");
    assert.deepEqual({ discovered: first.discovered, imported: first.imported, unchanged: first.unchanged }, { discovered: 1, imported: 1, unchanged: 0 });
    assert.deepEqual({ discovered: second.discovered, imported: second.imported, unchanged: second.unchanged }, { discovered: 1, imported: 0, unchanged: 1 });
    assert.equal(stored.events.length, 1);
    assert.equal(stored.mappings.projections.claude.nativeSessionId, "legacy-claude");
  });
});

test("project native import reports malformed native history instead of silently returning zero", async () => {
  await withStore(async (projectRoot) => {
    const claudeHome = path.join(projectRoot, "claude-config");
    const native = path.join(claudeHome, "projects", getSessionAdapter("claude").claudeProjectKey(projectRoot), "broken.jsonl");
    await (await import("node:fs/promises")).mkdir(path.dirname(native), { recursive: true });
    await (await import("node:fs/promises")).writeFile(native, "{not json}\n");
    const result = await importProjectSessions(projectRoot, "claude", { environment: { CLAUDE_CONFIG_DIR: claudeHome } });
    assert.equal(result.discovered, 0);
    assert.equal(result.failed, 1);
    assert.match(result.diagnostics.at(-1), /could not (parse|identify)/i);
  });
});

test("Codex project history imports to portable and canonical stores idempotently", async () => {
  await withStore(async (projectRoot) => {
    const codexHome = path.join(projectRoot, "codex-home");
    const rollout = path.join(codexHome, "sessions", "2026", "rollout.jsonl");
    await (await import("node:fs/promises")).mkdir(path.dirname(rollout), { recursive: true });
    const rows = [
      { type: "session_meta", payload: { id: "legacy-codex", cwd: projectRoot, model_provider: "openai" } },
      { type: "response_item", timestamp: "2026-09-16T00:00:00.000Z", payload: { id: "u", type: "message", role: "user", content: [{ type: "input_text", text: "A" }] } },
    ];
    await (await import("node:fs/promises")).writeFile(rollout, `${rows.map(JSON.stringify).join("\n")}\n`);
    const options = { environment: { CODEX_HOME: codexHome } };
    const first = await importProjectSessions(projectRoot, "codex", options);
    const second = await importProjectSessions(projectRoot, "codex", options);
    const stored = await readCanonicalSession(projectRoot, "codex-legacy-codex");
    assert.deepEqual([first.discovered, first.imported, first.unchanged], [1, 1, 0]);
    assert.deepEqual([second.discovered, second.imported, second.unchanged], [1, 0, 1]);
    assert.equal(stored.mappings.projections.codex.nativeSessionId, "legacy-codex");
  });
});
