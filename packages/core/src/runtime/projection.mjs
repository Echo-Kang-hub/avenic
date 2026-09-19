import { createHash } from "node:crypto";

// One canonical conversation can be answered by several agents. This module
// turns canonical events into the *shape* each agent can actually receive, and
// nothing else: it never writes a native store, never invents a transcript and
// never calls a model. Adapters own the transport; this owns the meaning.
//
// The order of preference, highest first:
//   1. append to the target's own native history (Codex can do this officially)
//   2. a structured briefing the target reads as context (Claude Code)
//   3. a one-shot handoff prompt (only when neither of the above is possible)
// The projection is always a *delta*: events already living in the native
// session being resumed are left out, so a switch costs one delta, not a
// replay of the whole conversation.

export const PROJECTION_SCHEMA_VERSION = 1;
export const PROJECTION_KIND = {
  native: "native-history",
  briefing: "structured-briefing",
  handoff: "handoff-prompt",
};

// The budget is the only thing that decides how much of a conversation
// travels; it is never a per-turn limit. Handing over a clipped answer is
// handing over a different answer, which is the failure Shared mode exists to
// remove, so a turn is delivered whole unless it alone would blow the budget.
export const BRIEFING_BUDGET = 6_000;
export const NATIVE_BUDGET = 400_000;
const TURN_TEXT_LIMIT = 2_000;
const CHECKPOINT_REQUESTS = 5;
const CHECKPOINT_REQUEST_LIMIT = 240;

const AGENT_LABELS = { claude: "Claude", codex: "Codex", opencode: "OpenCode" };

export function agentLabel(agentId) {
  return AGENT_LABELS[agentId] ?? (agentId ? agentId[0].toUpperCase() + agentId.slice(1) : "Unknown");
}

// Provenance used to live only inside the event id. New events carry it as a
// field as well; old ones are read by prefix so an upgrade does not strand a
// project's existing history.
export function eventAgent(event) {
  if (typeof event?.agent === "string" && event.agent) return event.agent;
  const id = typeof event?.id === "string" ? event.id : "";
  const separator = id.indexOf(":");
  return separator > 0 ? id.slice(0, separator) : "unknown";
}

export function eventNativeSession(event, agentId) {
  const prefix = `${agentId}:`;
  const id = typeof event?.id === "string" ? event.id : "";
  if (!id.startsWith(prefix)) return null;
  const rest = id.slice(prefix.length);
  const separator = rest.indexOf(":");
  return separator > 0 ? rest.slice(0, separator) : null;
}

export function blockText(block) {
  if (!block || typeof block !== "object") return "";
  if (typeof block.text === "string") return block.text;
  if (block.type === "tool_use") {
    const name = block.name ?? "tool";
    const input = summarizeInput(block.input);
    return `[ran ${name}${input ? ` ${input}` : ""}]`;
  }
  if (block.type === "tool_result") {
    const text = typeof block.content === "string"
      ? block.content
      : Array.isArray(block.content)
        ? block.content.map((part) => part?.text ?? "").join("\n")
        : "";
    return `[tool result${text ? `: ${text.trim().slice(0, 400)}` : ""}]`;
  }
  if (typeof block.reasoning === "string") return block.reasoning;
  return "";
}

function summarizeInput(input) {
  if (input === undefined || input === null) return "";
  if (typeof input === "string") return input.slice(0, 160);
  if (typeof input !== "object") return String(input).slice(0, 160);
  for (const key of ["command", "file_path", "path", "pattern", "query", "url", "skill"]) {
    if (typeof input[key] === "string") return input[key].slice(0, 160);
  }
  const keys = Object.keys(input).slice(0, 4);
  return keys.length ? `(${keys.join(", ")})` : "";
}

export function eventText(event) {
  const parts = Array.isArray(event?.content) ? event.content : [];
  return parts.map(blockText).filter(Boolean).join("\n").trim();
}

