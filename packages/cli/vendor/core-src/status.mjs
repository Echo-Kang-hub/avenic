// One description of a project, for every host that has to show one. The
// terminal renders it as text, the extension renders it as a tree, and
// `--json` is this object unchanged, so the three can never disagree about
// what a project currently looks like.
//
// Everything here is read-only and local: no network, no git fetch, no launch
// reconciliation, and no agent CLI is started. A status that repaired what it
// found would be a status nobody could use to decide whether to repair it, and
// one that waited on a Hub would not be a status.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { countCanonicalEvents, listCanonicalSessionRecords } from "./runtime/canonical-sessions.mjs";
import { getSessionAdapter } from "./runtime/adapters/index.mjs";
import { AGENTS, classifyAgentExecutable, getAgent } from "./runtime/agents.mjs";
import {
  agentSessionsRoot,
  getActiveCanonicalSessionId,
  loadRuntime,
  projectConfig,
  runtimePaths,
} from "./runtime/config.mjs";
import { launchGroupState } from "./runtime/sessions.mjs";
import { catalogCacheDirectory, catalogDisplayName, loadDefaultCatalogSpec, parseCatalogSpec } from "./skills/catalog.mjs";
import { currentRepositoryState } from "./skills/git.mjs";
import { createInstallContext, isCatalogDirectory, skillsInstallationStatus } from "./skills/install.mjs";
import { PROJECT_LOCK_FILE, globalLockFile } from "./skills/paths.mjs";

export const STATUS_SCHEMA_VERSION = 1;

