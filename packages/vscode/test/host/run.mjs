#!/usr/bin/env node
// Real VS Code Extension Host check for the Avenic dashboard.
//
// What it proves: the packaged VSIX installs into a clean profile, the extension
// activates in a genuine Extension Host, the dashboard webview renders real
// content from a real (temporary) project, and clicking its controls changes
// what is on screen. Writes screenshots + report.md to dist/host-check/.
//
// Needs a DESKTOP session: pixels come from CopyFromScreen, so the host window is
// raised (topmost, never activated — it does not take your keyboard focus). All
// input is injected through the DevTools protocol instead, so nothing is typed
// into whatever window you are actually using. Everything runs against a
// throwaway profile under the temp dir, recreated for each run; your own profile
// is never touched. One run at a time: a pid file under dist/host-check
// serialises them, because two would share the profile and the debug port — and
// would each reap the other's window.
//
// Every shot is taken twice: once off the screen, and once as the window's own
// compositor surface over CDP. The screen read is the one that shows the real
// editor, so the whole of it is scanned — a grid of points every 40px, each asked
// which process owns the window under it — and repeated if another window is
// above; if it stays occluded the read is dropped rather than kept (a picture of
// somebody else's window must not sit in this repo's artifacts under this
// window's name), and only the report line naming the pid, the process and the
// point survives. The surface capture cannot be occluded at all, so a busy
// desktop cannot quietly turn the evidence into a picture of somebody else's
// window.
//
// The run ends in a verdict: a click that changed nothing, a session that did
// not open, a screen read of another window, a read that holds only the part of
// the window that was on the desk, a lost compositor fallback or an error in the
// extension's own log fail it, and the process exits non-zero — a green run is
// one where the checks ran and passed. However it ends, the window is dropped
// back to NOTOPMOST and this run's processes are reaped (--keep leaves the
// window up to look at).
//
// Nothing here launches or resumes an agent session. The fixture is synthetic:
// a project of the class the product is actually used on (API-managed Claude,
// project-account Codex, OpenCode answering for itself, Skills from a real
// catalog, sessions on all three agents), built by the production calls in
// test/host/fixture.mjs.
//
// 具体到点击上：这个 harness 只点刷新、分区的导航项和一条会话的*标题*（标题进的是
// 对话阅读，见 media/dashboard/main.js 的 viewSession），从不点 Continue / Launch——
// 启动或继续一个 agent 是用户自己的动作，隔离 profile 也不是借口。这条规矩由
// clickAllowed 把着（见下），所以将来谁往步骤表里加一条 "Continue"，是这里响亮地
// 拒绝，而不是某天悄悄把一个 agent 跑起来。
//
// The window is started with a throwaway bin directory on PATH holding one
// `avenic.cmd` that runs *this checkout's* CLI, so the footer's version line is
// a claim about this repo rather than about whatever is installed on the
// machine — and the report records what that line actually said.
//
// Usage: node packages/vscode/test/host/run.mjs [--keep] [--upgrade [--from=<version|path>] [--open-old]]
//   expects packages/vscode/dist/avenic-agent-manager.vsix (npm run package).
//   The editor comes from AVENIC_VSCODE_BIN or from `code` on PATH; the paths
//   actually used are printed and recorded in the report.
//
// --upgrade is the in-place Marketplace update, as a check rather than a hope:
// the profile gets the *previous* released VSIX first, the window is started and
// driven with it (--open-old leaves its own dashboard page open, the default
// leaves the extension merely installed), and only then is the new VSIX installed
// over it with --force and no uninstall. The window is reloaded the way the
// fallback notification offers to — Ctrl+Shift+P, "Reload Window" — and the rest
// of the run is the ordinary one. That path is where
// "No view is registered with id: avenic.launcher" came from: after an in-place
// update the workbench serves the new manifest's view id while the extension host
// is still running the previous release's code, which registered the four views
// that release had (avenic.agents / avenic.catalog / avenic.skills /
// avenic.overview). The pane body is read by name and the run fails on that
// sentence rather than on "no 'Open Dashboard' row" three screens later.
// Upgrade runs write their shots and report under their own directory
// (dist/host-check/upgrade*), so the fresh run's evidence stays intact.

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { buildHostFixture } from "./fixture.mjs";

// Derived rather than typed in: a literal repo path turns "check this checkout"
// into "check whatever happens to sit at that path on this machine".
// host/ → test/ → vscode/ → packages/ → repo: four levels up. 少一级会把
// 「检查这个 checkout」变成「检查 packages 里的一个不存在的东西」。
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const VSIX = `${REPO}/packages/vscode/dist/avenic-agent-manager.vsix`;
// Shots and report land in a directory of their own per mode: the fresh run's
// evidence is what the release notes point at, and an upgrade run that overwrote
// it would leave the report describing a window it never opened. Reassigned in
// main(); the lock below stays on the base path, because the two modes share one
// profile directory and one debug port.
let OUT = `${REPO}/dist/host-check`;
const LOCK = `${OUT}/run.pid`;
const ROOT = path.join(tmpdir(), "avenic-host-check");
const UD = path.join(ROOT, "ud");
const EXT = path.join(ROOT, "ext");
// The project the window opens. Named, not just "project": the dashboard paints
// the folder's own name in its header, so this is part of what the screenshot
// shows.
const PROJECT = path.join(ROOT, "atlas");
const CATALOG = path.join(ROOT, "catalog");
const STATE = path.join(ROOT, "state");
export const AGENT_HOME = path.join(ROOT, "home");
const SHIM = path.join(ROOT, "bin");
const PORT = 9333;
const EXT_ID = "EchoKang.avenic-agent-manager";
const KEEP = process.argv.includes("--keep");
// In-place update mode: install the previous release first, update over it while
// the window runs, reload, and then run the ordinary checks (see the header).
const UPGRADE = process.argv.includes("--upgrade");
// Leave the previous release's own dashboard page open when the update lands.
const OPEN_OLD = process.argv.includes("--open-old");
const FROM = process.argv.find((arg) => arg.startsWith("--from="))?.slice("--from=".length) ?? null;

// Only for a launcher that is on PATH without its install tree beside it: the
// window binary is what has to be started, and it cannot be derived from a shim
// that lives somewhere else.
const FALLBACK_CODE = "D:/AppDownload/Visual Studio/VS code/Microsoft VS Code/Code.exe";

const log = (...a) => console.log("[host-check]", ...a);
const sleep = (ms) => delay(ms);

// `code` on PATH is a shim, not the editor: --install-extension has to go through
// the shim (running Code.exe starts the whole GUI app, which then never exits)
// while the window itself is Code.exe. Both are resolved, printed and recorded,
// because which editor a check verified against is part of what it proved.
function launcherOnPath() {
  try {
    const lines = execFileSync(process.platform === "win32" ? "where" : "which", ["code"], { encoding: "utf8" })
      .split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
    // `where` lists the POSIX script, the .cmd shim and a .ps1; only the shim is
    // executable from cmd.exe.
    return (process.platform === "win32" ? lines.find((line) => /\.cmd$/i.test(line)) : lines[0]) ?? null;
  } catch {
    return null;
  }
}

function resolveEditor() {
  const launcher = process.env.AVENIC_VSCODE_BIN ?? launcherOnPath();
  if (!launcher) throw new Error("no VS Code launcher: set AVENIC_VSCODE_BIN, or put `code` on PATH");
  const exe = [path.resolve(path.dirname(launcher), "..", "..", "Code.exe"), FALLBACK_CODE].find((candidate) => existsSync(candidate));
  if (exe === undefined) throw new Error(`no Code.exe in the install tree of ${launcher}, and none at ${FALLBACK_CODE} — set AVENIC_VSCODE_BIN to the install's bin/code.cmd`);
  return { launcher, exe };
}

// --------------------------------------------------------------- the update
// Which released VSIX the in-place update starts from. Pure and exported because
// this is the decision that makes the whole upgrade check meaningful or vacuous:
// picking the version already installed (or picking nothing at all) turns "update
// over a running previous release" into "update over itself", which passes while
// proving nothing.
//
// `wanted` is --from: a version ("0.5.2"), a path, or null for "the highest
// release that is not the one being shipped". Versions are compared numerically,
// not as strings, so 0.5.10 does not sort below 0.5.9.
export function pickPreviousVsix(candidates, currentVersion, wanted = null) {
  const parse = (version) => String(version).split(".").map((part) => Number.parseInt(part, 10));
  const newer = (a, b) => {
    const [x, y] = [parse(a), parse(b)];
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
    }
    return false;
  };
  if (wanted !== null) {
    const hit = candidates.find((c) => c.version === wanted || c.file === wanted || path.resolve(c.file) === path.resolve(wanted));
    if (!hit) throw new Error(`--from=${wanted} matches none of the ${candidates.length} VSIX(s) on disk: ${candidates.map((c) => `${c.version} (${c.file})`).join(", ") || "none"}`);
    return hit;
  }
  const older = candidates.filter((c) => c.version !== currentVersion);
  return older.sort((a, b) => (newer(a.version, b.version) ? -1 : 1))[0] ?? null;
}

// Every `avenic-agent-manager-<version>.vsix` under dist/ (the release directories
// keep them by version), which is where a previous release's own artifact is.
function vsixOnDisk() {
  const found = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(file); continue; }
      const version = entry.name.match(/^avenic-agent-manager-(\d+\.\d+\.\d+)\.vsix$/)?.[1];
      if (version !== undefined) found.push({ version, file });
    }
  };
  walk(path.join(REPO, "dist"));
  return found;
}

// ------------------------------------------------------------------ CLI shim
// 面板底部那一行版本号说的是这台机器真正在用的那份 Avenic CLI：扩展自己跑
// `avenic --version` 读它的 PATH。所以「这次跑的是这个 checkout」不能是希望，而要是
// 这个窗口的 PATH 的第一段——run 自己目录里的一个 .cmd，机器上什么都没装、没改。
// The version is read from the CLI's manifest, not typed in: a literal here is a
// stale claim the day the version bumps.
const CLI_VERSION = JSON.parse(readFileSync(`${REPO}/packages/cli/package.json`, "utf8")).version;
const FOOTER_LINE = `Avenic v${CLI_VERSION}`;

// The environment the window starts with: the shim first on PATH, and the state
// root inside this run. The second half matters as much as the first — the
// dashboard reads the catalog cache and the Skills state from this root, so
// pointing it here is what makes the window read the fixture's catalog instead
// of the machine's, and keeps every write inside the run's own directory.
export function windowEnvironment() {
  const inherited = process.env.PATH ?? process.env.Path ?? "";
  // Both spellings: Windows preserves whichever one a process was started with,
  // and core's resolver reads PATH first and Path second.
  const value = `${SHIM}${path.delimiter}${inherited}`;
  // The agent homes are re-routed the same way test/helpers.ts and test/host/fixture.mjs
  // already re-route theirs: core falls back to `CLAUDE_CONFIG_DIR || <home>/.claude`
  // and `CODEX_HOME || <home>/.codex`, so without these two the window would read the
  // developer's real homes on any path that touches them. Latent, not an active leak —
  // today's click set only reads the project's own portable store — but the next click
  // added to the step list would make it real.
  return {
    ...process.env,
    PATH: value,
    Path: value,
    AVENIC_STATE_DIR: STATE,
    XDG_CONFIG_HOME: path.join(AGENT_HOME, ".config"),
    CLAUDE_CONFIG_DIR: path.join(AGENT_HOME, ".claude"),
    CODEX_HOME: path.join(AGENT_HOME, ".codex"),
  };
}

// Proved before the window depends on it: this is the command the extension's
// probe runs, so a shim that cannot answer it here cannot answer it in the
// footer either — and the report says which line it gave.
function writeCliShim() {
  const entry = path.join(REPO, "packages", "cli", "scripts", "skills.mjs");
  mkdirSync(SHIM, { recursive: true });
  writeFileSync(path.join(SHIM, "avenic.cmd"), `@echo off\r\n"${process.execPath}" "${entry}" %*\r\n`);
  const output = execFileSync("cmd.exe", ["/c", "avenic", "--version"], { env: windowEnvironment(), encoding: "utf8", timeout: 60_000 }).trim();
  // The version, not the sentence: the CLI prints `Avenic 1.8.4` and the panel
  // paints `Avenic v1.8.4`, and the extension reads the first number out of the
  // CLI's line (core's parseCliVersion, same rule here).
  const version = output.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
  return { entry, file: path.join(SHIM, "avenic.cmd"), output, version, expected: CLI_VERSION };
}

