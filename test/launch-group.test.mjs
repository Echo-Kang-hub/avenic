import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { getSessionAdapter } from "../packages/core/src/runtime/adapters/index.mjs";
import { finishLaunch, joinLaunchGroup } from "../packages/core/src/runtime/session-interop.mjs";
import { launchFinished, sessionLeasePath } from "../packages/core/src/runtime/sessions.mjs";
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
    const stateDir = sessionLeasePath("claude", projectRoot);
    assert.equal(existsSync(path.join(stateDir, "pids")), false, "no launch is left in the group");
    // The snapshot itself stays: it now describes native storage as it stands,
    // and the next launch verifies against it instead of copying the tree.
    assert.equal(existsSync(path.join(stateDir, "snapshot.clean")), true, "a clean exit leaves the snapshot trustworthy");
  });
});

test("a launch after a clean exit verifies the retained snapshot instead of copying it", async () => {
  await withClaudeProject(async ({ projectRoot, environment, createUnmappedSession, nativeSnapshot }) => {
    const stateDir = sessionLeasePath("claude", projectRoot);
    const snapshotRoot = path.join(stateDir, "snapshot");
    // What the snapshot holds, by modification time: copying a file again
    // rewrites it, verifying it does not.
    const stamps = async () => {
      const found = {};
      for (const name of await readdir(snapshotRoot)) found[name] = (await stat(path.join(snapshotRoot, name))).mtimeMs;
      return found;
    };

    const first = await joinLaunchGroup(projectRoot, "claude", { environment });
    await createUnmappedSession(3);
    await finishLaunch(projectRoot, "claude", { environment, member: first.member });
    const settled = await nativeSnapshot();
    const copied = await stamps();

    const second = await joinLaunchGroup(projectRoot, "claude", { environment });
    assert.deepEqual(await stamps(), copied, "the second launch must verify the retained snapshot, not copy it");
    assert.deepEqual(await nativeSnapshot(), settled, "the second launch must not disturb native storage");
    await finishLaunch(projectRoot, "claude", { environment, member: second.member });
    assert.deepEqual(await nativeSnapshot(), settled);
    assert.equal(existsSync(path.join(stateDir, "snapshot.clean")), true);
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

// A killed launch leaves a watch behind, and that watch decides what to do by
// reading whether the launch's work is finished. Two processes capturing the
// same tree at once cost far more than either one alone, so the launch that
// takes an interrupted group over has to say so in the place the watch reads.
test("the launch that takes over an interrupted group finishes what the dead one owed", async () => {
  await withClaudeProject(async ({ projectRoot, environment, createUnmappedSession }) => {
    const adapter = getSessionAdapter("claude");
    const stateDir = sessionLeasePath("claude", projectRoot);
    const dead = `2147483647-${Date.now()}-0`;
    const aged = `2147483646-${Date.now() - 11 * 60 * 1000}-0`;
    await mkdir(path.join(stateDir, "launch", dead), { recursive: true });
    await mkdir(path.join(stateDir, "launch", aged), { recursive: true });
    await adapter.snapshotNative(projectRoot, path.join(stateDir, "snapshot"), { environment });
    await mkdir(path.join(stateDir, "pids"), { recursive: true });
    await writeFile(path.join(stateDir, "pids", dead), "");
    await writeFile(path.join(stateDir, "snapshot.ok"), "");
    await createUnmappedSession(3);
    assert.equal(launchFinished("claude", projectRoot, dead), false, "a killed launch starts out unfinished");

    const group = await joinLaunchGroup(projectRoot, "claude", { environment });

    assert.equal(
      launchFinished("claude", projectRoot, dead),
      true,
      "recovering the group is the finish the dead launch was owed, and its watch must not repeat it",
    );
    assert.equal(
      existsSync(path.join(stateDir, "launch", aged)),
      false,
      "a record no watch can still be waiting on is dropped rather than adopted",
    );
    await finishLaunch(projectRoot, "claude", { environment, member: group.member });
  });
});

test("a launch record whose owner is still running is left alone", async () => {
  await withClaudeProject(async ({ projectRoot, environment }) => {
    const stateDir = sessionLeasePath("claude", projectRoot);
    const running = `${process.pid}-${Date.now()}-1`;
    await mkdir(path.join(stateDir, "launch", running), { recursive: true });
    await writeFile(path.join(stateDir, "snapshot.ok"), "");

    const group = await joinLaunchGroup(projectRoot, "claude", { environment });

    assert.equal(launchFinished("claude", projectRoot, running), false, "a watch for a live launch still has something to watch");
    await finishLaunch(projectRoot, "claude", { environment, member: group.member });
  });
});

test("a fixture's launch group is taken off the machine with the tree it made", async () => {
  // 启动组的 state 落在系统临时目录里，按项目身份取名 —— 它在夹具的 root 之外，所以
  // removeTree(root) 够不着它。夹具每跑一次都新建一个项目，于是每跑一次就往机器上留一
  // 个目录：一个测试一次的泄漏，机器上的临时目录早晚会被它塞满。项目是夹具造的，跟着
  // 夹具走才对。
  let lease = null;
  await withClaudeProject(async ({ projectRoot, environment }) => {
    const group = await joinLaunchGroup(projectRoot, "claude", { environment });
    assert.ok(group, "this fixture can join a launch group");
    lease = sessionLeasePath("claude", projectRoot);
    assert.equal(existsSync(lease), true, "the group's state lives in the system temp directory");
  });
  assert.equal(existsSync(lease), false, "and the fixture takes it away with the tree it made");
});
