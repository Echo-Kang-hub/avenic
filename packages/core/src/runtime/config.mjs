import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "./atomic-file.mjs";
import { CREDENTIAL_FILE, getAgent } from "./agents.mjs";
import { ensureModelConfiguration, modelConfigTarget, removeModelConfiguration } from "./model-config.mjs";
import { agentHomeRoot, agentSessionsRoot, runtimePaths } from "./project-paths.mjs";
import { LABELS } from "../labels.mjs";
import { refreshStateStamp } from "./sessions.mjs";
import { ensureRuntimeGitignore, removeRuntimeGitignore } from "./gitignore.mjs";

// One question per axis, and no axis answered by an implication of another:
//
//   authMethod    account | api          how the agent authenticates
//   accountScope  global | project       which account state (account only)
//   configScope   global | project       which native config file (api only)
//   sessionScope  global | project       where Avenic keeps its session records
//   historyMode   shared | isolated      project-wide: one conversation or many
//
// An answered method is the only thing that makes `accountScope`/`configScope`
// meaningful, so only the one that belongs to the answer is stored. A missing
// `authMethod` is not "unset": it is the project saying it does not know, and a
// plain launch asks (see `agent-runtime.mjs`) instead of guessing.
const AUTH_METHODS = new Set(["account", "api"]);
const SCOPES = new Set(["global", "project"]);
const HISTORY_MODES = new Set(["shared", "isolated"]);
// 2.x stored one `auth: "global"|"project"` per agent plus a project-wide
// `sessionInterop`; 3 is the converged model above. `loadRuntime` upgrades a
// legacy file once, in place, and keeps nothing of the old spelling.
const SCHEMA_VERSION = 3;

async function readJsonIfExists(file, fallback) {
  if (!existsSync(file)) {
    return fallback;
  }
  try {
    return JSON.parse((await readFile(file, "utf8")).replace(/^﻿/, ""));
  } catch {
    // A file that cannot be read is not a file that is not there: saying which
    // one, and what to do, beats a parser's position report with no filename in
    // it. Nothing is written over the damaged file — its bytes are the only
    // remaining copy of what the project answered.
    throw new Error(`Refusing to read ${file}: it is not valid JSON — repair or remove the file, then run the command again`);
  }
}

async function writeJsonIfChanged(file, value) {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  if (existsSync(file) && (await readFile(file, "utf8")) === content) {
    return false;
  }
  await writeFileAtomic(file, content);
  return true;
}

export function validateAuthMethod(method) {
  if (!AUTH_METHODS.has(method)) {
    throw new Error(`${LABELS.authentication} must be ${LABELS.account} or ${LABELS.api}: ${method}`);
  }
  return method;
}

export function validateScope(scope, what = "Scope") {
  if (!SCOPES.has(scope)) {
    throw new Error(`${what} must be global or project: ${scope}`);
  }
  return scope;
}

export function validateHistoryMode(mode) {
  if (!HISTORY_MODES.has(mode)) {
    throw new Error(`History must be shared or isolated: ${mode}`);
  }
  return mode;
}

export { agentHomeRoot, agentSessionsRoot, runtimePaths };

// A released version projected a provider configuration into the agent's own
// *native* project file — for Claude, `.claude/settings.local.json`, which is
// the file the projection wrote and the only one it wrote. That file is the
// evidence that turns a legacy `auth` into an API configuration; an agent with
// no native project file (Codex) has none to find, and a project that never
// used the released projection has none either. Without usable content the
// entry keeps the sign-in axis it recorded instead. Read-only: migration never
// writes, moves or deletes a user file.
async function usableOverlay(projectRoot, agentId) {
  const target = modelConfigTarget(projectRoot, agentId, "project");
  if (!target || agentId !== "claude" || !existsSync(target.file)) return false;
  try {
    const parsed = JSON.parse((await readFile(target.file, "utf8")).replace(/^﻿/, ""));
    const env = parsed?.env;
    if (env === null || typeof env !== "object" || Array.isArray(env)) return false;
    return Object.values(env).some((value) => typeof value === "string" && value.length > 0);
  } catch {
    return false;
  }
}

