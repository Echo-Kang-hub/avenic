import { stat } from "node:fs/promises";
import path from "node:path";
import {
  agentLabel,
  listCanonicalSessionRecords,
  readCanonicalSession,
  readCanonicalSessionRecord,
  runtimePaths,
  shortTimestamp,
  unmanagedSkillNames,
  type CanonicalEvent,
  type CanonicalSessionRecord,
  type InstallStatus,
  type Pack,
  type StatusAgent,
  type StatusModel,
} from "@avenic/core";
import { projectStatus } from "../services/agents.ts";
import { defaultSpec, packsFor } from "../services/catalog.ts";
import { describeSkill, installedPackIds, readSkillsSnapshot } from "../services/skills.ts";
import { AGENT_IDS, type ActivityRow, type AgentCard, type AgentId, type BadgeTone, type DashboardData, type FieldRow, type PackRow, type SessionRow, type SkillRow } from "./protocol.ts";

// 仪表盘的数据组装（无 vscode import，因此测试不需要编辑器）：面板上每一格都取自
// core 的同一份答案 —— `avenic status` 的那张模型、core 的会话记录、core 的 Skill
// 安装状态。插件自己不判断「这个项目现在是什么样」，因此也不会与 CLI 说法不一致。
//
// 两件事在这里被刻意**不**做：
//   1. 不读事件日志。会话标题在导入时就已经由 core 按「原生 summary → 首条用户发言
//      → 短 id」定下来了，概览页再解析一遍就是为画 5 行字打开几十兆。
//   2. 不替 agent 回答它自己管的事。Account 模式的模型、OpenCode 的 provider 都不在
//      core 的解答里，于是面板上就没有那一格 —— 空着好过编一个。

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

