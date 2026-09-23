import { createHash } from "node:crypto";
import { isControlEvent, spokenLocalCommand } from "./adapters/canonical.mjs";

const HANDOFF_SCHEMA_VERSION = 1;
// Keep rehydration prompts bounded even when a legacy project has thousands
// of canonical events. The append-only canonical store remains complete; only
// the model-visible semantic handoff is compacted.
const MAX_TRANSCRIPT_EVENTS = 12;
const MAX_EVENT_TEXT = 1_200;

function text(event) {
  return spokenLocalCommand((event.content ?? []).filter((part) => part?.type === "text").map((part) => part.text).join("\n").trim());
}

function compact(value) {
  return value.length > MAX_EVENT_TEXT ? `${value.slice(0, MAX_EVENT_TEXT)}\n[truncated]` : value;
}

export function deriveState(events) {
  // What the CLI wrote for itself is not a goal and not a task: a store an
  // older version wrote still holds those records (see adapters/canonical.mjs).
  const spoken = (events ?? []).filter((event) => !isControlEvent(event));
  const users = spoken.filter((event) => event.role === "user").map(text).filter(Boolean);
  const assistants = spoken.filter((event) => event.role === "assistant").map(text).filter(Boolean);
  return {
    schemaVersion: HANDOFF_SCHEMA_VERSION,
    goal: users[0] ?? null,
    currentTask: users.at(-1) ?? null,
    completed: assistants.filter((value) => /\b(completed|done|implemented|fixed)\b/i.test(value)).slice(-10),
    pending: users.length > 1 ? users.at(-1) : null,
    decisions: [],
    relevantFiles: [],
    blockers: [],
    warnings: [],
  };
}

// A compact, deterministic rehydration payload. Native adapters decide how to
// submit it; this layer deliberately does not fabricate native transcripts.
export function buildHandoff({ session, events, targetAgent, lastCanonicalEventId = null }) {
  const start = lastCanonicalEventId ? events.findIndex((event) => event.id === lastCanonicalEventId) + 1 : 0;
  const delta = events.slice(Math.max(0, start));
  const state = session.state && typeof session.state === "object"
    ? session.state
    : deriveState(events);
  // Canonical history remains complete. A launcher receives only a bounded,
  // recent semantic transcript so legacy projects cannot exceed CLI/context
  // limits during first bootstrap.
  const transcript = delta.slice(-MAX_TRANSCRIPT_EVENTS)
    .filter((event) => !isControlEvent(event))
    .map((event) => `- ${event.role}: ${compact(text(event))}`)
    .filter((line) => !line.endsWith(": "));
  const markdown = [
    `# Avenic continuation (${targetAgent})`,
    `Goal: ${state.goal ?? "Unknown"}`,
    `Current task: ${state.currentTask ?? state.pending ?? "Continue the shared session."}`,
    state.completed.length ? `Completed work:\n${state.completed.map((value) => `- ${value}`).join("\n")}` : "",
    `Project: ${session.project?.cwd ?? "Unknown"}`,
    `Source provenance: ${session.provenance?.source ?? session.source ?? "unknown"}`,
    transcript.length ? `New shared events since your last sync:\n${transcript.join("\n")}` : "No new shared events.",
  ].filter(Boolean).join("\n\n");
  const hash = createHash("sha256").update(JSON.stringify({ version: HANDOFF_SCHEMA_VERSION, sessionId: session.id, targetAgent, lastCanonicalEventId, delta, state })).digest("hex");
  return { schemaVersion: HANDOFF_SCHEMA_VERSION, targetAgent, delta, state, markdown, hash, lastCanonicalEventId: delta.at(-1)?.id ?? lastCanonicalEventId };
}
