import {
  AGENTS,
  effectiveAgentEnvironment,
  machineEnvironment,
  agentRuntimeEnvironment,
  beginLaunch,
  collectStatus,
  deinitializeAgent,
  detectAgentInstallationAsync,
  effectiveAgentConfig,
  finishLaunch,
  getAgent,
  getSessionAdapter,
  importProjectSessions,
  initializeAgent,
  loadRuntime,
  projectConfig,
  quoteShellLine,
  resolveEffectiveAgentRuntime,
  type Agent,
  type AgentInstallation,
  type ReleasedMethod,
  type StatusAgent,
  type StatusModel,
} from "@avenic/core";
import { cliVersionStatus, type CliVersionStatus } from "./agent-versions.ts";
import { chineseVisible, LocalizedError, sentence } from "../i18n/text.ts";

export interface AgentStatus {
  agent: Agent;
  executableAvailable: boolean;
  initialized: boolean;
  // 认证的整份解答来自 core 的状态模型：方法（account/api）、作用域、来源
  // （project/local）、账号 home、以及 API 那一侧读了哪个文件、选了哪个 provider。
  // 插件不重算其中任何一项——CLI 的 status、树视图、仪表盘问的是同一个函数。
  auth: StatusAgent["auth"];
  // "native" 给那些自己回答认证的 agent（OpenCode）：它的认证不是 Avenic 的答案，
  // 也不该被说成「没选」。树视图和仪表盘都要靠这个字知道自己面对的是哪一种。
  runtime: StatusAgent["runtime"];
  sessions: StatusAgent["sessions"];
  // 本机已装版本与 npm registry 最新版（10 分钟缓存，失败容错为 null）
  cli: CliVersionStatus;
  installation: AgentInstallation;
}

// Agents and Dashboard ask for the same picture during one refresh cycle, and
// the picture is one call: `collectStatus` reads the runtime file, the
// executable classification, every agent's session counts and the auth facts
// once. Caching *it* (rather than each consumer's own slice) is what keeps a
// refresh from reading the project three times. Mutations explicitly invalidate
// from the extension shell.
const STATUS_TTL_MS = 1_000;
const statusCache = new Map<string, { at: number; value: Promise<StatusModel> }>();

export function invalidateAgentStatusCache(): void {
  statusCache.clear();
}

/** The whole project picture, shared by the tree view and the dashboard. */
export function projectStatus(projectRoot: string, environment: NodeJS.ProcessEnv = process.env): Promise<StatusModel> {
  // 同一份项目、同一个环境才叫同一份答案：环境决定了 state 目录（Hub 缓存、全局
  // Skills），把它排除在键外就等于让一次注入环境的调用读到另一个环境的结果。
  // The key covers every variable the picture depends on — the state root and
  // the two agent homes a project-scoped account relocates — so two environments
  // that would render differently never share an entry.
  const key = [projectRoot, environment.AVENIC_STATE_DIR ?? "", environment.CLAUDE_CONFIG_DIR ?? "", environment.CODEX_HOME ?? ""].join("\u0000");
  const cached = statusCache.get(key);
  if (cached !== undefined && Date.now() - cached.at < STATUS_TTL_MS) return cached.value;
  // 面板每次显式取数时要的是「现在」：进入时清一次，避免把上一轮缓存当本轮结果。
  const pending = collectStatus(projectRoot, { environment });
  statusCache.set(key, { at: Date.now(), value: pending });
  return pending;
}

export function listAgents(): Agent[] {
  return Object.keys(AGENTS).map((id) => getAgent(id)); // AGENTS 值不含 id，getAgent 补齐
}

// 面板的安装/升级入口同样不该阻塞事件循环：探测一次即拿到 executable 与 version。
export async function detectInstallation(agentId: string): Promise<AgentInstallation> {
  return detectAgentInstallationAsync(agentId);
}

export async function agentStatus(projectRoot: string, agentId: string, environment: NodeJS.ProcessEnv = process.env): Promise<AgentStatus> {
  const agent = getAgent(agentId);
  const [status, installation] = await Promise.all([
    projectStatus(projectRoot, environment),
    detectAgentInstallationAsync(agentId),
  ]);
  const row = status.agents.find((entry) => entry.id === agentId);
  if (row === undefined) throw new Error(`Unknown agent: ${agentId}`);
  // registry 版本是异步网络查询，10 分钟内命中缓存；单次失败容错为 null
  const cli = await cliVersionStatus(agentId, agent, undefined, installation);
  return {
    agent,
    executableAvailable: row.available,
    initialized: row.initialized,
    auth: row.auth,
    runtime: row.runtime,
    sessions: row.sessions,
    cli,
    installation,
  };
}

