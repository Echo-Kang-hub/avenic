// The dashboard's whole contract with the webview: one data payload, one
// validated message channel. Everything the webview shows arrives here, so the
// renderer never reads the disk and never trusts a string it receives — unknown
// sections and actions are dropped rather than forwarded.

export const AGENT_IDS = ["claude", "codex", "opencode"] as const;
export type AgentId = (typeof AGENT_IDS)[number];

export const SECTIONS = ["overview", "configure", "agents", "sessions", "skills", "quick", "center", "hooks", "settings"] as const;
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

/** A provider the Center can fill in, as the agent's own file would name it. */
export type CenterProvider = {
  id: string;
  name: string;
  /** The vendor page this preset was read from; the Center links to it. */
  docs: string;
  /** The preset's own endpoint, or null for a proxy the user runs — then the URL is theirs to type. */
  baseUrl: string | null;
  selected: boolean;
};

/**
 * One model role the agent's file can map. `recommended` is what the vendor's own
 * guide says (null where the vendor published none — an invented mapping would
 * send a request to a model the account may not have), `current` is what the file
 * on disk says right now.
 */
export type CenterRole = { id: string; recommended: string | null; current: string | null };

/** One optional block of the agent's own configuration, and whether the file carries it. */
export type CenterBlock = { id: string; name: string; on: boolean };

/**
 * The Model Configuration Center's whole state for one agent.
 *
 * It is read off the agent's own file — the same file core merges into — so this
 * page and `avenic change` are two views of one fact rather than two stores. The
 * credential is never here: `credentialSet` is all a screen may know, because a
 * panel that could echo a key is a panel that could leak one.
 */
export type CenterState = {
  agent: AgentId;
  label: string;
  /** Which of the agent's own ways of authenticating this project uses. */
  auth: "account" | "api" | "none";
  scope: "global" | "project" | null;
  /** The agent's own file Avenic would merge into, relative to the project (or a `~` path). */
  relative: string | null;
  /** The presets this agent's native format can be filled from, in the table's order. */
  providers: CenterProvider[];
  provider: string | null;
  baseUrl: string;
  model: string;
  credentialSet: boolean;
  roles: CenterRole[];
  blocks: CenterBlock[];
  /** The models the Center can offer without asking anyone: the cached list plus the curated ones. */
  models: string[];
  /** When the list was last fetched, and what a refresh said the last time — never a key. */
  catalog: { at: string | null; note: string | null };
};

/** The form the page holds while it is being filled in, sent back on every question. */
export type CenterDraft = {
  provider: string;
  baseUrl: string;
  model: string;
  /**
   * `null` means "leave the credential that is already in the file exactly where
   * it is" — the omission core's template understands. An empty string is a
   * refusal, not a deletion, so the two are different values here too.
   */
  credential: string | null;
  roles: Record<string, string>;
  blocks: string[];
};

/** What the last thing the user asked the Center to do answered; the page shows it verbatim. */
export type CenterResult =
  | { kind: "connection"; state: "connected" | "authentication-failed" | "model-unavailable" | "network-error" | "timeout" | "unreadable" | "http-error"; status: number | null }
  | { kind: "catalog"; state: "fetched" | "failed"; count: number | null; note: string | null }
  | { kind: "diff"; lines: { kind: "same" | "add" | "remove"; text: string }[]; written: boolean }
  | { kind: "error"; message: string };

/**
 * 钩子与通知那一页的两个半页：装的是 agent 自己的机制，响的是 Avenic 自己的通知名单。
 * 这一档作用域是「这份名单写在项目里还是写在这台机器上」，与认证的作用域（P62）不是
 * 同一个问题——换它不碰任何一份认证配置，所以它是自己的一条轴。
 */
export const HOOK_SCOPES = ["project", "global"] as const;
export type HookScope = (typeof HOOK_SCOPES)[number];

/** 一个 agent 的那一行：它的机制、这个作用域里装没装、以及它有什么条件。 */
export type HookAgentRow = {
  agent: AgentId;
  displayName: string;
  /** Avenic 给这个机制的说法（settings-hooks / config-hooks / plugin）。 */
  mechanism: string;
  /** 这台机器上装的那个版本（唯一的探测器读出来的），读不到就是 null。 */
  version: string | null;
  supported: boolean;
  /** 「不支持」那一句（按编辑器语言说）；支持时是 null。 */
  supportNote: string | null;
  file: string;
  /** 文件读得动才谈得上有答案：读不动时是 null，为什么写在 error 里。 */
  installed: boolean | null;
  /** 文件读不出来时 core 给的那句话（含文件与 errno）；读得出来时是 null。 */
  error: string | null;
  /** 机制自己带的一个条件（Codex 的钩子要用户审阅过才会响）；空串就是没有。 */
  caveat: string;
};

