// Native history belongs to the agents, so Avenic reads it defensively and
// reports what it could not use rather than repairing it. Every producer marks
// what happened with a `kind`; this is the single place that turns those into
// something a person reads, at the outermost layer of a command, once.
const KINDS = {
  "malformed-record": {
    level: "warning",
    text: ({ agentId, file, line, count }) =>
      `${label(agentId, file)}: skipped ${count ?? 1} unreadable record${(count ?? 1) === 1 ? "" : "s"}${line ? ` (first at line ${line})` : ""}. The rest of the history is intact.`,
  },
  "truncated-tail": {
    level: "note",
    text: ({ agentId, file }) =>
      `${label(agentId, file)}: the last record is incomplete, as a session being written has. Everything before it is imported.`,
  },
  "unreadable-session": {
    level: "warning",
    text: ({ agentId, file, message }) =>
      `${label(agentId, file)}: could not be read${message ? ` (${message})` : ""}. Native history was left untouched.`,
  },
  "unidentified-session": {
    level: "warning",
    text: ({ agentId, file }) => `${label(agentId, file)}: has no session id, so it cannot be tracked as shared history.`,
  },
  "missing-root": { level: "note", text: ({ message }) => message },
};

function label(agentId, file) {
  return `${agentId ?? "session"}${file ? ` ${file}` : ""}`;
}

function describe(diagnostic) {
  if (typeof diagnostic === "string") return { level: "note", text: diagnostic };
  const shape = KINDS[diagnostic?.kind];
  if (!shape) {
    // An unrecognized diagnostic is still shown; hiding it would be worse than
    // showing it without a level.
    return { level: "note", text: diagnostic?.message ?? null };
  }
  return { level: shape.level, text: shape.text(diagnostic) };
}

/**
 * Turn capture diagnostics into deduplicated lines for one command.
 * Repeating the same unreadable record on every pass is noise, and the same
 * source at the same revision cannot say anything new.
 */
export function formatSessionDiagnostics(diagnostics = []) {
  const warnings = new Set();
  const notes = new Set();
  for (const diagnostic of diagnostics ?? []) {
    const { level, text } = describe(diagnostic);
    if (!text) continue;
    (level === "warning" ? warnings : notes).add(text);
  }
  return { warnings: [...warnings], notes: [...notes] };
}
