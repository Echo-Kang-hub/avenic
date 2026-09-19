import assert from "node:assert/strict";
import test from "node:test";
import { listCanonicalSessions } from "../packages/core/src/runtime/canonical-sessions.mjs";
import { withClaudeProject } from "./helpers/session-fixture.mjs";

// What the user waits for is the delay before the official agent process
// starts. The ceiling guards against whole-history work returning to the
// launch path, not against machine noise: local warm launches are well under
// the product target of one second.
const WARM_LAUNCH_BUDGET_MS = 2500;
const AGENT_START_BUDGET_MS = 2500;

test("a plain launch reaches the agent without touching canonical history", async () => {
  await withClaudeProject(async ({ launch, sessionIds }) => {
    assert.ok(sessionIds.length > 0);
    const first = await launch(["claude"]);
    assert.equal(first.status, 0);
    assert.equal(first.probe.cwd.length > 0, true);
    assert.deepEqual(first.probe.canonical, [], "no canonical session may exist before the TUI starts");
  }, { sessions: 3, records: 5 });
});

test("a plain launch resumes no session and passes no continuation prompt", async () => {
  await withClaudeProject(async ({ launch }) => {
    const result = await launch(["claude"]);
    assert.deepEqual(result.probe.argv, [], "the official TUI must start with no Avenic arguments");
  }, { sessions: 2, records: 4 });
});

test("a warm plain launch starts the agent without scanning history", async () => {
  await withClaudeProject(async ({ launch }) => {
    await launch(["claude"]);
    const warm = await launch(["claude"]);
    assert.equal(warm.status, 0);
    assert.ok(warm.toAgentMs !== null, "the agent process must start");
    assert.ok(
      warm.toAgentMs < AGENT_START_BUDGET_MS,
      `the agent waited ${warm.toAgentMs} ms to start (wrapper lifetime ${warm.elapsedMs.toFixed(0)} ms)`,
    );
    // The whole wrapper, including the capture that runs after the agent exits.
    assert.ok(warm.elapsedMs < WARM_LAUNCH_BUDGET_MS, `warm plain launch took ${warm.elapsedMs.toFixed(0)} ms`);
  }, { sessions: 12, records: 120 });
});

/**
 * The fastest warm launch in a project of a given size: one throwaway launch
 * first, so the history is already imported and the runs being timed are the
 * ones a user makes every day, then three timed launches and the quickest of
 * them — the sample least polluted by whatever else the machine is doing.
 */
async function fastestWarmLaunch(options, runs = 2) {
  let measured = null;
  await withClaudeProject(async ({ launch }) => {
    await launch(["claude"]);
    const samples = [];
    for (let index = 0; index < runs; index += 1) samples.push((await launch(["claude"])).toAgentMs);
    measured = Math.min(...samples);
  }, options);
  return measured;
}

test("the wait before a plain launch starts does not grow with the project's history", async () => {
  // The pre-spawn work is about the project, not about how many conversations
  // it holds. A hundred against three: a per-session scan would be many times
  // slower in the larger project, while the allowance here is a factor of three
  // plus fixed slack — wide enough that machine noise cannot trip it, narrow
  // enough that linear work cannot hide inside it.
  const few = await fastestWarmLaunch({ sessions: 3, records: 3 });
  const many = await fastestWarmLaunch({ sessions: 100, records: 3 });
  assert.ok(Number.isFinite(few) && Number.isFinite(many), `both launches must reach the agent (${few} / ${many})`);
  assert.ok(
    many < few * 3 + 250,
    `100 conversations took ${many} ms to reach the agent, against ${few} ms for 3`,
  );
});

test("a plain launch never blocks on importing pre-existing history", async () => {
  await withClaudeProject(async ({ launch, projectRoot }) => {
    const result = await launch(["claude"]);
    const during = result.probe.canonical.length;
    assert.equal(during, 0);
    // The exit capture still makes the history durable afterwards.
    const after = await listCanonicalSessions(projectRoot);
    assert.ok(after.length > 0, "the exit capture must still import the history");
  }, { sessions: 4, records: 6 });
});
