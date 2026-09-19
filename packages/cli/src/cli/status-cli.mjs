// `avenic status` renders the core status model. It computes nothing about the
// project itself: the extension reads the same object and draws it as a tree,
// and `--json` prints it unchanged, so all three hosts answer the same
// question with the same answer.
import { collectStatus, shortTimestamp } from "#core";
import { locateProjectRoot } from "#core/runtime/project-root.mjs";
import { collectLines, field, note, palette, section, table } from "./prompts.mjs";
import { compactBrand } from "./brand.mjs";

const SYNC_LABELS = {
  current: "current",
  running: "running",
  stale: "stale",
  missing: "missing",
  dirty: "dirty",
  none: "—",
};

const SYNC_REMEDIES = {
  stale: "run: avenic sessions continue <id> --agent <agent> to extend it",
  missing: "run: avenic sessions sync to import this agent's history",
  dirty: "a launch was interrupted — run: avenic sessions sync to finish it",
  running: "a launch is running in this project right now",
};

function scopeSummary(scope) {
  if (scope.state === "none") return "nothing installed";
  if (scope.state === "unreadable") return "installation record could not be read";
  const packs = scope.packs.length > 0 ? ` · ${scope.packs.map((pack) => pack.name).join(" + ")}` : "";
  return `${scope.installed} installed${packs} · ${scope.state}`;
}

function hubSummary(hub) {
  if (!hub.configured) return "not configured";
  const revision = hub.revision ? hub.revision.slice(0, 7) : null;
  const detail = hub.cache === "missing"
    ? "not on this machine — run: avenic skills update"
    : hub.cache === "stale"
      ? `cache is ${revision ?? "unknown"}, installed from ${hub.pinned?.slice(0, 7) ?? "unknown"} — run: avenic skills update`
      : revision ?? "unknown";
  return `${hub.name} · ${hub.cache} · ${detail}`;
}

function agentRow(agent) {
  return [
    agent.displayName,
    agent.available ? "found" : "not found",
    agent.initialized ? `${agent.auth} auth` : "not initialized",
    agent.initialized ? `${agent.sessions} sessions` : "—",
    String(agent.history.sessions),
    SYNC_LABELS[agent.history.sync] ?? agent.history.sync,
  ];
}

/**
 * `avenic status`, drawn: ◆ heading, one ◇ block per question, │ for what is
 * inside it, ! for what needs an action. The same blocks and the same wording
 * the editor's dashboard uses, because both read the one status object.
 */
export function renderStatus(status, io = console, options = {}) {
  const { project, history, agents, skills } = status;
  const colors = options.colors ?? palette(options.stdout ?? process.stdout);
  // 这一页由多个「写一行」的助手拼成；收集它们，最后一次性交给 io.log。
  const { sink, line: blank, flush } = collectLines({ ...io, columns: (options.stdout ?? process.stdout).columns });
  const at = { colors };

  compactBrand(sink, { ...at, title: "Status", description: project.root });
  blank();
  section(sink, "Project", at);
  field(sink, "Name", project.name, at);
  field(sink, "Agents", project.agents.length > 0 ? project.agents.join(", ") : "none configured", at);
  blank();
  section(sink, "History", at);
  field(sink, "Mode", history.mode, at);
  field(sink, "Sessions", String(history.sessions), at);
  if (history.active) {
    field(sink, "Active", `${history.active}${history.activeTitle ? `  ${history.activeTitle}` : ""}`, at);
    field(sink, "Events", String(history.activeEvents ?? "unknown"), at);
  } else {
    field(sink, "Active", history.mode === "shared" ? "none — run: avenic sessions list" : "— (isolated history)", at);
  }
  field(sink, "Updated", shortTimestamp(history.updatedAt) ?? "—", at);
  blank();
  section(sink, "Agents", at);
  table(sink, ["Agent", "CLI", "Auth", "Sessions", "History", "Sync"], agents.map(agentRow), { colors });
  for (const agent of agents) {
    const remedy = SYNC_REMEDIES[agent.history.sync];
    if (remedy) note(sink, `${agent.displayName}: ${SYNC_LABELS[agent.history.sync]} — ${remedy}`, { ...at, mark: "!" });
    else if (!agent.available) note(sink, `${agent.displayName}: the ${agent.command} CLI is not on PATH — Avenic still manages its history`, at);
    else if (!agent.initialized) note(sink, `${agent.displayName}: run: avenic ${agent.id} init`, at);
  }
  blank();
  section(sink, "Skills", at);
  field(sink, "Project", scopeSummary(skills.project), at);
  field(sink, "Global", scopeSummary(skills.global), at);
  field(sink, "Hub", hubSummary(skills.hub), at);
  flush();
  return 0;
}

export async function dispatchStatusCommand(argumentsList = [], options = {}) {
  const io = options.io ?? console;
  const [flag, ...rest] = argumentsList;
  const asJson = flag === "--json";
  if ((flag !== undefined && !asJson) || rest.length > 0) {
    throw new Error("Usage: avenic status [--json]");
  }
  const projectRoot = options.projectRoot ?? locateProjectRoot();
  const status = await collectStatus(projectRoot, { environment: options.environment ?? process.env });
  if (asJson) {
    io.log(JSON.stringify(status, null, 2));
    return 0;
  }
  return renderStatus(status, io, options);
}
