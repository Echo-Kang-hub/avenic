import assert from "node:assert/strict";
import { readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { getSessionAdapter } from "../packages/core/src/runtime/adapters/index.mjs";
import { importProjectSessions } from "../packages/core/src/runtime/session-interop.mjs";
import { withClaudeProject } from "./helpers/session-fixture.mjs";

// A restore puts the project's copy into native storage; the capture at exit
// puts native storage back into that copy. A file the restore brought into
// agreement on both sides has nothing new to capture — and re-copying it is
// what made a large session cost seconds of churn on every launch. What must
// never be swallowed is the opposite case: the destination was already longer
// (a plain `claude` run appended natively), and that tail belongs in the copy.

test("a restored catalog is not copied back out, but its new turns still are", async () => {
  await withClaudeProject(async ({ projectRoot, environment, sessionIds, nativeRoot, portableFile, appendRecords }) => {
    const adapter = getSessionAdapter("claude");
    await importProjectSessions(projectRoot, "claude", { environment });
    const sessionId = sessionIds[0];

    // The clone: native storage is empty, the project's copy is all there is.
    await rm(path.join(nativeRoot, `${sessionId}.jsonl`));
    await adapter.restore(projectRoot, { environment });

    const untouched = await stat(portableFile(sessionId));
    const quiet = await adapter.capture(projectRoot, { environment });
    assert.equal(quiet.changed, false, "a restored file nobody touched is not copied back out");
    assert.equal((await stat(portableFile(sessionId))).mtimeMs, untouched.mtimeMs);

    // A turn lands in the restored native session: it must still be captured.
    await appendRecords(sessionId, 1, 4);
    const changed = await adapter.capture(projectRoot, { environment });
    assert.equal(changed.changed, true);
    assert.match(await readFile(portableFile(sessionId), "utf8"), /message 4/);
  });
});

test("native bytes the destination was left longer with are still captured", async () => {
  await withClaudeProject(async ({ projectRoot, environment, sessionIds, nativeRoot, portableFile, appendRecords }) => {
    const adapter = getSessionAdapter("claude");
    await importProjectSessions(projectRoot, "claude", { environment });
    const sessionId = sessionIds[0];

    // Native storage grew where this project's copy did not: a plain `claude`
    // run outside Avenic appended a turn. Restore must leave those bytes in
    // place, and the capture must not count the file as already saved.
    await appendRecords(sessionId, 1, 4);
    await adapter.restore(projectRoot, { environment });
    assert.match(await readFile(path.join(nativeRoot, `${sessionId}.jsonl`), "utf8"), /message 4/, "restore keeps the native tail");

    const changed = await adapter.capture(projectRoot, { environment });
    assert.equal(changed.changed, true);
    assert.match(await readFile(portableFile(sessionId), "utf8"), /message 4/, "the native tail reaches the project's copy");
  });
});
