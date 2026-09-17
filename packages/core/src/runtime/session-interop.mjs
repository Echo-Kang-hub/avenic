import { appendCanonicalEvents, canonicalSessionRevision, readCanonicalSession, syncNativeMapping } from "./canonical-sessions.mjs";
import { createCanonicalSession } from "./canonical-sessions.mjs";
import { getSessionAdapter } from "./adapters/index.mjs";
import { buildHandoff } from "./handoff.mjs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { runtimePaths, setActiveCanonicalSession } from "./config.mjs";
import { listFiles } from "./sessions.mjs";

function canonicalRevision(stored) {
  return stored.session.revision
    ?? canonicalSessionRevision(stored.events);
}

async function mergeCapturedEvents(projectRoot, canonicalSessionId, captured) {
  if (!captured?.events) return { added: 0, duplicate: 0 };
  return appendCanonicalEvents(projectRoot, canonicalSessionId, captured.events);
}

// One import path for CLI and VS Code: native -> portable cache -> canonical.
export async function importProjectSessions(projectRoot, agentId, options = {}) {
  const adapter = getSessionAdapter(agentId);
  const portable = path.join(runtimePaths(projectRoot).sessionsRoot, agentId);
  const captured = await adapter.capture(projectRoot, options);
  let discovered = 0; let imported = 0; let unchanged = 0; let failed = 0;
  const diagnostics = [...(captured.diagnostics ?? [])];
  for (const relative of await listFiles(portable)) {
    if (!(relative.endsWith(".jsonl") || relative.endsWith(".json"))
      || relative.includes(`${path.sep}subagents${path.sep}`)
      || path.basename(relative) === "session_index.jsonl") continue;
    let native;
    try { native = adapter.toCanonical(await readFile(path.join(portable, relative), "utf8")); }
    catch (error) {
      failed += 1;
      diagnostics.push(`Could not parse ${agentId} session ${relative}: ${error.message}`);
      continue;
    }
    if (!native?.nativeSessionId || native.nativeSessionId === "unknown") {
      failed += 1;
      diagnostics.push(`Could not identify ${agentId} session id in ${relative}.`);
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
    await setActiveCanonicalSession(projectRoot, canonicalId);
    if (created.created || appended.added > 0) imported += 1; else unchanged += 1;
  }
  return { ...captured, discovered, imported, unchanged, failed, diagnostics };
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
  return { ...append, nativeSessionId: native.nativeSessionId, nativeRevision: native.revision };
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
      if (!/native session is unavailable|session is unavailable|not found|does not exist/i.test(error?.message ?? "")) throw error;
      results.push({ agentId, stale: true, nativeSessionId: mapping.nativeSessionId, diagnostic: error.message });
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
  const launchers = {
    claude: () => {
      if (!nativeSessionId) throw new Error("Claude continuation requires a session id");
      return mode === "resume"
        ? ["-p", "--output-format", "json", "--resume", nativeSessionId]
        : ["-p", "--output-format", "json", "--session-id", nativeSessionId];
    },
    // `exec` is the official non-interactive surface and still persists a
    // resumable thread. It works from terminals, VS Code tasks, and CI alike.
    codex: () => mode === "resume"
      ? ["exec", "resume", nativeSessionId, "-"]
      : ["exec", "-"],
  };
  const createArguments = launchers[agentId];
  if (!createArguments) throw new Error(`No semantic continuation launcher for ${agentId}`);
  return { argumentsList: createArguments(), input: handoff.markdown };
}
