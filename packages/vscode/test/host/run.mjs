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
// editor, so it is probed at five points for the process that owns the pixels
// and repeated if another window is above; if it stays occluded the file is
// saved with `-occluded` in its name, because a picture that is not of this
// window must not be readable as one that is. The surface capture cannot be
// occluded at all, so a busy desktop cannot quietly turn the evidence into a
// picture of somebody else's window.
//
// The run ends in a verdict: a click that changed nothing, a session that did
// not open, a screen read of another window, a lost compositor fallback or an
// error in the extension's own log fail it, and the process exits non-zero — a
// green run is one where the checks ran and passed. However it ends, the window
// is dropped back to NOTOPMOST and this run's processes are reaped (--keep
// leaves the window up to look at).
//
// Nothing here launches or resumes an agent session. The fixture is synthetic.
//
// Usage: node packages/vscode/test/host/run.mjs [--keep]
//   expects packages/vscode/dist/avenic-agent-manager.vsix (npm run package).
//   The editor comes from AVENIC_VSCODE_BIN or from `code` on PATH; the paths
//   actually used are printed and recorded in the report.

import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

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
const PROJECT = path.join(ROOT, "project");
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
}
"@
if(-not("Win" -as [type])){Add-Type -TypeDefinition $cs -Language CSharp}

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

# Restore + raise every window this profile owns, so the capture below cannot be
# occluded and the renderer reports real screen geometry (a minimized Electron
# window reports screenX -31999).
$pids=@(Get-CimInstance Win32_Process -Filter "Name='Code.exe'"|Where-Object{$_.CommandLine -like "*avenic-host-check*"}|Select-Object -ExpandProperty ProcessId)
$biggest=$null
foreach($p in $pids){foreach($wnd in [Win]::Handles($p)){
 [void][Win]::ShowWindow($wnd,9)
 [void][Win]::SetWindowPos($wnd,[IntPtr]::new(-1),0,0,0,0,0x0010 -bor 0x0001 -bor 0x0002 -bor 0x0040)
 $r=New-Object Win+RECT;[void][Win]::GetWindowRect($wnd,[ref]$r)
 $area=($r.Right-$r.Left)*($r.Bottom-$r.Top)
 if(-not $biggest -or $area -gt $biggest.area){
   $biggest=[pscustomobject]@{area=$area;L=$r.Left;T=$r.Top;W=$r.Right-$r.Left;H=$r.Bottom-$r.Top}}}}
Start-Sleep -Milliseconds 900

# What is on top at a point, and whose process owns it: raising the window is
# not a promise that nothing else is above it, so the report says which pid the
# capture actually looked at instead of assuming it was ours. Five points, not
# one: a window covering the sidebar leaves the centre ours, and a centre-only
# probe would call that shot clean while the file held somebody else's pixels.
if($Mode -eq "probe"){
 $ix=[int]($W*0.1);$iy=[int]($H*0.1)
 $pts=@((($X+$ix),($Y+$iy)),(($X+$W-$ix),($Y+$iy)),(($X+$ix),($Y+$H-$iy)),(($X+$W-$ix),($Y+$H-$iy)),(($X+[int]($W/2)),($Y+[int]($H/2))))
 foreach($p in $pts){
  $pt=New-Object Win+POINT;$pt.X=[int]$p[0];$pt.Y=[int]$p[1]
  $top=[Win]::WindowFromPoint($pt)
  [uint32]$owner=0;[void][Win]::GetWindowThreadProcessId($top,[ref]$owner)
  Write-Output ("probe=" + $pt.X + "," + $pt.Y + " pid=" + $owner)}
 exit 0
}

