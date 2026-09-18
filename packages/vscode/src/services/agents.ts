import path from "node:path";
import {
  AGENTS,
  agentEnvironment,
  agentExecutableAvailable as coreAgentExecutableAvailable,
  clearLocalAuth,
  applyProjectConfiguration,
  detectAgentInstallation,
  deinitializeAgent,
  effectiveAgentConfig,
  finishLaunch,
  getAgentRuntimeMode,
  getAgent,
  getSessionAdapter,
  initializeAgent,
  importProjectSessions,
  joinLaunchGroup,
  loadRuntime,
  projectConfig,
  resolveEffectiveAgentRuntime,
  setLocalAuth,
  type Agent,
  type AgentInstallation,
  type EffectiveAgentConfig,
} from "@avenic/core";
import { cliVersionStatus, type CliVersionStatus } from "./agent-versions.ts";

export interface AgentStatus {
  agent: Agent;
  executableAvailable: boolean;
  effective: EffectiveAgentConfig | null;
  mode?: Awaited<ReturnType<typeof getAgentRuntimeMode>>;
  // 本机已装版本与 npm registry 最新版（10 分钟缓存，失败容错为 null）
  cli: CliVersionStatus;
  installation?: AgentInstallation;
}

// Agents and Dashboard ask for the same status during one refresh cycle.
// Keep a short-lived in-memory snapshot so we do not respawn three CLIs for
// every view. Mutations explicitly invalidate it from the extension shell.
const STATUS_TTL_MS = 1_000;
const statusCache = new Map<string, { at: number; value: Promise<AgentStatus> }>();

export function invalidateAgentStatusCache(): void {
  statusCache.clear();
}

export function listAgents(): Agent[] {
  return Object.keys(AGENTS).map((id) => getAgent(id)); // AGENTS 值不含 id，getAgent 补齐
}

// dashboard 专用薄包装（cwd 域，无 environment 参数——与 agentStatus 一致）
export function agentExecutableAvailable(agentId: string): boolean {
  return coreAgentExecutableAvailable(agentId);
}

export function detectInstallation(agentId: string): AgentInstallation {
  return detectAgentInstallation(agentId);
}

export async function agentStatus(projectRoot: string, agentId: string): Promise<AgentStatus> {
  const key = `${projectRoot}\u0000${agentId}`;
  const cached = statusCache.get(key);
  if (cached !== undefined && Date.now() - cached.at < STATUS_TTL_MS) return cached.value;
  const pending = readAgentStatus(projectRoot, agentId);
  statusCache.set(key, { at: Date.now(), value: pending });
  return pending;
}

async function readAgentStatus(projectRoot: string, agentId: string): Promise<AgentStatus> {
  const state = await loadRuntime(projectRoot);
  const agent = getAgent(agentId);
  const installation = detectAgentInstallation(agentId);
  // 探测并行化：本机 --version 与 npm registry 查询互不依赖；单次失败容错为 null
  const [executableAvailable, cli] = await Promise.all([
    Promise.resolve(coreAgentExecutableAvailable(agentId)),
    cliVersionStatus(agentId, agent, undefined, installation),
  ]);
  return { agent, executableAvailable, effective: effectiveAgentConfig(state, agentId), mode: await getAgentRuntimeMode(projectRoot, agentId), cli, installation };
}

export { invalidateCliVersionCache, npmPackage } from "./agent-versions.ts";

export function initialize(projectRoot: string, agentId: string, authMode: "global" | "project", sessionsMode: "global" | "project") {
  return initializeAgent(projectRoot, agentId, authMode, sessionsMode).finally(invalidateAgentStatusCache);
}

export type ProjectAgentSettings = Record<string, { auth: "global" | "project"; sessions: "global" | "project" }>;

export async function readProjectConfiguration(projectRoot: string) {
  return projectConfig(await loadRuntime(projectRoot));
}

// The extension only collects choices. Core validates, commits, and imports
// isolated native histories when switching into Shared mode.
export async function configureProjectRuntime(projectRoot: string, agents: ProjectAgentSettings, sessionInterop: "shared" | "isolated") {
  const result = await applyProjectConfiguration(projectRoot, { agents, sessionInterop });
  invalidateAgentStatusCache();
  return result;
}

export function deinitialize(projectRoot: string, agentId: string, purge?: boolean) {
  return deinitializeAgent(projectRoot, agentId, purge ? { purge: true } : undefined).finally(invalidateAgentStatusCache);
}

export async function setAuthMode(projectRoot: string, agentId: string, mode: "global" | "project" | "reset") {
  const result = mode === "reset" ? await clearLocalAuth(projectRoot, agentId) : await setLocalAuth(projectRoot, agentId, mode);
  invalidateAgentStatusCache();
  return result;
}

export async function setSessionsMode(projectRoot: string, agentId: string, mode: "global" | "project") {
  const state = await loadRuntime(projectRoot);
  const effective = effectiveAgentConfig(state, agentId);
  const auth = effective?.auth ?? "global";
  const result = await initializeAgent(projectRoot, agentId, auth, mode);
  invalidateAgentStatusCache();
  return result;
}

export function importSessions(projectRoot: string, agentId: string) {
  // Import means native Agent history -> project portable storage. This must
  // match `avenic <agent> sessions import`; restore is the explicit writeback.
  return importProjectSessions(projectRoot, agentId);
}

export function writebackSessions(projectRoot: string, agentId: string) {
  return getSessionAdapter(agentId).restore(projectRoot);
}

// ---- 启动运行（免 @avenic/cli npm 包：插件直接复用 core 运行时原语） ----
// 等价于 `avenic <agent>` 的一次启动：项目认证环境注入（project auth）、便携会话
// 快照/恢复/回收（project sessions——与 CLI 共用同一 lease 文件与快照目录，交叉启动互不冲突）。
// 官方 CLI 交互在集成终端进行；终端关闭时由命令层调用 finishRun 收官。

