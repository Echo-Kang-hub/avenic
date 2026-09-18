#!/usr/bin/env node
// Profiles the two paths a user actually waits on: starting an agent, and the
// bookkeeping that happens after it exits. This is a measurement tool, not a
// test — the pass/fail budgets live in test/launch-latency.test.mjs, which
// should stay small enough to run on every commit. Here we want the numbers in
// full, on a fixture big enough for the difference between "reads what changed"
// and "reads everything" to be obvious.
//
//   node scripts/perf/profile.mjs            # end-to-end, then per-step
//   node scripts/perf/profile.mjs --json     # one machine-readable object
//   node scripts/perf/profile.mjs --keep     # leave the fixture on disk
//
// Sizes come from the environment (CLAUDE_SESSIONS, CLAUDE_RECORDS,
// CODEX_OTHER_SESSIONS) so a slower or faster machine can scale the fixture
// rather than the thresholds.
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const cliEntry = path.join(repoRoot, "packages", "cli", "scripts", "skills.mjs");
const coreEntry = path.join(repoRoot, "packages", "core", "src", "index.mjs");

const claudeSessions = Number(process.env.CLAUDE_SESSIONS ?? 40);
const claudeRecords = Number(process.env.CLAUDE_RECORDS ?? 400);
const codexRollouts = Number(process.env.CODEX_ROLLOUTS ?? 120);
const json = process.argv.includes("--json");
const keep = process.argv.includes("--keep");
const measurements = [];

function record(group, label, ms, status = "ok") {
  measurements.push({ group, label, ms: Number(ms.toFixed(1)), status });
  if (!json) console.log(`${label.padEnd(46)} ${ms.toFixed(0).padStart(6)} ms  ${status}`);
}

async function time(group, label, run) {
  const started = process.hrtime.bigint();
  const value = await run();
  record(group, label, Number(process.hrtime.bigint() - started) / 1e6);
  return value;
}

// Claude's project directory is its own encoding of the cwd. The fixture writes
// the same shape, so discovery has to do real work rather than match a path.
function claudeProjectKey(projectRoot) {
  return path.resolve(projectRoot).replace(/[^a-zA-Z0-9]/g, "-");
}

function claudeRecord(sessionId, index, cwd) {
  return {
    type: "assistant",
    uuid: `uuid-${sessionId}-${index}`,
    sessionId,
    timestamp: new Date(1700000000000 + index * 1000).toISOString(),
    cwd,
    message: {
      role: index % 2 === 0 ? "user" : "assistant",
      model: "claude-sonnet-5",
      content: [{ type: "text", text: `message ${index} ${"x".repeat(200)}` }],
    },
  };
}

function codexRecord(index) {
  return {
    timestamp: new Date(1700000000000 + index * 1000).toISOString(),
    type: "response_item",
    payload: {
      id: `p-${index}`,
      type: "message",
      role: index % 2 === 0 ? "user" : "assistant",
      content: [{ type: "input_text", text: `codex ${index} ${"y".repeat(200)}` }],
    },
  };
}

async function seedClaude(home, projectRoot) {
  const dir = path.join(home, ".claude", "projects", claudeProjectKey(projectRoot));
  await mkdir(dir, { recursive: true });
  for (let s = 0; s < claudeSessions; s += 1) {
    const sessionId = `11111111-2222-3333-4444-${String(s).padStart(12, "0")}`;
    const lines = [];
    for (let i = 0; i < claudeRecords; i += 1) lines.push(JSON.stringify(claudeRecord(sessionId, i, projectRoot)));
    await writeFile(path.join(dir, `${sessionId}.jsonl`), `${lines.join("\n")}\n`);
  }
  // Other projects' history: it must cost nothing to skip.
  for (let s = 0; s < 60; s += 1) {
    const other = path.join(home, ".claude", "projects", `-other-project-${s}`);
    await mkdir(other, { recursive: true });
    const lines = [];
    for (let i = 0; i < 50; i += 1) lines.push(JSON.stringify(claudeRecord(`other-${s}`, i, `C:\\other\\${s}`)));
    await writeFile(path.join(other, `other-${s}.jsonl`), `${lines.join("\n")}\n`);
  }
}

async function seedCodex(home, projectRoot) {
  const root = path.join(home, ".codex", "sessions", "2026", "09", "18");
  await mkdir(root, { recursive: true });
  for (let s = 0; s < codexRollouts; s += 1) {
    const lines = [JSON.stringify({ type: "session_meta", payload: { id: `rollout-${s}`, cwd: s % 3 === 0 ? projectRoot : `C:\\other\\${s}` } })];
    for (let i = 0; i < 60; i += 1) lines.push(JSON.stringify(codexRecord(i)));
    await writeFile(path.join(root, `rollout-${s}.jsonl`), `${lines.join("\n")}\n`);
  }
}

// The agent itself is not under test, and a real one would need a terminal.
async function writeFakeAgent(bin, name) {
  await mkdir(bin, { recursive: true });
  const target = path.join(bin, process.platform === "win32" ? `${name}.cmd` : name);
  if (process.platform === "win32") {
    await writeFile(target, "@echo off\r\nexit /b 0\r\n");
  } else {
    await writeFile(target, "#!/bin/sh\nexit 0\n");
    await chmod(target, 0o755);
  }
}

