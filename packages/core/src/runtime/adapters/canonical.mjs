import { createHash } from "node:crypto";

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

export function textBlocks(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  const blocks = [];
  for (const part of content) {
    if (typeof part === "string") blocks.push({ type: "text", text: part });
    else if (part && typeof part === "object" && typeof part.text === "string") blocks.push({ type: "text", text: part.text });
  }
  return blocks;
}

export function eventTimestamp(value) {
  return timestamp(value);
}

export function readonlyProjection(events) {
  return { capability: "read-only", events };
}
