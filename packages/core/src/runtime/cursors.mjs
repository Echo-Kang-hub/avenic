import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { stateRoot } from "../skills/paths.mjs";

const SCHEMA_VERSION = 1;

// Cursors describe where this machine's copy of a native history had been read
// up to. They are derived state: losing them costs one full re-read and never
// loses history, so they live in machine state rather than in the project tree
// (a committed cursor would be meaningless on another checkout).
export function cursorFilePath(projectRoot, environment = process.env) {
  const key = createHash("sha256").update(path.resolve(projectRoot)).digest("hex").slice(0, 16);
  return path.join(stateRoot(environment), "runtime", key, "cursors.json");
}

export function emptyCursors() {
  return { schemaVersion: SCHEMA_VERSION, agents: {} };
}

export function loadCursors(projectRoot, environment = process.env) {
  const file = cursorFilePath(projectRoot, environment);
  if (!existsSync(file)) return emptyCursors();
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (parsed?.schemaVersion !== SCHEMA_VERSION || typeof parsed.agents !== "object" || parsed.agents === null) {
      return emptyCursors();
    }
    return parsed;
  } catch {
    // A damaged cursor is a cache miss. It must never fail a capture.
    return emptyCursors();
  }
}

export async function saveCursors(projectRoot, cursors, environment = process.env) {
  const file = cursorFilePath(projectRoot, environment);
  const content = `${JSON.stringify(cursors, null, 2)}\n`;
  if (existsSync(file) && (await readFile(file, "utf8")) === content) return false;
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, file);
  return true;
}

// stat is the only filesystem call the fast path may make per native file:
// no open, no read, no parse.
export async function stampOf(file) {
  try {
    const stats = await stat(file);
    return { size: stats.size, mtimeMs: stats.mtimeMs };
  } catch {
    return null;
  }
}

// A stamp is plain data, and which fields identify a source depends on the
// source: a file is identified by its size and mtime, an agent that only
// exposes a CLI is identified by whatever revision it reports for a session.
// Comparing the fields present keeps one primitive for both.
export function sameStamp(left, right) {
  if (!left || !right) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}

export function agentCursors(cursors, agentId) {
  cursors.agents[agentId] ??= { files: {}, heads: {} };
  cursors.agents[agentId].files ??= {};
  cursors.agents[agentId].heads ??= {};
  return cursors.agents[agentId].files;
}

// Writing the project's sessions back into native storage is a launch step,
// and native storage is put back the way it was when the run ends — so the
// same files are written again and again with the same bytes. A restored file
// is identified by both stamps: the portable copy that was read and the native
// copy that was produced. Deleting or rewriting either side brings the file
// back, so a lost or stale cursor costs one re-render and cannot lose history.
export function restoreStamps(cursors, agentId) {
  cursors.agents[agentId] ??= { files: {}, heads: {} };
  cursors.agents[agentId].restores ??= {};
  return cursors.agents[agentId].restores;
}

// The native directories discovery matched for this project last time. A
// background capture during a run must not re-enumerate an agent's entire
// history root to rediscover them; the full walk belongs to the exit and
// recovery paths.
export function knownDirectories(cursors, agentId) {
  return cursors.agents[agentId]?.directories ?? [];
}

export function rememberDirectories(cursors, agentId, directories) {
  cursors.agents[agentId] ??= { files: {}, heads: {} };
  cursors.agents[agentId].directories = [...directories];
}

// Discovery has to read the first bytes of every session on the machine to
// learn which project it belongs to. That is the most expensive part of a
// launch, and the answer never changes while the file is untouched, so cache
// it against the file's stamp. Heads are keyed by absolute path, separately
// from the per-agent destination state in `files`.
export function rememberHead(cursors, agentId, file, stamp, head) {
  cursors.agents[agentId] ??= { files: {}, heads: {} };
  cursors.agents[agentId].heads ??= {};
  cursors.agents[agentId].heads[file] = { stamp, head };
}

// `undefined` means "not cached"; a stored `null` means "already known to have
// no readable head" and is a hit.
export function cachedHead(cursors, agentId, file, stamp) {
  const entry = cursors.agents[agentId]?.heads?.[file];
  if (!entry || !("head" in entry) || !sameStamp(entry.stamp, stamp)) return undefined;
  return entry.head;
}

// One fact read out of the head of one native file, through the cache above.
// The reader returns the fact, or null when the head holds nothing readable —
// which is a fact too, and is cached as such so an unreadable session is not
// reopened on every later pass. Callers without a cursor store read every time.
export async function cachedFileHead(cursors, agentId, file, read) {
  const stamp = cursors ? await stampOf(file) : null;
  if (cursors && stamp) {
    const cached = cachedHead(cursors, agentId, file, stamp);
    if (cached !== undefined) return cached;
  }
  const head = await read();
  if (cursors && stamp) rememberHead(cursors, agentId, file, stamp, head);
  return head;
}
