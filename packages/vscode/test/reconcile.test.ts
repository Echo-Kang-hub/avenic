import assert from "node:assert/strict";
import test from "node:test";
import { reconcileOutcome, type ReconcileSeen } from "../src/dashboard/reconcile.ts";

// 面板跟着项目走，但走的速度分两档：一场会话长长了要重列（列表上多一行、换时间、
// 换了当前会话），一次启动的开始与结束只动状态那一行——后者重画整页，正在读的人
// 会看见自己那一页跳一下。这条规矩以前长在 activation 的闭包里，只有把扩展真正
// 跑起来才验证得到；它本身是一道纯判断，就该在这儿被一条一条钉住。

const runsKey = (runs: Record<string, string>) => JSON.stringify(runs);

function seen(overrides: Partial<ReconcileSeen> = {}): ReconcileSeen {
  return { count: 3, active: null, launches: runsKey({ claude: "idle" }), ...overrides };
}

test("a session list that moved redraws the page", () => {
  const state = seen();
  const outcome = reconcileOutcome(state, { count: 4, active: null, runsKey: runsKey({ claude: "idle" }) });

  assert.equal(outcome.panel, "refresh");
  assert.equal(outcome.runsMoved, false, "只是多了一场会话，启动状态没有变");
});

test("a session that became the active one counts as the list moving", () => {
  const state = seen();
  const outcome = reconcileOutcome(state, { count: 3, active: "claude-abc", runsKey: state.launches });

  assert.equal(outcome.panel, "refresh");
});

test("only a launch changing moves the pills and redraws nothing", () => {
  const state = seen();
  const outcome = reconcileOutcome(state, { count: 3, active: null, runsKey: runsKey({ claude: "running" }) });

  assert.equal(outcome.panel, "status");
  assert.equal(outcome.runsMoved, true, "启动状态变了，agent 卡片那边也要重新问一次");
});

test("a page that is being redrawn is not also handed a status push", () => {
  const state = seen();
  const outcome = reconcileOutcome(state, { count: 9, active: "claude-abc", runsKey: runsKey({ claude: "running" }) });

  assert.equal(outcome.panel, "refresh", "两件事一起变的时候，一次重画说清楚两件，别一次重画又一次改胶囊");
  assert.equal(outcome.runsMoved, true);
});

test("a stamp that says nothing new does nothing at all", () => {
  const state = seen();
  const outcome = reconcileOutcome(state, { count: 3, active: null, runsKey: state.launches });

  assert.equal(outcome.panel, "none");
  assert.equal(outcome.runsMoved, false);
});

test("it remembers what it has answered, so the same stamp does not move the page twice", () => {
  const state = seen();
  const stamp = { count: 3, active: null, runsKey: runsKey({ claude: "running" }) };
  assert.equal(reconcileOutcome(state, stamp).panel, "status");
  assert.equal(reconcileOutcome(state, stamp).panel, "none", "同一份 stamp 说第二遍不再动面板");
  assert.equal(state.launches, stamp.runsKey, "看到过的那一份记在 seen 上");
});
