import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getAgent } from "./agents.mjs";
import { ensureRuntimeGitignore, removeRuntimeGitignore } from "./gitignore.mjs";

const AUTH_MODES = new Set(["global", "project"]);
const SESSIONS_MODES = new Set(["global", "project"]);
const SESSION_INTEROP_MODES = new Set(["shared", "isolated"]);

async function readJsonIfExists(file, fallback) {
  if (!existsSync(file)) {
    return fallback;
  }
  return JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
}

async function writeJsonIfChanged(file, value) {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  if (existsSync(file) && (await readFile(file, "utf8")) === content) {
    return false;
  }
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, file);
  return true;
}

export function validateAuthMode(authMode) {
  if (!AUTH_MODES.has(authMode)) {
    throw new Error(`Authentication must be global or project: ${authMode}`);
  }
  return authMode;
}

export function validateSessionsMode(sessionsMode) {
  if (!SESSIONS_MODES.has(sessionsMode)) {
    throw new Error(`Sessions must be global or project: ${sessionsMode}`);
  }
  return sessionsMode;
}

export function validateSessionInteropMode(mode) {
  if (!SESSION_INTEROP_MODES.has(mode)) {
    throw new Error(`Session history must be shared or isolated: ${mode}`);
  }
  return mode;
}

export function runtimePaths(projectRoot) {
  const agentsRoot = path.join(projectRoot, ".agents");
  const localRoot = path.join(agentsRoot, "local");
  return {
    localRoot,
    runtimeFile: path.join(agentsRoot, "runtime.json"),
    localRuntimeFile: path.join(localRoot, "runtime.local.json"),
    sessionsRoot: path.join(agentsRoot, "sessions"),
  };
}

export async function loadRuntime(projectRoot) {
  const paths = runtimePaths(projectRoot);
  const runtime = await readJsonIfExists(paths.runtimeFile, { schemaVersion: 1, agents: {} });
  const local = await readJsonIfExists(paths.localRuntimeFile, { schemaVersion: 1, agents: {} });
  return { paths, runtime, local };
}

// The persisted file is deliberately small: credentials stay in their native
// locations and only the user-selected scopes and session policy live here.
// Legacy projects had canonical sessions before an explicit policy existed;
// treating that absence as shared preserves their released behavior.
export function projectConfig(state) {
  const agents = {};
  for (const [agentId, config] of Object.entries(state.runtime.agents ?? {})) {
    if (!config?.enabled) continue;
    agents[agentId] = {
      auth: config.auth ?? "global",
      sessions: config.sessions ?? "project",
    };
  }
  return {
    agents,
    sessionInterop: state.runtime.sessionInterop ?? "shared",
  };
}

function normalizedAgents(agents) {
  const result = {};
  for (const [agentId, config] of Object.entries(agents ?? {})) {
    getAgent(agentId);
    const auth = validateAuthMode(config?.auth ?? "global");
    const sessions = validateSessionsMode(config?.sessions ?? "project");
    result[agentId] = { enabled: true, auth, sessions };
  }
  return result;
}

// Apply a complete project draft in one write. Callers build the draft in
// memory first, so cancelling an init/change wizard cannot leave half-configured
// state on disk. Omitting `agents` changes only the requested project policy.
export async function configureProject(projectRoot, draft = {}) {
  if (draft.sessionInterop !== undefined) validateSessionInteropMode(draft.sessionInterop);
  const state = await loadRuntime(projectRoot);
  const nextAgents = draft.agents === undefined
    ? (state.runtime.agents ?? {})
    : normalizedAgents(draft.agents);
  const nextInterop = draft.sessionInterop ?? state.runtime.sessionInterop ?? "shared";
  state.runtime = {
    ...state.runtime,
    schemaVersion: Math.max(2, state.runtime.schemaVersion ?? 1),
    agents: nextAgents,
    sessionInterop: nextInterop,
  };
  const directories = [];
  for (const [agentId, config] of Object.entries(nextAgents)) {
    directories.push(path.join(state.paths.sessionsRoot, agentId));
    if (config.auth === "project") directories.push(path.join(state.paths.localRoot, agentId));
  }
  for (const directory of directories) await mkdir(directory, { recursive: true });
  const configChanged = await writeJsonIfChanged(state.paths.runtimeFile, state.runtime);
  const gitignoreChanged = Object.keys(nextAgents).length > 0
    ? await ensureRuntimeGitignore(projectRoot)
    : false;
  return { ...state, configChanged, gitignoreChanged, config: projectConfig(state) };
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
  return canonicalSessionId;
}

