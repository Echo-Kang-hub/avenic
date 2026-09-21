import {
  appendCanonicalEvents,
  canonicalSessionRevision,
  createCanonicalSession,
  findCanonicalSessionForNative,
  readCanonicalSession,
  readCanonicalSessionRecord,
  syncNativeMapping,
  upgradeCanonicalSessionTitle,
} from "./canonical-sessions.mjs";
import { sessionTitleFor } from "./session-title.mjs";
import { getSessionAdapter } from "./adapters/index.mjs";
import { agentCursors, canonicalCursors, loadCursors, sameStamp, saveCursors, stampOf } from "./cursors.mjs";
import { buildHandoff } from "./handoff.mjs";
import { timed } from "./timing.mjs";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  agentHomeRoot,
  agentSessionsRoot,
  configureProject,
  effectiveAgentConfig,
  loadRuntime,
  projectConfig,
  runtimePaths,
  setActiveCanonicalSession,
  validateHistoryMode,
} from "./config.mjs";
import { apiRelative, removeApiConfiguration } from "./api-config.mjs";
import { agentRuntimeEnvironment, effectiveAgentEnvironment } from "./agent-runtime.mjs";
import { getAgent } from "./agents.mjs";
import {
  acquireSessionLease,
  isConversationFile,
  listFiles,
  markLaunchFinished,
  releaseSessionLease,
  sessionLeasePath,
} from "./sessions.mjs";

/**
 * The agents whose authentication method a draft changes: the answers that
 * *replace* one another, as opposed to answers that merely arrive. Only these
 * leave something behind, so only these are ever asked about — and only these
 * are ever released. `stored` is what the project said before the run
 * (`projectDraft` copies it in), so comparing the two is what tells the
 * difference.
 */
export function methodSwitches(draft) {
  const switched = [];
  for (const agentId of draft?.selected ?? []) {
    const stored = draft.stored?.[agentId] ?? {};
    const next = draft.agents?.[agentId] ?? {};
    const before = stored.authMethod ?? null;
    const after = next.authMethod ?? null;
    if (!before || !after) continue;
    // A change of method, and a move of *where* an API configuration is
    // written: both leave the previous one standing, and only the answer that
    // replaced it can say so. The scope is part of an API answer — the global
    // one is live for every project on the machine — so an API answer that
    // moved scopes is asked about like a method that changed. An account that
    // moved scopes is not: a home is the agent's own sign-in, and the release
    // for it deletes nothing.
    const movedScope = before === "api" && after === "api"
      && (stored.configScope ?? "global") !== (next.configScope ?? "global");
    if (before !== after || movedScope) switched.push({ agentId, before, after });
  }
  return switched;
}

/**
 * The switches a "Remove" could actually act on: the ones whose previous answer
 * was an API configuration, which is the only thing Avenic can show it wrote.
 * A project account home is a sign-in the agent performed, so a host asks the
 * destructive question only when this is non-empty — a confirmation for a
 * deletion that is never going to happen teaches users to click through them.
 */
function deletableSwitches(draft) {
  return methodSwitches(draft).filter(({ agentId }) => draft.stored?.[agentId]?.authMethod === "api");
}

/**
 * What that removal would name, in the words every host uses: the agent, and
 * the file the previous configuration lives in. One formatter, so a terminal
 * confirmation and an editor modal cannot name different files for the same
 * answer — and so the question itself can be drawn from the step list rather
 * than asked again inside a write, where a cancel can no longer reach it.
 */
export function removalTargets(draft) {
  return deletableSwitches(draft).map(({ agentId }) => ({
    agentId,
    name: getAgent(agentId).displayName,
    relative: apiRelative(agentId, draft.stored?.[agentId]?.configScope ?? "global"),
  }));
}

function canonicalRevision(stored) {
  return stored.session.revision
    ?? canonicalSessionRevision(stored.events);
}

// The one capture primitive for foreground exits, crash watchdogs and startup
// recovery. Canonical event identity makes repeated captures idempotent, so no
// second inventory/cache layer or background polling is required.
export async function observeSharedNativeSessions(projectRoot, agentId, options = {}) {
  const adapter = getSessionAdapter(agentId);
  const captured = await timed("observe.capture", () => adapter.capture(projectRoot, options));
  const mode = projectConfig(await loadRuntime(projectRoot)).historyMode;
  const imported = mode === "shared"
    ? await timed("observe.import", () => importProjectSessions(projectRoot, agentId, { ...options, skipCapture: true, setActive: options.setActive }))
    : { imported: 0, diagnostics: [] };
  return { changed: Boolean(captured.changed || imported.imported), imported: imported.imported ?? 0, diagnostics: [...(captured.diagnostics ?? []), ...(imported.diagnostics ?? [])] };
}

