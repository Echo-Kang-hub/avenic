import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { agentSessionsRoot } from "../config.mjs";
import { environmentHome } from "../environment.mjs";
import { agentCursors, cachedFileHead, loadCursors, saveCursors } from "../cursors.mjs";
import {
  hashContent,
  listFiles,
  projectRootTransform,
  readFirstJsonLine,
  restoreInto,
  revertFrom,
  samePath,
  snapshotInto,
  syncDirectory,
} from "../sessions.mjs";
import {
  canonicalBlocks,
  eventTimestamp,
  isConversationRole,
  nativeEventId,
  parseJsonLines,
} from "./canonical.mjs";
import { isInjectedRecord, isRefusedInjection, openCodexAppServer, startCodexThread, injectCodexItems } from "../codex-app-server.mjs";
import { buildProjection, projectionItems, NATIVE_BUDGET, PROJECTION_KIND } from "../projection.mjs";

export const agentId = "codex";

// Reasoning records carry provider-encrypted blobs, and agent_message records
// are Codex's own multi-agent chatter; neither is part of the conversation the
// user had, so neither belongs in the shared history.
const TOOL_RECORDS = new Set(["function_call", "custom_tool_call", "function_call_output", "custom_tool_call_output"]);

// Codex's own client writes the plugin list, the environment and the
// instruction files into a thread as `role: "user"` records, ahead of anything
// the user typed. `internal_chat_message_metadata_passthrough` says what each
// item is, and the user's own text is the only thing marked `user.text` (older
// builds) or `unknown` (0.154.0). A record that carries kinds and none of them
// is the user's text is the client talking to the model, not the user talking
// to the agent: capturing it would put words in the user's mouth, show them in
// the viewer as "You", and hand them to the next agent through the projection.
const USER_TEXT_KINDS = new Set(["user.text", "unknown"]);

function isClientContextRecord(record) {
  const kinds = record?.payload?.internal_chat_message_metadata_passthrough?.content_item_kinds;
  return Array.isArray(kinds) && kinds.length > 0 && !kinds.some((kind) => USER_TEXT_KINDS.has(kind));
}

export function toCanonical(content, options = {}) {
  const records = parseJsonLines(content, agentId);
  const meta = records.find((record) => record.type === "session_meta");
  const nativeSessionId = options.nativeSessionId ?? meta?.payload?.id ?? meta?.payload?.session_id ?? "unknown";
  const events = records.flatMap((record, index) => {
    if (record.type !== "response_item") return [];
    const payload = record.payload;
    // Avenic's own projection is written into the rollout by Codex itself; a
    // capture must not read it back as work the agent did. Codex's own client
    // context is the same kind of thing: it is not something the user said.
    if (isInjectedRecord(record) || isClientContextRecord(record)) return [];
    const isTool = TOOL_RECORDS.has(payload?.type);
    if (payload?.type !== "message" && !isTool) return [];
    const role = isTool ? "tool" : payload.role;
    if (!isConversationRole(role)) return [];
    const attached = isTool
      ? [{ type: payload.type, name: payload.name, input: payload.input ?? payload.arguments, output: payload.output }]
      : payload.content;
    const blocks = canonicalBlocks(attached);
    if (blocks.length === 0) return [];
    return [{
      id: nativeEventId(agentId, nativeSessionId, payload.id, index, record),
      agent: agentId,
      role,
      createdAt: eventTimestamp(record.timestamp),
      content: blocks,
      model: payload.model,
      provider: meta?.payload?.model_provider,
      extensions: { codex: { record, payload } },
    }];
  });
  return { nativeSessionId, events, revision: options.revision ?? null };
}

/**
 * The interactive command that opens one Codex thread. A mapping that is
 * already current needs nothing else, which is what keeps a switch with no new
 * history from starting an app server at all.
 */
export function resumeArguments(nativeSessionId) {
  return ["resume", nativeSessionId];
}

