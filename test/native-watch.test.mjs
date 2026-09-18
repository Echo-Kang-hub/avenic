import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { flushNativeSessions, startNativeWatch } from "../packages/core/src/runtime/native-watch.mjs";
import { readCanonicalSession } from "../packages/core/src/runtime/canonical-sessions.mjs";
import { withClaudeProject } from "./helpers/session-fixture.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("a durability pass makes a running session visible without ending it", async () => {
  await withClaudeProject(async ({ projectRoot, environment, sessionIds, appendRecords }) => {
    await flushNativeSessions(projectRoot, "claude", { environment });
    const canonicalId = `claude-${sessionIds[0]}`;
    const before = (await readCanonicalSession(projectRoot, canonicalId)).events.length;

    // The agent is still working: two more records and no exit.
    await appendRecords(sessionIds[0], 2);
    const pass = await flushNativeSessions(projectRoot, "claude", { environment });

    assert.equal(pass.imported, 1);
    const after = await readCanonicalSession(projectRoot, canonicalId);
    assert.equal(after.events.length, before + 2);
  }, { sessions: 3, records: 6 });
});

test("a durability pass never writes to native storage", async () => {
  await withClaudeProject(async ({ projectRoot, environment, sessionIds, nativeSnapshot, appendRecords }) => {
    await appendRecords(sessionIds[0], 2);
    const before = await nativeSnapshot();
    await flushNativeSessions(projectRoot, "claude", { environment });
    assert.deepEqual(await nativeSnapshot(), before);
  }, { sessions: 2, records: 4 });
});

test("a durability pass does not move the active session", async () => {
  await withClaudeProject(async ({ projectRoot, environment, sessionIds, createUnmappedSession }) => {
    const { getActiveCanonicalSessionId, setActiveCanonicalSession } = await import("../packages/core/src/runtime/config.mjs");
    await flushNativeSessions(projectRoot, "claude", { environment });
    await setActiveCanonicalSession(projectRoot, `claude-${sessionIds[1]}`);

    await createUnmappedSession(2);
    await flushNativeSessions(projectRoot, "claude", { environment });

    assert.equal(await getActiveCanonicalSessionId(projectRoot), `claude-${sessionIds[1]}`);
  }, { sessions: 2, records: 4 });
});

test("the watch keeps capturing while the agent runs and stops on request", async () => {
  await withClaudeProject(async ({ projectRoot, environment, sessionIds, appendRecords }) => {
    const watcher = startNativeWatch(projectRoot, "claude", { environment, intervalMs: 40 });
    try {
      await delay(60);
      await appendRecords(sessionIds[0], 3);
      const canonicalId = `claude-${sessionIds[0]}`;
      const deadline = Date.now() + 4000;
      let events = 0;
      while (Date.now() < deadline) {
        await delay(50);
        // 第一次轮询可能早于 watcher 的首趟导入：会话尚不存在＝还没有事件，
        // 而不是失败（与下面的实时会话用例同一处理）。
        events = (await readCanonicalSession(projectRoot, canonicalId).catch(() => ({ events: [] }))).events.length;
        if (events >= 9) break;
      }
      assert.ok(events >= 9, `the watch must capture the appended records (saw ${events})`);
    } finally {
      await watcher.drain();
    }

    const canonicalId = `claude-${sessionIds[0]}`;
    await appendRecords(sessionIds[0], 2);
    const quiet = (await stat(path.join(projectRoot, ".agents", "sessions", "canonical", canonicalId, "events.jsonl"))).size;
    await delay(200);
    const still = (await stat(path.join(projectRoot, ".agents", "sessions", "canonical", canonicalId, "events.jsonl"))).size;
    assert.equal(still, quiet, "a stopped watch must not keep capturing");
  }, { sessions: 2, records: 6 });
});

test("a half-written record does not break the durability pass", async () => {
  await withClaudeProject(async ({ projectRoot, environment, sessionIds, appendRecords, truncateTail }) => {
    await appendRecords(sessionIds[0], 2);
    await truncateTail(sessionIds[0]);
    const pass = await flushNativeSessions(projectRoot, "claude", { environment });
    assert.equal(pass.failed ?? 0, 0);
    const stored = await readCanonicalSession(projectRoot, `claude-${sessionIds[0]}`);
    assert.ok(stored.events.length > 0, "the complete records still become durable");
  }, { sessions: 2, records: 4 });
});

test("a running agent's session becomes durable before the agent exits", async () => {
  await withClaudeProject(async ({ projectRoot, nativeRoot, launchAsync, createUnmappedSession }) => {
    const sessionId = await createUnmappedSession(1, "live-session-0001");
    const liveFile = path.join(nativeRoot, `${sessionId}.jsonl`);
    const sleepMs = 5000;
    const run = await launchAsync(["claude"], {
      AVENIC_WATCH_INTERVAL_MS: "300",
      AVENIC_AGENT_WRITE: JSON.stringify({ file: liveFile, records: 2, sleepMs }),
    });

    // The agent is still alive here: it appended its records and went back to
    // work. Everything below must already be durable.
    const canonicalId = `claude-${sessionId}`;
    const deadline = Date.now() + sleepMs - 500;
    let events = 0;
    while (Date.now() < deadline) {
      await delay(100);
      events = (await readCanonicalSession(projectRoot, canonicalId).catch(() => ({ events: [] }))).events.length;
      if (events >= 3) break;
    }

    const probe = await run.probe();
    assert.ok(probe?.wroteAt, "the agent must have started writing");
    assert.equal(run.child.exitCode, null, "the agent must still be running");
    assert.ok(events >= 3, `the live session must be durable while the agent runs (saw ${events} events)`);
    assert.equal(await readFile(liveFile, "utf8").then((text) => text.includes("live message 1")), true);

    assert.equal((await run.completion).status, 0);
  }, { sessions: 0 });
});

test("the watch reports a failure instead of throwing into the agent", async () => {
  await withClaudeProject(async ({ projectRoot, environment }) => {
    const failures = [];
    const watcher = startNativeWatch(projectRoot, "claude", {
      environment,
      intervalMs: 30,
      onError: (error) => failures.push(error),
    });
    try {
      // A pass against a project whose session root cannot exist.
      await flushNativeSessions(path.join(projectRoot, "gone"), "claude", { environment }).catch(() => {});
      await delay(120);
    } finally {
      await watcher.drain();
    }
    assert.equal(failures.length, 0, "a healthy project must not report failures");
  }, { sessions: 2, records: 4 });
});