// ---------------------------------------------------------------- PowerShell
// Chromium cannot be captured with PrintWindow (GPU-composited content comes
// back black), so the window is raised with SWP_NOACTIVATE and read off screen.
const PS_FILE = path.join(ROOT, "capture.ps1");

// Windows PowerShell 5.1 读一个没有 BOM 的文件用的是本机 ANSI 代码页（这台机器上是
// GBK）：UTF-8 的中文注释在那里被拆错，行尾的多字节序列连换行一起吃掉，下一行就并进
// 了注释里——`$scan=@(Get-Owners …)` 这么消失过一次，扫描一声不响地什么也没做，
// 快门照下的画面因此没经过「这些像素是谁的」这道检查，而报告上一个字都不会提。
// 所以这个文件先写 BOM 再落盘；而 BOM 写成一个转义序列而不是源码里的那个字符，是因为
// 看不见的字节不该只活在看不见的地方——读者要能一眼看出它是故意写下的。
const BOM = "\uFEFF";

export function writePsFile(file) {
  writeFileSync(file, BOM + PS);
}
const PS = String.raw`
param([string]$Mode,[string]$OutFile,[string]$InFile,[int]$X=0,[int]$Y=0,[int]$W=0,[int]$H=0,[int]$Scale=1)
# PowerShell variable names are case-insensitive, so the window loops below
# must not use $h: that IS the $H parameter, and a loop that clobbers the
# height asks GDI+ for a bitmap as tall as a window handle — "Parameter is not
# valid". They are named $wnd for that reason.
$ErrorActionPreference="Stop"; Add-Type -AssemblyName System.Drawing
$cs=@"
using System;using System.Collections.Generic;using System.Runtime.InteropServices;using System.Text;
public class Win{
 [DllImport("user32.dll")]static extern bool EnumWindows(EnumProc cb,IntPtr p);
 [DllImport("user32.dll")]public static extern bool SetProcessDPIAware();
 [DllImport("user32.dll")]public static extern int GetSystemMetrics(int i);
 [DllImport("user32.dll")]public static extern IntPtr WindowFromPoint(POINT p);
 [StructLayout(LayoutKind.Sequential)]public struct POINT{public int X,Y;}
 [DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,out RECT r);
 [DllImport("user32.dll")]public static extern bool ShowWindow(IntPtr h,int c);
 [DllImport("user32.dll")]public static extern bool SetWindowPos(IntPtr h,IntPtr a,int x,int y,int w,int hh,uint f);
 delegate bool EnumProc(IntPtr h,IntPtr p);
 [StructLayout(LayoutKind.Sequential)]public struct RECT{public int Left,Top,Right,Bottom;}
 public static List<IntPtr> Handles(uint pid){var l=new List<IntPtr>();
  EnumWindows((h,p)=>{uint q;GetWindowThreadProcessId(h,out q);
   RECT r;GetWindowRect(h,out r);
   // A minimized window reports its 158x26 icon rectangle, so the size test
   // alone would skip exactly the window that needs restoring; IsIconic keeps
   // it in and the caller's SW_RESTORE brings it back to a real rectangle.
   if(q==pid && (IsIconic(h) || (r.Right-r.Left>=200 && r.Bottom-r.Top>=200))) l.Add(h);return true;},IntPtr.Zero);return l;}
 [DllImport("user32.dll")]static extern bool IsIconic(IntPtr h);
 [DllImport("user32.dll")]static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")]static extern int GetWindowTextLength(IntPtr h);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetClassName(IntPtr h,StringBuilder s,int n);
 // One point, one call: the scan below asks this a few thousand times, and
 // marshalling a POINT and two out-parameters from PowerShell each time is what
 // would make that slow rather than the syscalls.
 public static IntPtr HandleAt(int x,int y){POINT p;p.X=x;p.Y=y;return WindowFromPoint(p);}
 public static uint PidOf(IntPtr h){uint q;GetWindowThreadProcessId(h,out q);return q;}
 // A window this run may raise or read has to be one that is up and named. Electron
 // keeps an untitled Chrome_WidgetWin_0 hidden behind the editor's window, and
 // IsWindowVisible reflects that only until somebody shows it: SW_RESTORE and
 // SWP_SHOWWINDOW are what show it, so the raise itself is what has to refuse.
 public static bool Visible(IntPtr h){return IsWindowVisible(h);}
 public static bool Titled(IntPtr h){return GetWindowTextLength(h)>0;}
 public static string NameOf(IntPtr h){var c=new StringBuilder(256);GetClassName(h,c,c.Capacity);
  var t=new StringBuilder(GetWindowTextLength(h)+2);GetWindowText(h,t,t.Capacity);
  return (t.Length>0?t.ToString():c.ToString());}
}
"@
if(-not("Win" -as [type])){Add-Type -TypeDefinition $cs -Language CSharp}

# Every ~40px of the rectangle, and whose process owns each point. Asked twice:
# once before a read, to decide whether to raise the window again, and once inside
# the read itself, because a window can arrive between those two calls and a picture
# is only this instance's if it was this instance's when the pixels were taken.
#
# A grid rather than a handful of fixed points, which is what this used to be: nine
# points (the corners and the centre, then a 3×3) cannot see a window that sits
# between them, and two runs' artifact shots came back with somebody else's window
# on them while every point said the pixels were ours. At 40px the only thing that
# fits between two points is a window narrower than 40px, and a point the intruder
# covers is a point its process owns — this is the question "is anything else in
# this picture", asked of every part of it.
#
# The grid is inset by 8px so the window's own rounded corners and its drop shadow
# are not read as somebody else, and it counts as it goes: the report says how many
# points were sampled, so a scan that silently covered nothing cannot pass for one
# that covered the window.
function Get-Owners([string]$tag,[int]$px,[int]$py,[int]$pw,[int]$ph){
 $step=40;$inset=8;$n=0;$strangers=@();$procs=@{}
 for($y=$py+$inset;$y -lt $py+$ph-$inset;$y+=$step){
  for($x=$px+$inset;$x -lt $px+$pw-$inset;$x+=$step){
   $n++
   $h=[Win]::HandleAt($x,$y);$owner=[Win]::PidOf($h)
   # This instance's own windows are not intruders: the panel is one process and the
   # extension host another, and both are ours to be in the picture.
   #
   # The process's own image name goes in the line as well as the window title: a pid
   # is not a name a reader can place, and the title can be no help at all — the lock
   # screen's reads "Windows 输入体验", which is how three runs reported a locked
   # workstation without anything saying so. Looked up once per pid for this call: a
   # full-screen occluder owns every point of the grid, and a Get-Process per point
   # would cost more than the scan it is reporting on.
   if($pids -notcontains $owner){
    if(-not $procs.ContainsKey($owner)){$nm='?';try{$nm=(Get-Process -Id $owner -ErrorAction Stop).ProcessName}catch{};$procs[$owner]=$nm}
    $strangers+=($tag+$x+","+$y+" pid="+$owner+" proc="+$procs[$owner]+" win="+[Win]::NameOf($h))}}}
 Write-Output ($tag+"points="+$n+" step="+$step+" strangers="+$strangers.Count)
 foreach($s in $strangers){Write-Output $s}}

# Which windows this call is about: the ones this profile's processes have up, that
# are visible and carry a title — the editor's own window, and not the untitled
# Chrome_WidgetWin_0 that Electron keeps hidden behind it. A raise is not a neutral
# call on such a window: ShowWindow(SW_RESTORE) plus SWP_SHOWWINDOW is exactly how a
# window nobody had shown ends up drawn over the panel, and one run's artifact came
# back as an empty black rectangle full of this harness's own doing.
$pids=@(Get-CimInstance Win32_Process -Filter "Name='Code.exe'"|Where-Object{$_.CommandLine -like "*avenic-host-check*"}|Select-Object -ExpandProperty ProcessId)
$mine=@()
foreach($p in $pids){foreach($wnd in [Win]::Handles($p)){
 if([Win]::Visible($wnd) -and [Win]::Titled($wnd)){$mine+=$wnd}}}

# Restore + raise those, so the capture cannot be occluded and the renderer reports
# real screen geometry (a minimized Electron window reports screenX -31999). Called
# twice per shot: here, and again a step before the shutter, because among topmost
# windows the most recent raise is the one on top and this call is 900ms and a scan
# old by the time the pixels are read.
function Raise(){
 foreach($wnd in $mine){
  [void][Win]::ShowWindow($wnd,9)
  [void][Win]::SetWindowPos($wnd,[IntPtr]::new(-1),0,0,0,0,0x0010 -bor 0x0001 -bor 0x0002 -bor 0x0040)}}

# Chromium reports device pixels; a DPI-unaware process sees a virtualized
# desktop (1707x1067 where the display is 2560x1600), and GetWindowRect speaks
# that same smaller space. The harness asks for the renderer's rectangle, so an
# unaware capture reads the wrong region at the wrong size — and at 150% the
# requested rectangle does not even exist in the virtualized space, which is
# how a plain 2184x1365 bitmap fails to construct. Awareness first, then
# measure.
[void][Win]::SetProcessDPIAware()

if($Mode -eq "crop"){
 $src=[System.Drawing.Image]::FromFile($InFile)
 $dw=[int]($W*$Scale);$dh=[int]($H*$Scale)
 $out=New-Object System.Drawing.Bitmap($dw,$dh)
 $g=[System.Drawing.Graphics]::FromImage($out)
 $g.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
 $g.PixelOffsetMode=[System.Drawing.Drawing2D.PixelOffsetMode]::Half
 $g.DrawImage($src,(New-Object System.Drawing.Rectangle(0,0,$dw,$dh)),(New-Object System.Drawing.Rectangle($X,$Y,$W,$H)),[System.Drawing.GraphicsUnit]::Pixel)
 $g.Dispose();$out.Save($OutFile,[System.Drawing.Imaging.ImageFormat]::Png);$out.Dispose();$src.Dispose()
 Write-Output "crop=$OutFile";exit 0
}

# Which window this call is about: the biggest of those. Restoring is what gets a
# real rectangle back (a minimized Electron window reports screenX -31999 until it
# is), and only one of them is worth a picture.
$biggest=$null
Raise
foreach($wnd in $mine){
 $r=New-Object Win+RECT;[void][Win]::GetWindowRect($wnd,[ref]$r)
 $area=($r.Right-$r.Left)*($r.Bottom-$r.Top)
 if(-not $biggest -or $area -gt $biggest.area){
   $biggest=[pscustomobject]@{wnd=$wnd;area=$area;L=$r.Left;T=$r.Top;W=$r.Right-$r.Left;H=$r.Bottom-$r.Top}}}
Start-Sleep -Milliseconds 900

# What is over the window, and whose process owns it: raising is not a promise
# that nothing else is above it, so the report names what the capture actually
# looked through instead of assuming it was ours. A grid over the whole rectangle,
# not a point or a handful of them — a window covering the sidebar leaves the
# centre ours, and anything small enough to sit between two fixed points would let
# a shot be called clean while the file held somebody else's pixels.
if($Mode -eq "probe"){
 Get-Owners "probe=" $X $Y $W $H
 exit 0
}

if($Mode -eq "raise"){
 # 抬到最前（TopMost，SWP_NOACTIVATE 保住键盘焦点），再把它挪回桌面里：一个被拖到
 # 屏幕外的窗口仍然会渲染，合成面里整整齐齐，而 CopyFromScreen 只交得回落在桌面上的
 # 那一条——94 像素的细条顶着「这张窗口的照片」的名字，就是它这么来的。（这里原先写的是
 # HWND_NOTOPMOST：一次「再抬一次」实际上把窗口降到了普通层，用户的窗口一点就回到上面，
 # 重试因此白重试。）
 foreach($wnd in $mine){
  [void][Win]::ShowWindow($wnd,9)
  [void][Win]::SetWindowPos($wnd,[IntPtr]::new(-1),0,0,0,0,0x0010 -bor 0x0001 -bor 0x0002 -bor 0x0040)}
 $vw=[Win]::GetSystemMetrics(78);$vh=[Win]::GetSystemMetrics(79)
 $L=$biggest.L;$T=$biggest.T;$W=$biggest.W;$H=$biggest.H;$moved=0
 if($biggest -and ($L -lt 0 -or $T -lt 0 -or ($L+$W) -gt $vw -or ($T+$H) -gt $vh)){
  # 留 8px 边距。窗口挪回桌面里之后，读窗口矩形的是另一条通道（CDP 报的尺寸比 Win32
  # 大两三像素），贴着底边放下会让下一次读越界三像素——而那个读会被判成「窗口不在
  # 屏幕上」，是运行自己造成的。挪一次就挪到用不着再挪的地方。
  $nx=[Math]::Max(0,[Math]::Min($L,$vw-$W-8));$ny=[Math]::Max(0,[Math]::Min($T,$vh-$H-8))
  foreach($wnd in $mine){
   [void][Win]::SetWindowPos($wnd,[IntPtr]::new(-1),$nx,$ny,0,0,0x0010 -bor 0x0001 -bor 0x0040)}
  Start-Sleep -Milliseconds 400
  $r=New-Object Win+RECT;[void][Win]::GetWindowRect($biggest.wnd,[ref]$r)
  $L=$r.Left;$T=$r.Top;$W=$r.Right-$r.Left;$H=$r.Bottom-$r.Top;$moved=1}
 Write-Output "rect=$L,$T,$W,$H desktop=$vw,$vh moved=$moved";exit 0
}

# A read that runs past the desktop edge comes back blank rather than throwing,
# so the rectangle is trimmed to the screen and the trim is reported: a shot is
# never silently smaller than the window it claims to show.
$vw=[Win]::GetSystemMetrics(78);$vh=[Win]::GetSystemMetrics(79)
$clip=@()
if($X+$W -gt $vw){$W=[Math]::Max(1,$vw-$X);$clip+="right"}
if($Y+$H -gt $vh){$H=[Math]::Max(1,$vh-$Y);$clip+="bottom"}
$note=if($clip.Count){" clip="+($clip -join "+")}else{""}
# Raised once more, this close to the shutter. The call above is a second old by
# now, which is long enough for somebody to have put their own window up, and a
# raise is the only answer this harness has to that: among topmost windows the last
# one raised is the one on top. It is not a promise either — the scan below is what
# has the last word, and it is asked of the rectangle as it is at the shutter.
Raise
Start-Sleep -Milliseconds 250
# The same grid, read here — the call above happened seconds ago, and a window that
# arrived since is invisible to it. The report demotes the file when this disagrees
# with the process the read was meant to be of.
#
# 这张画要不要落盘，先问再读：哪怕一个点被别人的进程占着，读下来的也是那个人的屏幕，
# 而别人的桌面不该出现在这个 harness 的产物里，一秒也不该。扫描本来就在快门之前，
# 把它放进同一个判断里，读之前就知道该不该读。
$scan=@(Get-Owners "pre=" $X $Y $W $H)
foreach($line in $scan){Write-Output $line}
$strangers=@($scan|Where-Object{$_ -like "pre=*" -and $_ -match " pid="})
if($strangers.Count -gt 0){
 foreach($wnd in $mine){
  [void][Win]::SetWindowPos($wnd,[IntPtr]::new(-2),0,0,0,0,0x0010 -bor 0x0001 -bor 0x0002)}
 Write-Output ("shot=" + $OutFile + " rect=" + $X + "," + $Y + "," + $W + "," + $H + " dropped=" + $strangers.Count + $note);exit 0}
$bmp=New-Object System.Drawing.Bitmap($W,$H)
$g=[System.Drawing.Graphics]::FromImage($bmp);$g.CopyFromScreen($X,$Y,0,0,$bmp.Size);$g.Dispose()
$img="" + $bmp.Width + "x" + $bmp.Height
$bmp.Save($OutFile,[System.Drawing.Imaging.ImageFormat]::Png);$bmp.Dispose()
foreach($wnd in $mine){
 [void][Win]::SetWindowPos($wnd,[IntPtr]::new(-2),0,0,0,0,0x0010 -bor 0x0001 -bor 0x0002)}
Write-Output ("shot=" + $OutFile + " rect=" + $X + "," + $Y + "," + $W + "," + $H + " img=" + $img + $note)
`;
const ps = (...args) => execFileSync("powershell.exe", ["-NoProfile", "-File", PS_FILE, ...args], { encoding: "utf8" }).trim();

