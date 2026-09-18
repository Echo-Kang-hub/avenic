import { API_TYPES, AUTH_FIELDS, CODEX_EFFORTS, MODEL_ROLES, TOGGLE_KEYS } from "@avenic/core";
import type { ApiType, ModelProfile } from "@avenic/core";

// 面板消息白名单（仿 dashboard/protocol.ts）：webview 永远不能指定路径或命令，
// 只能提交结构化的 profile 草稿与 id。apiKey === null 表示"不修改现有密钥"。
//
// 草稿是**白名单**：角色、开关、Agent 覆盖、认证字段都必须命中 @avenic/core 导出的清单，
// 面板多送一个键就会被拒——这样 webview 无法往 .claude/settings.local.json 里注入任意键。
export interface ModelRowDraft {
  id: string;
  display?: string;
  longContext?: boolean;
}

export interface EnvRowDraft {
  key: string;
  value: string;
}

// 面板只能改覆盖里的 baseUrl / api / providerId；覆盖对象的 apiKey / authField 永远由
// host 从库中带过（密钥不进 webview），所以草稿里没有这两个字段的位置。
export interface AgentOverrideDraft {
  baseUrl?: string;
  api?: ApiType;
  providerId?: string;
}

export interface CodexDraft {
  providerId: string;
  envKey: string;
  reasoningEffort: ModelProfile["codex"]["reasoningEffort"];
}

export interface OpencodeDraft {
  providerId: string;
  npmAdapter: string;
}

export interface ProfileDraft {
  id: string;
  name: string;
  baseUrl: string;
  api: ApiType;
  authField: string;
  // null = 保留库中现有密钥；"" = 明确清除；非空 = 替换。
  apiKey: string | null;
  models: Record<string, ModelRowDraft>;
  toggles: string[];
  env: EnvRowDraft[];
  overrides: Record<string, AgentOverrideDraft>;
  codex: CodexDraft;
  opencode: OpencodeDraft;
  // 粘贴导入的未识别键（§9.4：Claude settings 形态落到 claude.settings 透传区）。
  passthrough?: Record<string, unknown>;
}

export type ModelViewMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "saveProfile"; profile: ProfileDraft }
  | { type: "preview"; profile: ProfileDraft }
  | { type: "deleteProfile"; id: string }
  | { type: "duplicateProfile"; id: string }
  | { type: "bindProject"; id: string }
  | { type: "clearProject" }
  | { type: "testConnection"; id: string }
  | { type: "parseJson"; text: string }
  | { type: "parseText"; text: string }
  | { type: "openLibraryFile" }
  | { type: "openSettingsFile" };

/** 定位到具体输入的一条问题：field 用草稿里的点分路径（如 env.3.key、models.opus.id）。 */
export interface DraftIssue {
  field: string;
  message: string;
}

/** 投影预览的一条：path 是 .claude/settings.local.json 里的键路径，value 已掩码。 */
export interface ProjectionEntry {
  path: string[];
  value: unknown;
  secret?: boolean;
}

export interface DraftPreview {
  entries: ProjectionEntry[];
  // 掩码后的嵌套对象（.claude/settings.local.json 的形状）：面板只做 JSON.stringify。
  content: Record<string, unknown>;
  requestUrl: string | null;
  // 整份草稿层面的失败（如 core 的路径冲突），无法定位到单个输入时用这个。
  error: string | null;
  issues: DraftIssue[];
}

export interface ModelCardData {
  id: string;
  name: string;
  baseUrl: string;
  api: string;
  apiKeyMasked: string;
  hasStoredApiKey: boolean;
  mainModel: string;
  current: boolean;
  compatibility: { claude: { ok: boolean; reason?: string }; codex: { ok: boolean; reason?: string }; opencode: { ok: boolean; reason?: string } };
  // 编辑区需要回显的完整配置；密钥只以掩码出现（§7：明文永不进 webview）。
  profile: ProfileDraft;
}

