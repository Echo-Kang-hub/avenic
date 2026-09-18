import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { appendCanonicalEvents, readCanonicalSession } from "../packages/core/src/runtime/canonical-sessions.mjs";
import { importProjectSessions } from "../packages/core/src/runtime/session-interop.mjs";
import { withClaudeProject } from "./helpers/session-fixture.mjs";

test("a repeated import of unchanged natives appends nothing", async () => {
  await withClaudeProject(async ({ projectRoot, environment, sessionIds, canonicalDirectory }) => {
    const first = await importProjectSessions(projectRoot, "claude", { environment });
    assert.equal(first.discovered, sessionIds.length);
    assert.equal(first.imported, sessionIds.length);

    const eventsFile = path.join(canonicalDirectory(`claude-${sessionIds[0]}`), "events.jsonl");
    const before = await stat(eventsFile);
    const second = await importProjectSessions(projectRoot, "claude", { environment });
    assert.equal(second.skipped, sessionIds.length, "unchanged sessions are never re-parsed");
    assert.equal(second.imported, 0);
    assert.equal(second.unchanged, sessionIds.length);
    assert.equal((await stat(eventsFile)).mtimeMs, before.mtimeMs, "events.jsonl must not be rewritten");
  });
});

test("appending to one native session imports only its delta and stays idempotent", async () => {
  await withClaudeProject(async ({ projectRoot, environment, sessionIds, appendRecords }) => {
    await importProjectSessions(projectRoot, "claude", { environment });
    const canonicalId = `claude-${sessionIds[0]}`;
    const before = (await readCanonicalSession(projectRoot, canonicalId)).events.length;

    await appendRecords(sessionIds[0], 2);
    const result = await importProjectSessions(projectRoot, "claude", { environment });
    assert.equal(result.imported, 1);
    assert.equal(result.skipped, sessionIds.length - 1, "only the changed session is re-parsed");

    const stored = await readCanonicalSession(projectRoot, canonicalId);
    assert.equal(stored.events.length, before + 2, "only the two appended records become events");
    assert.equal(new Set(stored.events.map((event) => event.id)).size, stored.events.length);

    const repeat = await importProjectSessions(projectRoot, "claude", { environment });
    assert.equal(repeat.imported, 0);
    assert.equal((await readCanonicalSession(projectRoot, canonicalId)).events.length, stored.events.length);
  });
});

test("appendCanonicalEvents reports duplicates without rewriting the event log", async () => {
  await withClaudeProject(async ({ projectRoot, environment, sessionIds, canonicalDirectory }) => {
    await importProjectSessions(projectRoot, "claude", { environment });
    const canonicalId = `claude-${sessionIds[0]}`;
    const stored = await readCanonicalSession(projectRoot, canonicalId);

    const eventsFile = path.join(canonicalDirectory(canonicalId), "events.jsonl");
    const before = await stat(eventsFile);
    const result = await appendCanonicalEvents(projectRoot, canonicalId, stored.events);
    assert.deepEqual(result, { added: 0, duplicate: stored.events.length });
    assert.equal((await stat(eventsFile)).mtimeMs, before.mtimeMs);
  });
});

test("import keeps every session identity separate and never merges by time", async () => {
  await withClaudeProject(async ({ projectRoot, environment, sessionIds }) => {
    const result = await importProjectSessions(projectRoot, "claude", { environment });
    assert.equal(result.discovered, sessionIds.length);
    const reloaded = await Promise.all(sessionIds.map((id) => readCanonicalSession(projectRoot, `claude-${id}`)));
    for (const [index, stored] of reloaded.entries()) {
      assert.equal(stored.session.source, "claude");
      assert.ok(stored.events.length > 0);
      assert.equal(stored.mappings.projections.claude.nativeSessionId, sessionIds[index]);
    }
  });
});

test("import surfaces a malformed middle record without dropping the session", async () => {
  await withClaudeProject(async ({ projectRoot, environment, sessionIds, nativeFile }) => {
    const file = nativeFile(sessionIds[0]);
    const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
    lines.splice(2, 0, "{ not json");
    await writeFile(file, `${lines.join("\n")}\n`);

    const result = await importProjectSessions(projectRoot, "claude", { environment });
    assert.equal(result.failed, 0, "a malformed record must not fail the whole session");
    const diagnostics = result.diagnostics.filter((item) => item.kind === "malformed-record");
    assert.equal(diagnostics.length, 1);
    const stored = await readCanonicalSession(projectRoot, `claude-${sessionIds[0]}`);
    assert.ok(stored.events.length > 0, "the valid records still import");
  });
});