export async function recoverSharedNativeSessions(projectRoot, agentIds, options = {}) {
  const results = [];
  for (const agentId of agentIds) {
    try {
      // The home this agent's runs write to, from the project's own answer: a
      // caller hands the base environment it was given (or nothing), and the
      // capture still reads the same root the launch used.
      const supplied = typeof options.environmentForAgent === "function" ? options.environmentForAgent(agentId) : options.environment;
      const environment = await effectiveAgentEnvironment(projectRoot, agentId, supplied);
      results.push({ agentId, ...(await observeSharedNativeSessions(projectRoot, agentId, { environment })) });
    } catch (error) {
      results.push({ agentId, changed: false, diagnostic: error.message });
    }
  }
  return results;
}

// One launch group, three hosts: the CLI's foreground launch, the detached
// watchdog that finishes an interrupted one, and the VS Code extension's
// terminal. They all need the same sequence — the first member snapshots the
// agent's native storage, the last member to leave restores it — and the same
// two safety rules: a recovering group salvages the run it inherited *before*
// snapshotting, so the dead run's sessions are not recorded as pre-launch
// state, and a snapshot is replayed only when it completed, because writing a
// half-copied tree back over the user's storage would destroy it. Hosts own
// when a launch happens; they do not own these rules.
function launchGroup(projectRoot, agentId, environment) {
  const adapter = getSessionAdapter(agentId);
  const { snapshotNative, revertNative } = adapter;
  if (typeof snapshotNative !== "function" || typeof revertNative !== "function") {
    // An agent whose history is owned by its own CLI (OpenCode) has no native
    // tree to isolate: it is captured, never snapshotted.
    return null;
  }
  const stateDir = sessionLeasePath(agentId, projectRoot);
  const snapshotRoot = path.join(stateDir, "snapshot");
  return {
    hooks: {
      onFirst: async (recovering) => {
        if (recovering) {
          // The run that died wrote its session where this project's sessions
          // already live, and the cursors know those directories. Asking the
          // adapter to rediscover them would read the head of every session on
          // the machine before the user's next launch could start — the
          // capture falls back to a full discovery on its own when nothing is
          // known yet, which is the only case that needs one.
          await timed("recovery.observe", () => observeSharedNativeSessions(projectRoot, agentId, { environment, knownOnly: true, setActive: false }));
          await timed("recovery.revert", () => revertNative(snapshotRoot, projectRoot, { environment }));
        }
        await timed("recovery.snapshot", () => snapshotNative(projectRoot, snapshotRoot, { environment }));
      },
      // `acquireSessionLease` writes the marker once onFirst returns, so its
      // absence means the copy never finished.
      onLast: async () => {
        if (existsSync(path.join(stateDir, "snapshot.ok"))) {
          await revertNative(snapshotRoot, projectRoot, { environment });
        }
      },
    },
  };
}

/**
 * Join the launch group for one project+agent, or return null when the agent's
 * storage is not isolated for the run. Membership is a member id to leave with
 * plus, for hosts that never leave early, the same membership as a function.
 */
export async function joinLaunchGroup(projectRoot, agentId, options = {}) {
  const environment = options.environment ?? process.env;
  const group = launchGroup(projectRoot, agentId, environment);
  if (!group) return null;
  const lease = await acquireSessionLease(agentId, projectRoot, group.hooks);
  return { member: lease.member, release: lease.release };
}

/**
 * The opening sequence of a project-scoped launch, written once for every host:
 * join the project+agent launch group, then hand the agent the project's
 * session records. From here the launch ends with `finishLaunch`, which leaves
 * the group through the same member id. A host adds only what is its own — the
 * durability watch, the child process or terminal, the wording of "not
 * initialized" — so the CLI and the extension cannot drift on the order of
 * these steps or on which one releases the group when the restore fails.
 * `skipRestore` is for `avenic <agent> sessions continue`: that run reads
 * native storage itself, so the project's records must not overwrite it.
 * `member` is null for agents whose storage the official CLI owns (opencode)
 * and for global-scope launches, which join nothing.
 */
export async function beginLaunch(projectRoot, agentId, options = {}) {
  const environment = options.environment ?? process.env;
  const portable = options.config?.sessionScope === "project";
  const group = portable ? await joinLaunchGroup(projectRoot, agentId, { environment }) : null;
  if (portable && !options.skipRestore) {
    // Project session records take priority on launch: conflicting native
    // copies are overwritten silently. Native storage is never written to
    // proactively; only `avenic <agent> sessions writeback` writes project
    // records back to native storage.
    try {
      await getSessionAdapter(agentId).restore(projectRoot, { environment });
    } catch (error) {
      // Leaving the group reverts native storage when this was the only
      // launch in it.
      if (group) {
        try {
          await group.release();
        } catch {}
      }
      throw error;
    }
  }
  return { portable, member: group?.member ?? null };
}

/**
 * The exit sequence for a launch: capture what the run produced, then leave the
 * group (the last member restores native storage). A host that started a
 * durability watch removes its state here too. `beforeRevert` runs while the
 * native tree still holds what the run left, which is what a continuation
 * reader needs; everything else belongs after the group is gone.
 */
