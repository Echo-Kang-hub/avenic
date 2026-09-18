import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { getSessionAdapter } from "../packages/core/src/runtime/adapters/index.mjs";
import { finishLaunch, joinLaunchGroup } from "../packages/core/src/runtime/session-interop.mjs";
import { sessionLeasePath } from "../packages/core/src/runtime/sessions.mjs";
import { withClaudeProject } from "./helpers/session-fixture.mjs";

// Three hosts run the same launch: the CLI's foreground `avenic claude`, the
// detached watchdog that finishes an interrupted one, and the VS Code
// extension's terminal. The rules they share — what the first member snapshots,
// what a recovering group does before it snapshots, and when a revert is safe
// at all — live in one place, so these tests pin the rules instead of one
// host's copy of them.

test("a launch group captures what the run produced, then restores native storage", async () => {
  await withClaudeProject(async ({
    projectRoot, environment, nativeRoot, portableFile, canonicalDirectory, createUnmappedSession, nativeSnapshot,
  }) => {
    const before = await nativeSnapshot();
    const group = await joinLaunchGroup(projectRoot, "claude", { environment });
    assert.ok(group, "an agent with its own native directory joins the group");
    const created = await createUnmappedSession(3);

    await finishLaunch(projectRoot, "claude", { environment, member: group.member });

    assert.equal(existsSync(portableFile(created)), true, "the session the run created belongs to the project");
    assert.equal(
      existsSync(path.join(canonicalDirectory(`claude-${created}`), "session.json")),
      true,
      "the run's session reaches canonical history through the same capture",
    );
    assert.deepEqual(await nativeSnapshot(), before, "native storage is back to its pre-launch state");
    assert.equal(existsSync(path.join(nativeRoot, `${created}.jsonl`)), false);
    assert.equal(existsSync(sessionLeasePath("claude", projectRoot)), false, "the group state goes away with its last member");
  });
});

test("a snapshot that never completed is never replayed over native storage", async () => {
  await withClaudeProject(async ({ projectRoot, environment, nativeRoot, createUnmappedSession, nativeSnapshot }) => {
    const group = await joinLaunchGroup(projectRoot, "claude", { environment });
    const stateDir = sessionLeasePath("claude", projectRoot);
    // The run dies between copying the snapshot and marking it complete, so the
    // snapshot holds a half-read tree. Writing that back would destroy history
    // the user still has.
    await rm(path.join(stateDir, "snapshot.ok"), { force: true });
    await writeFile(path.join(stateDir, "snapshot", "half-copied.jsonl"), "truncated\n");
    const created = await createUnmappedSession(2);
    const duringRun = await nativeSnapshot();

    await finishLaunch(projectRoot, "claude", { environment, member: group.member });

    assert.deepEqual(await nativeSnapshot(), duringRun, "an unmarked snapshot must not be reverted");
    assert.equal(existsSync(path.join(nativeRoot, `${created}.jsonl`)), true);
  });
});

test("a group that died last run is salvaged into the project before the next snapshot", async () => {
  await withClaudeProject(async ({
    projectRoot, environment, portableFile, createUnmappedSession, nativeSnapshot,
  }) => {
    const adapter = getSessionAdapter("claude");
    const stateDir = sessionLeasePath("claude", projectRoot);
    // A group that died without exiting: its completed snapshot records the
    // pre-launch tree, and its only member pid is long gone.
    await adapter.snapshotNative(projectRoot, path.join(stateDir, "snapshot"), { environment });
    await mkdir(path.join(stateDir, "pids"), { recursive: true });
    await writeFile(path.join(stateDir, "pids", "2147483647"), "");
    await writeFile(path.join(stateDir, "snapshot.ok"), "");
    const before = await nativeSnapshot();
    const lost = await createUnmappedSession(3);

    const group = await joinLaunchGroup(projectRoot, "claude", { environment });
    // A launch hands the project's records to the agent before its TUI opens,
    // which is also what keeps the salvaged session in the project's copy.
    await adapter.restore(projectRoot, { environment });
    await finishLaunch(projectRoot, "claude", { environment, member: group.member });

    assert.equal(existsSync(portableFile(lost)), true, "the dead run's session must reach the project");
    assert.deepEqual(await nativeSnapshot(), before, "the dead run's session must not survive in native storage");
  });
});
