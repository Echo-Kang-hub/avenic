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
  ownershipScan: (text: string, tag: string) => { points: number; step: number; strangers: { x: number; y: number; pid: number; proc: string; window: string }[] };
  windowEnvironment: () => Record<string, string | undefined>;
  writePsFile: (file: string) => void;
  pickPreviousVsix: (candidates: { version: string; file: string }[], currentVersion: string, wanted?: string | null) => { version: string; file: string } | null;
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

// 没有点击的那一格：外面开一个启动组、再离开，面板自己改口两次。
const STATE = { running: true, idle: true };

const run = (over: Record<string, unknown> = {}) =>
  host.verdict({ steps: [SKILLS], row: SESSION, header: HEADER, shots: [SCREEN, SURFACE], errors: [], footer: FOOTER, state: STATE, ...over });

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
  const result = run({ steps: [{ label: "Refresh", changed: false, mutations: 1, expectText: false, answers: 1 }] });
  assert.deepEqual(result, { pass: true, reasons: [] });
});

test("a refresh that repainted nothing at all still fails", () => {
  const result = run({ steps: [{ label: "Refresh", changed: false, mutations: 0, expectText: false, answers: 1 }] });
  assert.equal(result.pass, false);
  assert.match(result.reasons.join("\n"), /mutation/i);
});