/** 一条通知，按页面能看的样子：没有令牌本身，命令类只有程序名。 */
export type HookActionRow = {
  id: string;
  /** core 的四种之一；这一页只画它被交到手里的那些。 */
  kind: string;
  /** 一行认得出它的字样：地址、网关+路径，或者单独一个程序名。 */
  target: string;
  tokenSet: boolean;
  tokenEnv: string | null;
  timeoutMs: number | null;
};

export type HooksState = {
  scope: HookScope;
  agents: HookAgentRow[];
  actions: HookActionRow[];
  /** 这一档的名单写在哪个文件里。 */
  actionsFile: string;
  /** core 的四种通知，按 core 的顺序。 */
  kinds: string[];
  /** core 的门槛与去重窗口：页面从不自己记 20 这个数。 */
  completedMinSeconds: number;
  dedupeSeconds: number;
};

export type DiffLine = { kind: "same" | "add" | "remove"; text: string };

/** 钩子页上一次问题回答了什么（预览、装、卸、写名单）。预览写不了任何东西，所以它没有
 *  「written」这一栏；问不成的那几次由宿主当面说话（showError），不混进这张结果里。 */
export type HooksResult =
  | { kind: "diff"; agent: AgentId; file: string; lines: DiffLine[] }
  /** note：core 拒绝写的那一句话（版本在这一行画出来之后变了）；没有就是 null。 */
  | { kind: "installed"; agent: AgentId; file: string; changed: boolean; note: string | null }
  | { kind: "uninstalled"; agent: AgentId; file: string; changed: boolean }
  | { kind: "actions"; file: string; changed: boolean };

/** 设置与关于那一页的一行：左边是词，右边是那个事实。 */
export type AboutRow = {
  key: string;
  label: string;
  value: string;
  /** 宿主解析得出这一行指的路径、而且它在盘上，才为 true。 */
  reveal: boolean;
};

