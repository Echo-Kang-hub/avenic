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
import { accountSignInStatus } from "./runtime/agent-runtime.mjs";
import { accountHome } from "./runtime/agent-home.mjs";
import { LABELS, authenticationValue, historyLabel, scopeLabel, scopedHomeValue, signInLabel } from "./labels.mjs";
import { environmentHome } from "./runtime/environment.mjs";
import { legacyModelConfiguration, modelConfigCandidate, readAccountConfiguration, readModelConfiguration } from "./runtime/model-config.mjs";
import {
  agentSessionsRoot,
  effectiveAgentConfig,
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

// Additive fields do not bump this: a consumer that reads the fields it knows
// keeps working. A removed, renamed or repurposed field does — that is what the
// number is for, and it is the only thing allowed to raise it.
const STATUS_SCHEMA_VERSION = 1;

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

// A directory under the machine's own home reads as `~…`, the way the docs and
// every command hint spell it. Measured against the environment this status was
// read in, never against this process's home: a host can describe another
// machine's environment, and shortening against the wrong home invents a `~`
// that points somewhere else.
function tildify(directory, environment) {
  const machine = environmentHome(environment);
  return directory.startsWith(machine + path.sep) ? `~${directory.slice(machine.length)}` : directory;
}

/**
 * What one agent's authentication answer is, as facts. The two methods answer
 * with different facts, and a host shows the one the method owns: an Account
 * says where its sign-in lives and whether it has happened; an API
 * configuration says which file carries it and what it selects — never the
 * credential itself, only whether one is set.
 *
 * Split out because it is asked twice: by the status page, and by `init`/`change`
 * reporting the configuration it has just written. The two must not be able to
 * describe the same project differently.
 */
async function authFacts(projectRoot, agentId, configured, environment) {
  if (!configured?.authMethod) return null;
  const scope = configured.authMethod === "account" ? configured.accountScope : configured.configScope;
  // The home is the Account's: where the agent's own sign-in lives. It is
  // reported for *both* scopes — the project's relative to the root, the
  // machine's own with `~` — because that is the directory the sign-in state
  // below was just read from, and a `null` there described no file at all.
  // An API configuration names its file instead, so it has no home here.
  const home = configured.authMethod === "account" ? accountHome(projectRoot, agentId, scope, environment) : null;
  // An Account answer is checked against the file an API answer for this
  // project would use: a file that is there while the project runs on its
  // account is not "wrong", it is simply not in effect, and saying which of
  // the two it is beats leaving the user to guess why their edits do nothing.
  const detected = configured.authMethod === "account" ? modelConfigCandidate(projectRoot, agentId, { environment }) : null;
  // 这一份与「现在生效的是哪份」无关，只与「换过地方的那份还在不在」有关 ——
  // Codex 的项目配置换过一次住处，旧的那份属于用户，页面上要能看见。
  const legacy = configured.authMethod === "api" ? legacyModelConfiguration(projectRoot, agentId) : null;
  return {
    method: configured.authMethod,
    scope,
    source: configured.source,
    // Forward-slashed either way: this value is shown to people and to other
    // hosts, and `~\\.claude` on Windows reads like a different directory next
    // to the `~/.claude` in the docs and in every command hint.
    home: home === null ? null
      : (scope === "project" ? path.relative(projectRoot, home) : tildify(home, environment)).split(path.sep).join("/"),
    status: configured.authMethod === "account" ? await accountSignInStatus(agentId, home) : null,
    // What the agent's *own* home says while it runs on its account: read
    // from the agent's file, so a model the agent really uses is reported and
    // nothing is invented for one it does not name.
    account: configured.authMethod === "account" ? await readAccountConfiguration(projectRoot, agentId, scope, { environment }) : null,
    // What the file an API answer points at says — read from the file itself,
    // never from Avenic's records: a provider or a model the user filled in is
    // the configuration in effect whether or not Avenic put the file there.
    configuration: configured.authMethod === "api" ? await readModelConfiguration(projectRoot, agentId, scope, { environment }) : null,
    // Present but not in effect: the project runs on its account while the file
    // an API answer would use is sitting there with content in it.
    detected: detected?.exists ? detected : null,
    // 上一个版本写的那份配置还在不在。升级之后它是用户唯一还能找到旧值的地方，
    // 所以它是这个项目的事实之一，而不是某个渲染器自己补的一句话。
    legacy: legacy?.exists ? legacy : null,
  };
}

/**
 * One agent's card, read straight from the project — the same rows `avenic
 * status` shows and the dashboard draws, for a caller that has one agent to
 * describe rather than a whole project (a command reporting what it just
 * wrote). Nothing here reads the network, the Hub or another agent.
 */
export async function agentCard(projectRoot, agentId, options = {}) {
  const environment = options.environment ?? process.env;
  const agent = getAgent(agentId);
  const configured = options.config ?? effectiveAgentConfig(options.state ?? await loadRuntime(projectRoot), agentId);
  return {
    id: agentId,
    displayName: agent.displayName,
    // OpenCode answers for its own authentication and provider; the one thing
    // Avenic records for it is where its sessions live.
    runtime: agent.managesOwnAuth ? "native" : null,
    auth: await authFacts(projectRoot, agentId, configured, environment),
    sessions: configured?.sessionScope ?? null,
  };
}

async function agentOverview(projectRoot, agentId, context) {
  const agent = getAgent(agentId);
  // The scope this agent actually runs under, local override included: an
  // override leaves the project's configuration saying something else, and a
  // status that reported the project's scope would name a file the launch
  // never reads. One answer, the same one the launcher asks for.
  const configured = effectiveAgentConfig(context.state, agentId);
  const executable = classifyAgentExecutable(agentId, { cwd: projectRoot, environment: context.environment });
  const adapter = getSessionAdapter(agentId);
  const sessions = await adapter.status(projectRoot).then((status) => status.count).catch(() => null);
  const launchGroup = await launchGroupState(agentId, projectRoot);
  const projection = context.projections[agentId] ?? null;
  const projectionMissing = await projectionSessionMissing(projectRoot, agentId, projection, context);
  const auth = await authFacts(projectRoot, agentId, configured, context.environment);
  return {
    id: agentId,
    displayName: agent.displayName,
    command: agent.executable,
    executable: executable.executable,
    available: Boolean(executable.executable),
    installMethod: executable.installMethod,
    initialized: Boolean(configured),
    // OpenCode answers for its own authentication and provider; the one thing
    // Avenic records for it is where its sessions live.
    runtime: agentId === "opencode" ? "native" : null,
    auth,
    sessions: configured?.sessionScope ?? null,
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
 * One agent's card, as rows: the same rows, in the same order, under the same
 * words, whether they are read in a terminal, on the extension's Configure page
 * or on the dashboard card. The vocabulary is labels.mjs, which is the
 * dashboard's, so a host that wants a different word for one of these has to
 * change it for every host at once.
 *
 * `key` is what a host styles by — an icon, a colour, a link. A host must never
 * match on `label`: the label is the user-visible word, and the word is allowed
 * to change without a host breaking.
 *
 * Only facts that exist become rows. A provider, a model or a role key the file
 * does not carry is `null` and gets no row — a row reading "Provider —" would
 * be a claim about a configuration nobody wrote. For the same reason the
 * Account's Model row comes from the agent's own configuration file, which is
 * what actually runs, and never from a guess Avenic made for it.
 */
/**
 * 那份文件现在的处境，接在 Config Source 的路径后面。文件不在、读不出来、在但
 * 还空着，都不是「一份配置」，而这一行是页面上唯一说得出这件事的地方 ——
 * provider 和 model 两行在文件没配好的时候根本不出现，于是「为什么没有它们」
 * 只有这里能回答。文件配好了就不加任何字。
 */
function configurationState(configuration) {
  if (!configuration.exists) return configuration.owned ? " (no longer there)" : " (missing)";
  if (!configuration.valid) return " (cannot be read)";
  return configuration.configured ? "" : " (nothing in it yet)";
}

export function agentCardRows(agent, historyMode) {
  const rows = [];
  const push = (key, label, value) => {
    if (value !== null && value !== undefined && value !== "") rows.push({ key, label, value });
  };
  if (agent.runtime === "native") {
    push("authentication", LABELS.authentication, LABELS.native);
  } else if (!agent.auth) {
    // 没有方法不是「未初始化」的一种说法，而是这一题还没回答 —— 启动时会问。
    push("authentication", LABELS.authentication, LABELS.notChosen);
  } else {
    const auth = agent.auth;
    push("authentication", LABELS.authentication, authenticationValue({ authMethod: auth.method, authScope: auth.scope }));
    if (auth.method === "account") {
      push("accountStatus", LABELS.accountStatus, signInLabel(auth.status));
      // 作用域和承载它的目录一起写：只写目录，读的人还得回头找它属于谁。
      if (auth.home !== null) push("accountScope", LABELS.accountScope, scopedHomeValue(auth.scope, auth.home));
      // 这一行说的是这个账号真正在读的配置，因此它来自 agent 自己的家目录。
      push("model", LABELS.model, auth.account?.model ?? null);
    } else {
      const configuration = auth.configuration ?? {};
      push("configSource", LABELS.configSource, configuration.relative ? `${configuration.relative}${configurationState(configuration)}` : null);
      // 配置好了才谈 provider 和 model：文件在、里面还是空的，等于这一行什么都
      // 没配 —— 面板上要出现一份没人写过的配置，比留白更坏。
      if (configuration.configured) {
        push("provider", LABELS.provider, configuration.provider ?? null);
        push("model", LABELS.model, configuration.model ?? null);
        const settings = configuration.settings ?? {};
        push("opusModel", LABELS.opusModel, settings.opus ?? null);
        push("sonnetModel", LABELS.sonnetModel, settings.sonnet ?? null);
        push("haikuModel", LABELS.haikuModel, settings.haiku ?? null);
        push("subAgentModel", LABELS.subAgentModel, settings.subagent ?? null);
        // effort 存的是小写枚举（medium/max/…）：值本身不动，只有这一行的写法
        // 跟着面板走，两个宿主才不会把同一个值印成两种。
        push("effort", LABELS.defaultEffort, titled(settings.effort));
        push("reasoningEffort", LABELS.reasoningEffort, titled(settings.reasoning));
      }
    }
  }
  push("sessions", LABELS.sessions, agent.sessions ? scopeLabel(agent.sessions) : null);
  push("history", LABELS.history, historyMode ? historyLabel(historyMode) : null);
  return rows;
}

const titled = (value) => (typeof value === "string" && value !== "" ? value.charAt(0).toUpperCase() + value.slice(1) : null);

/**
 * The status of one project: its configuration, its shared history, one row per
 * agent, and the state of the skills and the Hub. Read-only and never
 * networked, so it is safe to call from a file watch or a render pass.
 */export async function collectStatus(projectRoot, options = {}) {
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
    agents.push(await agentOverview(root, agentId, { state, environment, history, projections }));
  }
  return {
    schemaVersion: STATUS_SCHEMA_VERSION,
    project: {
      root,
      name: path.basename(root),
      configured: Object.keys(config.agents).length > 0,
      agents: Object.keys(config.agents),
      historyMode: config.historyMode,
    },
    history: {
      ...history,
      mode: config.historyMode,
      projections,
    },
    agents,
    skills: { project: projectSkills, global: globalSkills, hub },
  };
}
