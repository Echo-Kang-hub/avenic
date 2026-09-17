import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { runtimePaths } from "../config.mjs";
import {
  PROJECT_ROOT_TOKEN,
  listFiles,
  mergeFiles,
  readFirstJsonLine,
  replaceDirectory,
  revertFrom,
  samePath,
  snapshotInto,
  transformJsonLines,
} from "../sessions.mjs";
import { eventTimestamp, nativeEventId, parseJsonLines, readonlyProjection, textBlocks } from "./canonical.mjs";

export const agentId = "codex";

export function toCanonical(content, options = {}) {
  const records = parseJsonLines(content, agentId);
  const meta = records.find((record) => record.type === "session_meta");
  const nativeSessionId = options.nativeSessionId ?? meta?.payload?.id ?? meta?.payload?.session_id ?? "unknown";
  const events = records.flatMap((record, index) => {
    if (record.type !== "response_item" || record.payload?.type !== "message") return [];
    const role = record.payload.role;
    if (!new Set(["user", "assistant", "system", "tool"]).has(role)) return [];
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
  for (const relative of await listFiles(nativeSessions)) {
    if (!relative.endsWith(".jsonl")) continue;
    const content = await readFile(path.join(nativeSessions, relative), "utf8");
    const parsed = toCanonical(content);
    if (parsed.nativeSessionId === nativeSessionId) {
      return { ...parsed, revision: createHash("sha256").update(content).digest("hex") };
    }
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

function locations(projectRoot, environment = process.env) {
  const codexHome = environment.CODEX_HOME || path.join(homedir(), ".codex");
  return {
    codexHome,
    nativeSessions: path.join(codexHome, "sessions"),
    portable: path.join(runtimePaths(projectRoot).sessionsRoot, "codex"),
  };
}

function rewriteCwd(content, projectRoot, restore) {
  return transformJsonLines(content.toString("utf8"), (record) => {
    const cwd = record.payload?.cwd;
    if (restore ? typeof cwd === "string" : samePath(cwd, projectRoot)) {
      record.payload.cwd = restore ? projectRoot : PROJECT_ROOT_TOKEN;
    }
    return record;
  });
}

async function matchingRollouts(root, projectRoot) {
  const matches = [];
  for (const relative of await listFiles(root)) {
    if (!relative.endsWith(".jsonl")) {
      continue;
    }
    try {
      const first = await readFirstJsonLine(path.join(root, relative));
      if (first.type === "session_meta" && samePath(first.payload?.cwd, projectRoot)) {
        matches.push({ relative, id: first.payload?.id ?? first.payload?.session_id });
      }
    } catch {}
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
  const rollouts = await matchingRollouts(nativeSessions, projectRoot);
  if (rollouts.length === 0) {
    return {
      count: 0,
      changed: false,
      diagnostics: [existsSync(nativeSessions)
        ? "Found Codex session data, but none matched this workspace."
        : `Codex session root not found: ${nativeSessions}`],
    };
  }
  const ids = new Set(rollouts.map(({ id }) => id).filter(Boolean));
  await replaceDirectory(portable, async (temporary) => {
    for (const { relative } of rollouts) {
      const target = path.join(temporary, "sessions", relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, rewriteCwd(await readFile(path.join(nativeSessions, relative)), projectRoot, false));
    }
    const index = await filteredIndex(codexHome, ids);
    if (index) {
      await writeFile(path.join(temporary, "session_index.jsonl"), `${index}\n`, "utf8");
    }
  });
  return { count: rollouts.length, changed: true, diagnostics: [] };
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
  const files = await listFiles(sourceRoot);
  if (files.length === 0) {
    return { count: 0, added: 0, updated: 0, unchanged: 0 };
  }
  // Project portable sessions are the source of truth: on conflict they
  // overwrite the native copy (explicit `sessions writeback` semantics).
  const result = await mergeFiles(sourceRoot, files, nativeSessions, (content, relative) =>
    relative.endsWith(".jsonl") ? rewriteCwd(content, projectRoot, true) : content,
    { onConflict: "keep-source" },
  );
  await restoreIndex(portable, codexHome);
  return { count: files.length, ...result };
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
