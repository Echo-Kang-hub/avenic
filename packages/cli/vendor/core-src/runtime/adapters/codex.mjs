import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { agentSessionsRoot } from "../config.mjs";
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
import { eventTimestamp, isConversationRole, nativeEventId, parseJsonLines, readonlyProjection, textBlocks } from "./canonical.mjs";

export const agentId = "codex";

export function toCanonical(content, options = {}) {
  const records = parseJsonLines(content, agentId);
  const meta = records.find((record) => record.type === "session_meta");
  const nativeSessionId = options.nativeSessionId ?? meta?.payload?.id ?? meta?.payload?.session_id ?? "unknown";
  const events = records.flatMap((record, index) => {
    if (record.type !== "response_item" || record.payload?.type !== "message") return [];
    const role = record.payload.role;
    if (!isConversationRole(role)) return [];
    return [{
      id: nativeEventId(agentId, nativeSessionId, record.payload.id, index, record),
      role,
      createdAt: eventTimestamp(record.timestamp),
      content: textBlocks(record.payload.content),
      model: record.payload.model,
      provider: meta?.payload?.model_provider,
      extensions: { codex: { record, payload: record.payload } },
    }];
  });
  return { nativeSessionId, events, revision: options.revision ?? null };
}

export function fromCanonical(events) {
  return readonlyProjection(events);
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

// Codex multi-agent v2 persists child rollouts with a parent_thread_id, but
// the app-server cannot resume an unloaded child directly. Keep the canonical
// mapping stable while resolving the native resume target to its parent.
export async function resolveResumableSession(projectRoot, nativeSessionId, options = {}) {
  const { nativeSessions } = locations(projectRoot, options.environment);
  const matches = await matchingRollouts(nativeSessions, projectRoot);
  const byId = new Map(matches.filter((item) => item.id).map((item) => [item.id, item]));
  const seen = new Set([nativeSessionId]);
  let resumable = nativeSessionId;
  while (true) {
    const rollout = byId.get(resumable);
    const parent = rollout?.parentThreadId;
    if (!parent || rollout.multiAgentVersion === undefined) return resumable;
    // A corrupt/cyclic native rollout must not hang or change the stored
    // mapping. The official CLI can still give its normal diagnostic.
    if (seen.has(parent)) return nativeSessionId;
    seen.add(parent);
    resumable = parent;
  }
}

function locations(projectRoot, environment = process.env) {
  const codexHome = environment.CODEX_HOME || path.join(homedir(), ".codex");
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
  const result = await restoreInto(sourceRoot, await listFiles(sourceRoot), nativeSessions,
    projectRootTransform(projectRoot, { field: ["payload", "cwd"], restore: true }));
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
export async function snapshotNative(projectRoot, snapshotRoot, options = {}) {
  const { codexHome, nativeSessions } = locations(projectRoot, options.environment);
  await snapshotInto(nativeSessions, path.join(snapshotRoot, "sessions"));
  await snapshotInto(path.join(codexHome, "session_index.jsonl"), path.join(snapshotRoot, "index.jsonl"));
}

export async function revertNative(snapshotRoot, projectRoot, options = {}) {
  const { codexHome, nativeSessions } = locations(projectRoot, options.environment);
  await revertFrom(path.join(snapshotRoot, "index.jsonl"), path.join(codexHome, "session_index.jsonl"));
  await revertFrom(path.join(snapshotRoot, "sessions"), nativeSessions);
}
