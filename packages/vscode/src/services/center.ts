import { readFile } from "node:fs/promises";
import {
  CLAUDE_BLOCKS,
  MODEL_ROLES,
  applyModelConfiguration,
  claudeTemplate,
  codexTemplate,
  fetchModelCatalog,
  getAgent,
  previewModelConfiguration,
  providerForBaseUrl,
  providerPreset,
  providersForAgent,
  readModelCatalogCache,
  readModelConfiguration,
  testProviderConnection,
  writeModelCatalogCache,
} from "@avenic/core";
import type { CatalogFailure, ModelSettings, ProviderFormat, ProviderPreset, Scope } from "@avenic/core";
import type { AgentId, CenterBlock, CenterDraft, CenterProvider, CenterResult, CenterRole, CenterState } from "../dashboard/protocol.ts";
import { LocalizedError, sentence, type TextKey } from "../i18n/text.ts";
import { projectStatus } from "./agents.ts";

// 模型配置中心的数据与动作（无 vscode import，所以整套判断不需要编辑器就能测）。
//
// 这一页写的不是 Avenic 的配置，是 agent 自己的那个文件：供应商、地址、模型与凭据
// 全部由 core 的预设表与合并回答，插件只把「用户此刻填的那份表单」翻译成 core 认识
// 的模板，再把 core 的答案翻回协议里那几种结果。它不判断 API 是什么格式，也不自己
// 拼 diff。
//
// 两条不许破的规矩，它们也是这一页存在的理由：
//   1. 凭据只出不进。状态里只有 credentialSet 一个布尔；结果里的 diff 行由 core 的
//      maskSecrets 打过码；预览与写入拿回来的整份文件字节（core 的 `after`）在进程里
//      停住，永远不进任何返回值。填了 key 的那一次请求，key 只在 header 里。
//   2. 没变就不写。预览说 written: false 时，文件必须一个字节都没动——core 的合并按
//      解析后的值判断，所以「格式不同、内容一样」也不写。

// 一个可选的块落成一个勾选框时要有个名字。core 的 CLAUDE_BLOCKS 只有 id 与值（那是它写出
// 去的东西），名字是宿主给页面画的那一句 —— 所以它在词表里，按编辑器的语言说。
const BLOCK_KEYS: Record<string, TextKey> = {
  signature: "center.block-signature",
  teammates: "center.block-teammates",
  toolSearch: "center.block-tool-search",
  thinkingBudget: "center.block-thinking-budget",
  autoUpgrade: "center.block-auto-upgrade",
};

