import { spawn as spawnAsync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

// Windows resolves a bare command in PATHEXT order, and npm's `.cmd` shim comes
// before its `.ps1` twin. Following the same order matters twice: the agent
// gets the launcher the user's own shell would pick, and `.ps1` costs a
// PowerShell startup that no interactive launch should pay.
export const WINDOWS_SHIM_EXTENSIONS = [".exe", ".com", ".bat", ".cmd", ".ps1", ""];

export function resolveOnPath(executable, environment) {
  if (path.isAbsolute(executable) || executable.includes(path.sep)) {
    return existsSync(executable) ? executable : null;
  }
  const extensions = process.platform === "win32" ? WINDOWS_SHIM_EXTENSIONS : [""];
  // Windows preserves the inherited spelling of environment variables. Node
  // processes commonly receive `Path` (not `PATH`), while callers that build a
  // minimal POSIX-style environment use `PATH`.
  const pathValue = environment.PATH ?? environment.Path ?? "";
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory.replace(/^"|"$/g, ""), `${executable}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * One command line for a shell to run: the rule for quoting an argv, written
 * once. cmd.exe re-parses `& | ^ < > ( )` even inside an argument and splits on
 * whitespace, so a caller that hands a whole line to a shell (the launcher's
 * `.cmd` branch, the extension's terminal `sendText`) must quote exactly like
 * this. Parts are quoted only when they need it, so the common case — a bare
 * command with plain arguments — comes back as the line the user typed.
 */
export function quoteShellLine(executable, argumentsList) {
  const needsQuotes = /[\s"&|^<>()]/;
  const quote = (part) => {
    if (!needsQuotes.test(part)) return part;
    // 双引号没有一条对两种 shell 都对的内嵌写法：cmd 认 `""`，POSIX 与 PowerShell
    // 读 `\"`，同一条命令在另一边就是另一种含义。加引号救不了它，那就拒绝——
    // 一行静默变意的命令比一个错误更糟，而到这里的参数（session id、路径）本就不
    // 该带双引号。
    if (part.includes("\"")) throw new Error(`Cannot pass ${JSON.stringify(part)} to a shell: a double quote cannot be quoted the same way for cmd and POSIX shells`);
    return `"${part}"`;
  };
  return [quote(executable), ...argumentsList.map(quote)].join(" ");
}

function invocation(executable, argumentsList, environment) {
  const resolved = resolveOnPath(executable, environment) ?? executable;
  if (process.platform === "win32" && resolved.toLowerCase().endsWith(".ps1")) {
    const powershell = path.join(environment.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    return {
      command: powershell,
      argumentsList: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", resolved, ...argumentsList],
    };
  }
  // .cmd/.bat 不能直接 CreateProcess（EINVAL）；npm 全局安装生成的 agent CLI shim
  // （如 opencode.cmd）经 shell（cmd）运行。注意：node 20.16+ 对 args 数组会做
  // CreateProcess 引号转义（\"），cmd 无法还原——必须整体作为 shell 命令透传。
  if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(resolved)) {
    // 白名单（model/schema.mjs 的 validateBaseUrl）已经拒绝元字符，但用户自带参数
    // （如 `avenic codex --cd "a&b"`）仍会经过这里，因此拼接层必须同样加固。
    return { command: quoteShellLine(resolved, argumentsList), argumentsList: [], shell: true };
  }
  return { command: resolved, argumentsList };
}

// 子进程站在哪个目录，就该从 PWD 读到哪个目录。shell 里 `cd` 同时移动两者，但调用方可以
// 单独指定 cwd —— 启动路径交给 agent 的是「项目根」，而项目根是从用户所在目录向上找出来的，
// 所以 `avenic` 在子目录里运行时两者本就不一致。OpenCode 把 PWD 当作它的项目：两者不一致
// 时，一条被续接的投影会话答完之后不再退出（2x2 见 dist/logs/opencode-pwd-matrix.txt）。
function withDirectoryInStep(environment, cwd) {
  return cwd ? { ...environment, PWD: path.resolve(cwd) } : environment;
}

// A long-lived child that speaks a protocol over pipes (the Codex app server).
// The caller owns its lifetime; this only solves "how do I start this binary on
// this platform", the same way the two spawmers below do.
export function spawnExecutableChild(executable, argumentsList, options = {}) {
  const environment = withDirectoryInStep(options.env ?? process.env, options.cwd);
  const { spawn, ...spawnOptions } = options;
  if (spawn) {
    return spawn(executable, argumentsList, { ...spawnOptions, env: environment });
  }
  const resolved = invocation(executable, argumentsList, environment);
  const child = spawnAsync(resolved.command, resolved.argumentsList, {
    ...spawnOptions,
    shell: resolved.shell ?? false,
    env: environment,
    windowsHide: true,
  });
  // On Windows a `.cmd` shim means the real process is a grandchild: killing the
  // shell leaves it behind, and a stray app server keeps its write lock on the
  // threads it had open.
  if (process.platform === "win32" && resolved.shell) {
    child.terminateTree = () => {
      try {
        spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
      } catch {
        child.kill();
      }
    };
  }
  return child;
}

export function spawnExecutableSync(executable, argumentsList, options = {}) {
  const environment = withDirectoryInStep(options.env ?? process.env, options.cwd);
  const { spawn, ...spawnOptions } = options;
  if (spawn) {
    return spawn(executable, argumentsList, { ...spawnOptions, env: environment });
  }
  const resolved = invocation(executable, argumentsList, environment);
  return spawnSync(resolved.command, resolved.argumentsList, { ...spawnOptions, shell: resolved.shell ?? false, env: environment });
}

// Wait for a child process the way a terminal would, but without stopping the
// event loop. Anything that shares its loop with a user interface (the VS Code
// extension host, the CLI's interactive prompts) has to use this one: the sync
// variant monopolises the thread for as long as the child runs, which for a
// network operation is seconds of frozen window.
export function spawnExecutable(executable, argumentsList, options = {}) {
  const environment = withDirectoryInStep(options.env ?? process.env, options.cwd);
  const { spawn, capture = true, ...spawnOptions } = options;
  return new Promise((resolve) => {
    const resolved = invocation(executable, argumentsList, environment);
    const child = spawnAsync(resolved.command, resolved.argumentsList, {
      ...spawnOptions,
      shell: resolved.shell ?? false,
      env: environment,
      // Captured output, but the child keeps the real stdin: a command that
      // stops to ask for a password (git writing to a private Hub) has to be
      // able to read the answer from the terminal it was started in.
      stdio: capture ? ["inherit", "pipe", "pipe"] : spawnOptions.stdio ?? "inherit",
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve({ status: null, stdout, stderr, error }));
    child.on("close", (status) => resolve({ status, stdout, stderr, error: null }));
  });
}
