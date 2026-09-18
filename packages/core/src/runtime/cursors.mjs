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
export function cursorFilePath(projectRoot) {
  const key = createHash("sha256").update(path.resolve(projectRoot)).digest("hex").slice(0, 16);
  return path.join(stateRoot(), "runtime", key, "cursors.json");
}

export function emptyCursors() {
  return { schemaVersion: SCHEMA_VERSION, agents: {} };
}

export function loadCursors(projectRoot) {
  const file = cursorFilePath(projectRoot);
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

export async function saveCursors(projectRoot, cursors) {
  const file = cursorFilePath(projectRoot);
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
  cursors.agents[agentId] ??= { files: {} };
  cursors.agents[agentId].files ??= {};
  return cursors.agents[agentId].files;
}

// Reading the first bytes of every session on the machine to recover its cwd is
// the most expensive part of discovery, and a cwd never changes for a file that
// has not been rewritten. Cache it against the file's stamp.
export function rememberCwd(cursors, agentId, file, stamp, cwd) {
  const files = agentCursors(cursors, agentId);
  files[file] = { ...files[file], cwd, cwdStamp: stamp };
}

export function cachedCwd(cursors, agentId, file, stamp) {
  const entry = cursors.agents[agentId]?.files?.[file];
  if (!entry || entry.cwd == null) return null;
  return sameStamp(entry.cwdStamp, stamp) ? entry.cwd : null;
}