export async function finishLaunch(projectRoot, agentId, options = {}) {
  const environment = options.environment ?? process.env;
  try {
    const captured = await observeSharedNativeSessions(projectRoot, agentId, {
      environment,
      setActive: options.setActive ?? true,
    });
    if (typeof options.beforeRevert === "function") await options.beforeRevert({ environment, projectRoot });
    return captured;
  } finally {
    if (options.member) {
      await releaseSessionLease(agentId, projectRoot, options.member, launchGroup(projectRoot, agentId, environment)?.hooks ?? {});
      // The exit sequence reached its end. A watch that outlives this process
      // reads that as "nothing left to finish" instead of recovering a launch
      // that already finished recovering itself.
      try {
        markLaunchFinished(agentId, projectRoot, options.member);
      } catch {}
    } else {
      // A host with no launch group still owns the watch state the launch
      // created, and nothing else removes it.
      await rm(sessionLeasePath(agentId, projectRoot), { recursive: true, force: true });
    }
  }
}

/**
 * Where a native session's events belong.
 *
 * The mapping is the authority and the cursor is its constant-time copy: a
 * conversation that joined a shared session keeps appending to it. Only a
 * native session that has never been part of one becomes a canonical session of
 * its own, named after the native conversation it came from.
 */
async function canonicalSessionFor(projectRoot, agentId, nativeSessionId, cursors) {
  const index = canonicalCursors(cursors, agentId);
  if (index[nativeSessionId]) return index[nativeSessionId];
  const existing = await findCanonicalSessionForNative(projectRoot, agentId, nativeSessionId);
  const canonicalId = existing ?? `${agentId}-${nativeSessionId}`;
  index[nativeSessionId] = canonicalId;
  return canonicalId;
}

async function mergeCapturedEvents(projectRoot, canonicalSessionId, captured) {
  if (!captured?.events) return { added: 0, duplicate: 0 };
  return appendCanonicalEvents(projectRoot, canonicalSessionId, captured.events);
}

