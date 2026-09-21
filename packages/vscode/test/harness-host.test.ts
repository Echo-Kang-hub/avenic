import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.resolve(pkgDir, "..", "..");

// Imported by URL rather than statically: both are entry scripts, and an import
// that inlined one would run its body (each guards its run by comparing
// import.meta.url with argv[1], which bundling rewrites to this test file). The
// decisions below are the ones that were prose-only, so they are asserted here
// where they cost nothing to run — no editor, no window, no desktop.
const host = (await import(pathToFileURL(path.join(pkgDir, "test", "host", "run.mjs")).href)) as {
  verdict: (run: unknown) => { pass: boolean; reasons: string[] };
  wbWait: (find: () => Promise<unknown>, tries: number, gap: number) => Promise<unknown>;
  clickAllowed: (label: string) => boolean;
  ownershipScan: (text: string, tag: string) => { points: number; step: number; strangers: { x: number; y: number; pid: number; window: string }[] };
  windowEnvironment: () => Record<string, string | undefined>;
  AGENT_HOME: string;
};
const artifacts = (await import(pathToFileURL(path.join(repo, "scripts", "verify-artifacts.mjs")).href)) as {
  installVerdict: (attempt: unknown) => { status: string; detail: string };
};

const SKILLS = { label: "Skills", changed: true, mutations: 2 };
const SESSION = { sessionsActive: true, turns: 4 };
// 三段的矩形都在，才有「没有重叠」这句话可说：status 是状态块的矩形，rects 里是标题与
// 路径的矩形——重叠检查正是拿这三个互相量的。
const HEADER = {
  status: { left: 614, right: 759, top: 10, bottom: 39 },
  rects: { title: { left: 226, right: 600 }, path: { left: 226, right: 600 } },
  overlaps: [] as string[],
};
const SCREEN = { name: "01-dashboard-open.png", occluded: false, surface: false };
const SURFACE = { name: "01-dashboard-open.window.png", surface: true, captured: true };

// The footer line the run reads off the page, and the line the shim was proved
// to answer: a run that got everything else right but painted "Avenic" with no
// version has not shown that the panel named this repo's CLI.
const FOOTER = { text: "Avenic v1.8.4", expected: "Avenic v1.8.4" };

const run = (over: Record<string, unknown> = {}) =>
  host.verdict({ steps: [SKILLS], row: SESSION, header: HEADER, shots: [SCREEN, SURFACE], errors: [], footer: FOOTER, ...over });

// The report used to record all of this and exit 0, so a run that clicked
// nothing and opened nothing was as green as one that worked.
test("a run where every click landed and the session opened passes", () => {
  assert.deepEqual(run(), { pass: true, reasons: [] });
});

// A window that has painted its workbench is not yet a window whose extension host
// has loaded anything. Two runs looked for the activity bar container and then for
// the launcher's first row a fixed 2.5s after the click, and threw on the miss —
// each miss was only "not yet", and the run was red for a window that was still
// starting. Extracted as a decision so the difference is pinned: an answer of "no"
// is asked again, and giving up takes the whole bounded wait.
test("a question asked before the window was ready is asked again, not answered 'no'", async () => {
  let calls = 0;
  const hit = await host.wbWait(async () => (++calls === 3 ? { x: 24, y: 299 } : null), 5, 1);
  assert.deepEqual(hit, { x: 24, y: 299 });
  assert.equal(calls, 3);
});

test("a thing that never arrives ends as a miss after the bounded wait", async () => {
  let calls = 0;
  const hit = await host.wbWait(async () => { calls++; return null; }, 4, 1);
  assert.equal(hit, null);
  assert.equal(calls, 4);
});

test("a click that left the page unchanged fails the run", () => {
  const result = run({ steps: [{ label: "Skills", changed: false, mutations: 1 }] });
  assert.equal(result.pass, false);
  assert.match(result.reasons.join("\n"), /Skills/);
});

// Refresh 的活儿是重新读一遍同一个项目：项目没变时，它正确的样子就是再画一遍同一段
// 字。用「字变了没有」判它，会把一次成功的重读判成失败——它该被问的是「面板动了吗」。
test("a refresh that repainted the same words still counts as the panel reacting", () => {
  const result = run({ steps: [{ label: "Refresh", changed: false, mutations: 1, expectText: false }] });
  assert.deepEqual(result, { pass: true, reasons: [] });
});

test("a refresh that repainted nothing at all still fails", () => {
  const result = run({ steps: [{ label: "Refresh", changed: false, mutations: 0, expectText: false }] });
  assert.equal(result.pass, false);
  assert.match(result.reasons.join("\n"), /mutation/i);
});

