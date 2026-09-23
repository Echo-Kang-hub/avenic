import assert from "node:assert/strict";
import test from "node:test";

import {
  HOOK_CAPABILITIES,
  HOOK_EVENTS,
  HOOK_POLICY,
  hookCapability,
  hookFingerprint,
  hookSupport,
  normalizeHook,
} from "../packages/core/src/runtime/hooks.mjs";

// What each agent tells Avenic, and what Avenic is allowed to say back.
//
// Everything asserted here is read off docs/agent-hooks.md, which was read off
// the installed binaries: the native event names, the payload field names and
// the version numbers are real, the payload *values* below are fiction. The one
// thing a capability matrix must never do is claim more than was verified — a
// mapping Avenic invented fires never, and a notification that never arrives
// reads to the user as "my agent stopped telling me anything". So `absent` is a
// value here, and a payload that carries a native event nobody mapped comes
// back as null rather than as the nearest event that fits.

const CLAUDE_STOP = {
  session_id: "11111111-2222-3333-4444-555555555555",
  transcript_path: "C:/tmp/not-a-real-transcript.jsonl",
  cwd: "D:/tmp/not-a-real-project",
  hook_event_name: "Stop",
  prompt_id: "p-0001",
  stop_hook_active: false,
};

test("the vocabulary is six events, and nothing else is one", () => {
  assert.deepEqual(HOOK_EVENTS, ["session.started", "turn.started", "turn.completed", "turn.failed", "attention.required", "session.ended"]);
  assert.equal(new Set(HOOK_EVENTS).size, HOOK_EVENTS.length);
});

test("every agent names its mechanism, the file it goes in, and where its duration comes from", () => {
  assert.deepEqual(Object.keys(HOOK_CAPABILITIES), ["claude", "codex", "opencode"]);
  for (const [agent, row] of Object.entries(HOOK_CAPABILITIES)) {
    assert.match(row.mechanism, /^[a-z-]+$/, `${agent}: mechanism`);
    assert.ok(row.file.length > 0, `${agent}: the file the hooks go in`);
    assert.ok(["payload", "correlated", "none"].includes(row.duration), `${agent}: ${row.duration}`);
    assert.ok(row.verified.length > 0, `${agent}: which version this was read off`);
    for (const [event, entry] of Object.entries(row.events)) {
      assert.ok(HOOK_EVENTS.includes(event), `${agent}.${event} 不在事件表里`);
      assert.ok(["reliable", "conditional", "absent"].includes(entry.reliability), `${agent}.${event}: ${entry.reliability}`);
      // 要么有原生事件名，要么说清为什么没有 —— 「没有」本身是一个答案，得带上理由。
      if (entry.reliability === "absent") assert.ok(entry.native === null && entry.note.length > 0, `${agent}.${event}: 缺席要说得出为什么`);
      else assert.ok(typeof entry.native === "string" && entry.native.length > 0, `${agent}.${event}: 有的话就得说出原生事件名`);
    }
  }
});

test("Claude's Stop is a completed turn, and the session, the directory and the prompt come with it", () => {
  const event = normalizeHook("claude", CLAUDE_STOP);
  assert.equal(event.event, "turn.completed");
  assert.equal(event.agent, "claude");
  assert.equal(event.sessionId, "11111111-2222-3333-4444-555555555555");
  assert.equal(event.cwd, "D:/tmp/not-a-real-project");
  // Stop 上没有 turn_id：能对上这一次提问的是 prompt_id，duration 也只能靠它算。
  assert.equal(event.turnId, "p-0001");
  assert.equal(HOOK_CAPABILITIES.claude.duration, "correlated");
});

test("Claude's StopFailure is a failed turn with the reason class it carries, and an exit code is not the reason", () => {
  const event = normalizeHook("claude", { ...CLAUDE_STOP, hook_event_name: "StopFailure", error: "rate_limit", error_details: "429 from the gateway" });
  assert.equal(event.event, "turn.failed");
  assert.equal(event.reason, "rate_limit");
  // 退出码不是失败的理由：StopFailure 根本不看退出码，任何从退出码推断出来的理由都是编的。
  const bare = normalizeHook("claude", { ...CLAUDE_STOP, hook_event_name: "StopFailure" });
  assert.equal(bare.event, "turn.failed");
  assert.equal(bare.reason, "unknown");
});

test("a Claude notification is attention, and a type nobody mapped is nothing at all", () => {
  for (const type of ["permission_prompt", "idle_prompt", "agent_needs_input", "agent_completed"]) {
    const event = normalizeHook("claude", { ...CLAUDE_STOP, hook_event_name: "Notification", message: "the agent is waiting", notification_type: type });
    assert.equal(event.event, "attention.required", type);
    assert.equal(event.reason, type);
    assert.equal(event.detail, "the agent is waiting");
  }
  assert.equal(normalizeHook("claude", { ...CLAUDE_STOP, hook_event_name: "Notification", notification_type: "something_new" }), null);
  assert.equal(normalizeHook("claude", { ...CLAUDE_STOP, hook_event_name: "PreCompact" }), null, "没有映射的原生事件不能就近找一个");
});

