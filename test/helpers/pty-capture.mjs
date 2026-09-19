// A real terminal for the tests that need one: a frame only repaints when
// stdout is a TTY, so "what the user actually sees" has to be read off a
// terminal instead of a pipe. Windows drives a pseudoconsole (ConPTY) through a
// small PowerShell client; elsewhere util-linux `script` does the same job with
// a PTY.
//
//   const run = capturePty(process.execPath, [cli, "status"], { columns: 100, rows: 40 });
//   run.output            // the console bytes, control sequences and all
//
// Returns { status, exitCode, output, detail }: status is "ok" when the command
// ran to completion, "timeout" when it had to be killed, "unavailable" when the
// platform has no way to make a terminal, and "error" for anything else.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const helpers = path.dirname(fileURLToPath(import.meta.url));
const conptyScript = path.join(helpers, "conpty-capture.ps1");

function hasConPty() {
  if (process.platform !== "win32") return false;
  try {
    readFileSync(conptyScript);
    return true;
  } catch {
    return false;
  }
}

function hasScript() {
  const probe = spawnSync("script", ["--version"], { stdio: "ignore" });
  return probe.status === 0;
}

/** True when this machine can hand a child a terminal. */
export function ptyAvailable() {
  return hasConPty() || hasScript();
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/**
 * The environment the child runs in. What a terminal can paint is the child's
 * business, not the machine's: a test that asserts a colour has to say which
 * terminal it is asking for, or the same commit passes here and fails wherever
 * NO_COLOR or a bare TERM is set. `options.environment` pins it.
 */
function childEnvironment(options) {
  return { ...process.env, ...(options.environment ?? {}) };
}

/** Windows: a pseudoconsole through the PowerShell client. */
function captureWithConPty(command, args, options) {
  const work = mkdtempSync(path.join(os.tmpdir(), "avenic-conpty-"));
  const argsFile = path.join(work, "args.json");
  const outFile = path.join(work, "console.bin");
  try {
    // Arguments travel as a file: the PowerShell tokenizer eats brackets and
    // commas, so an inline JSON array does not survive the command line.
    writeFileSync(argsFile, JSON.stringify(args.map(String)));
    const result = spawnSync("powershell.exe", [
      "-NoProfile",
      "-File", conptyScript,
      "-Exe", command,
      "-ArgsFile", argsFile,
      "-Cwd", options.cwd ?? process.cwd(),
      "-Columns", String(options.columns ?? 100),
      "-Rows", String(options.rows ?? 40),
      "-Out", outFile,
      "-Input", options.input ? Buffer.from(options.input, "utf8").toString("base64") : "",
      "-InputDelayMs", String(options.inputDelayMs ?? 1200),
      "-TimeoutMs", String(options.timeoutMs ?? 60_000),
    ], { encoding: "utf8", timeout: (options.timeoutMs ?? 60_000) + 30_000, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], env: childEnvironment(options) });

    let output = "";
    try {
      output = readFileSync(outFile, "utf8");
    } catch {
      output = "";
    }
    const line = String(result.stdout ?? "").trim().split("\n").pop() ?? "";
    let parsed = null;
    try {
      parsed = JSON.parse(line);
    } catch {
      parsed = null;
    }
    if (!parsed) {
      return { status: "error", exitCode: null, output, detail: (result.stderr || line || "the pseudoconsole client produced no result").trim().slice(0, 400) };
    }
    if (parsed.status !== "ok") {
      return { status: "error", exitCode: parsed.exitCode ?? null, output, detail: String(parsed.status) };
    }
    if (parsed.exitCode === 124) return { status: "timeout", exitCode: 124, output, detail: "the console client hit its timeout" };
    return { status: "ok", exitCode: parsed.exitCode, output };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** POSIX: util-linux `script`, which runs the command under a pty of its own. */
function captureWithScript(command, args, options) {
  const work = mkdtempSync(path.join(os.tmpdir(), "avenic-pty-"));
  const outFile = path.join(work, "console.bin");
  const timeoutMs = options.timeoutMs ?? 60_000;
  try {
    const runCommand = [command, ...args].map(shellQuote).join(" ");
    // -q: no banner, -e: exit status of the child, -f: flush as it goes, -c: the command.
    const result = spawnSync("script", ["-qfec", runCommand, outFile], {
      cwd: options.cwd ?? process.cwd(),
      encoding: "buffer",
      timeout: timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      input: options.input ? Buffer.from(options.input, "utf8") : undefined,
      env: { ...childEnvironment(options), TERM: options.environment?.TERM ?? process.env.TERM ?? "xterm-256color", COLUMNS: String(options.columns ?? 100), LINES: String(options.rows ?? 40) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    try {
      output = readFileSync(outFile, "utf8");
    } catch {
      output = String(result.stdout ?? "");
    }
    // `script` writes a header and a footer into the typescript file; they are
    // about the capture, not about the screen.
    output = output
      .replace(/^Script started on [^\n]*\n/, "")
      .replace(/\n?Script done on [^\n]*\n?$/, "");
    if (result.error?.code === "ETIMEDOUT") return { status: "timeout", exitCode: null, output, detail: "the pty run hit its timeout" };
    if (result.error) return { status: "error", exitCode: null, output, detail: String(result.error.message) };
    return { status: "ok", exitCode: result.status, output };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Run `command args` on a terminal and hand back everything it painted.
 * Returns { status, exitCode, output, detail } — never throws.
 */
export function capturePty(command, args = [], options = {}) {
  if (hasConPty()) return captureWithConPty(command, args, options);
  if (hasScript()) return captureWithScript(command, args, options);
  return { status: "unavailable", exitCode: null, output: "", detail: `no pseudoconsole on ${process.platform}` };
}

/** The console bytes with the control sequences taken out — for reading, not asserting. */
export function stripControl(output) {
  return String(output)
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1b[()][A-Z0-9]/g, "")
    .replace(/\x1b[=>]/g, "")
    .replace(/\r/g, "");
}