test("a click that caused no DOM mutation fails the run even if the text differs", () => {
  const result = run({ steps: [{ label: "Refresh", changed: true, mutations: 0 }] });
  assert.equal(result.pass, false);
  assert.match(result.reasons.join("\n"), /mutation/i);
});

test("a session row that was never found fails the run", () => {
  const result = run({ row: null });
  assert.equal(result.pass, false);
  assert.match(result.reasons.join("\n"), /session row/);
});

// 头部的三段（标题、路径、状态块）在参考图里各就各位；窗口窄下来之后，长路径会把
// 状态块压过去，两行字叠在一起。这一条是那一场的检查：叠了就算失败，
// 而不是等人去看截图时才发现。
test("a project path painted over the status block fails the run", () => {
  const result = run({ header: { ...HEADER, overlaps: [".proj-path"] } });
  assert.equal(result.pass, false);
  assert.match(result.reasons.join("\n"), /proj-path/);
});

test("a header whose three parts each stay in their own column passes", () => {
  assert.deepEqual(run({ header: { ...HEADER } }), { pass: true, reasons: [] });
});

// 没有这次测量与「没有重叠」不是一回事：量不到的时候不能算通过。
test("a run that never measured the header fails", () => {
  const result = run({ header: null });
  assert.equal(result.pass, false);
  assert.match(result.reasons.join("\n"), /header/i);
});

// 量不到的另外两种形状，都是「检查的对象不见了，于是检查没有话可说」：状态块没在页面上
// （status 为 null，重叠循环一次都没跑），或者标题/路径的选择器一个也没匹配上（循环跑
// 了，但比较的那几个节点不在）。两种都会让 overlaps 是空数组——那是「没量过」，不是
// 「没有重叠」。
test("a header whose status block is missing fails instead of passing unmeasured", () => {
  const result = run({ header: { ...HEADER, status: null } });
  assert.equal(result.pass, false);
  assert.match(result.reasons.join("\n"), /status/i);
});

test("a header whose title or path is missing is a check that could not run", () => {
  const result = run({ header: { ...HEADER, rects: { title: null, path: HEADER.rects.path } } });
  assert.equal(result.pass, false);
  assert.match(result.reasons.join("\n"), /title or path/i);
});

// The row click has to open the conversation: a title that only repaints would
// satisfy "the body text changed" while showing the list it was already showing.
test("a session click that did not leave Sessions active with a transcript fails", () => {
  const result = run({ row: { sessionsActive: false, turns: 0 } });
  assert.equal(result.pass, false);
  assert.match(result.reasons.join("\n"), /Sessions/);
  assert.match(result.reasons.join("\n"), /transcript/);
});

// 启动或继续一个 agent 是用户自己的动作，不是这个 harness 的——隔离 profile 也不是
// 借口。步骤表里将来多出一条 "Continue"，要在点下去之前被拒绝，而不是某天悄悄把一个
// agent 跑起来。
test("a click that would start an agent is refused, whatever the step list says", () => {
  for (const label of ["Continue", "continue with Claude", "  Launch", "Resume session"]) {
    assert.equal(host.clickAllowed(label), false, label);
  }
  for (const label of ["Refresh", "Skills", "Sessions", "Overview", "summarize the release notes for 0.5.5"]) {
    assert.equal(host.clickAllowed(label), true, label);
  }
});

// 遮挡检查的失效方式不是「说错了」，而是「什么都没说就当干净」——它只读探针的
// stdout，探针换了措辞（比如分隔符少了一个 '='）它就静默地给每一次截图发一张清白
// 证明。因此没有 points= 行、或者点数为零，都是探针坏了，不是窗口干净。
test("an ownership scan that answered nothing is a broken probe, not a clean window", () => {
  assert.throws(() => host.ownershipScan("shot=D:/x.png rect=0,0,100,100 img=100x100", "pre"), /no points/);
  assert.throws(() => host.ownershipScan("pre=points=0 step=40 strangers=0", "pre"), /no points/);
});

// 数出来的和列出来的对不上，说明输出被截断了——剩下的那几行不足以说这次读是谁的。
test("an ownership scan whose strangers do not add up is refused", () => {
  assert.throws(() => host.ownershipScan("pre=points=1870 step=40 strangers=2\npre=199,134 pid=13232 win=Notepad", "pre"), /strangers/);
});

test("a scan of a window with nothing over it names no strangers", () => {
  assert.deepEqual(host.ownershipScan("pre=points=1870 step=40 strangers=0", "pre"), { points: 1870, step: 40, strangers: [] });
});

