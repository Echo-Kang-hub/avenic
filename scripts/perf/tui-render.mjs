// TUI 渲染基准：品牌层与提示帧的真实成帧成本，逐项对照预算。
//
// 量的是「从按键到下一帧画出来」的时间：键写入假 TTY，prompt 在同一个事件里
// 更新状态并重画，所以这段时间就是用户感觉到的卡顿上限。预算 16ms 一帧（60Hz）。
// Logo 的目标更严：静态常量 + 一次 write，中位应当远低于 1ms，5ms 是硬上限。
//
//   node scripts/perf/tui-render.mjs [--runs 200] [--json]
//
// 与 launch-overhead.mjs 一样，必须在空闲机器上量：并行测试或构建会把中位数
// 变成机器的中位数，而不是渲染的中位数。
import { performance } from "node:perf_hooks";
import process from "node:process";
import { PassThrough } from "node:stream";
import { fullLogo, compactBrand } from "../../packages/cli/src/cli/brand.mjs";
import { multiSelect, singleSelect } from "../../packages/cli/src/cli/prompts.mjs";
import { percentile } from "./fixture.mjs";

const KEY_BUDGET = 16; // 一帧的时间：按键 → 重绘
const LOGO_BUDGET = 5; // 大字标：静态常量 + 一次 write

const options = new URLSearchParams();
for (let index = 2; index < process.argv.length; index += 1) {
  const [name, value] = process.argv[index].replace(/^--/, "").split("=");
  if (value === undefined && /^\d+$/.test(process.argv[index + 1] ?? "")) {
    options.set(name, process.argv[index + 1]);
    index += 1;
  } else {
    options.set(name, value ?? "1");
  }
}
const runs = Number(options.get("runs") ?? 200);
const asJson = options.has("json");

class FakeTTY extends PassThrough {
  constructor() {
    super();
    this.isTTY = true;
  }
  setRawMode() {}
}

/** 一个假 stdout：记下每一次写入的时刻，成帧成本就是最后一次写入的时刻。 */
function newSink(columns = 100) {
  const sink = {
    isTTY: true,
    columns,
    writes: 0,
    lastAt: 0,
    write() {
      this.writes += 1;
      this.lastAt = performance.now();
      return true;
    },
  };
  return sink;
}

const sleep = () => new Promise((resolve) => setImmediate(resolve));

/**
 * 按一个键，等这一帧画完：返回按键时刻到最近一次写入的毫秒数。
 * keypress 走的是流事件，不占用定时器（Windows 定时器粒度 ~15ms，会把 16ms
 * 的预算量成噪音），所以这里只在 nextTick/immediate 上自旋。
 */
async function press(stdin, sink, key) {
  const startedAt = performance.now();
  const before = sink.writes;
  stdin.write(key);
  for (let turn = 0; turn < 200 && sink.writes === before; turn += 1) {
    await sleep();
  }
  if (sink.writes === before) throw new Error(`no frame was painted after ${JSON.stringify(key)}`);
  return sink.lastAt - startedAt;
}

function scenario(name, budget) {
  return { name, budget, samples: [] };
}

const list = (count, prefix = "Skill") => Array.from({ length: count }, (_, index) => ({
  value: `${prefix.toLowerCase()}-${index}`,
  label: `${prefix} ${String(index).padStart(3, "0")}`,
  hint: `${index} files`,
}));

async function measureLogo(entry) {
  for (let run = 0; run < runs; run += 1) {
    const sink = newSink();
    const startedAt = performance.now();
    await fullLogo(sink, { color: true, environment: { FORCE_COLOR: "1" } });
    entry.samples.push(performance.now() - startedAt);
  }
}

function measureCompact(entry) {
  for (let run = 0; run < runs; run += 1) {
    const sink = newSink();
    const startedAt = performance.now();
    compactBrand(sink, { title: "Status", description: "/a/project/root/that/is/long/enough/to/truncate", environment: { NO_COLOR: "1" } });
    entry.samples.push(performance.now() - startedAt);
  }
}

/**
 * 一轮交互：首帧 → 移动 → 切换 → 搜索 → 确认（摘要）→ 分节过渡。
 * 每次都用新的假 TTY，样本之间不共享状态；色板走 16 色，和终端无关。
 */
