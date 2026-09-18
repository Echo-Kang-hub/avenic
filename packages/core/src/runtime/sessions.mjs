import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { agentCursors, sameStamp, stampOf } from "./cursors.mjs";

export const PROJECT_ROOT_TOKEN = "${PROJECT_ROOT}";

// Resolving a path through the filesystem is the expensive half of comparing
// two identities, and discovery compares the same few spellings — this
// project's root, plus one cwd per other workspace on the machine — once for
// every session file it finds. On a machine with a long history of unrelated
// projects that was seconds per pass; with the memo it is one resolution per
// distinct spelling. The cache holds what this process believes each spelling
// means, which is the same guarantee the OS path cache gives: a directory
// created mid-process is recognised from the next process on, not instantly.
const identityCache = new Map();
const IDENTITY_CACHE_LIMIT = 4096;

export function normalizeProjectIdentity(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const cached = identityCache.get(value);
  if (cached !== undefined) return cached;
  let target = value;
  try {
    if (/^file:/i.test(target)) target = fileURLToPath(target);
  } catch {
    return null;
  }
  let resolved = path.normalize(path.resolve(target));
  // Resolve junctions/symlinks when the path exists, while retaining the
  // lexical fallback for native metadata that references a deleted path.
  try { resolved = realpathSync.native(resolved); } catch {}
  if (process.platform === "win32") resolved = resolved.toLowerCase();
  if (identityCache.size >= IDENTITY_CACHE_LIMIT) identityCache.clear();
  identityCache.set(value, resolved);
  return resolved;
}

export function samePath(left, right) {
  const normalizedLeft = normalizeProjectIdentity(left);
  const normalizedRight = normalizeProjectIdentity(right);
  return normalizedLeft !== null && normalizedLeft === normalizedRight;
}

export function transformJsonLines(content, transform) {
  const trailingNewline = content.endsWith("\n");
  const lines = content.split(/\r?\n/);
  if (trailingNewline) {
    lines.pop();
  }
  const transformed = lines.map((line) => {
    if (!line.trim()) {
      return line;
    }
    try {
      return JSON.stringify(transform(JSON.parse(line)));
    } catch {
      return line;
    }
  });
  return `${transformed.join("\n")}${trailingNewline ? "\n" : ""}`;
}

export async function listFiles(root) {
  if (!existsSync(root)) {
    return [];
  }
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        files.push(path.relative(root, absolute));
      }
    }
  }
  await walk(root);
  return files.sort();
}

export async function replaceDirectory(destination, build) {
  const parent = path.dirname(destination);
  const suffix = `${process.pid}-${Date.now()}`;
  const temporary = `${destination}.tmp-${suffix}`;
  const backup = `${destination}.bak-${suffix}`;
  await mkdir(parent, { recursive: true });
  await rm(temporary, { recursive: true, force: true });
  await mkdir(temporary, { recursive: true });
  try {
    await build(temporary);
    if (existsSync(destination)) {
      await renameWithRetry(destination, backup);
    }
    await renameWithRetry(temporary, destination);
    await rm(backup, { recursive: true, force: true });
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    if (existsSync(backup) && !existsSync(destination)) {
      await renameWithRetry(backup, destination);
    }
    throw error;
  }
}

async function renameWithRetry(source, destination) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      if (attempt >= 4 || !["EACCES", "EBUSY", "EPERM"].includes(error.code)) throw error;
      await delay(40 * (attempt + 1));
    }
  }
}

export async function snapshotFiles(sourceRoot, relativeFiles, destination, transform) {
  await replaceDirectory(destination, async (temporary) => {
    for (const relative of relativeFiles) {
      const source = path.join(sourceRoot, relative);
      const target = path.join(temporary, relative);
      await mkdir(path.dirname(target), { recursive: true });
      const content = await readFile(source);
      await writeFile(target, transform ? await transform(content, relative) : content);
    }
  });
}