export async function initializeAgent(projectRoot, agentId, authMode, sessionsMode) {
  getAgent(agentId);
  if (authMode) {
    validateAuthMode(authMode);
  }
  if (sessionsMode) {
    validateSessionsMode(sessionsMode);
  }
  const state = await loadRuntime(projectRoot);
  const previous = state.runtime.agents?.[agentId] ?? {};
  const effectiveAuthMode = authMode ?? previous.auth ?? "global";
  const effectiveSessionsMode = sessionsMode ?? previous.sessions ?? "project";
  const sessionDirectory = path.join(state.paths.sessionsRoot, agentId);
  const localDirectory = path.join(state.paths.localRoot, agentId);
  const missingStructure = [sessionDirectory];
  if (effectiveAuthMode === "project") {
    missingStructure.push(localDirectory);
  }
  const structureRepaired = missingStructure.some((directory) => !existsSync(directory));
  for (const directory of missingStructure) {
    await mkdir(directory, { recursive: true });
  }
  const draft = projectConfig(state);
  draft.agents[agentId] = { auth: effectiveAuthMode, sessions: effectiveSessionsMode };
  const configured = await configureProject(projectRoot, draft);
  return {
    ...configured,
    authMode: effectiveAuthMode,
    sessionsMode: effectiveSessionsMode,
    configChanged: configured.configChanged,
    gitignoreChanged: configured.gitignoreChanged,
    structureRepaired,
  };
}

// Environment overrides that scope an agent's credentials and configuration to
// the project (stored under .agents/local/, which is always gitignored).
export function projectAuthEnvironment(agentId, projectRoot) {
  getAgent(agentId);
  const localRoot = runtimePaths(projectRoot).localRoot;
  switch (agentId) {
    case "claude":
      return { CLAUDE_CONFIG_DIR: path.join(localRoot, "claude") };
    case "codex":
      return { CODEX_HOME: path.join(localRoot, "codex") };
    case "opencode":
      return { XDG_CONFIG_HOME: path.join(localRoot, "opencode") };
    default:
      throw new Error(`Unknown Agent: ${agentId}`);
  }
}

export async function deinitializeAgent(projectRoot, agentId, options = {}) {
  const agent = getAgent(agentId);
  const state = await loadRuntime(projectRoot);
  if (!state.runtime.agents?.[agentId]) {
    const sessionDirectory = path.join(state.paths.sessionsRoot, agentId);
    const localDirectory = path.join(state.paths.localRoot, agentId);
    const purged = Boolean(options.purge && (existsSync(sessionDirectory) || existsSync(localDirectory)));
    if (options.purge) {
      await rm(sessionDirectory, { recursive: true, force: true });
      await rm(localDirectory, { recursive: true, force: true });
      if (Object.keys(state.runtime.agents ?? {}).length === 0) {
        await removeRuntimeGitignore(projectRoot, { sessions: true });
      }
    }
    return {
      agent,
      changed: purged,
      purged,
      remaining: Object.keys(state.runtime.agents ?? {}).length,
    };
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
  if (options.purge) {
    await rm(path.join(state.paths.localRoot, agentId), { recursive: true, force: true });
    await rm(path.join(state.paths.sessionsRoot, agentId), { recursive: true, force: true });
  }
  const remaining = Object.keys(state.runtime.agents).length;
  if (remaining === 0) {
    if (options.purge) {
      await rm(state.paths.localRoot, { recursive: true, force: true });
      await rm(path.join(projectRoot, ".agents", "tmp"), { recursive: true, force: true });
    }
    await removeRuntimeGitignore(projectRoot, { sessions: Boolean(options.purge) });
  }
  return {
    agent,
    changed: true,
    purged: Boolean(options.purge),
    remaining,
  };
}

export async function setLocalAuth(projectRoot, agentId, authMode) {
  const agent = getAgent(agentId);
  validateAuthMode(authMode);
  const state = await loadRuntime(projectRoot);
  if (!state.runtime.agents?.[agentId]?.enabled) {
    throw new Error(`${agent.displayName} is not initialized`);
  }
  state.local.schemaVersion ??= 1;
  state.local.agents ??= {};
  state.local.agents[agentId] = {
    ...(state.local.agents[agentId] ?? {}),
    auth: authMode,
  };
  await mkdir(state.paths.localRoot, { recursive: true });
  if (authMode === "project") {
    await mkdir(path.join(state.paths.localRoot, agentId), { recursive: true });
  }
  await writeJsonIfChanged(state.paths.localRuntimeFile, state.local);
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

export function effectiveAgentConfig(state, agentId) {
  const configured = state.runtime.agents?.[agentId];
  const override = state.local.agents?.[agentId];
  if (!configured) {
    return null;
  }
  return {
    ...configured,
    ...override,
    configuredAuth: configured.auth ?? "global",
    localAuth: override?.auth ?? null,
  };
}

// Shared status shape for CLI and VS Code. Auth and session storage are
// intentionally independent dimensions; callers can switch either one.
export async function getAgentRuntimeMode(projectRoot, agentId) {
  const state = await loadRuntime(projectRoot);
  const effective = effectiveAgentConfig(state, agentId);
  if (!effective) return null;
  return {
    auth: {
      default: effective.configuredAuth,
      localOverride: effective.localAuth,
      effective: effective.auth,
    },
    sessions: { mode: effective.sessions ?? "project" },
  };
}