// ------------------------------------------------------------------ cleanup
// Only this harness's own throwaway instances, identified by the throwaway
// profile path in their command line. A run that died leaves its instance
// behind, and a survivor keeps the debugging port: the next run would then
// measure and click the *old* window instead of the one it just opened. It is
// also what fills the desktop with renderers the capture below has to find
// room for, so this runs before the window exists and again at the end.
// What keeps this signature from meaning "every host check on the machine" is
// the pid lock below: only a run that got past it can be in flight, so anything
// else matching the signature is the corpse of a run that died — the thing this
// is here to clean up.
const reap = () => execFileSync("powershell.exe", ["-NoProfile", "-Command",
  `Get-CimInstance Win32_Process -Filter "Name='Code.exe'" | Where-Object { $_.CommandLine -like '*avenic-host-check*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`]);

// Removed, not reused: "installs into a clean profile" is a claim the report
// makes, and a profile left over from the previous run makes it false —
// extensions, workspace state and logs all carry into the next one. The retries
// are for a window that died a moment ago and still holds its own profile.
const removeProfile = (root) => rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
// The reap comes first, and this is not a tidy-up detail: the holder of that
// profile is the corpse of a run that died, or a window --keep left on screen,
// and Windows answers EPERM on a directory somebody still has open rather than
// waiting for it. Retrying the wipe alone waits out a process nobody asked to
// leave — that is how a run ended here before it had opened anything.
export function clearProfile({ root = ROOT, reapProcesses = reap, removeProfile: remove = removeProfile } = {}) {
  reapProcesses();
  try {
    remove(root);
  } catch {
    // Killed a moment ago is not gone yet: reap again, and let the wipe try
    // once more. A second refusal is the run's to report.
    reapProcesses();
    remove(root);
  }
}

// One run at a time. Two concurrent runs share the profile under ROOT and the
// debug port: the second one's rmSync would erase the first one's window state,
// its reap would stop the first one's window, and its CDP calls would land on
// whichever instance owns --remote-debugging-port. A pid file serialises them:
// refuse while the pid in it is alive, take over only when it is not.
const heldBy = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };
let locked = false;
function acquireLock() {
  if (existsSync(LOCK)) {
    const owner = Number.parseInt(readFileSync(LOCK, "utf8"), 10);
    if (Number.isInteger(owner) && owner > 0 && heldBy(owner)) {
      throw new Error(`another host check is already running (pid ${owner}, ${LOCK}) — it owns the profile under ${ROOT} and port ${PORT}; stop it first or remove the lock if it is gone`);
    }
    log(`stale lock from pid ${owner} — taking over`);
  }
  mkdirSync(OUT, { recursive: true });
  writeFileSync(LOCK, String(process.pid));
  locked = true;
}
function releaseLock() {
  try { if (locked && readFileSync(LOCK, "utf8").trim() === String(process.pid)) rmSync(LOCK, { force: true }); } catch { /* best effort */ }
}

// Whatever ends the run — the report being written, a throw, Ctrl+C — the window
// goes back to NOTOPMOST and this run's processes stop; a harness that leaves a
// window floating above everything the user does is worse than one that fails.
// reap() is synchronous, which is what lets the exit handler use it.
let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  // A start that was refused the lock never spawned anything, and raising or
  // reaping here would touch the window of the run that does own it.
  if (!locked) return;
  // All best-effort: the instance may already be gone, and a PowerShell failure
  // here must not replace whatever is already unwinding.
  try { ps("-Mode", "raise"); } catch { /* it is gone */ }
  if (!KEEP) { try { reap(); log("host processes stopped"); } catch { /* it is gone */ } }
  releaseLock();
}

// ------------------------------------------------------------------- CDP
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((ok, no) => {
    const t = setTimeout(() => no(new Error(`ws connect timed out: ${wsUrl}`)), 10_000);
    ws.addEventListener("open", () => { clearTimeout(t); ok(); }, { once: true });
    ws.addEventListener("error", () => { clearTimeout(t); no(new Error(`ws connect failed: ${wsUrl}`)); }, { once: true });
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { ok, no } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? no(new Error(JSON.stringify(m.error))) : ok(m.result);
    }
  });
  return {
    send: (method, params = {}) =>
      new Promise((ok, no) => {
        const t = setTimeout(() => { pending.delete(id); no(new Error(`cdp timeout: ${method}`)); }, 20_000);
        pending.set(++id, { ok: (v) => { clearTimeout(t); ok(v); }, no: (e) => { clearTimeout(t); no(e); } });
        ws.send(JSON.stringify({ id, method, params }));
      }),
    close: () => ws.close(),
  };
}
const evalIn = async (c, expression) => {
  const r = await c.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed");
  return r.result.value;
};
const json = async (c, expr) => JSON.parse(await evalIn(c, `JSON.stringify(${expr})`));
// The dashboard lives in the webview's inner #active-frame document.
const DOC = "document.getElementById('active-frame').contentDocument";

// A timeout on every call: a wedged debug port must surface as an error, not a
// silent hang.
const targets = async () => (await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(5_000) })).json();

// -------------------------------------------------------- the window reload
// The same action the fallback notification offers, asked for the way a user
// would: the command palette, by keyboard, over the same debug channel the clicks
// use. Not a process restart and not a Page.reload — "Reload Window" is what the
// in-place update asks for, and a run that proved something else would be
// evidence for a different claim.
async function pressKey(c, definition) {
  await c.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...definition });
  await c.send("Input.dispatchKeyEvent", { type: "keyUp", ...definition });
}

// Typed one character at a time, as key events: the quick input is a real input
// element and filters on the events, so a single insertText can leave it showing
// an empty box (and then "Enter" picks the wrong command).
async function typeKeys(c, text) {
  for (const ch of text) {
    await c.send("Input.dispatchKeyEvent", { type: "char", text: ch, unmodifiedText: ch, key: ch });
    await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
    await sleep(25);
  }
}

// Returns whether the command was actually picked: "the window reloaded" and "the
// palette never opened" must not look the same in the report.
export async function reloadWindow(c) {
  await pressKey(c, { modifiers: 2 | 8, key: "P", code: "KeyP", windowsVirtualKeyCode: 80, nativeVirtualKeyCode: 80 });
  const opened = await wbWait(() => evalIn(c, "!!document.querySelector('.quick-input-widget input')").catch(() => false), 12, 400);
  if (!opened) { log("reload: the command palette never opened"); return false; }
  await typeKeys(c, "reload window");
  const first = await wbWait(() => evalIn(c, `(()=>{const r=document.querySelector('.quick-input-list .monaco-list-row');return r?(r.innerText||'').replace(/\\s+/g,' ').trim():null;})()`).catch(() => null), 8, 300);
  if (first === null || !/reload window/i.test(first)) { log(`reload: the palette's first match reads ${JSON.stringify(first)}`); return false; }
  // The keyUp after Enter can be answered by a dead socket: the renderer is going
  // away, and that is the whole point of this call.
  await pressKey(c, { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }).catch(() => {});
  return true;
}

// The reload replaces the page's document, not the debug target, so the question
// is "does a fresh connection answer again with a painted workbench" — and it is
// asked until it does, because a workbench that has not finished reloading is
// "not yet", not a verdict.
export async function waitForReloadedWorkbench(wsUrl) {
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    try {
      const fresh = await connect(wsUrl);
      const ready = await wbWait(() => evalIn(fresh, "document.readyState === 'complete' && !!document.querySelector('.monaco-workbench')").catch(() => false), 3, 1000);
      if (ready) return fresh;
      fresh.close();
    } catch { /* still coming back */ }
  }
  return null;
}


// A window that has painted its workbench is not yet a window whose extension
// host has loaded anything: on a busy machine the container and the view's rows
// arrive seconds later, and a miss caught at that moment is "not yet", not the
// verdict. So every question the click depends on is asked again for a bounded
// while, and only a thing that never arrives is a failure. Extracted because the
// difference between "asked once" and "asked until it arrived" is a decision, and
// decisions here are unit-tested (test/harness-host.test.ts) rather than trusted.
export async function wbWait(find, tries, gap) {
  for (let i = 0; i < tries; i++) {
    const hit = await find();
    if (hit) return hit;
    await sleep(gap);
  }
  return null;
}

