import {
  agentNpmPackage,
  compareCliVersions,
  installedCliVersion,
  latestPublishedVersion,
  type Agent,
  type AgentInstallation,
} from "@avenic/core";

export interface CliVersionStatus {
  installed: string | null;
  latest: string | null;
  updateAvailable: boolean;
}

// 安装命令：core 已判定安装方式时按它给出的命令升级，否则（本地未检测到 CLI）
// 唯一入口是 registry 上的官方 npm 包。包名与「这条安装怎么升级」都由 core 决定，
// 面板不再自带一份包名表。
export function updateCommandForInstallation(agentId: string, installation: AgentInstallation | null): string | null {
  if (installation === null || installation.executable === null) {
    return `npm install --global ${agentNpmPackage(agentId)}@latest`;
  }
  return installation.updateStrategy.command;
}

// 探测可注入：单测用假结果，扩展运行时探测本机 CLI 与 npm registry。
// 两个探测都在 core 内实现且异步——同步 spawn 会冻结扩展宿主的事件循环。
export interface VersionProbes {
  probeInstalled: (agent: Agent) => Promise<string | null>;
  probeLatest: (agentId: string) => Promise<string | null>;
}

const defaultProbes: VersionProbes = {
  probeInstalled: (agent) => installedCliVersion(agent.executable),
  probeLatest: (agentId) => latestPublishedVersion(agentId),
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
  // 已检测到的安装方式不是 npm 时，registry 上的版本与这条安装无关（§7：不把
  // brew/standalone 安装误判成「可升级 npm 包」）。
  const useNpmRegistry = installation === null || installation.executable === null || installation.installMethod.startsWith("npm-");
  const [installed, latest] = await Promise.all([
    installation?.version ?? probes.probeInstalled(agent),
    useNpmRegistry ? probes.probeLatest(agentId) : Promise.resolve(null),
  ]);
  const value: CliVersionStatus = {
    installed,
    latest,
    updateAvailable: installed !== null && latest !== null && compareCliVersions(latest, installed) > 0,
  };
  cache.set(agentId, { at: Date.now(), value });
  return value;
}
