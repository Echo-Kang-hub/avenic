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
// above; if it stays occluded the file is saved with `-occluded` in its name,
// because a picture that is not of this window must not be readable as one that
// is. The surface capture cannot be occluded at all, so a busy desktop cannot
// quietly turn the evidence into a picture of somebody else's window.
//
// The run ends in a verdict: a click that changed nothing, a session that did
// not open, a screen read of another window, a lost compositor fallback or an
// error in the extension's own log fail it, and the process exits non-zero — a
// green run is one where the checks ran and passed. However it ends, the window
// is dropped back to NOTOPMOST and this run's processes are reaped (--keep
// leaves the window up to look at).
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
// Usage: node packages/vscode/test/host/run.mjs [--keep]
//   expects packages/vscode/dist/avenic-agent-manager.vsix (npm run package).
//   The editor comes from AVENIC_VSCODE_BIN or from `code` on PATH; the paths
//   actually used are printed and recorded in the report.

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
const OUT = `${REPO}/dist/host-check`;
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
 $step=40;$inset=8;$n=0;$strangers=@()
 for($y=$py+$inset;$y -lt $py+$ph-$inset;$y+=$step){
  for($x=$px+$inset;$x -lt $px+$pw-$inset;$x+=$step){
   $n++
   $h=[Win]::HandleAt($x,$y);$owner=[Win]::PidOf($h)
   # This instance's own windows are not intruders: the panel is one process and the
   # extension host another, and both are ours to be in the picture.
   if($pids -notcontains $owner){$strangers+=($tag+$x+","+$y+" pid="+$owner+" win="+[Win]::NameOf($h))}}}
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
   $biggest=[pscustomobject]@{area=$area;L=$r.Left;T=$r.Top;W=$r.Right-$r.Left;H=$r.Bottom-$r.Top}}}
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
 foreach($wnd in $mine){
  [void][Win]::SetWindowPos($wnd,[IntPtr]::new(-2),0,0,0,0,0x0010 -bor 0x0001 -bor 0x0002)}
 Write-Output "rect=$($biggest.L),$($biggest.T),$($biggest.W),$($biggest.H)";exit 0
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
Get-Owners "pre=" $X $Y $W $H
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
  const strangers = [...text.matchAll(new RegExp(`^${tag}=(-?\\d+),(-?\\d+) pid=(\\d+) win=(.*)$`, "gm"))]
    .map((match) => ({ x: Number(match[1]), y: Number(match[2]), pid: Number(match[3]), window: match[4] }));
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
export function verdict({ steps = [], row = null, header = null, shots = [], errors = [], footer = null }) {
  const reasons = [];
  for (const step of steps) {
    // 每个按钮被问的是它那一件事：切换分区的点击必须换掉屏幕上的字，而「刷新」的活儿
    // 是重新读一遍同一个项目——项目没变时，再画一遍同一段字正是它答对了的样子。
    // （`expectText: false` 是那一步自己声明的，不是这里替它开脱。）
    if (step.changed !== true && step.expectText !== false) reasons.push(`the ${JSON.stringify(step.label)} click left the page's text unchanged`);
    if (!(step.mutations > 0)) reasons.push(`the ${JSON.stringify(step.label)} click caused no DOM mutations`);
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
  for (const shot of shots.filter((entry) => entry.occluded === true)) {
    reasons.push(`${shot.name} is a screen read of another window (pid ${shot.byPid} owned ${shot.at})`);
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
    // Removed, not reused: "installs into a clean profile" is a claim the report
    // makes, and a profile left over from the previous run makes it false —
    // extensions, workspace state and logs all carry into the next one.
    //
    // Retried: a window that was killed a moment ago (or one left up by --keep)
    // still holds its own profile open for a moment, and Windows answers EPERM
    // rather than waiting — which ended a run before it had opened anything.
    rmSync(ROOT, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
    // ROOT 自己先落地：capture.ps1 就写在它里面，先写文件再建目录的话，
    // 第一次在干净机器上跑会在 PowerShell 那一行报「找不到这个 .ps1」。
    mkdirSync(ROOT, { recursive: true });
    writeFileSync(PS_FILE, PS);
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
    const installOut = codeCli("--install-extension", VSIX, "--force");
    const listOut = codeCli("--list-extensions", "--show-versions");
    log("installed:", listOut.trim());
    // Exiting 0 says the editor accepted the file; it does not say which version
    // is in the profile now. Same assertion verify-artifacts.mjs makes on the
    // released artifact, here against the profile this run actually drives.
    const packaged = JSON.parse(readFileSync(`${REPO}/packages/vscode/package.json`, "utf8"));
    const expectedInstalled = `${packaged.publisher}.${packaged.name}@${packaged.version}`;
    const listedRow = listOut.split(/\r?\n/).map((line) => line.trim()).find((line) => /avenic/i.test(line)) ?? "";
    if (listedRow.toLowerCase() !== expectedInstalled.toLowerCase()) {
      throw new Error(`the extension list says ${JSON.stringify(listedRow)}, expected ${expectedInstalled} (from packages/vscode/package.json — a stale VSIX shows up as this)`);
    }

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
    const wbc = await connect(wbTarget.webSocketDebuggerUrl);

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
    const byName = (stranger) => (stranger === null ? "" : ` (${stranger.window || "no window title"})`);
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
      const raised = ps("-Mode", "raise").match(/rect=(-?\d+),(-?\d+),(\d+),(\d+)/);
      const win32 = raised ? raised.slice(1).map(Number) : null;
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
      // An occluded read is still taken — it is the only picture of the real
      // editor — but it is not saved under a clean shot's name: `-occluded` in
      // the filename is the part of the evidence a reader cannot miss, and the
      // report carries the point and the pid that were on top.
      const shootOnce = () => ps("-Mode", "window", "-OutFile", `${OUT}/${file}`, "-X", String(x), "-Y", String(y), "-W", String(w), "-H", String(h));
      let file = block === null ? name : name.replace(/\.png$/, "-occluded.png");
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
      if (block === null && during.strangers.length > 0) {
        const who = during.strangers[0];
        log(`shot: pid ${who.pid}${byName(who)} owned ${who.x},${who.y} while the read was taken; raising and reading again`);
        ps("-Mode", "raise");
        await sleep(600);
        out = shootOnce();
        during = scanOf(out, "pre");
      }
      const stolen = block ?? during.strangers[0] ?? null;
      if (stolen !== block && stolen !== null) {
        renameSync(`${OUT}/${file}`, `${OUT}/${file.replace(/\.png$/, "-occluded.png")}`);
        file = file.replace(/\.png$/, "-occluded.png");
      }
      const said = out.split(/\r?\n/).filter((line) => !line.startsWith("pre=")).join(" ").trim();
      geo0 = g;
      shots.push({
        name: file, screen: true, surface: false, occluded: stolen !== null, byPid: stolen?.pid ?? null, at: stolen === null ? null : `${stolen.x},${stolen.y}`,
        out: `${said} (${sane ? "cdp" : "win32"} geometry, dpr=${g.dpr}, ${stolen === null
          ? `all ${during.points} points of a ${during.step}px grid over this window belong to this instance, before and during the read`
          : `pid ${stolen.pid}${byName(stolen)} owns the pixels at ${stolen.x},${stolen.y} — occluded`})`,
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
      log("shot", file, `${w}x${h} at ${x},${y} via ${sane ? "cdp" : "win32"}`, stolen === null ? `(on top of every one of ${during.points} points)` : `(occluded by pid ${stolen.pid}${byName(stolen)})`);
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
      // legitimately paints the same words. Counting the DOM mutations the click
      // causes says whether the panel reacted at all.
      await evalIn(wvc, `(()=>{const d=${DOC};window.__mut=0;
    new MutationObserver(()=>{window.__mut++}).observe(d.body,{subtree:true,childList:true,characterData:true});
    return true})()`);
      const x = frame.x + el.x, y = frame.y + el.y;
      await wbc.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
      await wbc.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1, buttons: 1 });
      await sleep(80);
      await wbc.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1, buttons: 0 });
      await sleep(1600);
      // 点的是哪一个元素、点的是它的哪一点，跟着这一击一起记下来：下一回这一击没
      // 反应时，报告里先要看的就是这两样。
      const hit = { label, x, y, target: el.target, aimed: el.where, mutations: Number(await evalIn(wvc, "window.__mut || 0")) };
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
      steps.push({ label, hit, file, changed: prev !== now, mutations: hit.mutations, expectText });
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
      steps.push({ label: rowLabel, hit, file: "04-click-session.png", changed: prev !== now, mutations: hit.mutations, opened });
      log(`session click -> Sessions current: ${opened.sessionsActive}, transcript turns: ${opened.turns}`);
    } else {
      log("no session row found on the Sessions page");
      await shoot("04-click-session.png");
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
    await shoot("final-overview.png");
    // The footer line, read off the page rather than assumed from the shim: the
    // probe crosses two process boundaries between this harness and the panel,
    // and "the window was started with the shim on PATH" is not the same
    // statement as "the footer reads this repo's CLI".
    const footer = await json(wvc, `(()=>{const d=${DOC};const n=d.getElementById('version');
  return { text: (n ? n.textContent : '').trim(), line: (d.getElementById('version-line')?.textContent ?? '').trim() };})()`);
    log(`footer reads ${JSON.stringify(footer.line)}; expected ${JSON.stringify(FOOTER_LINE)}`);

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
    const outcome = verdict({ steps, row, header, shots, errors, footer: { text: footer.text, expected: FOOTER_LINE } });
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
\`\`\`
${installOut.trim()}
\`\`\`
\`code --list-extensions --show-versions\`:
\`\`\`
${listOut.trim()}
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

## Screenshots
${shots.map((s) => `- \`${OUT}/${s.name}\` — ${s.out}`).join("\n")}

