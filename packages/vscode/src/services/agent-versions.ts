import { agentNpmPackage, installedCliVersion, type AgentInstallation } from "@avenic/core";

/** A CLI version probe, injectable so tests never spawn anything. */
export type CliProbe = () => Promise<string | null>;

// 安装命令：core 已判定安装方式时按它给出的命令升级，否则（本地未检测到 CLI）
// 唯一入口是 registry 上的官方 npm 包。包名与「这条安装怎么升级」都由 core 决定，
// 面板不再自带一份包名表。
export function updateCommandForInstallation(agentId: string, installation: AgentInstallation | null): string | null {
  if (installation === null || installation.executable === null) {
    return `npm install --global ${agentNpmPackage(agentId)}@latest`;
  }
  return installation.updateStrategy.command;
}

const CACHE_TTL_MS = 10 * 60 * 1000; // 刷新窗口内不重复探测本机 CLI

// 面板底部那一行「Avenic v…」说的是这台机器上真正在用的那份 CLI —— 产品版本是 CLI
// 的，扩展自己的版本不抢这一行。扩展不依赖 CLI，所以这是一次探测：激活时与刷新时
// 各做一次，十分钟窗口内复用同一个答案。探测失败就是 null：底部只写「Avenic」，
// 不编一个版本号，也不为一个探测拖住首帧 —— 读的人拿的是 cachedAvenicCliVersion()，
// 答案到了再由宿主把那一行补上。
const avenicProbe: CliProbe = () => installedCliVersion("avenic");

let avenicVersion: { at: number; version: string | null } | null = null;
let avenicInFlight: Promise<string | null> | null = null;

/** 已经拿到的答案；探到之前（或探不到）是 null —— 首帧不为它等待。 */
export function cachedAvenicCliVersion(): string | null {
  return avenicVersion === null ? null : avenicVersion.version;
}

export function avenicCliVersion(probe: CliProbe = avenicProbe, options: { refresh?: boolean } = {}): Promise<string | null> {
  const cached = avenicVersion;
  if (cached !== null && options.refresh !== true && Date.now() - cached.at < CACHE_TTL_MS) {
    return Promise.resolve(cached.version);
  }
  // 探测在飞的时候再点一次刷新，等的是同一次探测：spawn 一次就是一次。
  avenicInFlight ??= probe().catch(() => null).then((version) => {
    avenicVersion = { at: Date.now(), version };
    avenicInFlight = null;
    return version;
  });
  return avenicInFlight;
}
