import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { agentSessionsRoot, runtimePaths } from "../config.mjs";
import { loadCursors, saveCursors } from "../cursors.mjs";
import { hashContent, listFiles, samePath, syncDirectory } from "../sessions.mjs";
import { spawnExecutableSync } from "../process.mjs";
import { eventTimestamp, isConversationRole, nativeEventId } from "./canonical.mjs";
import { createHash } from "node:crypto";

export const agentId = "opencode";

// OpenCode's export format carries more roles than it can read back: a
// projection is a conversation, so only these two become messages.
const PROJECTABLE_ROLES = new Set(["user", "assistant"]);

function canonicalBlocks(parts) {
  if (!Array.isArray(parts)) return [];
  return parts.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    if (part.type === "text" && typeof part.text === "string") return [{ type: "text", text: part.text }];
    if (part.type === "reasoning" && typeof part.text === "string") return [{ type: "reasoning_summary", text: part.text }];
    return [{ type: "unknown/native_extension", nativeType: part.type ?? "unknown", data: part }];
  });
}

export function toCanonical(content, options = {}) {
  let exported;
  try { exported = typeof content === "string" ? JSON.parse(content) : content; } catch { throw new Error("Malformed opencode session export"); }
  if (!exported || typeof exported !== "object") throw new Error("Malformed opencode session export");
  const nativeSessionId = options.nativeSessionId ?? exported.id ?? exported.info?.id ?? exported.session?.id;
  if (typeof nativeSessionId !== "string") throw new Error("OpenCode export has no session id");
  const messages = exported.messages ?? exported.data?.messages ?? [];
  if (!Array.isArray(messages)) throw new Error("OpenCode export messages must be an array");
  const events = messages.flatMap((message, index) => {
    const info = message?.info ?? message;
    const role = info?.role;
    if (!isConversationRole(role)) return [];
    const provenance = (message.parts ?? info.parts ?? []).find((part) => part?.metadata?._avenic)?.metadata?._avenic;
    const canonicalEventId = provenance && provenance.canonicalSessionId === options.canonicalSessionId
      && typeof provenance.canonicalEventId === "string"
      ? provenance.canonicalEventId
      : null;
    return [{
      id: canonicalEventId ?? nativeEventId(agentId, nativeSessionId, info.id, index, message),
      role,
      createdAt: eventTimestamp(info.time?.created ?? info.createdAt),
      content: canonicalBlocks(message.parts ?? info.parts ?? info.content),
      model: info.modelID ?? info.model,
      provider: info.providerID ?? info.provider,
      extensions: { opencode: { message } },
    }];
  });
  return { nativeSessionId, events, revision: options.revision ?? null };
}