// Copy only the native files whose stamp moved since the last capture, and
// drop destination files whose native source is gone. A repeated capture with
// nothing new must touch nothing: that is the common case for every launch
// after the first.
//
// An entry is either `{ relative, source }` — a file, stamped by its own
// stat — or `{ relative, stamp, produce }`, for an agent whose history is only
// reachable through its CLI: the caller supplies the revision the agent
// reported plus a function that fetches the content, which is called only when
// that revision moved. A `stamp` of null means "this agent reports no
// revision", and such an entry is always produced.
export async function syncDirectory(entries, destinationRoot, transform, cursors, agentId) {
  const files = agentCursors(cursors, agentId);
  const seen = new Set();
  let added = 0;
  let updated = 0;
  let unchanged = 0;
  for (const { relative, source, stamp, produce } of entries) {
    seen.add(relative);
    const native = produce ? stamp : await stampOf(source);
    if (!produce && !native) continue;
    const destination = path.join(destinationRoot, relative);
    const entry = files[relative] ?? {};
    const destinationStamp = await stampOf(destination);
    // Nothing to do only when the source and the destination copy both still
    // look the way they did after the last capture. A missing stamp — an agent
    // that reports no revision, or a destination someone deleted — never
    // matches, so the entry is produced again.
    if (sameStamp(entry.native, native) && sameStamp(entry.portable, destinationStamp)) {
      unchanged += 1;
      continue;
    }
    await mkdir(path.dirname(destination), { recursive: true });
    const content = produce ? await produce() : await readFile(source);
    await writeFile(destination, transform ? await transform(content, relative) : content);
    files[relative] = { ...entry, native, portable: await stampOf(destination) };
    if (destinationStamp) updated += 1; else added += 1;
  }
  let removed = 0;
  for (const relative of await listFiles(destinationRoot)) {
    if (seen.has(relative)) continue;
    await rm(path.join(destinationRoot, relative), { force: true });
    await removeEmptyDirectories(path.dirname(path.join(destinationRoot, relative)), destinationRoot);
    delete files[relative];
    removed += 1;
  }
  return { added, updated, unchanged, removed };
}