## Header layout
The project header's three parts (title, path, status block) measured in the webview:
**${header.overlaps.length === 0 ? "each stays inside its own column" : `painted over the status block: ${header.overlaps.join(", ")}`}**
(the right edge of each element is clamped by every clipping ancestor, so an ellipsised path counts as inside).

## Clicks (injected via CDP, not the OS cursor)
${clicks.map((c) => `\`${c.label}\` → ${c.target}`).join(" · ") || "_none_"} — every element any label resolved to. The session row was opened by its *title* (\`viewSession\` → the transcript); no Continue or Launch was clicked, and \`clickAllowed\` refuses such a label outright (starting an agent is the user's action, not this run's).

${steps.map((s) => `- \`${s.label}\` at workbench (${s.hit.x}, ${s.hit.y})${s.hit.target ? ` (${s.hit.target}${s.hit.aimed === "text" ? ", aimed at its text" : ""})` : ""} → \`${s.file}\`, body text changed: **${s.changed}**${s.expectText === false ? " (not required for this button — it re-reads the same project)" : ""}, DOM mutations caused by the click: **${s.mutations}**${s.opened ? `, Sessions marked current: **${s.opened.sessionsActive}**, transcript turns rendered: **${s.opened.turns}**` : ""}`).join("\n") || "_none_"}

## Extension Host log
Only log files written at or after this run started are listed${staleLogs.length ? ` (${staleLogs.length} from earlier runs ignored)` : ""}.
${logLines.length ? "```\n" + logLines.join("\n") + "\n```" : "_no lines mentioning avenic, and no ERROR/WARN lines._"}
`);
    log("report:", `${OUT}/report.md`);
    log(`verdict: ${outcome.pass ? "PASS" : "FAIL"}`);
    for (const reason of outcome.reasons) log(`  reason: ${reason}`);
    for (const s of steps) log(`click ${JSON.stringify(s.label)} -> ${s.hit.target ?? "?"} ${s.hit.aimed ?? ""} changed=${s.changed} mutations=${s.mutations}`);
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