test("Codex has no failure hook, and the matrix says so instead of pretending", () => {
  const failed = HOOK_CAPABILITIES.codex.events["turn.failed"];
  assert.equal(failed.reliability, "absent");
  assert.equal(failed.native, null);
  assert.match(failed.note, /app server/i);
  // Codex 的钩子在被审阅之前是 untrusted：这一行必须说得出这层条件。
  assert.equal(HOOK_CAPABILITIES.codex.events["turn.completed"].reliability, "conditional");
  assert.match(HOOK_CAPABILITIES.codex.events["turn.completed"].note, /trust/i);
  // 反而它的会话/轮次标识是稳的（session_id / turn_id 两个字段都在载荷里）。
  const stop = normalizeHook("codex", { session_id: "s-1", turn_id: "t-1", cwd: "D:/tmp/not-a-real-project", hook_event_name: "Stop" });
  assert.deepEqual({ event: stop.event, sessionId: stop.sessionId, turnId: stop.turnId, cwd: stop.cwd }, { event: "turn.completed", sessionId: "s-1", turnId: "t-1", cwd: "D:/tmp/not-a-real-project" });
});

test("OpenCode spells it sessionID, and an event that does not exist in this version maps to nothing", () => {
  const asked = normalizeHook("opencode", { sessionID: "ses_1", directory: "D:/tmp/not-a-real-project", type: "permission.asked", permission: { title: "run a command" } });
  assert.equal(asked.event, "attention.required");
  assert.equal(asked.sessionId, "ses_1");
  assert.equal(asked.cwd, "D:/tmp/not-a-real-project");
  assert.equal(asked.reason, "permission.asked");
  const idle = normalizeHook("opencode", { sessionID: "ses_1", directory: "D:/tmp/not-a-real-project", type: "session.idle" });
  assert.equal(idle.event, "turn.completed");
  // 1.18.30 里没有 permission.updated —— 一个不存在的原生事件不该悄悄变成 attention。
  assert.equal(normalizeHook("opencode", { sessionID: "ses_1", type: "permission.updated" }), null);
});

test("a version below the one that was verified is unsupported, and it says so in the agent's own name", () => {
  assert.deepEqual(hookSupport("claude", "2.1.274"), { supported: true, since: HOOK_CAPABILITIES.claude.since, note: null });
  assert.equal(hookSupport("codex", "0.154.0").supported, true);
  const old = hookSupport("codex", "0.120.0");
  assert.equal(old.supported, false);
  assert.equal(old.note, "Unsupported by Codex 0.120.0");
  assert.equal(hookSupport("opencode", "1.17.0").supported, false);
  // 版本读不出来时不下结论：说「不知道」比说「支持」安全。
  assert.equal(hookSupport("codex", null).supported, false);
  assert.equal(hookSupport("codex", "unknown").supported, false);
  assert.equal(hookSupport("nobody", "1.0.0"), null);
});

test("the thresholds are one policy, and a completed turn waits for it", () => {
  assert.ok(HOOK_POLICY.completedMinSeconds >= 20, "完成的提示有个下限，不是每轮都响");
  assert.equal(HOOK_POLICY.attentionImmediate, true);
  assert.equal(HOOK_POLICY.failedImmediate, true);
  assert.ok(HOOK_POLICY.dedupeSeconds >= 30 && HOOK_POLICY.dedupeSeconds <= 60, "同一件事的重复在窗口内只报一次");
});

test("the fingerprint of an event is stable across the noise a payload carries, and distinct otherwise", () => {
  const first = normalizeHook("claude", { ...CLAUDE_STOP, timestamp: "2026-09-24T01:00:00Z" });
  const again = normalizeHook("claude", { ...CLAUDE_STOP, timestamp: "2026-09-24T01:00:07Z" });
  assert.equal(hookFingerprint(first), hookFingerprint(again), "同一件事隔七秒还是同一件事");
  assert.notEqual(hookFingerprint(first), hookFingerprint(normalizeHook("claude", { ...CLAUDE_STOP, prompt_id: "p-0002" })));
  assert.notEqual(hookFingerprint(first), hookFingerprint(normalizeHook("codex", { session_id: CLAUDE_STOP.session_id, turn_id: "p-0001", hook_event_name: "Stop" })));
  assert.equal(typeof hookFingerprint(first), "string");
  assert.equal(hookFingerprint(first).includes(CLAUDE_STOP.session_id), true, "指纹里带上是谁，不然两个会话的同一轮会互相吃掉");
});

test("a capability row for an agent nobody wrote one for is null, not an empty row", () => {
  assert.equal(hookCapability("claude"), HOOK_CAPABILITIES.claude);
  assert.equal(hookCapability("nobody"), null);
  assert.equal(normalizeHook("nobody", CLAUDE_STOP), null);
  assert.equal(normalizeHook("claude", null), null);
  assert.equal(normalizeHook("claude", {}), null);
});