// ------------------------------------------------------------------ verdict
// What an ownership scan found: the windows over the rectangle that are not this
// instance's, and how much of the rectangle was asked at all. The count is
// evidence too — "nothing in this picture belongs to another process" only means
// something if the picture was actually covered by the questions — so a scan that
// answered nothing, or whose named strangers do not add up to the number it
// counted, is a broken probe rather than a clean window. It is a pure function of
// the probe's stdout for the same reason: the way this check fails invisibly is
// by parsing nothing and calling every shot clean, and that is exactly the kind of
// decision this file tests rather than trusts.
export function ownershipScan(text, tag) {
  const summary = text.match(new RegExp(`^${tag}=points=(\\d+) step=(\\d+) strangers=(\\d+)$`, "m"));
  // The line carries the process's own image name before the window title, because
  // neither of the other two fields says who is in the picture: a pid is nobody, and
  // the title of the window that made three runs fail reads "Windows 输入体验".
  const strangers = [...text.matchAll(new RegExp(`^${tag}=(-?\\d+),(-?\\d+) pid=(\\d+) proc=(\\S*) win=(.*)$`, "gm"))]
    .map((match) => ({ x: Number(match[1]), y: Number(match[2]), pid: Number(match[3]), proc: match[4], window: match[5] }));
  // There is no rectangle small enough to sample zero points of, so zero points
  // is a probe that stopped answering — not a window with nothing over it.
  if (!summary || Number(summary[1]) === 0) throw new Error(`the ownership scan answered no points for ${tag} — nothing about this read is evidence`);
  if (strangers.length !== Number(summary[3])) throw new Error(`the ownership scan counted ${summary[3]} strangers but only ${strangers.length} of its lines were readable`);
  return { points: Number(summary[1]), step: Number(summary[2]), strangers };
}

// Which labels this harness is allowed to click. Continue / Launch are the panel's
// way of starting or resuming an agent session, and that is the user's own action —
// never this run's, isolated profile or not. The check is by label because that is
// what a click step is: a name from the page. It is a pure function so the rule is
// pinned by a test instead of by the current step list happening to be gentle.
export function clickAllowed(label) {
  return !/^\s*(continue|launch|resume)\b/i.test(label);
}

// The run's outcome as a pure function of what it observed, so it can be tested
// without a desktop (test/harness-host.test.ts). Everything it fails on used to
// be prose in the report while the process exited 0, which made a run that
// clicked nothing and opened nothing as green as one that worked.
export function verdict({ steps = [], row = null, header = null, shots = [], errors = [], footer = null, state = null }) {
  const reasons = [];
  for (const step of steps) {
    // 每个按钮被问的是它那一件事：切换分区的点击必须换掉屏幕上的字，而「刷新」的活儿
    // 是重新读一遍同一个项目——项目没变时，再画一遍同一段字正是它答对了的样子。
    // （`expectText: false` 是那一步自己声明的，不是这里替它开脱。）
    if (step.changed !== true && step.expectText !== false) reasons.push(`the ${JSON.stringify(step.label)} click left the page's text unchanged`);
    if (!(step.mutations > 0)) reasons.push(`the ${JSON.stringify(step.label)} click caused no DOM mutations`);
    // 重读按钮（expectText: false 那一个）的活儿是「问过、答过」：宿主那条 data 回来
    // 了没有，比页面动没动更早、更准——一次重读要读盘、要问 CLI 的版本，固定时刻的
    // 一眼突变数会把一次真发生了的重读读成「面板没动」。
    if (step.expectText === false && !(step.answers > 0)) {
      reasons.push(`the ${JSON.stringify(step.label)} click was never answered — the host sent no data message after it`);
    }
  }
  // 头部的三段各就各位是「看起来像参考图」的一部分，而且是最先塌的一块：窗口一窄、
  // 项目路径一长，路径就画到状态块上去了。量不到这一项不算通过——没测过与没重叠是两
  // 件事，而「量不到」不止一种：状态块没查到时 status 是 null（探针只记了一行 log），
  // 标题/路径没查到时重叠循环的几个选择器一个也没匹配上、overlaps 是空数组而不是
  // 「没有重叠」。两种都必须点名，否则一次删掉了节点的头部会安静地变绿。
  if (header === null) reasons.push("the header layout was never measured (no overlap check ran)");
  else if (header.status == null) reasons.push("the header status block was never measured (no .header-status node on the page)");
  else if (header.rects?.title == null || header.rects?.path == null) reasons.push("the header's title or path was not on the page, so the overlap check never compared them");
  else if ((header.overlaps ?? []).length > 0) reasons.push(`the project header paints ${header.overlaps.join(", ")} over the status block`);
  if (row === null) reasons.push("no session row was found on the Sessions page");
  else {
    if (row.sessionsActive !== true) reasons.push("the session click did not leave Sessions as the sidebar's current section");
    if (!(row.turns > 0)) reasons.push(`the transcript did not render (${row.turns} .transcript .turn nodes after the session click)`);
  }
  // 「CLI 已经退出，面板还写着 Running」是这一轮要关掉的 bug：判据不是"有没有刷新按钮
  // 被人点过"，而是**没有任何点击**时，外部的一次启动结束能否让面板当场改口。所以这一
  // 项要么量到了两个方向（先出现 Running，再消失），要么就是没测过——没量到与通过是两
  // 件事，"Running 一直没出现"和"出现了但没消失"也要分开点名。
  if (state === null) reasons.push("the running/idle transition was never measured (no external lease step ran)");
  else {
    if (state.running !== true) reasons.push(`the dashboard never showed Running while a launch held the lease (${state.note ?? "no pill"})`);
    if (state.idle !== true) reasons.push("the Running pill outlived the lease — the panel did not follow the launch's end on its own");
  }
  for (const shot of shots.filter((entry) => entry.occluded === true)) {
    reasons.push(`${shot.name} is a screen read of another window (pid ${shot.byPid} owned ${shot.at}) — the desk was in use, and no picture of this window was kept; the paired compositor capture of the same view is what that step has`);
  }
  // 窗口没全在桌面上时，CopyFromScreen 交回来的就是裁剩下的那一条，而它照样会被写在一个
  // 干净的名字下面——一次跑里的 05-running.png 和 final-overview.png 正是这么来的，两个
  // 19KB 的细条，本该是这一轮要交的证据。有别人的窗口压在上面是「拍不到」，窗口自己不
  // 在屏幕里是「拍到的不算」：分开点名，读者才不会把前者读成产品坏了。
  for (const shot of shots.filter((entry) => entry.partial === true)) {
    reasons.push(`${shot.name} is a screen read of ${Math.round((shot.visible ?? 0) * 100)}% of the window — the window was not on screen when the picture was taken`);
  }
  if (shots.some((entry) => entry.surface === true) && !shots.some((entry) => entry.surface === true && entry.captured === true)) {
    reasons.push("no compositor surface capture succeeded — the fallback for a blocked screen read did not work either");
  }
  // 底部那一行说的是「这台机器上真正在用的那份 Avenic CLI」，而这次跑在窗口的 PATH 上
  // 放了这个 checkout 的 CLI：面板写出来的话因此是这次跑能验证的一句，而不是环境巧合。
  // 没读到（null）与读到别的都算不通过——探针跨了两个进程边界，猜测不是证据。
  if (footer === null) reasons.push("the footer's CLI version was never read (no footer check ran)");
  else if (footer.text !== footer.expected) {
    reasons.push(`the footer reads ${JSON.stringify(footer.text || "Avenic")}, expected ${JSON.stringify(footer.expected)} — the window's PATH did not reach this repo's CLI`);
  }
  for (const line of errors) reasons.push(`the Extension Host log has an error: ${line}`);
  return { pass: reasons.length === 0, reasons };
}