// One import path for CLI and VS Code: native -> portable cache -> canonical.
// A portable file that has not moved since its last successful import is not
// read at all; only genuine native deltas cost a parse.
export async function importProjectSessions(projectRoot, agentId, options = {}) {
  const adapter = getSessionAdapter(agentId);
  const portable = agentSessionsRoot(projectRoot, agentId);
  const ownsCursors = options.cursors === undefined;
  // The import reads the home the agent's runs wrote to, resolved from the
  // project's own answer instead of trusted from the caller: `avenic sessions
  // sync` hands this process's environment, and for Account · Project the
  // machine's home is a different tree holding a different person's runs.
  const environment = await effectiveAgentEnvironment(projectRoot, agentId, options.environment);
  const cursors = options.cursors ?? loadCursors(projectRoot, environment);
  const files = agentCursors(cursors, agentId);
  const captured = options.skipCapture
    ? { count: 0, changed: false, diagnostics: [] }
    : await adapter.capture(projectRoot, { ...options, environment, cursors });
  let discovered = 0; let imported = 0; let unchanged = 0; let skipped = 0; let failed = 0; let selected = 0;
  const diagnostics = [...(captured.diagnostics ?? [])];
  // Files some pass imported while it was not allowed to select them (the
  // durability watch, startup recovery, `sessions sync`) still owe a
  // selection. Without one, a clean launch whose final bytes the watch
  // happened to import first never becomes the active conversation — the exit
  // pass finds the very stamp the watch recorded and skips the file — and the
  // next launch silently starts a new conversation instead of continuing it.
  const pending = [];
  for (const relative of await listFiles(portable)) {
    if (!isConversationFile(relative)) continue;
    const absolute = path.join(portable, relative);
    const bookmark = files[relative];
    // The bookmark records the portable file as it was when it was last
    // imported, which is deliberately not the same stamp the capture just
    // refreshed: a capture that copied new bytes must still be imported.
    const stamp = await stampOf(absolute);
    if (bookmark?.canonicalId && bookmark.imported === true && sameStamp(bookmark.importedStamp, stamp)) {
      discovered += 1;
      skipped += 1;
      unchanged += 1;
      if (bookmark.pending === true) pending.push({ relative, canonicalId: bookmark.canonicalId, at: stamp?.mtimeMs ?? 0 });
      continue;
    }
    let native;
    try { native = adapter.toCanonical(await readFile(absolute, "utf8")); }
    catch (error) {
      failed += 1;
      diagnostics.push({ agentId, file: relative, kind: "unreadable-session", message: error.message });
      continue;
    }
    if (!native?.nativeSessionId || native.nativeSessionId === "unknown") {
      failed += 1;
      diagnostics.push({ agentId, file: relative, kind: "unidentified-session" });
      continue;
    }
    discovered += 1;
    // Where this conversation already lives, if it lives anywhere: a capture
    // must append to the canonical session a shared launch projected it into,
    // never fork a second conversation holding the same turns.
    const canonicalId = await canonicalSessionFor(projectRoot, agentId, native.nativeSessionId, cursors);
    // What this conversation is called: the name its own store gave it, the
    // first thing the user said, or — for a session that holds nothing yet —
    // the short id a later capture will replace. A session is created with it,
    // and a session an earlier import named after its native id is given it
    // here; anything else keeps the title it has.
    const title = sessionTitleFor({ agentId, nativeSessionId: native.nativeSessionId, nativeTitle: native.title, events: native.events });
    const created = await createCanonicalSession(projectRoot, { id: canonicalId, source: agentId, title });
    const appended = await appendCanonicalEvents(projectRoot, canonicalId, native.events);
    // A conversation created a line ago already carries this title, so only a
    // session that was here before this import can have one to replace.
    if (!created.created) await upgradeCanonicalSessionTitle(projectRoot, canonicalId, title, {
      agentId,
      nativeSessionId: native.nativeSessionId,
      // What this conversation would be called if its own store had no name to
      // give: the first thing the user said. A stored title equal to it was
      // written by an earlier capture, not chosen by anyone, and may be
      // replaced by the name the conversation has now gained.
      derivedTitle: sessionTitleFor({ agentId, nativeSessionId: native.nativeSessionId, nativeTitle: null, events: native.events }),
    });
    await syncNativeMapping(projectRoot, canonicalId, {
      agentId,
      nativeSessionId: native.nativeSessionId,
      nativeRevision: native.revision ?? null,
      // The cursor moves only as far as this capture actually contributed. A
      // re-read of a rollout adds nothing, and writing the rollout's own last
      // event id would walk a target that had already seen the whole history
      // backwards — which is what made a reconciled switch re-project
      // everything the target already had.
      ...(appended.added > 0 ? { lastCanonicalEventId: native.events.at(-1)?.id ?? null } : {}),
    });
    if (options.setActive !== false) {
      await setActiveCanonicalSession(projectRoot, canonicalId);
      selected += 1;
    }
    if (native.diagnostics?.length) diagnostics.push(...native.diagnostics.map((item) => ({ ...item, file: relative })));
    files[relative] = {
      ...bookmark,
      importedStamp: await stampOf(absolute),
      canonicalId,
      nativeSessionId: native.nativeSessionId,
      imported: true,
      pending: options.setActive === false,
    };
    if (created.created || appended.added > 0) imported += 1; else unchanged += 1;
  }
  // The selection the skipped files are owed. A pass that may select decides
  // by the same rule an import always has: the file that moved last is the
  // conversation that counts — for a launch's exit pass, the run that just
  // ended, whatever the watch imported first. Every claim is resolved by this
  // pass either way, so a conversation imported out of order cannot take over
  // a later pass.
  if (options.setActive !== false && pending.length > 0) {
    if (selected === 0) {
      const newest = pending.reduce((best, item) => (item.at >= best.at ? item : best));
      await setActiveCanonicalSession(projectRoot, newest.canonicalId);
    }
    for (const item of pending) files[item.relative].pending = false;
  }
  if (ownsCursors) await saveCursors(projectRoot, cursors, environment);
  return { ...captured, discovered, imported, unchanged, skipped, failed, diagnostics };
}

// Switching policy never rewrites or deletes native history. Moving into
// Shared imports each enabled agent into the canonical workspace by identity;
// unrelated conversations remain separate canonical sessions rather than being
// joined merely because their timestamps are close.
export async function setHistoryMode(projectRoot, mode, options = {}) {
  validateHistoryMode(mode);
  const before = await loadRuntime(projectRoot);
  const previous = projectConfig(before).historyMode;
  // A caller carrying a whole draft (the wizard's commit) writes that draft,
  // so a mode change can never drop the answers that came with it — including
  // the API half, which is written by the same configuration step. A caller
  // that only moves the mode keeps the old shape.
  const configured = await configureProject(projectRoot, options.draft ?? {
    ...(options.agents === undefined ? {} : { agents: options.agents }),
    historyMode: mode,
  }, options);
  if (previous === mode || mode !== "shared") {
    return { previous, mode, imported: [], config: configured.config };
  }
  const imported = [];
  for (const agentId of Object.keys(configured.config.agents)) {
    // Capture reads the environment the agent itself runs in — the same one a
    // launch hands it, resolved from the same answer (`agentRuntimeEnvironment`
    // over the effective config). For Account · Project that is the project's
    // own home; falling back to this process's environment would capture the
    // developer's global root instead of the home the run actually wrote.
    const environment = agentRuntimeEnvironment(
      projectRoot,
      agentId,
      effectiveAgentConfig(configured, agentId),
      options.environmentForAgent?.(agentId) ?? options.environment ?? process.env,
    );
    try {
      imported.push({ agentId, ...(await importProjectSessions(projectRoot, agentId, { environment, setActive: false })) });
    } catch (error) {
      // A single damaged agent cache must not make the mode change destructive
      // or prevent other histories from becoming available in the workspace.
      imported.push({ agentId, failed: true, diagnostics: [error.message] });
    }
  }
  return { previous, mode, imported, config: configured.config };
}

