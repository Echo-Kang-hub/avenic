import { readCanonicalSession } from "./canonical-sessions.mjs";
import { isControlEvent } from "./adapters/canonical.mjs";
import { TOOL_BLOCKS, agentLabel, blockText, eventAgent, turnKind } from "./projection.mjs";
import { mappedNativeSessionIds, resolveSessionTitle } from "./session-title.mjs";

// The canonical store is the one transcript a shared project has, so the one
// place that knows how to read it as a conversation lives here — not in a
// terminal renderer and not in a webview. A viewer asks for turns; how they are
// drawn is somebody else's problem.
//
// A turn is one thing a person said or one thing an agent answered, from
// whoever actually said it. Tool traffic is attached to the turn that ran it
// rather than presented as a speaker of its own.

const TRANSCRIPT_SCHEMA_VERSION = 1;

const TOOL_RESULT_BLOCKS = new Set(["tool_result", "function_call_output", "custom_tool_call_output"]);

function summarize(value, limit = 120) {
  if (value === undefined || value === null) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function toolTarget(input) {
  if (!input || typeof input !== "object") return summarize(input, 80);
  for (const key of ["command", "file_path", "path", "pattern", "query", "url", "skill", "name"]) {
    if (typeof input[key] === "string") return summarize(input[key], 100);
  }
  const keys = Object.keys(input);
  return keys.length ? `(${keys.slice(0, 4).join(", ")})` : "";
}

function toolFromBlock(block) {
  const name = block.name ?? (TOOL_RESULT_BLOCKS.has(block.type) ? "result" : block.type);
  if (TOOL_RESULT_BLOCKS.has(block.type)) {
    const text = typeof block.content === "string"
      ? block.content
      : Array.isArray(block.content)
        ? block.content.map((part) => part?.text ?? "").join("\n")
        : block.output;
    return { kind: "result", name, detail: summarize(text, 160) };
  }
  return { kind: "call", name, detail: toolTarget(block.input ?? block.arguments ?? block.params) };
}

function toolFromEvent(event) {
  const parts = Array.isArray(event.content) ? event.content : [];
  const block = parts.find((part) => TOOL_BLOCKS.has(part?.type)) ?? parts[0] ?? {};
  return toolFromBlock({ ...block, input: block.input ?? event.extensions?.codex?.payload?.input });
}

/**
 * The conversation as a list of turns.
 *
 * `limit` keeps the newest N turns, which is what a narrow viewer wants; the
 * default is the whole history, because "the complete shared history" is the
 * promise. Nothing is dropped for being foreign: a turn answered by another
 * agent is exactly what the viewer exists to show.
 */
export function transcriptTurns(events, { limit = 0 } = {}) {
  const turns = [];
  for (const event of events ?? []) {
    // A control record is transport, whether it was captured this round or is
    // still sitting in the store from before this rule existed.
    if (isControlEvent(event)) continue;
    const agent = eventAgent(event);
    const role = event?.role;
    if (role === "tool") {
      const tool = toolFromEvent(event);
      const previous = turns.at(-1);
      if (previous && previous.kind === "agent" && previous.agent === agent) {
        previous.tools.push(tool);
        continue;
      }
      turns.push({ id: event.id, kind: "tool", agent, speaker: agentLabel(agent), role, at: event.createdAt ?? null, text: "", tools: [tool], model: null, provider: null });
      continue;
    }
    if (role !== "user" && role !== "assistant") continue;
    const blocks = Array.isArray(event.content) ? event.content : [];
    const tools = blocks.filter((block) => TOOL_BLOCKS.has(block?.type)).map(toolFromBlock);
    const text = blocks.filter((block) => !TOOL_BLOCKS.has(block?.type)).map(blockText).filter(Boolean).join("\n").trim();
    if (!text && tools.length === 0) continue;
    // A tool result is filed by the API under role "user"; only the person's
    // own words are read as the person's, so an agent's tool traffic is never
    // shown as something the user ran.
    const kind = turnKind(event) === "user" ? "user" : "agent";
    turns.push({
      id: event.id,
      kind,
      agent,
      role,
      // "You" is the person at the keyboard; every other speaker is named for
      // the agent that produced the words.
      speaker: kind === "user" ? "You" : agentLabel(agent),
      at: event.createdAt ?? null,
      text,
      tools,
      model: event.model ?? null,
      provider: event.provider ?? null,
    });
  }
  return limit > 0 ? turns.slice(-limit) : turns;
}

function mappingState(mapping, lastEventId) {
  if (!mapping?.nativeSessionId) return "none";
  if (!mapping.lastCanonicalEventId) return "stale";
  return mapping.lastCanonicalEventId === lastEventId ? "current" : "stale";
}

/**
 * What a viewer needs before the turns: what this conversation is, who has
 * taken part, and which native session each agent is answering from.
 */
export function transcriptSummary(session, events, record = {}) {
  const list = events ?? [];
  const turns = transcriptTurns(list);
  const lastEventId = list.at(-1)?.id ?? null;
  const speakers = [];
  let userTurns = 0;
  const add = (agent) => {
    if (!speakers.includes(agent)) speakers.push(agent);
  };
  for (const turn of turns) {
    if (turn.kind === "user") { userTurns += 1; continue; }
    if (turn.agent && turn.agent !== "unknown") add(turn.agent);
  }
  const projections = Object.entries(record.mappings?.projections ?? {})
    .filter(([, mapping]) => mapping?.nativeSessionId)
    .map(([agentId, mapping]) => ({
      agentId,
      label: agentLabel(agentId),
      nativeSessionId: mapping.nativeSessionId,
      state: mappingState(mapping, lastEventId),
      lastSyncedAt: mapping.lastSyncedAt ?? null,
      provenance: mapping.provenance?.kind ?? null,
    }));
  return {
    schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    id: session?.id ?? null,
    // The title the stored record carries was resolved before it got here, but
    // a caller that passes its own session object gets the same answer: what
    // the session is called is never a raw id, whichever end you read it from.
    title: resolveSessionTitle(session, list, { nativeSessionIds: mappedNativeSessionIds(record?.mappings) }),
    revision: session?.revision ?? null,
    createdAt: session?.createdAt ?? null,
    updatedAt: session?.updatedAt ?? null,
    events: list.length,
    turns: turns.length,
    userTurns,
    agents: speakers,
    startedAt: list.at(0)?.createdAt ?? null,
    endedAt: lastEventId ? list.at(-1)?.createdAt ?? null : null,
    lastEventId,
    projections,
  };
}

/**
 * The whole thing in one call: read a canonical session and describe it.
 * Callers that already hold the record (the CLI does) pass it in rather than
 * paying for a second read.
 */
export async function readTranscript(projectRoot, id, options = {}) {
  const stored = options.record ?? await readCanonicalSession(projectRoot, id);
  const turns = transcriptTurns(stored.events, { limit: options.limit ?? 0 });
  const summary = transcriptSummary(stored.session, stored.events, stored);
  return { summary, turns, session: stored.session, events: stored.events };
}

// The one-line form of a turn, for lists and previews that have no room for a
// transcript. It is the same text the viewer shows, so a preview never
// disagrees with what opening it reveals.
/**
 * The conversation as data: the CLI's `sessions show <id> --json`, the VS Code
 * Sessions page's model, and whatever reads it next. One shape built in one
 * place — a renderer that re-listed these fields would keep printing yesterday's
 * transcript the first time a field was added here.
 */
export function transcriptModel({ summary, turns }) {
  const { schemaVersion, ...session } = summary;
  return { schemaVersion, session, turns: turns.map((turn) => ({ ...turn })) };
}

export function turnPreview(turn, limit = 90) {
  const body = turn.text || turn.tools.map((tool) => `[${tool.name}] ${tool.detail}`).join(" ");
  const single = body.replace(/\s+/g, " ").trim();
  return `${turn.speaker}: ${single.length > limit ? `${single.slice(0, limit)}…` : single}`;
}
