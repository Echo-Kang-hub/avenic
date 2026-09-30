import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { readCanonicalSession } from "../packages/core/src/runtime/canonical-sessions.mjs";
import { formatSessionDiagnostics } from "../packages/core/src/runtime/diagnostics.mjs";
import { importProjectSessions } from "../packages/core/src/runtime/session-interop.mjs";
import { claudeRecord, withClaudeProject } from "./helpers/session-fixture.mjs";

// The shapes a clone of a project with history really carries: a file whose
// records predate Claude writing `sessionId` into every line, a file the
// project left to Git LFS, and — for contrast — a file that is neither.
const LEGACY = "dd333209-31a4-4820-a98f-834d721c8236";
const pointer = (oid = "2ff8baf0".padEnd(64, "0"), size = 22039051) =>
  `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${size}\n`;

// A record shaped like the ones written before Claude repeated its session id
// in every line: same fields otherwise, so identity is the only difference
// between this history and a modern one.
function legacySession(uuid, projectRoot) {
  return [
    { type: "user", uuid: `uuid-${uuid}-0`, timestamp: "2026-01-01T00:00:00.000Z", cwd: projectRoot, message: { role: "user", model: "claude-sonnet-5", content: [{ type: "text", text: "message 0" }] } },
    { type: "assistant", uuid: `uuid-${uuid}-1`, timestamp: "2026-01-01T00:00:01.000Z", cwd: projectRoot, message: { role: "assistant", model: "claude-sonnet-5", content: [{ type: "text", text: "message 1" }] } },
  ].map((record) => JSON.stringify(record)).join("\n") + "\n";
}

async function canonicalIds(projectRoot) {
  const { readdir } = await import("node:fs/promises");
  return (await readdir(path.join(projectRoot, ".agents", "sessions", "canonical")).catch(() => [])).sort();
}

// A clone materializes the portable directory long before anything runs, so
// the file under test can simply be there.
async function writePortable(portableFile, id, content) {
  await mkdir(path.dirname(portableFile(id)), { recursive: true });
  await writeFile(portableFile(id), content);
}

test("a legacy transcript is identified by its file name and imported once", async () => {
  await withClaudeProject(async ({ projectRoot, root, environment, portableFile }) => {
    await writePortable(portableFile, LEGACY, legacySession(LEGACY, projectRoot));

    const first = await importProjectSessions(projectRoot, "claude", { environment, setActive: false });
    assert.equal(first.failed, 0);
    assert.equal(first.imported, 1, "history must not be abandoned for lacking a session id");
    const stored = await readCanonicalSession(projectRoot, `claude-${LEGACY}`);
    assert.equal(stored.events.length, 2);
    assert.equal(stored.mappings.projections.claude.nativeSessionId, LEGACY);
    assert.ok(stored.events.every((event) => event.id.includes(LEGACY)), "event identity is built on the recovered id");

    const second = await importProjectSessions(projectRoot, "claude", { environment, setActive: false });
    assert.equal(second.imported, 0);
    assert.equal(second.skipped, 1, "an unchanged legacy file is never re-parsed");

    // The state a second clone (or a lost machine state) starts from: no
    // cursors at all, only what the repository committed. Recovering again
    // must append nothing and create no second session.
    await rm(path.join(root, "state"), { recursive: true, force: true });
    const recovered = await importProjectSessions(projectRoot, "claude", { environment, setActive: false });
    assert.deepEqual(await canonicalIds(projectRoot), [`claude-${LEGACY}`]);
    assert.equal((await readCanonicalSession(projectRoot, `claude-${LEGACY}`)).events.length, 2, "recovery is idempotent");
    assert.equal(recovered.failed, 0);
  }, { sessions: 0 });
});

test("the canonical mapping the clone inherited names the conversation", async () => {
  await withClaudeProject(async ({ projectRoot, root, environment, portableFile }) => {
    // The modern history is imported first, as the machine that wrote it did.
    const modern = `${Array.from({ length: 2 }, (_, index) => claudeRecord(LEGACY, index, projectRoot)).join("\n")}\n`;
    await writePortable(portableFile, LEGACY, modern);
    const seeded = await importProjectSessions(projectRoot, "claude", { environment, setActive: false });
    assert.equal(seeded.failed, 0);
    // Then the clone: the same file, but written the old way — no session id
    // in any record — and no machine state at all.
    await writePortable(portableFile, LEGACY, legacySession(LEGACY, projectRoot));
    await rm(path.join(root, "state"), { recursive: true, force: true });

    const result = await importProjectSessions(projectRoot, "claude", { environment, setActive: false });
    assert.deepEqual(await canonicalIds(projectRoot), [`claude-${LEGACY}`], "no second canonical session");
    assert.equal(result.failed, 0);
    assert.equal((await readCanonicalSession(projectRoot, `claude-${LEGACY}`)).events.length, 2);
  }, { sessions: 0 });
});

test("a Git LFS pointer is reported once, silently kept afterwards, and never imported", async () => {
  await withClaudeProject(async ({ projectRoot, environment, portableFile }) => {
    await writePortable(portableFile, LEGACY, pointer());

    const first = await importProjectSessions(projectRoot, "claude", { environment, setActive: false });
    assert.equal(first.failed, 0, "a pointer is not a corrupt session");
    const { notes } = formatSessionDiagnostics(first.diagnostics);
    assert.equal(notes.length, 1);
    assert.match(notes[0], /Git LFS/);
    assert.equal(await canonicalIds(projectRoot).then((ids) => ids.length), 0, "no canonical session for bytes that are not here");

    const second = await importProjectSessions(projectRoot, "claude", { environment, setActive: false });
    assert.equal(second.skipped, 1, "the pointer is not read again");
    assert.deepEqual(second.diagnostics, [], "the same pointer is not diagnosed twice");

    // The bytes arrive: the same file now imports as a conversation.
    await writePortable(portableFile, LEGACY, legacySession(LEGACY, projectRoot));
    const pulled = await importProjectSessions(projectRoot, "claude", { environment, setActive: false });
    assert.equal(pulled.imported, 1);
    assert.equal((await readCanonicalSession(projectRoot, `claude-${LEGACY}`)).events.length, 2);
  }, { sessions: 0 });
});

test("a session with no recoverable identity is diagnosed once and blocks nothing", async () => {
  await withClaudeProject(async ({ projectRoot, environment, sessionIds, portableFile }) => {
    await writePortable(portableFile, "unidentified-notes", "{ not json\n");

    const first = await importProjectSessions(projectRoot, "claude", { environment });
    assert.equal(first.imported, sessionIds.length, "the other sessions still import");
    assert.equal(first.failed, 1);
    const { warnings } = formatSessionDiagnostics(first.diagnostics);
    assert.ok(warnings.includes("Claude session unidentified-notes.jsonl could not be restored: no recoverable session identity."));

    const second = await importProjectSessions(projectRoot, "claude", { environment });
    assert.equal(second.failed, 1, "it is still failed, and still counted");
    const again = formatSessionDiagnostics(second.diagnostics);
    assert.ok(!again.warnings.some((warning) => warning.includes("could not be restored")), "the same file is not re-warned");
  });
});