// ------------------------------------------------------------------ the run
async function main() {
  const startedAt = Date.now();
  const editor = resolveEditor();
  const launcherHash = createHash("sha256").update(readFileSync(editor.launcher)).digest("hex");
  // The window binary is not hashed: it is ~150MB, and the VSIX hash below is
  // the one that identifies what is being checked.
  const exeSize = statSync(editor.exe).size;
  log(`repo ${REPO}`);
  log(`editor launcher ${editor.launcher} (sha256 ${launcherHash})`);
  log(`editor window binary ${editor.exe} (${exeSize} bytes)`);

  try {
    // Before anything destructive: the rmSync below is another run's profile if
    // one is live.
    acquireLock();
    if (!existsSync(VSIX)) {
      log("VSIX missing — building:", VSIX);
      execFileSync("npm", ["run", "package"], { cwd: `${REPO}/packages/vscode`, stdio: "inherit", shell: true });
    }
    const packaged = JSON.parse(readFileSync(`${REPO}/packages/vscode/package.json`, "utf8"));
    // Which release this run updates *from*. Resolved before anything is written,
    // because "no previous release on disk" must end the run before it destroys a
    // profile, not after it has taken shots of a window that proves nothing.
    const previous = UPGRADE ? pickPreviousVsix(vsixOnDisk(), packaged.version, FROM) : null;
    if (UPGRADE && previous === null) {
      throw new Error(`--upgrade needs a previous release's VSIX under dist/ (avenic-agent-manager-<version>.vsix, beside ${packaged.version}) — none found`);
    }
    if (previous !== null) {
      OUT = path.join(OUT, `upgrade-${previous.version}${OPEN_OLD ? "-open" : ""}`);
      log(`in-place update: ${previous.version} (${previous.file}) -> ${packaged.version} (${VSIX})${OPEN_OLD ? "; the previous release's own dashboard stays open across it" : ""}`);
    }
    // Removed, not reused — see clearProfile, which reaps the holder first.
    clearProfile();
    // ROOT 自己先落地：capture.ps1 就写在它里面，先写文件再建目录的话，
    // 第一次在干净机器上跑会在 PowerShell 那一行报「找不到这个 .ps1」。
    mkdirSync(ROOT, { recursive: true });
    writePsFile(PS_FILE);
    for (const d of [OUT, UD, EXT, path.join(UD, "User")]) mkdirSync(d, { recursive: true });
    // An earlier run's report is not this run's evidence: absent is honest, a
    // stale PASS sitting under a new run's screenshots is not.
    rmSync(`${OUT}/report.md`, { force: true });
    writeFileSync(path.join(UD, "User", "settings.json"), JSON.stringify({
      "workbench.startupEditor": "none", "telemetry.telemetryLevel": "off", "update.mode": "none",
      "extensions.autoUpdate": false, "window.restoreWindows": "none", "security.workspace.trust.enabled": false,
      "git.enabled": false, "workbench.tips.enabled": false, "workbench.colorTheme": "Default Dark Modern",
      // 面板是这个窗口的主角：副侧栏（Chat）默认收起来，窗口给面板的就是它自己的宽度。
      // 这是本 run 一次性 profile 的显示偏好，不是对产品的任何主张。
      "workbench.secondarySideBar.defaultVisibility": "hidden",
    }, null, 2));
    const sha = createHash("sha256").update(readFileSync(VSIX)).digest("hex");
    const size = statSync(VSIX).size;
    log(`VSIX sha256=${sha} size=${size}`);

    // The footer's claim, made true before the window exists to make it.
    const shim = writeCliShim();
    if (shim.version !== shim.expected) {
      throw new Error(`the CLI shim answers ${JSON.stringify(shim.output)} (version ${JSON.stringify(shim.version)}), expected ${shim.expected} — the footer would name a version this repo does not build`);
    }
    log(`CLI shim ${shim.file} -> ${JSON.stringify(shim.output)} = version ${shim.version} (from ${shim.entry})`);

    // fixture: a project of the class the product is used on, built by the
    // production calls (test/host/fixture.mjs) under this run's own directory.
    const { digest } = await buildHostFixture(PROJECT, { catalogDir: CATALOG, stateDir: STATE, home: AGENT_HOME });
    log("fixture ready:", digest.project,
      `agents ${digest.agents.map((agent) => `${agent.id}=${agent.status}`).join(" ")}`,
      `sessions shared=${digest.sessions.shared} claude=${digest.sessions.claude} codex=${digest.sessions.codex} opencode=${digest.sessions.opencode}`,
      `skills=${digest.skills.installed}/${digest.skills.packs} packs (${digest.skills.names.join(", ") || "none"})`,
      `hub=${digest.hub}`);

    const codeCli = (...args) => execFileSync("cmd.exe", ["/c", editor.launcher, "--user-data-dir", UD, "--extensions-dir", EXT, ...args], { encoding: "utf8", timeout: 180_000 });
    // Exiting 0 says the editor accepted the file; it does not say which version
    // is in the profile now. Same assertion verify-artifacts.mjs makes on the
    // released artifact, here against the profile this run actually drives.
    const expectedRow = (version) => `${packaged.publisher}.${packaged.name}@${version}`;
    const installedRow = () => {
      const listed = codeCli("--list-extensions", "--show-versions");
      const row = listed.split(/\r?\n/).map((line) => line.trim()).find((line) => /avenic/i.test(line)) ?? "";
      return { listed, row };
    };
    const installAndRequire = (file, version, what) => {
      const install = codeCli("--install-extension", file, "--force");
      const list = installedRow();
      log(`installed ${what}:`, list.row);
      if (list.row.toLowerCase() !== expectedRow(version).toLowerCase()) {
        throw new Error(`the extension list says ${JSON.stringify(list.row)} after installing ${what}, expected ${expectedRow(version)} (from packages/vscode/package.json — a stale VSIX shows up as this)`);
      }
      return install;
    };
    // The order is the whole point of --upgrade: the previous release goes in
    // first and is what the window starts with; the new one is installed later,
    // over it, while that window is running.
    let installOut = null;
    let priorInstallOut = null;
    if (previous !== null) {
      priorInstallOut = installAndRequire(previous.file, previous.version, `the previous release ${previous.version}`);
    } else {
      installOut = installAndRequire(VSIX, packaged.version, "this build");
    }
    const listOut = installedRow().listed;

    reap();
    const child = spawn(editor.exe, ["--user-data-dir", UD, "--extensions-dir", EXT, `--remote-debugging-port=${PORT}`, "--new-window", PROJECT], { detached: true, stdio: "ignore", env: windowEnvironment() });
    child.unref();
    log("launched pid", child.pid, "with", shim.file, "first on PATH");

    let wbTarget = null;
    for (let i = 0; i < 45 && !wbTarget; i++) {
      await sleep(2000);
      try { wbTarget = (await targets()).find((t) => t.type === "page" && t.url.startsWith("vscode-file://")); } catch { /* not up yet */ }
    }
    if (!wbTarget) throw new Error("VS Code workbench never came up");
    let wbc = await connect(wbTarget.webSocketDebuggerUrl);

    // Open the dashboard the way a user does — activity bar icon, then the view's
    // "Open Dashboard" row. The extension has no auto-open, so this is also what
    // proves activation works.
    const wbClick = async (x, y) => {
      await wbc.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
      await wbc.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1, buttons: 1 });
      await sleep(80);
      await wbc.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1, buttons: 0 });
      await sleep(1000);
    };
    const wbFind = async (label, scope) => json(wbc, `(()=>{for(const e of document.querySelectorAll(${JSON.stringify(scope)})){
    const a=e.querySelector('a')||e;
    const c=[a.getAttribute('aria-label'),e.getAttribute('aria-label'),e.innerText,a.getAttribute('title')].filter(Boolean).map(s=>s.replace(/\\s+/g,' ').trim());
    if(c.some(t=>t.startsWith(${JSON.stringify(label)}))){const r=e.getBoundingClientRect();
      if(r.width>0)return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};}}
    return null;})()`);

    // ------------------------------------------------------- in-place update
    // The window is running with the previous release installed. This is the
    // moment the bug report describes: the new VSIX goes in over the old one, with
    // no uninstall, while that window keeps running the old code with the new
    // manifest on disk.
    let upgrade = null;
    if (previous !== null) {
      const icon = await wbWait(() => wbFind("Avenic", ".activitybar .action-item"), 12, 2500);
      if (!icon) throw new Error(`no Avenic activity bar item with ${previous.version} installed — the previous release did not contribute its container`);
      await wbClick(icon.x, icon.y);
      let oldPage = null;
      if (OPEN_OLD) {
        // The previous release's own dashboard, opened the way its users open it:
        // the container's first view is a tree, so the page itself is the Overview
        // view's body. Whichever of the two it lands on, the report says which.
        const header = await wbWait(() => wbFind("Overview", ".pane-header"), 8, 1000);
        if (header) { await wbClick(header.x, header.y); oldPage = "Overview"; }
      }
      const paneBefore = await evalIn(wbc, "document.querySelector('.part.sidebar')?.innerText ?? ''");
      log(`before the update the sidebar reads ${JSON.stringify(paneBefore.replace(/\s+/g, " ").trim().slice(0, 160))}`);

      // --force, no uninstall first: that is the in-place update.
      const updateOut = codeCli("--install-extension", VSIX, "--force");
      const afterInstall = installedRow();
      log("after the update the profile reads", afterInstall.row);
      if (afterInstall.row.toLowerCase() !== expectedRow(packaged.version).toLowerCase()) {
        throw new Error(`after installing the new VSIX over ${previous.version} the profile reads ${JSON.stringify(afterInstall.row)}, expected ${expectedRow(packaged.version)}`);
      }

      const asked = await reloadWindow(wbc);
      let reloadedBy = asked ? "the command palette (Ctrl+Shift+P, \"Reload Window\")" : null;
      let reloaded = asked ? await waitForReloadedWorkbench(wbTarget.webSocketDebuggerUrl) : null;
      if (reloaded === null) {
        // The palette is a UI, and a UI can be missed. The fallback says so in the
        // report rather than quietly becoming a different check.
        log("reload: falling back to restarting the window process");
        reap();
        const again = spawn(editor.exe, ["--user-data-dir", UD, "--extensions-dir", EXT, `--remote-debugging-port=${PORT}`, "--new-window", PROJECT], { detached: true, stdio: "ignore", env: windowEnvironment() });
        again.unref();
        reloadedBy = "restarting the window process (the command palette did not take the reload)";
        let target = null;
        for (let i = 0; i < 45 && !target; i++) {
          await sleep(2000);
          try { target = (await targets()).find((t) => t.type === "page" && t.url.startsWith("vscode-file://")); } catch { /* not up yet */ }
        }
        if (!target) throw new Error("the window never came back after the in-place update");
        wbTarget = target;
        reloaded = await waitForReloadedWorkbench(target.webSocketDebuggerUrl);
      }
      if (reloaded === null) throw new Error("the window never finished reloading after the in-place update");
      wbc = reloaded;
      upgrade = { from: previous.version, fromFile: previous.file, openOld: OPEN_OLD, oldPage, paneBefore: paneBefore.replace(/\s+/g, " ").trim(), updateOut, updatedRow: afterInstall.row, reloadedBy, viewError: null };
      log(`updated ${previous.version} -> ${packaged.version} and reloaded by ${reloadedBy}`);
    }

    // What the activity bar's own row says, by name. The bug this run exists for
    // painted VS Code's own sentence there ("No view is registered with id:
    // avenic.launcher") instead of the extension's entry rows, and three retries
    // later that showed up as "no 'Open Dashboard' row" — which names the symptom
    // and hides the cause. Asked once the container is on screen, in both modes.
    const viewErrorText = async (where) => {
      const text = (await evalIn(wbc, "document.querySelector('.part.sidebar')?.innerText ?? ''")).replace(/\s+/g, " ").trim();
      const hit = text.match(/No view is registered with id:\s*(\S+)/i);
      if (hit !== null) {
        throw new Error(`${where}: VS Code's own "No view is registered with id: ${hit[1]}" is what the Avenic container shows — the view's provider was never registered (see packages/vscode/src/views/view-ids.ts)`);
      }
      return text;
    };

    const ROWS = ".pane-body .monaco-list-row";
    let webview = null;
    // Retried: the sidebar is still settling right after the icon click, and a row
    // click that lands mid-layout is simply lost. The icon click can be lost the
    // same way, so a missing row ends the attempt rather than the run: a window
    // that is not ready yet is "not yet", and only three misses in a row are the
    // verdict. (A run died here once, at the first miss, having never clicked the
    // row — the observation was written into a throw instead of into a retry.)
    for (let attempt = 1; attempt <= 3 && !webview; attempt++) {
      let row = await wbFind("Open Dashboard", ROWS);
      if (!row) {   // the icon toggles, so click only when hidden
        const icon = await wbWait(() => wbFind("Avenic", ".activitybar .action-item"), 12, 2500);
        if (!icon) throw new Error("no Avenic activity bar item after 30s — extension did not contribute its container");
        log("clicking activity bar icon at", icon.x, icon.y);
        await wbClick(icon.x, icon.y);
        row = await wbWait(() => wbFind("Open Dashboard", ROWS), 12, 1500);
        // Named before it is retried: if the container is painting VS Code's own
        // sentence instead of our rows, that sentence is the finding, not the
        // missing row. Throws, so it can never be recorded as "checked" without
        // having been read.
        const sidebar = await viewErrorText(UPGRADE ? "after the in-place update" : "on a fresh install");
        if (!/Open Dashboard/i.test(sidebar)) log(`sidebar reads ${JSON.stringify(sidebar.slice(0, 200))}`);
      }
      if (!row) { log(`attempt ${attempt}: launcher view has not listed 'Open Dashboard' yet`); continue; }
      log(`attempt ${attempt}: clicking 'Open Dashboard' at`, row.x, row.y);
      await wbClick(row.x, row.y); // runs avenic.dashboard.open
      for (let i = 0; i < 12 && !webview; i++) {
        await sleep(1000);
        try { webview = (await targets()).find((t) => t.url.includes(`extensionId=${EXT_ID}`)); } catch { /* opening */ }
      }
    }
    if (!webview) throw new Error("dashboard webview never appeared after 3 attempts");
    // 「读 DOM 的那个 webview」与「收到点击的那个」必须是同一个。不是的话，这一趟
    // 量到的每一次「点击没反应」都是量错了对象——面板没错，错的是问错了页面。所以
    // 数一遍：几个，哪几个，读的是哪一个。
    const homes = (await targets()).filter((t) => t.url.includes(`extensionId=${EXT_ID}`));
    log(`dashboard webview targets: ${homes.length} (${homes.map((t) => t.id ?? "?").join(", ")}) — reading the one opened first`);
    const wvc = await connect(webview.webSocketDebuggerUrl);
    await sleep(5000); // let the first paint settle

    // ---------------------------------------------------------------- capture
    // Geometry comes from the renderer, which is bound to *our* instance; the
    // window rect is only used to raise the right window for the screen read.
    const geometry = async () => json(wbc, `({ sx: window.screenX, sy: window.screenY, w: window.outerWidth, h: window.outerHeight, iw: window.innerWidth, ih: window.innerHeight, dpr: window.devicePixelRatio })`);
    const shots = [];
    let geo0 = null; // the geometry the last shot was taken with (crops are cut from it)
    // One PowerShell call per round, because each call sleeps 900ms before it
    // reads; what comes back is parsed by ownershipScan above, which refuses to
    // answer for a probe that said nothing rather than call the window clean.
    const scanOf = ownershipScan;
    // "pid 33352 (LockApp Windows 输入体验)" is a line a reader can act on; the pid
    // and the window title on their own are not.
    const byName = (stranger) => {
      if (stranger === null) return "";
      const parts = [stranger.proc, stranger.window].filter((part) => part && part !== "?");
      return ` (${parts.length > 0 ? parts.join(" ") : "no window title"})`;
    };
    // The scan already drops this instance's own pids, so anything it names is over
    // the window — including a window of the *other* process this run owns (the
    // extension host), which a pid comparison against the launched process alone
    // would have reported.
    const probe = (rect) => scanOf(ps("-Mode", "probe", "-X", String(rect.x), "-Y", String(rect.y), "-W", String(rect.w), "-H", String(rect.h)), "probe");
    const blockedBy = (scan) => scan.strangers[0] ?? null;
    const shoot = async (name) => {
      // Restore first: geometry read from a minimized window is meaningless.
      // The raise can come back without a rect (windows momentarily gone, or the
      // instance is mid-restart); cdp geometry is the primary source, so a missing
      // rect only matters when cdp is unusable too.
      const raised = ps("-Mode", "raise");
      if (/moved=1/.test(raised)) log("the window was off the desktop; moved it back inside before reading");
      const rect = raised.match(/rect=(-?\d+),(-?\d+),(\d+),(\d+)/);
      const win32 = rect ? rect.slice(1).map(Number) : null;
      const g = await geometry();
      // screenX/Y are CSS pixels; the screen read is in physical pixels. If the
      // renderer still reports a minimized position, fall back to the Win32 rect.
      const sane = g.sx > -10000 && g.w > 400;
      if (!sane && !win32) throw new Error("no window rectangle from cdp or win32");
      const x = sane ? Math.round(g.sx * g.dpr) : win32[0];
      const y = sane ? Math.round(g.sy * g.dpr) : win32[1];
      const w = sane ? Math.round(g.w * g.dpr) : win32[2];
      const h = sane ? Math.round(g.h * g.dpr) : win32[3];
      // Raising is not a promise that nothing else is above the window — other
      // topmost windows exist — so the whole rectangle is scanned for the process
      // that owns the pixels, and the raise is retried before the read.
      let pre = probe({ x, y, w, h });
      let block = blockedBy(pre);
      for (let attempt = 0; attempt < 2 && block !== null; attempt += 1) {
        log(`not on top at ${block.x},${block.y}: pid ${block.pid}${byName(block)}; raising again`);
        ps("-Mode", "raise");
        await sleep(600);
        pre = probe({ x, y, w, h });
        block = blockedBy(pre);
      }
      // The OS rectangle and the renderer's own numbers should agree now that the
      // capture is DPI-aware; when they do not, say so rather than pick silently.
      if (win32 && Math.abs(win32[2] - w) > 4) log(`geometry mismatch: win32 ${win32.join(",")} vs cdp ${x},${y},${w},${h}`);
      // A read that came back holding somebody else's window is not kept as a
      // file: it is a picture of that window, and keeping it puts a picture of
      // whatever the desk was showing into this repo's artifacts. The report
      // line carries what a reader needs (pid, process, window title, point),
      // and the paired compositor capture of the same view is the picture.
      const shootOnce = () => ps("-Mode", "window", "-OutFile", `${OUT}/${file}`, "-X", String(x), "-Y", String(y), "-W", String(w), "-H", String(h));
      let file = name;
      let out = shootOnce();
      // 快门落下的那一刻，整个矩形是谁的：探针和快门隔着一两秒，这期间冒出来的窗口
      // 对探针是不存在的，于是它会把别人的像素写在一个干净的名字下面。同一次
      // PowerShell 里、CopyFromScreen 之前再扫一遍，这个缺口就没了。
      // （它管不了另一件事：GPU 合成的窗口偶尔会被读回一块没画完的黑，而那块黑也属于
      // 本进程——扫描看不出这种读数。所以每一次读都配着一张合成面截图，那种
      // 时刻的真相在那张上。）
      let during = scanOf(out, "pre");
      // 第一次就是别人：再抬一次窗子重读一张，而不是马上判成被遮挡——上面那次探针说
      // 它就在最上面，一两秒后才被盖住的东西，多半是来了又走的。两次都是别人，才按
      // 被遮挡记（那也正是这次读真正说明的事）。
      //
      // 一次不够。挡住快门的东西常常是桌面上来了又走的浮面（任务栏的浮出、通知），
      // 它们的寿命是几秒而不是几百毫秒，所以给它几次机会、每次多等一点；判据一个字没
      // 松：只要还有一个点属于别的进程，这张照片就删掉，绝不留下别人的屏幕。
      const waits = [800, 1600, 3000];
      for (let attempt = 0; attempt < waits.length && block === null && during.strangers.length > 0; attempt += 1) {
        const who = during.strangers[0];
        log(`shot: pid ${who.pid}${byName(who)} owned ${who.x},${who.y} while the read was taken; raising and reading again (${attempt + 1}/${waits.length})`);
        ps("-Mode", "raise");
        await sleep(waits[attempt]);
        out = shootOnce();
        during = scanOf(out, "pre");
      }
      // An occluder named here as LockApp (window class Windows.UI.Core.CoreWindow, title "Windows 输入体验") is the lock screen itself: it runs on the Default desktop, so this line naming it means the workstation is locked even though LogonUI is absent and the input desktop still reads Default.
      const stolen = block ?? during.strangers[0] ?? null;
      // 读回来的像素比窗口小，就是窗口没全在桌面上：裁剪是越过桌面的矩形唯一能被读下来
      // 的样子。它不是「拍不到」，是「拍到的不算」——细条照样会被写在一个完整的名字下面，
      // 只有当名字说出它是什么，读者才不会把它当成这张窗口的照片。
      const pixels = out.match(/img=(\d+)x(\d+)/);
      const visible = pixels && w * h > 0 ? (Number(pixels[1]) * Number(pixels[2])) / (w * h) : 1;
      const partial = /\bclip=/.test(out);
      const dropped = /\bdropped=\d+/.test(out);
      if (stolen !== null) {
        if (!dropped) rmSync(`${OUT}/${file}`, { force: true });
      } else if (partial) {
        renameSync(`${OUT}/${file}`, `${OUT}/${file.replace(/\.png$/, "-partial.png")}`);
        file = file.replace(/\.png$/, "-partial.png");
      }
      const said = out.split(/\r?\n/).filter((line) => !line.startsWith("pre=")).join(" ").trim();
      geo0 = g;
      shots.push({
        name: file, screen: true, surface: false, occluded: stolen !== null, byPid: stolen?.pid ?? null, at: stolen === null ? null : `${stolen.x},${stolen.y}`,
        partial, visible, dropped,
        out: `${said} (${sane ? "cdp" : "win32"} geometry, dpr=${g.dpr}, ${stolen === null
          ? `all ${during.points} points of a ${during.step}px grid over this window belong to this instance, before and during the read${partial ? `, but only ${(visible * 100).toFixed(0)}% of the window was inside the desktop` : ""}`
          : `pid ${stolen.pid}${byName(stolen)} owns the pixels at ${stolen.x},${stolen.y} — occluded, and the read was dropped rather than kept`})`,
      });
      // The same view a few seconds later, this time from the window's own
      // compositor surface over CDP — the two pictures are paired, not
      // simultaneous. The webview is an iframe target and Chromium refuses to
      // screenshot those, so this is the whole window — but unlike a screen read it
      // is composed by the application itself and cannot be occluded by anything on
      // the desktop. It fails on a minimized window, which the report says.
      try {
        const cap = await wbc.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
        const inName = name.replace(/\.png$/, ".window.png");
        writeFileSync(`${OUT}/${inName}`, Buffer.from(cap.data, "base64"));
        shots.push({ name: inName, screen: false, surface: true, captured: true, occluded: false, out: "the window's own compositor surface, a few seconds later with no input in between" });
      } catch (error) {
        shots.push({ name: `(no surface capture for ${name})`, screen: false, surface: true, captured: false, occluded: false, out: error.message });
      }
      log("shot", file, `${w}x${h} at ${x},${y} via ${sane ? "cdp" : "win32"}`, stolen !== null ? `(occluded by pid ${stolen.pid}${byName(stolen)} — dropped, not kept)` : `(on top of every one of ${during.points} points${partial ? `; only ${(visible * 100).toFixed(0)}% of the window was on the desk` : ""})`);
    };
    const crop = (src, name, r) => {
      // Crops are cut from the surface capture, whose origin and size are the
      // page viewport's: element rectangles then need nothing but the device pixel
      // ratio. Reading them out of the screen shot would mean reconstructing the
      // window frame, and Chromium's outerWidth counts the invisible resize border
      // that screenX does not — which is how a crop ends up 20px off the element it
      // claims to show.
      const d = geo0?.dpr ?? 1;
      ps("-Mode", "crop", "-InFile", `${OUT}/${src}`, "-OutFile", `${OUT}/${name}`,
        "-X", String(Math.round(r.x * d)), "-Y", String(Math.round(r.y * d)),
        "-W", String(Math.round(r.w * d)), "-H", String(Math.round(r.h * d)), "-Scale", String(r.scale));
      shots.push({ name, screen: false, surface: false, captured: true, occluded: false, out: `crop of ${src}` });
    };

    // 头部三段有没有叠在一起。被祖先裁掉的那部分不算数（裁掉就是没画在那儿），
    // 所以每个元素的可见右边缘要一路取它在所有裁剪祖先里的最小值——这样
    // 「overflow:hidden 让它收住」不会被误报成「压在状态块上」。
    const header = await json(wvc, `(()=>{const d=${DOC};
  const r=(sel)=>{const n=d.querySelector(sel);if(!n)return null;const b=n.getBoundingClientRect();return {left:b.left,right:b.right,top:b.top,bottom:b.bottom};};
  const status=r('.header-status');
  const visibleRight=(n)=>{let right=n.getBoundingClientRect().right;
    for(let p=n.parentElement;p;p=p.parentElement){const s=getComputedStyle(p);
      if(s.overflowX!=='visible')right=Math.min(right,p.getBoundingClientRect().right);}
    return right;};
  const overlaps=[];
  if(status)for(const sel of ['.proj-title','.proj-path','#project-root']){const n=d.querySelector(sel);
    if(n&&visibleRight(n)>status.left+0.5)overlaps.push(sel);}
  return {status, overlaps, rects:{
    header:r('.proj-header'), id:r('.proj-id'), title:r('.proj-title'), path:r('.proj-path'), actions:r('.header-actions')}};})()`);
    if (header.status === null) log("header check: no .header-status node — the layout never got that far");
    else {
      log(`header check -> overlaps: ${header.overlaps.length ? header.overlaps.join(", ") : "none"}`);
      const box = (r) => (r === null ? "n/a" : `${Math.round(r.left)}..${Math.round(r.right)} (${Math.round(r.right - r.left)}w)`);
      log(`header rects -> id ${box(header.rects.id)} · title ${box(header.rects.title)} · path ${box(header.rects.path)} · status ${box(header.status)} · actions ${box(header.rects.actions)} · header ${box(header.rects.header)}`);
    }

    const before = await evalIn(wvc, `${DOC}.body.innerText`);
    await shoot("01-dashboard-open.png");

    // The webview sits at an offset inside the workbench page; the page origin is
    // the window's content origin, which screenX/Y already accounts for.
    const page = await json(wbc, `(()=>{const r=document.querySelector('iframe.webview').getBoundingClientRect();return {x:r.x,y:r.y};})()`);
    const brand = await json(wvc, `(()=>{const d=${DOC};
  const n=[...d.querySelectorAll('*')].find(x=>!x.children.length&&(x.textContent||'').trim()==='AVENIC');
  if(!n)return null;const r=n.getBoundingClientRect();
  return {x:r.x-58,y:r.y-18,w:310,h:80};})()`);
    if (brand) {
      crop("01-dashboard-open.window.png", "dashboard-brand.png", { x: page.x + brand.x, y: page.y + brand.y, w: brand.w, h: brand.h, scale: 3 });
      log("brand crop from page offset", page.x, page.y);
    }

    // ------------------------------------------------------------------ clicks
    // 点一个标签，要成立的是「点到了那个标签自己的像素」。这句话有两半，两半都错过。
    //
    // 一半是「哪个元素」：候选里既有容器（tr、class 带 row 的 div）也有真正的控件，
    // 按文档顺序取第一个，于是会话行找到的是包着标题的那个 .row-main。侧栏展开的宽度
    // 下它被拉满整行（498px），中心落在标题右边的空白上——点下去什么都没发生，面板没
    // 动是对的，错的是这次点击。所以控件优先，容器只作退路。
    //
    // 另一半是「这个元素的哪一点」：容器的中心往往不是它的字，所以按下去之前先问
    // elementFromPoint——这一点还是不是这个元素（或它的后代/祖先）。不是就改点它文字
    // 自己的中心；两个都不是就报错。盲点一下，等于把「点到了没有」交给运气，而
    // 「点了没错」正是这一步要证明的事。
    const aim = (label) => json(wvc, `(()=>{const d=${DOC};
  const same=(x)=>(x.innerText||'').trim()===${JSON.stringify(label)};
  const controls=[...d.querySelectorAll('button,a,[role=button]')];
  const node=controls.find(same)??[...d.querySelectorAll('tr,[class*=row]')].find(same);
  if(!node)return null;
  const onTarget=(p)=>{const hit=d.elementFromPoint(p.x,p.y);return hit!==null&&(hit===node||node.contains(hit)||hit.contains(node));};
  const centre=(r)=>({x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)});
  let rect=node.getBoundingClientRect();
  // 视口外的东西点不到，所以先滚进来：这一步在观察器装上之前，它自己的重排不算这次
  // 点击的功劳。
  if(rect.bottom<0||rect.top>d.defaultView.innerHeight||rect.right<0||rect.left>d.defaultView.innerWidth){
    node.scrollIntoView({block:"center"});rect=node.getBoundingClientRect();}
  let at=centre(rect);let where="element";
  if(!onTarget(at)){const range=d.createRange();range.selectNodeContents(node);
    const text=range.getBoundingClientRect();
    if(text.width>0&&text.height>0){at=centre(text);where="text";}}
  window.__aimNode=node;window.__hit=null;
  return {x:at.x,y:at.y,target:node.tagName+"."+String(node.className),control:controls.includes(node),where,onTarget:onTarget(at)};})()`);
    const click = async (label) => {
      // 启动/继续一个 agent 是用户自己的动作：这一步宁可把整次跑打断，也不点下去。
      if (!clickAllowed(label)) throw new Error(`${JSON.stringify(label)} starts an agent session, and launching or resuming one is the user's own action — this harness never clicks it`);
      const frame = await json(wbc, `(()=>{const r=document.querySelector('iframe.webview').getBoundingClientRect();return {x:r.x,y:r.y};})()`);
      const el = await aim(label);
      if (!el) throw new Error(`no clickable element labelled ${JSON.stringify(label)}`);
      if (el.onTarget !== true) {
        throw new Error(`nothing labelled ${JSON.stringify(label)} can be clicked where it is: ${el.target} at (${el.x}, ${el.y}) is not what is under that point`);
      }
      // Text equality alone is a weak signal: Refresh re-reads the same project and
      // legitimately paints the same words. Two counters say whether the panel
      // reacted at all: the mutation batches this click caused, and the data
      // messages the host sent back. The second one is what the re-read button is
      // judged on — a repaint that changes nothing is invisible, an answer is not.
      await evalIn(wvc, `(()=>{const d=${DOC};window.__mut=0;window.__data=0;
    if(!window.__dataHook){window.__dataHook=true;
      d.defaultView.addEventListener('message',(e)=>{const m=e.data;if(m&&typeof m==='object'&&m.type==='data')window.__data++;});}
    // 这一击到底落到了谁身上：页面自己收到的那个 click 事件说得最准。aim 只能证明
    // 「按下去之前，这一点上是它」；重排、被换掉的节点、另一份文档，都发生在那一瞬
    // 之后。谁收到了事件，谁才是被点的那一个。
    if(!window.__hitHook){window.__hitHook=true;
      d.defaultView.addEventListener('click',(e)=>{const n=window.__aimNode,t=e.target;
        window.__hit={target:t&&t.tagName?t.tagName+"."+String(t.className):String(t),
          aimConnected:n?n.isConnected:null,onAim:n?(t===n||n.contains(t)||t.contains(n)):null};},true);}
    new MutationObserver(()=>{window.__mut++}).observe(d.body,{subtree:true,childList:true,characterData:true});
    return true})()`);
      const x = frame.x + el.x, y = frame.y + el.y;
      await wbc.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
      await wbc.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1, buttons: 1 });
      await sleep(80);
      await wbc.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1, buttons: 0 });
      // 等的是「有反应」，不是一个固定的时长：重读一个项目要多久是项目自己的事，
      // 不是这次点击的对错，固定的一眼会把一次真发生了的重读数成「面板没动」。
      // 有反应之后再给一小段时间，让随后的几批落地。
      const reactionDeadline = Date.now() + 6000;
      const reacted = async () => Number(await evalIn(wvc, "(window.__mut || 0) + (window.__data || 0)")) > 0;
      while (Date.now() < reactionDeadline && !(await reacted())) await sleep(150);
      await sleep(500);
      // 点的是哪一个元素、点的是它的哪一点，跟着这一击一起记下来：下一回这一击没
      // 反应时，报告里先要看的就是这两样——以及第三样：谁收到了这一击，页面因此站
      // 到了哪一页。少了它们，「点击没反应」与「页面自己走岔了」长得一模一样。
      const after = await json(wvc, `(()=>{const d=${DOC};const n=d.querySelector('.nav-item[aria-current="page"]');
    return {hit:window.__hit, section:n?n.textContent.trim():null};})()`);
      const hit = { label, x, y, target: el.target, aimed: el.where, reached: after.hit, section: after.section, mutations: Number(await evalIn(wvc, "window.__mut || 0")), answers: Number(await evalIn(wvc, "window.__data || 0")) };
      log(`click ${JSON.stringify(label)} on ${el.target} at (${Math.round(x)}, ${Math.round(y)}) -> the click reached ${after.hit === null ? "nothing (no click event)" : JSON.stringify(after.hit)}; the page now stands on ${JSON.stringify(after.section)}`);
      // 每一次点击都进这本账，不只是被记进 steps 的那几个：报告里要能一眼看完这一趟
      // 到底点了哪些元素——「有没有点过哪个开始 agent 的按钮」是一眼就能回答的问题。
      clicks.push(hit);
      return hit;
    };

    const steps = [];
    const clicks = [];
    let prev = before;
    // expectText：这一步的点击该不该换掉屏幕上的字。刷新是重读同一个项目，字变不变
    // 取决于项目变没变，不是它答对答错；切分区则必须换。
    for (const [label, file, expectText] of [["Refresh", "02-click-refresh.png", false], ["Skills", "03-click-skills.png", true]]) {
      const hit = await click(label);
      await shoot(file);
      const now = await evalIn(wvc, `${DOC}.body.innerText`);
      steps.push({ label, hit, file, changed: prev !== now, mutations: hit.mutations, answers: hit.answers, expectText });
      prev = now;
    }
    // A session row lives on the Sessions page.
    await click("Sessions");
    await sleep(1200);
    const rowLabel = await evalIn(wvc, `(()=>{const d=${DOC};
  const n=[...d.querySelectorAll('*')].find(x=>/summarize the release notes|wire the retry policy/.test(x.textContent||'')&&!x.children.length);
  return n?(n.textContent||'').trim():null;})()`);
    let row = null;
    if (rowLabel) {
      const hit = await click(rowLabel);
      await shoot("04-click-session.png");
      const now = await evalIn(wvc, `${DOC}.body.innerText`);
      // Clicking a session has to open it rather than repaint the list it was
      // already showing: the sidebar marks Sessions as the current section and
      // the conversation's own turns are on the page. "The body text changed"
      // would pass on any render the click happened to trigger.
      const opened = await json(wvc, `(()=>{const d=${DOC};return {
    sessionsActive: d.querySelector('.nav-item[data-section="sessions"][aria-current="page"]') !== null,
    turns: d.querySelectorAll('.transcript .turn').length};})()`);
      row = { found: true, label: rowLabel, sessionsActive: opened.sessionsActive, turns: opened.turns };
      // 这一步红了要说清它红在哪儿：页面站在哪一页、会话那一半在不在、这一页的字是
      // 什么。没有这一句，「点击没反应」和「点到了别的行」是同一行红。
      if (opened.sessionsActive !== true || opened.turns < 1) {
        const seen = await evalIn(wvc, `(()=>{const d=${DOC};return JSON.stringify({
  nav:[...d.querySelectorAll('.nav-item')].map(n=>[n.dataset.section||'',n.textContent.trim().replace(/\\s+/g,' '),n.getAttribute('aria-current')]),
  browser:d.querySelector('.sessions-browser')!==null, transcript:d.querySelector('.transcript')!==null,
  text:(d.body.innerText||'').replace(/\\s+/g,' ').slice(0,240)})})()`);
        log(`session click diagnosis: ${seen}`);
      }
      steps.push({ label: rowLabel, hit, file: "04-click-session.png", changed: prev !== now, mutations: hit.mutations, answers: hit.answers, opened });
      log(`session click -> Sessions current: ${opened.sessionsActive}, transcript turns: ${opened.turns}`);
    } else {
      log("no session row found on the Sessions page");
      await shoot("04-click-session.png");
    }

    // ------------------------------------------- the launch that ends by itself
    // 这一轮最贵的一个 bug 是"CLI 已经退出，面板还写着 Running"。它不能靠点击来证明：
    // 用户关掉 agent 时不会顺手点一下刷新。所以这一格不点任何东西，只是从外面真的开一
    // 个启动组（core 自己的 joinLaunchGroup，和 CLI、扩展走同一条路），等面板自己改口，
    // 再真的离开那个组，等它自己改回来。判据由 verdict 把着：两个方向都量到才算过。
    //
    // 租约开始之前先站到会显示状态的那一页上：胶囊画在 agent 卡片上，卡片在概览；
    // 从别的页面量这一格，量到的是「这一页上没有胶囊」，不是「面板没跟上」。站页
    // 面的这一击在租约之前，租约期间没有任何点击——量到的仍然是面板自己改口。
    await click("Overview");
    await sleep(1200);
    const readRun = () => evalIn(wvc, `(()=>{const d=${DOC};
  const pill=[...d.querySelectorAll('.run-pill')].map(n=>(n.textContent||'').trim()).filter(Boolean);
  return {pill:[...new Set(pill)], text:(d.body.innerText||'').includes('Running')};})()`);
    const waitRun = async (want, ms) => {
      const deadline = Date.now() + ms;
      let last = null;
      while (Date.now() < deadline) {
        last = await readRun();
        if (want(last)) return last;
        await sleep(200);
      }
      return last;
    };
    // 面板有没有答、答了什么：把 webview 收到的消息记一条流水（只记类型，status 连
    // runs 一起记）。「页面上没有 Running」有两种完全不同的原因——面板没答，和面板答
    // 了而状态没到这一页——流水把这两种分开。
    await evalIn(wvc, `(()=>{const d=${DOC};window.__msgs=[];
  if(!window.__msgHook){window.__msgHook=true;
    d.defaultView.addEventListener('message',(e)=>{const m=e.data;if(m&&typeof m==='object'&&m.type){
      window.__msgs.push(m.type==='status'?('status '+JSON.stringify(m.runs)):m.type);
      if(window.__msgs.length>24)window.__msgs.shift();}});}
  return true})()`);
    let state = null;
    try {
      const { joinLaunchGroup } = await import("../../../../packages/core/src/index.mjs");
      const group = await joinLaunchGroup(PROJECT, "claude", { environment: windowEnvironment() });
      const heldAt = Date.now();
      const appeared = await waitRun((seen) => seen.text, 6000);
      const appearedMs = Date.now() - heldAt;
      await shoot("05-running.png");
      const releasedAt = Date.now();
      await group.release();
      const cleared = await waitRun((seen) => !seen.text, 6000);
      const clearedMs = Date.now() - releasedAt;
      await shoot("06-idle.png");
      const trail = await evalIn(wvc, "JSON.stringify(window.__msgs || [])");
      log(`messages the webview received during the lease: ${trail}`);
      state = {
        running: appeared?.text === true,
        idle: cleared?.text === false,
        appearedMs,
        clearedMs,
        note: `pill while held: ${JSON.stringify(appeared?.pill ?? [])}, gone ${clearedMs} ms after the lease was released, messages: ${trail}`,
      };
      log(`running/idle by lease alone -> running: ${state.running} (${appearedMs} ms), idle: ${state.idle} (${clearedMs} ms after release)`);
    } catch (error) {
      state = { running: false, idle: false, note: `the lease step failed: ${error.message}` };
      log(`running/idle step failed: ${error.message}`);
    }

    // ---------------------------------------------------- the artifact shot
    // What this run is for: the dashboard as it stands after the clicks above
    // have shown it is live, back on Overview and scrolled to the top, with the
    // editor's own sidebar out of the way so the panel is the whole picture —
    // the same framing the design reference uses. Ctrl+B through CDP is the
    // same class of input as the clicks above (the OS cursor is never used);
    // if the window does not take it the shot is simply narrower, so it is
    // best-effort and the footer below is what the report checks.
    await click("Overview");
    await evalIn(wvc, "window.scrollTo(0, 0)");
    await wbc.send("Input.dispatchKeyEvent", { type: "keyDown", modifiers: 2, key: "b", code: "KeyB", windowsVirtualKeyCode: 66, nativeVirtualKeyCode: 66 });
    await wbc.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 2, key: "b", code: "KeyB", windowsVirtualKeyCode: 66, nativeVirtualKeyCode: 66 });
    await sleep(1500);
    await evalIn(wvc, "window.scrollTo(0, 0)");
    // Named for the claim it is evidence for: this is where the release's two
    // screenshots come from — a fresh install and an in-place update.
    const finalShot = upgrade === null ? "final-overview.png" : "final-overview-upgrade.png";
    await shoot(finalShot);
    // The footer line, read off the page rather than assumed from the shim: the
    // probe crosses two process boundaries between this harness and the panel,
    // and "the window was started with the shim on PATH" is not the same
    // statement as "the footer reads this repo's CLI".
    const footer = await json(wvc, `(()=>{const d=${DOC};const n=d.getElementById('version');
  return { text: (n ? n.textContent : '').trim(), line: (d.getElementById('version-line')?.textContent ?? '').trim() };})()`);
    log(`footer reads ${JSON.stringify(footer.line)}; expected ${JSON.stringify(FOOTER_LINE)}`);

    // The profile's own answer to "which version is installed now", read at the
    // end of the run: after an in-place update this is the one place where the
    // whole sequence (install over, reload, drive the panel) is answered by the
    // thing that owns the truth rather than by the installer's exit code.
    const listFinal = previous === null ? null : installedRow();
    // 与 installAndRequire 同一条比较：`code --list-extensions` 打的是清单里那个
    // publisher 的原文（echokang），清单写的是 EchoKang —— 只有大小写不同。行里找
    // 大小写也辨的那一行，别用 includes 去碰一个区分大小写的字符串。
    if (listFinal !== null && listFinal.row.toLowerCase() !== expectedRow(packaged.version).toLowerCase()) {
      throw new Error(`after the run the profile reads ${JSON.stringify(listFinal.row)}, expected ${expectedRow(packaged.version)}`);
    }

    // ---------------------------------------------------- Extension Host log
    // The profile was recreated above, so its logs are this run's; the mtime
    // filter is the belt to that brace, because VS Code can keep a log directory
    // from an earlier window open — which is how one report ended up listing five
    // runs under a single header.
    const logsDir = path.join(UD, "logs");
    const logFiles = [];
    const staleLogs = [];
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/exthost.*\.log$/i.test(e.name) || /avenic/i.test(e.name)) {
          if (statSync(p).mtimeMs >= startedAt) logFiles.push(p);
          else staleLogs.push(p);
        }
      }
    };
    if (existsSync(logsDir)) walk(logsDir);
    const logEntries = logFiles.flatMap((file) => {
      const ours = /avenic/i.test(file);
      return readFileSync(file, "utf8").split(/\r?\n/)
        .filter((line) => /avenic|ERROR|WARN/i.test(line))
        .map((line) => ({ ours, text: `${path.relative(UD, file)}: ${line.trim()}` }));
    }).slice(0, 40);
    const logLines = logEntries.map((entry) => entry.text);
    // Only this extension's own errors count against the run: exthost.log is
    // shared with every other extension, and a red from somebody else's failure
    // says nothing about this build.
    const errors = logEntries.filter((entry) => /\bERROR\b/i.test(entry.text) && (entry.ours || /avenic/i.test(entry.text))).map((entry) => entry.text);

    // 报告里的夹具一节写的是卡片上真正有的那几行（digest 来自面板自己调用的那个
    // buildDashboardData），不是这份文件里手抄的期望值。
    const cardOf = (id) => digest.agents.find((agent) => agent.id === id) ?? { status: "?", fields: [] };
    const cardLines = ["claude", "codex", "opencode"]
      .map((id) => `- ${id}: ${cardOf(id).status} — ${cardOf(id).fields.join(" · ")}`).join("\n");
    const outcome = verdict({ steps, row, header, shots, errors, footer: { text: footer.text, expected: FOOTER_LINE }, state });
    writeFileSync(`${OUT}/report.md`, `# Avenic VS Code Extension Host check

## Verdict: ${outcome.pass ? "PASS" : "FAIL"}

${outcome.pass
    ? "Every click made the panel react (the ones that switch what the page shows changed it; Refresh repainted the same project, which is what a re-read of unchanged state looks like), the session opened with its transcript, the footer names this repo's CLI, every screen read is this instance's, and the Extension Host log has no errors from this extension."
    : outcome.reasons.map((reason) => `- ${reason}`).join("\n")}

Generated ${new Date().toISOString()} by \`packages/vscode/test/host/run.mjs\`; the run started ${new Date(startedAt).toISOString()}.

## Artifact
- VSIX: \`${VSIX}\`
- sha256: \`${sha}\`
- size: ${size} bytes

## Toolchain
- repo: \`${REPO}\`
- editor launcher: \`${editor.launcher}\` (sha256 \`${launcherHash}\`)
- editor window binary: \`${editor.exe}\` (${exeSize} bytes)

## Install
${upgrade === null
    ? `\`\`\`\n${installOut.trim()}\n\`\`\``
    : `This is an **in-place update** run: the profile was given the previous release (\`${upgrade.fromFile}\`) first, the window was started with it — ${upgrade.openOld ? `its own dashboard page (${upgrade.oldPage ?? "the container's first view"}) left open across the update` : "the extension merely installed, no page of it opened"} — and the new VSIX was then installed over it with \`--force\` and no uninstall, with that window still running.

\`\`\`
${priorInstallOut.trim()}
\`\`\`

Installed over it while the window ran:

\`\`\`
${upgrade.updateOut.trim()}
\`\`\``}

