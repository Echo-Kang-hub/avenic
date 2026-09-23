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

// A project-scoped launch ends by reverting native storage, so the portable
// copies under `.agents/sessions/claude` are the project's durable record —
// committed to git, and after a revert the only copy. Native storage is a
// cache the run borrows and gives back, so a session being absent from it is
// the *normal* state of everything a previous run produced. Capture is
// therefore additive: native absence is never a deletion. A removal pass keyed
// on "native does not hold it" deleted exactly the sessions the project had
// just saved, which is how canonical history ends up with a missing portable
// half — and how the next `--resume` answers "No conversation found with
// session ID".
test("a native file that is gone never deletes the project's durable copy", async () => {
  await withClaudeProject(async ({ projectRoot, environment, sessionIds, portableFile, nativeFile }) => {
    const adapter = getSessionAdapter("claude");
    await adapter.capture(projectRoot, { environment });
    assert.ok((await stat(portableFile(sessionIds[0]))).size > 0);
    await rm(nativeFile(sessionIds[0]), { force: true });
    const result = await adapter.capture(projectRoot, { environment });
    assert.equal(result.changed, false, "a native file that is gone is not a change to the project's copy");
    assert.ok(
      (await stat(portableFile(sessionIds[0]))).size > 0,
      "the project keeps the session native storage no longer holds",
    );
    assert.ok((await stat(portableFile(sessionIds[1]))).size > 0, "the surviving session stays");
  }, { sessions: 2, records: 4 });
});

// The same rule at the whole-root level: no native root at all is the state a
// reverted project and a freshly cloned project share, and it must read as
// "nothing new to copy" — never as "every session was deleted".
test("a capture that finds no native root keeps the portable history", async () => {
  await withClaudeProject(async ({ projectRoot, environment, sessionIds, portableFile, nativeRoot }) => {
    const adapter = getSessionAdapter("claude");
    await adapter.capture(projectRoot, { environment });
    await rm(nativeRoot, { recursive: true, force: true });
    const result = await adapter.capture(projectRoot, { environment });
    assert.equal(result.count, 0);
    assert.equal(result.changed, false, "an empty source is not a change to the destination");
    for (const sessionId of sessionIds) {
      assert.ok((await stat(portableFile(sessionId))).size > 0, `${sessionId} must survive a native root that is gone`);
    }
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
// catastrophic regression (re-reading whole foreign transcripts, say). It is
// deliberately loose: even a pass with its cursor deleted, which re-discovers
// all 1500 foreign sessions, was measured at ~550 ms of processor time, so the
// ceiling is an order-of-magnitude net, not the cursor's guard.
//
// The ceiling is on the work the pass does, not on the clock it took: the test
// runner runs several files at once, and a pass that waits for the processor
// has not discovered more. The wall clock is still reported, because a pass
// that takes seconds of it is worth seeing.
//
// One sample is not a measurement on a loaded host. The same pass that costs
// ~190 ms of processor time alone was seen at ~1000 ms during a full suite run,
// where file system filter drivers charge the suite's I/O to this process (the
// wall clock moved by only 300 ms, so this was not a busy loop). The pass is
// therefore run twice and the cheaper of the two is judged: a regression raises
// both samples, so the net keeps its teeth, while a spike that belongs to the
// host cannot fail the suite. Both samples are named when the net does trip.
const FOREIGN_DISCOVERY_BUDGET_MS = 1000;

test("discovery stays bounded when the machine holds a long foreign history", async () => {
  await withClaudeProject(async ({ projectRoot, environment, sessionIds, foreignSessions }) => {
    assert.ok(foreignSessions >= 500, "the fixture must hold enough foreign sessions to matter");
    const adapter = getSessionAdapter("claude");
    await adapter.capture(projectRoot, { environment });
    const samples = [];
    for (let pass = 0; pass < 2; pass += 1) {
      const started = process.hrtime.bigint();
      const cpuBefore = process.cpuUsage();
      const second = await adapter.capture(projectRoot, { environment });
      const cpu = process.cpuUsage(cpuBefore);
      samples.push({
        cpu: (cpu.user + cpu.system) / 1000,
        user: cpu.user / 1000,
        system: cpu.system / 1000,
        wall: Number(process.hrtime.bigint() - started) / 1e6,
        changed: second.changed,
        count: second.count,
      });
    }
    for (const sample of samples) {
      assert.equal(sample.changed, false);
      assert.equal(sample.count, sessionIds.length);
    }
    const cheapest = samples.reduce((best, sample) => (sample.cpu < best.cpu ? sample : best));
    assert.ok(
      cheapest.cpu < FOREIGN_DISCOVERY_BUDGET_MS,
      `re-discovery spent ${samples.map((sample) => `${sample.cpu.toFixed(0)} ms`).join(" then ")} of processor time ` +
        `(cheapest user ${cheapest.user.toFixed(0)} · system ${cheapest.system.toFixed(0)}, ${cheapest.wall.toFixed(0)} ms wall) ` +
        `over ${foreignSessions} foreign sessions (budget ${FOREIGN_DISCOVERY_BUDGET_MS} ms)`,
    );
  }, { sessions: 2, records: 4, otherWorkspaces: { projects: 60, sessions: 25 } });
});
