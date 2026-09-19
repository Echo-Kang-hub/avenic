import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import {
  copyFile as copyFileNative,
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
import { agentCursors, restoreStamps, sameStamp, stampOf } from "./cursors.mjs";
import { timed } from "./timing.mjs";

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
  // No entries means the source had nothing to offer this run — a native root
  // that is missing, or a scan that matched no session — and that is not the
  // same as "every native session was deleted". The removal pass below cannot
  // tell those apart, and choosing wrong deletes the project's only copy: after
  // `avenic claude` reverts native storage, the portable files under
  // `.agents/sessions/claude` are all the project has left, so the next capture
  // finding no native root must leave them alone. Agents whose native history
  // can be genuinely empty return before this point and report why.
  if (entries.length === 0) return { added: 0, updated: 0, unchanged: 0, removed: 0 };
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

// Whether a byte buffer contains a byte sequence, optionally comparing ASCII
// letters case-insensitively — which is how Windows compares paths. This is
// the cheap question a content rewrite asks first, so it scans without
// decoding the buffer to a string: on a session log that needs no rewrite, the
// answer is one pass over the bytes instead of a parse of every line.
function sameLetter(left, right) {
  const fold = (byte) => (byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte);
  return fold(left) === fold(right);
}

function containsBytes(haystack, needle, ignoreCase) {
  if (needle.length === 0) return true;
  if (needle.length > haystack.length) return false;
  const first = needle[0];
  const limit = haystack.length - needle.length;
  outer: for (let index = 0; index <= limit; index += 1) {
    if (ignoreCase ? !sameLetter(haystack[index], first) : haystack[index] !== first) continue;
    for (let offset = 1; offset < needle.length; offset += 1) {
      const left = haystack[index + offset];
      const right = needle[offset];
      if (ignoreCase ? !sameLetter(left, right) : left !== right) continue outer;
    }
    return true;
  }
  return false;
}

export async function mergeFiles(sourceRoot, relativeFiles, destinationRoot, transform, options = {}) {
  let added = 0;
  let conflicts = 0;
  let updated = 0;
  let unchanged = 0;
  for (const relative of relativeFiles) {
    const source = path.join(sourceRoot, relative);
    const destination = path.join(destinationRoot, relative);
    const raw = await readFile(source);
    const transformed = transform ? await transform(raw, relative) : raw;
    // A transform that had nothing to rewrite hands the buffer straight back,
    // and wrapping it again would copy the whole file to say so.
    const sourceContent = Buffer.isBuffer(transformed) ? transformed : Buffer.from(transformed);
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
  // A record can only be rewritten when the file already spells out the token
  // being written, or the workspace directory being tokenised — Windows
  // compares paths case-insensitively, so the search does too. Almost every
  // file in a real history fails that test, and answering it from the raw
  // bytes is what keeps a launch from parsing a hundred megabytes of logs: the
  // alternative, parsing every line of every file to find the few records that
  // name this workspace, was the largest single cost of starting an agent.
  const marker = restore
    ? PROJECT_ROOT_TOKEN
    : path.basename(normalizeProjectIdentity(projectRoot) ?? path.resolve(projectRoot));
  if (!containsBytes(content, Buffer.from(marker, "utf8"), process.platform === "win32")) {
    return content;
  }
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
export async function restoreInto(portable, files, native, transform, options = {}) {
  if (files.length === 0) return { count: 0, added: 0, updated: 0, unchanged: 0 };
  const stamps = options.cursors ? restoreStamps(options.cursors, options.agentId) : null;
  const pending = [];
  const next = {};
  let skipped = 0;
  // Every session file needs two stamps to decide whether it can be skipped,
  // and a project with a long history has hundreds. Read them in parallel —
  // sequentially this was ~500 syscalls deep on the path to the agent's first
  // paint, which is the one place a launch cannot afford latency.
  const sourceStamps = stamps ? await stampsOf(portable, files) : {};
  const targetStamps = stamps ? await stampsOf(native, files) : {};
  for (const relative of files) {
    const recorded = stamps?.[relative];
    if (recorded) {
      if (sameStamp(recorded.source, sourceStamps[relative]) && sameStamp(recorded.target, targetStamps[relative])) {
        next[relative] = recorded;
        skipped += 1;
        continue;
      }
    }
    pending.push(relative);
  }
  const result = await mergeFiles(portable, pending, native, transform, { onConflict: "keep-source" });
  if (stamps) {
    const mergedSources = await stampsOf(portable, pending);
    const mergedTargets = await stampsOf(native, pending);
    for (const relative of pending) {
      next[relative] = { source: mergedSources[relative], target: mergedTargets[relative] };
    }
    // 整表替换：删掉的会话不该把它的条目永远留在游标里。
    for (const key of Object.keys(stamps)) delete stamps[key];
    Object.assign(stamps, next);
  }
  return { count: files.length, ...result, unchanged: result.unchanged + skipped };
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

// Copy one file, replacing whatever the destination holds. The kernel's own
// copy is several times faster than reading the bytes into this process and
// writing them out again, which on a project's real history is the difference
// between a launch and a pause.
async function copyFile(from, to) {
  await rm(to, { recursive: true, force: true });
  await mkdir(path.dirname(to), { recursive: true });
  await copyFileNative(from, to);
}

// A session tree is independent files, and on Windows each one costs a
// create/close pair that dominates the bytes moved. A bounded pool keeps the
// disk busy without flooding it.
const COPY_CONCURRENCY = 16;
async function copyEach(files, run) {
  const queue = [...files];
  await Promise.all(Array.from({ length: Math.min(COPY_CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const item = queue.pop();
      if (item === undefined) return;
      await run(item);
    }
  }));
}

async function stampsOf(root, relativeFiles) {
  const stamps = {};
  await copyEach(relativeFiles, async (relative) => {
    stamps[relative] = await stampOf(path.join(root, relative));
  });
  return stamps;
}

// Make destination hold exactly what source holds, while leaving matching
// files alone. Rewriting a file that did not change is not just wasted work:
// it replaces the file stamp that incremental capture reads, so an unchanged
// native tree would be re-copied and re-parsed on the next launch. Both paths
// may also be single files, which is how Codex snapshots its session index.
async function mirrorInto(source, destination, skip, keep = null) {
  if (!(await stat(source)).isDirectory()) {
    if (!(await sameContent(source, destination))) await copyFile(source, destination);
    return null;
  }
  const wanted = await listFiles(source);
  const copies = [];
  const pending = [];
  for (const relative of wanted) {
    const from = path.join(source, relative);
    const to = path.join(destination, relative);
    if (skip && (await skip(relative, to))) continue;
    pending.push([relative, from, to]);
  }
  // Both questions the loop above asks are per-file, so they are asked in
  // parallel: a revert that has to look at a project's whole history would
  // otherwise read its files one at a time, twice each.
  const decisions = await Promise.all(pending.map(([, from, to]) => sameContent(from, to)));
  for (const [index, [relative]] of pending.entries()) if (!decisions[index]) copies.push(relative);
  await copyEach(copies, (relative) => copyFile(path.join(source, relative), path.join(destination, relative)));
  if (!(await stat(destination).catch(() => null))?.isDirectory()) {
    // Either the destination held a file where the source has a directory, or
    // the source was empty so nothing above created the destination. Both are
    // resolved by making the destination an empty directory — recursing here
    // would never make progress on the second case.
    await rm(destination, { recursive: true, force: true });
    await mkdir(destination, { recursive: true });
  }
  const held = keep ?? new Set(wanted);
  for (const relative of await listFiles(destination)) {
    if (held.has(relative)) continue;
    const target = path.join(destination, relative);
    await rm(target, { force: true });
    await removeEmptyDirectories(path.dirname(target), destination);
  }
  return wanted;
}

// The stamps the snapshot was taken from. A revert reads them to answer "did
// the run touch this file?" from one stat instead of comparing every session's
// bytes in both trees — which, on a project with a real history, is the whole
// cost of the exit path.
function mirrorManifest(destination) {
  return `${destination}.mirror.json`;
}

async function readMirrorManifest(destination) {
  try {
    const parsed = JSON.parse(await readFile(mirrorManifest(destination), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null; // 没有清单只是退回到逐字节比较，不是错误
  }
}

// The destination ends up holding the source; when the source is absent the
// destination is removed instead, so a path that did not exist at snapshot time
// disappears again on revert.
//
// A retained snapshot makes this a comparison instead of a copy. The manifest
// names the source stamp each copied file was taken from, so a file whose stamp
// has not moved is still what the destination holds and does not have to be
// read back — on a project with a real history that is the difference between
// launching and waiting for a hundred megabytes of session logs to be copied.
export async function snapshotInto(source, destination, options = {}) {
  // `only` says which of the source's files the caller can actually change, so
  // its content is worth holding. Every file is still listed and stamped: the
  // listing is what tells a revert which files the run created, and that
  // question has to be answered for the whole tree whatever was copied.
  const only = options.only ?? null;
  const copies = (relative) => !only || only.has(relative);
  if (!existsSync(source)) {
    await rm(destination, { recursive: true, force: true });
    await rm(mirrorManifest(destination), { force: true });
    return;
  }
  if (!(await stat(source)).isDirectory()) {
    return timed("snapshot.single", async () => {
      if (!(await sameContent(source, destination))) await copyFile(source, destination);
    });
  }
  const wanted = await listFiles(source);
  const [stamps, held] = await timed("snapshot.stamp", () => Promise.all([
    stampsOf(source, wanted),
    stampsOf(destination, wanted),
  ]));
  const known = await readMirrorManifest(destination);
  const wantedCopies = wanted.filter((relative) => {
    if (!copies(relative)) return false;
    if (!known || !sameStamp(known[relative], stamps[relative])) return true;
    return !held[relative]; // the destination was emptied out from under the manifest
  });
  await timed("snapshot.copy", () => copyEach(wantedCopies, (relative) => copyFile(path.join(source, relative), path.join(destination, relative))));
  await timed("snapshot.prune", async () => {
    if (!(await stat(destination).catch(() => null))?.isDirectory()) {
      await rm(destination, { recursive: true, force: true });
      await mkdir(destination, { recursive: true });
    }
    const keep = new Set(wanted.filter(copies));
    for (const relative of await listFiles(destination)) {
      if (keep.has(relative)) continue;
      const target = path.join(destination, relative);
      await rm(target, { force: true });
      await removeEmptyDirectories(path.dirname(target), destination);
    }
    await writeFile(mirrorManifest(destination), `${JSON.stringify(stamps)}\n`, "utf8");
  });
}

// Restore the pre-launch state saved by snapshotInto: the source path returns
// to its snapshot content, or disappears entirely when the snapshot is absent.
// A file whose stamp still matches the snapshot's is already that snapshot's
// content — the only writer in between is the agent, and it appends.
//
// `partial` says the snapshot holds content for only part of the tree — the
// part the launch could change. The manifest, not the snapshot directory, then
// names what the tree held, which is what decides whether a file found in it
// now was created by the run. Without one nothing is removed: deleting files a
// manifest cannot account for would destroy history, not restore it.
export async function revertFrom(snapshot, source, options = {}) {
  if (!existsSync(snapshot)) {
    await rm(source, { recursive: true, force: true });
    return;
  }
  const stamps = await readMirrorManifest(snapshot);
  if (options.partial && !stamps) return;
  await mirrorInto(snapshot, source, async (relative, target) => {
    const recorded = stamps?.[relative];
    return recorded ? sameStamp(recorded, await stampOf(target)) : false;
  }, options.partial ? new Set(Object.keys(stamps)) : null);
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

/**
 * What the launch group for one project+agent is doing, read from the outside:
 * a launch is live, a launch died before its exit sequence ran, or nothing is
 * pending. The answer comes from the same markers the launch path itself
 * decides on, so a status can never disagree with what the next launch will do.
 */
export async function launchGroupState(agentId, projectRoot) {
  const stateDir = sessionLeasePath(agentId, projectRoot);
  if (!existsSync(stateDir)) return "idle";
  if ((await aliveLeasePids(stateDir)).length > 0) return "running";
  // The exit sequence ran to its end and put native storage back; the snapshot
  // is retained for the next launch to verify against, not to recover from.
  return existsSync(path.join(stateDir, "snapshot.clean")) ? "idle" : "interrupted";
}

let leaseMemberSequence = 0;

// The group state is shared by concurrent launches, so one launch's markers
// live under its own member id: "I am finishing" from the launch that ended an
// hour ago must not be read as this launch's, and a state directory that
// outlives its launch still holds the last one's files.
export function launchMarkerPath(agentId, projectRoot, member, name) {
  return path.join(sessionLeasePath(agentId, projectRoot), "launch", member, name);
}

/** Record that a launch has begun its exit sequence, so its durability watch stops. */
export function markLaunchClosing(agentId, projectRoot, member) {
  const marker = launchMarkerPath(agentId, projectRoot, member, "closing");
  mkdirSync(path.dirname(marker), { recursive: true });
  writeFileSync(marker, "");
}

/**
 * Whether there is anything left to finish for a launch, as opposed to it
 * dying with work unfinished. A watchdog reads this to tell "the launcher is
 * done, or a later launch did it" from "the launcher was killed with nobody to
 * take over", which decides whether it still has a reason to run.
 */
export function launchFinished(agentId, projectRoot, member) {
  return existsSync(launchMarkerPath(agentId, projectRoot, member, "done"));
}

export function markLaunchFinished(agentId, projectRoot, member) {
  const marker = launchMarkerPath(agentId, projectRoot, member, "done");
  mkdirSync(path.dirname(marker), { recursive: true });
  writeFileSync(marker, "");
}

// How long a launch's records outlive it. The watch that reads them is started
// by the launch itself and may wake up seconds later, so they have to stand for
// longer than any watch can live; past that they are clutter in a directory
// that lives as long as the project's launch state does.
const LAUNCH_MARKER_RETENTION_MS = 10 * 60 * 1000;

/**
 * Take over the records of the launches that are gone, for a group whose first
 * live launch just arrived. A launch that recovers an interrupted group has
 * already done what those launches never got to — captured their sessions and
 * put native storage back — so their watches would only repeat it. Marking
 * them finished is how that is said with the marker a watch already reads: two
 * processes capturing the same tree at once cost far more than either alone,
 * and the second one's work is wasted anyway. Records too old for any watch to
 * still be owed an answer are the ones that get deleted.
 */
async function adoptLaunchMarkers(stateDir) {
  const launchRoot = path.join(stateDir, "launch");
  let members = [];
  try {
    members = await readdir(launchRoot);
  } catch {
    return; // no launch has run for this group yet
  }
  const cutoff = Date.now() - LAUNCH_MARKER_RETENTION_MS;
  for (const member of members) {
    const [pid, startedAt] = member.split("-");
    const record = path.join(launchRoot, member);
    const owner = Number.parseInt(pid, 10);
    const recorded = Number.parseInt(startedAt, 10);
    if (!Number.isInteger(owner) || !Number.isInteger(recorded) || recorded < cutoff) {
      await rm(record, { recursive: true, force: true });
      continue;
    }
    if (processAlive(owner)) continue; // a launch of this group is still running
    await mkdir(record, { recursive: true });
    await writeFile(path.join(record, "done"), "", { encoding: "utf8" });
  }
}

// Join a launch group for one project+agent. Any number of launches can be
// active at once; the first one snapshots the agent's native storage (or, when
// a previous group died without finishing, salvages it via onFirst(true)
// first) and the last one to exit reverts it via onLast, so sessions created
// by avenic launches live only in the project. The returned function
// leaves the group.
// Leave a launch group as the given member. Runs onLast when the group has
// no live launches left, then keeps the group state for the next launch. Used
// by the launch flow and by the watchdog that finishes an interrupted launch.
export async function releaseSessionLease(agentId, projectRoot, member, callbacks = {}) {
  const stateDir = sessionLeasePath(agentId, projectRoot);
  const cleanMarker = path.join(stateDir, "snapshot.clean");
  await withLaunchLock(stateDir, async () => {
    await rm(path.join(stateDir, "pids", member), { force: true });
    if ((await aliveLeasePids(stateDir)).length > 0) {
      return;
    }
    // The snapshot outlives the launch it was taken for, and the next launch
    // trusts it: that is only sound when this exit actually put native storage
    // back the way the snapshot describes it.
    let restored = !callbacks.onLast;
    try {
      if (callbacks.onLast) {
        await callbacks.onLast();
        restored = true;
      }
    } finally {
      await rm(path.join(stateDir, "pids"), { recursive: true, force: true });
      if (restored) await writeFile(cleanMarker, "", { encoding: "utf8" });
      else await rm(cleanMarker, { force: true });
    }
  });
}

export async function acquireSessionLease(agentId, projectRoot, callbacks = {}) {
  const stateDir = sessionLeasePath(agentId, projectRoot);
  const snapshotMarker = path.join(stateDir, "snapshot.ok");
  // A group that ended cleanly leaves its snapshot behind for the next launch
  // to verify against instead of copying the tree again; this marker is what
  // tells that situation apart from a group that died mid-run.
  const cleanMarker = path.join(stateDir, "snapshot.clean");
  // One member file per launch: two launches of the same process (tests) must
  // count separately, while the pid records whether the owner is still alive.
  const member = `${process.pid}-${Date.now()}-${leaseMemberSequence++}`;
  await timed("lease", () => withLaunchLock(stateDir, async () => {
    if ((await aliveLeasePids(stateDir)).length === 0) {
      // First launch of the group, or every previous launch died: the marker
      // records that a completed snapshot exists to recover from.
      const recovered = existsSync(snapshotMarker) && !existsSync(cleanMarker);
      await timed("lease.first", () => callbacks.onFirst?.(recovered));
      await writeFile(snapshotMarker, "", { encoding: "utf8" });
      await rm(cleanMarker, { force: true });
      // This launch owns the group now: the previous launches' records say
      // nothing about it, and a stale closing marker would end this run's
      // watch early. What they do still say is which of those launches are
      // owed a finish — and this launch just did it.
      await adoptLaunchMarkers(stateDir);
      // No member is alive, so every pid file belongs to a launch that was
      // killed before it could leave. They are already ignored when the group
      // is read, but leaving them is what lets a recycled process id make a
      // dead launch look like a live one.
      await rm(path.join(stateDir, "pids"), { recursive: true, force: true });
    }
    await mkdir(path.join(stateDir, "pids"), { recursive: true });
    await writeFile(path.join(stateDir, "pids", member), "", { encoding: "utf8" });
  }));
  return {
    member,
    stateDir,
    release: () => releaseSessionLease(agentId, projectRoot, member, callbacks),
  };
}