The previous release's sidebar, read just before the update landed:
\`\`\`
${upgrade === null ? "—" : upgrade.paneBefore.slice(0, 400) || "(empty)"}
\`\`\`

\`code --list-extensions --show-versions\` after the run:
\`\`\`
${(listFinal?.listed ?? listOut).trim()}
\`\`\`

Isolated profile: \`${UD}\` + \`${EXT}\` — removed and recreated for this run; your real profile's settings and extensions were not read or written (VS Code opens its own shared-storage database outside the profile either way). The window also runs with the Avenic state root inside this run (\`AVENIC_STATE_DIR=${STATE}\`), so what it reads about Skills is this fixture's catalog and nothing it writes can land in the machine's own state directory.

## Footer
The dashboard's version line is the CLI the extension finds on its own PATH. This run starts the window with a throwaway bin directory first on PATH holding one \`avenic.cmd\` that runs this checkout's CLI:

- shim: \`${shim.file}\` → \`${shim.entry}\`
- the shim answers \`avenic --version\` with \`${shim.output}\` (checked before the window was started)
- the footer on screen reads **\`${footer.text || "Avenic"}\`**, expected \`${FOOTER_LINE}\`

## Fixture
\`${PROJECT}\`, built by the production calls (test/host/fixture.mjs; \`initialize\` for all three agents, \`writeApiConfiguration\`, the real catalog + \`installPacks\`, and \`importProjectSessions\` for each agent's own portable store):

The cards, as the panel reads them back (fields in the order the card paints them):
${cardLines}

- Claude is \`API (Project)\`, and the model block below \`Model\` is the file's own configuration.
- Codex is \`Account (Project)\`: a project-scoped account is the agent's own sign-in, so a fixture that never logs in reads "Not signed in" — Avenic does not invent one.
- OpenCode records only the session scope; its authentication, provider and model are its own.
- sessions: ${digest.sessions.claude} Claude, ${digest.sessions.codex} Codex, ${digest.sessions.opencode} OpenCode (${digest.sessions.shared} canonical)
- Skills: ${digest.skills.installed} installed, ${digest.skills.packs} packs from the fixture catalog, Hub ${digest.hub}
- every credential-shaped string says "fixture"; the Claude model block in \`.claude/settings.local.json\` (\`env.ANTHROPIC_DEFAULT_*\`, \`CLAUDE_CODE_SUBAGENT_MODEL\`, \`CLAUDE_CODE_EFFORT_LEVEL\`) is what an earlier Avenic or the user left in the file Avenic wrote, not something this run asks Avenic to own

No agent was launched and no session was resumed.

## In-place update
${upgrade === null
    ? "Not this run: this is the fresh-install scenario (activity bar icon → the view's row → dashboard). Run it with `--upgrade` for the Marketplace update case."
    : `- previous release: \`${upgrade.from}\` (\`${upgrade.fromFile}\`)
- installed over it, no uninstall, window running: **${upgrade.updatedRow}**
- what was on screen when the update landed: ${upgrade.openOld ? `the previous release's own dashboard page (${upgrade.oldPage ?? "the container's first view"})` : "the previous release's container, no page of it opened"}
- reload: **${upgrade.reloadedBy}**
- the Avenic container after the reload: **no \`No view is registered with id: …\` anywhere in the sidebar** (the run throws on that sentence — it is the one this scenario exists for), the view's own rows are there, and the dashboard it opens passes every check below`}

