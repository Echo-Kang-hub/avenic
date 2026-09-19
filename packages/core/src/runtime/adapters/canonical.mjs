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

export function readonlyProjection(events) {
  return { capability: "read-only", events };
}