// The canonical form of one agent entry. Idempotent by construction: a file
// that is already canonical maps to itself, so `writeJsonIfChanged` turns the
// second read into no write at all.
async function canonicalEntry(projectRoot, agentId, entry) {
  const sessionScope = SCOPES.has(entry.sessionScope) ? entry.sessionScope
    : SCOPES.has(entry.sessions) ? entry.sessions : "project";
  const base = entry.enabled === undefined ? {} : { enabled: Boolean(entry.enabled) };
  // OpenCode answers for its own authentication and provider: Avenic records a
  // session choice, nothing else.
  if (agentId === "opencode") {
    return { ...base, sessionScope };
  }
  if (AUTH_METHODS.has(entry.authMethod)) {
    return entry.authMethod === "account"
      ? { ...base, authMethod: "account", accountScope: SCOPES.has(entry.accountScope) ? entry.accountScope : "global", sessionScope }
      : { ...base, authMethod: "api", configScope: SCOPES.has(entry.configScope) ? entry.configScope : "global", sessionScope };
  }
  // The released axis said where the sign-in lived, and it maps one to one:
  // `global` is the machine's own account and `project` a sign-in the agent
  // keeps in the project's own home — which is what the run did then and what
  // it does now. A provider projection is the one thing that is not a sign-in,
  // so it wins over the axis it was written beside; it is also the only case
  // where the entry becomes API.
  if (entry.auth === "project" && await usableOverlay(projectRoot, agentId)) {
    return { ...base, authMethod: "api", configScope: "project", sessionScope };
  }
  if (entry.auth === "project") {
    return { ...base, authMethod: "account", accountScope: "project", sessionScope };
  }
  if (entry.auth === "global") {
    return { ...base, authMethod: "account", accountScope: "global", sessionScope };
  }
  return { ...base, sessionScope };
}

async function canonicalRuntime(projectRoot, runtime) {
  const agents = {};
  for (const [agentId, entry] of Object.entries(runtime.agents ?? {})) {
    if (entry === null || typeof entry !== "object") continue;
    agents[agentId] = await canonicalEntry(projectRoot, agentId, entry);
  }
  const { sessionInterop, auth, sessions, ...rest } = runtime;
  return {
    ...rest,
    schemaVersion: SCHEMA_VERSION,
    agents,
    historyMode: HISTORY_MODES.has(runtime.historyMode) ? runtime.historyMode
      : HISTORY_MODES.has(sessionInterop) ? sessionInterop : "shared",
  };
}

// The per-developer override answers one question — which method applies here —
// so an override that no longer answers it is not kept as an empty shell.
async function canonicalLocal(projectRoot, local) {
  const agents = {};
  for (const [agentId, entry] of Object.entries(local.agents ?? {})) {
    if (entry === null || typeof entry !== "object" || agentId === "opencode") continue;
    if (AUTH_METHODS.has(entry.authMethod)) {
      agents[agentId] = entriesForMethod(entry.authMethod, entry);
    } else if (entry.auth === "project" && await usableOverlay(projectRoot, agentId)) {
      agents[agentId] = { authMethod: "api", configScope: "project" };
    }
  }
  return { schemaVersion: SCHEMA_VERSION, agents };
}

function entriesForMethod(authMethod, entry) {
  return authMethod === "account"
    ? { authMethod, accountScope: SCOPES.has(entry.accountScope) ? entry.accountScope : "global" }
    : { authMethod, configScope: SCOPES.has(entry.configScope) ? entry.configScope : "global" };
}

/**
 * The project's runtime state, upgraded to the canonical schema on the way in.
 * A legacy file is rewritten exactly once — the rewrite is the migration, and
 * a canonical file maps to its own bytes — and nothing outside Avenic's two
 * config files is read or written.
 */
