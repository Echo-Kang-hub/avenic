// The dashboard's whole contract with the webview: one data payload, one
// validated message channel. Everything the webview shows arrives here, so the
// renderer never reads the disk and never trusts a string it receives — unknown
// sections and actions are dropped rather than forwarded.

export const AGENT_IDS = ["claude", "codex", "opencode"] as const;
export type AgentId = (typeof AGENT_IDS)[number];

export const SECTIONS = ["overview", "configure", "agents", "sessions", "skills", "quick"] as const;
export type DashboardSection = (typeof SECTIONS)[number];

/**
 * Sessions 页的两半：共享（这个项目跨 agent 的那一份历史）与 Agent（某个 agent
 * 自己那份原生会话）。它是落点的一部分——「View All Agent Sessions」与
 * 「View All Shared Sessions」去的是同一页的不同的另一半。
 */
export const SESSIONS_TABS = ["shared", "agent"] as const;
export type SessionsTab = (typeof SESSIONS_TABS)[number];

export type BadgeTone = "brand" | "blue" | "purple" | "green" | "muted";

/**
 * 一次启动此刻的样子，由 core 的启动组状态算出来（不是面板自己记的开没开过）。
 * `interrupted` 是一次没跑完就消失的启动：它不能看起来像 Ready。
 */
export type RunState = "idle" | "running" | "interrupted";

/**
 * core 里「一次启动此刻的样子」有两个入口、两种拼写：状态模型（`syncState`）说
 * "running"/"dirty"，state stamp（`launchStates`）说 "running"/"interrupted"。
 * 实时那一帧读 stamp（只看那个小文件的 mtime），初帧读状态模型——同一个事实的两种
 * 拼写都在这里读成同一个 RunState，宿主里没有第二处翻译。
 *
 * 其余的词（"stale"、"missing"、"current"…）说的都是历史对不对得上，不是有没有人在
 * 跑，所以都读成 idle：把一条投影落后的会话画成 Running 会是在报告一件没发生的事。
 */
export function runStateOf(run: string): RunState {
  if (run === "running") return "running";
  if (run === "dirty" || run === "interrupted") return "interrupted";
  return "idle";
}

export type FieldRow = {
  label: string;
  kind: "badge" | "value" | "select" | "status";
  value: string;
  tone: BadgeTone;
  icon: string;
  /** Only for kind "select": the values the agent's own files currently carry. */
  options?: string[];
  href?: string;
};

export type AgentCard = {
  id: AgentId;
  label: string;
  /** Short form used by session chips and tabs ("Claude" for "Claude Code"). */
  short: string;
  ready: boolean;
  /** What the card's status pill says: "Ready", "CLI not installed", and so on. */
  statusText: string;
  /** Whether a launch of this agent is happening right now (core's answer, not a
   *  memory of the last click). */
  run: RunState;
  /** Explanatory paragraph for agents whose configuration Avenic does not own. */
  detail: string | null;
  fields: FieldRow[];
  sessions: { label: string; count: number; tone: BadgeTone };
  history: { label: string; tone: BadgeTone };
  configLink: { label: string; icon: string } | null;
  actions: { launch: boolean; change: boolean };
};

/**
 * 一条会话此刻的样子，除它说了什么之外的全部：投影跟不跟得上 canonical 历史
 * （core 的映射答案），以及参与它的 agent 里有没有正在跑的那一次（core 的启动组
 * 答案）。面板不记「上次点了启动」，因为那既不是现在，也可能是另一个终端里的事。
 */
export type SessionSync = {
  state: "current" | "stale" | "none";
  running: boolean;
};

export type SessionRow = {
  id: string;
  title: string;
  /** Agent ids participating in the session; rendered as small badges. */
  agents: AgentId[];
  updated: string;
  relative: string;
  active: boolean;
  sync: SessionSync;
};

export type SkillRow = {
  name: string;
  description: string;
  agents: AgentId[];
  enabled: boolean;
};

export type PackRow = { id: string; name: string; description: string; installed: boolean; count: number };

export type ActivityRow = { time: string; text: string; tone: BadgeTone };

/**
 * 一次工具往返，挂在发起它的那一轮下面。工具不是自己说话的人：它属于让它跑起来
 * 的那个 agent，所以它不是一轮话，而是那一轮的一行。
 */
export type TranscriptTool = { kind: "call" | "result"; name: string; detail: string };

/**
 * 一轮话。`speaker` 是 core 定下的称呼（"You"、"Claude"、"Codex"、"OpenCode"），
 * `role` 是存在盘上的那个词（"user"/"assistant"）——**界面上只准出现前者**：数据库
 * 的词是给程序看的，不是给读对话的人看的。
 */
export type TranscriptTurn = {
  id: string;
  kind: "user" | "agent" | "tool";
  speaker: string;
  agent: AgentId | null;
  role: string;
  at: string | null;
  text: string;
  tools: TranscriptTool[];
  model: string | null;
};

/**
 * 打开的那一条会话：core 的 transcriptSummary 的头部（谁在说、说了多少、投到哪个
 * 原生会话里去了）加上它的一段轮次。宿主只在用户点开一条会话时读它——列表那一帧
 * 一个字都不读事件日志。
 */
export type Transcript = {
  id: string;
  title: string;
  active: boolean;
  /** 参与者的显示名，按 core 的 agentLabel 排。 */
  participants: string[];
  updated: string | null;
  updatedRelative: string;
  /** 事件总数，不是页面上画出来的轮数：一条事件可能是一轮话，也可能是一行工具。 */
  eventCount: number;
  /** 投影与 canonical 历史的对账，用 core 的三态词（current/stale/none）。 */
  sync: { state: "current" | "stale" | "none"; label: string };
  turns: TranscriptTurn[];
  /** core 的 formatSessionDiagnostics 去重后的两行话：这条会话的投影说过什么。 */
  diagnostics: { warnings: string[]; notes: string[] };
};

