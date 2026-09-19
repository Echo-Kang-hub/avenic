import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";
import { formatSessionDiagnostics } from "../packages/core/src/runtime/diagnostics.mjs";
import { importProjectSessions } from "../packages/core/src/runtime/session-interop.mjs";
import { withClaudeProject } from "./helpers/session-fixture.mjs";

test("one unreadable record is one warning, not one per pass", () => {
  const diagnostics = [
    { agentId: "claude", file: "a.jsonl", kind: "malformed-record", line: 3 },
    { agentId: "claude", file: "a.jsonl", kind: "malformed-record", line: 3 },
    { agentId: "claude", file: "a.jsonl", kind: "malformed-record", line: 3 },
  ];
  const { warnings, notes } = formatSessionDiagnostics(diagnostics);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /claude a\.jsonl/);
  assert.match(warnings[0], /line 3/);
  assert.equal(notes.length, 0);
});

test("an incomplete final record is a note, not a warning", () => {
  const { warnings, notes } = formatSessionDiagnostics([{ agentId: "claude", file: "a.jsonl", kind: "truncated-tail", line: 9 }]);
  assert.equal(warnings.length, 0);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /incomplete/);
});

test("diagnostics with no recognizable kind are still shown", () => {
  const { notes } = formatSessionDiagnostics([{ message: "Something happened." }]);
  assert.deepEqual(notes, ["Something happened."]);
});

test("an agent nobody has run yet is not announced on every read", () => {
  const missing = { kind: "missing-root", message: "Codex session root not found: /home/nobody/.codex/sessions" };
  // Reading a project must not narrate a fresh install: the root appears the
  // first time that agent runs, and until then there is nothing to report.
  const quiet = formatSessionDiagnostics([missing, { agentId: "claude", file: "a.jsonl", kind: "malformed-record" }]);
  assert.deepEqual(quiet.notes, []);
  assert.equal(quiet.warnings.length, 1);
  // A command whose whole job was to import history says where it looked.
  const asked = formatSessionDiagnostics([missing], { missingRoots: true });
  assert.deepEqual(asked.notes, [missing.message]);
});

test("`avenic sessions import` says where it looked when there was nothing", async () => {
  await withClaudeProject(async ({ projectRoot, environment }) => {
    // The Claude root exists (the fixture made it); Codex has never run here.
    const result = await importProjectSessions(projectRoot, "codex", { environment });
    const { warnings, notes } = formatSessionDiagnostics(result.diagnostics, { missingRoots: true });
    assert.equal(warnings.length, 0);
    assert.equal(notes.length, 1);
    assert.match(notes[0], /Codex session root not found/);
  }, { sessions: 0 });
});

test("a malformed record is reported once, naming the session file", async () => {
  await withClaudeProject(async ({ projectRoot, environment, sessionIds, nativeFile }) => {
    const file = nativeFile(sessionIds[0]);
    const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
    lines.splice(2, 0, "{ not json");
    await writeFile(file, `${lines.join("\n")}\n`);

    const first = await importProjectSessions(projectRoot, "claude", { environment });
    const reported = formatSessionDiagnostics(first.diagnostics).warnings.filter((line) => line.includes(sessionIds[0]));
    assert.equal(reported.length, 1, `expected one warning for the broken session, got ${JSON.stringify(first.diagnostics)}`);

    // The second pass has nothing new to read, so it must not repeat itself.
    const second = await importProjectSessions(projectRoot, "claude", { environment });
    const again = formatSessionDiagnostics(second.diagnostics).warnings.filter((line) => line.includes(sessionIds[0]));
    assert.equal(again.length, 0);
  }, { sessions: 2, records: 6 });
});

test("`avenic sessions list` reports a broken record once", async () => {
  await withClaudeProject(async ({ runCli, sessionIds, nativeFile }) => {
    const file = nativeFile(sessionIds[0]);
    const lines = (await readFile(file, "utf8")).split("\n").filter(Boolean);
    lines.splice(2, 0, "{ not json");
    await writeFile(file, `${lines.join("\n")}\n`);

    const result = runCli(["sessions", "list"]);
    assert.equal(result.status, 0, result.stderr);
    const reported = result.stderr.split("\n").filter((line) => line.includes("unreadable record"));
    assert.equal(reported.length, 1, `expected exactly one warning, got ${JSON.stringify(result.stderr)}`);
    assert.match(reported[0], new RegExp(sessionIds[0]));
  }, { sessions: 2, records: 6 });
});
