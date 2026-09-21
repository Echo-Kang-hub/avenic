import process from "node:process";
import path from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { spawnExecutableSync, WINDOWS_SHIM_EXTENSIONS } from "./process.mjs";

export const AGENTS = {
  claude: {
    displayName: "Claude Code",
    executable: "claude",
  },
  codex: {
    displayName: "Codex",
    executable: "codex",
  },
  // OpenCode owns its own authentication and provider configuration end to end:
  // Avenic records where its sessions live and nothing else, so the flag lives
  // with the agent rather than as another `=== "opencode"` at each call site.
  opencode: {
    displayName: "OpenCode",
    executable: "opencode",
    managesOwnAuth: true,
  },
};

/**
 * Whether a command word names an Agent. The registry is the only list of
 * Agent ids, so a caller that has to tell an Agent launch from another command
 * before it has loaded anything else asks here rather than keeping a copy.
 */
export function isAgentId(value) {
  return typeof value === "string" && Object.hasOwn(AGENTS, value);
}

export function getAgent(agentId) {
  const agent = AGENTS[agentId];
  if (!agent) {
    throw new Error(`Unknown Agent: ${agentId}`);
  }
  return { id: agentId, ...agent };
}

// Where each agent's own login keeps its credentials. Avenic reads this file —
// it never writes one, and never deletes one as ordinary cleanup — so "signed
// in" is a fact about local files, and a purge that would take it has to say so
// first. It lives with the registry because the reader and the remover must
// name the same file.
export const CREDENTIAL_FILE = { claude: ".credentials.json", codex: "auth.json" };

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

// The registry package an agent is installed from. Hosts that offer to install
// or upgrade one need the same spelling the installation profiles use.
export function agentNpmPackage(agentId) {
  const profile = INSTALL_PROFILES[agentId];
  if (!profile) throw new Error(`Unknown Agent: ${agentId}`);
  return profile.npmPackage;
}

// The first semantic version in whatever an executable prints for `--version`:
// `2.1.238 (Claude Code)` and `codex-cli 0.150.1` both answer.
export function parseCliVersion(text) {
  return String(text ?? "").match(/\d+\.\d+\.\d+/)?.[0] ?? null;
}

export function compareCliVersions(left, right) {
  const a = String(left).split(".").map(Number);
  const b = String(right).split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

function pathApi(platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function pathSeparator(platform) {
  return platform === "win32" ? ";" : ":";
}

function executableExtensions(platform) {
  // Same list the launcher resolves with, so "found" and "started" can never
  // disagree about which file an agent is.
  return platform === "win32" ? WINDOWS_SHIM_EXTENSIONS : [""];
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
 * it can differ from the first executable selected by PATH. Nothing here runs
 * a child process: a host that only needs to know whether a CLI is installed
 * asks this and gets an answer immediately.
 */
export function classifyAgentExecutable(agentId, options = {}) {
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
      installMethod: "unknown",
      packageManager: null,
      updateStrategy: updateStrategy(profile, "unknown", platform),
    };
  }
  const resolvedExecutable = resolveRealpath(executable);
  const installMethod = classifyInstallation(profile, resolvedExecutable, options.cwd ?? process.cwd(), platform, fileExists);
  return {
    executable,
    resolvedExecutable,
    installMethod,
    packageManager: installMethod.startsWith("npm-") ? "npm" : installMethod === "brew" ? "brew" : null,
    updateStrategy: updateStrategy(profile, installMethod, platform),
  };
}

/**
 * The full installation record, including the version the executable reports.
 * This is the form a terminal host wants: it may block its thread for as long
 * as the CLI takes to answer.
 */
export function detectAgentInstallation(agentId, options = {}) {
  const classified = classifyAgentExecutable(agentId, options);
  let version = null;
  if (classified.executable) {
    try {
      const output = options.runVersion
        ? options.runVersion(classified.executable)
        : spawnExecutableSync(classified.executable, ["--version"], {
          env: options.environment ?? process.env,
          stdio: "pipe",
          windowsHide: true,
          encoding: "utf8",
        });
      version = parseCliVersion(typeof output === "string" ? output : (output.status === 0 ? output.stdout ?? "" : ""));
    } catch {
      // Path provenance remains useful even when the binary cannot report a version.
    }
  }
  return { ...classified, version };
}
