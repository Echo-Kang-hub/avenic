import { stat } from "node:fs/promises";
import path from "node:path";
import {
  agentCardRows,
  agentLabel,
  formatSessionDiagnostics,
  listCanonicalSessionRecords,
  mappingState,
  readCanonicalSession,
  readCanonicalSessionRecord,
  runtimePaths,
  shortTimestamp,
  transcriptSummary,
  transcriptTurns,
  unmanagedSkillNames,
  type CanonicalSessionRecord,
  type InstallStatus,
  type NativeSessionMapping,
  type Pack,
  type StatusAgent,
  type StatusModel,
} from "@avenic/core";
import { projectStatus } from "../services/agents.ts";
import { aboutFacts, type AboutOptions } from "../services/about.ts";
import { defaultSpec, packsFor } from "../services/catalog.ts";
import { centerState } from "../services/center.ts";
import { hooksFacts, type HookOptions } from "../services/hooks.ts";
import { describeSkill, installedPackIds, readSkillsSnapshot } from "../services/skills.ts";
import { CORE_VERSION } from "../product.ts";
import { AGENT_IDS, runStateOf, type AboutState, type ActivityRow, type AgentCard, type AgentId, type BadgeTone, type CenterResult, type CenterState, type DashboardData, type FieldRow, type HookScope, type HooksResult, type PackRow, type RunState, type SessionRow, type SessionSync, type SkillRow, type Transcript, type TranscriptTurn } from "./protocol.ts";

// 仪表盘的数据组装（无 vscode import，因此测试不需要编辑器）：面板上每一格都取自
// core 的同一份答案 —— `avenic status` 的那张模型、core 的会话记录、core 的 Skill
// 安装状态。插件自己不判断「这个项目现在是什么样」，因此也不会与 CLI 说法不一致。
//
// 两件事在这里被刻意**不**做：
//   1. 不读事件日志。会话标题在导入时就已经由 core 按「原生 summary → 首条用户发言
//      → 短 id」定下来了，概览页再解析一遍就是为画 5 行字打开几十兆。
//   2. 不替 agent 回答它自己管的事。OpenCode 的 provider 不在 core 的解答里，于是
//      面板上就没有那一格 —— 空着好过编一个；Account 模式的模型来自 agent 自己的
//      配置文件（core 读了它），不是插件为它猜的。

// 会话数超过这个数就不再逐条列出：概览是「最近发生了什么」，完整列表在 Sessions 页。
const LIST_LIMIT = 5;
// 那个「完整列表」也有个头：一页里能读的条数不是无限的，而且每一行都要读一次它的
// 参与记录。到这个数就停，并把「列了多少、总共有多少」一起说出来。
const DETAIL_LIMIT = 50;
const ACTIVITY_LIMIT = 3;

const SESSION_SCOPE_LABEL: Record<string, string> = { project: "Project", global: "Global" };
// 安装目标按运行时分组，面板按 agent 一一平等分行。目标是 agent id 的超集。
const TARGET_AGENTS: Record<string, AgentId | null> = {
  "claude-code": "claude",
  codex: "codex",
  opencode: "opencode",
  universal: null, // 不是某一个 agent 的目录
};