async function removeEmptyDirectories(directory, stopAt) {
  const stop = path.resolve(stopAt);
  let current = path.resolve(directory);
  while (current !== stop && current.startsWith(stop)) {
    try {
      if ((await readdir(current)).length > 0) return;
      await rmdir(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}

function isPrefix(prefix, content) {
  return prefix.length <= content.length && content.subarray(0, prefix.length).equals(prefix);
}

export async function mergeFiles(sourceRoot, relativeFiles, destinationRoot, transform, options = {}) {
  let added = 0;
  let conflicts = 0;
  let updated = 0;
  let unchanged = 0;
  for (const relative of relativeFiles) {
    const source = path.join(sourceRoot, relative);
    const destination = path.join(destinationRoot, relative);
    const sourceContent = Buffer.from(transform ? await transform(await readFile(source), relative) : await readFile(source));
    if (!existsSync(destination)) {
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, sourceContent);
      added += 1;
      continue;
    }
    const destinationContent = await readFile(destination);
    if (sourceContent.equals(destinationContent) || isPrefix(sourceContent, destinationContent)) {
      unchanged += 1;
      continue;
    }
    if (relative.endsWith(".jsonl") && isPrefix(destinationContent, sourceContent)) {
      await writeFile(destination, sourceContent);
      updated += 1;
      continue;
    }
    if (options.onConflict === "keep-destination") {
      conflicts += 1;
      continue;
    }
    if (options.onConflict === "keep-source") {
      // The portable (project) copy wins; the destination gets the source
      // content and the caller reports the conflict.
      await writeFile(destination, sourceContent);
      conflicts += 1;
      continue;
    }
    throw new Error(`Session conflict: ${relative}. Keep one version, then retry.`);
  }
  return { added, conflicts, updated, unchanged };
}

// Session headers are one short line; conversation bodies are arbitrarily
// long. Nothing here needs a body to identify a session, so reads stop at the
// head and only fall back to the whole file when a head is all one line.
const HEAD_BYTES = 64 * 1024;

async function readHead(file, bytes) {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return { text: buffer.subarray(0, bytesRead).toString("utf8"), truncated: bytesRead === bytes };
  } finally {
    await handle.close();
  }
}

export async function readFileHead(file, bytes = HEAD_BYTES) {
  return (await readHead(file, bytes)).text;
}

export async function readFirstJsonLine(file) {
  const { text, truncated } = await readHead(file, HEAD_BYTES);
  const line = truncated && !text.includes("\n")
    ? (await readFile(file, "utf8")).split(/\r?\n/, 1)[0]
    : text.split(/\r?\n/, 1)[0];
  return JSON.parse(line.replace(/^\uFEFF/, ""));
}

// A portable entry that carries conversation history. An index is a derived
// lookup rather than a session, and a subagent transcript belongs to its
// parent, so neither is one.
const INDEX_BASENAMES = new Set(["session_index.jsonl", "sessions-index.json"]);

export function isConversationFile(relative) {
  if (!(relative.endsWith(".jsonl") || relative.endsWith(".json"))) return false;
  if (relative.includes(`${path.sep}subagents${path.sep}`)) return false;
  return !INDEX_BASENAMES.has(path.basename(relative));
}

// Every native record that names the workspace names it in the same field the
// agent uses, and the portable copy stores the same field as a token so the
// checkout can move; only where that field lives differs between agents, so
// that is the argument. `restore` writes the real root back.
export function rewriteProjectRoot(content, projectRoot, options = {}) {
  const field = options.field ?? ["cwd"];
  const restore = options.restore === true;
  return transformJsonLines(content.toString("utf8"), (record) => {
    let holder = record;
    for (const key of field.slice(0, -1)) {
      holder = holder?.[key];
      if (holder === null || typeof holder !== "object") return record;
    }
    const leaf = field.at(-1);
    if (restore ? typeof holder[leaf] === "string" : samePath(holder[leaf], projectRoot)) {
      holder[leaf] = restore ? projectRoot : PROJECT_ROOT_TOKEN;
    }
    return record;
  });
}

// The transform a native <-> portable copy applies to each file: only the
// agent's own JSONL records carry the root path.
export function projectRootTransform(projectRoot, options = {}) {
  return (content, relative) => (relative.endsWith(".jsonl") ? rewriteProjectRoot(content, projectRoot, options) : content);
}

// Write portable copies back into native storage. Project records are the
// source of truth: on conflict they overwrite the native copy (explicit
// `sessions writeback` semantics).
export async function restoreInto(portable, files, native, transform) {
  if (files.length === 0) return { count: 0, added: 0, updated: 0, unchanged: 0 };
  const result = await mergeFiles(portable, files, native, transform, { onConflict: "keep-source" });
  return { count: files.length, ...result };
}

export function hashContent(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function sameContent(left, right) {
  const source = await stat(left);
  const target = await stat(right).catch(() => null);
  if (!target || !target.isFile() || !source.isFile() || target.size !== source.size) return false;
  return (await readFile(left)).equals(await readFile(right));
}

// Copy one file, replacing whatever the destination holds.
async function copyFile(from, to) {
  await rm(to, { recursive: true, force: true });
  await mkdir(path.dirname(to), { recursive: true });
  await writeFile(to, await readFile(from));
}

// Make destination hold exactly what source holds, while leaving matching
// files alone. Rewriting a file that did not change is not just wasted work:
// it replaces the file stamp that incremental capture reads, so an unchanged
// native tree would be re-copied and re-parsed on the next launch. Both paths
// may also be single files, which is how Codex snapshots its session index.
async function mirrorInto(source, destination) {
  if (!(await stat(source)).isDirectory()) {
    if (!(await sameContent(source, destination))) await copyFile(source, destination);
    return;
  }
  const wanted = await listFiles(source);
  for (const relative of wanted) {
    const from = path.join(source, relative);
    const to = path.join(destination, relative);
    if (await sameContent(from, to)) continue;
    await copyFile(from, to);
  }
  if (!(await stat(destination).catch(() => null))?.isDirectory()) {
    // Either the destination held a file where the source has a directory, or
    // the source was empty so nothing above created the destination. Both are
    // resolved by making the destination an empty directory — recursing here
    // would never make progress on the second case.
    await rm(destination, { recursive: true, force: true });
    await mkdir(destination, { recursive: true });
  }
  const keep = new Set(wanted);
  for (const relative of await listFiles(destination)) {
    if (keep.has(relative)) continue;
    const target = path.join(destination, relative);
    await rm(target, { force: true });
    await removeEmptyDirectories(path.dirname(target), destination);
  }
}

// The destination ends up holding the source; when the source is absent the
// destination is removed instead, so a path that did not exist at snapshot time
// disappears again on revert.
export async function snapshotInto(source, destination) {
  if (!existsSync(source)) {
    await rm(destination, { recursive: true, force: true });
    return;
  }
  await mirrorInto(source, destination);
}

// Restore the pre-launch state saved by snapshotInto: the source path returns
// to its snapshot content, or disappears entirely when the snapshot is absent.
export async function revertFrom(snapshot, source) {
  if (!existsSync(snapshot)) {
    await rm(source, { recursive: true, force: true });
    return;
  }
  await mirrorInto(snapshot, source);
}

export function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM"; // exists but owned by another user
  }
}