function clamp(value, limit) {
  const text = String(value ?? "");
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

// A projection never repeats what the target can already read in its own
// transcript. `nativeSessionId` identifies that transcript — or, when a mapping
// resolves to more than one native session (a Codex sub-agent thread is resumed
// through its parent), the set of transcripts the target already has.
export function projectableEvents(events, { targetAgent, nativeSessionId = null } = {}) {
  const owned = new Set([].concat(nativeSessionId ?? []).filter(Boolean));
  if (owned.size === 0) return events;
  return events.filter((event) => !(eventAgent(event) === targetAgent && owned.has(eventNativeSession(event, targetAgent))));
}

function checkpointFor(events) {
  const users = events.filter((event) => event.role === "user").map(eventText).filter(Boolean);
  const tools = events.filter((event) => event.role === "tool").length;
  return {
    events: events.length,
    from: events.at(0)?.createdAt ?? null,
    to: events.at(-1)?.createdAt ?? null,
    agents: [...new Set(events.map(eventAgent))],
    goal: users.length ? clamp(users[0], CHECKPOINT_REQUEST_LIMIT) : null,
    requests: users.slice(-CHECKPOINT_REQUESTS).map((value) => clamp(value, CHECKPOINT_REQUEST_LIMIT)),
    tools,
  };
}

/**
 * Turn canonical events into the turns a target agent should receive.
 *
 * `turns` is the part that fits the budget, newest last. Everything older is
 * folded into `checkpoint` — deterministic, no model call, so the same history
 * always produces the same projection (which is what makes the mapping hash
 * meaningful).
 */
export function buildProjection({ session, events, targetAgent, nativeSessionId = null, budget = BRIEFING_BUDGET } = {}) {
  const projectable = projectableEvents(events ?? [], { targetAgent, nativeSessionId });
  const turns = [];
  let used = 0;
  let index = projectable.length - 1;
  for (; index >= 0; index -= 1) {
    const event = projectable[index];
    const text = eventText(event);
    if (!text) continue;
    const clipped = clamp(text, Math.max(TURN_TEXT_LIMIT, budget));
    const cost = clipped.length + 32;
    // The newest turn is always kept, even if it alone exceeds the budget:
    // dropping it would hand the next agent a history that stops mid-sentence.
    if (turns.length > 0 && used + cost > budget) break;
    turns.unshift({
      eventId: event.id,
      role: event.role,
      agent: eventAgent(event),
      text: clipped,
      createdAt: event.createdAt ?? null,
    });
    used += cost;
  }
  const checkpoint = index >= 0 ? checkpointFor(projectable.slice(0, index + 1)) : null;
  const lastEventId = projectable.at(-1)?.id ?? null;
  const hash = createHash("sha256")
    .update(JSON.stringify({ version: PROJECTION_SCHEMA_VERSION, targetAgent, nativeSessionId, checkpoint, turns }))
    .digest("hex");
  return {
    schemaVersion: PROJECTION_SCHEMA_VERSION,
    targetAgent,
    nativeSessionId,
    sessionId: session?.id ?? null,
    turns,
    checkpoint,
    lastEventId,
    hash,
    counts: { total: events?.length ?? 0, projected: turns.length, skipped: (events?.length ?? 0) - projectable.length },
  };
}

function stamp(value) {
  if (!value) return "unknown time";
  return String(value).replace("T", " ").slice(0, 16);
}

/**
 * The briefing a target agent reads as context. It is written as a transcript
 * with speakers, because that is what it is — a conversation other agents and
 * the user already had. Nobody's words are put in anyone else's mouth.
 */
export function renderBriefing(projection, { heading = "Avenic shared session" } = {}) {
  const lines = [`# ${heading}`, ""];
  lines.push("This project keeps one conversation across agents. The turns below are already part of it;");
  lines.push("continue from them instead of asking the user to repeat anything.");
  lines.push("");
  const checkpoint = projection.checkpoint;
  if (checkpoint) {
    const range = `${stamp(checkpoint.from)} → ${stamp(checkpoint.to)}`;
    lines.push(`[condensed] ${checkpoint.events} earlier events (${range}) from ${checkpoint.agents.join(", ") || "unknown"}` +
      `${checkpoint.tools ? `, including ${checkpoint.tools} tool results` : ""}.`);
    if (checkpoint.goal) lines.push(`[condensed] original request: ${checkpoint.goal}`);
    for (const request of checkpoint.requests ?? []) lines.push(`[condensed] later request: ${request}`);
    lines.push("");
  }
  for (const turn of projection.turns) {
    const speaker = turn.role === "user" ? "User" : `${agentLabel(turn.agent)} (${turn.role})`;
    lines.push(`${speaker}: ${turn.text}`);
    lines.push("");
  }
  if (!projection.turns.length && !checkpoint) lines.push("(no earlier turns)");
  return lines.join("\n").trimEnd();
}

/**
 * The same projection as model-visible Responses API items, in the order they
 * happened. Only user/assistant turns become messages: a tool call the target
 * cannot answer would be worse than the summary of it that is already inside
 * the assistant turn.
 */
export function projectionItems(projection, { idPrefix = "avenic_evt_" } = {}) {
  return projection.turns
    .filter((turn) => turn.role === "user" || turn.role === "assistant")
    .map((turn, position) => {
      const foreign = turn.role !== "user" && turn.agent !== projection.targetAgent;
      const text = foreign ? `${agentLabel(turn.agent)}: ${turn.text}` : turn.text;
      return {
        type: "message",
        id: `${idPrefix}${position}_${createHash("sha1").update(turn.eventId).digest("hex").slice(0, 12)}`,
        role: turn.role === "assistant" ? "assistant" : "user",
        content: [{ type: turn.role === "assistant" ? "output_text" : "input_text", text }],
      };
    });
}
