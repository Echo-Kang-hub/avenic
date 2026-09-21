import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { withClaudeProject } from "./helpers/session-fixture.mjs";

async function canonicalIds(projectRoot) {
  const root = path.join(projectRoot, ".agents", "sessions", "canonical");
  return (await readdir(root).catch(() => [])).sort();
}

test("listing sessions picks up native history no capture has seen", async () => {
  await withClaudeProject(async ({ createUnmappedSession, runCli, projectRoot }) => {
    const sessionId = await createUnmappedSession(3);
    const result = runCli(["sessions", "list"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(sessionId), "the interrupted session must appear in shared history");
    assert.deepEqual(await canonicalIds(projectRoot), [`claude-${sessionId}`]);
  }, { sessions: 0 });
});

test("a second listing does not re-import the same native session", async () => {
  await withClaudeProject(async ({ createUnmappedSession, runCli }) => {
    await createUnmappedSession(3);
    const first = runCli(["sessions", "status"]);
    assert.equal(first.status, 0, first.stderr);
    const second = runCli(["sessions", "status"]);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /3 events\b/, "repeated recovery must stay idempotent");
  }, { sessions: 0 });
});

test("isolated history is only imported when the user asks for it", async () => {
  await withClaudeProject(async ({ createUnmappedSession, runCli, projectRoot }) => {
    const sessionId = await createUnmappedSession(3);
    const listed = runCli(["sessions", "list"]);
    assert.equal(listed.status, 0, listed.stderr);
    assert.deepEqual(await canonicalIds(projectRoot), [], "isolated mode must not share history behind the user's back");

    const synced = runCli(["sessions", "sync"]);
    assert.equal(synced.status, 0, synced.stderr);
    assert.deepEqual(await canonicalIds(projectRoot), [`claude-${sessionId}`]);
  }, { sessions: 0, historyMode: "isolated" });
});
