import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT_TOKEN = "${PROJECT_ROOT}";

export function normalizeProjectIdentity(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    if (/^file:/i.test(value)) value = fileURLToPath(value);
  } catch {
    return null;
  }
  let resolved = path.normalize(path.resolve(value));
  // Resolve junctions/symlinks when the path exists, while retaining the
  // lexical fallback for native metadata that references a deleted path.
  try { resolved = realpathSync.native(resolved); } catch {}
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
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

export async function readFirstJsonLine(file) {
  const content = await readFile(file, "utf8");
  const line = content.split(/\r?\n/, 1)[0];
  return JSON.parse(line.replace(/^\uFEFF/, ""));
}

export function hashContent(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function copyPath(source, destination) {
  const stats = await stat(source);
  if (stats.isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const entry of await readdir(source, { withFileTypes: true })) {
      await copyPath(path.join(source, entry.name), path.join(destination, entry.name));
    }
  } else {
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, await readFile(source));
  }
}

// Copy a file or directory into destination, which must not exist; when the
// source is absent the destination is removed instead, so a path that did not
// exist at snapshot time disappears again on revert.
export async function snapshotInto(source, destination) {
  if (!existsSync(source)) {
    await rm(destination, { recursive: true, force: true });
    return;
  }
  await rm(destination, { recursive: true, force: true });
  await copyPath(source, destination);
}

// Restore the pre-launch state saved by snapshotInto: the source path returns
// to its snapshot content, or disappears entirely when the snapshot is absent.
export async function revertFrom(snapshot, source) {
  await rm(source, { recursive: true, force: true });
  if (existsSync(snapshot)) {
    await copyPath(snapshot, source);
  }
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