export { invalidateCliVersionCache } from "./agent-versions.ts";

// 写入口只有一个形状：命名的答案（authMethod + 该方法自己的作用域 + 会话作用域）。
// 位置参数在这里还能编译，但写出来的会是别的东西——core 会拒绝，也就不必等运行时。
export function initialize(projectRoot: string, agentId: string, answers: Parameters<typeof initializeAgent>[2]) {
  return initializeAgent(projectRoot, agentId, answers).finally(invalidateAgentStatusCache);
}

export async function readProjectConfiguration(projectRoot: string) {
  return projectConfig(await loadRuntime(projectRoot));
}

export function deinitialize(projectRoot: string, agentId: string, purge?: boolean) {
  return deinitializeAgent(projectRoot, agentId, purge ? { purge: true } : undefined).finally(invalidateAgentStatusCache);
}

// 释放的总结句：这一轮把旧配置还回去了什么。三种结果都要说——删掉的、按设计
// 留下的（Account 的家），以及最要紧的那种：原值 Avenic 只存过 hash（用户自己
// 写过、被覆盖），它给不回来。第三种不出现在句子里，用户就会以为一切都恢复了。
// 与 CLI 的 releaseLines 说的是同一组事实，各自用自己的语言。
export function releaseSummary(released: ReleasedMethod[], language: string): string {
  const removed = released.filter((entry) => entry.removed > 0 || entry.deleted);
  const kept = released.filter((entry) => entry.removed === 0 && !entry.deleted);
  const unrecoverable = released.reduce((sum, entry) => sum + entry.kept, 0);
  // 并列用什么标点是语言的事（中文顿号、英文逗号），不是格式：它是句子的一部分。
  const join = (items: string[]) => items.join(chineseVisible(language) ? "、" : ", ");
  return [
    removed.length > 0 ? sentence(language, "release.removed", {
      entries: join(removed.map((entry) => sentence(language, "release.removed-entry", { file: entry.relative ?? "", count: entry.removed }))),
    }) : "",
    kept.length > 0 ? sentence(language, "release.kept", { files: join(kept.map((entry) => entry.relative ?? entry.home ?? "")) }) : "",
    unrecoverable > 0 ? sentence(language, "release.unrecoverable", { count: unrecoverable }) : "",
  ].filter(Boolean).join(" · ");
}

export function importSessions(projectRoot: string, agentId: string) {
  // Import means native Agent history -> project portable storage. This must
  // match `avenic <agent> sessions import`; restore is the explicit writeback.
  return importProjectSessions(projectRoot, agentId);
}

export async function writebackSessions(projectRoot: string, agentId: string) {
  // 回写落到 agent 真正运行的那个 home（Account · Project 是项目自己的），和导入读
  // 的是同一棵树：core 的组合，不是调用方各自拼的。
  return getSessionAdapter(agentId).restore(projectRoot, { environment: await effectiveAgentEnvironment(projectRoot, agentId) });
}

// ---- 启动运行（免 @avenic/cli npm 包：插件直接复用 core 运行时原语） ----
// 等价于 `avenic <agent>` 的一次启动：认证环境注入（Account·Project 把配置根指向
// 项目自己的 home）、便携会话快照/恢复/回收（与 CLI 共用同一 lease 文件与快照目录，
// 交叉启动互不冲突）。官方 CLI 交互在集成终端进行；终端关闭时由命令层调用 finishRun 收官。

export interface AgentLaunchDefinition {
  name: string;
  cwd: string;
  environment: Record<string, string>;
  // core 解析出的 argv（Codex 项目作用域下就是那串 -c key=value）。命令层用
  // sendText(command) 启动，保留它是为了让解析结果能被独立断言，也为将来的
  // argv 直启留位。
  argumentsList: string[];
  command: string; // 终端内执行的官方 CLI 命令（端子按 PATH 解析）
  // 解析给出的可读说明（core 的 note：为什么这次没有带上 API 配置等原因）；无异常时为 null。
  note: string | null;
}

export interface PreparedLaunch {
  definition: AgentLaunchDefinition;
  // 收官：捕获本次运行会话进项目并偿还 lease（最后成员恢复原生存储）；幂等。
  finishRun: () => Promise<void>;
}