/** 下拉/磁贴/开关行的展示清单：成员与顺序来自 core，中文标签只在扩展侧（§9.7）。 */
export interface PanelOptions {
  apis: string[];
  authFields: string[];
  roles: Array<{ id: string; label: string }>;
  toggles: Array<{ id: string; label: string; writes: string }>;
  presets: Array<{ id: string; label: string; baseUrl: string; api: string }>;
  // 只有这些角色会得到「1M 上下文」勾选框（设计 §9.3 限定 Opus / Sonnet）。
  longContextRoles: string[];
  // 只有这些角色的 display 会被 core 投影成 `ANTHROPIC_DEFAULT_<SUFFIX>_MODEL_NAME`（core 的
  // ROLE_KEYS）：显示名输入框只出现在这几行，避免给出一个存得下、却什么都不写的输入框。
  displayRoles: string[];
  agents: Array<{ id: string; label: string }>;
  codexEffort: string[];
  // 「+ 新建」表单的起点，默认值由 core 生成（见 state.ts）。
  newProfile: ProfileDraft;
}

export interface ModelPanelData {
  libraryPath: string;
  libraryExists: boolean;
  libraryBroken: string | null;
  projectRoot: string | null;
  cards: ModelCardData[];
  binding: { profileId: string; name: string } | null;
  projection: { file: string; keys: number; fingerprintMatches: boolean } | null;
  options: PanelOptions;
  notes: string[];
  message: string | null;
}

/**
 * 面板消息 → 命令 id 的转发表。面板宿主只照表执行，不自己判断消息该去哪。
 */
export const FORWARDED_COMMANDS: Readonly<Record<string, string>> = {
  saveProfile: "avenic.model.saveProfile",
  deleteProfile: "avenic.model.deleteProfile",
  duplicateProfile: "avenic.model.duplicateProfile",
  bindProject: "avenic.model.bindProject",
  clearProject: "avenic.model.clearProject",
  testConnection: "avenic.model.testConnection",
  preview: "avenic.model.preview",
};

/**
 * 转发里**会改库或改绑定**的那些：做完必须让面板自己重新取数。
 * extension 的 refresh() 只刷新三个树视图与 Overview，编辑器标签页不在其中——漏掉任何一个，
 * 用户点完保存/删除/复制/绑定看到的都还是旧界面。
 * `preview`（每次按键都跑、不写盘）与 `testConnection`（只读探测）故意不在表里。
 */
export const MUTATING_MESSAGES: ReadonlySet<string> = new Set([
  "saveProfile",
  "deleteProfile",
  "duplicateProfile",
  "bindProject",
  "clearProject",
]);

export type ModelSenderMessage =
  | { type: "data"; payload: ModelPanelData }
  | { type: "parsed"; payload: unknown }
  | { type: "projection"; payload: DraftPreview }
  | { type: "testResult"; payload: unknown }
  | { type: "error"; message: string };

const MAX_TEXT = 20_000;
const MAX_ROWS = 100;
const MAX_OVERRIDE_AGENTS = ["codex", "opencode"];

function isText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