// 突变数是在固定时刻数的一眼：一次重读要读盘、要问 CLI 的版本，落地比观察窗口晚
// 半步是常事，一次真发生了的重读会被数成「面板没动」。重读按钮真正的证据是宿主答没
// 答——那条 data 有没有回来——所以它单独成一条，而不是靠数一眼突变去推断。
test("a refresh the host never answered fails even if the page moved", () => {
  const result = run({ steps: [{ label: "Refresh", changed: false, mutations: 1, expectText: false, answers: 0 }] });
  assert.equal(result.pass, false);
  assert.match(result.reasons.join("\n"), /never answered/);
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

// 启动结束这一格没有点击可数，所以它的证据是那两个方向本身：Running 出现过、并且
// 在租约离开之后自己消失了。三件事要分开——没测过、没出现过、出现了不肯走。
test("a launch that never showed Running fails the run", () => {
  const result = run({ state: { running: false, idle: true, note: "pill while held: []" } });
  assert.equal(result.pass, false);
  assert.match(result.reasons.join("\n"), /never showed Running/);
});

test("a Running pill that outlived its launch fails the run", () => {
  const result = run({ state: { running: true, idle: false, note: "pill while held: [\"Running\"]" } });
  assert.equal(result.pass, false);
  assert.match(result.reasons.join("\n"), /outlived the lease/);
});

test("a run that never measured the transition does not pass by omission", () => {
  const result = run({ state: null });
  assert.equal(result.pass, false);
  assert.match(result.reasons.join("\n"), /never measured/);
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
  assert.throws(() => host.ownershipScan("pre=points=1870 step=40 strangers=2\npre=199,134 pid=13232 proc=notepad win=Notepad", "pre"), /strangers/);
});

test("a scan of a window with nothing over it names no strangers", () => {
  assert.deepEqual(host.ownershipScan("pre=points=1870 step=40 strangers=0", "pre"), { points: 1870, step: 40, strangers: [] });
});

test("a scan names the window that is over this one, not just its pid", () => {
  const scan = host.ownershipScan("pre=points=1870 step=40 strangers=1\npre=1219,1334 pid=13232 proc=notepad win=Notepad", "pre");
  assert.deepEqual(scan.strangers, [{ x: 1219, y: 1334, pid: 13232, proc: "notepad", window: "Notepad" }]);
});

// 三个被锁住的跑都是靠这一行才知道画面是谁的：pid 33352 谁也认不出来，那个窗口的标题写着
// 「Windows 输入体验」——正是锁屏。谁在画面上要写在行里，读的人才知道这是锁着的机器，
// 而不是探针坏了。
test("a scan says which process owns the pixels, not only its pid", () => {
  const scan = host.ownershipScan("pre=points=1870 step=40 strangers=1\npre=199,134 pid=33352 proc=LockApp win=Windows 输入体验", "pre");
  assert.deepEqual(scan.strangers, [{ x: 199, y: 134, pid: 33352, proc: "LockApp", window: "Windows 输入体验" }]);
});

// 名字查不到时不能变成一句空话：进程已经退出的那个窗口仍然是「谁在上面」的答案，
// 标题还在，行就还得读得出来。
test("a stranger whose process is gone still reads by its window title", () => {
  const scan = host.ownershipScan("pre=points=1870 step=40 strangers=1\npre=1219,1334 pid=13232 proc=? win=Notepad", "pre");
  assert.deepEqual(scan.strangers, [{ x: 1219, y: 1334, pid: 13232, proc: "?", window: "Notepad" }]);
});

// Windows PowerShell 5.1 读一个没有 BOM 的文件用的是本机 ANSI 代码页（这台机器上是
// GBK）：UTF-8 的中文注释在那里被拆错，行尾的多字节序列把换行也吃掉，下一行就并进了
// 注释里。`$scan=@(Get-Owners …)` 正是这么消失的——所有权扫描一声不响地什么也没做，
// 快门照下的画面因此根本没经过「这些像素是谁的」这道检查，而报告上一个字都不会提。
// 写文件时先写 BOM，PowerShell 就按 UTF-8 读，中文注释想怎么写就怎么写。
test("the PowerShell the harness runs is written as UTF-8 with a BOM", async () => {
  const { mkdtempSync, readFileSync, rmSync } = await import("node:fs");
  const os = await import("node:os");
  const dir = mkdtempSync(path.join(os.tmpdir(), "avenic-ps-"));
  const file = path.join(dir, "capture.ps1");
  try {
    host.writePsFile(file);
    const bytes = readFileSync(file);
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "the script must start with a UTF-8 BOM");
    assert.match(bytes.subarray(3).toString("utf8"), /Get-Owners "pre=" \$X \$Y \$W \$H/, "and hold the scan the shutter depends on");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a screen read of somebody else's window fails the run", () => {
  const result = run({ shots: [{ name: "01-dashboard-open-occluded.png", occluded: true, byPid: 4242 }, SURFACE] });
  assert.equal(result.pass, false);
  assert.match(result.reasons.join("\n"), /01-dashboard-open-occluded\.png/);
});

// 一张只拍到窗口一角的读数，不是这张窗口的照片。窗口被拖到屏幕外面之后，探针在剩下
// 的那 94 像素里谁也没抓到，于是「干净」这个名字写给了一张细条——那次的 05-running.png
// 和 final-overview.png 正是这么来的，而它们本该是这一轮要交出去的证据。有别人的窗口
// 压在下面是「拍不到」，窗口自己不在屏幕里是「拍到的不算」，两个问题得分着回答。
test("a screen read that holds only a corner of the window fails the run", () => {
  const result = run({ shots: [{ name: "05-running-partial.png", screen: true, occluded: false, partial: true, visible: 0.04 }, SURFACE] });
  assert.equal(result.pass, false);
  const reasons = result.reasons.join("\n");
  assert.match(reasons, /05-running-partial\.png/);
  assert.match(reasons, /4%/);
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

// 原地升级那一趟检查的前提是「从一个真的更早的发行版升上来」。选错版本（选到正在发的
// 这个、或者什么都没选到）会把「升级过一个正在跑的旧版本」变成「升级过它自己」——照样
// 全绿，什么都没证明，所以这个选择本身进了测试。
test("the in-place update starts from the newest release that is not the one being shipped", () => {
  const onDisk = [
    { version: "0.5.2", file: "dist/release-20260919-1551/avenic-agent-manager-0.5.2.vsix" },
    { version: "0.5.5", file: "dist/host-check/avenic-agent-manager-0.5.5.vsix" },
    { version: "0.6.0", file: "dist/release-20260921/avenic-agent-manager-0.6.0.vsix" },
  ];
  assert.deepEqual(host.pickPreviousVsix(onDisk, "0.6.0"), onDisk[1]);
  // 版本按数字比，不按字符串：0.5.10 比 0.5.9 新。
  assert.equal(host.pickPreviousVsix([{ version: "0.5.9", file: "a" }, { version: "0.5.10", file: "b" }], "0.9.0")?.version, "0.5.10");
});

test("--from picks one version by name or by path, and says so when it matches nothing", () => {
  const onDisk = [{ version: "0.5.2", file: "dist/release-x/avenic-agent-manager-0.5.2.vsix" }, { version: "0.5.5", file: "b" }];
  assert.equal(host.pickPreviousVsix(onDisk, "0.6.0", "0.5.2")?.version, "0.5.2");
  assert.equal(host.pickPreviousVsix(onDisk, "0.6.0", "b")?.version, "0.5.5");
  assert.throws(() => host.pickPreviousVsix(onDisk, "0.6.0", "0.4.0"), /0\.4\.0/);
});

test("with only the version being shipped on disk there is no previous release to update from", () => {
  assert.equal(host.pickPreviousVsix([{ version: "0.6.0", file: "only" }], "0.6.0"), null);
});