export async function prepareAgentLaunch(projectRoot: string, agentId: string, options: { argumentsList?: string[]; language?: string } = {}): Promise<PreparedLaunch> {
  const agent = getAgent(agentId);
  const state = await loadRuntime(projectRoot);
  const effective = effectiveAgentConfig(state, agentId);
  if (effective === null) {
    // 键而不是句子：这一层没有 vscode，不知道编辑器现在是哪种语言——showError 在说这句话
    // 的时候把它翻出来。
    throw new LocalizedError("agent.not-initialized", { agent: agent.displayName });
  }
  // 与 CLI 启动同一个环境：用户自己的那份，一个字都不改。认证方法只是配置，
  // 不是登录；只有 Account·Project 会把子进程的配置根指向项目自己的 home。
  const environment = machineEnvironment() as Record<string, string>;
  // 与 `avenic <agent>` 启动取用的是同一个解析结果：会话适配器/终端拿到 argv、
  // 子进程环境与"为什么不带 API 配置"（note）三件东西，判定逻辑不在插件里重写。
  let launchArguments: string[] = [];
  let launchEnvironment = environment;
  let launchNote: string | null = null;
  // 继续共享会话时 argv 由 core 的 prepareCanonicalContinuation 给出——「这条会话
  // 该怎么打开」只有它回答得了——这里仍然向 core 要一次认证环境：继续不是一次
  // 特殊启动，它和普通启动用同一份凭据解析。
  let resolvedEnvironment: Record<string, string> | null = null;
  try {
    let logged: string | null = null;
    const runtime = await resolveEffectiveAgentRuntime(projectRoot, agentId, {
      state,
      environment,
      io: { log: (line: string) => { logged = line; } },
    });
    resolvedEnvironment = runtime.environment as Record<string, string>;
    if (options.argumentsList === undefined) {
      launchArguments = runtime.argumentsList;
      launchNote = runtime.note ?? logged;
    }
  } catch (error) {
    // 走到这里只可能是一件事：这个项目还没回答认证（"未初始化"在函数开头
    // 就已经返回了）。启动照常进行——core 解析不出方法时用的就是用户自己的环境
    // ——但原因必须说对：不是"API 配置没生效"，而是没有答案。插件不画这道题，
    // 因为它的答案要写进项目而不是这一次运行。
    if (options.argumentsList === undefined) {
      // 宿主给的是什么语言就用什么语言；没给（测试、非编辑器宿主）时是英文——它是产品的
      // 主语言，也是词表在其它任何语言下的答案。
      launchNote = sentence(options.language ?? "", "agent.no-auth-picked", { agent: agent.displayName });
    }
  }
  if (options.argumentsList !== undefined) launchArguments = options.argumentsList;
  if (resolvedEnvironment !== null) launchEnvironment = resolvedEnvironment;
  const sharedSessions = projectConfig(state).historyMode === "shared";
  // 这次运行的原生存储就在 agent 自己的配置根下：Account·Project 指向项目内，
  // 其余情况就是调用方的那一份。快照与收官回写因此共用同一个环境值，而不是各自
  // 去猜——读错根就会一个会话都捕获不到，还会把快照还原到别的树上去。
  const runtimeEnvironment = agentRuntimeEnvironment(projectRoot, agentId, effective, environment);
  // 启动的开启序列（加入启动组 → 项目会话记录优先）与 CLI 共用 core 的同一份实现：
  // 首个成员快照原生存储、末个成员还原，恢复失败时由同一步释放组。插件只加入本
  // agent 的组：启动不扫描其它 agent 的原生历史，那是 Sessions 命令的职责。
  const { portable: portableSessions, member } = await beginLaunch(projectRoot, agentId, { config: effective, environment: runtimeEnvironment });
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
      environment: runtimeEnvironment,
      member,
      setActive: sharedSessions,
    });
  };
  return {
    definition: {
      name: `Avenic · ${agent.displayName}`,
      cwd: projectRoot,
      environment: launchEnvironment,
      argumentsList: launchArguments,
      // sendText 把整行交给用户的 shell 二次解析：引号规则由 core 的
      // quoteShellLine 回答（与启动器 .cmd 分支同一份），插件不自己实现一份。
      command: quoteShellLine(agent.executable, launchArguments),
      note: launchNote,
    },
    finishRun,
  };
}
