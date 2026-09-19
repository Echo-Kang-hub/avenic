import { appendCanonicalEvents, canonicalSessionRevision, readCanonicalSession, syncNativeMapping } from "./canonical-sessions.mjs";
import { createCanonicalSession } from "./canonical-sessions.mjs";
import { getSessionAdapter } from "./adapters/index.mjs";
import { agentCursors, loadCursors, sameStamp, saveCursors, stampOf } from "./cursors.mjs";
import { buildHandoff } from "./handoff.mjs";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  agentSessionsRoot,
  configureProject,
  effectiveAgentConfig,
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
  const captured = await adapter.capture(projectRoot, options);
  const mode = projectConfig(await loadRuntime(projectRoot)).sessionInterop;
  const imported = mode === "shared"
    ? await importProjectSessions(projectRoot, agentId, { ...options, skipCapture: true, setActive: options.setActive })
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
          await observeSharedNativeSessions(projectRoot, agentId, { environment, setActive: false });
          await revertNative(snapshotRoot, projectRoot, { environment });
        }
        await snapshotNative(projectRoot, snapshotRoot, { environment });
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
    const canonicalId = `${agentId}-${native.nativeSessionId}`;
    const created = await createCanonicalSession(projectRoot, { id: canonicalId, source: agentId, title: `${agentId} ${native.nativeSessionId}` });
    const appended = await appendCanonicalEvents(projectRoot, canonicalId, native.events);
    await syncNativeMapping(projectRoot, canonicalId, {
      agentId,
      nativeSessionId: native.nativeSessionId,
      nativeRevision: native.revision ?? null,
      lastCanonicalEventId: native.events.at(-1)?.id ?? null,
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

// Prepare one native projection for a resume catalog without selecting it in
// the foreground UI. The caller supplies the agent's official bootstrap hook;
// this function owns identity, cursor, and idempotency.
export async function ensureNativeProjection({ projectRoot, canonicalId, targetAgent, environment, intent = "resume-catalog", materialize }) {
  const stored = await readCanonicalSession(projectRoot, canonicalId);
  const existing = stored.mappings.projections[targetAgent];
  const tail = stored.events.at(-1)?.id ?? null;
  if (existing?.nativeSessionId && existing.lastCanonicalEventId === tail) {
    return { nativeSessionId: existing.nativeSessionId, status: "current", mapping: existing };
  }
  if (existing?.nativeSessionId && intent === "resume-catalog" && !materialize) {
    return { nativeSessionId: existing.nativeSessionId, status: "stale", mapping: existing };
  }
  if (typeof materialize !== "function") throw new Error(`No ${targetAgent} projection materializer is available`);
  const result = await materialize({ session: stored.session, events: stored.events, mapping: existing ?? null, intent });
  if (!result?.nativeSessionId) throw new Error(`${targetAgent} projection did not return a native session id`);
  const mapping = await syncNativeMapping(projectRoot, canonicalId, {
    agentId: targetAgent,
    nativeSessionId: result.nativeSessionId,
    nativeRevision: result.nativeRevision ?? null,
    canonicalRevision: canonicalRevision(stored),
    projectionHash: result.projectionHash ?? null,
    lastCanonicalEventId: tail,
    provenance: { kind: "avenic-projection", intent },
    diagnostics: result.diagnostics ?? [],
  });
  return { nativeSessionId: result.nativeSessionId, status: existing ? "refreshed" : "created", mapping };
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

// Prepare is intentionally auth-agnostic. The CLI/runtime resolves the exact
// environment it normally uses for an agent, then supplies it only to native
// capture/launch hooks. This prevents session sharing from altering providers
// or credential scopes.
export async function prepareCanonicalContinuation(projectRoot, canonicalSessionId, agentId, options = {}) {
  const stored = await readCanonicalSession(projectRoot, canonicalSessionId);
  const mapping = stored.mappings.projections[agentId] ?? null;
  const adapter = getSessionAdapter(agentId);
  const mappedNativeSessionId = options.forceBootstrap ? null : mapping?.nativeSessionId ?? null;
  const nativeSessionId = mappedNativeSessionId && typeof adapter.resolveResumableSession === "function"
    ? await adapter.resolveResumableSession(projectRoot, mappedNativeSessionId, options)
    : mappedNativeSessionId;
  const handoff = buildHandoff({
    session: stored.session,
    events: stored.events,
    targetAgent: agentId,
    lastCanonicalEventId: options.forceBootstrap ? null : mapping?.lastCanonicalEventId ?? null,
  });
  const handoffRoot = path.join(runtimePaths(projectRoot).sessionsRoot, "canonical", canonicalSessionId);
  await mkdir(handoffRoot, { recursive: true });
  await writeFile(path.join(handoffRoot, "handoff.json"), `${JSON.stringify(handoff, null, 2)}\n`, "utf8");
  await writeFile(path.join(handoffRoot, "handoff.md"), `${handoff.markdown}\n`, "utf8");
  return {
    canonicalSessionId,
    agentId,
    mode: nativeSessionId ? "resume" : "bootstrap",
    nativeSessionId,
    mapping,
    handoff,
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
export async function continueCanonicalSession({ projectRoot, canonicalId, targetAgent, captureKnown, capture, launch, environment, forceBootstrap: requestedBootstrap = false }) {
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
  const continuation = await prepareCanonicalContinuation(projectRoot, canonicalId, targetAgent, { environment, forceBootstrap });
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

// These are documented public CLI paths, not native storage projections.
// Handoff remains visible to the user/model as an explicit continuation prompt.
export function continuationLaunchArguments({ agentId, mode, nativeSessionId, handoff }) {
  if (!handoff?.markdown) throw new Error("Continuation launch requires a handoff");
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
