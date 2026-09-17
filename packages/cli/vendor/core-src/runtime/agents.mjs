import process from "node:process";
import path from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { spawnExecutableSync } from "./process.mjs";

export const AGENTS = {
  claude: {
    displayName: "Claude Code",
    executable: "claude",
  },
  codex: {
    displayName: "Codex",
    executable: "codex",
  },
  opencode: {
    displayName: "OpenCode",
    executable: "opencode",
  },
};

export function getAgent(agentId) {
  const agent = AGENTS[agentId];
  if (!agent) {
    throw new Error(`Unknown Agent: ${agentId}`);
  }
  return { id: agentId, ...agent };
}

export function agentExecutableAvailable(agentId, environment = process.env) {
  const agent = getAgent(agentId);
  try {
    const result = spawnExecutableSync(agent.executable, ["--version"], {
      env: environment,
      stdio: "pipe",
      windowsHide: true,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

const INSTALL_PROFILES = {
  claude: { npmPackage: "@anthropic-ai/claude-code" },
  codex: {
    npmPackage: "@openai/codex",
    standalone: ["/.codex/packages/standalone/", "/packages/standalone/"],
    brew: [/(?:^|\/)cellar\/codex\//, /\/homebrew\/caskroom\/codex\//],
    standaloneCommand: {
      win32: "powershell -ExecutionPolicy ByPass -c \"irm https://chatgpt.com/codex/install.ps1 | iex\"",
      default: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
    },
    brewCommand: "brew upgrade --cask codex",
  },
  opencode: { npmPackage: "opencode-ai" },
};

function pathApi(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function pathSeparator(platform) {
  return platform === "win32" ? ";" : ":";
}

function executableExtensions(platform) {
  return platform === "win32" ? [".exe", ".cmd", ".bat", ".ps1", ""] : [""];
}

function isPathLike(value, api) {
  return api.isAbsolute(value) || value.includes("/") || value.includes("\\\\");
}

function resolveExecutable(executable, options) {
  const api = pathApi(options.platform);
  if (isPathLike(executable, api)) return options.fileExists(executable) ? executable : null;
  const pathValue = options.environment.PATH ?? options.environment.Path ?? "";
  for (const directory of pathValue.split(pathSeparator(options.platform))) {
    if (!directory) continue;
    for (const extension of executableExtensions(options.platform)) {
      const candidate = api.join(directory.replace(/^"|"$/g, ""), `${executable}${extension}`);
      if (options.fileExists(candidate)) return candidate;
    }
  }
  return null;
}

function normalizePath(value, platform) {
  return platform === "win32" ? value.replace(/\\/g, "/").toLowerCase() : value;
}

function updateStrategy(profile, installMethod, platform) {
  if (installMethod === "npm-global") return { kind: "npm-global", command: `npm install --global ${profile.npmPackage}@latest` };
  if (installMethod === "npm-local") return { kind: "npm-local", command: `npm install ${profile.npmPackage}@latest` };
  if (installMethod === "brew" && profile.brewCommand) return { kind: "brew", command: profile.brewCommand };
  if (installMethod === "standalone" && profile.standaloneCommand) {
    return { kind: "standalone", command: profile.standaloneCommand[platform] ?? profile.standaloneCommand.default };
  }
  return { kind: "manual", command: null };
}

function isSourceBuild(resolvedExecutable, options) {
  const api = pathApi(options.platform);
  let current = api.dirname(resolvedExecutable);
  for (let depth = 0; depth < 8; depth += 1) {
    if (options.fileExists(api.join(current, ".git"))) return true;
    const parent = api.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return false;
}

function classifyInstallation(profile, resolvedExecutable, cwd, platform, fileExists) {
  const resolved = normalizePath(resolvedExecutable, platform).toLowerCase();
  const cwdPath = normalizePath(cwd, platform).toLowerCase().replace(/\/+$/, "");
  if (profile.standalone?.some((marker) => resolved.includes(marker))) return "standalone";
  if (profile.brew?.some((pattern) => pattern.test(resolved))) return "brew";
  const npmMarker = `/node_modules/${profile.npmPackage.toLowerCase()}/`;
  if (resolved.includes(npmMarker)) {
    return resolved.startsWith(`${cwdPath}/node_modules/`) ? "npm-local" : "npm-global";
  }
  if (isSourceBuild(resolvedExecutable, { platform, fileExists })) return "source";
  return "binary";
}

/**
 * Detect the executable that would actually run for an agent, then classify
 * its installation provenance. This never consults global npm state, because
 * it can differ from the first executable selected by PATH.
 */
export function detectAgentInstallation(agentId, options = {}) {
  const agent = getAgent(agentId);
  const profile = INSTALL_PROFILES[agentId];
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const fileExists = options.fileExists ?? existsSync;
  const resolveRealpath = options.realpath ?? ((file) => {
    try { return realpathSync.native(file); } catch { return file; }
  });
  const executable = resolveExecutable(agent.executable, { platform, environment, fileExists });
  if (!executable) {
    return {
      executable: null,
      resolvedExecutable: null,
      version: null,
      installMethod: "unknown",
      packageManager: null,
      updateStrategy: updateStrategy(profile, "unknown", platform),
    };
  }
  const resolvedExecutable = resolveRealpath(executable);
  const installMethod = classifyInstallation(profile, resolvedExecutable, options.cwd ?? process.cwd(), platform, fileExists);
  let version = null;
  try {
    const output = options.runVersion
      ? options.runVersion(executable)
      : spawnExecutableSync(executable, ["--version"], { env: environment, stdio: "pipe", windowsHide: true, encoding: "utf8" });
    const text = typeof output === "string" ? output : (output.status === 0 ? output.stdout ?? "" : "");
    const match = text.match(/\d+\.\d+\.\d+/);
    version = match?.[0] ?? null;
  } catch {
    // Path provenance remains useful even when the binary cannot report a version.
  }
  return {
    executable,
    resolvedExecutable,
    version,
    installMethod,
    packageManager: installMethod.startsWith("npm-") ? "npm" : installMethod === "brew" ? "brew" : null,
    updateStrategy: updateStrategy(profile, installMethod, platform),
  };
}
