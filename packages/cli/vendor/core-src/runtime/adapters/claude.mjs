import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { runtimePaths } from "../config.mjs";
import { cachedHead, knownDirectories, loadCursors, rememberDirectories, rememberHead, saveCursors, stampOf } from "../cursors.mjs";
import {
  PROJECT_ROOT_TOKEN,
  listFiles,
  mergeFiles,
  revertFrom,
  samePath,
  snapshotInto,
  syncDirectory,
  transformJsonLines,
} from "../sessions.mjs";
import { eventTimestamp, nativeEventId, parseJsonLines, readonlyProjection, textBlocks } from "./canonical.mjs";

export const agentId = "claude";

export function toCanonical(content, options = {}) {
  const parsed = parseJsonLines(content, agentId, { diagnostics: true });
  const records = parsed.records;
  const nativeSessionId = options.nativeSessionId ?? records.find((record) => typeof record.sessionId === "string")?.sessionId ?? "unknown";
  const events = records.flatMap((record, index) => {
    const role = record.message?.role;
    if (!new Set(["user", "assistant", "system", "tool"]).has(role)) return [];
    return [{
      id: nativeEventId(agentId, nativeSessionId, record.uuid, index, record),
      role,
      createdAt: eventTimestamp(record.timestamp),
      content: textBlocks(record.message.content),
      model: record.message.model,
      provider: "anthropic",
      extensions: { claude: { record, message: record.message } },
    }];
  });
  return { nativeSessionId, events, diagnostics: parsed.diagnostics, revision: options.revision ?? null };
}

export function fromCanonical(events) {
  return readonlyProjection(events);
}

// Reads one known native session only. It never consults configuration or
// credentials; callers supply the launch environment that is already active.
export async function readCanonical(projectRoot, nativeSessionId, options = {}) {
  for (const native of (await discoverNativeProjectDirectories(projectRoot, options.environment)).directories) {
    for (const relative of await listFiles(native)) {
      if (!isRootSession(relative)) continue;
      const content = await readFile(path.join(native, relative), "utf8");
      const parsed = toCanonical(content);
      if (parsed.nativeSessionId === nativeSessionId) {
        return { ...parsed, revision: createHash("sha256").update(content).digest("hex") };
      }
    }
  }
  throw new Error(`Claude native session is unavailable: ${nativeSessionId}`);
}

export function claudeProjectKey(projectRoot) {
  return path.resolve(projectRoot).replace(/[^a-zA-Z0-9]/g, "-");
}

function locations(projectRoot, environment = process.env) {
  const claudeHome = environment.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude");
  return {
    native: path.join(claudeHome, "projects", claudeProjectKey(projectRoot)),
    portable: path.join(runtimePaths(projectRoot).sessionsRoot, "claude"),
  };
}

function isRootSession(relative) {
  return relative.endsWith(".jsonl") && !relative.includes(`${path.sep}subagents${path.sep}`);
}

async function readCwdHead(file) {
  let handle;
  try {
    handle = await open(file, "r");
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    for (const line of buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const cwd = JSON.parse(line.replace(/^\uFEFF/, "")).cwd;
        if (typeof cwd === "string") return cwd;
      } catch {}
    }
  } catch {}
  finally { await handle?.close(); }
  return null;
}

// A session's cwd never changes while the file that records it is untouched,
// so the head read is cached against the file's stamp. Without this, every
// launch reopens the head of every Claude session on the machine.
async function jsonlCwd(file, cursors) {
  const stamp = cursors ? await stampOf(file) : null;
  if (cursors && stamp) {
    const cached = cachedHead(cursors, agentId, file, stamp);
    if (cached !== undefined) return cached;
  }
  const cwd = await readCwdHead(file);
  if (cursors && stamp) rememberHead(cursors, agentId, file, stamp, cwd);
  return cwd;
}