export async function loadRuntime(projectRoot) {
  const paths = runtimePaths(projectRoot);
  const hadRuntime = existsSync(paths.runtimeFile);
  const hadLocal = existsSync(paths.localRuntimeFile);
  const rawRuntime = await readJsonIfExists(paths.runtimeFile, { schemaVersion: SCHEMA_VERSION, agents: {} });
  const rawLocal = await readJsonIfExists(paths.localRuntimeFile, { schemaVersion: SCHEMA_VERSION, agents: {} });
  const runtime = await canonicalRuntime(projectRoot, rawRuntime);
  const local = await canonicalLocal(projectRoot, rawLocal);
  if (hadRuntime) await writeJsonIfChanged(paths.runtimeFile, runtime);
  if (hadLocal) await writeJsonIfChanged(paths.localRuntimeFile, local);
  return { paths, runtime, local };
}

// The persisted file is deliberately small: credentials stay in their native
// locations and only the user's answers live here.
export function projectConfig(state) {
  const agents = {};
  for (const [agentId, config] of Object.entries(state.runtime.agents ?? {})) {
    if (!config?.enabled) continue;
    agents[agentId] = viewOf(config);
  }
  return {
    agents,
    historyMode: HISTORY_MODES.has(state.runtime.historyMode) ? state.runtime.historyMode : "shared",
  };
}

// What one entry answers, with the method's own scope and nothing of the other
// method's. Used for the persisted config, for the wizard's draft and for every
// surface that reports what a launch will do.
export function viewOf(config) {
  const view = { sessionScope: SCOPES.has(config?.sessionScope) ? config.sessionScope : "project" };
  if (config?.authMethod === "account") {
    view.authMethod = "account";
    view.accountScope = SCOPES.has(config.accountScope) ? config.accountScope : "global";
  } else if (config?.authMethod === "api") {
    view.authMethod = "api";
    view.configScope = SCOPES.has(config.configScope) ? config.configScope : "global";
  }
  return view;
}

function normalizedAgents(agents) {
  const result = {};
  for (const [agentId, config] of Object.entries(agents ?? {})) {
    getAgent(agentId);
    const sessionScope = validateScope(config?.sessionScope ?? "project", "Sessions");
    if (agentId === "opencode") {
      result[agentId] = { enabled: true, sessionScope };
      continue;
    }
    if (config?.authMethod === undefined || config?.authMethod === null) {
      result[agentId] = { enabled: true, sessionScope };
    } else {
      validateAuthMethod(config.authMethod);
      result[agentId] = { enabled: true, ...entriesForMethod(config.authMethod, config), sessionScope };
    }
  }
  return result;
}

// Apply a complete project draft in one write. Callers build the draft in
// memory first, so cancelling an init/change wizard cannot leave half-configured
// state on disk. Omitting `agents` changes only the requested project policy.
export async function configureProject(projectRoot, draft = {}, options = {}) {
  if (draft.historyMode !== undefined) validateHistoryMode(draft.historyMode);
  const state = await loadRuntime(projectRoot);
  const nextAgents = draft.agents === undefined
    ? (state.runtime.agents ?? {})
    : normalizedAgents(draft.agents);
  const nextHistory = draft.historyMode ?? state.runtime.historyMode ?? "shared";
  state.runtime = {
    ...state.runtime,
    schemaVersion: SCHEMA_VERSION,
    agents: nextAgents,
    historyMode: nextHistory,
  };
  const directories = [];
  for (const [agentId, config] of Object.entries(nextAgents)) {
    directories.push(agentSessionsRoot(projectRoot, agentId));
    // Only a project-scope account needs a home for the agent's own login;
    // an API configuration lives in the agent's native config file, and its
    // directory is the native writer's to create.
    if (config.authMethod === "account" && config.accountScope === "project") {
      directories.push(agentHomeRoot(projectRoot, agentId));
    }
  }
  for (const directory of directories) await mkdir(directory, { recursive: true });
  const configChanged = await writeJsonIfChanged(state.paths.runtimeFile, state.runtime);
  // The API half of a draft: the agent's own configuration file, made to exist
  // where that agent reads it. Written after the runtime file, so a native
  // failure still leaves a project that knows what it answered — and only for
  // an agent whose draft answer *is* API: leaving API mode is the explicit
  // keep/remove step, never a side effect of choosing something else. An
  // existing file is never touched; a file this run created is taken back out
  // if the rest of the apply fails, so a failed run leaves nothing behind.
  const prepared = [];
  try {
    for (const [agentId, entry] of Object.entries(nextAgents)) {
      if (entry?.authMethod !== "api") continue;
      const outcome = await ensureModelConfiguration(projectRoot, agentId, entry.configScope ?? "global", options);
      if (outcome.created) prepared.push({ agentId, scope: entry.configScope ?? "global" });
    }
    const gitignoreChanged = Object.keys(nextAgents).length > 0
      ? await ensureRuntimeGitignore(projectRoot)
      : false;
    return { ...state, configChanged, gitignoreChanged, config: projectConfig(state) };
  } catch (error) {
    for (const { agentId, scope } of prepared) {
      await removeModelConfiguration(projectRoot, agentId, scope, options).catch(() => {});
    }
    throw error;
  }
}

