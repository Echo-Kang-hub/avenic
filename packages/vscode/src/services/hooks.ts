import {
  HOOK_ACTION_KINDS,
  HOOK_POLICY,
  configurationDiff,
  hookActionsPath,
  hookCapability,
  hookPlan,
  hookStatus,
  hookSupport,
  installHooks,
  readHookActionsAt,
  uninstallHooks,
  writeHookActions,
  type AgentInstallation,
  type HookAction,
  type HookPlan,
} from "@avenic/core";
import { AGENT_IDS, type AgentId, type DiffLine } from "../dashboard/protocol.ts";
import { LocalizedError, sentence } from "../i18n/text.ts";
import { detectInstallation } from "./agents.ts";

// 钩子与通知的数据与动作（无 vscode import，所以整套判断不需要编辑器就能测）。
//
// 这一页问的是两个不同的问题，宿主必须分开回答：
//   装没装 —— agent 自己的机制（三种文件、三种写法），由 core 的 hookPlan/hookStatus 读；
//   响了之后做什么 —— Avenic 自己的通知名单（一个文件，四个种类），由 core 的
//   hook-actions 读写成整份。前者的作用域是 P62 的那个作用域（与认证无关），后者的
//   作用域也只是「这份名单写在项目里还是写在你的用户目录里」。
//
// 两条不许破的规矩：
//   1. 钩子令牌只出不进这条不适用——它是用户填进去的，所以它只进不出：状态里只有
//      tokenSet 一个布尔与变量名，令牌本身既不进页面的载荷，也不进日志；行里的
//      command 只报程序名，不报参数（参数里可能有用户自己的凭据）。
//   2. 装与卸都把文件交给 core：本页不拼任何一行配置，也不自己判断「装了没」。

export type HookScope = "project" | "global";
export type HookActionKind = (typeof HOOK_ACTION_KINDS)[number];

export interface HookOptions {
  environment?: Record<string, string | undefined>;
  /** 编辑器自己的语言：这一层要说的话（不支持的那一句）按它说哪一半。 */
  language?: string;
  /**
   * 扩展只有这一个探测器（services/agents 的 detectInstallation，它会真的去问
   * 那个 CLI 的版本）。测试注入一个假的，好让这一页的测试不去跑任何 CLI。
   */
  detect?: (agentId: AgentId) => Promise<AgentInstallation>;
}

const languageOf = (options: HookOptions): string => options.language ?? "en";
const detectorOf = (options: HookOptions) => options.detect ?? detectInstallation;

/** One agent's row: whether its own mechanism is installed, and whether it can be. */
export interface HookAgentFacts {
  agent: AgentId;
  displayName: string;
  /** Avenic's word for the mechanism (settings-hooks / config-hooks / plugin). */
  mechanism: string;
  /** The CLI version detectInstallation read off this machine, for support and display. */
  version: string | null;
  supported: boolean;
  /** The sentence that says why not, when `supported` is false. */
  supportNote: string | null;
  /** The file the mechanism lives in, for this scope. */
  file: string;
  /** 文件读得动才谈得上有答案：读不动时是 null，为什么写在 error 里。 */
  installed: boolean | null;
  /** 这个 agent 的文件读不出来时 core 给的那句话；读得出来时是 null。 */
  error: string | null;
  /** A condition no screen can see from here (Codex's trust review); "" when there is none. */
  caveat: string;
}

/** One notification, as the page may see it. Never the token, never a command's arguments. */
export interface HookActionFacts {
  id: string;
  kind: HookActionKind;
  /** One identifying line: the URL, gateway+path, or the program alone. */
  target: string;
  tokenSet: boolean;
  tokenEnv: string | null;
  timeoutMs: number | null;
}

export interface HooksFacts {
  scope: HookScope;
  agents: HookAgentFacts[];
  actions: HookActionFacts[];
  /** Where this scope's notification list lives (the rows above come from it). */
  actionsFile: string;
  /** The four kinds in core's order; the page offers them in this order. */
  kinds: HookActionKind[];
  /** core's thresholds, never spelled again here: the floor for a completed turn, and the dedupe window. */
  completedMinSeconds: number;
  dedupeSeconds: number;
}

// 供应商自己那一套的默认值。core 里它们是私有常量（hook-actions.mjs 的 OPENCLAW_GATEWAY /
// OPENCLAW_PATH / DEFAULT_TIMEOUT_MS），扩展这一侧要一个可预填的值，所以这几行是它们的镜像：
// 值必须一致，改了 core 的那一份就要改这一份（报告里请 core 导出更省事）。
export const OPENCLAW_DEFAULTS = { gateway: "http://127.0.0.1:18789", path: "/hooks/avenic" } as const;
export const HOOK_TIMEOUT_MS = { default: 2000, min: 100, max: 30_000 } as const;

/** 用户敲的命令行里，行上只报程序名：参数是他自己的东西，可能有凭据。 */
function programOf(command: string): string {
  const trimmed = command.trim();
  const first = trimmed.split(/\s+/)[0] ?? "";
  return trimmed === first ? first : `${first} …`;
}