async function main() {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-perf-"));
  const home = path.join(root, "home");
  const projectRoot = path.join(root, "project");
  const bin = path.join(root, "bin");
  await mkdir(home, { recursive: true });
  await mkdir(projectRoot, { recursive: true });
  await seedClaude(home, projectRoot);
  await seedCodex(home, projectRoot);
  for (const name of ["claude", "codex", "opencode"]) await writeFakeAgent(bin, name);

  const inherited = process.env.PATH ?? process.env.Path ?? "";
  const environment = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    HOMEDRIVE: path.parse(home).root.replace(/\\$/, ""),
    HOMEPATH: home.slice(path.parse(home).root.length - 1),
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    CODEX_HOME: path.join(home, ".codex"),
    PATH: `${bin}${path.delimiter}${inherited}`,
    Path: `${bin}${path.delimiter}${inherited}`,
  };

  if (!json) {
    console.log(`fixture   ${root}`);
    console.log(`claude    ${claudeSessions} sessions x ${claudeRecords} records`);
    console.log(`codex     ${codexRollouts} rollouts\n`);
  }

  const launch = (argumentsList, label) => {
    const started = process.hrtime.bigint();
    const result = spawnSync(process.execPath, [cliEntry, ...argumentsList], { cwd: projectRoot, env: environment, encoding: "utf8" });
    record("launch", label, Number(process.hrtime.bigint() - started) / 1e6, result.status === 0 ? "ok" : `exit ${result.status}`);
    if (result.status !== 0 && !json) {
      console.log(`    stderr: ${(result.stderr ?? "").trim().split("\n").slice(-3).join(" | ")}`);
    }
  };

  launch(["--version"], "avenic --version");
  launch(["init", "--agents", "claude,codex,opencode", "--auth", "global", "--sessions", "project", "--history", "shared"], "avenic init (shared)");
  launch(["claude"], "avenic claude (cold)");
  launch(["claude"], "avenic claude (warm)");
  launch(["codex"], "avenic codex (warm)");
  launch(["opencode"], "avenic opencode (warm)");
  launch(["sessions", "status"], "avenic sessions status");
  launch(["status"], "avenic status");

  if (!json) console.log("--- individual steps ---");
  const core = await import(pathToFileURL(coreEntry).href);
  const claude = core.getSessionAdapter("claude");
  const codex = core.getSessionAdapter("codex");
  const agentEnvironment = { ...environment };

  await time("steps", "loadRuntime", () => core.loadRuntime(projectRoot));
  // A full capture is what a foreground exit runs: it re-reads the head of
  // every Claude session on the machine to decide which belong to this
  // project, so its first pass in a process is the one number here that grows
  // with the machine's history rather than with this fixture. `knownOnly` is
  // the same pass without that discovery, which is what the in-run watchdog
  // uses; the gap between the two lines is the discovery cost.
  await time("steps", "claude.capture", () => claude.capture(projectRoot, { environment: agentEnvironment }));
  await time("steps", "claude.capture (knownOnly)", () => claude.capture(projectRoot, { environment: agentEnvironment, knownOnly: true }));
  await time("steps", "importProjectSessions(claude)", () => core.importProjectSessions(projectRoot, "claude", { environment: agentEnvironment }));
  await time("steps", "codex.capture", () => codex.capture(projectRoot, { environment: agentEnvironment }));
  await time("steps", "importProjectSessions(codex)", () => core.importProjectSessions(projectRoot, "codex", { environment: agentEnvironment }));
  await time("steps", "listCanonicalSessions", () => core.listCanonicalSessions(projectRoot));
  await time("steps", "recoverSharedNativeSessions(3 agents)", () => core.recoverSharedNativeSessions(projectRoot, ["claude", "codex", "opencode"], { environment: agentEnvironment }));

  if (!json) console.log("--- exit path (after the agent quits) ---");
  const snapshot = path.join(root, "snapshot");
  const codexSnapshot = path.join(root, "snapshot-codex");
  await claude.snapshotNative(projectRoot, snapshot, { environment: agentEnvironment });
  await codex.snapshotNative(projectRoot, codexSnapshot, { environment: agentEnvironment });
  await time("exit", "claude.revertNative", () => claude.revertNative(snapshot, projectRoot, { environment: agentEnvironment }));
  await time("exit", "codex.revertNative", () => codex.revertNative(codexSnapshot, projectRoot, { environment: agentEnvironment }));
  await time("exit", "observeSharedNativeSessions(claude)", () => core.observeSharedNativeSessions(projectRoot, "claude", { environment: agentEnvironment, setActive: true }));
  await time("exit", "observeSharedNativeSessions(codex)", () => core.observeSharedNativeSessions(projectRoot, "codex", { environment: agentEnvironment, setActive: true }));

  if (json) console.log(JSON.stringify({ fixture: root, measurements }, null, 2));
  if (keep) console.log(`kept: ${root}`);
  else await rm(root, { recursive: true, force: true });
}

await main();