/**
 * Give a Codex thread the turns it does not have yet.
 *
 * This is the native path, not a briefing: the turns are appended to the
 * thread's own model-visible history through the app server's documented
 * `thread/inject_items`, so the next turn continues the shared conversation
 * instead of reading a summary of it. `codex resume <id>` then opens it as an
 * ordinary session.
 *
 * The delta rule is the whole point of the mapping, and it has two halves:
 * turns the target authored in the thread it is resuming are left out, and so
 * is every turn the mapping already carried into it. So the tenth switch costs
 * the tenth delta, not the whole conversation — and, just as important, the
 * thread is not handed a second copy of what it has already read.
 */
export async function projectCanonical(projectRoot, { session, events, mapping = null, intent = "resume" }, options = {}) {
  const stored = mapping?.nativeSessionId ?? null;
  // A v2 sub-agent thread cannot be resumed on its own; the parent is the
  // thread that continues it. The mapping keeps naming the session Avenic saw,
  // and both are excluded from the delta: the target already produced those
  // turns either way.
  const resolved = stored ? await resolveResumableSession(projectRoot, stored, options) : null;
  const mapped = resolved && await holdsRefusedInjection(projectRoot, resolved, options) ? null : resolved;
  const owned = [...new Set([stored, mapped].filter(Boolean))];
  // What the thread being resumed already holds. The mapping records the last
  // canonical event it was given, so everything up to it — the turns Avenic
  // injected and the turns the thread wrote itself — is already in its
  // model-visible history. A resume therefore starts after it; sending the
  // conversation again would append a second copy of it to the thread.
  const since = mapping?.lastCanonicalEventId ?? null;
  const project = (nativeSessionIds, sinceEventId = null) => buildProjection({
    session,
    events,
    targetAgent: agentId,
    nativeSessionId: nativeSessionIds,
    sinceEventId,
    budget: NATIVE_BUDGET,
  });
  if (mapped) {
    const current = project(owned, since);
    if (current.turns.length === 0) {
      // Nothing new since the last switch: the thread is already up to date and
      // no server has to be started at all.
      return {
        kind: PROJECTION_KIND.native,
        nativeSessionId: mapped,
        injected: 0,
        materialized: false,
        projection: current,
        launch: { argumentsList: ["resume", mapped] },
      };
    }
  }
  const client = await openCodexAppServer({ command: options.command, cwd: projectRoot, environment: options.environment, spawn: options.spawn });
  try {
    let threadId = mapped;
    let materialized = false;
    if (threadId) {
      try {
        await client.call("thread/resume", { threadId });
      } catch {
        // The mapping points at a thread that is gone. Canonical history is
        // unaffected; the target is rehydrated from it below.
        threadId = null;
      }
    }
    if (!threadId) {
      threadId = await startCodexThread(client, projectRoot);
      materialized = true;
    }
    // A thread that was just created holds nothing, so its projection is the
    // whole conversation; a resumed one only receives what it is missing.
    const projection = materialized ? project(null) : project(owned, since);
    const injected = projection.turns.length
      ? await injectCodexItems(client, threadId, projectionItems(projection))
      : 0;
    return {
      kind: PROJECTION_KIND.native,
      nativeSessionId: threadId,
      injected,
      materialized,
      intent,
      projection,
      launch: { argumentsList: ["resume", threadId] },
    };
  } finally {
    await client.close();
  }
}

// A thread that already holds a turn with an id the provider refuses cannot be
// sent another one: every request over it is rejected before the model sees it,
// and appending cannot repair the ids already in its history. Such a thread is
// not resumable — canonical history rebuilds it, and the rollout Avenic stops
// using is left where Codex put it. This is one read of the same rollout the
// capture on this path reads anyway, and only when a mapping exists.
async function holdsRefusedInjection(projectRoot, nativeSessionId, options) {
  const { nativeSessions } = locations(projectRoot, options.environment);
  const match = (await matchingRollouts(nativeSessions, projectRoot)).find((item) => item.id === nativeSessionId);
  if (!match) return false;
  const content = await readFile(path.join(nativeSessions, match.relative), "utf8");
  return parseJsonLines(content, agentId).some((record) => isRefusedInjection(record));
}

