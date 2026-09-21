import assert from "node:assert/strict";
import test from "node:test";
import { ActivityLog } from "../src/ui/activity.ts";

// 「最近发生了什么」是插件自己唯一拥有的数据：项目状态从 core 读，而「你刚刚点了
// 什么、它成没成」只有宿主知道。它是内存里的一圈记录，不是第二份状态存储。

test("the newest action is first and the oldest falls off the end", () => {
  const log = new ActivityLog({ limit: 3 });
  for (const text of ["one", "two", "three", "four"]) log.record(text);
  assert.deepEqual(log.rows().map((row) => row.text), ["four", "three", "two"], "越界的记录被丢掉，顺序是新的在前");
});

test("every row carries the clock time it happened at", () => {
  const at = new Date(2026, 8, 20, 20, 47, 12);
  const log = new ActivityLog({ now: () => at });
  log.record("Project configuration loaded");
  assert.equal(log.rows()[0].time, "20:47:12");
});

test("rows are readable as the dashboard's activity model", () => {
  const log = new ActivityLog({ now: () => new Date(2026, 8, 20, 18, 32, 11) });
  log.record('Skill "code-reviewer" imported', "green");
  assert.deepEqual(log.rows(), [{ time: "18:32:11", text: 'Skill "code-reviewer" imported', tone: "green" }]);
});

test("the same moment is written to the log channel, so the panel can be explained", () => {
  const lines: string[] = [];
  const log = new ActivityLog({ sink: { appendLine: (line) => lines.push(line) }, now: () => new Date(2026, 8, 20, 20, 47, 12) });
  log.record("Claude session started");
  assert.deepEqual(lines, ["20:47:12 Claude session started"]);
});

test("disposing the log closes the channel it was writing to", () => {
  let closed = 0;
  const log = new ActivityLog({ sink: { appendLine: () => {}, dispose: () => { closed += 1; } } });
  log.dispose();
  assert.equal(closed, 1, "输出通道随插件一起关闭，不留在窗口上");
});

test("disposing twice closes the channel once", () => {
  let closed = 0;
  const log = new ActivityLog({ sink: { appendLine: () => {}, dispose: () => { closed += 1; } } });
  log.dispose();
  log.dispose();
  assert.equal(closed, 1);
});

test("a sink with nothing to close is disposed without complaint", () => {
  const log = new ActivityLog({ sink: { appendLine: () => {} } });
  log.dispose();
  log.record("Claude session started");
  assert.equal(log.rows().length, 1, "没有通道也照常记录");
});
