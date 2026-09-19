import {
  appendCanonicalEvents,
  canonicalSessionRevision,
  createCanonicalSession,
  findCanonicalSessionForNative,
  readCanonicalSession,
  readCanonicalSessionRecord,
  syncNativeMapping,
} from "./canonical-sessions.mjs";
import { getSessionAdapter } from "./adapters/index.mjs";
import { agentCursors, canonicalCursors, loadCursors, sameStamp, saveCursors, stampOf } from "./cursors.mjs";
import { buildHandoff } from "./handoff.mjs";
import { timed } from "./timing.mjs";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  agentSessionsRoot,
  configureProject,
  effectiveAgentConfig,
  getActiveCanonicalSessionId,
  loadRuntime,
  projectAuthEnvironment,
  projectConfig,
  runtimePaths,
  setActiveCanonicalSession,
  validateSessionInteropMode,
} from "./config.mjs";
import {
  acquireSessionLease,
  isConversationFile,
  listFiles,
  markLaunchFinished,
  releaseSessionLease,
  sessionLeasePath,
} from "./sessions.mjs";

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
  const mode = projectConfig(await loadRuntime(projectRoot)).sessionInterop;
  const imported = mode === "shared"
    ? await timed("observe.import", () => importProjectSessions(projectRoot, agentId, { ...options, skipCapture: true, setActive: options.setActive }))
    : { imported: 0, diagnostics: [] };
  return { changed: Boolean(captured.changed || imported.imported), imported: imported.imported ?? 0, diagnostics: [...(captured.diagnostics ?? []), ...(imported.diagnostics ?? [])] };
}

export async function recoverSharedNativeSessions(projectRoot, agentIds, options = {}) {
  const results = [];
  for (const agentId of agentIds) {
    try {
      results.push({ agentId, ...(await observeSharedNativeSessions(projectRoot, agentId, {
        environment: typeof options.environmentForAgent === "function" ? options.environmentForAgent(agentId) : options.environment,
      })) });
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
  const cursors = options.cursors ?? loadCursors(projectRoot, options.environment);
  const files = agentCursors(cursors, agentId);
  const captured = options.skipCapture
    ? { count: 0, changed: false, diagnostics: [] }
    : await adapter.capture(projectRoot, { ...options, cursors });
  let discovered = 0; let imported = 0; let unchanged = 0; let skipped = 0; let failed = 0;
  const diagnostics = [...(captured.diagnostics ?? [])];
  for (const relative of await listFiles(portable)) {
    if (!isConversationFile(relative)) continue;
    const absolute = path.join(portable, relative);
    const bookmark = files[relative];
    // The bookmark records the portable file as it was when it was last
    // imported, which is deliberately not the same stamp the capture just
    // refreshed: a capture that copied new bytes must still be imported.
    if (bookmark?.canonicalId && bookmark.imported === true && sameStamp(bookmark.importedStamp, await stampOf(absolute))) {
      discovered += 1;
      skipped += 1;
      unchanged += 1;
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
    const created = await createCanonicalSession(projectRoot, { id: canonicalId, source: agentId, title: `${agentId} ${native.nativeSessionId}` });
    const appended = await appendCanonicalEvents(projectRoot, canonicalId, native.events);
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
    if (options.setActive !== false) await setActiveCanonicalSession(projectRoot, canonicalId);
    if (native.diagnostics?.length) diagnostics.push(...native.diagnostics.map((item) => ({ ...item, file: relative })));
    files[relative] = {
      ...bookmark,
      importedStamp: await stampOf(absolute),
      canonicalId,
      nativeSessionId: native.nativeSessionId,
      imported: true,
    };
    if (created.created || appended.added > 0) imported += 1; else unchanged += 1;
  }
  if (ownsCursors) await saveCursors(projectRoot, cursors, options.environment);
  return { ...captured, discovered, imported, unchanged, skipped, failed, diagnostics };
}

// Switching policy never rewrites or deletes native history. Moving into
// Shared imports each enabled agent into the canonical workspace by identity;
// unrelated conversations remain separate canonical sessions rather than being
// joined merely because their timestamps are close.
export async function setSessionInteropMode(projectRoot, mode, options = {}) {
  validateSessionInteropMode(mode);
  const before = await loadRuntime(projectRoot);
  const previous = projectConfig(before).sessionInterop;
  const configured = await configureProject(projectRoot, {
    ...(options.agents === undefined ? {} : { agents: options.agents }),
    sessionInterop: mode,
  });
  if (previous === mode || mode !== "shared") {
    return { previous, mode, imported: [], config: configured.config };
  }
  const imported = [];
  for (const agentId of Object.keys(configured.config.agents)) {
    const agent = effectiveAgentConfig(configured, agentId);
    const environment = options.environmentForAgent?.(agentId) ?? (agent?.auth === "project"
      ? { ...process.env, ...projectAuthEnvironment(agentId, projectRoot) }
      : process.env);
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
  const previous = projectConfig(before).sessionInterop;
  if (previous === draft.sessionInterop) {
    const configured = await configureProject(projectRoot, draft);
    return { previous, mode: draft.sessionInterop, imported: [], config: configured.config };
  }
  return setSessionInteropMode(projectRoot, draft.sessionInterop, {
    agents: draft.agents,
    environmentForAgent: options.environmentForAgent,
  });
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
  const mapped = existing?.nativeSessionId && typeof adapter.resolveResumableSession === "function"
    ? await adapter.resolveResumableSession(projectRoot, existing.nativeSessionId, { environment })
    : existing?.nativeSessionId ?? null;
  if (!force && mapped && durable && existing.lastCanonicalEventId === tail) {
    return { nativeSessionId: mapped, status: "current", mapping: existing, launch: null };
  }
  const stored = await readCanonicalSession(projectRoot, canonicalId);
  const result = await project({ session: stored.session, events: stored.events, mapping: force ? null : existing, intent, projectRoot }, { environment });
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
    const environment = typeof options.environmentForAgent === "function"
      ? options.environmentForAgent(agentId)
      : options.environment;
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

/**
 * What a plain launch needs in order to continue the shared conversation
 * instead of starting a native session of its own.
 *
 * Returns null whenever that is not possible — no shared conversation yet, a
 * projection the target cannot take, a canonical session that was deleted — and
 * the caller launches exactly as it would have. A plain launch never degrades
 * into a prompt: the shared history reaches the agent through the agent's own
 * session, or it is not attached at all.
 */
export async function prepareSharedLaunch({ projectRoot, agentId, environment, activeCanonicalId = null }) {
  const canonicalId = activeCanonicalId ?? await getActiveCanonicalSessionId(projectRoot);
  if (!canonicalId) return null;
  const adapter = getSessionAdapter(agentId);
  if (!adapter) return null;
  try {
    await readCanonicalSessionRecord(projectRoot, canonicalId);
  } catch {
    return null;
  }
  const projected = await ensureNativeProjection({
    projectRoot,
    canonicalId,
    targetAgent: agentId,
    environment,
    intent: "launch",
  });
  const launch = projectionLaunch(adapter, projected);
  return launch ? { canonicalId, ...projected, launch } : null;
}

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
