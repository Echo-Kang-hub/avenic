import { createHash } from "node:crypto";

// The roles a canonical conversation can hold. A native record with any other
// role (a tool result, an internal marker) is not a conversation event.
export const CONVERSATION_ROLES = new Set(["user", "assistant", "system", "tool"]);

export function isConversationRole(role) {
  return typeof role === "string" && CONVERSATION_ROLES.has(role);
}

function timestamp(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number") return new Date(value).toISOString();
  return new Date(0).toISOString();
}

export function parseJsonLines(content, agentId, options = {}) {
  if (typeof content !== "string") throw new Error(`${agentId} native session must be text`);
  const records = [];
  const diagnostics = [];
  const lines = content.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      const hasLaterContent = lines.slice(index + 1).some((later) => later.trim());
      diagnostics.push({
        agentId,
        line: index + 1,
        kind: hasLaterContent ? "malformed-record" : "truncated-tail",
        message: `Malformed ${agentId} JSONL record at line ${index + 1}`,
      });
    }
  }
  return options.diagnostics ? { records, diagnostics } : records;
}

export function nativeEventId(agentId, nativeSessionId, nativeId, index, record) {
  if (typeof nativeId === "string" && nativeId) return `${agentId}:${nativeSessionId}:${nativeId}`;
  const digest = createHash("sha256").update(JSON.stringify(record)).digest("hex").slice(0, 20);
  return `${agentId}:${nativeSessionId}:${index}:${digest}`;
}

// A tool result can be a whole command's output. Keeping it verbatim would make
// every canonical append rewrite megabytes, so it is kept as evidence — enough
// to see what ran and what came back — with the original size recorded.
const MAX_TOOL_RESULT = 8_000;

function flattenResult(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((part) => (typeof part === "string" ? part : part?.text ?? "")).join("\n");
  if (value && typeof value === "object" && typeof value.text === "string") return value.text;
  return value === undefined || value === null ? "" : JSON.stringify(value);
}

/**
 * The conversation blocks a canonical event keeps.
 *
 * Text is text; tool calls and their results are part of what happened and stay
 * (provenance needs them: "who ran what" is the state a switch has to preserve).
 * Reasoning and provider-encrypted blobs are model-internal — they are dropped
 * rather than copied into an append-only store that every agent can read.
 */
export function canonicalBlocks(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  const blocks = [];
  for (const part of content) {
    if (typeof part === "string") {
      blocks.push({ type: "text", text: part });
      continue;
    }
    if (!part || typeof part !== "object") continue;
    if (typeof part.text === "string") {
      blocks.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type === "tool_use" || part.type === "function_call" || part.type === "custom_tool_call") {
      blocks.push({ type: "tool_use", name: part.name ?? "tool", input: part.input ?? part.arguments ?? null });
      continue;
    }
    if (part.type === "tool_result" || part.type === "function_call_output" || part.type === "custom_tool_call_output") {
      const result = flattenResult(part.content ?? part.output);
      blocks.push(result.length > MAX_TOOL_RESULT
        ? { type: "tool_result", content: result.slice(0, MAX_TOOL_RESULT), truncated: true, originalLength: result.length }
        : { type: "tool_result", content: result });
    }
  }
  return blocks;
}

export function eventTimestamp(value) {
  return timestamp(value);
}

// ── The conversation boundary ────────────────────────────────────────────────
//
// A native transcript is not a conversation: a CLI writes its own machinery
// into the same file — local-command envelopes, caveats, meta records — and
// the API files a tool's answer under the user's role. The rules below are the
// one place that tells the user's own words apart from transport, so every
// reader (the transcript view, the cross-agent projection, titles) answers the
// same way instead of each filtering for itself.

// What a CLI wraps around a local command it ran for itself. These records
// document the CLI's own machinery; nobody said them out loud.
const LOCAL_COMMAND_MARKERS = [
  "<local-command-caveat>",
  "<local-command-stdout>",
  "<command-name>",
  "<command-message>",
  "<command-args>",
];

// A bare local command typed at the CLI's prompt, with no words of its own.
// An argumented line (`/goal …`, `/review the diff`) is the person speaking.
const BARE_LOCAL_COMMAND = /^\/(clear|compact|resume|login|logout|status|model|config|help)$/;

// The elements a CLI wraps around a local command it ran for itself. What the
// person wrote sits inside `<command-args>`; the envelope around it is the
// CLI's own paperwork and never anybody's words.
const COMMAND_ARGS_ELEMENT = /<command-args>([\s\S]*?)<\/command-args>/g;
const LOCAL_COMMAND_ELEMENTS = /<(local-command-caveat|local-command-stdout|command-name|command-message|command-args)>([\s\S]*?)<\/\1>/g;

/**
 * What the person said in a local-command record: the arguments they typed and
 * anything they wrote outside the envelope — empty when the record is the CLI
 * talking to itself. Text carrying no envelope comes back unchanged.
 */
export function spokenLocalCommand(text) {
  if (typeof text !== "string" || !LOCAL_COMMAND_MARKERS.some((marker) => text.includes(marker))) return text;
  const spoken = text.matchAll(COMMAND_ARGS_ELEMENT);
  const args = [...spoken].map((match) => match[1]).join("\n");
  return `${text.replace(LOCAL_COMMAND_ELEMENTS, " ")}\n${args}`.trim();
}

function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => typeof part?.text === "string").map((part) => part.text).join("\n");
}

/**
 * Whether a native record is the CLI talking to itself. Only the user's side
 * can be a control record: an assistant explaining `<command-name>` is
 * answering, not logging a command.
 */
export function isLocalCommandRecord(role, content) {
  if (role !== "user") return false;
  const text = messageText(content).trim();
  if (!text) return false;
  // An envelope is transport only when nothing of the person's survived it. A
  // `/goal …` whose arguments are the words that started the whole session is
  // the person speaking, and dropping it deletes the session's reason to exist.
  if (LOCAL_COMMAND_MARKERS.some((marker) => text.includes(marker))) return !spokenLocalCommand(text);
  return BARE_LOCAL_COMMAND.test(text);
}

/**
 * The same rule, asked of a canonical event rather than a native record.
 *
 * A store written by an older version still holds the records that version
 * accepted, and it keeps the record it was made from — so the CLI's own meta
 * mark is still readable, and everything else is read from the role and the
 * content. Readers apply this one instead of filtering for themselves.
 */
export function isControlEvent(event) {
  if (event?.extensions?.claude?.record?.isMeta === true) return true;
  return isLocalCommandRecord(event?.role, event?.content);
}

/**
 * A native record as a conversation event, or null when it is not one.
 *
 * Transport with nothing to say never enters the timeline: a record marked as
 * meta, a local-command envelope, a thinking-only assistant record (the
 * reasoning is model-internal and dropped, leaving nothing else), an empty
 * message. A record whose content is only a tool's answer is the agent's own
 * machinery and takes the tool role, whatever role the API filed it under.
 */
export function normalizedRecord({ role, content, control = false }) {
  if (control) return null;
  const blocks = canonicalBlocks(content)
    // The envelope comes off here, once: what is stored is what the person
    // said, and no reader has to know the CLI's markup to read it.
    .map((block) => (block?.type === "text" && typeof block.text === "string" ? { ...block, text: spokenLocalCommand(block.text) } : block))
    .filter((block) => block.type !== "text" || block.text.trim() !== "");
  if (blocks.length === 0) return null;
  const toolOnly = !blocks.some((block) => block.type === "text" || block.type === "tool_use")
    && blocks.some((block) => block.type === "tool_result");
  return { role: role === "user" && toolOnly ? "tool" : role, blocks };
}