## Screenshots
${shots.map((s) => `- \`${OUT}/${s.name}\` — ${s.out}`).join("\n")}

## Header layout
The project header's three parts (title, path, status block) measured in the webview:
**${header.overlaps.length === 0 ? "each stays inside its own column" : `painted over the status block: ${header.overlaps.join(", ")}`}**
(the right edge of each element is clamped by every clipping ancestor, so an ellipsised path counts as inside).

## Clicks (injected via CDP, not the OS cursor)
${clicks.map((c) => `\`${c.label}\` → ${c.target}`).join(" · ") || "_none_"} — every element any label resolved to. The session row was opened by its *title* (\`viewSession\` → the transcript); no Continue or Launch was clicked, and \`clickAllowed\` refuses such a label outright (starting an agent is the user's action, not this run's).

${steps.map((s) => `- \`${s.label}\` at workbench (${s.hit.x}, ${s.hit.y})${s.hit.target ? ` (${s.hit.target}${s.hit.aimed === "text" ? ", aimed at its text" : ""})` : ""} → \`${s.file}\`, body text changed: **${s.changed}**${s.expectText === false ? " (not required for this button — it re-reads the same project)" : ""}, DOM mutations caused by the click: **${s.mutations}**, data messages the host sent back: **${s.answers ?? "n/a"}**, the click reached **${s.hit.reached === undefined || s.hit.reached === null ? "nothing (no click event)" : `${s.hit.reached.target}${s.hit.reached.onAim === true ? "" : " (not the element aimed at)"}`}**, the page then stood on **${JSON.stringify(s.hit.section ?? null)}**${s.opened ? `, Sessions marked current: **${s.opened.sessionsActive}**, transcript turns rendered: **${s.opened.turns}**` : ""}`).join("\n") || "_none_"}

