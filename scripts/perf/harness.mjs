// What a timing harness needs, shared by every measurement under scripts/perf.
//
// The clock that matters starts before Avenic and stops when the operating
// system actually started the agent, so both harnesses measure the same thing:
// a shim stands in for the agent, writes the instant it began to run, and the
// sample is that instant minus the instant the command was spawned. Nothing the
// agent does afterwards is charged to Avenic.
import { spawn, spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { percentile } from "./fixture.mjs";
import { getAgent } from "../../packages/core/src/index.mjs";

export const repoRoot = path.resolve(import.meta.dirname, "..", "..");
export const cliEntry = path.join(repoRoot, "packages", "cli", "scripts", "skills.mjs");
export const budget = { median: 300, p95: 500 };

/**
 * The commands that configure a project for `agents`, in the shape the model
 * actually has: the agents Avenic configures answer one method question
 * together, and an agent that manages its own authentication answers only
 * where its sessions live. Handing that one `--auth` is refused — and since a
 * refused init configures nothing at all, a harness that spells the command
 * itself silently measures "not initialized" error exits instead of launches.
 * Derived from the agents, so a capability change moves these commands too.
 */
export function configureCommands(agents) {
  const managed = agents.filter((agent) => !getAgent(agent).managesOwnAuth);
  const native = agents.filter((agent) => getAgent(agent).managesOwnAuth);
  return [
    ...(managed.length > 0
      ? [["init", "--agents", managed.join(","), "--auth", "account", "--scope", "global", "--sessions", "project", "--history", "shared"]]
      : []),
    ...native.map((agent) => [agent, "init", "--sessions", "project"]),
  ];
}

/** Run them in order, and let the first refusal fail with what it printed. */
export function configureProject({ projectRoot, environment, agents }) {
  const commands = configureCommands(agents);
  // No agents is not a configured project: a harness that measured from here
  // would report an empty case list as a clean run.
  if (commands.length === 0) throw new Error("no agents to configure — pass --agents");
  for (const argumentsList of commands) {
    const result = spawnSync(process.execPath, [cliEntry, ...argumentsList], { cwd: projectRoot, env: environment, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`avenic ${argumentsList.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
}

// A 95th percentile of a handful of samples is the largest sample wearing a
// statistic's name, and on a busy machine that is a report of the bus, not of
// the wrapper. Below this many samples the median decides on its own and the
// row says so.
export const P95_SAMPLE_FLOOR = 20;

/**
 * The real binary a shim hands off to. `where` lists the shell wrapper first,
 * which the command interpreter refuses to run, so an executable wins.
 */
export function resolveReal(agent) {
  const found = spawnSync(process.platform === "win32" ? "where.exe" : "which", [agent], { encoding: "utf8" });
  const candidates = (found.stdout ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (process.platform !== "win32") return candidates[0] ?? null;
  return candidates.find((file) => file.toLowerCase().endsWith(".exe"))
    ?? candidates.find((file) => file.toLowerCase().endsWith(".cmd"))
    ?? candidates[0] ?? null;
}

/**
 * A PATH entry that stands in for the agent: it reports that it has started,
 * and then exits (the default), runs the real binary, or stays alive — the
 * last one is how a launch is killed while its agent is still running, which
 * is what a closed terminal does.
 */
export async function writeShim(directory, agent) {
  const recorder = path.join(directory, `${agent}-shim.mjs`);
  await writeFile(recorder, `import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
writeFileSync(process.env.AVENIC_LAUNCH_PROBE, String(Date.now()));
if (process.env.AVENIC_LAUNCH_SHIM === "exec") {
  spawnSync(process.env.AVENIC_LAUNCH_REAL, process.argv.slice(2), { stdio: "inherit" });
} else if (process.env.AVENIC_LAUNCH_SHIM === "hold") {
  await delay(Number(process.env.AVENIC_LAUNCH_SHIM_HOLD_MS) || 20_000);
}
`);
  if (process.platform === "win32") {
    const target = path.join(directory, `${agent}.cmd`);
    await writeFile(target, `@echo off\r\n"${process.execPath}" "${recorder}" %*\r\n`);
    return target;
  }
  const target = path.join(directory, agent);
  await writeFile(target, `#!/bin/sh\n"${process.execPath}" "${recorder}" "$@"\n`, { mode: 0o755 });
  return target;
}

export function terminate(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
  } else {
    child.kill("SIGKILL");
  }
}

async function readProbe(probe) {
  try {
    const raw = await readFile(probe, "utf8");
    return raw.length > 0 ? Number(raw) : null;
  } catch {
    return null;
  }
}

function exited(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
    const timer = setTimeout(() => {
      terminate(child);
      resolve(false);
    }, timeoutMs);
    child.on("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * Start `command` and stop the clock when the shim reports. Everything the
 * agent does after that is the agent's own time, so the run is either left to
 * finish (and clean up after itself) or killed where it stands, which is what
 * a closed terminal does.
 */
export async function timeToShim(executable, argumentsList, { cwd, env, probe, shell = false, kill = false, timeoutMs = 60_000 }) {
  const startedAt = Date.now();
  const child = spawn(executable, argumentsList, { cwd, env, stdio: "ignore", windowsHide: true, shell });
  let seenAt = null;
  const deadline = startedAt + timeoutMs;
  while (seenAt === null && Date.now() < deadline) {
    seenAt = await readProbe(probe);
    if (seenAt === null) {
      if (child.exitCode !== null || child.signalCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }
  if (kill) terminate(child);
  else await exited(child, 20_000);
  if (seenAt !== null) return { ms: seenAt - startedAt, status: "ok" };
  return { ms: Date.now() - startedAt, status: child.exitCode === null ? "timeout" : `exit-${child.exitCode}` };
}

export function record(failures, label, result) {
  if (result.status !== "ok") failures.push(`${label}: ${result.status}`);
  return result;
}

export function summarize(samples) {
  return {
    runs: samples.length,
    median: Math.round(percentile(samples, 0.5)),
    p95: Math.round(percentile(samples, 0.95)),
    min: Math.round(percentile(samples, 0)),
    max: Math.round(percentile(samples, 1)),
  };
}

export function verdict(measures) {
  if (measures.median > budget.median) return "FAIL";
  if (measures.runs < P95_SAMPLE_FLOOR) return "PASS (median)";
  return measures.p95 <= budget.p95 ? "PASS" : "FAIL";
}

/** `direct` / `wrapped` / `overhead`, where overhead is paired per sample. */
export function measures(samples) {
  return {
    direct: summarize(samples.map((entry) => entry.direct)),
    wrapped: summarize(samples.map((entry) => entry.wrapped)),
    // Paired: the machine's noise lands on both sides of the same sample.
    overhead: summarize(samples.map((entry) => entry.wrapped - entry.direct)),
  };
}