async function readJsonFile(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

// A canonical project's whole history, sized without reading it. `events` and
// `lastEventId` come from the session record when it has them and from one
// pass over the log when it does not, which only the first status after an
// upgrade pays for, and only for the active session.
async function historyOverview(projectRoot, activeSessionId) {
  const sessions = await listCanonicalSessionRecords(projectRoot);
  const active = sessions.find((session) => session.id === activeSessionId) ?? null;
  if (!active) {
    return { sessions: sessions.length, active: null, activeTitle: null, activeEvents: null, activeLastEventId: null, activeUpdatedAt: null, updatedAt: sessions[0]?.updatedAt ?? null };
  }
  const events = Number.isInteger(active.eventCount)
    ? active.eventCount
    : await countCanonicalEvents(projectRoot, active.id);
  return {
    sessions: sessions.length,
    active: active.id,
    activeTitle: active.title ?? null,
    activeEvents: events,
    activeLastEventId: active.lastEventId ?? null,
    activeUpdatedAt: active.updatedAt ?? null,
    updatedAt: sessions[0]?.updatedAt ?? null,
  };
}

// Which native thread an agent's shared history currently points at, and
// whether that projection still matches the canonical events. The mapping
// records the last canonical event it wrote; anything older is a projection
// that would have to be rehydrated before it could carry the conversation.
async function projectionsOf(projectRoot, activeSessionId) {
  if (!activeSessionId) return {};
  const mappings = await readJsonFile(path.join(runtimePaths(projectRoot).sessionsRoot, "canonical", activeSessionId, "mappings.json"));
  const projections = {};
  for (const [agentId, mapping] of Object.entries(mappings?.projections ?? {})) {
    if (!mapping?.nativeSessionId) continue;
    projections[agentId] = {
      nativeSessionId: mapping.nativeSessionId,
      lastSyncedAt: mapping.lastSyncedAt ?? null,
      lastCanonicalEventId: mapping.lastCanonicalEventId ?? null,
    };
  }
  return projections;
}

/**
 * The sync word for one agent, in the order the words stop being true: a live
 * launch owns this agent's history right now, a dead one left it incomplete,
 * an uninitialized agent has nothing to be in sync with, a projection behind
 * its canonical events needs rehydrating, and a conversation the project is
 * supposed to hold but holds nowhere is missing.
 *
 * "Holds nowhere" is asked of the conversation the mapping names, not of the
 * project's session count: a project with fifty healthy sessions and one ghost
 * mapping is not current. That ghost — a mapping whose native and portable
 * copies are both gone — is precisely the state that makes the next resume
 * answer "No conversation found with session ID".
 */
function syncState({ initialized, launchGroup, projection, projectionMissing, lastEventId, sessions }) {
  if (!initialized) return "none";
  if (launchGroup === "running") return "running";
  if (launchGroup === "interrupted") return "dirty";
  if (projection) {
    if (projection.lastCanonicalEventId && lastEventId && projection.lastCanonicalEventId !== lastEventId) return "stale";
    if (projectionMissing || sessions === 0) return "missing";
  }
  return "current";
}

// Whether the conversation the mapping names exists in any of the project's
// stores. Adapters that cannot answer cheaply are left out and the aggregate
// count decides, exactly as before.
async function projectionSessionMissing(projectRoot, agentId, projection, context) {
  if (!projection?.nativeSessionId) return false;
  const adapter = getSessionAdapter(agentId);
  if (typeof adapter.hasProjectCopy !== "function") return false;
  try {
    return !(await adapter.hasProjectCopy(projectRoot, projection.nativeSessionId, { environment: context.environment }));
  } catch {
    // A predicate that cannot answer must not become a health claim.
    return false;
  }
}

async function agentOverview(projectRoot, agentId, context) {
  const agent = getAgent(agentId);
  const configured = context.config.agents[agentId] ?? null;
  const executable = classifyAgentExecutable(agentId, { cwd: projectRoot, environment: context.environment });
  const adapter = getSessionAdapter(agentId);
  const sessions = await adapter.status(projectRoot).then((status) => status.count).catch(() => null);
  const launchGroup = await launchGroupState(agentId, projectRoot);
  const projection = context.projections[agentId] ?? null;
  const projectionMissing = await projectionSessionMissing(projectRoot, agentId, projection, context);
  return {
    id: agentId,
    displayName: agent.displayName,
    command: agent.executable,
    executable: executable.executable,
    available: Boolean(executable.executable),
    installMethod: executable.installMethod,
    initialized: Boolean(configured),
    auth: configured?.auth ?? null,
    sessions: configured?.sessions ?? null,
    history: {
      // Where this agent's copies live, so every host names the same directory.
      directory: agentSessionsRoot(projectRoot, agentId),
      sessions: sessions ?? 0,
      launchGroup,
      projection,
      sync: syncState({
        initialized: Boolean(configured),
        launchGroup,
        projection,
        projectionMissing,
        lastEventId: context.history.activeLastEventId,
        sessions: sessions ?? 0,
      }),
    },
  };
}

async function scopeSkills(projectRoot, environment, global) {
  const scope = global ? "global" : "project";
  let status = null;
  try {
    status = await skillsInstallationStatus(createInstallContext(global, { cwd: projectRoot, environment, migrate: false }));
  } catch {
    // A lock file that cannot be read is reported as such: it is not the same
    // answer as "nothing is installed", and only one of them is actionable.
    return { scope, state: "unreadable", installed: null, packs: [], targets: [] };
  }
  if (!status) return { scope, state: "none", installed: 0, packs: [], targets: [] };
  return {
    scope,
    state: status.state,
    installed: status.names.length,
    // 锁文件里的 Pack 记录带着完整描述（install 时需要）；状态模型只留标识，
    // 渲染器就不必猜「这一项该印哪个字段」——之前直接把对象交给主机，于是终端
    // 上印出了 [object Object]。
    packs: status.packs.map((pack) => ({ id: pack.id, name: pack.name ?? pack.id })),
    // agents 和 complete 是目标本身的事实（谁读这个目录、它是否完整），不是
    // 某个渲染器的排版选择：VS Code 按 agent 拆行，CLI 按目标列一行。
    targets: status.targets.map((target) => ({
      id: target.id,
      label: target.label,
      agents: target.agents ?? [],
      state: target.state,
      complete: target.complete === true,
      present: target.present,
      total: target.total,
    })),
  };
}

// Avenic checks its Hub out detached at FETCH_HEAD, so HEAD holds the revision
// itself and reading it costs one small file. Only a cache someone else left on
// a branch needs git to answer.
async function cacheRevision(directory) {
  const head = (await readFile(path.join(directory, ".git", "HEAD"), "utf8").catch(() => "")).trim();
  if (/^[0-9a-f]{40}$/i.test(head)) return head.toLowerCase();
  return (await currentRepositoryState(directory)).revision ?? null;
}

async function pinnedRevision(projectRoot, environment) {
  const projectLock = await readJsonFile(path.join(projectRoot, PROJECT_LOCK_FILE));
  const globalLock = await readJsonFile(globalLockFile(environment));
  return projectLock?.catalog?.revision ?? globalLock?.catalog?.revision ?? null;
}

// Missing means this machine has no Hub checkout; stale means it has one but
// it is not the revision the lock file says the installed skills came from.
async function hubOverview(projectRoot, environment) {
  const spec = await loadDefaultCatalogSpec(environment);
  const { repository, ref } = parseCatalogSpec(spec);
  const directory = catalogCacheDirectory(spec, environment);
  const present = existsSync(directory) && isCatalogDirectory(directory);
  const revision = present ? await cacheRevision(directory) : null;
  const pinned = await pinnedRevision(projectRoot, environment);
  return {
    configured: true,
    spec,
    name: catalogDisplayName(spec),
    repository,
    ref,
    directory,
    revision,
    pinned,
    cache: !present ? "missing" : pinned && revision && pinned !== revision ? "stale" : "current",
  };
}

/**
 * The status of one project: its configuration, its shared history, one row per
 * agent, and the state of the skills and the Hub. Read-only and never
 * networked, so it is safe to call from a file watch or a render pass.
 */
export async function collectStatus(projectRoot, options = {}) {
  const environment = options.environment ?? process.env;
  const root = path.resolve(projectRoot);
  const state = await loadRuntime(root);
  const config = projectConfig(state);
  const activeSessionId = await getActiveCanonicalSessionId(root);
  const [history, projections, hub, projectSkills, globalSkills] = await Promise.all([
    historyOverview(root, activeSessionId),
    projectionsOf(root, activeSessionId),
    hubOverview(root, environment),
    scopeSkills(root, environment, false),
    scopeSkills(root, environment, true),
  ]);
  const agents = [];
  for (const agentId of Object.keys(AGENTS)) {
    agents.push(await agentOverview(root, agentId, { config, environment, history, projections }));
  }
  return {
    schemaVersion: STATUS_SCHEMA_VERSION,
    project: {
      root,
      name: path.basename(root),
      configured: Object.keys(config.agents).length > 0,
      agents: Object.keys(config.agents),
      historyMode: config.sessionInterop,
    },
    history: {
      ...history,
      mode: config.sessionInterop,
      projections,
    },
    agents,
    skills: { project: projectSkills, global: globalSkills, hub },
  };
}