// The single project-settings commit used by every host UI. Keeping this
// decision here prevents CLI and VS Code from drifting on the same-mode path.
export async function applyProjectConfiguration(projectRoot, draft, options = {}) {
  const before = await loadRuntime(projectRoot);
  const previous = projectConfig(before).historyMode;
  if (previous === draft.historyMode) {
    const configured = await configureProject(projectRoot, draft, options);
    return { previous, mode: draft.historyMode, imported: [], config: configured.config };
  }
  // The mode changed, so history still has to be imported — but the rest of
  // the draft is written either way: the mode decides how history is
  // imported, never whether the project's answers reach their files.
  return setHistoryMode(projectRoot, draft.historyMode, { ...options, draft });
}

/**
 * Give back what one agent's previous method left on disk.
 *
 * Only an API configuration can be released: Avenic wrote those keys and the
 * ledger says which ones, so the removal restores the values it displaced and
 * keeps every key the user changed after the fact. A project account home is
 * never released — the sign-in inside it is the agent's own, written by the
 * agent's own login, and nothing in it can be shown to be Avenic's. Which is
 * why the answer names it instead of deleting it.
 */
export async function releasePreviousMethod(projectRoot, agentId, previous, options = {}) {
  if (previous?.authMethod !== "api") {
    // A caller that hands no previous answer gets no method back: naming one
    // would report "an Account was released" about a project that never
    // answered, which is a fact this function would be inventing.
    const method = previous?.authMethod === "account" ? "account" : null;
    const home = method === "account" && previous.accountScope === "project" ? agentHomeRoot(projectRoot, agentId) : null;
    return {
      agentId,
      method,
      relative: null,
      // Project-relative, the way every other surface names it: hosts print the
      // same string the status page and the wizard's descriptions use.
      home: home === null ? null : path.relative(projectRoot, home).split(path.sep).join("/"),
      removed: 0,
      conflicts: 0,
      kept: 0,
      deleted: false,
    };
  }
  const result = await removeApiConfiguration(projectRoot, agentId, previous.configScope ?? "global", {
    environment: options.environment,
    // The home travels with every other option: a caller that redirected where
    // a configuration is written must redirect where it is given back, or a
    // removal reads the developer's own file instead of the fixture's.
    homeDir: options.homeDir,
  });
  return { agentId, method: "api", home: null, ...result };
}


// The service owns mapping updates. Adapters only understand one native format,
// which keeps canonical-to-agent conversion linear as new agents are added.
export async function projectCanonicalSession(projectRoot, canonicalSessionId, agentId, options = {}) {
  const stored = await readCanonicalSession(projectRoot, canonicalSessionId);
  const adapter = getSessionAdapter(agentId);
  if (typeof adapter.writeCanonical !== "function") {
    throw new Error(`${agentId} does not support canonical native projection`);
  }
  const mapping = stored.mappings.projections[agentId];
  const revision = canonicalRevision(stored);
  const result = await adapter.writeCanonical(projectRoot, {
    id: stored.session.id,
    title: stored.session.title,
    events: stored.events,
  }, {
    ...options,
    nativeSessionId: mapping?.nativeSessionId,
    mapping,
    canonicalRevision: revision,
  });
  await syncNativeMapping(projectRoot, canonicalSessionId, {
    agentId,
    nativeSessionId: result.nativeSessionId,
    nativeRevision: result.nativeRevision,
    canonicalRevision: revision,
    diagnostics: result.diagnostics,
  });
  return { ...result, canonicalRevision: revision };
}

/**
 * Make one agent able to answer next.
 *
 * This is the single place that decides what "shared" costs. If the target's
 * mapping already reaches the end of canonical history *and* the agent's
 * projection lives inside its own session (Codex appends to the thread's
 * history; OpenCode imports a session), there is nothing to do and nothing to
 * read beyond the session record. Otherwise the adapter is asked for a
 * projection — a delta, never a replay — and the mapping records how far it got.
 *
 * `materialize` lets a caller supply its own projection (tests, or a host that
 * knows better); otherwise the adapter's own `projectCanonical` is used.
 */