/** 设置与关于那一页：这套安装是什么，这个项目的文件在哪里。 */
export type AboutState = {
  rows: AboutRow[];
  /** 那一行离开页面去 VS Code 自己的设置；查询字符串（@ext:…）留在宿主里。 */
  settings: { label: string };
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
  /** Built only when the Center is the section being shown; null everywhere else. */
  center: CenterState | null;
  /** What the Center's last question answered, or null when nothing was asked yet. */
  centerResult: CenterResult | null;
  /** Hooks & Notifications: built only while that section is the one on screen, and
   *  only for the scope it is showing — the other scope's list is not read here. */
  hooks: HooksState | null;
  /** What the Hooks page's last question answered (preview, install, uninstall, a
   *  written list), or why it did not happen. Null everywhere else. */
  hooksResult: HooksResult | null;
  /** Settings & About: what this install is and where this project's files are.
   *  Built only while that section is on screen. */
  about: AboutState | null;
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
  | { action: "openSettings" }
  /** The Model Configuration Center. Every question it asks carries the whole form
   *  back: the page owns what was typed, the host only ever merges it. */
  | { action: "centerOpen"; agent: AgentId }
  | { action: "centerFill"; agent: AgentId; provider: string }
  | { action: "centerPreview"; agent: AgentId; draft: CenterDraft }
  | { action: "centerApply"; agent: AgentId; draft: CenterDraft }
  | { action: "centerTest"; agent: AgentId; draft: CenterDraft }
  | { action: "centerRefreshModels"; agent: AgentId; draft: CenterDraft }
  | { action: "centerOpenFile"; agent: AgentId }
  /** The vendor page a preset was read from: the page carries the provider's name,
   *  the host carries the URL — a link the webview holds is a link the webview
   *  could be tricked into holding. */
  | { action: "centerOpenDocs"; agent: AgentId; provider: string }
  /** 钩子与通知那一页：先落到这一页（这一档作用域是谁的名单），然后每一行做它自己那件事。
   *  装与卸把作用域一起带回来 —— 页面正看着哪一档，写的就是哪一档。 */
  | { action: "hooksOpen"; scope: HookScope }
  | { action: "hookPlan"; agent: AgentId; scope: HookScope }
  | { action: "hookInstall"; agent: AgentId; scope: HookScope }
  | { action: "hookUninstall"; agent: AgentId; scope: HookScope }
  /** 四种通知各有一份编辑器：加一条先问是哪一种，改一条问的是那一条。 */
  | { action: "hookActionAdd"; scope: HookScope; kind: string }
  | { action: "hookActionEdit"; scope: HookScope; id: string }
  | { action: "hookActionRemove"; scope: HookScope; id: string }
  /** 设置页那一行「显示」：页面递来的是一个键，路径由宿主自己解析。 */
  | { action: "revealFile"; key: string };

/**
 * 宿主 → 面板的实时状态：一次启动的开始与结束不改载荷里的任何一段历史，只改状态那一行。
 * 整份载荷重发会让正在读的那一页跳一下，而这件事和那一页无关。
 */
export type StatusMessage = { type: "status"; runs: Record<AgentId, RunState> };

/**
 * Host → page. The answer to `centerFill` is a *form*, not state: the preset's
 * values become what the user is holding, and the page is the thing holding it —
 * so it travels as its own message rather than being carried in the payload and
 * fighting the user's typing on every repaint.
 */
export type CenterDraftMessage = { type: "draft"; draft: CenterDraft };

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

function isHookScope(value: unknown): value is HookScope {
  return typeof value === "string" && (HOOK_SCOPES as readonly string[]).includes(value);
}

/**
 * A notification's own id: unlike the ids above this one is a user's, so it is not
 * held to the shape of a session id — it only has to be a single line short enough
 * to be a row, and the host still refuses ids the file cannot hold.
 */
function hasLine(value: unknown): value is string {
  return typeof value === "string" && value !== "" && value.length <= 200 && !/[\r\n]/.test(value);
}

/** The keys the Settings page may name: a key is a key, never a path. */
const KEY_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * The form as the host is willing to receive it: every string a single line (a
 * value with a newline in it is a header being injected into someone's file, not
 * a model name), the provider one of the ids the page was handed, and the
 * credential the only field allowed to be long — and never echoed back.
 */
function isCenterDraft(value: unknown, requireModel: boolean): value is CenterDraft {
  if (typeof value !== "object" || value === null) return false;
  const draft = value as { provider?: unknown; baseUrl?: unknown; model?: unknown; credential?: unknown; roles?: unknown; blocks?: unknown };
  const single = (field: unknown) => typeof field === "string" && field.length <= 512 && !/[\r\n]/.test(field);
  if (!single(draft.provider) || draft.provider === "" || !single(draft.baseUrl) || draft.baseUrl === "") return false;
  if (requireModel && (!single(draft.model) || draft.model === "")) return false;
  if (!requireModel && !single(draft.model)) return false;
  if (draft.credential !== null && !(typeof draft.credential === "string" && draft.credential.length <= 4096 && !/[\r\n]/.test(draft.credential))) return false;
  if (typeof draft.roles !== "object" || draft.roles === null || Array.isArray(draft.roles)) return false;
  if (!Object.values(draft.roles).every(single)) return false;
  return Array.isArray(draft.blocks) && draft.blocks.every((id) => hasId(id));
}

/** A message the host will act on, or null for anything it should ignore. */
export function isWebviewMessage(value: unknown): value is DashboardMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as { type?: unknown; section?: unknown; tab?: unknown; action?: unknown; agent?: unknown; id?: unknown; pack?: unknown; provider?: unknown; draft?: unknown; scope?: unknown; kind?: unknown; key?: unknown };
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
    case "centerOpen":
    case "centerOpenFile":
      return isAgentId(message.agent);
    case "centerFill":
    case "centerOpenDocs":
      return isAgentId(message.agent) && typeof message.provider === "string" && hasId(message.provider);
    case "centerPreview":
    case "centerApply":
    case "centerTest":
      return isAgentId(message.agent) && isCenterDraft(message.draft, true);
    case "centerRefreshModels":
      // 问模型目录要的是地址与钥匙，不是模型名：「刷一下有哪些模型」正是还不知道模型名叫
      // 什么的时候要做的事，把它按模型名挡住就挡住了这个按钮唯一的用处。
      return isAgentId(message.agent) && isCenterDraft(message.draft, false);
    case "hooksOpen":
      return isHookScope(message.scope);
    case "hookPlan":
    case "hookInstall":
    case "hookUninstall":
      return isAgentId(message.agent) && isHookScope(message.scope);
    case "hookActionAdd":
      // 「哪一种通知」由宿主对着 core 的那四种判定（draftAction 会拒），这里只保证它是
      // 一行短字样，别让一个换行符或一整篇文章走进来。
      return isHookScope(message.scope) && typeof message.kind === "string" && message.kind !== "" && message.kind.length <= 32 && !/[\r\n]/.test(message.kind);
    case "hookActionEdit":
    case "hookActionRemove":
      return isHookScope(message.scope) && hasLine(message.id);
    case "revealFile":
      return typeof message.key === "string" && KEY_PATTERN.test(message.key);
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