// Claude's encoded `projects/<name>` directory is not a stable API. Keep it
// as a cheap hint, then identify every other candidate from the native cwd
// recorded in its JSONL. This keeps custom config roots and Windows URI/path
// spelling from silently hiding existing project history.
async function discoverNativeProjectDirectories(projectRoot, environment = process.env, options = {}) {
  const { native: hinted } = locations(projectRoot, environment);
  const projectsRoot = path.dirname(hinted);
  if (!existsSync(projectsRoot)) {
    return { directories: [], diagnostics: [{ kind: "missing-root", message: `Claude session root not found: ${projectsRoot}` }] };
  }
  // A capture that runs while the agent is working only has to re-read the
  // directories this project already matched; rediscovering them means
  // opening the head of every Claude session on the machine.
  if (options.knownOnly) {
    return { directories: knownDirectories(options.cursors, agentId).filter((directory) => existsSync(directory)), diagnostics: [] };
  }
  const directories = [hinted];
  try {
    for (const entry of await readdir(projectsRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) directories.push(path.join(projectsRoot, entry.name));
    }
  } catch {}
  const unique = [...new Set(directories.map((directory) => path.resolve(directory)))];
  const matches = [];
  let candidateSessions = 0;
  let unreadable = 0;
  for (const directory of unique) {
    const files = await listFiles(directory);
    const rootSessions = files.filter(isRootSession);
    if (rootSessions.length === 0) continue;
    candidateSessions += rootSessions.length;
    let hasMetadata = false;
    for (const relative of rootSessions) {
      const cwd = await jsonlCwd(path.join(directory, relative), options.cursors);
      if (cwd) hasMetadata = true;
      else unreadable += 1;
      if (samePath(cwd, projectRoot)) {
        matches.push(directory);
        break;
      }
    }
    // Older Claude records can lack cwd. The historical encoded directory is
    // a compatibility fallback only when there was no contradicting metadata.
    if (!hasMetadata && path.resolve(directory) === path.resolve(hinted)) matches.push(directory);
  }
  if (options.cursors) rememberDirectories(options.cursors, agentId, matches);
  if (matches.length > 0) return { directories: matches, diagnostics: [] };
  if (candidateSessions > 0) {
    // Sessions that belong to other workspaces are not a problem to report:
    // this project simply has no Claude history yet.
    const suffix = unreadable > 0 ? `; ${unreadable} session file(s) had no readable cwd metadata` : "";
    return { directories: [], diagnostics: unreadable > 0 ? [{ kind: "missing-root", message: `Found ${candidateSessions} Claude session(s) for other workspaces, but none matched this one${suffix}.` }] : [] };
  }
  return { directories: [], diagnostics: [] };
}

function rewriteCwd(content, projectRoot, restore) {
  return transformJsonLines(content.toString("utf8"), (record) => {
    if (restore ? typeof record.cwd === "string" : samePath(record.cwd, projectRoot)) {
      record.cwd = restore ? projectRoot : PROJECT_ROOT_TOKEN;
    }
    return record;
  });
}

export async function capture(projectRoot, options = {}) {
  const { portable } = locations(projectRoot, options.environment);
  const ownsCursors = options.cursors === undefined;
  const cursors = options.cursors ?? loadCursors(projectRoot, options.environment);
  let discovery = await discoverNativeProjectDirectories(projectRoot, options.environment, { cursors, knownOnly: options.knownOnly });
  if (options.knownOnly && discovery.directories.length === 0) {
    // Nothing has been captured here yet, so there is no known root to watch.
    discovery = await discoverNativeProjectDirectories(projectRoot, options.environment, { cursors });
  }
  const sources = [];
  for (const native of discovery.directories) {
    for (const relative of await listFiles(native)) sources.push({ relative, source: path.join(native, relative) });
  }
  const result = await syncDirectory(
    sources,
    portable,
    (content, relative) => (relative.endsWith(".jsonl") ? rewriteCwd(content, projectRoot, false) : content),
    cursors,
    agentId,
  );
  if (ownsCursors) await saveCursors(projectRoot, cursors, options.environment);
  return {
    count: sources.filter(({ relative }) => isRootSession(relative)).length,
    changed: result.added + result.updated + result.removed > 0,
    diagnostics: discovery.diagnostics,
  };
}

export async function restore(projectRoot, options = {}) {
  const { native, portable } = locations(projectRoot, options.environment);
  const files = await listFiles(portable);
  if (files.length === 0) {
    return { count: 0, added: 0, updated: 0, unchanged: 0 };
  }
  // Project portable sessions are the source of truth: on conflict they
  // overwrite the native copy (explicit `sessions writeback` semantics).
  const result = await mergeFiles(portable, files, native, (content, relative) =>
    relative.endsWith(".jsonl") ? rewriteCwd(content, projectRoot, true) : content,
    { onConflict: "keep-source" },
  );
  return { count: files.length, ...result };
}

export async function status(projectRoot) {
  const { portable } = locations(projectRoot);
  const files = await listFiles(portable);
  return { count: files.filter((file) => file.endsWith(".jsonl") && !file.includes(`${path.sep}subagents${path.sep}`)).length };
}

// Save the native project directory into the shared launch state so the last
// exit can restore it: sessions created by `avenic claude` must live only
// in the project, never in the global native storage.
export async function snapshotNative(projectRoot, snapshotRoot, options = {}) {
  const { native } = locations(projectRoot, options.environment);
  await snapshotInto(native, snapshotRoot);
}

export async function revertNative(snapshotRoot, projectRoot, options = {}) {
  const { native } = locations(projectRoot, options.environment);
  await revertFrom(snapshotRoot, native);
}