export async function getActiveCanonicalSessionId(projectRoot) {
  const state = await loadRuntime(projectRoot);
  const id = state.runtime.activeCanonicalSessionId;
  if (typeof id !== "string" || !id) return null;
  const sessionFile = path.join(state.paths.sessionsRoot, "canonical", id, "session.json");
  return existsSync(sessionFile) ? id : null;
}

export async function setActiveCanonicalSession(projectRoot, canonicalSessionId) {
  if (canonicalSessionId !== null && (typeof canonicalSessionId !== "string" || !canonicalSessionId)) {
    throw new Error("Active canonical session id must be a non-empty string or null");
  }
  const state = await loadRuntime(projectRoot);
  if (canonicalSessionId === null) delete state.runtime.activeCanonicalSessionId;
  else state.runtime.activeCanonicalSessionId = canonicalSessionId;
  await writeJsonIfChanged(state.paths.runtimeFile, state.runtime);
  // Which conversation is current is what every session list marks, so the
  // state stamp names it: a launch transition carries the previous one forward,
  // and only this write knows the new one.
  await refreshStateStamp(projectRoot, { active: canonicalSessionId });
  return canonicalSessionId;
}

export async function initializeAgent(projectRoot, agentId, entry = {}) {
  getAgent(agentId);
  // The answers are named, not positional: a caller that passes a bare string
  // would otherwise spread it into the entry and write a runtime file of single
  // characters, so it is refused here instead.
  if (entry === null || typeof entry !== "object") {
    throw new Error("Agent configuration must be an object of named answers");
  }
  if (entry.authMethod !== undefined && entry.authMethod !== null) {
    validateAuthMethod(entry.authMethod);
  }
  if (entry.sessionScope !== undefined) {
    validateScope(entry.sessionScope, "Sessions");
  }
  const state = await loadRuntime(projectRoot);
  const previous = viewOf(state.runtime.agents?.[agentId] ?? {});
  const next = { ...previous, ...entry };
  // The method's own scope, defaulted and narrowed by the same function that
  // writes the file: naming a method without naming its scope is choosing the
  // default, and the other method's scope is not carried over as a stale answer.
  if (AUTH_METHODS.has(next.authMethod)) {
    Object.assign(next, entriesForMethod(next.authMethod, next));
  }
  const sessionDirectory = agentSessionsRoot(projectRoot, agentId);
  const homeDirectory = agentHomeRoot(projectRoot, agentId);
  const missingStructure = [sessionDirectory];
  if (next.authMethod === "account" && next.accountScope === "project") {
    missingStructure.push(homeDirectory);
  }
  const structureRepaired = missingStructure.some((directory) => !existsSync(directory));
  for (const directory of missingStructure) {
    await mkdir(directory, { recursive: true });
  }
  const draft = projectConfig(state);
  draft.agents[agentId] = next;
  const configured = await configureProject(projectRoot, draft);
  return {
    ...configured,
    // The entry as it was written, not as it was assembled: one method's scope
    // and no trace of the other's.
    entry: viewOf(next),
    configChanged: configured.configChanged,
    gitignoreChanged: configured.gitignoreChanged,
    structureRepaired,
  };
}

