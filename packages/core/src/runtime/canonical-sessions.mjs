import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "./atomic-file.mjs";
import { runtimePaths } from "./config.mjs";
import { refreshStateStamp } from "./sessions.mjs";

import { deriveState } from "./handoff.mjs";
import { CONVERSATION_ROLES } from "./adapters/canonical.mjs";
import { collapseWhitespace, isAutoTitle, mappedNativeSessionIds, resolveSessionTitle } from "./session-title.mjs";

const CANONICAL_SESSION_SCHEMA_VERSION = 1;
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const SECRET_KEY = /(?:api[_-]?key|authorization|auth(?:entication)?|cookie|credential|password|secret|token)/i;

function now() {
  return new Date().toISOString();
}

function canonicalRoot(projectRoot) {
  return path.join(runtimePaths(projectRoot).sessionsRoot, "canonical");
}

function assertSafeSessionId(id) {
  if (typeof id !== "string" || !SAFE_ID.test(id) || id.includes("..")) {
    throw new Error("Expected a safe session id");
  }
  return id;
}

function sessionDirectory(projectRoot, id) {
  return path.join(canonicalRoot(projectRoot), assertSafeSessionId(id));
}

async function writeAtomic(file, value) {
  return writeFileAtomic(file, value, { mode: 0o600 });
}

async function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  return JSON.parse(await readFile(file, "utf8"));
}

function filterSecrets(value) {
  if (Array.isArray(value)) return value.map(filterSecrets);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !SECRET_KEY.test(key))
    .map(([key, nested]) => [key, filterSecrets(nested)]));
}

function normalizeContent(content) {
  if (!Array.isArray(content)) throw new Error("Canonical event content must be an array");
  return content.map((block) => {
    if (!block || typeof block !== "object" || typeof block.type !== "string") {
      throw new Error("Canonical content blocks require a type");
    }
    return filterSecrets(block);
  });
}

function normalizeEvent(event) {
  if (!event || typeof event !== "object") throw new Error("Canonical event must be an object");
  if (typeof event.id !== "string" || !event.id) throw new Error("Canonical event requires an id");
  if (!CONVERSATION_ROLES.has(event.role)) throw new Error(`Unknown canonical event role: ${event.role}`);
  if (typeof event.createdAt !== "string") throw new Error("Canonical event requires createdAt");
  if (event.parentId !== undefined && typeof event.parentId !== "string") throw new Error("Canonical event parentId must be a string");
  return {
    ...filterSecrets(event),
    content: normalizeContent(event.content),
  };
}

export function canonicalSessionRevision(events) {
  return createHash("sha256").update(events.map((event) => JSON.stringify(event)).join("\n")).digest("hex");
}

export async function createCanonicalSession(projectRoot, input = {}) {
  const id = assertSafeSessionId(input.id ?? randomUUID());
  const directory = sessionDirectory(projectRoot, id);
  const sessionFile = path.join(directory, "session.json");
  if (existsSync(sessionFile)) return { id, created: false };
  const timestamp = now();
  const session = {
    schemaVersion: CANONICAL_SESSION_SCHEMA_VERSION,
    id,
    title: typeof input.title === "string" ? input.title : null,
    project: { cwd: path.resolve(projectRoot) },
    source: typeof input.source === "string" ? input.source : null,
    createdAt: timestamp,
    updatedAt: timestamp,
    metadata: filterSecrets(input.metadata ?? {}),
    provenance: filterSecrets(input.provenance ?? {}),
    state: {
      schemaVersion: 1,
      goal: null,
      currentTask: null,
      completed: [],
      pending: null,
      decisions: [],
      relevantFiles: [],
      blockers: [],
      warnings: [],
    },
  };
  await mkdir(path.join(directory, "attachments"), { recursive: true });
  await writeAtomic(sessionFile, `${JSON.stringify(session, null, 2)}\n`);
  await writeAtomic(path.join(directory, "events.jsonl"), "");
  await writeAtomic(path.join(directory, "state.json"), `${JSON.stringify(session.state, null, 2)}\n`);
  await writeAtomic(path.join(directory, "mappings.json"), `${JSON.stringify({ schemaVersion: 1, canonicalSessionId: id, projections: {} }, null, 2)}\n`);
  // A conversation arrived: the count in the state stamp moves with it.
  await refreshStateStamp(projectRoot);
  return { id, created: true };
}

// Everything about a session except its events: the session record and the
// native mappings. A switch asks "is the target already current?" far more
// often than it asks for history, and that question must not open a multi-
// megabyte event log.
export async function readCanonicalSessionRecord(projectRoot, id) {
  const directory = sessionDirectory(projectRoot, id);
  const session = await readJson(path.join(directory, "session.json"), null);
  if (!session) throw new Error(`Unknown canonical session: ${id}`);
  if (session.schemaVersion !== CANONICAL_SESSION_SCHEMA_VERSION) throw new Error(`Unsupported canonical session schema: ${session.schemaVersion}`);
  const mappings = await readJson(path.join(directory, "mappings.json"), { schemaVersion: 1, canonicalSessionId: id, projections: {} });
  // The title a reader is handed is the one to show, and it is never an id.
  // Naming a session after its first turn would mean opening the event log this
  // read exists to avoid, so a session whose file still carries an id-derived
  // title is shown under a short id until the next import gives it the real one.
  return { session: displaySession(session, mappings), mappings };
}