// Shared state for concurrent avenic launches of one agent in one project.
export function sessionLeasePath(agentId, projectRoot) {
  const key = createHash("sha256").update(`${path.resolve(projectRoot)}\n${agentId}`).digest("hex").slice(0, 16);
  return path.join(os.tmpdir(), `avenic-launch-${key}`);
}

// Serialize the short bookkeeping sections of acquire/release. The lock file
// is created exclusively, holds the owner pid, and is stolen when that
// process is gone (crashed or killed).
async function withLaunchLock(stateDir, run) {
  await mkdir(stateDir, { recursive: true });
  const lockFile = path.join(stateDir, ".lock");
  const deadline = Date.now() + 60000;
  for (;;) {
    try {
      await writeFile(lockFile, `${process.pid}\n`, { encoding: "utf8", flag: "wx" });
      break;
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
      let owner = null;
      try {
        owner = Number.parseInt((await readFile(lockFile, "utf8")).trim(), 10);
      } catch {}
      if (!(Number.isInteger(owner) && processAlive(owner))) {
        await rm(lockFile, { force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error("Timed out waiting for another avenic launch in this project");
      }
      await delay(100);
    }
  }
  try {
    return await run();
  } finally {
    await rm(lockFile, { force: true });
  }
}

async function aliveLeasePids(stateDir) {
  let names = [];
  try {
    names = await readdir(path.join(stateDir, "pids"));
  } catch {}
  return names
    .map((name) => Number.parseInt(name.split("-", 1)[0], 10))
    .filter((pid) => Number.isInteger(pid) && processAlive(pid));
}

let leaseMemberSequence = 0;

// Join a launch group for one project+agent. Any number of launches can be
// active at once; the first one snapshots the agent's native storage (or, when
// a previous group died without finishing, salvages it via onFirst(true)
// first) and the last one to exit reverts it via onLast, so sessions created
// by avenic launches live only in the project. The returned function
// leaves the group.
// Leave a launch group as the given member. Runs onLast when the group has
// no live launches left, then removes the group state. Used by the launch
// flow and by the watchdog that finishes an interrupted launch.
export async function releaseSessionLease(agentId, projectRoot, member, callbacks = {}) {
  const stateDir = sessionLeasePath(agentId, projectRoot);
  await withLaunchLock(stateDir, async () => {
    await rm(path.join(stateDir, "pids", member), { force: true });
    if ((await aliveLeasePids(stateDir)).length > 0) {
      return;
    }
    try {
      await callbacks.onLast?.();
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
}

export async function acquireSessionLease(agentId, projectRoot, callbacks = {}) {
  const stateDir = sessionLeasePath(agentId, projectRoot);
  const snapshotMarker = path.join(stateDir, "snapshot.ok");
  // One member file per launch: two launches of the same process (tests) must
  // count separately, while the pid records whether the owner is still alive.
  const member = `${process.pid}-${Date.now()}-${leaseMemberSequence++}`;
  await withLaunchLock(stateDir, async () => {
    if ((await aliveLeasePids(stateDir)).length === 0) {
      // First launch of the group, or every previous launch died: the marker
      // records that a completed snapshot exists to recover from.
      await callbacks.onFirst?.(existsSync(snapshotMarker));
      await writeFile(snapshotMarker, "", { encoding: "utf8" });
    }
    await mkdir(path.join(stateDir, "pids"), { recursive: true });
    await writeFile(path.join(stateDir, "pids", member), "", { encoding: "utf8" });
  });
  return {
    member,
    stateDir,
    release: () => releaseSessionLease(agentId, projectRoot, member, callbacks),
  };
}
