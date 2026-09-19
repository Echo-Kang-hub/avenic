import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { agentSessionsRoot, runtimePaths } from "../config.mjs";
import { cachedFileHead, knownDirectories, loadCursors, rememberDirectories, saveCursors } from "../cursors.mjs";
import {
  hashContent,
  listFiles,
  projectRootTransform,
  readFileHead,
  restoreInto,
  revertFrom,
  samePath,
  snapshotInto,
  syncDirectory,
} from "../sessions.mjs";
import { canonicalBlocks, eventTimestamp, isConversationRole, nativeEventId, parseJsonLines } from "./canonical.mjs";
import { NATIVE_BUDGET, PROJECTION_KIND, buildProjection, renderBriefing } from "../projection.mjs";

export const agentId = "claude";

export function toCanonical(content, options = {}) {
  const parsed = parseJsonLines(content, agentId, { diagnostics: true });
  const records = parsed.records;
  const nativeSessionId = options.nativeSessionId ?? records.find((record) => typeof record.sessionId === "string")?.sessionId ?? "unknown";
  const events = records.flatMap((record, index) => {
    const role = record.message?.role;
    if (!isConversationRole(role)) return [];
    return [{
      id: nativeEventId(agentId, nativeSessionId, record.uuid, index, record),
      agent: agentId,
      role,
      createdAt: eventTimestamp(record.timestamp),
      content: canonicalBlocks(record.message.content),
      model: record.message.model,
      provider: "anthropic",
      extensions: { claude: { record, message: record.message } },
    }];
  });
  return { nativeSessionId, events, diagnostics: parsed.diagnostics, revision: options.revision ?? null };
}

// Claude Code has no supported way to append to a transcript, and inventing one
// by writing its private session files is exactly the kind of handoff a switch
// is supposed to avoid. What it does support is resuming a session with context
// appended to the system prompt, which is where the shared turns go: they reach
// the model in order, they are not shown as the user's own words, and the
// session itself stays a normal Claude session.
//
// The session id is derived from the canonical session, so the mapping is
// stable from the first launch and the same id can be re-created if the user
// deletes the transcript.
// The shared turns reach Claude in the launch that carries them, not in the
// session: `--system-prompt-snapshot off` keeps them out of the transcript, so
// every switch re-renders the delta instead of assuming the last one is still
// there. The mapping is still what says which native session to resume.
//
// The turns travel as a file, not as an argument, so the budget that used to
// exist for cmd.exe's command-line limit does not apply: a turn arrives whole.
export const projectionIsDurable = false;

export function resumeArguments(nativeSessionId) {
  return ["--resume", nativeSessionId];
}

// The id this adapter would give a session it has never projected. A fallback
// launch (no projection available) still has to name a session, and naming the
// same one keeps the mapping stable whichever path ran.
export function nativeSessionIdFor(canonicalSessionId) {
  return claudeSessionId(canonicalSessionId);
}

