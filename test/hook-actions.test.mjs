import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { HOOK_POLICY, hookFingerprint, normalizeHook } from "../packages/core/src/runtime/hooks.mjs";
import { HOOK_ACTION_KINDS, emitHook, hookActionsPath, readHookActions } from "../packages/core/src/runtime/hook-actions.mjs";

// What Avenic does with one hook event, once the vocabulary is Avenic's own.
//
// The evidence in docs/agent-hooks.md says which native events exist and what
// they carry; this file is about the other half — what happens after a payload
// becomes an event. Three rules are the whole reason the module exists, and
// each one is pinned here rather than in a comment: a notification fires only
// when HOOK_POLICY says it may, a duration is measured between a turn's own
// start and its end or it is left out, and nothing that leaves this module —
// not the URL, not the state file, not a printed line — carries a credential.
//
// Everything below is driven through the injected `io`: no test here opens a
// socket, shows a desktop notification, or runs a real command. A test that
// popped a toast on the machine it runs on would be a bug report, not a test.

const SECRET = "sk-test-not-a-real-key";
const SESSION = "11111111-2222-3333-4444-555555555555";
const OTHER_SESSION = "99999999-8888-7777-6666-555555555555";

const CLAUDE_START = {
  session_id: SESSION,
  cwd: "D:/tmp/not-a-real-project",
  hook_event_name: "UserPromptSubmit",
  prompt_id: "p-0001",
};
const CLAUDE_STOP = {
  session_id: SESSION,
  cwd: "D:/tmp/not-a-real-project",
  hook_event_name: "Stop",
  prompt_id: "p-0001",
  transcript_path: "C:/tmp/not-a-real-transcript.jsonl",
};

function scratch(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeActions(file, actions) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ actions }, null, 2));
}

/** Every file under a directory, as utf8. A scan that read nothing proves nothing. */
function readTree(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...readTree(full));
    else files.push([full, readFileSync(full, "utf8")]);
  }
  return files;
}

// One fake child process per spawn. The desktop action must never wait for it,
// so it only answers stdin with a close event when the test says a real command
// ended; the fire-and-forget path never touches stdin at all.
//
// `input: "closed"` is the program that exits without reading what was written
// to it: the real pipe answers with an EPIPE on our side. That stream is a real
// EventEmitter here on purpose — an unlistened 'error' on a Node stream is
// thrown, not ignored, and a fake that swallowed it could not catch the bug.
function fakeChild({ close = true, code = 0, fail = null, input = "open" } = {}) {
  const handlers = new Map();
  const stdin = new EventEmitter();
  stdin.write = (chunk) => { child.writes.push(String(chunk)); return true; };
  stdin.end = () => {
    if (input === "closed") setImmediate(() => stdin.emit("error", new Error("write EPIPE — the command closed its input")));
    else if (fail !== null) setImmediate(() => handlers.get("error")?.(fail));
    else if (close) setImmediate(() => handlers.get("close")?.(code, null));
  };
  const child = {
    writes: [],
    unrefCalls: 0,
    killCalls: 0,
    unref() { child.unrefCalls += 1; },
    kill() { child.killCalls += 1; },
    on(event, handler) { handlers.set(event, handler); return child; },
    once(event, handler) { return child.on(event, handler); },
    stderr: { on() { return child.stderr; } },
    stdin,
  };
  return child;
}

/**
 * A project on disk, a machine state directory that is not the user's, and an
 * `io` that records instead of acting. `respond` is the webhook's answer, so a
 * 500, a refusal and a slow gateway are all one line in a test.
 */
function harness({ platform = "linux", actions = [], globalActions = [], respond = async () => ({ ok: true, status: 204 }), child = () => fakeChild() } = {}) {
  const root = scratch("avenic-hook-project-");
  const machine = scratch("avenic-hook-state-");
  const calls = { spawn: [], fetch: [] };
  const io = {
    platform,
    clock: 1_700_000_000_000,
    now() { return io.clock; },
    spawn(command, args, options) {
      const spawned = child(command, args, options);
      calls.spawn.push({ command, args, options, child: spawned });
      return spawned;
    },
    async fetch(url, options) {
      calls.fetch.push({ url, options });
      return respond(url, options);
    },
  };
  // The machine's own state is never read: stateRoot honours this override, and
  // a test that let the real ~/.config/avenic in would be reading (and writing)
  // the developer's machine.
  const environment = { AVENIC_STATE_DIR: machine, PATH: "/usr/bin", HOME: machine };
  if (actions.length > 0) writeActions(hookActionsPath(root), actions);
  if (globalActions.length > 0) writeActions(path.join(machine, "hook-actions.json"), globalActions);
  return {
    root,
    machine,
    environment,
    io,
    calls,
    stateFile: path.join(root, ".agents", "local", "hook-state.json"),
    state() { return JSON.parse(readFileSync(this.stateFile, "utf8")); },
    stateText() { return readFileSync(this.stateFile, "utf8"); },
    emit(payload, options = {}) {
      return emitHook({ agentId: "claude", payload, projectRoot: root, environment, io, ...options });
    },
    dispose() {
      rmSync(root, { recursive: true, force: true });
      rmSync(machine, { recursive: true, force: true });
    },
  };
}

