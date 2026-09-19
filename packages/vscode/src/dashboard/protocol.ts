// 与 commands/* 注册的命令一一对应（均已在 T7–T9 与模型面板注册）——webview 只能转发白名单
// 命令，不可直达任意命令或 shell 能力。类型与运行时清单是**同一份**：`as const` 让下面
// WebviewMessage 的联合类型由这个数组推导，新增命令改一处即可。
export const ALLOWED_COMMANDS = [
  "catalog.sync",
  "skills.installPacks",
  "skills.addDirect",
  "agents.init",
  "agents.sessionsImport",
  // 模型配置面板（§9.1 的第三个入口）。不需要项目上下文：库是设备级的。
  "model.open",
] as const;

export type DashboardCommand = (typeof ALLOWED_COMMANDS)[number];

export type WebviewMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "command"; command: DashboardCommand };

export type SenderMessage =
  | { type: "data"; payload: DashboardData }
  | { type: "error"; message: string };

export interface DashboardData {
  projectRoot: string | null;
  // 共享历史（core 状态模型的 history 块）：未打开项目时为 null。
  history: { mode: string; sessions: number; activeTitle: string | null } | null;
  // sync 用 core 的六个词（none / current / stale / missing / running / dirty），
  // 与 `avenic status` 的 Sync 一列同义 —— 面板不另造一套措辞。
  agents: Array<{ id: string; label: string; statusText: string; executableAvailable: boolean; iconHint: string; sync: string }>;
  catalog: { spec: string; revision: string } | null;
  skillsHealth: Array<{ label: string; ok: boolean; details: string }>;
}

export function isWebviewMessage(value: unknown): value is WebviewMessage {
  if (typeof value !== "object" || value === null) return false;
  const msg = value as Record<string, unknown>;
  if (msg.type === "ready" || msg.type === "refresh") return true;
  // 来自 webview 的永远是 string，清单是窄类型 —— 按 string 比对（同 src/model/protocol.ts）。
  if (msg.type === "command") return typeof msg.command === "string" && (ALLOWED_COMMANDS as readonly string[]).includes(msg.command);
  return false;
}