// 卡片上半部分：这个 agent 的认证答案。方法与作用域必须一起说 —— 说「项目认证」
// 而不说那份状态在哪儿，等于让人去找一个没写出来的目录。
function authFields(row: StatusAgent): FieldRow[] {
  if (row.runtime === "native") {
    return [{
      label: "Authentication",
      kind: "badge",
      value: "Native (OpenCode UI)",
      tone: "purple",
      icon: "key",
    }];
  }
  const auth = row.auth;
  if (auth === null) {
    // 没有方法不是「未初始化」的一种说法，而是这一题还没回答 —— 启动时会问。
    return [{ label: "Authentication", kind: "badge", value: "Not chosen", tone: "muted", icon: "key" }];
  }
  const scope = SESSION_SCOPE_LABEL[auth.scope] ?? auth.scope;
  const fields: FieldRow[] = [{
    label: "Authentication",
    kind: "badge",
    value: `${auth.method === "api" ? "API" : "Account"} (${scope})`,
    tone: auth.method === "api" ? "muted" : "blue",
    icon: "account",
  }];
  if (auth.method === "account") {
    const status = auth.status === "signed-in" ? "Signed in" : auth.status === "not-signed-in" ? "Not signed in" : "Unknown";
    fields.push({ label: "Account Status", kind: "status", value: status, tone: auth.status === "signed-in" ? "green" : "muted", icon: "account" });
    // 参考图里这一格叫 Account Scope，值把作用域和承载它的目录一起写出来：
    // Project (.agents/local/claude)。只写目录，读的人还得回头找它属于谁；只写作
    // 用域，那一行和上面的认证徽章就重复了。home 未知时仍然给出作用域。
    if (auth.home !== null) fields.push({ label: "Account Scope", kind: "value", value: `${scope} (${auth.home})`, tone: "muted", icon: "folder" });
    return fields;
  }
  // API：说清楚哪个文件承载配置、选了哪个 provider / model。凭据本身从不进入载荷 ——
  // core 只报「设了没有」，面板连那个布尔值都不显示。
  // owned 和 present 是两件事：账本记得写过（owned），文件里现在还有（present）。
  // 只有 present 时 provider/model 才是现在生效的配置；被用户在 Avenic 之外删掉或
  // 改掉之后，Config Source 那一格自己说出这件事，而不是继续展示旧值。
  const configuration = auth.configuration;
  const present = configuration?.present === true;
  const source = configuration === null ? "—"
    : present || !configuration.owned ? configuration.relative
      : `${configuration.relative} (no longer holds Avenic's configuration)`;
  fields.push({ label: "Config Source", kind: "value", value: source, tone: "muted", icon: "file-code" });
  if (present && configuration !== null) {
    if (configuration.provider) {
      fields.push({ label: "Provider", kind: "value", value: configuration.provider, tone: "muted", icon: "package", href: configuration.relative });
    }
    if (configuration.model) {
      // 可选项就是文件里那一个值：面板不提供一份自己维护的模型表，改动走 Change 向导。
      fields.push({ label: "Model", kind: "select", value: configuration.model, tone: "muted", icon: "symbol-structure", options: [configuration.model] });
    }
    // 角色键（Opus/Sonnet/Haiku/子代理）与 effort 是这份文件里真正写着的那几条：
    // 没写的角色不会得到一行，因此这些行可以说「这就是现在生效的配置」。Claude 的
    // 角色键与 Codex 的 reasoning 是各自 agent 的形状，这里只是把它们排成行。
    const settings = configuration.settings;
    for (const [label, value] of [
      ["Opus Model", settings?.opus],
      ["Sonnet Model", settings?.sonnet],
      ["Haiku Model", settings?.haiku],
      ["Sub Agent Model", settings?.subagent],
    ] as const) {
      if (value) fields.push({ label, kind: "value", value, tone: "muted", icon: "symbol-structure" });
    }
    // effort 的原值是小写的枚举（medium/max/…），参考图里写成首字母大写；值本身
    // 不动，只有这一行的写法跟着图走。
    for (const [label, value] of [["Default Effort", settings?.effort], ["Reasoning Effort", settings?.reasoning]] as const) {
      if (value) fields.push({ label, kind: "value", value: value.charAt(0).toUpperCase() + value.slice(1), tone: "muted", icon: "dashboard" });
    }
  }
  return fields;
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
    statusText: ready
      ? "Ready"
      : !row.available
        ? "CLI not installed"
        : "Not configured",
    detail: id === "opencode"
      ? "OpenCode manages its own provider, authentication and model configuration. Avenic does not modify them."
      : null,
    fields: authFields(row),
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

function sessionRow(record: CanonicalSessionRecord, agents: AgentId[], active: boolean, now: number): SessionRow {
  const updated = typeof record.updatedAt === "string" ? record.updatedAt : null;
  return {
    id: record.id,
    // core 的标题解析保证这里不是 uuid（原生名 → 首条用户发言 → 短 id）。
    title: typeof record.title === "string" && record.title ? record.title : record.id,
    agents,
    updated: updated ?? "",
    relative: relativeTime(updated, now),
    active,
  };
}

// 谁参与了这条会话：答案在原生映射里，而映射与事件日志分开存放 —— 问「谁参与」
// 不该以读一整段对话为代价。
async function participants(projectRoot: string, id: string): Promise<AgentId[]> {
  try {
    const { mappings } = await readCanonicalSessionRecord(projectRoot, id);
    return AGENT_IDS.filter((agent) => typeof mappings.projections?.[agent]?.nativeSessionId === "string");
  } catch {
    return [];
  }
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
  now?: number;
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
      empty: "Open a project folder to see its Avenic state.",
    };
  }
  const status = await projectStatus(projectRoot, environment);
  const records = await listCanonicalSessionRecords(projectRoot);
  const listed = records.slice(0, limit);
  const activeId = status.history.active;
  // 映射每行只读一次：共享卡与各 agent 的分卡问的是同一件事。
  const sharedRows: SessionRow[] = [];
  const byAgent = new Map<AgentId, SessionRow[]>(AGENT_IDS.map((id) => [id, []]));
  for (const record of listed) {
    const agents = await participants(projectRoot, record.id);
    const active = record.id === activeId;
    sharedRows.push(sessionRow(record, agents, active, now));
    // Project Sessions：这条会话归哪几个 agent，就同时出现在哪几张分卡里。
    for (const agent of agents) byAgent.get(agent)?.push(sessionRow(record, [], active, now));
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
    transcript: options.transcriptId ? await readTranscript(projectRoot, options.transcriptId, activeId) : null,
    empty: status.project.configured ? null : "This project has no Avenic configuration yet.",
  };
}

function emptyRows(): { rows: SessionRow[]; total: number } {
  return { rows: [], total: 0 };
}

// 打开一条会话＝这一次推送里带上它的对话。事件在手，标题也按同一条规则取：打开
// 之后标题和列表里那一行必须是同一个名字，否则用户会以为自己打开错了。
const TURN_LIMIT = 40;

async function readTranscript(projectRoot: string, id: string, activeId: string | null): Promise<DashboardData["transcript"]> {
  try {
    const { session, events } = await readCanonicalSession(projectRoot, id);
    return {
      id,
      title: displaySessionTitle(session, id),
      active: id === activeId,
      turns: events.slice(0, TURN_LIMIT).map((event) => ({ role: event.role, text: textOf(event) })),
    };
  } catch {
    // 会话读不到（被删了、目录权限变了）不是面板的失败：那一格空着，列表照旧。
    return null;
  }
}

function displaySessionTitle(session: { title?: unknown }, id: string): string {
  return typeof session.title === "string" && session.title ? session.title : id;
}

// 一轮话说到底在说什么：文本块直接连起来，非文本块（工具调用）只留它的名字——
// 概览不是阅读器，看不懂的部分不该被编成一句话。
function textOf(event: CanonicalEvent): string {
  const parts: string[] = [];
  for (const block of event.content ?? []) {
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (typeof block.name === "string") parts.push(`[${block.name}]`);
  }
  return parts.join(" ").trim();
}

export type { DashboardData, BadgeTone };
