import assert from "node:assert/strict";
import test from "node:test";
import { reconcileOutcome, type ReconcileSeen, type ReconcileStamp } from "../src/dashboard/reconcile.ts";

// 面板跟着项目走，但走的速度分两档：一场会话长长了要重列（列表上多一行、换时间、
// 换了当前会话、多说了话），一次启动的开始与结束只动状态那一行——后者重画整页，正在
// 读的人会看见自己那一页跳一下。这条规矩以前长在 activation 的闭包里，只有把扩展真正
// 跑起来才验证得到；它本身是一道纯判断，就该在这儿被一条一条钉住。

const runsKey = (runs: Record<string, string>) => JSON.stringify(runs);

function seen(overrides: Partial<ReconcileSeen> = {}): ReconcileSeen {
  return { count: 3, active: null, revision: 0, launches: runsKey({ claude: "idle" }), ...overrides };
}

function stamp(overrides: Partial<ReconcileStamp> = {}): ReconcileStamp {
  return { count: 3, active: null, revision: 0, runsKey: runsKey({ claude: "idle" }), ...overrides };
}

test("a session list that moved redraws the page", () => {
  const state = seen();
  const outcome = reconcileOutcome(state, stamp({ count: 4 }));

  assert.equal(outcome.panel, "refresh");
  assert.equal(outcome.runsMoved, false, "只是多了一场会话，启动状态没有变");
});

test("a session that became the active one counts as the list moving", () => {
  const state = seen();
  const outcome = reconcileOutcome(state, stamp({ active: "claude-abc" }));

  assert.equal(outcome.panel, "refresh");
});

test("only a launch changing moves the pills and redraws nothing", () => {
  const state = seen();
  const outcome = reconcileOutcome(state, stamp({ runsKey: runsKey({ claude: "running" }) }));

  assert.equal(outcome.panel, "status");
  assert.equal(outcome.runsMoved, true, "启动状态变了，agent 卡片那边也要重新问一次");
});

test("a page that is being redrawn is not also handed a status push", () => {
  const state = seen();
  const outcome = reconcileOutcome(state, stamp({ count: 9, active: "claude-abc", runsKey: runsKey({ claude: "running" }) }));

  assert.equal(outcome.panel, "refresh", "两件事一起变的时候，一次重画说清楚两件，别一次重画又一次改胶囊");
  assert.equal(outcome.runsMoved, true);
});

test("a stamp that says nothing new does nothing at all", () => {
  const state = seen();
  const outcome = reconcileOutcome(state, stamp());

  assert.equal(outcome.panel, "none");
  assert.equal(outcome.runsMoved, false);
});

test("it remembers what it has answered, so the same stamp does not move the page twice", () => {
  const state = seen();
  const moved = stamp({ runsKey: runsKey({ claude: "running" }) });
  assert.equal(reconcileOutcome(state, moved).panel, "status");
  assert.equal(reconcileOutcome(state, moved).panel, "none", "同一份 stamp 说第二遍不再动面板");
  assert.equal(state.launches, moved.runsKey, "看到过的那一份记在 seen 上");
});

// 会长的不只有列表：一场已经列出来的会话又多了几行。count 不动、active 不动、启停也
// 不动，而用户正读着那一页。增长是写的人加在 stamp 上的那一格数字，这里读到它动过就
// 要重读这一页——页面自己会把新行接上（appendNewTurns），位置不丢。
test("a conversation that grew redraws the page it is being read on", () => {
  const state = seen({ revision: 7 });
  const outcome = reconcileOutcome(state, stamp({ revision: 9 }));

  assert.equal(outcome.panel, "refresh", "增长不走 refresh，页面就没有机会把新行接上去");
  assert.equal(outcome.runsMoved, false, "只是说了更多话，启动状态没有变");
  assert.equal(state.revision, 9, "看到过的那一份记在 seen 上");
});

test("growth said twice does not move the page twice", () => {
  const state = seen({ revision: 9 });
  assert.equal(reconcileOutcome(state, stamp({ revision: 9 })).panel, "none");
});
