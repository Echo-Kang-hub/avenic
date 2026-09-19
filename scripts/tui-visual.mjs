// 终端视觉工件：把每个界面渲染一遍，写到 test/fixtures/tui/*.ansi（金样本），
// 或者在真终端里跑一次把屏幕抄下来（--pty，P17 的「真实截图验收」）。
//
//   node scripts/tui-visual.mjs --check              # 对照金样本，有差异就失败
//   node scripts/tui-visual.mjs --update             # 重写金样本（改动过视觉才用）
//   node scripts/tui-visual.mjs --pty --out dist/tui-captures/<stamp>
//   node scripts/tui-visual.mjs --list
//
// 金样本是规范化文本：颜色写成 {brand}/{muted}/… 这样的名字，光标控制的
// {save}{repaint} 也是名字，所以它在 Windows 与 Linux 上完全一致，读起来就是
// 一屏排版。真终端的捕获带真实控制序列，只做验收留档，不进金样本。
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { renderAll } from "../test/helpers/tui-scenarios.mjs";
import { capturePty, stripControl } from "../test/helpers/pty-capture.mjs";

const here = path.dirname(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname));
const goldenDir = path.join(process.cwd(), "test", "fixtures", "tui");

const options = { update: false, check: false, pty: false, list: false, out: null, only: [] };
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 1) {
  const flag = argv[index];
  if (flag === "--update") options.update = true;
  else if (flag === "--pty") options.pty = true;
  else if (flag === "--list") options.list = true;
  else if (flag === "--out") options.out = argv[++index];
  else if (flag === "--only") options.only.push(argv[++index]);
  else options.check = true;
}
if (!options.update && !options.pty && !options.list) options.check = true;

async function goldenFiles() {
  try {
    return (await readdir(goldenDir)).filter((name) => name.endsWith(".ansi")).sort();
  } catch {
    return [];
  }
}

async function check(fixtures) {
  const failures = [];
  for (const [name, text] of fixtures) {
    const file = path.join(goldenDir, `${name}.ansi`);
    let expected;
    try {
      expected = await readFile(file, "utf8");
    } catch {
      failures.push(`${name}: no golden (run: node scripts/tui-visual.mjs --update)`);
      continue;
    }
    if (expected !== text) failures.push(`${name}: golden differs`);
  }
  const known = new Set([...fixtures.keys()].map((name) => `${name}.ansi`));
  for (const name of await goldenFiles()) {
    if (!known.has(name)) failures.push(`${name}: stale golden (no such scenario)`);
  }
  if (failures.length > 0) {
    process.stderr.write(`TUI goldens do not match:\n${failures.map((line) => `  - ${line}`).join("\n")}\n`);
    process.stderr.write(`Re-render with: node scripts/tui-visual.mjs --update\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`TUI goldens match (${fixtures.size} scenarios).\n`);
}

async function update(fixtures) {
  await mkdir(goldenDir, { recursive: true });
  const written = [];
  for (const [name, text] of fixtures) {
    await writeFile(path.join(goldenDir, `${name}.ansi`), text);
    written.push(`${name}.ansi`);
  }
  for (const name of await goldenFiles()) {
    if (!written.includes(name)) await rm(path.join(goldenDir, name));
  }
  process.stdout.write(`Wrote ${written.length} goldens to ${path.relative(process.cwd(), goldenDir)}.\n`);
}

/**
 * 真终端验收（P17）：把每个界面在真终端里跑一次，屏幕原样留档。
 *
 * 交互界面（init / change / sessions / skills）跑到第一帧就停：它们本来就
 * 在等人按键，等到超时被结束，屏幕就是我们要的那张。这些截图只写到
 * dist/（不入库），里面可能含真实会话信息，永远不进 fixtures。
 */
async function ptyCaptures(outDir) {
  await mkdir(outDir, { recursive: true });
  const scratch = path.join(outDir, "scratch");
  await mkdir(scratch, { recursive: true });
  const cli = path.join(process.cwd(), "packages", "cli", "scripts", "skills.mjs");
  const captures = [
    { name: "status", args: ["status"], where: "project" },
    { name: "version", args: ["--version"], where: "project" },
    { name: "init", args: ["init"], where: "scratch", interactive: true },
    { name: "change", args: ["change"], where: "scratch", interactive: true },
    { name: "sessions", args: ["sessions"], where: "project", interactive: true },
    { name: "skills", args: ["skills"], where: "project", interactive: true },
    { name: "sessions-list", args: ["sessions", "list"], where: "project" },
  ];
  const summary = [];
  const report = [];
  for (const capture of captures) {
    const result = capturePty(process.execPath, [cli, ...capture.args], {
      cwd: capture.where === "scratch" ? scratch : process.cwd(),
      columns: 100,
      rows: 40,
      timeoutMs: capture.interactive ? 8_000 : 60_000,
    });
    // A menu that waits for a key is a screen, not a failure: what matters is
    // that it painted, and that it is the frame we asked for.
    const painted = result.output.length > 0 && (result.status === "ok" || (capture.interactive && result.status === "timeout"));
    report.push({ name: capture.name, status: result.status, exitCode: result.exitCode, bytes: result.output.length, columns: 100, rows: 40, painted });
    if (!painted) {
      summary.push(`${capture.name}: ${result.status}${result.detail ? ` (${result.detail})` : ""}`);
      continue;
    }
    await writeFile(path.join(outDir, `${capture.name}.ansi`), result.output);
    await writeFile(path.join(outDir, `${capture.name}.txt`), stripControl(result.output));
    summary.push(`${capture.name}: ${result.output.length} bytes${result.status === "timeout" ? " (held at the first frame)" : ""}`);
  }
  await writeFile(path.join(outDir, "captures.json"), `${JSON.stringify({
    at: new Date().toISOString(),
    platform: process.platform,
    captures: report,
  }, null, 2)}\n`);
  process.stdout.write(`PTY captures (${summary.join(", ")}) → ${path.relative(process.cwd(), outDir)}\n`);
  if (report.some((entry) => !entry.painted)) process.exitCode = 1;
}

const fixtures = await renderAll(options.only);
if (options.list) {
  for (const name of fixtures.keys()) process.stdout.write(`${name}\n`);
} else {
  if (options.update) await update(fixtures);
  if (options.check) await check(fixtures);
  if (options.pty) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    await ptyCaptures(options.out ?? path.join("dist", "tui-captures", stamp));
  }
}
void here;