test("a scan names the window that is over this one, not just its pid", () => {
  const scan = host.ownershipScan("pre=points=1870 step=40 strangers=1\npre=1219,1334 pid=13232 win=Notepad", "pre");
  assert.deepEqual(scan.strangers, [{ x: 1219, y: 1334, pid: 13232, window: "Notepad" }]);
});

test("a screen read of somebody else's window fails the run", () => {
  const result = run({ shots: [{ name: "01-dashboard-open-occluded.png", occluded: true, byPid: 4242 }, SURFACE] });
  assert.equal(result.pass, false);
  assert.match(result.reasons.join("\n"), /01-dashboard-open-occluded\.png/);
});

test("a run whose compositor fallback never worked fails", () => {
  const result = run({ shots: [SCREEN, { name: "(no surface capture for 01-dashboard-open.png)", surface: true, captured: false }] });
  assert.equal(result.pass, false);
  assert.match(result.reasons.join("\n"), /surface/);
});

// 底部那一行说的是这台机器上真正在用的那份 CLI，而这次跑把本 checkout 的 CLI 放在
// 窗口 PATH 的第一段：面板写出来的那句话因此是这次跑证明得了的一句。写别的（或只写
// 「Avenic」）说明探针没走到这份 CLI，绿色就不能发。
test("a footer that does not name this repo's CLI fails the run", () => {
  const result = run({ footer: { text: "Avenic", expected: "Avenic v1.8.4" } });
  assert.equal(result.pass, false);
  assert.match(result.reasons.join("\n"), /footer/i);
});

test("a run that never read the footer fails", () => {
  const result = run({ footer: null });
  assert.equal(result.pass, false);
  assert.match(result.reasons.join("\n"), /footer/i);
});

test("an error in the extension's own log fails the run", () => {
  const result = run({ errors: [String.raw`logs\20260921T001717\window1\exthost\exthost.log: 2026-09-21 00:17:19.313 [error] Avenic: command 'avenic.dashboard.open' failed`] });
  assert.equal(result.pass, false);
  assert.match(result.reasons.join("\n"), /avenic\.dashboard\.open/);
});

// 窗口读的 agent 家目录必须是这次 run 自己的：core 的 fallback 是
// `CLAUDE_CONFIG_DIR || <home>/.claude`、`CODEX_HOME || <home>/.codex`，环境里不带这两
// 个变量时它读的就是开发者真实的家目录。今天点到的路径只读项目自己的 portable store，
// 所以这条是防下一行代码的，不是描述现在。
test("the window's agent homes are this run's, not the developer's", () => {
  const env = host.windowEnvironment();
  assert.equal(env.CLAUDE_CONFIG_DIR, path.join(host.AGENT_HOME, ".claude"));
  assert.equal(env.CODEX_HOME, path.join(host.AGENT_HOME, ".codex"));
});

// `code` refusing the VSIX and `code` not being on this machine are different
// facts. One branch that means both is how a package no editor will accept gets
// reported as "no editor here", with the install check skipped and the run green.
const EXPECTED = "echokang.avenic-agent-manager@0.6.0";
const attempt = (over: Record<string, unknown> = {}) =>
  artifacts.installVerdict({ editor: "C:/bin/code.cmd", install: { status: 0, stdout: "installing", stderr: "" }, listed: `${EXPECTED}\n`, expected: EXPECTED, ...over });

test("an editor that refuses the VSIX is a failure, not a skip", () => {
  const result = attempt({ install: { status: 1, stdout: "", stderr: "Unable to install extension: not a valid extension" } });
  assert.equal(result.status, "failed");
  assert.match(result.detail, /not a valid extension/);
});

test("no editor on PATH is the one branch that skips", () => {
  const result = attempt({ editor: null, install: null, listed: "" });
  assert.equal(result.status, "skipped");
  assert.match(result.detail, /no editor on PATH/);
});

test("an editor that exited 0 without installing anything fails", () => {
  const result = attempt({ listed: "ms-python.python@2026.1.0\n" });
  assert.equal(result.status, "failed");
  assert.match(result.detail, /avenic/i);
});

test("an editor that installed another version than the one packaged fails", () => {
  const result = attempt({ listed: "echokang.avenic-agent-manager@0.4.9\n" });
  assert.equal(result.status, "failed");
  assert.match(result.detail, /0\.4\.9/);
});

test("the version the editor lists is the version that was verified", () => {
  const result = attempt({ listed: "EchoKang.Avenic-Agent-Manager@0.6.0\n" });
  assert.equal(result.status, "installed");
  assert.match(result.detail, /0\.6\.0/);
});
