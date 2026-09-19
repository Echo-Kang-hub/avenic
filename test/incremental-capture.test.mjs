import assert from "node:assert/strict";
import { readFile, rm, stat } from "node:fs/promises";
import test from "node:test";
import { getSessionAdapter } from "../packages/core/src/runtime/adapters/index.mjs";
import { cursorFilePath } from "../packages/core/src/runtime/cursors.mjs";
import { withClaudeProject } from "./helpers/session-fixture.mjs";

test("capture copies the matched native session into the portable directory", async () => {
  await withClaudeProject(async ({ projectRoot, environment, sessionIds, portableFile }) => {
    const adapter = getSessionAdapter("claude");
    const result = await adapter.capture(projectRoot, { environment });
    assert.equal(result.count, sessionIds.length);
    assert.equal(result.changed, true);
    assert.match(await readFile(portableFile(sessionIds[0]), "utf8"), /"cwd":"\$\{PROJECT_ROOT\}"/);
  });
});

test("a second capture of unchanged native files rewrites nothing", async () => {
  await withClaudeProject(async ({ projectRoot, environment, sessionIds, portableFile }) => {
    const adapter = getSessionAdapter("claude");
    await adapter.capture(projectRoot, { environment });
    const before = await stat(portableFile(sessionIds[0]));
    const second = await adapter.capture(projectRoot, { environment });
    assert.equal(second.changed, false);
    assert.equal((await stat(portableFile(sessionIds[0]))).mtimeMs, before.mtimeMs);
  });
});

test("appending to one native session updates only that portable file", async () => {
  await withClaudeProject(async ({ projectRoot, environment, sessionIds, portableFile, appendRecords }) => {
    const adapter = getSessionAdapter("claude");
    await adapter.capture(projectRoot, { environment });
    const untouched = await stat(portableFile(sessionIds[1]));
    await appendRecords(sessionIds[0], 2);
    const result = await adapter.capture(projectRoot, { environment });
    assert.equal(result.changed, true);
    assert.match(await readFile(portableFile(sessionIds[0]), "utf8"), /message 5/);
    assert.equal((await stat(portableFile(sessionIds[1]))).mtimeMs, untouched.mtimeMs);
  });
});

test("a deleted native session disappears from the portable directory", async () => {
  await withClaudeProject(async ({ projectRoot, environment, sessionIds, portableFile, nativeFile }) => {
    const adapter = getSessionAdapter("claude");
    await adapter.capture(projectRoot, { environment });
    assert.ok((await stat(portableFile(sessionIds[0]))).size > 0);
    await rm(nativeFile(sessionIds[0]), { force: true });
    const result = await adapter.capture(projectRoot, { environment });
    assert.equal(result.changed, true);
    await assert.rejects(readFile(portableFile(sessionIds[0]), "utf8"));
    assert.ok((await stat(portableFile(sessionIds[1]))).size > 0, "the surviving session stays");
  });
});

test("capture persists a cursor that lets the next capture skip the scan", async () => {
  await withClaudeProject(async ({ projectRoot, environment, sessionIds }) => {
    const adapter = getSessionAdapter("claude");
    await adapter.capture(projectRoot, { environment });
    assert.ok((await stat(cursorFilePath(projectRoot, environment))).size > 0);
    const second = await adapter.capture(projectRoot, { environment });
    assert.equal(second.count, sessionIds.length);
    assert.equal(second.diagnostics.length, 0);
  });
});

test("capture never rewrites the native session", async () => {
  await withClaudeProject(async ({ projectRoot, environment, nativeSnapshot }) => {
    const before = await nativeSnapshot();
    await getSessionAdapter("claude").capture(projectRoot, { environment });
    assert.deepEqual(await nativeSnapshot(), before);
  });
});

// Discovery reads the head of every Claude session on the machine to decide
// which of them belong to this project, so a long unrelated history must not
// turn this project's bookkeeping into a per-session filesystem walk. The
// precise contract — a repeated comparison never revisits the filesystem — is
// asserted in session-adapter-contract.test.mjs; this ceiling only catches a
// catastrophic regression (re-reading whole foreign transcripts, say).
//
// The ceiling is on the work the pass does, not on the clock it took: the test
// runner runs several files at once, and a pass that waits for the processor
// has not discovered more. The wall clock is still reported, because a pass
// that takes seconds of it is worth seeing.
const FOREIGN_DISCOVERY_BUDGET_MS = 1000;

test("discovery stays bounded when the machine holds a long foreign history", async () => {
  await withClaudeProject(async ({ projectRoot, environment, sessionIds, foreignSessions }) => {
    assert.ok(foreignSessions >= 500, "the fixture must hold enough foreign sessions to matter");
    const adapter = getSessionAdapter("claude");
    await adapter.capture(projectRoot, { environment });
    const started = process.hrtime.bigint();
    const cpuBefore = process.cpuUsage();
    const second = await adapter.capture(projectRoot, { environment });
    const cpu = process.cpuUsage(cpuBefore);
    const ms = (cpu.user + cpu.system) / 1000;
    const wall = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(second.changed, false);
    assert.equal(second.count, sessionIds.length);
    assert.ok(
      ms < FOREIGN_DISCOVERY_BUDGET_MS,
      `re-discovery spent ${ms.toFixed(0)} ms of processor time (${wall.toFixed(0)} ms wall) over ${foreignSessions} foreign sessions (budget ${FOREIGN_DISCOVERY_BUDGET_MS} ms)`,
    );
  }, { sessions: 2, records: 4, otherWorkspaces: { projects: 60, sessions: 25 } });
});