/* ------------------------------------------------------- 预览那份 diff -- */
//
// 与模型配置中心同一套做法，而且是同一份实现：改动逐行说清楚，每一行都先由 core 的
// configurationDiff 打码 —— 预览是用户批准改动时读的东西，它不能自己变成那份文件本来
// 要靠权限防住的泄漏点。这一页不自己再写一遍掩码规则：两条规则分头长，迟早会有一条漏掉
// 一个凭据，而漏掉的那一条没人会知道。

/** 「View Generated Config」：这一份计划要写下去的字节，去掉没变的行，全部已打码。 */
export async function hookPlanDiff(projectRoot: string, agentId: AgentId, scope: HookScope, options: HookOptions = {}): Promise<{ agent: AgentId; file: string; lines: DiffLine[] }> {
  const plan = await hookPlanFor(projectRoot, agentId, scope, options);
  return { agent: agentId, file: plan.file, lines: configurationDiff(plan.before, plan.contents).filter((line) => line.kind !== "same") };
}


function targetOf(action: HookAction): string {
  if (action.kind === "openclaw") return `${action.gateway ?? OPENCLAW_DEFAULTS.gateway}${action.path ?? OPENCLAW_DEFAULTS.path}`;
  if (action.kind === "webhook") return action.url ?? "";
  if (action.kind === "command") return programOf(action.command ?? "");
  return "";
}

export function actionFacts(action: HookAction): HookActionFacts {
  return {
    id: action.id,
    kind: action.kind,
    target: targetOf(action),
    tokenSet: typeof action.token === "string" && action.token !== "",
    tokenEnv: action.tokenEnv ?? null,
    timeoutMs: typeof action.timeoutMs === "number" ? action.timeoutMs : null,
  };
}

/** 「不支持」那一句：core 给的是英文（它没有语言），这里按词表说编辑器自己的那一半。 */
function supportSentence(agent: string, version: string | null, support: { supported: boolean; note: string | null }, language: string): string | null {
  if (support.supported) return null;
  return version === null || version.trim() === ""
    ? sentence(language, "hooks.unsupported-unknown", { agent })
    : sentence(language, "hooks.unsupported-version", { agent, version });
}

/**
 * One agent's row for one scope. Read-only: `hookStatus` never builds a write
 * plan, so drawing this page costs two small reads per agent and no writes. The
 * version comes from the one detector the extension has (services/agents), not
 * from a second one written here.
 */
export async function agentHooks(projectRoot: string, agentId: AgentId, scope: HookScope, options: HookOptions = {}): Promise<HookAgentFacts> {
  const capability = hookCapability(agentId);
  if (capability === null) throw new LocalizedError("hooks.unsupported-agent", { agent: agentId });
  const installation = await detectorOf(options)(agentId);
  const status = await hookStatus(agentId, { scope, projectRoot, environment: options.environment, version: installation.version });
  const support = hookSupport(agentId, installation.version);
  return {
    agent: agentId,
    displayName: capability.displayName,
    mechanism: capability.mechanism,
    version: installation.version,
    supported: status.supported,
    supportNote: supportSentence(capability.displayName, installation.version, support ?? { supported: status.supported, note: status.note }, languageOf(options)),
    file: status.file,
    installed: status.installed,
    error: status.error ?? null,
    caveat: status.caveat,
  };
}

/** The whole page's facts for one scope: three rows and the notification list beside them. */
export async function hooksFacts(projectRoot: string, scope: HookScope, options: HookOptions = {}): Promise<HooksFacts> {
  const agents = await Promise.all(AGENT_IDS.map((agentId) => agentHooks(projectRoot, agentId, scope, options)));
  return {
    scope,
    agents,
    actions: hookActionList(projectRoot, scope, options).map(actionFacts),
    actionsFile: hookActionsPath(projectRoot),
    kinds: [...HOOK_ACTION_KINDS],
    completedMinSeconds: HOOK_POLICY.completedMinSeconds,
    dedupeSeconds: HOOK_POLICY.dedupeSeconds,
  };
}

/** The read-only plan behind "View Generated Config": the bytes an install would write. */
export async function hookPlanFor(projectRoot: string, agentId: AgentId, scope: HookScope, options: HookOptions = {}): Promise<HookPlan> {
  // 计划里的 supported 与 note 取决于装的是哪个版本，所以它也要那个探测器：一个版本读不到
  // 的 CLI，计划就不该说它支持。
  const installation = await detectorOf(options)(agentId);
  return hookPlan(agentId, { scope, projectRoot, environment: options.environment, version: installation.version });
}

/** Install and uninstall get their plan re-read from disk at the moment of the write (core's own rule). */
export async function installAgentHooks(projectRoot: string, agentId: AgentId, scope: HookScope, options: HookOptions = {}): Promise<{ changed: boolean; file: string; skipped?: string | null }> {
  return installHooks(await hookPlanFor(projectRoot, agentId, scope, options));
}