// 留下一个 home 里的登录文件本身、清掉其余内容；没有登录文件就整个删掉。返回是否
// 留下了文件，让调用方说得出来留下的是哪一个。
async function purgeHomeKeepingCredential(homeDirectory, credentialName) {
  if (credentialName === undefined || !existsSync(path.join(homeDirectory, credentialName))) {
    await rm(homeDirectory, { recursive: true, force: true });
    return false;
  }
  for (const entry of await readdir(homeDirectory)) {
    if (entry === credentialName) continue;
    await rm(path.join(homeDirectory, entry), { recursive: true, force: true });
  }
  return true;
}

// `--purge` 说的是清掉 Avenic 的数据。`.agents/local/<agent>/` 里住的不是它：那是
// agent 自己的账号家目录，Account · Project 的登录就在这里、用 agent 自己的格式写
// （release 路径正因为同一条理由拒绝删它）。所以默认只清 Avenic 的痕迹、留下登录
// 文件；连它一起删要用户第二次明说（purgeCredentials）。
async function purgeAgentHome(homeDirectory, agentId, options) {
  if (options.purgeCredentials) {
    await rm(homeDirectory, { recursive: true, force: true });
    return false;
  }
  const credential = CREDENTIAL_FILE[agentId];
  // 没有登录文件的 agent（OpenCode 管自己的认证）没有「留下的那一份」：它的 home
  // 里是项目数据本身（项目副本的导入名单、共享历史的投影），不是可以重来的登录。
  // 「留下登录、清掉其余」这条规则对它无从谈起，于是整个 home 留下。
  if (credential === undefined) return existsSync(homeDirectory);
  return purgeHomeKeepingCredential(homeDirectory, credential);
}

// 直接躺在 `.agents/local/` 下的这三个文件不属于任何 agent 的 home：名单是用户的
// 令牌（OpenClaw 的那一个删了就再也收不到通知，而且他没有地方找回），与登录文件同
// 一条规则——默认留下，第二次明说（purgeCredentials）才删；runtime.local.json 是他
// 自己的答案，ownership.json 是证明 Avenic 建过哪些文件的账本（删掉它，那些文件就
// 再没人证明得了），这两份不含任何凭据，两层都留下。其余的直接文件（state stamp、
// 去重窗口）都是导出来的，下一次运行自己写回来。
const KEPT_LOCAL_FILE = "hook-actions.json";
const KEPT_ANSWER_FILES = new Set(["runtime.local.json", "ownership.json"]);

// 整个 `.agents/local` 的清理守同一条规则：每个 agent 的 home 只留下它自己的登录
// 文件（第二次明说才连它一起删），直接放在这里的文件按上面那几份处理，认不出来的
// 目录留下 —— 比如 OpenCode 的项目 home（导入名单与共享历史的投影），它既不是配置
// 也不是登录，任何一层 purge 都不是冲它来的。一个文件都没留下才把目录本身删掉。
// 目录项只按目录处理：一个指向别处的链接不该被读穿。
async function purgeAgentHomes(localRoot, options) {
  if (!existsSync(localRoot)) return;
  let kept = false;
  for (const entry of await readdir(localRoot, { withFileTypes: true })) {
    const target = path.join(localRoot, entry.name);
    if (entry.isDirectory()) {
      const credential = CREDENTIAL_FILE[entry.name];
      if (credential === undefined) {
        kept = true;
      } else if (options.purgeCredentials) {
        await rm(target, { recursive: true, force: true });
      } else {
        kept = await purgeHomeKeepingCredential(target, credential) || kept;
      }
    } else if (KEPT_ANSWER_FILES.has(entry.name)) {
      kept = true;
    } else if (entry.name === KEPT_LOCAL_FILE && !options.purgeCredentials) {
      kept = true;
    } else {
      await rm(target, { recursive: true, force: true });
    }
  }
  if (!kept) await rm(localRoot, { recursive: true, force: true });
}

