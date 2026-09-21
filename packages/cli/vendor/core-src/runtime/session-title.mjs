import { AGENTS, isAgentId } from "./agents.mjs";
import { TOOL_BLOCKS, blockText, turnKind } from "./projection.mjs";

// What a session is called.
//
// A list of conversations is read by its titles: "claude 3f9a1c2b-4d5e-…" is
// not a name, and a dashboard that shows one has told the user nothing. So a
// title is resolved from the first thing that was actually written about the
// session — the name its own native store carries, the title the shared store
// already holds, or the first thing the person said — and only a session that
// has nothing to read at all is named after a short piece of its id.
//
// Every rule here is pure and reads nothing: the callers either have the
// events in hand or deliberately do not open them, and "which title" must cost
// the same either way.

const SNIPPET_LIMIT = 80;
const SHORT_ID_CHARS = 8;
const UNTITLED = "Untitled";
// A session id is what a placeholder title ends up carrying, so recognizing one
// is how an id-derived title is told apart from a title someone chose.
const UUID_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One line, no runs of whitespace: a title is never a paragraph's line breaks. */
export function collapseWhitespace(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

/**
 * The first thing the person said, as a title.
 *
 * Only a turn the person actually spoke becomes a title: a tool result filed
 * under the API's user role and a turn that carried no words at all are the
 * agent's own machinery, and a session named after its first tool call would be
 * named after the wrong speaker.
 */
export function sessionSnippet(events, limit = SNIPPET_LIMIT) {
  for (const event of events ?? []) {
    if (turnKind(event) !== "user") continue;
    const blocks = Array.isArray(event?.content) ? event.content : [];
    const text = collapseWhitespace(
      blocks.filter((block) => !TOOL_BLOCKS.has(block?.type)).map(blockText).filter(Boolean).join(" "),
    );
    if (text) return text.slice(0, limit).trim();
  }
  return null;
}

/** The agent a canonical session belongs to, from its source or from its id. */
export function sessionAgent(session) {
  const source = typeof session?.source === "string" ? session.source : "";
  if (isAgentId(source)) return source;
  const id = typeof session?.id === "string" ? session.id : "";
  return Object.keys(AGENTS).find((agentId) => id.startsWith(`${agentId}-`)) ?? null;
}

/** The native ids a canonical session is known by, from its own mappings. */
export function mappedNativeSessionIds(mappings) {
  return Object.values(mappings?.projections ?? {})
    .map((mapping) => mapping?.nativeSessionId)
    .filter((id) => typeof id === "string" && id);
}

// Every id this session answers to. The canonical id is `<agent>-<native id>`
// for an imported conversation, so it names the native session directly; a
// projected one is known only through its mapping, which the caller supplies.
function sessionIds(session, options = {}) {
  const agent = sessionAgent(session);
  const id = typeof session?.id === "string" ? session.id : "";
  const ids = [];
  if (agent && id.length > agent.length + 1 && id.startsWith(`${agent}-`)) ids.push(id.slice(agent.length + 1));
  for (const nativeSessionId of options.nativeSessionIds ?? []) {
    if (typeof nativeSessionId === "string" && nativeSessionId) ids.push(nativeSessionId);
  }
  return [...new Set(ids)];
}

/**
 * Whether a title says nothing about the session and may be replaced.
 *
 * A title that is empty, that *is* one of the session's own ids (bare, or as
 * the canonical id), or that is an agent's name followed by such an id, was
 * derived from an id and never chosen by anyone. Every other title — a snippet,
 * or the name a person typed — is left exactly as it is: a rename is not a
 * thing an import gets to undo.
 */
export function isAutoTitle(title, agentId, nativeSessionIds = []) {
  const text = collapseWhitespace(title);
  if (!text) return true;
  const ids = nativeSessionIds.filter((id) => typeof id === "string" && id);
  // The shapes above are what Avenic writes, and they are not the only way an
  // id ends up in the title field: a session file edited by hand, or one a
  // foreign tool created, may hold the id itself. "A reader is never shown a
  // raw id" is the promise, so the question is whether the title *is* an id,
  // not whether it has the shape this module happens to produce.
  const bare = agentId && text.startsWith(`${agentId}-`) ? text.slice(agentId.length + 1) : text;
  if (ids.includes(bare) || UUID_TOKEN.test(bare)) return true;
  if (!agentId || !text.startsWith(`${agentId} `)) return false;
  const token = text.slice(agentId.length + 1);
  // An id has no spaces in it; a sentence that starts with an agent's name and
  // continues in words is somebody's title.
  if (/\s/.test(token)) return false;
  if (ids.some((id) => id === token || id.startsWith(token))) return true;
  // The id a title carries may be one this reader cannot see — a conversation
  // created by a host, whose canonical id is not the native one. A uuid is
  // still recognisably an id rather than a name.
  return UUID_TOKEN.test(token);
}

/** The last resort: the shortest id the session has, never the whole one. */
function shortTitle(session, options = {}) {
  const agent = sessionAgent(session);
  if (!agent) return UNTITLED;
  const id = sessionIds(session, options)[0] ?? null;
  return id ? `${agent} ${id.slice(0, SHORT_ID_CHARS)}` : UNTITLED;
}

/**
 * What to display for a session that is already stored.
 *
 * The stored title wins whenever it says something; the turns are read only for
 * a session that has no title of its own, which is why a caller that cannot
 * afford to open an event log can still ask for a title it may show.
 */
export function resolveSessionTitle(session, events = [], options = {}) {
  const stored = collapseWhitespace(session?.title);
  if (stored && !isAutoTitle(stored, sessionAgent(session), sessionIds(session, options))) return stored;
  return sessionSnippet(events) ?? shortTitle(session, options);
}

/**
 * The title a native session brings with it.
 *
 * This is what a capture writes: the session's own name if its store has one,
 * the first thing the user said if it does not, and a short id only when the
 * conversation holds nothing yet that could name it.
 */
export function sessionTitleFor({ agentId, nativeSessionId, nativeTitle = null, events = [] }) {
  const explicit = collapseWhitespace(nativeTitle);
  if (explicit) return explicit;
  return sessionSnippet(events) ?? `${agentId} ${String(nativeSessionId).slice(0, SHORT_ID_CHARS)}`;
}
