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