async function measureFrames(stats) {
  const entries = list(60);
  for (let run = 0; run < runs; run += 1) {
    const stdin = new FakeTTY();
    const sink = newSink();
    const common = { stdin, stdout: sink, color: false, environment: {} };

    let startedAt = performance.now();
    const picking = singleSelect({
      ...common,
      title: "Set active session",
      options: entries,
    });
    stats.firstFrame.samples.push(performance.now() - startedAt);

    stats.move.samples.push(await press(stdin, sink, "\x1b[B"));

    // 确认：落定帧 + 摘要行在同一帧里画完。
    startedAt = performance.now();
    stdin.write("\r");
    await picking;
    const settledAt = performance.now();
    stats.settle.samples.push(settledAt - startedAt);

    // 分节过渡：从「按下确认」到下一页首行画出来（落定 + 下一帧首帧）。
    const next = singleSelect({ ...common, title: "Scope", options: entries.slice(0, 4) });
    stats.transition.samples.push(performance.now() - startedAt);
    stdin.write("\x1b");
    await next;
  }
}

/** 多选列表：空格切换与输入过滤（200 条里过滤，量的是过滤+重画，不是列表长度）。 */
async function measureMulti(stats) {
  const entries = list(200, "Pack");
  for (let run = 0; run < runs; run += 1) {
    const stdin = new FakeTTY();
    const sink = newSink();
    const picking = multiSelect({
      stdin,
      stdout: sink,
      color: false,
      environment: {},
      title: "Select Packs",
      searchable: true,
      options: entries,
    });
    stats.toggle.samples.push(await press(stdin, sink, " "));
    stats.filter.samples.push(await press(stdin, sink, "1"));
    stats.erase.samples.push(await press(stdin, sink, "\x7f"));
    stdin.write("\x1b");
    await picking;
  }
}

async function main() {
  const scenarios = [
    scenario("logo (12 rows)", LOGO_BUDGET),
    scenario("compact brand", LOGO_BUDGET),
    scenario("first frame (60 rows)", KEY_BUDGET),
    scenario("move cursor", KEY_BUDGET),
    scenario("settle + summary", KEY_BUDGET),
    scenario("section transition", KEY_BUDGET),
    scenario("toggle selection", KEY_BUDGET),
    scenario("search (200 rows)", KEY_BUDGET),
    scenario("erase", KEY_BUDGET),
  ];
  const [logo, compact, ...frames] = scenarios;

  await measureLogo(logo);
  measureCompact(compact);
  await measureFrames({
    firstFrame: frames[0], move: frames[1], settle: frames[2], transition: frames[3],
  });
  await measureMulti({ toggle: frames[4], filter: frames[5], erase: frames[6] });

  const report = scenarios.map(({ name, budget, samples }) => {
    const median = percentile(samples, 0.5);
    const p95 = percentile(samples, 0.95);
    return {
      scenario: name,
      runs: samples.length,
      median: Number(median.toFixed(3)),
      p95: Number(p95.toFixed(3)),
      max: Number(Math.max(...samples).toFixed(3)),
      budgetMs: budget,
      verdict: median <= budget && p95 <= budget ? "PASS" : "FAIL",
    };
  });

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ keyBudgetMs: KEY_BUDGET, logoBudgetMs: LOGO_BUDGET, report }, null, 2)}\n`);
  } else {
    process.stdout.write(`TUI render: ${runs} runs per scenario, budget ${KEY_BUDGET}ms per frame (logo ${LOGO_BUDGET}ms)\n\n`);
    process.stdout.write(`${"scenario".padEnd(24)}${"median".padStart(10)}${"p95".padStart(10)}${"max".padStart(10)}  verdict\n`);
    for (const row of report) {
      process.stdout.write(
        `${row.scenario.padEnd(24)}${`${row.median}ms`.padStart(10)}${`${row.p95}ms`.padStart(10)}${`${row.max}ms`.padStart(10)}  ${row.verdict}\n`,
      );
    }
  }

  const failed = report.filter((row) => row.verdict === "FAIL");
  if (failed.length > 0) {
    process.stdout.write(`\nFAIL: ${failed.map((row) => `${row.scenario} median ${row.median}ms`).join(", ")}\n`);
    process.exitCode = 1;
  }
}

await main();