// 清完之后留下来的那一份在哪，用同一条读数回答两条返回路径：`--purge` 说过要清数据，
// 那它就得说得出自己没清掉哪一份——一句「Preserved」而文件其实没了，比不说更坏。
function keptReport(projectRoot, file, kept) {
  return kept && existsSync(file) ? path.relative(projectRoot, file).split(path.sep).join("/") : null;
}

const keptActions = (state, projectRoot, purged) => keptReport(projectRoot, path.join(state.paths.localRoot, KEPT_LOCAL_FILE), purged);

export async function deinitializeAgent(projectRoot, agentId, options = {}) {
  const agent = getAgent(agentId);
  const state = await loadRuntime(projectRoot);
  const homeDirectory = agentHomeRoot(projectRoot, agentId);
  if (!state.runtime.agents?.[agentId]) {
    const sessionDirectory = agentSessionsRoot(projectRoot, agentId);
    const purged = Boolean(options.purge && (existsSync(sessionDirectory) || existsSync(homeDirectory)));
    if (options.purge) {
      await rm(sessionDirectory, { recursive: true, force: true });
      // 被 deinit 的是这一个 agent，清的就是它自己的 home；`.agents/local/` 下别人的
      // 东西（别的 agent 的答案、账本、用户自己的答案、OpenCode 的项目 home）不属于
      // 这一次 deinit，原样不动。没有别的 agent 了才顺带把目录里的杂物一起收掉 ——
      // 什么都没剩，目录本身才走。
      await purgeAgentHome(homeDirectory, agentId, options);
      if (Object.keys(state.runtime.agents ?? {}).length === 0) {
        await purgeAgentHomes(state.paths.localRoot, options);
        await removeRuntimeGitignore(projectRoot, { sessions: true });
      }
    }
    return {
      agent,
      changed: purged,
      purged,
      keptCredential: CREDENTIAL_FILE[agentId] === undefined ? null : keptReport(projectRoot, path.join(homeDirectory, CREDENTIAL_FILE[agentId]), Boolean(options.purge)),
      keptActions: keptActions(state, projectRoot, Boolean(options.purge)),
      remaining: Object.keys(state.runtime.agents ?? {}).length,
    };
  }

  // The file Avenic prepared goes with the answer that asked for it: deinit is
  // the user saying this project no longer configures that agent, and a file it
  // made, left behind where the agent still reads it, is the configuration
  // outliving its own removal. Ownership-bounded like every other release —
  // only a file the ledger proves Avenic created and nobody has touched since.
  const entry = state.runtime.agents[agentId];
  if (entry.authMethod === "api") {
    await removeModelConfiguration(projectRoot, agentId, entry.configScope ?? "global", options);
  }
  delete state.runtime.agents[agentId];
  if (Object.keys(state.runtime.agents).length === 0) {
    await rm(state.paths.runtimeFile, { force: true });
  } else {
    await writeJsonIfChanged(state.paths.runtimeFile, state.runtime);
  }

  if (state.local.agents?.[agentId]) {
    delete state.local.agents[agentId];
    if (Object.keys(state.local.agents).length === 0) {
      await rm(state.paths.localRuntimeFile, { force: true });
    } else {
      await writeJsonIfChanged(state.paths.localRuntimeFile, state.local);
    }
  }
  let kept = false;
  if (options.purge) {
    await rm(agentSessionsRoot(projectRoot, agentId), { recursive: true, force: true });
    kept = await purgeAgentHome(homeDirectory, agentId, options);
  }
  const remaining = Object.keys(state.runtime.agents).length;
  if (remaining === 0) {
    if (options.purge) {
      await purgeAgentHomes(state.paths.localRoot, options);
      await rm(path.join(projectRoot, ".agents", "tmp"), { recursive: true, force: true });
    }
    await removeRuntimeGitignore(projectRoot, { sessions: Boolean(options.purge) });
  }
  return {
    agent,
    changed: true,
    purged: Boolean(options.purge),
    remaining,
    keptCredential: keptReport(projectRoot, path.join(homeDirectory, CREDENTIAL_FILE[agentId]), kept),
    keptActions: keptActions(state, projectRoot, Boolean(options.purge)),
  };
}