// Reads one mapped rollout. No private files are written by the continuation
// layer; this is capture-only and uses the caller's existing CODEX_HOME.
export async function readCanonical(projectRoot, nativeSessionId, options = {}) {
  const { nativeSessions } = locations(projectRoot, options.environment);
  const match = (await matchingRollouts(nativeSessions, projectRoot)).find((item) => item.id === nativeSessionId);
  if (match) {
    const content = await readFile(path.join(nativeSessions, match.relative), "utf8");
    const parsed = toCanonical(content);
    return { ...parsed, revision: hashContent(content) };
  }
  throw new Error(`Codex native session is unavailable: ${nativeSessionId}`);
}

// Bootstrap discovery is capture-only: the official Codex CLI created the
// rollout, and we identify the newest rollout for this project afterwards.
export async function discoverNativeSession(projectRoot, options = {}) {
  const { nativeSessions } = locations(projectRoot, options.environment);
  const matches = await matchingRollouts(nativeSessions, projectRoot);
  const candidates = await Promise.all(matches.filter((item) => item.id).map(async (item) => ({
    ...item,
    modified: (await stat(path.join(nativeSessions, item.relative))).mtimeMs,
  })));
  const eligible = options.notBefore === undefined
    ? candidates
    : candidates.filter((item) => item.modified >= options.notBefore);
  eligible.sort((left, right) => right.modified - left.modified || right.relative.localeCompare(left.relative));
  if (!eligible[0]?.id) throw new Error("Codex did not create a discoverable native session after launch");
  return eligible[0].id;
}

// A rollout's identity is its file name, so one thread is found by suffix
// rather than by reading the head of every session on the machine.
async function rolloutMetaById(root, nativeSessionId, cursors) {
  const suffix = `-${nativeSessionId}.jsonl`;
  const basename = `${nativeSessionId}.jsonl`;
  for (const relative of await listFiles(root)) {
    if (!relative.endsWith(suffix) && path.basename(relative) !== basename) continue;
    return rolloutMeta(path.join(root, relative), cursors);
  }
  return null;
}

// Codex multi-agent v2 persists child rollouts with a parent_thread_id, but
// the app-server cannot resume an unloaded child directly. Keep the canonical
// mapping stable while resolving the native resume target to its parent.
//
// This is asked on every shared switch, so it reads the project's own portable
// copies first (their heads are already cached) and only falls back to the
// machine-wide native tree for a thread this project has never captured.
export async function resolveResumableSession(projectRoot, nativeSessionId, options = {}) {
  const { nativeSessions, portable } = locations(projectRoot, options.environment);
  const cursors = options.cursors ?? loadCursors(projectRoot, options.environment);
  const seen = new Set([nativeSessionId]);
  let resumable = nativeSessionId;
  while (true) {
    const meta = await rolloutMetaById(path.join(portable, "sessions"), resumable, cursors)
      ?? await rolloutMetaById(nativeSessions, resumable, cursors);
    const parent = meta?.parentThreadId;
    if (!parent || meta.multiAgentVersion === undefined) return resumable;
    // A corrupt/cyclic native rollout must not hang or change the stored
    // mapping. The official CLI can still give its normal diagnostic.
    if (seen.has(parent)) return nativeSessionId;
    seen.add(parent);
    resumable = parent;
  }
}

// Whether the project still holds a copy of one conversation. The portable
// tree comes first — it is the durable one, and it is project-sized — but a
// rollout the app server created moments ago lives only in native storage
// until the run's exit capture lands, and a mapping naming one of those is a
// conversation the user can still resume. Codex keeps every workspace's
// rollouts in one directory, so a native match only counts when its head says
// it belongs to this project. A mapping whose conversation exists in neither
// store is a ghost, and status must read it as missing rather than current.
export async function hasProjectCopy(projectRoot, nativeSessionId, options = {}) {
  if (!nativeSessionId) return false;
  const { nativeSessions, portable } = locations(projectRoot, options.environment);
  const cursors = options.cursors ?? loadCursors(projectRoot, options.environment);
  // Everything under the project's own sessions root belongs to the project,
  // so a portable match needs no further question.
  if (await rolloutMetaById(path.join(portable, "sessions"), nativeSessionId, cursors)) return true;
  const meta = await rolloutMetaById(nativeSessions, nativeSessionId, cursors);
  return Boolean(meta) && samePath(meta.cwd, projectRoot);
}

