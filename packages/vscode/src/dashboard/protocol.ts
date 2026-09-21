// The dashboard's whole contract with the webview: one data payload, one
// validated message channel. Everything the webview shows arrives here, so the
// renderer never reads the disk and never trusts a string it receives — unknown
// sections and actions are dropped rather than forwarded.

export const AGENT_IDS = ["claude", "codex", "opencode"] as const;
export type AgentId = (typeof AGENT_IDS)[number];

export const SECTIONS = ["overview", "configure", "agents", "sessions", "skills", "quick"] as const;
export type DashboardSection = (typeof SECTIONS)[number];

export type BadgeTone = "brand" | "blue" | "purple" | "green" | "muted";

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
  /** Explanatory paragraph for agents whose configuration Avenic does not own. */
  detail: string | null;
  fields: FieldRow[];
  sessions: { label: string; count: number; tone: BadgeTone };
  history: { label: string; tone: BadgeTone };
  configLink: { label: string; icon: string } | null;
  actions: { launch: boolean; change: boolean };
};

export type SessionRow = {
  id: string;
  title: string;
  /** Agent ids participating in the session; rendered as small badges. */
  agents: AgentId[];
  updated: string;
  relative: string;
  active: boolean;
};

export type SkillRow = {
  name: string;
  description: string;
  agents: AgentId[];
  enabled: boolean;
};

export type PackRow = { id: string; name: string; description: string; installed: boolean; count: number };

export type ActivityRow = { time: string; text: string; tone: BadgeTone };

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
  transcript: { id: string; title: string; active: boolean; turns: { role: string; text: string }[] } | null;
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

export type DashboardMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "navigate"; section: DashboardSection }
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
  const message = value as { type?: unknown; section?: unknown; action?: unknown; agent?: unknown; id?: unknown; pack?: unknown };
  if (message.type === "ready" || message.type === "refresh") return true;
  if (message.type === "navigate") {
    return typeof message.section === "string" && (SECTIONS as readonly string[]).includes(message.section);
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