/** 允许空串的短文本（apiKey 要能表达"清除"）。 */
function isEmptyableText(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length <= max;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 来自 webview 的永远是 string，清单本身是窄类型 —— 按 string 比对（§5：可选项以 core schema 为准）。
function isApiType(value: unknown): value is ApiType {
  return typeof value === "string" && (API_TYPES as readonly string[]).includes(value);
}

function isModelRow(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  // id 允许空串：把某个角色的输入框清空 = 删除该角色映射（core 的 normalizeModelRow
  // 拿到空 id 会响亮失败，所以空行由 host 在归一化前剔除）。
  if (!isEmptyableText(value.id, 128)) return false;
  if (value.display !== undefined && !isEmptyableText(value.display, 200)) return false;
  if (value.longContext !== undefined && typeof value.longContext !== "boolean") return false;
  return true;
}

function isEnvRow(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  return isEmptyableText(value.key, 128) && typeof value.value === "string" && value.value.length <= 2000;
}

function isOverride(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  if (value.baseUrl !== undefined && !isEmptyableText(value.baseUrl, 2000)) return false;
  if (value.api !== undefined && !isApiType(value.api)) return false;
  if (value.providerId !== undefined && !isEmptyableText(value.providerId, 32)) return false;
  return true;
}

function isDraft(value: unknown): value is ProfileDraft {
  if (!isPlainObject(value)) return false;
  if (!isText(value.id, 32)) return false;
  // name / baseUrl 允许空串：草稿是**编辑中的**表单，新建时它们本来就是空的。
  // 空值不算"非法消息"，而是由 draftIssues 报成可定位的问题（保存会被面板拦下）。
  if (!isEmptyableText(value.name, 200)) return false;
  if (!isEmptyableText(value.baseUrl, 2000)) return false;
  // api 必须是 core 认得的三种之一：未知取值会被 normalizeEndpoint 判失败（§5）。
  if (!isApiType(value.api)) return false;
  // 认证字段必须是 core schema 认得的那几个（§5：具体可选项以当前 core schema 为准）。
  if (typeof value.authField !== "string" || !AUTH_FIELDS.includes(value.authField)) return false;
  // null = 不修改；"" = 清除；其余为替换值。
  if (value.apiKey !== null && !isEmptyableText(value.apiKey, 1000)) return false;

  if (!isPlainObject(value.models)) return false;
  for (const [role, row] of Object.entries(value.models)) {
    // 角色白名单：core 不识别的角色直接拒绝，避免落进库里的未知键。
    // 这里校验的是来自 webview 的字符串，所以按 string 比对（清单本身是窄类型的）。
    if (!(MODEL_ROLES as readonly string[]).includes(role)) return false;
    if (!isModelRow(row)) return false;
  }

  if (!Array.isArray(value.toggles)) return false;
  if (value.toggles.length > TOGGLE_KEYS.length) return false;
  for (const id of value.toggles) {
    if (typeof id !== "string" || !(TOGGLE_KEYS as readonly string[]).includes(id)) return false;
  }

  if (!Array.isArray(value.env) || value.env.length > MAX_ROWS) return false;
  if (!value.env.every(isEnvRow)) return false;

  if (!isPlainObject(value.overrides)) return false;
  for (const [agentId, override] of Object.entries(value.overrides)) {
    if (!MAX_OVERRIDE_AGENTS.includes(agentId)) return false;
    if (!isOverride(override)) return false;
  }

  if (!isPlainObject(value.codex)) return false;
  if (!isEmptyableText(value.codex.providerId, 32) || !isEmptyableText(value.codex.envKey, 64)) return false;
  if (typeof value.codex.reasoningEffort !== "string" || !CODEX_EFFORTS.includes(value.codex.reasoningEffort)) return false;

  if (!isPlainObject(value.opencode)) return false;
  if (!isEmptyableText(value.opencode.providerId, 32) || !isEmptyableText(value.opencode.npmAdapter, 200)) return false;

  if (value.passthrough !== undefined) {
    if (!isPlainObject(value.passthrough)) return false;
    // 透传区直接落进 Claude settings 顶层：限制体积，且必须能安全序列化。
    try {
      if (JSON.stringify(value.passthrough).length > MAX_TEXT) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export function isModelViewMessage(value: unknown): value is ModelViewMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  switch (message.type) {
    case "ready":
    case "refresh":
    case "clearProject":
    case "openLibraryFile":
    case "openSettingsFile":
      return true;
    case "deleteProfile":
    case "duplicateProfile":
    case "bindProject":
    case "testConnection":
      return isText(message.id, 32);
    case "parseJson":
    case "parseText":
      return typeof message.text === "string" && message.text.length <= MAX_TEXT;
    case "saveProfile":
    case "preview":
      return isDraft(message.profile);
    default:
      return false;
  }
}