export type DashboardData = {
  /** 面板底部那一行的版本：这台机器上真正在用的那份 Avenic CLI 的版本（产品版本
   *  是 CLI 的）。探不到时是空串——那时底部只写「Avenic」，不编一个版本号。 */
  version: string;
  /** 悬停在底部那一行上时展开的完整说法：CLI 与这个扩展各自的版本。扩展自己的
   *  版本不占底部那一行，但必须可查。 */
  versionDetails: { cli: string; extension: string };
  /**
   * True when this payload was built for a section that lists a working set
   * (Sessions, Skills), false for the Overview's "what happened recently" cut.
   * 数字不动，行数动：概览给最近 5 条并指向下一站，那一站必须自己给出完整的一列。
   */
  detail: boolean;
  /** `root` is null when no folder is open — the header then says so instead of a path. */
  project: { name: string; root: string | null; configured: boolean; lastUpdated: string | null };
  agents: AgentCard[];
  history: { mode: "shared" | "isolated"; sharedCount: number };
  shared: { rows: SessionRow[]; total: number };
  native: Record<AgentId, { rows: SessionRow[]; total: number }>;
  skills: { installed: SkillRow[]; installedTotal: number; packs: PackRow[]; packsTotal: number };
  /** `state` is core's three-way answer, kept three-way: a checkout that lags its
   *  remote is not "synced", and flattening the two into a boolean says it is. */
  hub: { spec: string | null; revision: string | null; state: "current" | "stale" | "missing" };
  activity: ActivityRow[];
  /** Loaded only after the user opens one session (never at first paint). */
  transcript: Transcript | null;
  /** Localised reason shown when the project is not initialised yet. */
  empty: string | null;
};

export type DashboardAction =
  | { action: "launch"; agent: AgentId }
  | { action: "change"; agent: AgentId }
  | { action: "openConfig"; agent: AgentId }
  | { action: "continueShared"; id: string }
  | { action: "continueNative"; agent: AgentId; id: string }
  | { action: "viewSession"; id: string }
  | { action: "setActive"; id: string }
  | { action: "importSkill" }
  | { action: "manageSkills" }
  /** 装某一个 pack（列表里那一行说的就是它），以及同步 registry：两者都是已有命令，
   *  面板只是不再把它们换成一个「你想装哪个」的选择器。 */
  | { action: "installPack"; pack: string }
  | { action: "syncHub" }
  | { action: "viewLogs" }
  | { action: "switchHistory" }
  | { action: "initialize" }
  /** 重新配置这个项目（标题栏那一问），以及「还没打开任何项目」时去开一个。 */
  | { action: "reconfigure" }
  | { action: "openProject" }
  /** 在文件管理器里打开项目根目录（路径后面那个箭头）。 */
  | { action: "revealProject" }
  | { action: "openFolder" }
  | { action: "openInTerminal" }
  /** The sidebar's Documentation and Settings: the extension's own README, and its settings page. */
  | { action: "openDocs" }
  | { action: "openSettings" };

/**
 * 宿主 → 面板的实时状态：一次启动的开始与结束不改载荷里的任何一段历史，只改状态那一行。
 * 整份载荷重发会让正在读的那一页跳一下，而这件事和那一页无关。
 */
export type StatusMessage = { type: "status"; runs: Record<AgentId, RunState> };

export type DashboardMessage =
  | { type: "ready" }
  | { type: "refresh" }
  /** `tab` 只有 Sessions 页有，而且只有它名下的那两个值；别的分区带 tab 是错的。 */
  | { type: "navigate"; section: DashboardSection; tab?: SessionsTab }
  | ({ type: "action" } & DashboardAction);

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function isAgentId(value: unknown): value is AgentId {
  return typeof value === "string" && (AGENT_IDS as readonly string[]).includes(value);
}

function hasId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

/** A message the host will act on, or null for anything it should ignore. */
export function isWebviewMessage(value: unknown): value is DashboardMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as { type?: unknown; section?: unknown; tab?: unknown; action?: unknown; agent?: unknown; id?: unknown; pack?: unknown };
  if (message.type === "ready" || message.type === "refresh") return true;
  if (message.type === "navigate") {
    if (typeof message.section !== "string" || !(SECTIONS as readonly string[]).includes(message.section)) return false;
    // 一个不在模式里的 tab 是坏消息，不是可以忽略的一笔：放它过去，宿主就会记下
    // 一个面板根本不认的落点，下一次推送把页面送到它打不开的那一半。
    if (message.tab === undefined) return true;
    return message.section === "sessions" && (SESSIONS_TABS as readonly string[]).includes(message.tab as string);
  }
  if (message.type !== "action" || typeof message.action !== "string") return false;
  switch (message.action) {
    case "launch":
    case "change":
    case "openConfig":
      return isAgentId(message.agent);
    case "continueNative":
      return isAgentId(message.agent) && hasId(message.id);
    case "installPack":
      return hasId(message.pack);
    case "continueShared":
    case "viewSession":
    case "setActive":
      return hasId(message.id);
    case "importSkill":
    case "manageSkills":
    case "syncHub":
    case "viewLogs":
    case "switchHistory":
    case "initialize":
    case "reconfigure":
    case "openProject":
    case "revealProject":
    case "openFolder":
    case "openInTerminal":
    case "openDocs":
    case "openSettings":
      return true;
    default:
      return false;
  }
}
