#!/usr/bin/env node
// The number this exists to report is Avenic's own overhead: how much later the
// agent starts because Avenic is in front of it. The agent's own startup is
// real, but it is the agent's own startup and is never counted against the
// wrapper.
//
// Both sides are measured through the same shim, one per agent, which reports
// the instant the operating system started that agent's launcher. Direct and
// wrapped therefore differ only by Avenic:
//
//   direct   the shim, started the way a shell starts the agent
//   wrapped  avenic <agent>, which starts the same shim itself
//   overhead wrapped - direct, paired per run so machine noise cancels
//
// Three launch situations are measured separately, because they cost different
// amounts and all three are things a user does:
//
//   cold      the first launch in a project: nothing recorded yet
//   steady    the normal case: the previous launch exited cleanly
//   recovery  after a launch was killed (closed terminal, closed editor)
//
// The project is a temp one holding real-shaped native history, and the agent
// is a temp shim: by default it reports and exits instead of starting the real
// agent, because the measurement is the wait before the agent starts, and
// letting each run finish cleanly keeps every sample in the same state. Pass
// --real-agent to hand off to the installed binaries and kill them at the
// report instead, which measures the same thing against the real executables.
//
// Each situation is reported per agent, and so is their union: the budget in
// the last row of each block is the one that has to hold, because a user who
// launches an agent in a project they have never launched in is still a user.
//
//   node scripts/perf/launch-overhead.mjs                 # 15 runs per case
//   node scripts/perf/launch-overhead.mjs --runs 30 --json
//   node scripts/perf/launch-overhead.mjs --agents claude --phases
//   node scripts/perf/launch-overhead.mjs --runs 5 --real-agent
//   node scripts/perf/launch-overhead.mjs --cold-fixtures 5
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createPerfFixture, percentile } from "./fixture.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const cliEntry = path.join(repoRoot, "packages", "cli", "scripts", "skills.mjs");
const argument = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
};
const runs = Number(argument("--runs", 25));
const coldFixtures = Number(argument("--cold-fixtures", 3));
const json = process.argv.includes("--json");
const withPhases = process.argv.includes("--phases");
const realAgent = process.argv.includes("--real-agent");
const agents = (argument("--agents", "claude,codex,opencode")).split(",");
const budget = { median: 300, p95: 500 };

/**
 * The real binary a shim hands off to. `where` lists the shell wrapper first,
 * which the command interpreter refuses to run, so an executable wins.
 */