// What the record says the session is called, in the words a host renders.
function displaySession(session, mappings, events = []) {
  return { ...session, title: resolveSessionTitle(session, events, { nativeSessionIds: mappedNativeSessionIds(mappings) }) };
}

export async function readCanonicalSession(projectRoot, id) {
  const directory = sessionDirectory(projectRoot, id);
  const { session, mappings } = await readCanonicalSessionRecord(projectRoot, id);
  const eventsText = existsSync(path.join(directory, "events.jsonl")) ? await readFile(path.join(directory, "events.jsonl"), "utf8") : "";
  const events = eventsText.split(/\r?\n/).filter(Boolean).map((line) => normalizeEvent(JSON.parse(line)));
  const state = await readJson(path.join(directory, "state.json"), session.state ?? deriveState(events));
  // The events are in hand here, so a title that had to wait for them — the
  // first thing the user said — is available without anything being written.
  return { session: { ...displaySession(session, mappings, events), state }, events, state, mappings };
}

/**
 * Give a session the title its own store says it has.
 *
 * Import is the only caller, and the rules it relies on live here rather than
 * in it: a title is replaced only when the stored one is derived from an id (or
 * absent), a title someone chose is left alone, and a title that is already
 * right is not written at all — the session file must come out of a repeated
 * import byte for byte as it was, which is what the comparison is for.
 *
 * `updatedAt` is deliberately not moved. A title is not history: a session that
 * jumped to the top of a dashboard because its name was filled in would be
 * lying about when it last ran.
 */
export async function upgradeCanonicalSessionTitle(projectRoot, id, title, options = {}) {
  const wanted = typeof title === "string" ? title.trim() : "";
  if (!wanted) return { updated: false, title: null };
  // The stored title is read as bytes, not as the display title: what may be
  // replaced is what the file says, and what may be written is what it does not
  // already hold.
  const file = path.join(sessionDirectory(projectRoot, id), "session.json");
  const session = await readJson(file, null);
  if (!session) throw new Error(`Unknown canonical session: ${id}`);
  if (session.schemaVersion !== CANONICAL_SESSION_SCHEMA_VERSION) throw new Error(`Unsupported canonical session schema: ${session.schemaVersion}`);
  const current = typeof session.title === "string" ? session.title : "";
  if (current.trim() === wanted) return { updated: false, title: wanted };
  const nativeSessionIds = [options.nativeSessionId, ...(options.nativeSessionIds ?? [])].filter((value) => typeof value === "string" && value);
  // A title derived from the first turn is machine-made, exactly like one
  // derived from an id: every capture names a session with `sessionTitleFor`,
  // which falls back to what the user said first, and nothing was chosen. Only
  // the exact string an unnamed capture would have written is replaceable —
  // anything else is somebody's title, and a rename is not an import's to undo.
  // Without this, a session named by an early capture could never take the name
  // its own store gained later: the user renamed the conversation in the agent,
  // and the dashboard kept showing the first sentence forever.
  const derived = collapseWhitespace(options.derivedTitle ?? "");
  if (!isAutoTitle(current, options.agentId ?? session.source ?? null, nativeSessionIds) && !(derived && collapseWhitespace(current) === derived)) {
    return { updated: false, title: null, reason: "explicit" };
  }
  await writeAtomic(file, `${JSON.stringify({ ...session, title: wanted }, null, 2)}\n`);
  return { updated: true, title: wanted };
}

