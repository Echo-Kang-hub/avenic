import { execFile } from "node:child_process";
import process from "node:process";
import { promisify } from "node:util";
import { spawnExecutableSync, type Agent, type AgentInstallation } from "@avenic/core";

const execFileAsync = promisify(execFile);

export interface CliVersionStatus {
  installed: string | null;
  latest: string | null;
  updateAvailable: boolean;
}

// 官方 CLI 的 npm 包名（terminal 内 `npm install --global <pkg>@latest` 用）
export const AGENT_NPM_PACKAGES: Record<string, string> = {
  claude: "@anthropic-ai/claude-code",
  codex: "@openai/codex",
  opencode: "opencode-ai",
};

export function npmPackage(agentId: string): string {
  const pkg = AGENT_NPM_PACKAGES[agentId];
  if (pkg === undefined) throw new Error(`Unknown npm package for agent: ${agentId}`);
  return pkg;
}

export function updateCommandForInstallation(agentId: string, installation: AgentInstallation | null): string | null {
  if (installation === null || installation.executable === null) {
    return `npm install --global ${npmPackage(agentId)}@latest`;
  }
  return installation.updateStrategy.command;
}

// 从 --version 输出提取首个语义版本：`2.1.238 (Claude Code)` / `codex-cli 0.150.1` → semver
export function parseVersion(output: string): string | null {
  const match = output.match(/\d+\.\d+\.\d+/);
  return match?.[0] ?? null;
}

export function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let i = 0; i < 3; i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

// 探测可注入：单测用假结果，扩展运行时探测本机 CLI 与 npm registry
export interface VersionProbes {
  probeInstalled: (agent: Agent) => Promise<string | null>;
  probeLatest: (agentId: string) => Promise<string | null>;
}

const defaultProbes: VersionProbes = {
  async probeInstalled(agent) {
    try {
      const result = spawnExecutableSync(agent.executable, ["--version"], {
        windowsHide: true,
        stdio: "pipe",
        encoding: "utf8",
      });
      return result.status === 0 ? parseVersion(result.stdout ?? "") : null;
    } catch {
      return null;
    }
  },
  async probeLatest(agentId) {
    try {
      const { stdout } = await execFileAsync("npm", ["view", npmPackage(agentId), "version"], {
        windowsHide: true,
        timeout: 15_000,
        encoding: "utf8",
        // Windows 下 npm 是 .cmd shim：node 20+ 的 args 转义 cmd 无法还原，须经 shell 透传
        shell: process.platform === "win32",
      });
      return parseVersion(stdout);
    } catch {
      return null;
    }
  },
};

const CACHE_TTL_MS = 10 * 60 * 1000; // 刷新窗口内不重复探测本机 CLI / npm registry
const cache = new Map<string, { at: number; value: CliVersionStatus }>();

export function invalidateCliVersionCache(agentId: string): void {
  cache.delete(agentId);
}

export async function cliVersionStatus(
  agentId: string,
  agent: Agent,
  probes: VersionProbes = defaultProbes,
  installation: AgentInstallation | null = null,
): Promise<CliVersionStatus> {
  const cached = cache.get(agentId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
  const useNpmRegistry = installation === null || installation.executable === null || installation.installMethod.startsWith("npm-");
  const [installed, latest] = await Promise.all([
    installation?.version ?? probes.probeInstalled(agent),
    useNpmRegistry ? probes.probeLatest(agentId) : Promise.resolve(null),
  ]);
  const value: CliVersionStatus = {
    installed,
    latest,
    updateAvailable: installed !== null && latest !== null && compareVersions(latest, installed) > 0,
  };
  cache.set(agentId, { at: Date.now(), value });
  return value;
}