export async function ensureNativeProjection({ projectRoot, canonicalId, targetAgent, environment, intent = "resume-catalog", materialize, force = false }) {
  const adapter = getSessionAdapter(targetAgent);
  const project = materialize ?? (typeof adapter.projectCanonical === "function"
    ? (context, options) => adapter.projectCanonical(projectRoot, context, { ...options, environment })
    : null);
  if (typeof project !== "function") throw new Error(`No ${targetAgent} projection materializer is available`);
  const record = await readCanonicalSessionRecord(projectRoot, canonicalId);
  const existing = record.mappings.projections?.[targetAgent] ?? null;
  const tail = record.session.lastEventId ?? null;
  const durable = adapter.projectionIsDurable !== false;
  // The session a mapping names may not be the one that can be resumed: a Codex
  // sub-agent thread is continued through its parent. An adapter that knows the
  // difference answers here, before anything is read or started, and the
  // mapping keeps naming the session Avenic actually saw.
  const named = existing?.nativeSessionId ?? null;
  const mapped = named && typeof adapter.resolveResumableSession === "function"
    ? await adapter.resolveResumableSession(projectRoot, named, { environment })
    : named;
  // A mapping can outlive the conversation it names — that is a ghost mapping,
  // and resuming one can only fail ("No conversation found with session ID").
  // The adapter answers whether either store still holds it; when it does not,
  // the mapping is dropped and the projection is rebuilt from canonical
  // history, which is the one path that always works. The question is asked of
  // the session the mapping names: a derived resume target (a Codex
  // sub-agent's parent thread) is held exactly when that rollout is.
  const held = !named || typeof adapter.hasProjectCopy !== "function"
    ? true
    : await adapter.hasProjectCopy(projectRoot, named, { environment }).catch(() => true);
  if (!force && mapped && held && durable && existing.lastCanonicalEventId === tail) {
    return { nativeSessionId: mapped, status: "current", mapping: existing, launch: null };
  }
  const stored = await readCanonicalSession(projectRoot, canonicalId);
  const result = await project({ session: stored.session, events: stored.events, mapping: force || !held ? null : existing, intent, projectRoot }, { environment });
  if (!result?.nativeSessionId) throw new Error(`${targetAgent} projection did not return a native session id`);
  const mapping = await syncNativeMapping(projectRoot, canonicalId, {
    agentId: targetAgent,
    nativeSessionId: result.nativeSessionId,
    nativeRevision: result.nativeRevision ?? null,
    canonicalRevision: canonicalRevision(stored),
    projectionHash: result.projection?.hash ?? result.projectionHash ?? null,
    lastCanonicalEventId: result.projection?.lastEventId ?? tail,
    provenance: { kind: result.kind ?? "avenic-projection", intent },
    diagnostics: result.diagnostics ?? [],
  });
  return { ...result, status: result.materialized ? "materialized" : "projected", mapping };
}

export async function captureCanonicalSession(projectRoot, canonicalSessionId, agentId, options = {}) {
  const stored = await readCanonicalSession(projectRoot, canonicalSessionId);
  const adapter = getSessionAdapter(agentId);
  if (typeof adapter.readCanonical !== "function") {
    throw new Error(`${agentId} does not support canonical native capture`);
  }
  const mapping = stored.mappings.projections[agentId];
  if (!mapping?.nativeSessionId) throw new Error(`No ${agentId} native mapping for canonical session ${canonicalSessionId}`);
  const native = await adapter.readCanonical(projectRoot, mapping.nativeSessionId, { ...options, canonicalSessionId });
  const append = await appendCanonicalEvents(projectRoot, canonicalSessionId, native.events);
  const refreshed = await readCanonicalSession(projectRoot, canonicalSessionId);
  await syncNativeMapping(projectRoot, canonicalSessionId, {
    agentId,
    nativeSessionId: native.nativeSessionId,
    nativeRevision: native.revision,
    canonicalRevision: canonicalRevision(refreshed),
    diagnostics: [],
  });
  return { ...append, nativeSessionId: native.nativeSessionId, nativeRevision: native.revision, diagnostics: native.diagnostics ?? [] };
}

// Reconcile every known native projection before a new agent is launched.
// This is deliberately independent of exit hooks: a terminal/VS Code window
// may disappear without giving the previous agent a chance to write back.
export async function reconcileCanonicalSession(projectRoot, canonicalSessionId, options = {}) {
  const stored = await readCanonicalSession(projectRoot, canonicalSessionId);
  const results = [];
  for (const [agentId, mapping] of Object.entries(stored.mappings.projections ?? {})) {
    if (!mapping?.nativeSessionId) continue;
    const supplied = typeof options.environmentForAgent === "function"
      ? options.environmentForAgent(agentId)
      : options.environment;
    // Each projection is read from the home its own agent runs under, resolved
    // here rather than trusted from the caller.
    const environment = await effectiveAgentEnvironment(projectRoot, agentId, supplied);
    try {
      const captured = await captureCanonicalSession(projectRoot, canonicalSessionId, agentId, { environment });
      results.push({ agentId, ...captured });
    } catch (error) {
      results.push({
        agentId,
        stale: /native session is unavailable|session is unavailable|not found|does not exist/i.test(error?.message ?? ""),
        nativeSessionId: mapping.nativeSessionId,
        diagnostic: error.message,
      });
    }
  }
  return results;
}

