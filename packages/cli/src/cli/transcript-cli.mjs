import { agentLabel, readTranscript, transcriptModel, turnPreview } from "#core";
import { columns, displayWidth, field, intro, note, palette, section, truncate } from "./prompts.mjs";

// The canonical transcript, drawn. The reading is core's (`readTranscript`);
// this file only decides what a conversation looks like on a terminal: a
// heading, one speaker per turn, and the tool traffic of that turn hung off the
// rail underneath it.

const BODY_WIDTH = 96;
const BODY_LINES = 8;

function stamp(value) {
  if (!value) return "";
  return String(value).replace("T", " ").slice(0, 16);
}

function clock(value) {
  if (!value) return "";
  return String(value).slice(11, 16);
}

// A turn body is wrapped to the terminal, never squeezed into one very long
// line: a transcript that has to be scrolled sideways is not readable.
function wrap(text, width) {
  const lines = [];
  for (const paragraph of String(text).split(/\r?\n/)) {
    if (!paragraph.trim()) {
      lines.push("");
      continue;
    }
    let rest = paragraph.trim();
    while (displayWidth(rest) > width) {
      let cut = width;
      while (cut > 8 && displayWidth(rest.slice(0, cut)) > width) cut -= 1;
      const space = rest.lastIndexOf(" ", cut);
      const at = space > width * 0.6 ? space : cut;
      lines.push(rest.slice(0, at));
      rest = rest.slice(at).trimStart();
    }
    lines.push(rest);
  }
  return lines;
}

function speakerLine(colors, turn, width) {
  const at = turn.at ? `  ${colors.muted(clock(turn.at))}` : "";
  const who = turn.kind === "user" ? colors.strong(turn.speaker) : colors.brand(turn.speaker);
  const model = turn.model ? `  ${colors.muted(truncate(turn.model, 24))}` : "";
  return truncate(`${who}${at}${model}`, width);
}

function toolLine(colors, tool, width) {
  const mark = tool.kind === "result" ? "←" : "→";
  const body = `[${tool.name}]${tool.detail ? ` ${tool.detail}` : ""}`;
  return `${colors.muted(mark)}  ${colors.muted(truncate(body, width - 3))}`;
}

/**
 * Draw one transcript.
 *
 * `limit` shows the newest turns and says so, because a long shared session
 * outlives any terminal buffer; the default is the whole conversation.
 */
export function printTranscript(stdout, { summary, turns }, options = {}) {
  const colors = options.colors ?? palette(stdout, options.environment ?? process.env);
  const width = Math.max(40, Math.min(columns(stdout), options.maxWidth ?? 120));
  const bodyWidth = Math.max(20, Math.min(width - 6, BODY_WIDTH));
  intro(stdout, `Session ${summary.title}`, { colors, description: `${summary.id}  ·  ${summary.events} events  ·  ${summary.turns} turns` });
  const who = summary.agents.length ? summary.agents.map(agentLabel).join(", ") : "none";
  field(stdout, "Recorded", summary.startedAt ? `${stamp(summary.startedAt)} → ${stamp(summary.endedAt)}` : "unknown", { colors, labelWidth: 10 });
  field(stdout, "Agents", who, { colors, labelWidth: 10 });
  for (const projection of summary.projections) {
    const state = projection.state === "current" ? colors.success("current") : colors.warning(projection.state);
    field(stdout, projection.label, `${projection.nativeSessionId}  ${state}`, { colors, labelWidth: 10 });
  }
  if (turns.length === 0) {
    note(stdout, "This session has no recorded turns yet.", { colors });
    return;
  }
  const shown = options.limit && options.limit > 0 && turns.length > options.limit ? turns.slice(-options.limit) : turns;
  if (shown.length < turns.length) {
    note(stdout, `${turns.length - shown.length} earlier turn(s) not shown`, { colors });
  }
  section(stdout, "Conversation", { colors });
  for (const turn of shown) {
    stdout.write("\n");
    stdout.write(`│  ${speakerLine(colors, turn, width - 4)}\n`);
    const body = turn.text ? wrap(turn.text, bodyWidth) : [];
    const clipped = options.maxLines ?? BODY_LINES;
    const visible = body.length > clipped ? [...body.slice(0, clipped), "…"] : body;
    for (const line of visible) stdout.write(`│  ${line}\n`);
    for (const tool of turn.tools) stdout.write(`│  ${toolLine(colors, tool, width - 4)}\n`);
  }
  stdout.write("\n");
}

/** A compact list row: who spoke last, and what it was. */
export function transcriptPreview({ turns }, limit = 80) {
  const last = turns.at(-1);
  return last ? truncate(turnPreview(last, limit), limit) : "no turns";
}

export async function loadTranscript(projectRoot, id, options = {}) {
  return readTranscript(projectRoot, id, options);
}