/** A test that would otherwise hang fails on its own terms instead. */
async function bounded(promise, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 2000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("the four kinds are the whole vocabulary of an action, and the actions file is inside the project's own state", () => {
  assert.deepEqual(HOOK_ACTION_KINDS, ["desktop", "openclaw", "webhook", "command"]);
  const file = hookActionsPath("D:/tmp/not-a-real-project");
  // .agents/local/ 是 Avenic 在项目里的机器状态，且已被 gitignore 规则挡住：动作里
  // 可能有一个 hook token，它不能进提交。
  assert.equal(path.basename(file), "hook-actions.json");
  assert.equal(path.dirname(file), path.join("D:/tmp/not-a-real-project", ".agents", "local"));
});

test("a project action replaces a global one of the same id, and a kind nobody wrote is not an action", () => {
  const box = harness({
    globalActions: [{ id: "phone", kind: "desktop", title: "from the machine" }, { id: "kept", kind: "desktop" }],
    actions: [{ id: "phone", kind: "desktop", title: "from the project" }, { id: "bogus", kind: "carrier-pigeon" }, { kind: "desktop" }],
  });
  try {
    const found = readHookActions(box.root, box.environment);
    assert.deepEqual(found.map((action) => action.id), ["kept", "phone"], "一个 id 只有一条动作，按 id 排序");
    assert.equal(found.find((action) => action.id === "phone").title, "from the project");
    assert.equal(found.find((action) => action.id === "kept").title, undefined);
  } finally {
    box.dispose();
  }
});

test("an event nobody mapped is not an event: no action runs, and nothing is written", () => {
  const box = harness({ actions: [{ id: "toast", kind: "desktop" }] });
  try {
    return box.emit({ ...CLAUDE_STOP, hook_event_name: "PreCompact" }).then((result) => {
      assert.equal(result.accepted, false);
      assert.equal(result.skipped, "unknown-event");
      assert.equal(result.event, null);
      assert.equal(result.fingerprint, null);
      assert.deepEqual(result.results, []);
      assert.equal(box.calls.spawn.length, 0);
      assert.equal(box.calls.fetch.length, 0);
      // 一个不认识的事件不该在任何地方留下痕迹 —— 连这张状态表都不该被建出来。
      assert.equal(existsSync(box.stateFile), false, "unknown event must not create the state file");
    });
  } finally {
    box.dispose();
  }
});

test("a turn under the floor is not worth a notification, and one over it is", async () => {
  const box = harness({ actions: [{ id: "toast", kind: "desktop" }] });
  try {
    await box.emit(CLAUDE_START);
    box.io.clock += (HOOK_POLICY.completedMinSeconds - 5) * 1000;
    const short = await box.emit(CLAUDE_STOP);
    assert.equal(short.accepted, true);
    assert.equal(short.skipped, "too-short");
    assert.deepEqual(short.results, []);
    assert.equal(box.calls.spawn.length, 0);

    box.io.clock += 5 * 1000;
    const long = await box.emit(CLAUDE_STOP);
    assert.equal(long.accepted, true);
    assert.equal(long.skipped, null);
    assert.equal(box.calls.spawn.length, 1, "恰好到下限的那一轮要报出来");
    assert.equal(long.results[0].state, "sent");
  } finally {
    box.dispose();
  }
});

test("the duration is measured between the turn's own start and its end, never invented", async () => {
  const box = harness({
    actions: [{ id: "hook", kind: "webhook", url: "https://hooks.example.invalid/avenic" }],
    respond: async () => ({ ok: true, status: 200 }),
  });
  try {
    await box.emit(CLAUDE_START);
    box.io.clock += 90 * 1000;
    await box.emit(CLAUDE_STOP);
    const sent = JSON.parse(box.calls.fetch[0].options.body);
    assert.equal(sent.durationMs, 90 * 1000);
    assert.equal(sent.event, "turn.completed");
    assert.equal(sent.agent, "claude");
    assert.equal(sent.sessionId, SESSION);
    // 载荷里没有的东西一个都不许出现：这是一条 Avenic 的事件，不是原生载荷。
    assert.equal("transcript_path" in sent, false);
  } finally {
    box.dispose();
  }
});

test("a completion nobody measured is still reported, without a duration", async () => {
  // 没有记录到开始的一轮，时长是 null，而这一条**照样要报**：把一个没量过的数字
  // 拿去和下限比，等于把这一轮悄悄丢掉，用户读到的却是「钩子坏了」。所以报，但
  // 不带那个谁都没量出来的时长。
  const box = harness({
    actions: [
      { id: "hook", kind: "webhook", url: "https://hooks.example.invalid/avenic" },
      { id: "toast", kind: "desktop" },
    ],
  });
  try {
    const result = await box.emit(CLAUDE_STOP);
    assert.equal(result.skipped, null);
    assert.equal(JSON.parse(box.calls.fetch[0].options.body).durationMs, null);
    assert.equal(box.calls.spawn.length, 1, "没有时长不等于没有通知");
    const shown = box.calls.spawn[0].args.join(" ");
    assert.doesNotMatch(shown, /\d+\s*(s|m)\b/, "消息里不该出现一个没人量过的时长");
  } finally {
    box.dispose();
  }
});

test("the same happening twice inside the window is one notification, and two sessions are two", async () => {
  const box = harness({ actions: [{ id: "toast", kind: "desktop" }] });
  try {
    const first = await box.emit(CLAUDE_STOP);
    assert.equal(first.results[0].state, "sent");
    box.io.clock += 10 * 1000;
    const again = await box.emit(CLAUDE_STOP);
    assert.equal(again.accepted, true);
    assert.equal(again.skipped, "deduped");
    assert.deepEqual(again.results, []);
    assert.equal(box.calls.spawn.length, 1, "同一个指纹在窗口内只响一次");

    // 另一个会话在同一分钟内结束，是另一件事：指纹里带着是谁。
    await box.emit({ ...CLAUDE_STOP, session_id: OTHER_SESSION });
    assert.equal(box.calls.spawn.length, 2);

    box.io.clock += (HOOK_POLICY.dedupeSeconds + 1) * 1000;
    const later = await box.emit(CLAUDE_STOP);
    assert.equal(later.results[0].state, "sent", "窗口一过，同一件事又是一件事");
    assert.equal(box.calls.spawn.length, 3);
  } finally {
    box.dispose();
  }
});

test("two turns that end inside one window are two notifications, for the agent that names no turn", async () => {
  // OpenCode 的插件只答得出 `sessionID` —— 没有回合 id。少了这一格，同一个会话里 45 秒内
  // 结束的两轮就是同一个指纹：第二次「做完了」被当成重复悄悄吞掉，而它正是用户刚问完
  // 那句话在等的那一声。这一格答得出来：Avenic 自己记着这一轮的起点 —— 一轮的时长用的
  // 就是它，所以这不是多出来的依赖，是把已经在手上的那个事实填进指纹。
  const box = harness({ actions: [{ id: "toast", kind: "desktop" }] });
  const native = (type, extra = {}) => ({ type, sessionID: "ses_1", directory: "/tmp/not-a-real-project", ...extra });
  const fire = (payload) => box.emit(payload, { agentId: "opencode" });
  try {
    await fire(native("message.updated", { info: { role: "user" } })); // 第一轮开始
    box.io.clock += 25 * 1000;
    const first = await fire(native("session.idle"));
    assert.equal(first.skipped, null, "25 秒的一轮够长了");
    assert.equal(box.calls.spawn.length, 1);

    box.io.clock += 5 * 1000;
    await fire(native("message.updated", { info: { role: "user" } })); // 第二轮开始
    box.io.clock += 25 * 1000;
    const second = await fire(native("session.idle"));
    assert.equal(second.skipped, null, "第二轮是另一件事，不是第一轮的重复");
    assert.equal(box.calls.spawn.length, 2);

    // 同一轮的那声「做完了」被两个钩子报两次，仍然是同一个指纹：只响一次。
    const duplicate = await fire(native("session.idle"));
    assert.equal(duplicate.skipped, "deduped");
    assert.equal(box.calls.spawn.length, 2);
  } finally {
    box.dispose();
  }
});

test("two different asks in one turn are two notifications, not one", async () => {
  // 一次询问和另一次询问之间唯一不同的是它自己那句话（`Notification` 的 message）：同一个
  // 回合里连着问两次「要不要用这个工具」，理由那一栏是一样的（permission_prompt），指纹里
  // 没有这一格，第二次就是「重复」—— 而它要人做的决定完全不同。
  const box = harness({ actions: [{ id: "toast", kind: "desktop" }] });
  const ask = (message) => ({ ...CLAUDE_STOP, hook_event_name: "Notification", notification_type: "permission_prompt", message });
  try {
    const first = await box.emit(ask("Claude needs your permission to use Bash"));
    assert.equal(first.skipped, null);
    assert.equal(box.calls.spawn.length, 1);

    const second = await box.emit(ask("Claude needs your permission to use Edit"));
    assert.equal(second.skipped, null, "第二次询问是另一件事");
    assert.equal(box.calls.spawn.length, 2);

    const again = await box.emit(ask("Claude needs your permission to use Bash"));
    assert.equal(again.skipped, "deduped", "同一句话被两个钩子报两次仍然是同一件事");
    assert.equal(box.calls.spawn.length, 2);

    // 而指纹落在盘上的那一段不是那句话本身：那个文件是身份表，不是转录 —— 一句话里
    // 可能就带着用户在跑的命令。它要的只是「这两句不是同一句」。
    assert.doesNotMatch(box.stateText(), /permission to use (Bash|Edit)/);
  } finally {
    box.dispose();
  }
});

test("a second hook reporting the same turn while the first is still being sent does not ring again", async () => {
  const box = harness({ actions: [{ id: "hook", kind: "webhook", url: "https://hooks.example.invalid/avenic" }] });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const slow = {
    ...box.io,
    async fetch(url, options) {
      box.calls.fetch.push({ url, options });
      await gate;
      return { ok: true, status: 204 };
    },
  };
  try {
    // Claude 的 Stop 可以由不止一个钩子报出来，两个进程前后脚起来是常态。第二个进程
    // 是在第一个还没等到对方回答的时候读那张表的 —— 窗口必须在动作跑起来之前就被
    // 占住，否则「同一件事只响一次」在最常见的那个重复场景里一次都不成立。
    const first = emitHook({ agentId: "claude", payload: CLAUDE_STOP, projectRoot: box.root, environment: box.environment, io: slow });
    while (box.calls.fetch.length === 0) await new Promise((resolve) => setImmediate(resolve));
    const second = await box.emit(CLAUDE_STOP);
    assert.equal(second.accepted, true);
    assert.equal(second.skipped, "deduped", "第一个还在响的时候，第二个不能也响");
    assert.deepEqual(second.results, []);
    release();
    const done = await bounded(first, "第一个 emit 没有回来");
    assert.equal(done.results[0].state, "sent");
  } finally {
    release();
    box.dispose();
  }
});

test("a failed turn and a call for attention are reported at once, with no floor to wait for", async () => {
  const box = harness({ actions: [{ id: "toast", kind: "desktop" }] });
  try {
    await box.emit(CLAUDE_START);
    const failed = await box.emit({ ...CLAUDE_STOP, hook_event_name: "StopFailure", error: "rate_limit" });
    assert.equal(failed.results[0].state, "sent");
    assert.equal(box.calls.spawn.length, 1);
    const shown = box.calls.spawn[0].args.join(" ");
    assert.match(shown, /rate_limit/, "失败的理由要出现在通知里");

    const attention = await box.emit({ ...CLAUDE_STOP, hook_event_name: "Notification", notification_type: "permission_prompt", message: "the agent is waiting" });
    assert.equal(attention.results[0].state, "sent");
    assert.equal(box.calls.spawn.length, 2);
  } finally {
    box.dispose();
  }
});

test("an address that fails to parse does not carry its token out in the failure's words", async () => {
  // 有些地址是配置里手写的，令牌就挂在查询串上。运输方拒绝一个这样的地址时，它说的
  // 那句话里带着整个地址 —— 一条「失败」不该把配置里的凭证转述一遍。
  const box = harness({
    actions: [{ id: "hook", kind: "webhook", url: `http://[fixture/hook?token=${SECRET}` }],
    respond: async (url) => { throw new TypeError(`Failed to parse URL from ${url}`); },
  });
  try {
    const result = await box.emit(CLAUDE_STOP);
    assert.equal(result.results[0].state, "failed");
    assert.equal(JSON.stringify(result).includes(SECRET), false, "失败的那一句话里不该有地址，更不该有地址里的令牌");
    assert.match(result.results[0].detail, /URL|address|failed/i, "但必须有话说：一个没有理由的失败没法排查");
  } finally {
    box.dispose();
  }
});

test("a webhook that refuses is a failed result and not a thrown hook", async () => {
  const box = harness({
    actions: [{ id: "hook", kind: "webhook", url: "https://hooks.example.invalid/avenic" }],
    respond: async () => ({ ok: false, status: 500 }),
  });
  try {
    const refused = await box.emit(CLAUDE_STOP);
    assert.equal(refused.accepted, true, "对方拒了不等于这个事件没被接受");
    assert.equal(refused.results[0].state, "failed");
    assert.match(refused.results[0].detail, /500/);

    // 连不上的那一种也要落在结果里：钩子进程自己崩掉，读到的就是「我的 agent 不动了」。
    const box2 = harness({
      actions: [{ id: "hook", kind: "webhook", url: "https://hooks.example.invalid/avenic" }],
      respond: async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:1"); },
    });
    try {
      const broken = await box2.emit(CLAUDE_STOP);
      assert.equal(broken.results[0].state, "failed");
      assert.match(broken.results[0].detail, /ECONNREFUSED/);
    } finally {
      box2.dispose();
    }
  } finally {
    box.dispose();
  }
});

test("an action that answers slowly has an end, and it is the action's own budget", async () => {
  // 这一段进程跑在 agent 自己的钩子里：它等多久，用户的这一轮就等多久。所以每个动作
  // 都有一个上限，而且这个上限是动作自己的 —— 用户可以把一个慢网关调宽，但没有任何
  // 一条路能让等待没有尽头。
  const box = harness({
    actions: [{ id: "hook", kind: "webhook", url: "https://slow.example.invalid/avenic", timeoutMs: 100 }],
    respond: () => new Promise(() => {}),
  });
  try {
    const startedAt = Date.now();
    const result = await bounded(box.emit(CLAUDE_STOP), "一个永远不回答的地址把这一轮挂住了");
    const waited = Date.now() - startedAt;
    assert.equal(result.accepted, true);
    assert.equal(result.results[0].state, "failed");
    assert.match(result.results[0].detail, /timed out after 100 ms/);
    assert.ok(waited < 1500, `等待该在 100ms 附近结束，实际 ${waited}ms`);
  } finally {
    box.dispose();
  }
});

test("the whole chain has one budget, not one per action", async () => {
  // 每个动作都有自己的上限，于是 N 个动作串起来就是 N 份等待 —— 而这个进程跑在 agent
  // 自己的钩子里（Claude 给钩子的上限是 60 秒）。一条链子要有尽头，尽头就得是这一条
  // 链子共用的：花完之后的动作一次都不发，而且要在答案里说出来，不能悄悄消失。
  const budget = HOOK_POLICY.dispatchBudgetSeconds * 1000;
  const box = harness({
    actions: [
      { id: "first", kind: "webhook", url: "https://first.example.invalid/avenic" },
      { id: "second", kind: "webhook", url: "https://second.example.invalid/avenic" },
    ],
    respond: async () => {
      box.io.clock += budget + 1000;
      return { ok: true, status: 204 };
    },
  });
  try {
    const result = await box.emit(CLAUDE_STOP);
    assert.equal(result.results.length, 2, "预算花完不等于把它从答案里删掉");
    const byId = Object.fromEntries(result.results.map((item) => [item.id, item]));
    assert.equal(byId.first.state, "sent");
    assert.equal(byId.second.state, "skipped");
    assert.match(byId.second.detail, /budget/);
    assert.equal(box.calls.fetch.length, 1, "预算花完之后的动作一次都不发");
  } finally {
    box.dispose();
  }
});

test("no single action can outlast what is left of the budget", async () => {
  const budget = HOOK_POLICY.dispatchBudgetSeconds * 1000;
  const box = harness({
    actions: [
      { id: "first", kind: "webhook", url: "https://first.example.invalid/avenic" },
      { id: "slow", kind: "command", command: "my-notifier", timeoutMs: 30_000 },
    ],
    respond: async () => {
      box.io.clock += budget - 500;
      return { ok: true, status: 204 };
    },
    child: () => fakeChild({ close: false }),
  });
  try {
    const startedAt = Date.now();
    const result = await bounded(box.emit(CLAUDE_STOP), "命令不回答，等待却没有尽头");
    const waited = Date.now() - startedAt;
    const byId = Object.fromEntries(result.results.map((item) => [item.id, item]));
    assert.equal(byId.slow.state, "failed");
    assert.match(byId.slow.detail, /timed out after 500 ms/);
    assert.equal(box.calls.spawn[0].child.killCalls, 1, "到点了要把命令收掉");
    assert.ok(waited < 2000, `等待该在 500ms 附近结束，实际 ${waited}ms`);
  } finally {
    box.dispose();
  }
});

test("the credential reaches the far side in a header, never in the URL, the state file or a printed line", async () => {
  const box = harness({
    actions: [{ id: "hook", kind: "webhook", url: "https://hooks.example.invalid/avenic", token: SECRET }],
  });
  try {
    const result = await box.emit(CLAUDE_STOP);
    const request = box.calls.fetch[0];
    assert.equal(request.url, "https://hooks.example.invalid/avenic", "配置的 URL 原样使用，不追加任何东西");
    assert.equal(new URL(request.url).search, "", "凭据不进查询串，这是硬规矩");
    assert.equal(request.url.includes(SECRET), false);
    assert.match(JSON.stringify(request.options.headers), new RegExp(SECRET), "那就得在头上");
    // 钩子进程打印出去的那点东西，是用户可能要贴进 issue 的东西。
    assert.equal(JSON.stringify(result).includes(SECRET), false);
    // 扫的是 Avenic 写下的每一样东西；用户自己写的那份动作文件当然有那个 token ——
    // 他就是从那里把凭据交给 Avenic 的。
    const own = new Set([hookActionsPath(box.root).toLowerCase()]);
    const files = [...readTree(box.root), ...readTree(box.machine)].filter(([file]) => !own.has(file.toLowerCase()));
    assert.ok(files.length > 0, "没有任何文件被写过，这个扫描证明不了什么");
    for (const [file, content] of files) {
      assert.equal(content.includes(SECRET), false, `${file} 里不该有凭据`);
    }
    assert.equal(box.stateText().includes(SECRET), false);
  } finally {
    box.dispose();
  }
});

test("an emit writes its own state file and nothing else, anywhere", async () => {
  // P65 的行为面：钩子流量不进共享对话，也不在项目里留下任何别的东西。import 图是
  // 结构性证明（这个模块引不到会话机制），这里是行为性证明 —— 一次完整的派发之后，
  // 项目里多出来的文件只有去重窗口和回合开始所在的那一个，机器状态一个字节没变。
  const box = harness({ actions: [{ id: "hook", kind: "webhook", url: "https://hooks.example.invalid/avenic" }] });
  try {
    const before = new Set(readTree(box.root).map(([file]) => file));
    const machineBefore = new Set(readTree(box.machine).map(([file]) => file));
    const result = await box.emit(CLAUDE_STOP);
    assert.equal(result.results[0].state, "sent");
    const added = readTree(box.root).map(([file]) => file).filter((file) => !before.has(file));
    assert.deepEqual(added.map((file) => path.relative(box.root, file)), [path.join(".agents", "local", "hook-state.json")]);
    assert.deepEqual(readTree(box.machine).map(([file]) => file).filter((file) => !machineBefore.has(file)), []);
  } finally {
    box.dispose();
  }
});

test("the state file is written whole, is pruned to the window, and holds no payload dump", async () => {
  const box = harness({ actions: [{ id: "toast", kind: "desktop" }] });
  try {
    await box.emit({ ...CLAUDE_STOP, session_id: SESSION });
    box.io.clock += 5 * 1000;
    await box.emit({ ...CLAUDE_STOP, session_id: OTHER_SESSION });
    const written = box.state();
    const stamps = Object.values(written.dedupe);
    assert.equal(stamps.length, 2);
    assert.deepEqual(stamps, [...stamps].sort((left, right) => left - right), "按时间排好，文件才不会因为插入顺序抖动");
    // 记的是指纹和时刻，不是载荷：transcript 路径、原始 JSON 都不在这里。
    assert.equal(box.stateText().includes("transcript_path"), false);
    assert.equal(box.stateText().includes("not-a-real-transcript"), false);
    assert.doesNotMatch(box.stateText(), /"cwd"/);
    assert.ok(box.stateText().length < 2048, "状态文件是一张小表，不是一份日志");
    // 目录里不能有写了一半的临时文件：写入走的是 core 那一个原子写。
    assert.deepEqual(readdirSync(path.dirname(box.stateFile)).filter((name) => name.includes(".tmp-")), []);

    box.io.clock += (HOOK_POLICY.dedupeSeconds + 1) * 1000;
    await box.emit({ ...CLAUDE_STOP, session_id: "12121212-3434-5656-7878-909090909090" });
    assert.equal(Object.keys(box.state().dedupe).length, 1, "窗口之外的条目要清掉，不然这个文件只长不减");
  } finally {
    box.dispose();
  }
});

test("a command action is a command line: the shell is what gives its words their meaning", async () => {
  // 向导收下的是一条命令行（提示语就是「要跑的命令」，行上只报程序名 —— 参数是用户自己的
  // 东西），而 spawn 默认把整串当成一个程序名：`my-notifier --turn "Build done"` 在那里
  // 是 ENOENT，Windows 上一个 .cmd（npx 装出来的工具全长这样）连启动都做不到（EINVAL）。
  // 「命令行」这三个字由平台自己的 shell 来解释，用户写下的引号与参数才是那个意思。
  const line = 'my-notifier --turn "Build done"';
  const box = harness({ platform: "win32", actions: [{ id: "notify", kind: "command", command: line }] });
  try {
    const result = await box.emit(CLAUDE_STOP);
    assert.equal(result.results[0].state, "sent");
    const spawned = box.calls.spawn[0];
    assert.equal(spawned.command, line, "整条命令行原样交出去");
    assert.deepEqual(spawned.args, [], "参数写在命令行里，不在这里");
    assert.equal(spawned.options.shell, true, "没有 shell，整串就是一个程序名");
  } finally {
    box.dispose();
  }
});

test("a command action with nothing to run says so instead of reporting a delivery", async () => {
  // 手写的文件里可以只有 id 与 kind。空的一条命令行交给 shell，shell 以 0 退出 —— 于是
  // 「已经送出去了」是一句假话，而用户配过的那条通知一条都不会到。webhook 那一栏有同样的
  // 规矩（没有地址就说没有地址），这里说的是同一件事。
  const box = harness({ actions: [{ id: "blank", kind: "command", command: "   " }, { id: "missing", kind: "command" }] });
  try {
    const result = await box.emit(CLAUDE_STOP);
    assert.deepEqual(result.results.map((item) => item.state), ["failed", "failed"]);
    for (const item of result.results) assert.match(item.detail, /no command configured/);
    assert.equal(box.calls.spawn.length, 0, "没有东西可跑，就一个进程都不开");
  } finally {
    box.dispose();
  }
});

test("a command action gets the event on stdin and none of the shell's credentials", async () => {
  const box = harness({ actions: [{ id: "notify", kind: "command", command: 'my-notifier --turn "Build done"' }] });
  try {
    const environment = { ...box.environment, ANTHROPIC_AUTH_TOKEN: SECRET, OPENAI_API_KEY: "sk-test-not-a-real-key-2", GH_TOKEN: "ghp_not-real", KEEP_ME: "yes" };
    const result = await emitHook({ agentId: "claude", payload: CLAUDE_STOP, projectRoot: box.root, environment, io: box.io });
    assert.equal(result.results[0].state, "sent");
    const spawned = box.calls.spawn[0];
    assert.equal(spawned.command, 'my-notifier --turn "Build done"');
    assert.deepEqual(JSON.parse(spawned.child.writes.join("")), {
      agent: "claude",
      event: "turn.completed",
      sessionId: SESSION,
      turnId: "p-0001",
      cwd: "D:/tmp/not-a-real-project",
      reason: null,
      detail: null,
      durationMs: null,
      at: new Date(box.io.clock).toISOString(),
    });
    const passed = spawned.options.env;
    assert.equal(passed.KEEP_ME, "yes", "一般的环境变量要留着，命令才跑得起来");
    assert.equal(passed.PATH, "/usr/bin");
    for (const name of ["ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "GH_TOKEN"]) {
      assert.equal(name in passed, false, `${name} 不该交给一个用户可配的命令`);
    }
  } finally {
    box.dispose();
  }
});

test("a command that will not start is a failed result, not a crash", async () => {
  const box = harness({ actions: [{ id: "notify", kind: "command", command: "no-such-tool" }], child: () => fakeChild({ close: false, fail: Object.assign(new Error("spawn no-such-tool ENOENT"), { code: "ENOENT" }) }) });
  try {
    const result = await box.emit(CLAUDE_STOP);
    assert.equal(result.results[0].state, "failed");
    assert.match(result.results[0].detail, /ENOENT/);
  } finally {
    box.dispose();
  }
});

test("a command that stops reading its input is a failed result, not the end of the emit", async () => {
  // 一个立刻退出的程序（不读 stdin 的命令、一上线就崩的命令）会让管道这头收到 EPIPE。
  // 没人监听的 'error' 在 Node 里是抛出去的异常：这一轮剩下的动作一个都不会跑，而去重
  // 窗口已经认领过这件事了 —— 那一条通知就此消失，且没有任何地方说过它消失过。
  const box = harness({
    actions: [
      { id: "quits", kind: "command", command: "my-notifier --once" },
      { id: "after", kind: "webhook", url: "https://after.example.invalid/avenic" },
    ],
    child: () => fakeChild({ input: "closed" }),
  });
  try {
    const result = await bounded(box.emit(CLAUDE_STOP), "命令关掉输入之后这一轮没回来");
    assert.equal(result.results.length, 2, "前面的动作失败，后面的动作还是要跑");
    const byId = Object.fromEntries(result.results.map((item) => [item.id, item]));
    assert.equal(byId.quits.state, "failed");
    assert.match(byId.quits.detail, /EPIPE/);
    assert.equal(byId.after.state, "sent");
  } finally {
    box.dispose();
  }
});

test("the desktop action is fire-and-forget: the emit never waits for it", async () => {
  const box = harness({ actions: [{ id: "toast", kind: "desktop" }], child: () => fakeChild({ close: false }) });
  try {
    const result = await bounded(box.emit(CLAUDE_STOP), "the emit waited for a desktop process nobody is waiting for");
    assert.equal(result.results[0].state, "sent");
    assert.equal(box.calls.spawn[0].child.unrefCalls, 1, "不 unref 就等于把这个进程挂在这一轮上");
    assert.equal(box.calls.spawn[0].options.detached, true);
    assert.equal(box.calls.spawn[0].options.stdio, "ignore");
  } finally {
    box.dispose();
  }
});

test("each platform gets its own notification, and a quote in the text cannot escape it", async () => {
  const linux = harness({ actions: [{ id: "toast", kind: "desktop" }] });
  const mac = harness({ platform: "darwin", actions: [{ id: "toast", kind: "desktop" }] });
  const windows = harness({ platform: "win32", actions: [{ id: "toast", kind: "desktop" }] });
  const unknown = harness({ platform: "aix", actions: [{ id: "toast", kind: "desktop" }] });
  try {
    await linux.emit(CLAUDE_STOP);
    await mac.emit(CLAUDE_STOP);
    await windows.emit(CLAUDE_STOP);
    const unsupported = await unknown.emit(CLAUDE_STOP);
    assert.equal(linux.calls.spawn[0].command, "notify-send");
    assert.equal(mac.calls.spawn[0].command, "osascript");
    assert.equal(windows.calls.spawn[0].command, "powershell");
    assert.deepEqual(unknown.calls.spawn, [], "没有桌面通知这件事，不是失败，是不做");
    assert.equal(unsupported.results[0].state, "skipped");
    assert.match(unsupported.results[0].detail, /aix/);

    // 事件里的文本会进到别人的解释器里（AppleScript、PowerShell），所以它只能待
    // 在一个字符串字面量里：整个脚本是一个 argv 元素，引号按各自语言的规矩转义。
    const attention = { ...CLAUDE_STOP, hook_event_name: "Notification", notification_type: "idle_prompt", message: 'he said "hi" && exit' };
    const quoted = harness({ platform: "darwin", actions: [{ id: "toast", kind: "desktop" }] });
    const single = harness({ platform: "win32", actions: [{ id: "toast", kind: "desktop" }] });
    try {
      await quoted.emit(attention);
      await single.emit({ ...attention, message: "it's waiting" });
      const apple = quoted.calls.spawn[0];
      assert.deepEqual(apple.args.slice(0, 1), ["-e"], "文本不能变成另一个参数");
      assert.equal(apple.args.length, 2);
      assert.match(apple.args[1], /^display notification /);
      assert.match(apple.args[1], /\\"hi\\"/, "进了 AppleScript 的字符串，引号必须先被转义");
      assert.equal(apple.args[1].includes('"hi"'), false, "没转义的引号会从字面量里跑出来");
      const script = single.calls.spawn[0].args.at(-1);
      assert.ok(single.calls.spawn[0].args.includes("-NoProfile"), "通知不该先去看用户的 profile");
      assert.match(script, /it''s waiting/, "PowerShell 的字符串里单引号要写两遍");
    } finally {
      quoted.dispose();
      single.dispose();
    }
  } finally {
    linux.dispose();
    mac.dispose();
    windows.dispose();
    unknown.dispose();
  }
});

test("the openclaw preset posts to the local gateway with a hook token of its own", async () => {
  const box = harness({ actions: [{ id: "claw", kind: "openclaw", token: SECRET }] });
  try {
    await box.emit(CLAUDE_STOP);
    const request = box.calls.fetch[0];
    assert.equal(request.url.startsWith("http://127.0.0.1:18789/"), true, request.url);
    assert.equal(request.url.includes(SECRET), false);
    assert.match(JSON.stringify(request.options.headers), new RegExp(`Bearer ${SECRET}`));

    // 没有 token 就不发：一个不带的请求打到别人的网关上，只是把失败推给下一次。
    const untokened = harness({ actions: [{ id: "claw", kind: "openclaw" }] });
    try {
      const result = await untokened.emit(CLAUDE_STOP);
      assert.equal(result.results[0].state, "skipped");
      assert.deepEqual(untokened.calls.fetch, []);
    } finally {
      untokened.dispose();
    }
  } finally {
    box.dispose();
  }
});

test("hook traffic never enters the shared conversation: this module imports no session machinery", () => {
  const source = readFileSync(new URL("../packages/core/src/runtime/hook-actions.mjs", import.meta.url), "utf8");
  const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(specifiers.length > 0, "一条 import 都没读到，这个扫描证明不了什么");
  for (const specifier of specifiers) {
    assert.doesNotMatch(specifier, /sessions|canonical|transcript|projection|cursors|handoff|adapters/i, `${specifier} 会把钩子流量接到会话那条路上`);
  }
  // 状态文件的每一次写入都走 core 那一个原子写（atomic-write.test.mjs 验的是它本身）。
  assert.ok(specifiers.includes("./atomic-file.mjs"), "状态文件必须由原子写落地");
  // 这一条路径也不在会话树里：钩子流量和会话模型是两个系统。
  assert.equal(hookActionsPath("D:/tmp/not-a-real-project").includes(path.join(".agents", "sessions")), false);
});

test("the fingerprint of a deduped event is the vocabulary's own, not a second spelling", async () => {
  const box = harness({ actions: [{ id: "toast", kind: "desktop" }] });
  try {
    const result = await box.emit(CLAUDE_STOP);
    assert.equal(result.fingerprint, hookFingerprint(normalizeHook("claude", CLAUDE_STOP)));
    assert.equal(Object.keys(box.state().dedupe).includes(result.fingerprint), true);
  } finally {
    box.dispose();
  }
});