function locations(projectRoot, environment = process.env) {
  const codexHome = environment.CODEX_HOME || path.join(environmentHome(environment), ".codex");
  return {
    codexHome,
    nativeSessions: path.join(codexHome, "sessions"),
    portable: agentSessionsRoot(projectRoot, "codex"),
  };
}

// The rollout's identity lives in its first line and never changes while that
// line is intact, so the parsed head is cached against the file's stamp.
function rolloutMeta(file, cursors) {
  return cachedFileHead(cursors, agentId, file, async () => {
    try {
      const first = await readFirstJsonLine(file);
      if (first?.type !== "session_meta") return null;
      return {
        cwd: first.payload?.cwd ?? null,
        id: first.payload?.id ?? first.payload?.session_id ?? null,
        parentThreadId: first.payload?.parent_thread_id,
        multiAgentVersion: first.payload?.multi_agent_version,
      };
    } catch {
      return null;
    }
  });
}

async function matchingRollouts(root, projectRoot, options = {}) {
  // A capture that runs while the agent is working only has to re-read the
  // rollouts this project already matched, which are exactly the ones the
  // cursor store knows. Rediscovering them means opening the head of every
  // Codex session on the machine.
  const candidates = options.knownOnly ? Object.keys(agentCursors(options.cursors, agentId)) : await listFiles(root);
  const matches = [];
  for (const relative of candidates) {
    if (!relative.endsWith(".jsonl")) {
      continue;
    }
    const meta = await rolloutMeta(path.join(root, relative), options.cursors);
    if (meta && samePath(meta.cwd, projectRoot)) {
      matches.push({
        relative,
        id: meta.id,
        parentThreadId: meta.parentThreadId,
        multiAgentVersion: meta.multiAgentVersion,
      });
    }
  }
  return matches;
}

async function filteredIndex(codexHome, ids) {
  const indexFile = path.join(codexHome, "session_index.jsonl");
  if (!existsSync(indexFile)) {
    return "";
  }
  return (await readFile(indexFile, "utf8"))
    .split(/\r?\n/)
    .filter((line) => {
      if (!line.trim()) return false;
      try {
        return ids.has(JSON.parse(line).id);
      } catch {
        return false;
      }
    })
    .join("\n");
}

export async function capture(projectRoot, options = {}) {
  const { codexHome, nativeSessions, portable } = locations(projectRoot, options.environment);
  const ownsCursors = options.cursors === undefined;
  const cursors = options.cursors ?? loadCursors(projectRoot, options.environment);
  let rollouts = await matchingRollouts(nativeSessions, projectRoot, { cursors, knownOnly: options.knownOnly });
  if (options.knownOnly && rollouts.length === 0) {
    // Nothing has been captured here yet, so there is no known rollout to watch.
    rollouts = await matchingRollouts(nativeSessions, projectRoot, { cursors });
  }
  if (rollouts.length === 0) {
    if (ownsCursors) await saveCursors(projectRoot, cursors, options.environment);
    return {
      count: 0,
      changed: false,
      // Codex data belonging to other workspaces is not a problem to report.
      diagnostics: existsSync(nativeSessions)
        ? []
        : [{ kind: "missing-root", message: `Codex session root not found: ${nativeSessions}` }],
    };
  }
  const ids = new Set(rollouts.map(({ id }) => id).filter(Boolean));
  const result = await syncDirectory(
    rollouts.map(({ relative }) => ({ relative, source: path.join(nativeSessions, relative) })),
    path.join(portable, "sessions"),
    projectRootTransform(projectRoot, { field: ["payload", "cwd"] }),
    cursors,
    agentId,
  );
  const index = await filteredIndex(codexHome, ids);
  const indexChanged = await writeIndex(path.join(portable, "session_index.jsonl"), index);
  if (ownsCursors) await saveCursors(projectRoot, cursors, options.environment);
  return {
    count: rollouts.length,
    changed: result.added + result.updated + result.removed > 0 || indexChanged,
    diagnostics: [],
  };
}

