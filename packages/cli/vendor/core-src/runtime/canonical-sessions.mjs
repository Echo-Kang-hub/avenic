import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { runtimePaths } from "./config.mjs";
import { deriveState } from "./handoff.mjs";
import { CONVERSATION_ROLES } from "./adapters/canonical.mjs";

export const CANONICAL_SESSION_SCHEMA_VERSION = 1;
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
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(temporary, value, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, file);
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
  return { id, created: true };
}

export async function readCanonicalSession(projectRoot, id) {
  const directory = sessionDirectory(projectRoot, id);
  const session = await readJson(path.join(directory, "session.json"), null);
  if (!session) throw new Error(`Unknown canonical session: ${id}`);
  if (session.schemaVersion !== CANONICAL_SESSION_SCHEMA_VERSION) throw new Error(`Unsupported canonical session schema: ${session.schemaVersion}`);
  const eventsText = existsSync(path.join(directory, "events.jsonl")) ? await readFile(path.join(directory, "events.jsonl"), "utf8") : "";
  const events = eventsText.split(/\r?\n/).filter(Boolean).map((line) => normalizeEvent(JSON.parse(line)));
  const state = await readJson(path.join(directory, "state.json"), session.state ?? deriveState(events));
  return { session: { ...session, state }, events, state, mappings: await readJson(path.join(directory, "mappings.json"), { schemaVersion: 1, canonicalSessionId: id, projections: {} }) };
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
  return { added: additions.length, duplicate };
}

export async function syncNativeMapping(projectRoot, id, mapping) {
  if (!mapping || typeof mapping !== "object" || !SAFE_ID.test(mapping.agentId ?? "") || typeof mapping.nativeSessionId !== "string") {
    throw new Error("Native mapping requires an agent id and native session id");
  }
  const stored = await readCanonicalSession(projectRoot, id);
  const projections = { ...stored.mappings.projections };
  projections[mapping.agentId] = {
    ...projections[mapping.agentId],
    ...filterSecrets(mapping),
    canonicalSessionId: id,
    lastSyncedAt: now(),
  };
  const result = { schemaVersion: 1, canonicalSessionId: id, projections };
  await writeAtomic(path.join(sessionDirectory(projectRoot, id), "mappings.json"), `${JSON.stringify(result, null, 2)}\n`);
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
    const session = await readJson(path.join(root, entry.name, "session.json"), null);
    if (!session || session.schemaVersion !== CANONICAL_SESSION_SCHEMA_VERSION) continue;
    sessions.push(session);
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
