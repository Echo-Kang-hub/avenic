// `avenic status` renders the core status model. It computes nothing about the
// project itself: the extension reads the same object and draws it as a tree,
// and `--json` prints it unchanged, so all three hosts answer the same
// question with the same answer.
import { collectStatus, shortTimestamp } from "#core";
import { locateProjectRoot } from "#core/runtime/project-root.mjs";

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

function printTable(io, headers, rows) {
  const widths = headers.map((header, column) => Math.max(header.length, ...rows.map((row) => row[column].length)));
  const line = (cells) => cells.map((cell, column) => cell.padEnd(widths[column])).join("  ").trimEnd();
  io.log(`  ${line(headers)}`);
  for (const row of rows) io.log(`  ${line(row)}`);
}

export function renderStatus(status, io = console) {
  const { project, history, agents, skills } = status;
  io.log("Avenic Status\n");
  io.log(`Project   ${project.name}`);
  io.log(`Root      ${project.root}`);
  io.log(`Agents    ${project.agents.length > 0 ? project.agents.join(", ") : "none configured"}`);
  io.log(`History   ${history.mode}`);

  io.log("\nHistory");
  io.log(`  Mode      ${history.mode}`);
  io.log(`  Sessions  ${history.sessions}`);
  if (history.active) {
    io.log(`  Active    ${history.active}${history.activeTitle ? `  ${history.activeTitle}` : ""}`);
    io.log(`  Events    ${history.activeEvents ?? "unknown"}`);
  } else {
    io.log(`  Active    ${history.mode === "shared" ? "none — run: avenic sessions list" : "— (isolated history)"}`);
  }
  io.log(`  Updated   ${shortTimestamp(history.updatedAt) ?? "—"}`);

  io.log("\nAgents");
  printTable(io, ["Agent", "CLI", "Auth", "Sessions", "History", "Sync"], agents.map(agentRow));
  for (const agent of agents) {
    const remedy = SYNC_REMEDIES[agent.history.sync];
    if (remedy) io.log(`  ${agent.displayName}: ${SYNC_LABELS[agent.history.sync]} — ${remedy}`);
    else if (!agent.available) io.log(`  ${agent.displayName}: the ${agent.command} CLI is not on PATH — Avenic still manages its history`);
    else if (!agent.initialized) io.log(`  ${agent.displayName}: run: avenic ${agent.id} init`);
  }

  io.log("\nSkills");
  io.log(`  Project  ${scopeSummary(skills.project)}`);
  io.log(`  Global   ${scopeSummary(skills.global)}`);
  io.log(`  Hub      ${hubSummary(skills.hub)}`);
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
  return renderStatus(status, io);
}