export async function setLocalAuth(projectRoot, agentId, choice) {
  const agent = getAgent(agentId);
  if (agentId === "opencode") {
    throw new Error(`${agent.displayName} manages its own authentication and provider configuration`);
  }
  const authMethod = validateAuthMethod(choice?.authMethod);
  const entry = entriesForMethod(authMethod, choice ?? {});
  validateScope(entry.accountScope ?? entry.configScope, "Scope");
  const state = await loadRuntime(projectRoot);
  if (!state.runtime.agents?.[agentId]?.enabled) {
    throw new Error(`${agent.displayName} is not initialized`);
  }
  state.local.schemaVersion = SCHEMA_VERSION;
  state.local.agents ??= {};
  state.local.agents[agentId] = entry;
  await mkdir(state.paths.localRoot, { recursive: true });
  if (entry.accountScope === "project") {
    await mkdir(agentHomeRoot(projectRoot, agentId), { recursive: true });
  }
  await writeJsonIfChanged(state.paths.localRuntimeFile, state.local);
  // An API answer is a file the agent reads, so answering API has to leave that
  // file where the agent will look — the same step a wizard's draft takes, and
  // for the same reason: an answer that names a file nobody made is an answer
  // the user has to finish by hand without being told. After the write, so a
  // native failure still leaves a project that knows what it answered. Nothing
  // is written into it, and a file that is already there is left alone.
  if (entry.authMethod === "api") {
    await ensureModelConfiguration(projectRoot, agentId, entry.configScope ?? "global");
  }
  await ensureRuntimeGitignore(projectRoot);
  return effectiveAgentConfig(state, agentId);
}

export async function clearLocalAuth(projectRoot, agentId) {
  const agent = getAgent(agentId);
  const state = await loadRuntime(projectRoot);
  if (!state.runtime.agents?.[agentId]?.enabled) {
    throw new Error(`${agent.displayName} is not initialized`);
  }
  if (!state.local.agents?.[agentId]) {
    return effectiveAgentConfig(state, agentId);
  }
  delete state.local.agents[agentId];
  if (Object.keys(state.local.agents).length === 0) {
    await rm(state.paths.localRuntimeFile, { force: true });
  } else {
    await writeJsonIfChanged(state.paths.localRuntimeFile, state.local);
  }
  return effectiveAgentConfig(state, agentId);
}

// The one answer a launch, a status line and a wizard prefill all ask for: what
// this agent runs under here, after the per-developer override, and where that
// answer came from. `authMethod` missing means the project has not decided.
export function effectiveAgentConfig(state, agentId) {
  const configured = state.runtime.agents?.[agentId];
  if (!configured) {
    return null;
  }
  const override = state.local.agents?.[agentId] ?? null;
  const view = viewOf({ ...configured, ...(override ?? {}) });
  return {
    ...view,
    source: override?.authMethod ? "local" : view.authMethod ? "project" : null,
    local: override,
    configured,
  };
}

// Shared status shape for CLI and VS Code. Authentication and session storage
// are independent dimensions; either one can be switched on its own.
export async function getAgentRuntimeMode(projectRoot, agentId) {
  const state = await loadRuntime(projectRoot);
  const effective = effectiveAgentConfig(state, agentId);
  if (!effective) return null;
  return {
    auth: {
      method: effective.authMethod ?? null,
      scope: effective.authMethod === "account" ? effective.accountScope ?? "global"
        : effective.authMethod === "api" ? effective.configScope ?? "global" : null,
      source: effective.source,
    },
    sessions: { scope: effective.sessionScope },
  };
}