function resolveReal(agent) {
  const found = spawnSync(process.platform === "win32" ? "where.exe" : "which", [agent], { encoding: "utf8" });
  const candidates = (found.stdout ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (process.platform !== "win32") return candidates[0] ?? null;
  return candidates.find((file) => file.toLowerCase().endsWith(".exe"))
    ?? candidates.find((file) => file.toLowerCase().endsWith(".cmd"))
    ?? candidates[0] ?? null;
}

/**
 * A PATH entry that stands in for the agent: it reports that it has started,
 * and then either exits (the default) or runs the real binary.
 */
async function writeShim(directory, agent) {
  const recorder = path.join(directory, `${agent}-shim.mjs`);
  await writeFile(recorder, `import { writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
writeFileSync(process.env.AVENIC_LAUNCH_PROBE, String(Date.now()));
if (process.env.AVENIC_LAUNCH_SHIM === "exec") {
  spawnSync(process.env.AVENIC_LAUNCH_REAL, process.argv.slice(2), { stdio: "inherit" });
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

function terminate(child) {
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
async function timeToShim(executable, argumentsList, { cwd, env, probe, shell = false, kill = false, timeoutMs = 60_000 }) {
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
  if (kill || realAgent) terminate(child);
  else await exited(child, 20_000);
  if (seenAt !== null) return { ms: seenAt - startedAt, status: "ok" };
  return { ms: Date.now() - startedAt, status: child.exitCode === null ? "timeout" : `exit-${child.exitCode}` };
}

function record(failures, label, result) {
  if (result.status !== "ok") failures.push(`${label}: ${result.status}`);
  return result;
}

function summarize(samples) {
  return {
    runs: samples.length,
    median: Math.round(percentile(samples, 0.5)),
    p95: Math.round(percentile(samples, 0.95)),
    min: Math.round(percentile(samples, 0)),
    max: Math.round(percentile(samples, 1)),
  };
}

// A 95th percentile of a handful of samples is the largest sample wearing a
// statistic's name, and on a busy machine that is a report of the bus, not of
// the wrapper. Below this many samples the median decides on its own and the
// row says so.
const P95_SAMPLE_FLOOR = 20;

function verdict(measures) {
  if (measures.median > budget.median) return "FAIL";
  if (measures.runs < P95_SAMPLE_FLOOR) return "PASS (median)";
  return measures.p95 <= budget.p95 ? "PASS" : "FAIL";
}

/**
 * One paired sample: how long the agent takes to start, and how long it takes
 * with Avenic in front of it, from the same state.
 */
async function sample(agent, shimPath, environment, { crashed = false } = {}) {
  const probe = path.join(environment.AVENIC_LAUNCH_PROBE_DIR, `${agent}-probe`);
  const runEnvironment = { ...environment, AVENIC_LAUNCH_PROBE: probe, AVENIC_LAUNCH_REAL: environment.AVENIC_LAUNCH_REAL };
  if (crashed) {
    // A launch that was killed where it stood: its sessions are unreconciled
    // and whatever native storage it isolated is still isolated.
    await rm(probe, { force: true });
    await timeToShim(process.execPath, [cliEntry, agent], { cwd: environment.AVENIC_LAUNCH_CWD, env: runEnvironment, probe, kill: true });
  }
  await rm(probe, { force: true });
  const direct = await timeToShim(shimPath, [], { cwd: environment.AVENIC_LAUNCH_CWD, env: runEnvironment, probe, shell: process.platform === "win32" });
  await rm(probe, { force: true });
  const wrapped = await timeToShim(process.execPath, [cliEntry, agent], { cwd: environment.AVENIC_LAUNCH_CWD, env: runEnvironment, probe });
  return { direct: direct.ms, wrapped: wrapped.ms, status: wrapped.status === "ok" ? direct.status : wrapped.status };
}

/**
 * A fixture with the shims and the configuration a wrapped launch needs, so a
 * cold sample can be taken in one and thrown away.
 */
async function prepare(stubAgents = false) {
  const fixture = await createPerfFixture({ stubAgents });
  const shimDirectory = path.join(fixture.root, "shim");
  const probeDirectory = path.join(fixture.root, "probe");
  await mkdir(shimDirectory, { recursive: true });
  await mkdir(probeDirectory, { recursive: true });
  const environment = {
    ...fixture.environment,
    AVENIC_LAUNCH_SHIM: realAgent ? "exec" : "exit",
    AVENIC_LAUNCH_PROBE_DIR: probeDirectory,
    AVENIC_LAUNCH_CWD: fixture.projectRoot,
    PATH: `${shimDirectory}${path.delimiter}${fixture.environment.PATH}`,
    Path: `${shimDirectory}${path.delimiter}${fixture.environment.Path}`,
  };
  const shims = {};
  const missing = [];
  for (const agent of agents) {
    const real = resolveReal(agent);
    if (!real) {
      missing.push(agent);
      continue;
    }
    shims[agent] = { real, shim: await writeShim(shimDirectory, agent) };
  }
  return { fixture, environment, shims, missing, measured: agents.filter((agent) => !missing.includes(agent)) };
}

/** Pair `run` with a direct launch of every measured agent, from the same state. */
async function sampleAll(context, options) {
  const pairs = {};
  for (const agent of context.measured) {
    pairs[agent] = await sample(agent, context.shims[agent].shim, { ...context.environment, AVENIC_LAUNCH_REAL: context.shims[agent].real }, options);
  }
  return pairs;
}

async function configure(context) {
  // The project has to be configured before a wrapped launch means anything.
  const init = spawnSync(
    process.execPath,
    [cliEntry, "init", "--agents", context.measured.join(","), "--auth", "global", "--sessions", "project", "--history", "shared"],
    { cwd: context.fixture.projectRoot, env: context.environment, encoding: "utf8" },
  );
  if (init.status !== 0) throw new Error(`init failed: ${init.stderr}`);
  // Seeding thousands of files makes the first spawn of the run pay for the
  // operating system inspecting them, which lands on whichever measurement
  // happens first. A real machine has nothing to inspect on a command it has
  // run before. This touches no session state, so the cold sample is cold.
  spawnSync(process.execPath, [cliEntry, "--version"], { cwd: context.fixture.projectRoot, env: context.environment });
}

async function main() {
  const report = { budget, mode: realAgent ? "exec" : "exit", coldFixtures, agents: {} };
  const cold = {};
  for (let index = 0; index < coldFixtures; index += 1) {
    // Every cold sample needs a project nothing has launched in yet, so each
    // one gets its own fixture: the first launch in a project is a different
    // amount of work from every launch after it, and one sample of it would
    // report the machine's mood rather than the cost.
    const context = await prepare();
    if (index === 0 && context.missing.length > 0 && !json) console.log(`no real binary found for: ${context.missing.join(", ")}`);
    await configure(context);
    const pairs = await sampleAll(context);
    for (const [agent, pair] of Object.entries(pairs)) (cold[agent] ??= []).push(pair);
    await context.fixture.dispose();
    if (index === 0) report.fixture = context.fixture.root;
  }

  const context = await prepare();
  report.sizes = context.fixture.sizes;
  await configure(context);
  for (const agent of context.measured) {
    const failures = [];
    const steady = [];
    for (let run = 0; run < runs; run += 1) {
      steady.push(record(failures, `steady ${run + 1}`, await sample(agent, context.shims[agent].shim, { ...context.environment, AVENIC_LAUNCH_REAL: context.shims[agent].real })));
    }
    const recovery = [];
    for (let run = 0; run < runs; run += 1) {
      recovery.push(record(failures, `recovery ${run + 1}`, await sample(agent, context.shims[agent].shim, { ...context.environment, AVENIC_LAUNCH_REAL: context.shims[agent].real }, { crashed: true })));
    }
    const measures = (samples) => ({
      direct: summarize(samples.map((entry) => entry.direct)),
      wrapped: summarize(samples.map((entry) => entry.wrapped)),
      // Paired: the machine's noise lands on both sides of the same sample.
      overhead: summarize(samples.map((entry) => entry.wrapped - entry.direct)),
    });
    const coldSamples = (cold[agent] ?? []).map((pair, index) => record(failures, `cold ${index + 1}`, pair));
    const situations = { cold: measures(coldSamples), steady: measures(steady), recovery: measures(recovery) };
    report.agents[agent] = {
      real: context.shims[agent].real,
      ...situations,
      all: measures([...coldSamples, ...steady, ...recovery]),
      failures,
    };
  }

  if (withPhases) {
    const agent = context.measured[0];
    const phases = spawnSync(process.execPath, [cliEntry, agent], {
      cwd: context.fixture.projectRoot,
      env: { ...context.environment, AVENIC_LAUNCH_TIMING: "1", AVENIC_LAUNCH_PROBE: path.join(context.fixture.root, "probe", "phases") },
      encoding: "utf8",
      timeout: 60_000,
    });
    report.phases = `${phases.stdout ?? ""}${phases.stderr ?? ""}`
      .split(/\r?\n/)
      .filter((line) => line.includes("[launch]"));
  }

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`fixture   ${report.fixture}`);
    console.log(`history   ${report.sizes.claudeSessions} claude sessions x ${report.sizes.claudeRecords} records, ${report.sizes.codexRollouts} codex rollouts`);
    console.log(`runs      ${runs} steady + ${runs} recovery + ${coldFixtures} cold per agent, in ${report.mode} mode\n`);
    console.log("agent    situation   runs   direct p50/p95   avenic p50/p95   overhead p50/p95   budget (ms)");
    for (const [agent, data] of Object.entries(report.agents)) {
      for (const situation of ["cold", "steady", "recovery", "all"]) {
        const sample = data[situation];
        console.log(
          `${situation === "cold" ? agent.padEnd(8) : "".padEnd(8)} ${situation.padEnd(10)}  ${String(sample.wrapped.runs).padStart(4)}   `
          + `${String(sample.direct.median).padStart(5)} /${String(sample.direct.p95).padStart(6)}   `
          + `${String(sample.wrapped.median).padStart(5)} /${String(sample.wrapped.p95).padStart(6)}   `
          + `${String(sample.overhead.median).padStart(5)} /${String(sample.overhead.p95).padStart(6)}   `
          + `<${budget.median}/${budget.p95} ${verdict(sample.overhead)}`,
        );
      }
      if (data.failures.length > 0) console.log(`${"".padEnd(9)} FAILED SAMPLES  ${data.failures.join(", ")}`);
    }
    if (report.phases?.length) {
      console.log("\n--- avenic's own phases, one wrapped launch ---");
      for (const line of report.phases) console.log(line);
    }
  }

  await context.fixture.dispose();
  if (Object.values(report.agents).some((data) => data.failures.length > 0)) process.exitCode = 1;
}

await main();
