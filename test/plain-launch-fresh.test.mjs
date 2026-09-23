import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { listCanonicalSessions, setActiveCanonicalSession } from "../packages/core/src/index.mjs";
import { withClaudeProject } from "./helpers/session-fixture.mjs";

// The first promise of the product: `avenic claude` is `claude`. A plain
// launch opens a new conversation every time. Shared history is a project
// capability — it means this project *can* carry one conversation between
// agents — not an instruction to resume the last one. Continuing is always an
// explicit act: `avenic sessions continue <canonical-id> --agent <agent>`, or
// the user's own `/resume` inside the agent.
//
// These tests pin the invariant at the only place it can be checked honestly:
// the argument list the official agent process actually received.

function argvOf(probe) {
  return probe?.argv ?? null;
}

test("a plain launch starts a new conversation even when a shared conversation is active", async () => {
  await withClaudeProject(async ({ projectRoot, sessionIds, runCli, launch }) => {
    const synced = runCli(["sessions", "sync"]);
    assert.equal(synced.status, 0, synced.stderr);
    await setActiveCanonicalSession(projectRoot, `claude-${sessionIds[0]}`);

    const result = await launch(["claude"]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      argvOf(result.probe),
      [],
      "an active shared conversation must not change what a plain launch is",
    );
  }, { sessions: 2, records: 4 });
});

test("a plain launch starts a new conversation even when a native mapping exists", async () => {
  await withClaudeProject(async ({ projectRoot, sessionIds, runCli, launch, nativeFile }) => {
    const synced = runCli(["sessions", "sync"]);
    assert.equal(synced.status, 0, synced.stderr);
    await setActiveCanonicalSession(projectRoot, `claude-${sessionIds[0]}`);
    // The mapping names a session native storage no longer holds — the state a
    // revert leaves behind. A launch that trusted it would hand the official
    // CLI a resume for a conversation it cannot open.
    assert.equal(existsSync(nativeFile(sessionIds[0])), true);

    const result = await launch(["claude"]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(argvOf(result.probe), [], "a stale mapping must not become a resume command");
  }, { sessions: 2, records: 4 });
});

test("three plain launches are three conversations, all of them discoverable", async () => {
  await withClaudeProject(async ({ projectRoot, nativeFile, nativeRoot, launchAsync }) => {
    const runIds = [
      "aaaa0000-0000-4000-8000-000000000001",
      "aaaa0000-0000-4000-8000-000000000002",
      "aaaa0000-0000-4000-8000-000000000003",
    ];
    const observed = [];
    for (const id of runIds) {
      const run = await launchAsync(["claude"], {
        AVENIC_AGENT_WRITE: JSON.stringify({ file: nativeFile(id), records: 4, sleepMs: 0 }),
      });
      const { status } = await run.completion;
      assert.equal(status, 0, run.output());
      observed.push(argvOf(await run.probe()));
    }
    assert.deepEqual(
      observed,
      [[], [], []],
      "each plain launch must open a new conversation, never the one before it",
    );
    // The run's conversation reaches the project the same way a direct `claude`
    // run's would: capture at exit, native storage reverted afterwards.
    const canonical = await listCanonicalSessions(projectRoot);
    const ids = new Set(canonical.map((session) => session.id));
    for (const id of runIds) {
      assert.ok(ids.has(`claude-${id}`), `run ${id} must be discoverable in the shared history`);
      assert.equal(existsSync(nativeFile(id)), false, "the run's session must not survive the revert");
    }
  }, { sessions: 2, records: 4 });
});

test("a plain launch is a new conversation whose /resume can still see the project's own", async () => {
  await withClaudeProject(async ({ projectRoot, nativeFile, nativeRoot, launchAsync }) => {
    const runIds = [
      "bbbb0000-0000-4000-8000-000000000001",
      "bbbb0000-0000-4000-8000-000000000002",
    ];
    for (const id of runIds) {
      const run = await launchAsync(["claude"], {
        AVENIC_AGENT_WRITE: JSON.stringify({ file: nativeFile(id), records: 4, sleepMs: 0 }),
      });
      const { status } = await run.completion;
      assert.equal(status, 0, run.output());
    }
    // After the exits, native storage holds none of them: the project does.
    for (const id of runIds) {
      assert.equal(existsSync(nativeFile(id)), false, "a finished run's session must not stay in native storage");
    }

    // The next plain launch is still a new conversation — but the official
    // CLI's own `/resume`, inside that conversation, must list what this
    // project holds. The probe is written the instant the agent starts, so
    // this is the shelf `/resume` reads, not the one the exit rebuilds.
    const next = await launchAsync(["claude"], { AVENIC_AGENT_NATIVE_LIST: nativeRoot });
    const { status } = await next.completion;
    assert.equal(status, 0, next.output());
    // This run writes nothing of its own, so the probe still holds what it
    // recorded at spawn.
    const spawnTime = await next.probe();
    assert.deepEqual(argvOf(spawnTime), [], "showing the project's conversations is not resuming one of them");
    assert.deepEqual(
      (spawnTime?.native ?? []).filter((name) => name.startsWith("bbbb")).sort(),
      [`${runIds[0]}.jsonl`, `${runIds[1]}.jsonl`],
      "the agent's own /resume must find the conversations this project saved",
    );
  }, { sessions: 2, records: 4 });
});

test("an explicit continuation is the one thing that resumes", async () => {
  await withClaudeProject(async ({ projectRoot, sessionIds, runCli, root }) => {
    const synced = runCli(["sessions", "sync"]);
    assert.equal(synced.status, 0, synced.stderr);
    const canonicalId = `claude-${sessionIds[0]}`;
    await setActiveCanonicalSession(projectRoot, canonicalId);
    const probe = `${root}/agent-probe.json`;

    const continued = runCli(["sessions", "continue", canonicalId, "--agent", "claude"], {
      AVENIC_AGENT_PROBE: probe,
    });
    assert.equal(continued.status, 0, continued.stderr);
    const argv = argvOf(JSON.parse(await readFile(probe, "utf8")));
    assert.deepEqual(argv.slice(0, 2), ["--resume", sessionIds[0]], "the explicit command is what resumes");
  }, { sessions: 2, records: 4 });
});