/**
 * Prepare one agent to continue the shared conversation.
 *
 * The preferred answer is a projection: the agent's own session receives the
 * turns it is missing, and the user is handed nothing. Only when an agent
 * cannot take a projection at all does this fall back to a handoff prompt —
 * and that fallback is written to disk as well, so what the user saw is
 * inspectable after the fact.
 *
 * Prepare is intentionally auth-agnostic. The CLI/runtime resolves the exact
 * environment it normally uses for an agent, then supplies it only to native
 * capture/launch hooks. This prevents session sharing from altering providers
 * or credential scopes.
 */
/**
 * How a projection is opened.
 *
 * A projection that prepared a native session names its own launch. One that
 * found the target already current has no launch of its own — the adapter's
 * resume command is the launch, which is the whole point of asking first, and
 * costs nothing but two small reads.
 */
function projectionLaunch(adapter, projected) {
  if (Array.isArray(projected?.launch?.argumentsList) && projected.launch.argumentsList.length > 0) {
    return projected.launch;
  }
  if (projected?.status === "current" && typeof adapter.resumeArguments === "function") {
    return { argumentsList: adapter.resumeArguments(projected.nativeSessionId) };
  }
  return null;
}

// A plain launch never resumes. This module used to expose a
// `prepareSharedLaunch` that a launch called to continue the active shared
// conversation by prepending the agent's resume arguments; it was the source
// of the 1.8.3 P0 — `avenic claude` silently resumed whatever conversation
// happened to be active, and a mapping whose native session had been reverted
// turned into `claude --resume <gone-id>` ("No conversation found with session
// ID …"). Continuing is `prepareCanonicalContinuation`, reached only from the
// explicit `avenic sessions continue` path.

export async function prepareCanonicalContinuation(projectRoot, canonicalSessionId, agentId, options = {}) {
  const adapter = getSessionAdapter(agentId);
  const record = await readCanonicalSessionRecord(projectRoot, canonicalSessionId);
  const mapping = record.mappings.projections?.[agentId] ?? null;
  // `handoff` is the last resort: this target has already refused a projected
  // native session, so the handoff opens a fresh one and carries the history
  // itself. Dropping the mapping is part of that — resuming the session that
  // just failed would fail again.
  const force = Boolean(options.forceBootstrap || options.handoff);
  let projected = null;
  let failure = null;
  if (!options.handoff) {
    try {
      projected = await ensureNativeProjection({
        projectRoot,
        canonicalId: canonicalSessionId,
        targetAgent: agentId,
        environment: options.environment,
        intent: options.intent ?? "sessions-continue",
        materialize: options.materialize,
        force: Boolean(options.forceBootstrap),
      });
    } catch (error) {
      failure = error;
    }
  }
  const launch = projectionLaunch(adapter, projected);
  if (launch) {
    // A projection that built the native session just now is a bootstrap; one
    // that continued an existing session is a resume. Either way the projection
    // decided how it opens, and the user is handed nothing.
    return {
      canonicalSessionId,
      agentId,
      kind: projected.kind,
      mode: projected.status === "current" ? "resume" : projected.materialized ? "bootstrap" : "resume",
      nativeSessionId: projected.nativeSessionId,
      launch,
      projection: projected.projection ?? null,
      mapping: projected.mapping,
      status: projected.status,
      canonicalRevision: record.session.revision ?? null,
    };
  }
  // No projection was possible: fall back to a bounded, structured handoff.
  const stored = await readCanonicalSession(projectRoot, canonicalSessionId);
  const mapped = force ? null : mapping?.nativeSessionId ?? null;
  // A fallback with no mapping still has to name a session for an agent whose
  // launch requires one; the id it will create is the same one a projection
  // would have used.
  const nativeSessionId = mapped
    ?? (typeof adapter.nativeSessionIdFor === "function" ? adapter.nativeSessionIdFor(canonicalSessionId) : null);
  const handoff = buildHandoff({
    session: stored.session,
    events: stored.events,
    targetAgent: agentId,
    lastCanonicalEventId: force ? null : mapping?.lastCanonicalEventId ?? null,
  });
  const handoffRoot = path.join(runtimePaths(projectRoot).sessionsRoot, "canonical", canonicalSessionId);
  await mkdir(handoffRoot, { recursive: true });
  await writeFile(path.join(handoffRoot, "handoff.json"), `${JSON.stringify(handoff, null, 2)}\n`, "utf8");
  await writeFile(path.join(handoffRoot, "handoff.md"), `${handoff.markdown}\n`, "utf8");
  return {
    canonicalSessionId,
    agentId,
    kind: "handoff-prompt",
    mode: mapped ? "resume" : "bootstrap",
    nativeSessionId,
    handoff,
    failure: failure?.message ?? null,
    mapping,
    canonicalRevision: canonicalRevision(stored),
  };
}