function nativeId(prefix, value) {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function epoch(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function fromCanonical(events, options = {}) {
  const canonicalSessionId = options.canonicalSessionId ?? "unknown";
  const sessionID = options.nativeSessionId ?? nativeId("ses", canonicalSessionId);
  const sessionModel = options.model ?? { id: "big-pickle", providerID: "opencode", variant: "default" };
  const messageModel = {
    providerID: sessionModel.providerID ?? sessionModel.provider ?? "opencode",
    modelID: sessionModel.modelID ?? sessionModel.id ?? "big-pickle",
  };
  const diagnostics = [];
  const messages = [];
  const nativeMessageIds = new Map();
  for (const [index, event] of events.entries()) {
    if (!PROJECTABLE_ROLES.has(event.role)) {
      diagnostics.push({ eventId: event.id, code: "unsupported_role", message: `OpenCode export does not project ${event.role} as a conversation message` });
      continue;
    }
    const parts = (event.content ?? []).flatMap((block) => {
      if (block?.type === "text" && typeof block.text === "string") return [{ type: "text", text: block.text }];
      diagnostics.push({ eventId: event.id, code: "unsupported_content", message: `OpenCode export does not project ${block?.type ?? "unknown"} content` });
      return [];
    });
    if (parts.length === 0) continue;
    const messageID = nativeId("msg", `${canonicalSessionId}:${event.id}:${index}`);
    const created = epoch(event.createdAt);
    const parentID = event.parentId ? nativeMessageIds.get(event.parentId) : messages.at(-1)?.info.id;
    if (event.role === "assistant" && !parentID) {
      diagnostics.push({ eventId: event.id, code: "missing_parent", message: "OpenCode assistant messages require a parent message" });
      continue;
    }
    const model = {
      providerID: event.provider ?? messageModel.providerID,
      modelID: event.model ?? messageModel.modelID,
    };
    messages.push({
      info: {
        role: event.role,
        time: { created },
        id: messageID,
        sessionID,
        ...(event.role === "user"
          ? { agent: options.agent ?? "build", model }
          : {
            parentID,
            modelID: model.modelID,
            providerID: model.providerID,
            mode: options.mode ?? "build",
            agent: options.agent ?? "build",
            path: { cwd: options.directory ?? ".", root: options.directory ?? "." },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          }),
      },
      parts: parts.map((part, partIndex) => ({
        ...part,
        id: nativeId("prt", `${messageID}:${partIndex}`),
        sessionID,
        messageID,
        metadata: { _avenic: { canonicalSessionId, canonicalEventId: event.id } },
      })),
    });
    nativeMessageIds.set(event.id, messageID);
  }
  return {
    format: "opencode-export-v1",
    data: {
      info: {
        id: sessionID,
        slug: `avenic-${nativeId("session", canonicalSessionId).slice(-12)}`,
        projectID: "global",
        title: typeof options.title === "string" && options.title.trim()
          ? options.title
          : `Avenic session ${canonicalSessionId}`,
        directory: options.directory ?? null,
        path: typeof options.directory === "string" ? options.directory.replace(/\\/g, "/").replace(/^([A-Z]):/i, "$1") : null,
        agent: options.agent ?? "build",
        model: sessionModel,
        version: options.version ?? "1.18.30",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: {
          created: messages[0]?.info.time.created ?? 0,
          updated: messages.at(-1)?.info.time.created ?? 0,
        },
      },
      messages,
    },
    diagnostics,
  };
}

function run(argumentsList, projectRoot, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const result = spawnExecutableSync("opencode", argumentsList, {
    cwd: projectRoot,
    encoding: "utf8",
    env: options.environment ?? process.env,
    windowsHide: true,
    timeout: timeoutMs,
    spawn: options.spawn,
  });
  if (result.error?.code === "ETIMEDOUT") {
    throw new Error(`OpenCode session command timed out after ${timeoutMs}ms`);
  }
  if (result.error) {
    throw new Error(`Unable to launch opencode: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || `opencode exited with code ${result.status}`);
  }
  return result.stdout;
}

function portableRoot(projectRoot) {
  return agentSessionsRoot(projectRoot, "opencode");
}

function projectionFile(projectRoot, canonicalSessionId) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(canonicalSessionId) || canonicalSessionId.includes("..")) {
    throw new Error("Expected a safe canonical session id");
  }
  return path.join(runtimePaths(projectRoot).localRoot, "opencode", "canonical", `${canonicalSessionId}.json`);
}

function matchingSessions(projectRoot, options) {
  const output = run(["session", "list", "--format", "json"], projectRoot, options);
  const sessions = output.trim() ? JSON.parse(output) : [];
  if (!Array.isArray(sessions)) throw new Error("OpenCode session list did not return an array");
  return sessions.filter((session) => samePath(session.directory, projectRoot));
}

// Project a canonical conversation through OpenCode's supported export/import
// CLI. The native id is deterministic, so re-running the projection updates
// the same OpenCode session instead of manufacturing another conversation.
export async function writeCanonical(projectRoot, canonical, options = {}) {
  if (!canonical || typeof canonical !== "object" || typeof canonical.id !== "string" || !Array.isArray(canonical.events)) {
    throw new Error("OpenCode canonical projection requires an id and events");
  }
  const projected = fromCanonical(canonical.events, {
    canonicalSessionId: canonical.id,
    nativeSessionId: options.nativeSessionId,
    title: canonical.title,
    directory: projectRoot,
    agent: options.agent,
    model: options.model,
    version: options.version,
  });
  const nativeSessionId = projected.data.info.id;
  const payload = `${JSON.stringify(projected.data, null, 2)}\n`;
  const nativeRevision = hashContent(payload);
  const sessions = matchingSessions(projectRoot, options);
  if (sessions.some((session) => session.id === nativeSessionId)
    && options.mapping?.canonicalRevision === options.canonicalRevision) {
    return { nativeSessionId, nativeRevision, diagnostics: projected.diagnostics, imported: false };
  }
  const file = projectionFile(projectRoot, canonical.id);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, payload, { encoding: "utf8", mode: 0o600 });
  run(["import", file], projectRoot, options);
  if (!matchingSessions(projectRoot, options).some((session) => session.id === nativeSessionId)) {
    throw new Error(`OpenCode import did not expose projected session ${nativeSessionId}`);
  }
  return { nativeSessionId, nativeRevision, diagnostics: projected.diagnostics, imported: true };
}

export function readCanonical(projectRoot, nativeSessionId, options = {}) {
  const content = run(["export", nativeSessionId], projectRoot, options);
  return toCanonical(content, { ...options, nativeSessionId, revision: hashContent(content) });
}

// OpenCode is the one agent whose history is only reachable through its CLI:
// answering "which sessions are this project's, and did any of them move?"
// means running `opencode session list`, because there is no directory to
// stat. That question is asked on every pass — including the durability
// watchdog's, every few seconds during a run — so the answer has to be enough
// to skip the expensive half: a session is re-exported only when the revision
// OpenCode reports for it moved, exactly like a file is re-read only when its
// mtime moved.
export async function capture(projectRoot, options = {}) {
  const ownsCursors = options.cursors === undefined;
  const cursors = options.cursors ?? loadCursors(projectRoot, options.environment);
  const sessions = matchingSessions(projectRoot, options);
  if (sessions.length === 0) {
    return { count: 0, changed: false, diagnostics: [{ kind: "missing-root", message: "Found no OpenCode sessions matching this workspace." }] };
  }
  const result = await syncDirectory(
    sessions.map((session) => ({
      relative: `${session.id}.json`,
      // `time.updated` is OpenCode's own revision for the session. Without it
      // there is nothing to compare, and the export has to be read again.
      stamp: session.time?.updated === undefined ? null : { revision: `${session.id}:${session.time.updated}` },
      produce: () => run(["export", session.id], projectRoot, options),
    })),
    portableRoot(projectRoot),
    null,
    cursors,
    agentId,
  );
  if (ownsCursors) await saveCursors(projectRoot, cursors, options.environment);
  return { count: sessions.length, changed: result.added + result.updated + result.removed > 0, diagnostics: [] };
}

export async function restore(projectRoot, options = {}) {
  const portable = portableRoot(projectRoot);
  const files = (await listFiles(portable)).filter((file) => file.endsWith(".json"));
  if (files.length === 0) {
    return { count: 0, added: 0, updated: 0, unchanged: 0 };
  }
  const localRoot = path.join(runtimePaths(projectRoot).localRoot, "opencode");
  const manifestFile = path.join(localRoot, "session-imports.json");
  const manifest = existsSync(manifestFile) ? JSON.parse(await readFile(manifestFile, "utf8")) : {};
  let imported = 0;
  let unchanged = 0;
  for (const relative of files) {
    const file = path.join(portable, relative);
    const hash = hashContent(await readFile(file));
    if (manifest[relative] === hash) {
      unchanged += 1;
      continue;
    }
    run(["import", file], projectRoot, options);
    manifest[relative] = hash;
    imported += 1;
  }
  await mkdir(localRoot, { recursive: true });
  await writeFile(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { count: files.length, added: imported, updated: 0, unchanged };
}

export async function status(projectRoot) {
  return { count: (await listFiles(portableRoot(projectRoot))).filter((file) => file.endsWith(".json")).length };
}
