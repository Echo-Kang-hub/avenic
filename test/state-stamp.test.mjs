import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { finishLaunch, joinLaunchGroup } from "../packages/core/src/runtime/session-interop.mjs";
import { launchGroupState, sessionLeasePath } from "../packages/core/src/runtime/sessions.mjs";
import { readStateStamp, refreshStateStamp } from "../packages/core/src/runtime/sessions.mjs";
import { stateStampFile } from "../packages/core/src/runtime/project-paths.mjs";
import { withClaudeProject } from "./helpers/session-fixture.mjs";

// A dashboard is not the launcher: it watches a project from the outside and
// has to learn that a launch started, an agent exited or a conversation grew
// without scanning the project every second. One tiny file carries exactly
// that — a revision, which agent is running, and how many conversations exist
// — and the truth stays where it always was (`launchGroupState` and the
// canonical store). These tests pin the contract the watcher depends on.

test("a launch transition is visible in one small stamp", async () => {
  await withClaudeProject(async ({ projectRoot, environment }) => {
    assert.equal(existsSync(stateStampFile(projectRoot)), false, "nothing has happened in this project yet");
    assert.equal(await readStateStamp(projectRoot), null);

    const group = await joinLaunchGroup(projectRoot, "claude", { environment });
    const running = await readStateStamp(projectRoot);
    assert.equal(running.launches.claude, "running", "the stamp says who is running");
    assert.equal(running.launches.codex, "idle");
    assert.equal(running.sessions.count, 0, "no conversation is in the project yet");

    await finishLaunch(projectRoot, "claude", { environment, member: group.member });
    const idle = await readStateStamp(projectRoot);
    assert.equal(idle.launches.claude, "idle", "the exit is visible the moment it is over");
    assert.ok(idle.revision > running.revision, "every transition is a new revision");
  });
});

test("an import says a conversation arrived without the reader scanning for it", async () => {
  await withClaudeProject(async ({ projectRoot, environment, sessionIds }) => {
    const group = await joinLaunchGroup(projectRoot, "claude", { environment });
    await finishLaunch(projectRoot, "claude", { environment, member: group.member });

    const stamp = await readStateStamp(projectRoot);
    assert.equal(stamp.sessions.count, sessionIds.length, "every fixture conversation is in the project now");
    assert.match(stamp.sessions.active, /^claude-/, "the active conversation is named in the stamp");
    assert.equal(stamp.launches.claude, "idle");
  });
});

test("a stamp write with nothing new leaves the file alone", async () => {
  await withClaudeProject(async ({ projectRoot, environment }) => {
    const group = await joinLaunchGroup(projectRoot, "claude", { environment });
    await finishLaunch(projectRoot, "claude", { environment, member: group.member });
    const before = await stat(stateStampFile(projectRoot));
    const stamp = await readStateStamp(projectRoot);

    await refreshStateStamp(projectRoot);
    await refreshStateStamp(projectRoot);

    const after = await stat(stateStampFile(projectRoot));
    assert.equal(after.mtimeMs, before.mtimeMs, "an unchanged project must not wake a watcher");
    assert.equal((await readStateStamp(projectRoot)).revision, stamp.revision);
  });
});

test("a launch that died reads as interrupted, and the stamp agrees with the one source of truth", async () => {
  await withClaudeProject(async ({ projectRoot }) => {
    const stateDir = sessionLeasePath("claude", projectRoot);
    await mkdir(path.join(stateDir, "pids"), { recursive: true });
    await writeFile(path.join(stateDir, "pids", `2147483647-${Date.now()}-0`), "");

    await refreshStateStamp(projectRoot);

    const stamp = await readStateStamp(projectRoot);
    assert.equal(stamp.launches.claude, "interrupted");
    assert.equal(await launchGroupState("claude", projectRoot), "interrupted", "the stamp mirrors the answer the launch path itself reads");
  });
});

test("a real launch is running in the stamp while the agent is alive, and idle after it exits", async () => {
  await withClaudeProject(async ({ projectRoot, nativeFile, sessionIds, launchAsync }) => {
    // The stand-in agent stays alive for a moment so the middle of the run can
    // be read from the outside, exactly as a dashboard would read it. It writes
    // where a working agent writes — into the native transcript it owns — so the
    // exit has a real conversation to capture.
    const run = await launchAsync(["claude"], {
      AVENIC_AGENT_WRITE: JSON.stringify({ file: nativeFile(sessionIds[0]), records: 1, sleepMs: 3000 }),
    });
    let alive = false;
    for (let attempt = 0; attempt < 200 && !alive; attempt += 1) {
      const probe = await run.probe();
      alive = Boolean(probe?.wroteAt);
      if (!alive) await delay(25);
    }
    assert.ok(alive, "the fixture agent must have started");

    const during = await readStateStamp(projectRoot);
    assert.equal(during.launches.claude, "running", "a live launch is visible in the stamp");

    await run.completion;
    const after = await readStateStamp(projectRoot);
    assert.equal(after.launches.claude, "idle", "the exit settles the stamp");
    assert.ok(after.revision > during.revision);
  });
});
