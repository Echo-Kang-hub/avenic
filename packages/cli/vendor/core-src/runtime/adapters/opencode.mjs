import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { agentSessionsRoot, runtimePaths } from "../config.mjs";
import { loadCursors, saveCursors } from "../cursors.mjs";
import { hashContent, listFiles, samePath, syncDirectory } from "../sessions.mjs";
import { spawnExecutableChild, spawnExecutableSync } from "../process.mjs";
import { eventTimestamp, isConversationRole, nativeEventId } from "./canonical.mjs";
import { createHash } from "node:crypto";
import { PROJECTION_KIND, PROJECTION_SCHEMA_VERSION } from "../projection.mjs";

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
  // The session's own name. It is set by the user in OpenCode's own UI, or by
  // whichever host imported the session, so it is the best title there is —
  // and an export that nests its payload carries it in the same two places the
  // session id does.
  const title = exported.info?.title ?? exported.data?.info?.title ?? null;
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
  return { nativeSessionId, title, events, revision: options.revision ?? null };
}

function nativeId(prefix, value) {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function epoch(value) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

// Every OpenCode install ships this model, so it is the one projection that can
// always start. It is a fallback, not a choice: `writeCanonical` asks OpenCode
// for the model this environment resolves to first.
const BUILT_IN_MODEL = { id: "big-pickle", providerID: "opencode", variant: "default" };

export function fromCanonical(events, options = {}) {
  const canonicalSessionId = options.canonicalSessionId ?? "unknown";
  const sessionID = options.nativeSessionId ?? nativeId("ses", canonicalSessionId);
  const sessionModel = options.model ?? BUILT_IN_MODEL;
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
    // A message's model is a claim about what produced it. OpenCode can only
    // make that claim about its own runs: carrying another agent's provider and
    // model into an OpenCode session produces a conversation OpenCode cannot
    // start — the model belongs to a provider this machine may not have, which
    // is what surfaces as a 403 the first time the user continues it. The
    // producer of a foreign event stays in canonical history, which is where
    // fidelity is owed.
    const model = event.provider === agentId && event.model
      ? { providerID: event.provider, modelID: event.model }
      : messageModel;
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

// The model a projected session will run on. Avenic does not choose it: the
// user's own configuration does, and `debug config` is OpenCode reporting what
// that configuration resolves to — including through the config home Avenic
// scopes for project authentication, which a hand-parsed config file would
// miss. A CLI that cannot answer (an older build, a broken config) leaves the
// bundled default, which every install can run.
function resolvedModel(projectRoot, options) {
  if (options.model) return options.model;
  try {
    const resolved = JSON.parse(run(["debug", "config"], projectRoot, { ...options, timeoutMs: 10_000 }));
    if (typeof resolved?.model !== "string") return null;
    const [providerID, ...rest] = resolved.model.split("/");
    if (!providerID || rest.length === 0) return null;
    return { id: rest.join("/"), providerID, variant: "default" };
  } catch {
    return null;
  }
}

// Bootstrap discovery is capture-only: the official OpenCode CLI created the
// session, and afterwards we identify the newest one for this project.
export async function discoverNativeSession(projectRoot, options = {}) {
  const candidates = matchingSessions(projectRoot, options)
    .map((session) => ({ id: session.id, created: session.created ?? session.time?.created }))
    .filter((item) => item.id && Number.isFinite(item.created));
  const eligible = options.notBefore === undefined
    ? candidates
    : candidates.filter((item) => item.created >= options.notBefore);
  eligible.sort((left, right) => right.created - left.created);
  if (!eligible[0]?.id) throw new Error("OpenCode did not create a discoverable native session after launch");
  return eligible[0].id;
}

// How long a projection waits for OpenCode to offer a name before continuing
// under one of its own. A server that is going to answer does so within about a
// second, cold; anything slower is a build that cannot be asked.
const MINT_TIMEOUT_MS = 10_000;
const MINT_POLL_MS = 200;

function freeLoopbackPort() {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.on("error", () => resolve(null));
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// One asking of the server for a session. A session is named when it is made
// and an import never renames one, so the name has to travel with the asking.
async function askForSessionId(port, projectRoot, title) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(title ? { directory: projectRoot, title } : { directory: projectRoot }),
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) return null;
    const body = await response.json();
    return typeof body?.id === "string" && body.id ? body.id : null;
  } catch {
    return null;
  }
}

/**
 * Ask OpenCode to name a session.
 *
 * The provider console decodes the id a session is created under: a name
 * Avenic invented is refused when the user runs it — in the console's own
 * words, "OpenCode's free tier can only be used from within OpenCode" — while
 * one OpenCode minted runs. `serve` is the one surface that creates a session
 * without a model call, and `POST /session` names one without doing anything
 * else, which is exactly what a projection needs. The server is stopped along
 * with the projection: it is a way to ask a question, not a daemon.
 */
async function mintSessionId(projectRoot, title, options = {}) {
  const port = await freeLoopbackPort();
  if (!port) return null;
  let child;
  try {
    child = spawnExecutableChild("opencode", ["serve", "--port", String(port)], {
      cwd: projectRoot,
      env: options.environment ?? process.env,
      stdio: ["ignore", "ignore", "ignore"],
      spawn: options.spawn,
    });
  } catch {
    return null;
  }
  let exited = false;
  child.once?.("exit", () => { exited = true; });
  try {
    const deadline = Date.now() + MINT_TIMEOUT_MS;
    while (!exited && Date.now() < deadline) {
      const id = await askForSessionId(port, projectRoot, title);
      if (id) return id;
      await new Promise((resolve) => setTimeout(resolve, MINT_POLL_MS));
    }
    return null;
  } finally {
    try {
      if (child.terminateTree) child.terminateTree();
      else child.kill?.();
    } catch { /* the question is over; a process already gone is not a failure */ }
  }
}