// Commit only after a native process has actually produced/discovered a
// session. The cursor records what the target was shown, so a later resume
// receives only new canonical events.
export async function completeCanonicalContinuation(projectRoot, canonicalSessionId, agentId, result) {
  if (!result || typeof result.nativeSessionId !== "string" || !result.nativeSessionId) {
    throw new Error("Continuation completion requires a native session id");
  }
  const stored = await readCanonicalSession(projectRoot, canonicalSessionId);
  const lastCanonicalEventId = stored.events.at(-1)?.id ?? null;
  return syncNativeMapping(projectRoot, canonicalSessionId, {
    agentId,
    nativeSessionId: result.nativeSessionId,
    nativeRevision: result.nativeRevision ?? null,
    canonicalRevision: canonicalRevision(stored),
    projectionHash: result.projectionHash ?? null,
    lastCanonicalEventId,
    diagnostics: result.diagnostics ?? [],
  });
}

// The only continuation orchestration path. Callers provide the native hooks;
// adapters remain responsible only for their native format and launch command.
// `capture` may return null when no mapped native session exists yet.
export async function continueCanonicalSession({ projectRoot, canonicalId, targetAgent, captureKnown, capture, launch, environment, materialize, forceBootstrap: requestedBootstrap = false }) {
  if (typeof capture !== "function" || typeof launch !== "function") {
    throw new Error("Canonical continuation requires capture and launch hooks");
  }
  // The projection this opens and the read-back that follows must land in the
  // home the target's runs use — Account · Project's own, not the caller's.
  environment = await effectiveAgentEnvironment(projectRoot, targetAgent, environment);
  if (captureKnown) await captureKnown();
  let forceBootstrap = Boolean(requestedBootstrap);
  let recoveredProjection = false;
  try {
    await mergeCapturedEvents(projectRoot, canonicalId, await capture("before"));
  } catch (error) {
    if (!/native session is unavailable/i.test(error?.message)) throw error;
    forceBootstrap = true;
    recoveredProjection = true;
  }
  const continuation = await prepareCanonicalContinuation(projectRoot, canonicalId, targetAgent, {
    environment,
    materialize,
    forceBootstrap,
  });
  const launched = await launch(continuation);
  const captured = await capture("after", { continuation, launched });
  await mergeCapturedEvents(projectRoot, canonicalId, captured);
  const mapping = await completeCanonicalContinuation(projectRoot, canonicalId, targetAgent, {
    ...launched,
    nativeSessionId: captured?.nativeSessionId ?? launched?.nativeSessionId,
    nativeRevision: captured?.nativeRevision ?? launched?.nativeRevision,
  });
  return {
    continuation,
    launched,
    captured,
    mapping,
    diagnostics: recoveredProjection
      ? [`Previous ${targetAgent} session was unavailable; restored from shared Avenic history.`]
      : [],
  };
}

/**
 * How one continuation is launched.
 *
 * A projection knows how it must be opened — resume the agent's own session,
 * resume the native session the projection just built, or open a fresh one —
 * and its argument list is used verbatim. The prompt path below survives only
 * for an agent with no projection at all, where a single bounded handoff
 * message is the honest remaining option.
 */
export function continuationLaunchArguments(continuation = {}) {
  const { agentId, mode, nativeSessionId, handoff, launch } = continuation;
  if (Array.isArray(launch?.argumentsList) && launch.argumentsList.length > 0) {
    return { argumentsList: [...launch.argumentsList], input: launch.input };
  }
  if (!handoff?.markdown) throw new Error("Continuation launch requires a projection or a handoff");
  // npm-style Windows .cmd shims pass command lines through cmd.exe. A newline
  // terminates that command even inside a quoted argument, so keep the
  // model-visible handoff a single argument on every platform. Canonical
  // history is untrusted input, so neutralize cmd metacharacters here only;
  // the stored handoff remains lossless.
  const replacements = { "&": " and ", "|": " / ", "^": "", "<": "‹", ">": "›", "(": "[", ")": "]", "%": "％", "!": "！", "\"": "'" };
  const prompt = handoff.markdown
    .replace(/\r?\n+/g, " ")
    .replace(/[&|^<>()%!\"]/g, (character) => replacements[character])
    .replace(/\s{2,}/g, " ")
    .trim();
  const launchers = {
    claude: () => {
      if (!nativeSessionId) throw new Error("Claude continuation requires a session id");
      return mode === "resume"
        ? ["--resume", nativeSessionId, prompt]
        : ["--session-id", nativeSessionId, prompt];
    },
    // The foreground command must remain the official interactive TUI. Handoff
    // is an initial prompt argument; stdin/stdout stay attached to the user.
    codex: () => mode === "resume"
      ? ["resume", nativeSessionId, prompt]
      : [prompt],
    // OpenCode names the conversation with a flag and takes the handoff as a
    // prompt. A bootstrap continuation is a fresh official session that opens
    // with the canonical delta, which is also the way back from a projected
    // session OpenCode refuses to start.
    opencode: () => mode === "resume" && nativeSessionId
      ? ["--session", nativeSessionId, "--prompt", prompt]
      : ["--prompt", prompt],
  };
  const createArguments = launchers[agentId];
  if (!createArguments) throw new Error(`No semantic continuation launcher for ${agentId}`);
  return { argumentsList: createArguments(), input: undefined };
}