export interface AgentLaunchDefinition {
  name: string;
  cwd: string;
  environment: Record<string, string>;
  // 模型配置注入产出的 argv（Codex 的 -c/-m 等）。当前命令层仍用 sendText(command) 启动，
  // 保留它是为了让注入能被独立断言，也为将来的 argv 直启留位。
  argumentsList: string[];
  command: string; // 终端内执行的官方 CLI 命令（executable 名，端子按 PATH 解析）
  // 模型配置未生效时的可读原因（spec §13：不静默跳过）；无异常时为 null。
  note: string | null;
}

// sendText 会把整行交给用户的 shell 二次解析，因此注入的 argv 必须先按 shell 规则引号化，
// 否则含空格的取值会被拆成两个参数——预设名里就带空格（「小米 MiMo」「Moonshot Kimi」「智谱 GLM」），
// Codex 会把它们注入成 model_providers.<id>.name=<name>。
// 规则与 core 的 src/runtime/process.mjs（.cmd/.bat 分支）一致：空白与 cmd 元字符加引号。
// 端点 URL 的元字符已被 core 的 validateBaseUrl 拒绝，含引号的 argv 会被 core 直接拒绝
// （codexInjection 的 "Refusing to inject a quoted Codex argument"），所以这里实际只需处理空白。
const SHELL_NEEDS_QUOTES = /[\s"&|^<>()]/;
const quoteForShell = (part: string) => (SHELL_NEEDS_QUOTES.test(part) ? `"${part}"` : part);
function shellLine(executable: string, argumentsList: string[]): string {
  // 无注入时逐字保持既有行为（`claude`），不改动未绑定项目的启动路径。
  return argumentsList.length === 0 ? executable : [quoteForShell(executable), ...argumentsList.map(quoteForShell)].join(" ");
}

export interface PreparedLaunch {
  definition: AgentLaunchDefinition;
  // 收官：捕获本次运行会话进项目并偿还 lease（最后成员恢复原生存储）；幂等。
  finishRun: () => Promise<void>;
}

export async function prepareAgentLaunch(projectRoot: string, agentId: string): Promise<PreparedLaunch> {
  const agent = getAgent(agentId);
  const state = await loadRuntime(projectRoot);
  const config = effectiveAgentConfig(state, agentId);
  if (!config) {
    throw new Error(`${agent.displayName} 尚未初始化，请先执行「Avenic: 初始化 Agent」`);
  }
  // 与 CLI 启动同一个作用域判定：project auth 是作用域，不是登录。
  const environment = agentEnvironment(state, projectRoot, agentId) as Record<string, string>;
  // 项目绑定的模型配置：dangling 先安全回滚（幂等），指纹不一致先刷新 Claude 投影；
  // 注入内容全部由 core 生成，插件侧零业务逻辑。任何异常都不阻断启动（spec §13）。
  // environment 本身保持不动（会话适配器/名册用的就是它，spec §5.2）——注入只作用于子进程。
  let launchArguments: string[] = [];
  let launchEnvironment = environment;
  let launchNote: string | null = null;
  try {
    // 与 `avenic <agent>` 启动取用的是同一个解析结果：会话适配器/终端拿到 argv、
    // 子进程环境与"模型配置为何没生效"（note）三件东西，判定逻辑不在插件里重写。
    let logged: string | null = null;
    const runtime = await resolveEffectiveAgentRuntime(projectRoot, agentId, {
      state,
      environment,
      io: { log: (line: string) => { logged = line; } },
    });
    launchArguments = runtime.argumentsList;
    launchEnvironment = runtime.environment as Record<string, string>;
    // core 已回滚的 dangling 绑定、被跳过的模型配置都以 note 呈现给用户（spec §7/§13）。
    launchNote = runtime.note ?? logged;
  } catch (error) {
    launchNote = `Model configuration skipped: ${error instanceof Error ? error.message : String(error)}`;
  }
  const adapter = getSessionAdapter(agentId);
  const portableSessions = config.sessions === "project";
  const sharedSessions = projectConfig(state).sessionInterop === "shared";
  // 启动组与 CLI、CLI 的看门狗共用 core 的同一份策略（首个成员快照、末个成员还原、
  // 崩溃组先回收再快照）。插件只加入本 agent 的组：启动不扫描其它 agent 的原生历史，
  // 那是 Sessions 命令与 `avenic sessions` 的职责。
  const group = portableSessions ? await joinLaunchGroup(projectRoot, agentId, { environment }) : null;
  try {
    if (portableSessions) {
      // 项目会话记录优先：启动前把项目里的会话合并进原生存储供 CLI 使用
      await adapter.restore(projectRoot, { environment });
    }
  } catch (error) {
    if (group) {
      try { await group.release(); } catch {}
    }
    throw error;
  }
  // 启动补齐共享链接：尽力而为，绝不阻断启动。
  try {
    const { repairLinks } = await import("./skills.ts");
    await repairLinks("project", projectRoot);
  } catch {
    // ignore
  }
  let done = false;
  const finishRun = async (): Promise<void> => {
    if (done) return;
    done = true;
    if (!portableSessions) return;
    await finishLaunch(projectRoot, agentId, {
      environment,
      member: group?.member ?? null,
      setActive: sharedSessions,
    });
  };
  return {
    definition: {
      name: `Avenic · ${agent.displayName}`,
      cwd: projectRoot,
      environment: launchEnvironment,
      argumentsList: launchArguments,
      command: shellLine(agent.executable, launchArguments),
      note: launchNote,
    },
    finishRun,
  };
}