export interface CenterOptions {
  environment?: Record<string, string | undefined>;
  /** Tests and hosts may bring their own fetch; production reads the platform's when a call is made. */
  fetchImpl?: (url: string, init: { method?: string; headers?: Record<string, string>; body?: string; signal?: unknown }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
  timeoutMs?: number;
  /**
   * The editor's own language, for the sentences this layer hands *back* (a
   * failed catalog's note). Refusals are thrown as LocalizedError instead: a key
   * travels further than a sentence, and the command layer is where it is said.
   */
  language?: string;
}

const languageOf = (options: CenterOptions): string => options.language ?? "en";

const text = (value: unknown): string => (typeof value === "string" && value.trim() !== "" ? value.trim() : "");
const isPlainObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** That agent's own side of a preset: Claude's `env` block, or Codex's provider table. */
function sideOf(preset: ProviderPreset, agentId: AgentId): ProviderFormat | null {
  if (agentId === "claude") return preset.claude;
  if (agentId === "codex") return preset.codex;
  // OpenCode keeps its own provider registry and its own sign-in: Avenic writes
  // nothing there, so there is no side of the table for it to write.
  return null;
}

const keepsOwn = (agentId: AgentId) => new LocalizedError("center.not-owned", { name: getAgent(agentId).displayName });

/**
 * The one page a provider documented, looked up in core's own table — the page
 * reports an id and never a link (a webview's link is a link the webview can be
 * talked into holding). Nothing recorded, or something that is not http(s),
 * means nothing is opened.
 */
export function docsLink(providerId: string): string | null {
  const docs = providerPreset(providerId)?.docs ?? null;
  return docs !== null && /^https?:\/\//.test(docs) ? docs : null;
}

/** The file an agent's configuration came from, read as a document — null for anything that is not one. */
async function readDocument(file: string): Promise<unknown> {
  try {
    return JSON.parse((await readFile(file, "utf8")).replace(/^﻿/, ""));
  } catch {
    return null;
  }
}

/** Whether a document carries a shape: every key it names, with the value it names. */
function carries(document: unknown, shape: Record<string, unknown>): boolean {
  if (!isPlainObject(document)) return false;
  return Object.entries(shape).every(([key, value]) =>
    isPlainObject(value) ? carries(document[key], value) : document[key] === value);
}

// 文件里那个值按角色读回来。fable 暂时没有：core 会写 ANTHROPIC_DEFAULT_FABLE_MODEL，
// 但它的读回（ModelSettings）里还没有这一栏 —— 那就说 null，不拿主模型顶上。
function roleCurrent(settings: ModelSettings | null, role: string): string | null {
  if (settings === null) return null;
  if (role === "sonnet") return settings.sonnet ?? null;
  if (role === "opus") return settings.opus ?? null;
  if (role === "haiku") return settings.haiku ?? null;
  if (role === "subagent") return settings.subagent ?? null;
  return null;
}

/**
 * The Center's whole state for one agent, read off the file that agent reads —
 * the same file core merges into, so this page and `avenic change` are two views
 * of one fact rather than two stores. An agent that keeps its own provider
 * configuration answers honestly: no provider, no roles, no blocks, and a page
 * that still has something to draw.
 */
export async function centerState(
  projectRoot: string,
  agentId: AgentId,
  environment: Record<string, string | undefined> = process.env,
  language = "en",
): Promise<CenterState> {
  const status = await projectStatus(projectRoot, environment as NodeJS.ProcessEnv);
  const row = status.agents.find((agent) => agent.id === agentId) ?? null;
  const auth = row?.auth ?? null;
  const providers: CenterProvider[] = providersForAgent(agentId).map((preset) => ({
    id: preset.id,
    name: preset.displayName,
    docs: preset.docs,
    baseUrl: sideOf(preset, agentId)?.baseUrl ?? null,
    selected: false,
  }));
  const state: CenterState = {
    agent: agentId,
    label: getAgent(agentId).displayName,
    auth: row?.runtime === "native" ? "none" : auth?.method ?? "none",
    scope: auth?.scope ?? null,
    relative: auth?.method === "api" ? auth.configuration?.relative ?? null : null,
    provider: null,
    baseUrl: "",
    model: "",
    credentialSet: false,
    roles: [],
    blocks: [],
    models: [],
    catalog: { at: null, note: null },
    providers,
  };
  // 只有 API 的答案指向一个 Avenic 会合并的文件；Account 与自管的 agent 都没有，
  // 于是这一页什么都不假装：说得出的是「这里没有一份在生效的 API 配置」。
  const facts = auth?.method === "api" ? await readModelConfiguration(projectRoot, agentId, auth.scope, { environment }) : null;
  if (facts === null) return state;

  const baseUrl = facts.baseUrl ?? "";
  // 供应商是文件里那个地址读回来的，不是这一页记住的：地址不属于表里任何一家时，
  // 它就是 `custom` —— 自己那扇门，而不是一个错的高亮。
  const provider = providerForBaseUrl(agentId, baseUrl)?.id ?? (baseUrl === "" ? null : "custom");
  const preset = providerPreset(provider ?? "");
  const document = agentId === "claude" ? await readDocument(facts.file) : null;
  const cache = provider === null ? null : await readModelCatalogCache(projectRoot, provider);
  const curated = preset?.curated ?? [];
  const cached = cache?.models ?? [];
  const roles: CenterRole[] = MODEL_ROLES.map((role) => ({
    id: role,
    recommended: preset?.claude?.roles?.[role] ?? null,
    current: roleCurrent(facts.settings, role),
  }));
  const blocks: CenterBlock[] = CLAUDE_BLOCKS.map((block) => ({
    id: block.id,
    // 词表里没有名字的那一块（core 新加了一个）就报自己的 id：页面至少画得出它，而不是空着。
    name: BLOCK_KEYS[block.id] === undefined ? block.id : sentence(language, BLOCK_KEYS[block.id]),
    on: carries(document, { ...(block.values ?? {}), ...(block.env === undefined ? {} : { env: block.env }) }),
  }));
  return {
    ...state,
    provider,
    baseUrl,
    model: facts.model ?? "",
    credentialSet: facts.credentialSet,
    providers: providers.map((entry) => ({ ...entry, selected: entry.id === provider })),
    // 角色的映射是 Claude 的事：Codex 的文件里只有一个模型名，没有角色可映。
    roles: agentId === "claude" ? roles : [],
    blocks: agentId === "claude" ? blocks : [],
    models: [...curated, ...cached.filter((name) => !curated.includes(name))],
    catalog: { at: cache?.fetchedAt ?? null, note: null },
  };
}

/**
 * The form a preset fills in. This is a *form*, not a write: it only ever runs
 * when the user picks a provider or resets one, and the vendor's recommendation
 * belongs to a configuration being created — never to one already in place,
 * which is why applying it is decided again at write time (see `presetRoles`).
 */
export function fillFromPreset(agentId: AgentId, providerId: string): CenterDraft {
  const preset = providerPreset(providerId);
  if (preset === null) throw new LocalizedError("center.unknown-provider", { provider: providerId });
  const side = sideOf(preset, agentId);
  if (side === null) throw keepsOwn(agentId);
  return {
    provider: preset.id,
    baseUrl: side.baseUrl ?? "",
    // 供应商自己文档里的第一个名字；只映射角色不列模型的供应商，用它推荐的 sonnet。
    model: preset.curated[0] ?? preset.claude?.roles?.sonnet ?? "",
    // Codex never holds a key: its configuration names the environment variable.
    credential: null,
    roles: agentId === "claude" ? { ...(preset.claude.roles ?? {}) } : {},
    blocks: [],
  };
}

/**
 * The preset a draft names, checked against the URL it carries before anything
 * is written. An id no preset owns is an error rather than a fallback to
 * `custom`; a URL no preset owns *is* `custom`, because that is the door for a
 * gateway whose address is the user's own — and a preset that publishes its own
 * endpoint cannot stand behind someone else's address, or its table name and
 * `env_key` would be facts about an endpoint nobody is using.
 */
function resolve(agentId: AgentId, draft: CenterDraft): { preset: ProviderPreset; side: ProviderFormat } {
  const chosen = providerPreset(draft.provider);
  if (chosen === null) throw new LocalizedError("center.unknown-provider", { provider: draft.provider });
  const side = sideOf(chosen, agentId);
  if (side === null) throw keepsOwn(agentId);
  if (side.baseUrl === null) return { preset: chosen, side };
  const resolved = providerForBaseUrl(agentId, draft.baseUrl) ?? providerPreset("custom");
  const replacement = resolved === null ? null : sideOf(resolved, agentId);
  return replacement === null ? { preset: chosen, side } : { preset: resolved as ProviderPreset, side: replacement };
}

/**
 * The scope this agent's API answer is written at, or the refusal that stops a
 * write pointing at a file nobody reads: an agent on its own account (or one
 * that manages its own configuration) has no Avenic-written provider file in
 * effect, and writing one anyway would be a configuration that silently never
 * applies. Switching the project's answer is the Configure Project wizard's
 * question, because it also asks what happens to the old one.
 */
async function apiScope(projectRoot: string, agentId: AgentId, options: CenterOptions): Promise<Scope> {
  const status = await projectStatus(projectRoot, (options.environment ?? process.env) as NodeJS.ProcessEnv);
  const row = status.agents.find((agent) => agent.id === agentId) ?? null;
  if (row?.auth?.method !== "api") {
    throw new LocalizedError("center.not-api-scope", { agent: getAgent(agentId).displayName });
  }
  return row.auth.scope;
}

/** The template core would merge, from the form the page holds. */
async function templateFor(projectRoot: string, agentId: AgentId, draft: CenterDraft, scope: Scope, preset: ProviderPreset, options: CenterOptions) {
  const facts = await readModelConfiguration(projectRoot, agentId, scope, options);
  // 文件里已经写着这家供应商：这是一次编辑，不是一次新建。供应商推荐的模型角色属于
  // 新建一份配置，不属于「回来改一下模型」。与 `avenic change` 同一句话。
  const inPlace = providerForBaseUrl(agentId, facts?.baseUrl)?.id === preset.id;
  if (agentId === "claude") {
    // null 是「别动文件里那个」——可这句话只在文件里那个是这一家的时才成立。换了家还
    // 收下 null，写下去的就是新地址配旧钥匙：每一次请求都会把它送到新供应商那里。
    // 用户自己的网关是例外：地址是他写的，收哪把钥匙由他说了算。空串是拒绝，模板会
    // 照直抛出来，两者绝不在这里被读成同一件事。与 `avenic change` 同一条规则——那边
    // 是 `keepsCredential`，这边是同一个判断落在这一页的形态上。
    const keeps = preset.id === "custom" || (inPlace && facts?.credentialSet === true);
    if (draft.credential === null && facts?.credentialSet === true && !keeps) {
      throw new LocalizedError("center.credential-other-provider", { provider: preset.displayName });
    }
    return claudeTemplate(preset.id, {
      apiKey: draft.credential ?? undefined,
      baseUrl: draft.baseUrl,
      model: draft.model,
      roles: draft.roles,
      presetRoles: !inPlace,
    }, draft.blocks);
  }
  return codexTemplate(preset.id, { baseUrl: draft.baseUrl, model: draft.model });
}

/** 只有会变的那些行：用户批准的是改动，不是整份文件。`after` 与凭据都不在这里。 */
function diffResult(diff: ReadonlyArray<{ kind: "same" | "add" | "remove"; text: string }>, written: boolean): CenterResult {
  return { kind: "diff", written, lines: diff.filter((line) => line.kind !== "same").map((line) => ({ kind: line.kind, text: line.text })) };
}

async function write(projectRoot: string, agentId: AgentId, draft: CenterDraft, commit: boolean, options: CenterOptions): Promise<CenterResult> {
  const { preset } = resolve(agentId, draft);
  const scope = await apiScope(projectRoot, agentId, options);
  const template = await templateFor(projectRoot, agentId, draft, scope, preset, options);
  if (!commit) {
    const plan = await previewModelConfiguration(projectRoot, agentId, scope, template, options);
    return diffResult(plan.diff, false);
  }
  const plan = await applyModelConfiguration(projectRoot, agentId, scope, template, options);
  return diffResult(plan.diff, plan.written);
}

/** What this write would do, line by line, against the file that is really there. Nothing is written. */
export function previewCenter(projectRoot: string, agentId: AgentId, draft: CenterDraft, options: CenterOptions = {}): Promise<CenterResult> {
  return write(projectRoot, agentId, draft, false, options);
}

/** The same computation, committed: nothing changed means nothing written, byte for byte. */
export function applyCenter(projectRoot: string, agentId: AgentId, draft: CenterDraft, options: CenterOptions = {}): Promise<CenterResult> {
  return write(projectRoot, agentId, draft, true, options);
}

/**
 * One probe at the endpoint the form names, on the wire that agent's providers
 * speak. It is asked for explicitly and never on a page being drawn.
 *
 * The credential comes from the form; for Codex, from the variable its own
 * configuration names. A key the user did not type is not readable — core only
 * ever reports whether a file holds one — so the honest answer there is that
 * there is nothing to send, not a probe with an empty header whose 401 would
 * blame a key that was never given.
 */
export async function testCenter(agentId: AgentId, draft: CenterDraft, options: CenterOptions = {}): Promise<CenterResult> {
  const { preset, side } = resolve(agentId, draft);
  const environment = options.environment ?? process.env;
  const key = agentId === "codex" ? text(side.envKey === undefined ? "" : environment[side.envKey]) : draft.credential ?? "";
  if (agentId === "codex" && key === "") {
    return { kind: "error", message: sentence(languageOf(options), "center.no-key-env", { variable: side.envKey ?? "", provider: preset.displayName }) };
  }
  if (agentId === "claude" && draft.credential === null) {
    return { kind: "error", message: sentence(languageOf(options), "center.no-key-file-probe") };
  }
  // 没有名单地址的供应商（custom 就是用户自己的网关）：猜一条 /v1/models 去问，等于拿一条
  // 编出来的路径去否定用户的地址。探不了就说探不了，一个请求都不发。
  const catalog = preset.catalog;
  const listUrl = agentId === "codex" ? catalog?.url ?? catalog?.path ?? null : null;
  if (agentId === "codex" && listUrl === null) {
    return { kind: "error", message: sentence(languageOf(options), "center.no-catalog-endpoint", { provider: preset.displayName }) };
  }
  const probe = await testProviderConnection({
    baseUrl: draft.baseUrl,
    // Avenic writes the credential into ANTHROPIC_AUTH_TOKEN, the variable the
    // vendors' own guides pair with `Authorization: Bearer`; a provider that
    // names its own header (X-Api-Key, say) is asked on that one instead.
    header: agentId === "codex" ? catalog?.header ?? "Authorization" : "Authorization",
    apiKey: key,
    model: draft.model,
    // Codex 只认 wire_api = "responses"：chat 那条线已经被删掉了，拿它去探只会让一个好好
    // 的网关去改一个从来没错过的模型名。于是这一家探的是供应商自己文档里的模型名单（一个
    // 路径，或它自己的地址）——不花 token，401 是认证失败，而名单里没有这个名字才是模型不
    // 可用。Claude 那一半没有名单地址，走的还是 messages 那条最小请求。
    listUrl,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
  });
  return { kind: "connection", state: probe.state, status: probe.status };
}

function failureNote(reason: CatalogFailure, status: number | null, language: string): string {
  if (reason === "unauthorized") return sentence(language, "center.catalog-unauthorized");
  if (reason === "http-error") return sentence(language, "center.catalog-http", { status: status ?? 0 });
  if (reason === "unreadable") return sentence(language, "center.catalog-unreadable");
  if (reason === "timeout") return sentence(language, "center.catalog-timeout");
  return sentence(language, "center.catalog-network");
}

/**
 * Ask the provider for its model list, once, because a user asked for it. The
 * list is cached where this page can read it again without asking, under the
 * provider it came from — and the answer names that provider, because the form
 * the user is filling may be naming another one: a model name belongs to the
 * provider it was listed by, and a page that shows one under the other teaches
 * the user to fill in a name that fails every request. The key travels in a
 * header and reaches neither the cache nor the result nor a log.
 */
export async function refreshCenterModels(projectRoot: string, agentId: AgentId, draft: CenterDraft, options: CenterOptions = {}): Promise<CenterResult> {
  const { preset, side } = resolve(agentId, draft);
  const language = languageOf(options);
  const catalog = preset.catalog;
  if (catalog === null) {
    return { kind: "catalog", state: "failed", note: sentence(language, "center.no-catalog-endpoint", { provider: preset.displayName }) };
  }
  const environment = options.environment ?? process.env;
  const key = agentId === "codex" ? text(side.envKey === undefined ? "" : environment[side.envKey]) : draft.credential ?? "";
  if (catalog.header !== null && key === "") {
    return {
      kind: "catalog",
      state: "failed",
      note: agentId === "codex"
        ? sentence(language, "center.no-key-env", { variable: side.envKey ?? "", provider: preset.displayName })
        : sentence(language, "center.no-key-file-fetch"),
    };
  }
  // 供应商自己给的地址是整条 URL（模型表挂在 host 上，不在 /anthropic 底下）；只有
  // 自己跑代理的那一家给的是路径，那时根就是用户填的那个。
  const baseUrl = catalog.url ?? draft.baseUrl;
  const outcome = await fetchModelCatalog({
    baseUrl,
    listPath: catalog.path,
    header: catalog.header,
    apiKey: key,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl,
  });
  if (!outcome.ok) return { kind: "catalog", state: "failed", note: failureNote(outcome.reason, outcome.status, language) };
  await writeModelCatalogCache(projectRoot, preset.id, { baseUrl, models: outcome.models });
  return { kind: "catalog", state: "fetched", provider: preset.id, models: outcome.models, note: null };
}