// The name a projection already gave this session, read back from the payload
// Avenic wrote for it. The mapping normally carries it, but the mapping can be
// lost on its own, and losing it must not manufacture a second conversation.
async function projectedName(projectRoot, canonicalSessionId) {
  try {
    const payload = JSON.parse(await readFile(projectionFile(projectRoot, canonicalSessionId), "utf8"));
    const id = payload?.info?.id;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

/**
 * The name the projected session will carry, plus anything the user should
 * hear about how it got it. A projection being updated keeps the name it
 * already has, a session already projected keeps the name it was given, and
 * everything else is named by OpenCode — with a derived id as the last resort,
 * said out loud rather than quietly.
 */
async function nameSession(projectRoot, canonical, options = {}) {
  if (options.nativeSessionId) return { nativeSessionId: options.nativeSessionId, diagnostics: [] };
  const known = await projectedName(projectRoot, canonical.id);
  if (known) return { nativeSessionId: known, diagnostics: [] };
  const minted = await mintSessionId(projectRoot, canonical.title, options);
  if (minted) return { nativeSessionId: minted, diagnostics: [] };
  return {
    nativeSessionId: nativeId("ses", canonical.id),
    diagnostics: [{
      code: "derived_session_id",
      message: "OpenCode could not be asked for a session id; the session is projected under an id derived from the shared session.",
    }],
  };
}

// Project a canonical conversation through OpenCode's supported export/import
// CLI. The session's name is OpenCode's to give and is kept across projections,
// so re-running the projection updates the same OpenCode session instead of
// manufacturing another conversation.
export async function writeCanonical(projectRoot, canonical, options = {}) {
  if (!canonical || typeof canonical !== "object" || typeof canonical.id !== "string" || !Array.isArray(canonical.events)) {
    throw new Error("OpenCode canonical projection requires an id and events");
  }
  const naming = await nameSession(projectRoot, canonical, options);
  const projected = fromCanonical(canonical.events, {
    canonicalSessionId: canonical.id,
    nativeSessionId: naming.nativeSessionId,
    title: canonical.title,
    directory: projectRoot,
    agent: options.agent,
    model: resolvedModel(projectRoot, options) ?? BUILT_IN_MODEL,
    version: options.version,
  });
  const nativeSessionId = projected.data.info.id;
  const diagnostics = [...naming.diagnostics, ...projected.diagnostics];
  const payload = `${JSON.stringify(projected.data, null, 2)}\n`;
  const nativeRevision = hashContent(payload);
  const sessions = matchingSessions(projectRoot, options);
  if (sessions.some((session) => session.id === nativeSessionId)
    && options.mapping?.canonicalRevision === options.canonicalRevision) {
    return { nativeSessionId, nativeRevision, diagnostics, imported: false };
  }
  const file = projectionFile(projectRoot, canonical.id);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, payload, { encoding: "utf8", mode: 0o600 });
  run(["import", file], projectRoot, options);
  if (!matchingSessions(projectRoot, options).some((session) => session.id === nativeSessionId)) {
    throw new Error(`OpenCode import did not expose projected session ${nativeSessionId}`);
  }
  return { nativeSessionId, nativeRevision, diagnostics, imported: true };
}

export function resumeArguments(nativeSessionId) {
  return ["--session", nativeSessionId];
}

/**
 * OpenCode's projection is its own import: the shared conversation becomes one
 * of its sessions, and every later switch opens that session. Re-importing a
 * grown conversation updates the messages Avenic already projected — their ids
 * are derived from canonical event ids — instead of duplicating them, and a
 * switch with nothing new costs no work at all because the mapping is current.
 */
export async function projectCanonical(projectRoot, { session, events, mapping = null }, options = {}) {
  const result = await writeCanonical(projectRoot, { id: session.id, title: session.title, events }, {
    ...options,
    nativeSessionId: mapping?.nativeSessionId,
    mapping,
    canonicalRevision: options.canonicalRevision ?? null,
  });
  return {
    kind: PROJECTION_KIND.native,
    nativeSessionId: result.nativeSessionId,
    injected: result.imported ? events.filter((event) => PROJECTABLE_ROLES.has(event.role)).length : 0,
    materialized: !mapping,
    diagnostics: result.diagnostics ?? [],
    projection: {
      schemaVersion: PROJECTION_SCHEMA_VERSION,
      targetAgent: agentId,
      nativeSessionId: result.nativeSessionId,
      sessionId: session.id,
      turns: [],
      checkpoint: null,
      lastEventId: events.at(-1)?.id ?? null,
      hash: null,
      counts: { events: events.length },
    },
    launch: { argumentsList: ["--session", result.nativeSessionId] },
  };
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
// OpenCode reports a session's own revision as a millisecond stamp, and the
// installed CLI prints it flat (`updated`) in `session list --format json`
// while other builds nest it under `time`. Reading only one of the two means
// every pass decides nothing is known and exports every session again, which is
// the cost this cursor exists to avoid.
function sessionRevision(session) {
  const updated = session?.updated ?? session?.time?.updated;
  return updated === undefined ? null : { revision: `${session.id}:${updated}` };
}

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
      // Without a revision there is nothing to compare, and the export has to
      // be read again.
      stamp: sessionRevision(session),
      produce: () => run(["export", session.id], projectRoot, options),
    })),
    portableRoot(projectRoot),
    null,
    cursors,
    agentId,
    // OpenCode's store is the user's own and Avenic never snapshots or reverts
    // it, so a session missing from the list was deleted there: the project's
    // copy goes with it rather than being imported back on the next launch.
    { remove: true },
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
