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

export function sameStamp(left, right) {
  return Boolean(left && right && left.size === right.size && left.mtimeMs === right.mtimeMs);
}

export function agentCursors(cursors, agentId) {
  cursors.agents[agentId] ??= { files: {}, heads: {} };
  cursors.agents[agentId].files ??= {};
  cursors.agents[agentId].heads ??= {};
  return cursors.agents[agentId].files;
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
