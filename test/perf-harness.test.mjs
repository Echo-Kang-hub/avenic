import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const script = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "perf", "tui-render.mjs");

// 这个基准驱动的是产品今天的提示层：向导重排（比如删掉 provider 文本步骤）之后它必须
// 还能按键、还能成帧。没有这道闸时，脚本会静默地死在第一个不再存在的步骤上——性能数字
// 停在上一轮的样子，而没人会注意到。
test("the TUI render benchmark still drives the prompts the product has today", async () => {
  const { stdout } = await run(process.execPath, [script, "--runs", "3", "--json"], { maxBuffer: 1 << 20 });
  const { report } = JSON.parse(stdout);
  assert.ok(report.length >= 10, `基准场景只剩 ${report.length} 个`);
  for (const row of report) {
    assert.ok(row.runs >= 3, `${row.scenario} 只跑了 ${row.runs} 次`);
    // 短跑里 p95 只是最大的那个样本，判定由中位数做（"PASS (median)"，见 harness.mjs）。
    assert.match(row.verdict, /^PASS/, `${row.scenario} 中位 ${row.median}ms（预算 ${row.budgetMs}ms）`);
  }
  const names = report.map((row) => row.scenario);
  assert.ok(names.includes("wizard: advance step"), `向导的重按键不在场景里：${names.join(" · ")}`);
  assert.ok(names.includes("text prompt: keystroke"), `文本步骤的逐字重画不在场景里：${names.join(" · ")}`);
});