if($Mode -eq "raise"){
 foreach($p in $pids){foreach($wnd in [Win]::Handles($p)){
  [void][Win]::SetWindowPos($wnd,[IntPtr]::new(-2),0,0,0,0,0x0010 -bor 0x0001 -bor 0x0002)}}
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
$bmp=New-Object System.Drawing.Bitmap($W,$H)
$g=[System.Drawing.Graphics]::FromImage($bmp);$g.CopyFromScreen($X,$Y,0,0,$bmp.Size);$g.Dispose()
$img="" + $bmp.Width + "x" + $bmp.Height
$bmp.Save($OutFile,[System.Drawing.Imaging.ImageFormat]::Png);$bmp.Dispose()
foreach($p in $pids){foreach($wnd in [Win]::Handles($p)){
 [void][Win]::SetWindowPos($wnd,[IntPtr]::new(-2),0,0,0,0,0x0010 -bor 0x0001 -bor 0x0002)}}
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
// The run's outcome as a pure function of what it observed, so it can be tested
// without a desktop (test/harness-host.test.ts). Everything it fails on used to
// be prose in the report while the process exited 0, which made a run that
// clicked nothing and opened nothing as green as one that worked.
export function verdict({ steps = [], row = null, header = null, shots = [], errors = [] }) {
  const reasons = [];
  for (const step of steps) {
    // 每个按钮被问的是它那一件事：切换分区的点击必须换掉屏幕上的字，而「刷新」的活儿
    // 是重新读一遍同一个项目——项目没变时，再画一遍同一段字正是它答对了的样子。
    // （`expectText: false` 是那一步自己声明的，不是这里替它开脱。）
    if (step.changed !== true && step.expectText !== false) reasons.push(`the ${JSON.stringify(step.label)} click left the page's text unchanged`);
    if (!(step.mutations > 0)) reasons.push(`the ${JSON.stringify(step.label)} click caused no DOM mutations`);
  }
  // 头部的三段各就各位是「看起来像参考图」的一部分，而且是最先塌的一块：窗口一窄、
  // 项目路径一长，路径就画到状态块上去了。量不到这一项不算通过——没测过与没重叠
  // 是两件事。
  if (header === null) reasons.push("the header layout was never measured (no overlap check ran)");
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
    rmSync(ROOT, { recursive: true, force: true });
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
    }, null, 2));
    const sha = createHash("sha256").update(readFileSync(VSIX)).digest("hex");
    const size = statSync(VSIX).size;
    log(`VSIX sha256=${sha} size=${size}`);

    // fixture: real core config + synthetic transcripts (temp dir only)
    const core = await import(`file:///${REPO}/packages/core/src/index.mjs`);
    for (const agent of ["claude", "codex"]) {
      await core.initializeAgent(PROJECT, agent, { authMethod: "account", accountScope: "project", sessionScope: "project" });
    }
    const sessionsDir = path.join(PROJECT, ".agents", "sessions", "claude");
    mkdirSync(sessionsDir, { recursive: true });
    const transcript = (sid, uuid, ts, model, text) => ["user", "assistant"].map((role, i) => JSON.stringify({
      type: role, uuid: `${uuid}-${role}`, sessionId: sid, timestamp: new Date(Date.parse(ts) + i * 4000).toISOString(),
      cwd: PROJECT, message: { role, model, content: [{ type: "text", text: i ? `Done: ${text}` : text }] },
    })).join("\n") + "\n";
    writeFileSync(path.join(sessionsDir, "session-0001.jsonl"), transcript("session-0001", "fixture-1", "2026-01-01T00:00:01Z", "claude-sonnet-5", "wire the retry policy into the fetch layer"));
    writeFileSync(path.join(sessionsDir, "session-0002.jsonl"), transcript("session-0002", "fixture-2", "2026-01-02T09:30:00Z", "claude-opus-5", "summarize the release notes for 0.5.5"));
    await core.importProjectSessions(PROJECT, "claude", { skipCapture: true });
    log("fixture ready; core sees", (await core.collectStatus(PROJECT)).history.sessions, "sessions");

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
    const child = spawn(editor.exe, ["--user-data-dir", UD, "--extensions-dir", EXT, `--remote-debugging-port=${PORT}`, "--new-window", PROJECT], { detached: true, stdio: "ignore" });
    child.unref();
    log("launched pid", child.pid);

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
    // Which process owns the pixels at each sample point: the capture is only
    // evidence of this instance if this instance is what they came from. One
    // PowerShell call per round, because the probe sleeps 900ms before it reads.
    const probe = (rect) => [...ps("-Mode", "probe", "-X", String(rect.x), "-Y", String(rect.y), "-W", String(rect.w), "-H", String(rect.h))
      .matchAll(/probe=(-?\d+),(-?\d+) pid=(\d+)/g)].map((match) => ({ x: Number(match[1]), y: Number(match[2]), pid: Number(match[3]) }));
    const blockedBy = (owners) => owners.find((owner) => owner.pid !== child.pid) ?? null;
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
      // topmost windows exist — so every sample point is probed for the process
      // that owns the pixels, and the raise is retried before the read.
      let block = blockedBy(probe({ x, y, w, h }));
      for (let attempt = 0; attempt < 2 && block !== null; attempt += 1) {
        log(`not on top at ${block.x},${block.y} (pid ${block.pid} is); raising again`);
        ps("-Mode", "raise");
        await sleep(600);
        block = blockedBy(probe({ x, y, w, h }));
      }
      // The OS rectangle and the renderer's own numbers should agree now that the
      // capture is DPI-aware; when they do not, say so rather than pick silently.
      if (win32 && Math.abs(win32[2] - w) > 4) log(`geometry mismatch: win32 ${win32.join(",")} vs cdp ${x},${y},${w},${h}`);
      // An occluded read is still taken — it is the only picture of the real
      // editor — but it is not saved under a clean shot's name: `-occluded` in
      // the filename is the part of the evidence a reader cannot miss, and the
      // report carries the point and the pid that were on top.
      const file = block === null ? name : name.replace(/\.png$/, "-occluded.png");
      const out = ps("-Mode", "window", "-OutFile", `${OUT}/${file}`, "-X", String(x), "-Y", String(y), "-W", String(w), "-H", String(h));
      geo0 = g;
      shots.push({
        name: file, screen: true, surface: false, occluded: block !== null, byPid: block?.pid ?? null, at: block === null ? null : `${block.x},${block.y}`,
        out: `${out} (${sane ? "cdp" : "win32"} geometry, dpr=${g.dpr}, ${block === null ? "all five sample points belong to this instance" : `pid ${block.pid} owns the pixels at ${block.x},${block.y} — occluded`})`,
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
      log("shot", file, `${w}x${h} at ${x},${y} via ${sane ? "cdp" : "win32"}`, block === null ? "(on top)" : `(occluded by pid ${block.pid})`);
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
    const click = async (label) => {
      const frame = await json(wbc, `(()=>{const r=document.querySelector('iframe.webview').getBoundingClientRect();return {x:r.x,y:r.y};})()`);
      const el = await json(wvc, `(()=>{const d=${DOC};
    const n=[...d.querySelectorAll('button,a,[role=button],tr,[class*=row]')].find(x=>(x.innerText||'').trim()===${JSON.stringify(label)});
    if(!n)return null;const r=n.getBoundingClientRect();
    return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
      if (!el) throw new Error(`no clickable element labelled ${JSON.stringify(label)}`);
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
      return { label, x, y, mutations: Number(await evalIn(wvc, "window.__mut || 0")) };
    };

    const steps = [];
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

    const outcome = verdict({ steps, row, header, shots, errors });
    writeFileSync(`${OUT}/report.md`, `# Avenic VS Code Extension Host check

## Verdict: ${outcome.pass ? "PASS" : "FAIL"}

${outcome.pass
    ? "Every click made the panel react (the ones that switch what the page shows changed it; Refresh repainted the same project, which is what a re-read of unchanged state looks like), the session opened with its transcript, every screen read is this instance's, and the Extension Host log has no errors from this extension."
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

Isolated profile: \`${UD}\` + \`${EXT}\` — removed and recreated for this run; your real profile's settings and extensions were not read or written (VS Code opens its own shared-storage database outside the profile either way).

## Fixture
\`${PROJECT}\`, configured with the real core (\`initializeAgent\` for claude + codex,
both \`sessionScope: project\`), plus two synthetic Claude transcripts under
\`.agents/sessions/claude/\` imported with \`importProjectSessions\`.
No agent was launched and no session was resumed.

## Screenshots
${shots.map((s) => `- \`${OUT}/${s.name}\` — ${s.out}`).join("\n")}

## Header layout
The project header's three parts (title, path, status block) measured in the webview:
**${header.overlaps.length === 0 ? "each stays inside its own column" : `painted over the status block: ${header.overlaps.join(", ")}`}**
(the right edge of each element is clamped by every clipping ancestor, so an ellipsised path counts as inside).

## Clicks (injected via CDP, not the OS cursor)
${steps.map((s) => `- \`${s.label}\` at workbench (${s.hit.x}, ${s.hit.y}) → \`${s.file}\`, body text changed: **${s.changed}**${s.expectText === false ? " (not required for this button — it re-reads the same project)" : ""}, DOM mutations caused by the click: **${s.mutations}**${s.opened ? `, Sessions marked current: **${s.opened.sessionsActive}**, transcript turns rendered: **${s.opened.turns}**` : ""}`).join("\n") || "_none_"}

## Extension Host log
Only log files written at or after this run started are listed${staleLogs.length ? ` (${staleLogs.length} from earlier runs ignored)` : ""}.
${logLines.length ? "```\n" + logLines.join("\n") + "\n```" : "_no lines mentioning avenic, and no ERROR/WARN lines._"}
`);
    log("report:", `${OUT}/report.md`);
    log(`verdict: ${outcome.pass ? "PASS" : "FAIL"}`);
    for (const reason of outcome.reasons) log(`  reason: ${reason}`);
    for (const s of steps) log(`click ${JSON.stringify(s.label)} -> changed=${s.changed} mutations=${s.mutations}`);
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
