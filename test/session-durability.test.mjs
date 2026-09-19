import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { prepareCanonicalContinuation, readCanonicalSession, setActiveCanonicalSession } from "../packages/core/src/index.mjs";
import { withClaudeProject } from "./helpers/session-fixture.mjs";

// What one run leaves behind has to survive everything that happens next.
//
// A project-scoped launch ends by reverting native storage to its pre-launch
// state, so from that moment the run's conversation exists in exactly two
// places: the portable files under `.agents/sessions/<agent>` (durable, in
// git) and canonical history. Every later pass that reads native storage —
// the sessions menu, `sessions list`, a status reconcile — sees a tree that
// does not hold the run's session, and that must never be read as "this
// session was deleted".
//
// These are the real-server symptoms, reproduced end to end: canonical
// history listing a conversation whose portable half is gone, and the next
// `--resume` answering "No conversation found with session ID".

test("a run's conversation survives the passes that follow its revert", async () => {
  await withClaudeProject(async ({ projectRoot, nativeFile, portableFile, runCli, launchAsync }) => {
    const id = "cccc0000-0000-4000-8000-000000000001";
    const run = await launchAsync(["claude"], {
      AVENIC_AGENT_WRITE: JSON.stringify({ file: nativeFile(id), records: 6, sleepMs: 0 }),
    });
    const { status } = await run.completion;
    assert.equal(status, 0, run.output());
    assert.ok(existsSync(portableFile(id)), "the run's conversation is captured into the project");
    assert.equal(existsSync(nativeFile(id)), false, "and native storage is reverted");

    // Reconciliation reads native storage, and native storage no longer holds
    // this session. The project's copy must come out of it unchanged.
    const menu = runCli(["sessions", "list"]);
    assert.equal(menu.status, 0, menu.stderr);
    assert.ok(existsSync(portableFile(id)), "`sessions list` must not delete what native no longer holds");
    const sync = runCli(["sessions", "sync"]);
    assert.equal(sync.status, 0, sync.stderr);
    assert.ok(existsSync(portableFile(id)), "an explicit sync must not delete it either");

    const canonical = await readCanonicalSession(projectRoot, `claude-${id}`);
    assert.ok(canonical.events.length > 0, "canonical history still holds the conversation");
    assert.equal(canonical.mappings.projections.claude.nativeSessionId, id, "the mapping still names the run's session");
  }, { sessions: 2, records: 4 });
});

test("a reverted conversation can still be continued, and a resume only names a session native storage holds", async () => {
  await withClaudeProject(async ({ projectRoot, nativeFile, root, runCli, launchAsync }) => {
    const id = "cccc0000-0000-4000-8000-000000000002";
    const run = await launchAsync(["claude"], {
      AVENIC_AGENT_WRITE: JSON.stringify({ file: nativeFile(id), records: 6, sleepMs: 0 }),
    });
    assert.equal((await run.completion).status, 0, run.output());
    assert.equal(existsSync(nativeFile(id)), false, "native storage was reverted");

    const probe = path.join(root, "continue-probe.json");
    const continued = runCli(["sessions", "continue", `claude-${id}`, "--agent", "claude"], {
      AVENIC_AGENT_PROBE: probe,
      AVENIC_AGENT_NATIVE_LIST: path.dirname(nativeFile(id)),
    });
    assert.equal(continued.status, 0, continued.stderr);
    const observed = JSON.parse(await readFile(probe, "utf8"));
    const argv = observed.argv ?? [];
    assert.equal(argv[0] === "--resume" || argv[0] === "--session-id", true, `continuation must open a real session (${argv.join(" ")})`);
    if (argv[0] === "--resume") {
      assert.ok(
        (observed.native ?? []).includes(`${argv[1]}.jsonl`),
        `a resume may only name a session native storage holds at spawn time (${argv[1]})`,
      );
    }
    // The conversation is held again: the mapping names a native session the
    // agent actually opened, and canonical history is intact.
    const canonical = await readCanonicalSession(projectRoot, `claude-${id}`);
    const mapped = canonical.mappings.projections.claude.nativeSessionId;
    assert.ok(mapped, "the continuation writes a mapping");
    assert.ok(canonical.events.length > 0, "canonical history still holds the conversation");
    const held = (await readdir(path.dirname(nativeFile(id)))).includes(`${mapped}.jsonl`)
      || existsSync(path.join(projectRoot, ".agents", "sessions", "claude", `${mapped}.jsonl`));
    assert.ok(held, `the mapping must name a session that exists somewhere real (${mapped})`);
  }, { sessions: 2, records: 4 });
});

test("a continuation never prepares a resume for a session the project cannot produce", async () => {
  await withClaudeProject(async ({ projectRoot, environment, sessionIds, portableFile, nativeFile, runCli }) => {
    const synced = runCli(["sessions", "sync"]);
    assert.equal(synced.status, 0, synced.stderr);
    const listed = runCli(["sessions", "list"]);
    assert.equal(listed.status, 0, listed.stderr);
    const canonicalId = `claude-${sessionIds[0]}`;
    await setActiveCanonicalSession(projectRoot, canonicalId);
    await rm(portableFile(sessionIds[0]), { force: true });
    await rm(nativeFile(sessionIds[0]), { force: true });

    // No capture ran first here: this is the preparation step on its own, the
    // one every host shares. The mapping still names a session neither store
    // holds, so the only honest answer is a fresh native session built from
    // the shared history — never `--resume <gone-id>`.
    const continuation = await prepareCanonicalContinuation(projectRoot, canonicalId, "claude", { environment });
    assert.equal(continuation.mode, "bootstrap");
    assert.deepEqual(
      continuation.launch.argumentsList.slice(0, 1),
      ["--session-id"],
      `prepared ${continuation.launch.argumentsList.join(" ")}`,
    );
  }, { sessions: 2, records: 4 });
});

test("a mapping whose session the project no longer holds never reads as current", async () => {
  await withClaudeProject(async ({ projectRoot, sessionIds, portableFile, nativeFile, runCli }) => {
    const synced = runCli(["sessions", "sync"]);
    assert.equal(synced.status, 0, synced.stderr);
    const listed = runCli(["sessions", "list"]);
    assert.equal(listed.status, 0, listed.stderr);
    // Listing history moves the active pointer; pin it to the conversation
    // this test is about, after that pass has had its say.
    await setActiveCanonicalSession(projectRoot, `claude-${sessionIds[0]}`);
    // The project holds sessions — just not the one the active mapping names.
    await rm(portableFile(sessionIds[0]), { force: true });
    await rm(nativeFile(sessionIds[0]), { force: true });

    const status = runCli(["status", "--json"]);
    assert.equal(status.status, 0, status.stderr);
    const model = JSON.parse(status.stdout);
    const claude = model.agents.find((agent) => agent.id === "claude");
    assert.ok(claude.history.sessions > 0, "the project does hold other sessions");
    assert.notEqual(claude.history.sync, "current", "a conversation held nowhere is not in sync");
  }, { sessions: 2, records: 4 });
});
