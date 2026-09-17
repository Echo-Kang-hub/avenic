import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

function resolveOnPath(executable, environment) {
  if (path.isAbsolute(executable) || executable.includes(path.sep)) {
    return existsSync(executable) ? executable : null;
  }
  const extensions = process.platform === "win32" ? [".exe", ".com", ".ps1", ".cmd", ".bat", ""] : [""];
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
    // cmd.exe 会把 & | ^ < > ( ) 当作元字符二次解析——即使它们在参数中间。
    // 白名单（model/schema.mjs 的 validateBaseUrl）已经拒绝这些字符，但用户自带参数
    // （如 `avenic codex --cd "a&b"`）仍会经过这里，因此拼接层必须同样加固。
    const needsQuotes = /[\s"&|^<>()]/;
    const quote = (part) => (needsQuotes.test(part) ? `"${part}"` : part);
    const line = [quote(resolved), ...argumentsList.map(quote)].join(" ");
    return { command: line, argumentsList: [], shell: true };
  }
  return { command: resolved, argumentsList };
}

export function spawnExecutableSync(executable, argumentsList, options = {}) {
  const environment = options.env ?? process.env;
  const { spawn, ...spawnOptions } = options;
  if (spawn) {
    return spawn(executable, argumentsList, { ...spawnOptions, env: environment });
  }
  const resolved = invocation(executable, argumentsList, environment);
  return spawnSync(resolved.command, resolved.argumentsList, { ...spawnOptions, shell: resolved.shell ?? false, env: environment });
}