export async function uninstallAgentHooks(projectRoot: string, agentId: AgentId, scope: HookScope, options: HookOptions = {}): Promise<{ changed: boolean; file: string }> {
  return uninstallHooks(await hookPlanFor(projectRoot, agentId, scope, options));
}

/** This scope's list as the wizards hold it (tokens and all — the page never sees this). */
export function hookActionList(projectRoot: string, scope: HookScope, options: HookOptions = {}): HookAction[] {
  return readHookActionsAt(projectRoot, scope, options.environment);
}

/** The whole list, written by the one writer core has. */
export function saveHookActions(projectRoot: string, scope: HookScope, actions: HookAction[], options: HookOptions = {}): Promise<{ changed: boolean; file: string }> {
  return writeHookActions(projectRoot, scope, actions, { environment: options.environment });
}

/**
 * 地址那一行必须是 http(s)。它是公开的：向导在用户答完地址那一刻就要这个判断，好过
 * 让他把剩下的问题答完再被告知地址不对 —— 但规则只有这一份。
 */
export function httpUrl(value: string, key: "hooks.bad-url" | "hooks.bad-gateway" = "hooks.bad-url"): string {
  const trimmed = value.trim();
  if (!/^https?:\/\/[^\s]+$/.test(trimmed)) throw new LocalizedError(key, { value: trimmed });
  return trimmed;
}

function bothOrNeitherToken(token: string | null, tokenEnv: string | null): Pick<HookAction, "token" | "tokenEnv"> {
  if (token !== null && token !== "" && tokenEnv !== null && tokenEnv !== "") throw new LocalizedError("hooks.token-both");
  if (token !== null && token !== "") return { token };
  if (tokenEnv !== null && tokenEnv !== "") return { tokenEnv };
  return {};
}

export interface ActionDraft {
  id?: string;
  url?: string;
  gateway?: string;
  path?: string;
  token?: string | null;
  tokenEnv?: string | null;
  timeoutMs?: number | null;
  command?: string;
}

/**
 * The form's answers as the file's shape: one place where a kind's fields are
 * checked and trimmed, so the wizards carry no rules of their own and a bad
 * answer is refused before anything is written.
 *
 * `command` needs `advanced: true`, and that flag is the only door: a command
 * notification runs a program on this machine, so the sentence that says so has
 * to have been read, and the confirmation answered, before one can be written.
 * The wizard is the only caller that can hand the flag over — it asks both.
 */
export function draftAction(kind: HookActionKind, draft: ActionDraft, existing: ReadonlyArray<HookAction> = [], options: { advanced?: boolean } = {}): HookAction {
  if (!(HOOK_ACTION_KINDS as readonly string[]).includes(kind)) throw new LocalizedError("hooks.unknown-kind", { kind });
  if (kind === "command" && options.advanced !== true) throw new LocalizedError("hooks.need-advanced");
  const id = draft.id !== undefined && draft.id.trim() !== "" ? draft.id.trim() : nextActionId(kind, existing);
  const timeout = draft.timeoutMs === undefined || draft.timeoutMs === null ? null : Math.min(HOOK_TIMEOUT_MS.max, Math.max(HOOK_TIMEOUT_MS.min, Math.round(draft.timeoutMs)));
  if (kind === "desktop") return { id, kind };
  if (kind === "webhook") {
    const url = draft.url === undefined || draft.url.trim() === "" ? null : httpUrl(draft.url, "hooks.bad-url");
    if (url === null) throw new LocalizedError("hooks.need-url");
    return { id, kind, url, ...bothOrNeitherToken(draft.token ?? null, draft.tokenEnv ?? null), ...(timeout === null ? {} : { timeoutMs: timeout }) };
  }
  if (kind === "openclaw") {
    const gateway = draft.gateway === undefined || draft.gateway.trim() === "" ? OPENCLAW_DEFAULTS.gateway : httpUrl(draft.gateway, "hooks.bad-gateway");
    const path = draft.path === undefined || draft.path.trim() === "" ? OPENCLAW_DEFAULTS.path : draft.path.trim();
    if (!path.startsWith("/")) throw new LocalizedError("hooks.need-path");
    return { id, kind, gateway, path, ...bothOrNeitherToken(draft.token ?? null, draft.tokenEnv ?? null) };
  }
  const command = draft.command === undefined ? "" : draft.command.trim();
  if (command === "") throw new LocalizedError("hooks.need-command");
  return { id, kind, command, ...(timeout === null ? {} : { timeoutMs: timeout }) };
}

/** `webhook`, then `webhook-2`: ids are how the list says "the same action" across edits. */
export function nextActionId(kind: HookActionKind, existing: ReadonlyArray<HookAction>): string {
  const taken = new Set(existing.map((action) => action.id));
  if (!taken.has(kind)) return kind;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${kind}-${index}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${kind}-${Date.now().toString(36)}`;
}