/** "2 hours ago" — 相对时间由面板算，存在盘上的永远是那个 ISO 时刻。 */
export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (typeof iso !== "string") return "—";
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "—";
  const seconds = Math.max(0, Math.floor((now - at) / 1_000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

// 卡片上半部分：这个 agent 的认证答案。**行的名字与值不在这里** —— 它们来自 core
// 的 `agentCardRows`，也就是 `avenic <agent>` 那张卡片印的同一组行：一行该不该出现、
// 值是什么、用哪个词，全部由 core 决定，两个宿主因此不可能各说各的。这里只决定画法
// （kind/tone/icon），按 core 给出的 `key` 排 —— 按 label 排就等于让插件依赖一句
// 会变的文案。
const FIELD_STYLE: Record<string, Pick<FieldRow, "kind" | "tone" | "icon">> = {
  authentication: { kind: "badge", tone: "blue", icon: "account" },
  accountStatus: { kind: "status", tone: "muted", icon: "account" },
  accountScope: { kind: "value", tone: "muted", icon: "folder" },
  configSource: { kind: "value", tone: "muted", icon: "file-code" },
  provider: { kind: "value", tone: "muted", icon: "package" },
  // 可选项就是文件里那一个值：面板不提供一份自己维护的模型表，改动走 Change 向导。
  model: { kind: "select", tone: "muted", icon: "symbol-structure" },
  opusModel: { kind: "value", tone: "muted", icon: "symbol-structure" },
  sonnetModel: { kind: "value", tone: "muted", icon: "symbol-structure" },
  haikuModel: { kind: "value", tone: "muted", icon: "symbol-structure" },
  subAgentModel: { kind: "value", tone: "muted", icon: "symbol-structure" },
  effort: { kind: "value", tone: "muted", icon: "dashboard" },
  reasoningEffort: { kind: "value", tone: "muted", icon: "dashboard" },
};
// 会话与历史在卡片上是两个角标，不是这一列里的行。
const CHIP_ROWS = new Set(["sessions", "history"]);

function authFields(row: StatusAgent, historyMode: StatusModel["project"]["historyMode"]): FieldRow[] {
  return agentCardRows(row, historyMode)
    .filter((row_) => !CHIP_ROWS.has(row_.key))
    .map((row_) => {
      const field: FieldRow = { label: row_.label, value: row_.value, ...(FIELD_STYLE[row_.key] ?? { kind: "value", tone: "muted", icon: "file-code" }) };
      // 徽章的颜色说的是哪一半答案：Account 是蓝色，API 是灰，自管的 agent 是紫色；
      // 图标同理 —— 自管认证和还没回答用的都是钥匙（那一格不是 Avenic 的答案）。
      if (row_.key === "authentication") {
        field.tone = row.runtime === "native" ? "purple" : row.auth?.method === "account" ? "blue" : "muted";
        field.icon = row.runtime === "native" || !row.auth ? "key" : "account";
      }
      if (row_.key === "accountStatus") field.tone = row.auth?.status === "signed-in" ? "green" : "muted";
      // 端点那一位点下去打开的是承载它的文件 —— 面板不链接到 provider 自己。
      if (row_.key === "provider" && row.auth?.configuration) field.href = row.auth.configuration.relative;
      if (row_.key === "model") field.options = [row_.value];
      return field;
    });
}

function agentCard(row: StatusAgent, historyMode: StatusModel["project"]["historyMode"]): AgentCard {
  const id = row.id as AgentId;
  const ready = row.initialized && row.available;
  const scope = row.sessions === null ? "Not set" : SESSION_SCOPE_LABEL[row.sessions] ?? row.sessions;
  return {
    id,
    label: row.displayName,
    short: agentLabel(id),
    ready,
    run: runStateOf(row.history.sync),
    statusText: ready
      ? "Ready"
      : !row.available
        ? "CLI not installed"
        : "Not configured",
    detail: id === "opencode"
      ? "OpenCode manages its own provider, sign-in and model selection. Avenic does not modify them."
      : null,
    fields: authFields(row, historyMode),
    sessions: { label: scope, count: row.history.sessions, tone: row.sessions === "project" ? "brand" : "blue" },
    // 共享与隔离是两种不同的项目：颜色是这句话在面板上的那一半。
    history: { label: historyMode === "shared" ? "Shared" : "Isolated", tone: historyMode === "shared" ? "brand" : "muted" },
    // 引导图标说「这一步会打开什么」：Claude 是一份文件，Codex 是它的目录，
    // OpenCode 是它自己的界面。目的地箭头由渲染层统一补在末尾。
    configLink: id === "claude"
      ? { label: "Open Config File", icon: "go-to-file" }
      : id === "codex"
        ? { label: "Open Config Folder", icon: "folder-opened" }
        : { label: "Open OpenCode", icon: "link-external" },
    // 启动是「跑这个项目里的这个 agent」：没装、没配置都跑不起来。Change 永远可用 ——
    // 它正是「还没配置」时要走的那一步。
    actions: { launch: ready, change: true },
  };
}

// 「最近更新」这一格：core 报的是最新一条会话的时间，配好了却还没有任何会话的项目
// 就没有答案——那时用这个项目的 Avenic 配置本身（`.agents/runtime.json`，初始化写下
// 的那一份）的 mtime 回答，两处都答不出才留空，而不是印一个空字符串（它在标题栏里
// 会变成一个悬着的冒号）。取两者中较晚的那一个，因此「Last updated」说的确实是这个
// 项目的状态最后一次变动。
async function lastUpdated(projectRoot: string, sessionUpdatedAt: string | null): Promise<string | null> {
  const moments: Array<string | null> = [sessionUpdatedAt];
  try {
    moments.push((await stat(runtimePaths(projectRoot).runtimeFile)).mtime.toISOString());
  } catch { /* 还没配置过：那它不是一个时刻 */ }
  const known = moments.filter((value): value is string => value !== null && !Number.isNaN(Date.parse(value)));
  const newest = known.sort((left, right) => Date.parse(left) - Date.parse(right)).at(-1) ?? null;
  if (newest === null) return null;
  // 时间戳只有一种写法（core 的 shortTimestamp），两个宿主才不会把同一个时刻印成两种。
  return shortTimestamp(newest);
}

// 标题为空时才轮得到 id，而且只取一小段、不拼 agent 的名字：`claude bee6f9b7`
// 看起来像一句人话，其实仍然只是一串编号——把编号打扮成名字比露出编号更坏。
function shortId(id: string): string {
  const separator = id.indexOf(":");
  return (separator === -1 ? id : id.slice(separator + 1)).slice(0, 8);
}

function sessionRow(record: CanonicalSessionRecord, agents: AgentId[], active: boolean, now: number, sync: SessionSync): SessionRow {
  const updated = typeof record.updatedAt === "string" ? record.updatedAt : null;
  return {
    id: record.id,
    // core 的标题解析保证这里不是 uuid（原生名 → 首条用户发言 → 短 id）；万一它空着，
    // 兜底的也必须是短 id，而不是一行工程编号。
    title: typeof record.title === "string" && record.title ? record.title : shortId(record.id),
    agents,
    updated: updated ?? "",
    relative: relativeTime(updated, now),
    active,
    sync,
  };
}

// 谁参与了这条会话、以及投影跟不跟得上：两个答案在同一份映射里，而映射与事件日志
// 分开存放 —— 问「谁参与、同步到哪」不该以读一整段对话为代价。
//
// `running` 说的是这一行上的某个 agent 正在跑，不是「这条对话正在被写」：core 的
// 启动组只知道某个 agent 在这个项目里跑着，不知道它跟哪一条会话说话，面板不替它
// 编一个更具体的说法。
async function participation(
  projectRoot: string,
  id: string,
  lastEventId: string | null,
  runs: Record<AgentId, RunState>,
): Promise<{ agents: AgentId[]; projections: Record<string, NativeSessionMapping>; sync: SessionSync }> {
  try {
    const { mappings } = await readCanonicalSessionRecord(projectRoot, id);
    const projections = mappings.projections ?? {};
    // 参与者与角标问的是同一句话：这一格的映射是不是指着一个真的原生会话。
    const agents = AGENT_IDS.filter((agent) => mappingState(projections[agent], lastEventId) !== "none");
    return {
      agents,
      projections,
      sync: {
        state: syncAcross(agents.map((agent) => projections[agent]), lastEventId),
        running: agents.some((agent) => runs[agent] === "running"),
      },
    };
  } catch {
    // 读不到映射（会话被删、权限变了）不是「没有参与者」以外的事：这一行照旧列出来，
    // 只是它说不出自己归谁。
    return { agents: [], projections: {}, sync: { state: "none", running: false } };
  }
}

// 一条会话可能同时投给两个 agent：只要有一个的拷贝落后了，这一行就该说出来。
// 「一个映射算不算跟得上」不在这里判断 —— 那是 core 的 mappingState，投影器和这一行
// 角标问的是同一个问题，答的也必须是同一个词。
function syncAcross(mappings: Array<NativeSessionMapping | undefined>, lastEventId: string | null): SessionSync["state"] {
  const states = mappings.map((mapping) => mappingState(mapping, lastEventId)).filter((state) => state !== "none");
  if (states.length === 0) return "none";
  return states.every((state) => state === "current") ? "current" : "stale";
}

// 一个 Skill 落在哪些 agent 手里：先问它是否受管（未受管的 Skill 不在任何 agent 的
// 托管目录里），再看每个安装目标是否真的把它带全了 —— 目标是 agent id 的超集，
// universal 那样的目录不属于某一个 agent。
function skillAgents(status: InstallStatus | null, name: string): AgentId[] {
  if (status === null || !status.managedNames.includes(name)) return [];
  const agents = new Set<AgentId>();
  for (const target of status.targets) {
    if (!target.complete) continue;
    for (const agent of target.agents) {
      const id = TARGET_AGENTS[agent];
      if (id) agents.add(id);
    }
  }
  return AGENT_IDS.filter((id) => agents.has(id));
}

// 一个 Skill 行只有两件事要说：它属于谁、它现在是不是真的在。链接被人换成了别的
// 目录时 core 会把名字放进 conflicts —— 那一行就不该再显示 Enabled。
function conflictsWith(status: InstallStatus, name: string): boolean {
  return status.targets.some((target) => (target.conflicts ?? []).some((conflict) => conflict.name === name));
}

async function skillRows(status: InstallStatus | null, unmanaged: string[]): Promise<SkillRow[]> {
  const rows: SkillRow[] = [];
  if (status !== null) {
    const directories = new Map(status.groups.flatMap((group) => group.skills.map((skill) => [skill.name, skill.directory] as const)));
    for (const name of status.names) {
      const description = await describeSkill(directories.get(name) ?? "");
      rows.push({
        name,
        description: description ?? "",
        agents: skillAgents(status, name),
        enabled: status.managedNames.includes(name) && !conflictsWith(status, name),
      });
    }
  }
  // 磁盘上有、Avenic 没管的 Skill 也在这张表里：它们确实装着，只是不归 Avenic 管。
  for (const name of unmanaged) {
    rows.push({ name, description: "", agents: [], enabled: false });
  }
  return rows;
}

function packRows(packs: Map<string, Pack>, installed: string[]): PackRow[] {
  return [...packs.values()].map((pack) => ({
    // id 不显示，但它是那一行「Install」要装的东西：按名字去猜一个 pack 是另一回事。
    id: pack.id,
    name: pack.name,
    description: pack.description ?? "",
    installed: installed.includes(pack.id),
    count: pack.sources.reduce((total, source) => total + source.skills.length, 0),
  }));
}

// 没有项目就没有状态模型 —— 不是三个「未配置」的 agent，而是三张说不出话的卡。
function unopenedCards(): AgentCard[] {
  return AGENT_IDS.map((id) => ({
    id,
    label: agentLabel(id),
    short: agentLabel(id),
    ready: false,
    run: "idle",
    statusText: "No project open",
    detail: null,
    fields: [{ label: "Authentication", kind: "badge", value: "Not chosen", tone: "muted", icon: "key" }],
    sessions: { label: "—", count: 0, tone: "muted" },
    history: { label: "—", tone: "muted" },
    configLink: null,
    actions: { launch: false, change: false },
  }));
}

export interface DashboardOptions {
  /** 面板底部那一行版本号：这台机器上真正在用的 Avenic CLI（探不到时留空）。 */
  cliVersion?: string | null;
  /** 底部那一行悬停时展开的第二个版本：宿主真正加载的那份扩展的版本。 */
  extensionVersion?: string;
  /** 最近发生的操作，由宿主的活动环形缓冲给出（核心数据之外唯一由宿主提供的一段）。 */
  activity?: ActivityRow[];
  /** 用户点开的那一条会话：只有它的事件日志会被读（初帧一条都不读）。 */
  transcriptId?: string | null;
  /** 这一份是给「完整清单」那一页的：列到 DETAIL_LIMIT 为止，而不是概览的 5 条。 */
  detail?: boolean;
  /**
   * 模型配置中心正在看哪个 agent。**只有这一页会给出它**，所以只有这一页会去读
   * agent 自己的配置文件：别的分区一个字节的额外读盘都不发生。没有它就不组装中心
   * 的状态——「没打开过这一页」与「这一页是空的」是两件事。
   */
  centerAgent?: AgentId | null;
  /** 上一次的测试／预览／写入结果；面板自己记着它，页面刷新后照着再画一遍。 */
  centerResult?: CenterResult | null;
  /** 编辑器自己的语言：中心那几块的名字是宿主给页面画的句子，按它说哪一半。 */
  language?: string;
  /**
   * 钩子与通知那一页正看着哪一档作用域。**只有这一页会给出它**，而且只有这一档的名单
   * 会被读：另一档的那份文件在这一帧里一个字节都不读。没有它就不组装这一页的状态。
   */
  hooksScope?: HookScope | null;
  /** 钩子页上一次问题回答了什么（预览、装、卸、写名单）；面板自己记着它。 */
  hooksResult?: HooksResult | null;
  /** 钩子那三个版本从哪里读（默认是那一个真的探测器）。用例注入它，于是测试不跑任何 CLI。 */
  detect?: HookOptions["detect"];
  /**
   * 设置与关于那一页要说的、只有宿主才知道的那几个事实（清单里的版本、编辑器自己的
   * 版本、这个配置文件下的存储目录）。core 的版本与语言由这一层补上。
   */
  about?: Omit<AboutOptions, "coreVersion" | "language"> | null;
  now?: number;
}

// 模型表那一行说的是「手里有多少」与「上一次问供应商的结果」：core 的缓存里只有成功的
// 名单，失败的原因不在盘上 —— 它只存在于面板记着的那一次结果里，于是从这里回到页面上。
function catalogNote(result: CenterResult | null): string | null {
  return result?.kind === "catalog" && result.state === "failed" ? result.note : null;
}

export async function buildDashboardData(
  projectRoot: string | null,
  environment: NodeJS.ProcessEnv = process.env,
  options: DashboardOptions = {},
): Promise<DashboardData> {
  const now = options.now ?? Date.now();
  const detail = options.detail === true;
  const limit = detail ? DETAIL_LIMIT : LIST_LIMIT;
  // 底部那一行的两个版本：CLI 是主（产品版本），扩展是悬停时展开的那一个。
  const cli = options.cliVersion ?? "";
  const versionDetails = { cli, extension: options.extensionVersion ?? "" };
  // 关于那一页说的是这套安装本身，不是这个项目：没有打开项目时它也说得出来（版本、
  // 存储目录），只有那几行需要项目路径的行会换成「没有打开项目」。
  const about: AboutState | null = options.about ? await aboutFacts(projectRoot, { ...options.about, coreVersion: CORE_VERSION, language: options.language ?? "en" }) : null;
  if (projectRoot === null) {
    return {
      version: cli,
      versionDetails,
      detail,
      project: { name: "", root: null, configured: false, lastUpdated: null },
      agents: unopenedCards(),
      history: { mode: "shared", sharedCount: 0 },
      shared: { rows: [], total: 0 },
      native: { claude: emptyRows(), codex: emptyRows(), opencode: emptyRows() },
      skills: { installed: [], installedTotal: 0, packs: [], packsTotal: 0 },
      hub: { spec: null, revision: null, state: "missing" },
      activity: options.activity ?? [],
      transcript: null,
      // 没有项目就没有 agent 的文件可读：这一页照旧画得出来，只是还没有事实可放。
      center: null,
      centerResult: null,
      // 钩子装的是这个项目里的机制、写的是这个项目的名单：没有项目就没有这一页。
      hooks: null,
      hooksResult: null,
      about,
      empty: "Open a project folder to see its Avenic state.",
    };
  }
  const status = await projectStatus(projectRoot, environment);
  const records = await listCanonicalSessionRecords(projectRoot);
  const listed = records.slice(0, limit);
  const activeId = status.history.active;
  // 一次启动的状态：每行都要问「这一行上的 agent 正跑着吗」，所以先算一遍。
  const runs = {} as Record<AgentId, RunState>;
  for (const agent of status.agents) runs[agent.id as AgentId] = runStateOf(agent.history.sync);
  // 映射每行只读一次：共享卡与各 agent 的分卡问的是同一件事。
  const sharedRows: SessionRow[] = [];
  const byAgent = new Map<AgentId, SessionRow[]>(AGENT_IDS.map((id) => [id, []]));
  for (const record of listed) {
    const lastEventId = typeof record.lastEventId === "string" ? record.lastEventId : null;
    const { agents, projections, sync } = await participation(projectRoot, record.id, lastEventId, runs);
    const active = record.id === activeId;
    sharedRows.push(sessionRow(record, agents, active, now, sync));
    // Agent Sessions：这条会话归哪几个 agent，就同时出现在哪几张分卡里。分卡上这一行
    // 的同步说的是「那一个 agent 的投影」，所以只问它自己那一份映射 —— 同一份映射，
    // 不再读第二遍盘。
    for (const agent of agents) {
      byAgent.get(agent)?.push(sessionRow(record, [], active, now, {
        state: syncAcross([projections[agent]], lastEventId),
        running: runs[agent] === "running",
      }));
    }
  }

  const snapshot = await readSkillsSnapshot("project", projectRoot, environment).catch(() => null);
  const unmanaged = unmanagedSkillNames(snapshot?.status ?? null, snapshot?.detected ?? []);
  const installed = await skillRows(snapshot?.status ?? null, unmanaged);
  // Pack 列表只读本地缓存：Catalog 是 git 拉下来的，为列几个名字去 fetch 会让
  // 「打开面板」变成一次网络等待（实测 7 秒）。没缓存就如实空着，同步由用户发起。
  const spec = await defaultSpec(environment).catch(() => null);
  const packs = (spec === null ? null : await packsFor(spec, environment, { cachedOnly: true }).catch(() => null)) ?? new Map<string, Pack>();
  const installedIds = await installedPackIds("project", projectRoot, environment).catch(() => null);

  const native = {} as DashboardData["native"];
  for (const agent of status.agents) {
    const id = agent.id as AgentId;
    native[id] = { rows: byAgent.get(id) ?? [], total: agent.history.sessions };
  }

  // 中心的状态只在它自己那一页组装，而且读的是 agent 自己的文件（service 里那一次
  // core 读盘）。别的分区把 centerAgent 留空，于是这一行就是 null。
  const centerResult = options.centerResult ?? null;
  const center: CenterState | null = options.centerAgent ? await centerState(projectRoot, options.centerAgent, environment, options.language ?? "en") : null;
  // 钩子页同理：只有它自己在屏幕上的时候才组装，而且只读它正看着的那一档作用域。三个
  // agent 的版本探测器各跑一次，所以别的分区不会为这一页付这一次代价。
  const hooks: DashboardData["hooks"] = options.hooksScope
    ? await hooksFacts(projectRoot, options.hooksScope, { environment, language: options.language ?? "en", detect: options.detect })
    : null;
  return {
    version: cli,
    versionDetails,
    detail,
    project: {
      name: status.project.name,
      root: status.project.root,
      configured: status.project.configured,
      lastUpdated: await lastUpdated(projectRoot, status.history.updatedAt),
    },
    agents: status.agents.map((row) => agentCard(row, status.project.historyMode)),
    history: { mode: status.project.historyMode, sharedCount: status.history.sessions },
    shared: { rows: sharedRows, total: records.length },
    native,
    skills: {
      installed: installed.slice(0, limit),
      installedTotal: installed.length,
      packs: packRows(packs, installedIds ?? []).slice(0, limit),
      packsTotal: packs.size,
    },
    // 三态照抄，不压成布尔：落后于远端的那份缓存不是「已同步」。
    hub: { spec: status.skills.hub.spec, revision: status.skills.hub.revision, state: status.skills.hub.cache },
    activity: (options.activity ?? []).slice(0, ACTIVITY_LIMIT),
    transcript: options.transcriptId ? await readTranscript(projectRoot, options.transcriptId, activeId, now) : null,
    center: center === null ? null : { ...center, catalog: { ...center.catalog, note: catalogNote(centerResult) } },
    centerResult,
    hooks,
    // 上一次问题的答案由面板记着；这一页不在屏幕上时它就是 null，页面也不会画它。
    hooksResult: options.hooksScope ? options.hooksResult ?? null : null,
    about,
    empty: status.project.configured ? null : "This project has no Avenic configuration yet.",
  };
}

function emptyRows(): { rows: SessionRow[]; total: number } {
  return { rows: [], total: 0 };
}

// 打开一条会话＝这一次推送里带上它的对话。事件在手，标题也按同一条规则取：打开
// 之后标题和列表里那一行必须是同一个名字，否则用户会以为自己打开错了。
//
// 读多少轮：阅读器一屏看最新 100 轮，再往上滚可以够到更早的那些，所以宿主读的必须
// 比 100 多一截，否则「往上滚」够到的是载荷的边，而不是这段对话的开头。200 是一个
// 页宽的量级——一条比这更长的会话，页面会说出它没读到的那些轮，而不是假装这就是全部。
const TURN_LIMIT = 200;

async function readTranscript(projectRoot: string, id: string, activeId: string | null, now: number): Promise<DashboardData["transcript"]> {
  try {
    const { session, events, mappings } = await readCanonicalSession(projectRoot, id);
    // 轮次、说话人、标题全部交给 core：CLI 的 `sessions show` 与这一页读的是同一份
    // 判断（谁说的、哪些是工具、哪几条是控制行），两个宿主不会各说各的。
    const summary = transcriptSummary(session, events, { mappings });
    const turns: TranscriptTurn[] = transcriptTurns(events, { limit: TURN_LIMIT }).map((turn) => ({
      id: turn.id,
      kind: turn.kind,
      speaker: turn.speaker,
      agent: turn.agent === null ? null : (AGENT_IDS as readonly string[]).includes(turn.agent) ? (turn.agent as AgentId) : null,
      role: turn.role,
      at: turn.at ?? null,
      text: turn.text,
      tools: (turn.tools ?? []).map((tool) => ({ kind: tool.kind, name: tool.name, detail: tool.detail ?? "" })),
      model: turn.model ?? null,
    }));
    // 投影里记着导入时读不懂的那些行（损坏的记录、截断的尾巴）。它们不是错误日志，
    // 是「这份对话是从什么里面读出来的」——所以照 core 的说法原样带上，不自己解释。
    const projections = Object.values(mappings?.projections ?? {});
    return {
      id,
      title: summary.title,
      active: id === activeId,
      participants: summary.agents.map((agent) => agentLabel(agent)),
      updated: summary.updatedAt ?? null,
      updatedRelative: relativeTime(summary.updatedAt, now),
      eventCount: summary.events,
      sync: transcriptSync(summary.projections),
      turns,
      diagnostics: formatSessionDiagnostics(projections.flatMap((mapping) => mapping.diagnostics ?? [])),
    };
  } catch {
    // 会话读不到（被删了、目录权限变了）不是面板的失败：那一格空着，列表照旧。
    return null;
  }
}

// 这条对话同步到什么程度：投影是 core 给的（它读了事件日志，比列表那一格更准），
// 这一页只说一句话——全都跟上了就是 Synced，有一个落后就说清几个落后。
function transcriptSync(projections: Array<{ state: string }>): Transcript["sync"] {
  const current = projections.filter((projection) => projection.state === "current").length;
  if (projections.length === 0) return { state: "none", label: "No native session yet" };
  if (current === projections.length) return { state: "current", label: "Synced" };
  return { state: "stale", label: current === 0 ? "Stale" : `${projections.length - current} of ${projections.length} stale` };
}

export type { DashboardData, BadgeTone };
