import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { getSessionAdapter } from "../packages/core/src/runtime/adapters/index.mjs";
import { withOpenCodeProject } from "./helpers/session-fixture.mjs";

// OpenCode's history is only reachable through its CLI, so a capture asks it
// what exists and exports what it returns. Asking is unavoidable; exporting is
// not. The durability watchdog runs this every few seconds while an OpenCode
// agent is working, so a pass with nothing new must cost one question and no
// exports — otherwise the "watch" is a process spawn per interval against the
// user's machine for the whole run.

test("a repeat OpenCode capture asks once and exports nothing again", async () => {
  await withOpenCodeProject(async ({ projectRoot, environment, portableRoot, createSession, invocations, resetInvocations }) => {
    await createSession("ses_one");
    await createSession("ses_two");
    const adapter = getSessionAdapter("opencode");

    const first = await adapter.capture(projectRoot, { environment });
    assert.equal(first.count, 2);
    assert.equal(first.changed, true);
    assert.deepEqual((await invocations()).filter((line) => line.startsWith("export")), ["export ses_one", "export ses_two"]);
    const exported = await stat(path.join(portableRoot, "ses_one.json"));

    await resetInvocations();
    const second = await adapter.capture(projectRoot, { environment });
    assert.equal(second.changed, false, "nothing moved, so nothing may be reported as changed");
    assert.deepEqual(await invocations(), ["session list --format json"], "the second pass must not export a session again");
    assert.equal((await stat(path.join(portableRoot, "ses_one.json"))).mtimeMs, exported.mtimeMs);
  });
});

test("only the OpenCode session whose own revision moved is exported again", async () => {
  await withOpenCodeProject(async ({ projectRoot, environment, portableRoot, createSession, appendTurn, invocations, resetInvocations }) => {
    await createSession("ses_one");
    await createSession("ses_two");
    const adapter = getSessionAdapter("opencode");
    await adapter.capture(projectRoot, { environment });
    await resetInvocations();

    await appendTurn("ses_two", 2);
    const result = await adapter.capture(projectRoot, { environment });
    assert.equal(result.changed, true);
    assert.deepEqual(await invocations(), ["session list --format json", "export ses_two"]);
    assert.match(await readFile(path.join(portableRoot, "ses_two.json"), "utf8"), /assistant turn 1/);
  });
});

test("an OpenCode session that disappears leaves the portable directory", async () => {
  await withOpenCodeProject(async ({ projectRoot, environment, portableRoot, createSession, removeSession }) => {
    await createSession("ses_one");
    await createSession("ses_two");
    const adapter = getSessionAdapter("opencode");
    await adapter.capture(projectRoot, { environment });

    await removeSession("ses_one");
    const result = await adapter.capture(projectRoot, { environment });
    assert.equal(result.count, 1);
    assert.equal(result.changed, true);
    await assert.rejects(readFile(path.join(portableRoot, "ses_one.json"), "utf8"));
    assert.match(await readFile(path.join(portableRoot, "ses_two.json"), "utf8"), /user turn 0/);
  });
});

test("an OpenCode export without a session revision is read every time", async () => {
  // Not every OpenCode build reports `time.updated`. When it is missing the
  // capture cannot claim nothing moved, so it must fall back to reading the
  // session rather than silently skipping a conversation that grew.
  await withOpenCodeProject(async ({ projectRoot, environment, createSession, forgetSessionRevision, invocations, resetInvocations }) => {
    await createSession("ses_one");
    const adapter = getSessionAdapter("opencode");
    await adapter.capture(projectRoot, { environment });

    await forgetSessionRevision("ses_one");
    await resetInvocations();
    const second = await adapter.capture(projectRoot, { environment });
    assert.equal(second.changed, true, "an unknown revision must not be treated as unchanged");
    assert.deepEqual(await invocations(), ["session list --format json", "export ses_one"]);
  });
});