## The launch that ended by itself
Nothing is clicked between taking the lease and releasing it; the panel is only read.

- Running showed up while an external lease was held: **${state?.running === true}**${state?.appearedMs === undefined ? "" : ` (${state.appearedMs} ms after the lease was taken)`}
- the pill went away on its own after the lease was released: **${state?.idle === true}**${state?.clearedMs === undefined ? "" : ` (${state.clearedMs} ms after release)`}
- what was on screen while the lease was held: \`${state?.note ?? "not measured"}\`

## Extension Host log
Only log files written at or after this run started are listed${staleLogs.length ? ` (${staleLogs.length} from earlier runs ignored)` : ""}.
${logLines.length ? "```\n" + logLines.join("\n") + "\n```" : "_no lines mentioning avenic, and no ERROR/WARN lines._"}
`);
    log("report:", `${OUT}/report.md`);
    log(`verdict: ${outcome.pass ? "PASS" : "FAIL"}`);
    for (const reason of outcome.reasons) log(`  reason: ${reason}`);
    for (const s of steps) log(`click ${JSON.stringify(s.label)} -> ${s.hit.target ?? "?"} ${s.hit.aimed ?? ""} changed=${s.changed} mutations=${s.mutations} answers=${s.answers ?? "n/a"}`);
    log(`clicks this run made: ${clicks.map((c) => `${JSON.stringify(c.label)} -> ${c.target}`).join(", ")}`);
    process.exitCode = outcome.pass ? 0 : 1;
  } finally {
    cleanup();
  }
}

// Entry guard, not a bare call: importing this file (its verdict is tested
// without an editor) must not boot a window or reap anything.
const isEntry = process.argv[1] !== undefined && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isEntry) {
  // Ctrl+C is the way a hung run actually ends, and a topmost window outliving it
  // is the worst thing this harness can leave behind.
  process.on("exit", cleanup);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => { cleanup(); process.exit(signal === "SIGINT" ? 130 : 143); });
  }
  await main();
}