export function claudeSessionId(canonicalSessionId) {
  const hex = createHash("sha256").update(`avenic:${canonicalSessionId}`).digest("hex").slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export async function projectCanonical(projectRoot, { session, events, mapping = null }, options = {}) {
  const nativeSessionId = mapping?.nativeSessionId ?? claudeSessionId(session?.id ?? "session");
  const projection = buildProjection({ session, events, targetAgent: agentId, nativeSessionId, budget: NATIVE_BUDGET });
  const briefing = projection.turns.length > 0 || projection.checkpoint ? renderBriefing(projection) : null;
  const argumentsList = mapping
    ? ["--resume", nativeSessionId]
    : ["--session-id", nativeSessionId];
  if (briefing) {
    // The briefing goes in as a file, not as an argument. On Windows the
    // official CLI is reached through a .cmd shim, and cmd.exe ends the command
    // at the first newline inside a quoted argument: an inlined briefing
    // arrives as its first line and nothing else. A path survives that, and it
    // survives the command-line length limit a long conversation would hit.
    const file = await writeBriefingFile(projectRoot, session?.id ?? "session", briefing);
    // Without this the first briefing would be recorded and replayed on every
    // later resume, so a delta would never replace the one before it.
    argumentsList.push("--append-system-prompt-file", file, "--system-prompt-snapshot", "off");
  }
  return {
    kind: PROJECTION_KIND.briefing,
    nativeSessionId,
    injected: projection.turns.length,
    materialized: !mapping,
    projection,
    briefing,
    launch: { argumentsList },
  };
}

// One deterministic file per canonical session, rewritten only when its content
// moved: a switch that carries no new turns must not touch the disk, and a
// briefing left behind stays inspectable next to the session it describes.
async function writeBriefingFile(projectRoot, canonicalSessionId, briefing) {
  const directory = path.join(runtimePaths(projectRoot).localRoot, agentId, "briefing");
  const file = path.join(directory, `${canonicalSessionId}.md`);
  const existing = existsSync(file) ? await readFile(file, "utf8") : null;
  if (existing !== `${briefing}\n`) {
    await mkdir(directory, { recursive: true });
    await writeFile(file, `${briefing}\n`, "utf8");
  }
  return file;
}

// Reads one known native session only. It never consults configuration or
// credentials; callers supply the launch environment that is already active.
export async function readCanonical(projectRoot, nativeSessionId, options = {}) {
  for (const native of (await discoverNativeProjectDirectories(projectRoot, options.environment)).directories) {
    for (const relative of await listFiles(native)) {
      if (!isTranscript(relative)) continue;
      const content = await readFile(path.join(native, relative), "utf8");
      const parsed = toCanonical(content);
      if (parsed.nativeSessionId === nativeSessionId) {
        return { ...parsed, revision: hashContent(content) };
      }
    }
  }
  throw new Error(`Claude native session is unavailable: ${nativeSessionId}`);
}

export function claudeProjectKey(projectRoot) {
  return path.resolve(projectRoot).replace(/[^a-zA-Z0-9]/g, "-");
}

// Whether any copy of one conversation still exists for this project. The
// portable store is the durable one; native storage counts too, because a run
// that is live right now keeps its session there until the exit capture. A
// mapping can outlive both — that is the "ghost mapping" a revert plus an old
// deletion pass used to leave behind, where `claude --resume <id>` answers
// "No conversation found with session ID" — and status must read that as
// missing rather than current.
export async function hasProjectCopy(projectRoot, nativeSessionId, options = {}) {
  if (!nativeSessionId) return false;
  const { native, portable } = locations(projectRoot, options.environment);
  const name = `${nativeSessionId}.jsonl`;
  return existsSync(path.join(portable, name)) || existsSync(path.join(native, name));
}

function locations(projectRoot, environment = process.env) {
  const claudeHome = environment.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude");
  return {
    native: path.join(claudeHome, "projects", claudeProjectKey(projectRoot)),
    portable: agentSessionsRoot(projectRoot, "claude"),
  };
}

// A Claude transcript of the conversation itself. Subagent transcripts live
// beside their parent and belong to it.
function isTranscript(relative) {
  return relative.endsWith(".jsonl") && !relative.includes(`${path.sep}subagents${path.sep}`);
}

// The first record that names a directory is the session's cwd; later records
// repeat it. The head is enough, and parsing it is the shared JSONL reader.
async function readCwdHead(file) {
  try {
    const records = parseJsonLines(await readFileHead(file), agentId);
    return records.find((record) => typeof record.cwd === "string")?.cwd ?? null;
  } catch {
    return null;
  }
}

// A session's cwd never changes while the file that records it is untouched,
// so the head read is cached against the file's stamp. Without this, every
// launch reopens the head of every Claude session on the machine.
function jsonlCwd(file, cursors) {
  return cachedFileHead(cursors, agentId, file, () => readCwdHead(file));
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
    const rootSessions = files.filter(isTranscript);
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
    projectRootTransform(projectRoot),
    cursors,
    agentId,
  );
  if (ownsCursors) await saveCursors(projectRoot, cursors, options.environment);
  return {
    count: sources.filter(({ relative }) => isTranscript(relative)).length,
    changed: result.added + result.updated + result.removed > 0,
    diagnostics: discovery.diagnostics,
  };
}

export async function restore(projectRoot, options = {}) {
  const { native, portable } = locations(projectRoot, options.environment);
  const ownsCursors = options.cursors === undefined;
  const cursors = options.cursors ?? loadCursors(projectRoot, options.environment);
  const result = await restoreInto(portable, await listFiles(portable), native,
    projectRootTransform(projectRoot, { restore: true }), { cursors, agentId });
  if (ownsCursors) await saveCursors(projectRoot, cursors, options.environment);
  return result;
}

export async function status(projectRoot) {
  const { portable } = locations(projectRoot);
  const files = await listFiles(portable);
  return { count: files.filter(isTranscript).length };
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