export async function appendCanonicalEvents(projectRoot, id, inputEvents) {
  if (!Array.isArray(inputEvents)) throw new Error("Canonical events must be an array");
  const stored = await readCanonicalSession(projectRoot, id);
  const known = new Set(stored.events.map((event) => event.id));
  const additions = [];
  let duplicate = 0;
  for (const raw of inputEvents) {
    const event = normalizeEvent(raw);
    if (known.has(event.id)) {
      duplicate += 1;
    } else {
      known.add(event.id);
      additions.push(event);
    }
  }
  if (additions.length === 0) return { added: 0, duplicate };
  const directory = sessionDirectory(projectRoot, id);
  const allEvents = [...stored.events, ...additions];
  await writeAtomic(path.join(directory, "events.jsonl"), `${allEvents.map((event) => JSON.stringify(event)).join("\n")}\n`);
  const state = deriveState(allEvents);
  await writeAtomic(path.join(directory, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
  const session = {
    ...stored.session,
    state,
    updatedAt: now(),
    revision: canonicalSessionRevision(allEvents),
    // Written next to the events for the readers that only need to say how
    // much history there is and where it ends. Sizing a canonical session by
    // reading its event log is what made a status on a real project open tens
    // of megabytes; the log is the only place these two numbers can be known
    // exactly, and this is the write that just had them in hand.
    eventCount: allEvents.length,
    lastEventId: allEvents.at(-1)?.id ?? null,
  };
  await writeAtomic(path.join(directory, "session.json"), `${JSON.stringify(session, null, 2)}\n`);
  // The conversation grew: a watcher re-reads this one instead of the store.
  await refreshStateStamp(projectRoot, { grew: additions.length });
  return { added: additions.length, duplicate };
}

export async function syncNativeMapping(projectRoot, id, mapping) {
  if (!mapping || typeof mapping !== "object" || !SAFE_ID.test(mapping.agentId ?? "") || typeof mapping.nativeSessionId !== "string") {
    throw new Error("Native mapping requires an agent id and native session id");
  }
  const stored = await readCanonicalSessionRecord(projectRoot, id);
  const projections = { ...stored.mappings.projections };
  projections[mapping.agentId] = {
    ...projections[mapping.agentId],
    ...filterSecrets(mapping),
    canonicalSessionId: id,
    lastSyncedAt: now(),
  };
  const result = { schemaVersion: 1, canonicalSessionId: id, projections };
  await writeAtomic(path.join(sessionDirectory(projectRoot, id), "mappings.json"), `${JSON.stringify(result, null, 2)}\n`);
  // Who took part in a conversation is part of what the dashboard lists, so a
  // mapping move is a change worth waking for.
  await refreshStateStamp(projectRoot);
  return result.projections[mapping.agentId];
}

export async function listCanonicalSessions(projectRoot) {
  const root = canonicalRoot(projectRoot);
  if (!existsSync(root)) return [];
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(root, { withFileTypes: true });
  const sessions = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !SAFE_ID.test(entry.name)) continue;
    try { sessions.push((await readCanonicalSession(projectRoot, entry.name)).session); } catch { /* ignore incomplete untrusted entries */ }
  }
  return sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

/**
 * The canonical session a native conversation already belongs to, or null.
 *
 * The mapping is the authority: a native session that was projected into a
 * shared conversation has to keep appending to that conversation when it is
 * captured, not fork a second canonical session that happens to hold the same
 * turns. The scan is one small read per canonical session and is asked once per
 * native session per process.
 */
export async function findCanonicalSessionForNative(projectRoot, agentId, nativeSessionId) {
  if (typeof nativeSessionId !== "string" || !nativeSessionId) return null;
  const root = canonicalRoot(projectRoot);
  if (!existsSync(root)) return null;
  const { readdir } = await import("node:fs/promises");
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !SAFE_ID.test(entry.name)) continue;
    // Same rule as the list: a mappings file that cannot be read is not this
    // session's answer, and it is certainly not an error that hides every other
    // session's answer. Capture asks this question on the way out of a run.
    const mappings = await readJson(path.join(root, entry.name, "mappings.json"), null).catch(() => null);
    if (mappings?.projections?.[agentId]?.nativeSessionId === nativeSessionId) return entry.name;
  }
  return null;
}

/**
 * The canonical session records without their event logs. A host that has to
 * list or summarise shared history reads this: the records are small, while an
 * event log is the whole conversation and can be tens of megabytes.
 */
export async function listCanonicalSessionRecords(projectRoot) {
  const root = canonicalRoot(projectRoot);
  if (!existsSync(root)) return [];
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(root, { withFileTypes: true });
  const sessions = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !SAFE_ID.test(entry.name)) continue;
    // A record that cannot be read costs its own session and nothing else. This
    // read used to throw out of the loop, so one unparseable file made the list
    // show no shared history at all — the same failure shape the sibling list
    // above has guarded each entry against since it was written.
    let session = null;
    try {
      session = await readJson(path.join(root, entry.name, "session.json"), null);
    } catch {
      continue;
    }
    if (!session || session.schemaVersion !== CANONICAL_SESSION_SCHEMA_VERSION) continue;
    // The record is all this read opens, so the title it reports is the one a
    // record can prove: an imported session whose file still carries the id an
    // old import named it after is shown as a short id rather than as nothing.
    // The event log stays unopened — a list of fifty conversations must not
    // cost fifty conversations' worth of reading.
    sessions.push(displaySession(session, null));
  }
  return sessions.sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""));
}

/**
 * How many events a canonical session holds, for a record written before the
 * count was stored beside them. One pass, no parse; the next append replaces
 * this with the stored number.
 */
export async function countCanonicalEvents(projectRoot, id) {
  const file = path.join(sessionDirectory(projectRoot, id), "events.jsonl");
  if (!existsSync(file)) return 0;
  const content = await readFile(file, "utf8");
  let lines = content.length > 0 ? 1 : 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) lines += content.charCodeAt(index + 1) === undefined ? 0 : 1;
  }
  return lines;
}