// The filtered index is derived from native state, so it is rewritten only
// when its content actually moved.
async function writeIndex(file, index) {
  if (!index) {
    if (!existsSync(file)) return false;
    await rm(file, { force: true });
    return true;
  }
  const content = `${index}\n`;
  if (existsSync(file) && (await readFile(file, "utf8")) === content) return false;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, "utf8");
  return true;
}

async function restoreIndex(portable, codexHome) {
  const source = path.join(portable, "session_index.jsonl");
  if (!existsSync(source)) {
    return;
  }
  const destination = path.join(codexHome, "session_index.jsonl");
  const existing = existsSync(destination) ? await readFile(destination, "utf8") : "";
  const existingLines = new Set(existing.split(/\r?\n/).filter(Boolean));
  const additions = (await readFile(source, "utf8")).split(/\r?\n/).filter((line) => line && !existingLines.has(line));
  if (additions.length > 0) {
    await mkdir(codexHome, { recursive: true });
    await appendFile(destination, `${existing && !existing.endsWith("\n") ? "\n" : ""}${additions.join("\n")}\n`, "utf8");
  }
}

export async function restore(projectRoot, options = {}) {
  const { codexHome, nativeSessions, portable } = locations(projectRoot, options.environment);
  const sourceRoot = path.join(portable, "sessions");
  const ownsCursors = options.cursors === undefined;
  const cursors = options.cursors ?? loadCursors(projectRoot, options.environment);
  const result = await restoreInto(sourceRoot, await listFiles(sourceRoot), nativeSessions,
    projectRootTransform(projectRoot, { field: ["payload", "cwd"], restore: true }), { cursors, agentId });
  if (ownsCursors) await saveCursors(projectRoot, cursors, options.environment);
  // The index only lists the rollouts that were written back.
  if (result.count > 0) await restoreIndex(portable, codexHome);
  return result;
}

export async function status(projectRoot) {
  const { portable } = locations(projectRoot);
  return { count: (await listFiles(path.join(portable, "sessions"))).filter((file) => file.endsWith(".jsonl")).length };
}

// Save the native sessions directory and session index into the shared launch
// state so the last exit can restore them: sessions created by `avenic
// codex` must live only in the project, never in the global native storage.
//
// Codex keeps every workspace's rollouts in one directory, so the files this
// launch can change are the ones it hands the agent — the project's own
// history — and the ones the agent writes, which did not exist yet. Copying
// the rest would copy every other workspace on the machine, twice per launch,
// and reverting over them would discard a session running in another project
// at the same time. The snapshot still records the whole tree, so what the run
// adds is still removed; only the content of another workspace's rollout is
// left where it was.
export async function snapshotNative(projectRoot, snapshotRoot, options = {}) {
  const { codexHome, nativeSessions, portable } = locations(projectRoot, options.environment);
  const mine = await listFiles(path.join(portable, "sessions"));
  await snapshotInto(nativeSessions, path.join(snapshotRoot, "sessions"), { only: new Set(mine) });
  await snapshotInto(path.join(codexHome, "session_index.jsonl"), path.join(snapshotRoot, "index.jsonl"));
}

export async function revertNative(snapshotRoot, projectRoot, options = {}) {
  const { codexHome, nativeSessions } = locations(projectRoot, options.environment);
  await revertFrom(path.join(snapshotRoot, "index.jsonl"), path.join(codexHome, "session_index.jsonl"));
  await revertFrom(path.join(snapshotRoot, "sessions"), nativeSessions, { partial: true });
}
