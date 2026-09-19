#!/usr/bin/env node
// What a Shared-mode switch costs before the target agent starts.
//
// Two situations, because they are the two a user is in:
//
//   materialize  the target has no native session yet, so the conversation has
//                to be projected into one, once
//   delta        the target already answers from a native session, so only what
//                it has not seen is projected
//
// Both run at 100, 1 000 and 10 000 canonical events, because the promise of
// Shared mode is that a switch costs its delta and not the conversation it sits
// on: the delta rows must stay flat as the conversation grows. A plain launch
// is measured by launch-overhead.mjs and is not what this adds.
//
// The target is a PATH shim that reports the instant it began to run, so the
// number is Avenic's own preparation — projection, mapping bookkeeping and
// whatever else has to happen before the agent exists — and never the agent's.
//
//   node scripts/perf/shared-continue.mjs
//   node scripts/perf/shared-continue.mjs --runs 10 --events 100,1000
//   node scripts/perf/shared-continue.mjs --json
import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  appendCanonicalEvents,
  createCanonicalSession,
  readCanonicalSession,
  setActiveCanonicalSession,
  syncNativeMapping,
} from "../../packages/core/src/index.mjs";
import { runtimePaths } from "../../packages/core/src/runtime/config.mjs";
import { createPerfFixture } from "./fixture.mjs";
import { cliEntry, measures, record, timeToShim, writeShim } from "./harness.mjs";

const argument = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
};
const runs = Number(argument("--runs", 7));
const sizes = argument("--events", "100,1000,10000").split(",").map(Number);
const json = process.argv.includes("--json");
const target = argument("--agent", "claude");
// A switch is only interesting when the target has work behind it: the six
// newest events are what it has not seen.
const DELTA_EVENTS = 6;

function fixtureEvents(sessionId, count) {
  const events = [];
  for (let index = 0; index < count; index += 1) {
    // A conversation that moved between agents, which is what Shared mode is
    // for: every tenth turn belongs to the other one.
    const fromOther = index % 10 === 9;
    const agent = fromOther ? (target === "claude" ? "codex" : "claude") : target;
    events.push({
      id: `${agent}:native-perf:${sessionId}-${index}`,
      agent,
      role: index % 2 === 0 ? "user" : "assistant",
      createdAt: "2026-09-19T00:00:00.000Z",
      content: [{ type: "text", text: `turn ${index}: ${fromOther ? "the other agent" : "the target"} speaking` }],
    });
  }
  return events;
}

async function mappingFile(projectRoot, sessionId) {
  return path.join(runtimePaths(projectRoot).sessionsRoot, "canonical", sessionId, "mappings.json");
}

/** No mapping at all: the next switch has to project the conversation. */
async function withoutMapping(projectRoot, sessionId) {
  const file = await mappingFile(projectRoot, sessionId);
  await writeFile(file, `${JSON.stringify({ schemaVersion: 1, canonicalSessionId: sessionId, projections: {} }, null, 2)}\n`);
}

/** A mapping that is six events behind: the next switch projects only those. */
async function withDelta(projectRoot, sessionId) {
  const { events } = await readCanonicalSession(projectRoot, sessionId);
  await syncNativeMapping(projectRoot, sessionId, {
    agentId: target,
    nativeSessionId: `native-perf-${sessionId}`,
    lastCanonicalEventId: events.at(-DELTA_EVENTS - 1)?.id ?? null,
  });
}

async function main() {
  const fixture = await createPerfFixture({ stubAgents: false });
  const shimDirectory = path.join(fixture.root, "shim");
  const probeDirectory = path.join(fixture.root, "probe");
  await mkdir(shimDirectory, { recursive: true });
  await mkdir(probeDirectory, { recursive: true });
  const shim = await writeShim(shimDirectory, target);
  const environment = {
    ...fixture.environment,
    AVENIC_LAUNCH_SHIM: "exit",
    PATH: `${shimDirectory}${path.delimiter}${fixture.environment.PATH}`,
    Path: `${shimDirectory}${path.delimiter}${fixture.environment.Path}`,
  };
  // init is not the measurement; the project only has to be configured before a
  // continuing launch means anything.
  const init = spawnSync(process.execPath,
    [cliEntry, "init", "--agents", target, "--auth", "global", "--sessions", "project", "--history", "shared"],
    { cwd: fixture.projectRoot, env: environment, encoding: "utf8" });
  if (init.status !== 0) throw new Error(`init failed: ${init.stderr || init.stdout}`);

  const report = { runs, target, cases: {} };
  const sessionFor = async (size) => {
    const id = `perf-${size}`;
    await createCanonicalSession(fixture.projectRoot, { id, title: `Perf ${size}` });
    await appendCanonicalEvents(fixture.projectRoot, id, fixtureEvents(id, size));
    await setActiveCanonicalSession(fixture.projectRoot, id);
    return id;
  };

  for (const size of sizes) {
    const sessionId = await sessionFor(size);
    for (const mode of ["materialize", "delta"]) {
      const failures = [];
      const samples = [];
      for (let run = 0; run < runs; run += 1) {
        if (mode === "materialize") await withoutMapping(fixture.projectRoot, sessionId);
        else await withDelta(fixture.projectRoot, sessionId);
        const probe = path.join(probeDirectory, `${mode}-${size}.probe`);
        await rm(probe, { force: true });
        const direct = await timeToShim(shim, [], { cwd: fixture.projectRoot, env: { ...environment, AVENIC_LAUNCH_PROBE: probe }, probe, shell: process.platform === "win32" });
        await rm(probe, { force: true });
        // The shim writes no native history, so the CLI's own exit code after
        // the agent is done says nothing about the wait being measured; the
        // sample is good exactly when the agent was reached.
        const wrapped = await timeToShim(process.execPath, [cliEntry, "sessions", "continue", sessionId, "--agent", target],
          { cwd: fixture.projectRoot, env: { ...environment, AVENIC_LAUNCH_PROBE: probe }, probe });
        samples.push(record(failures, `${mode} ${size} run ${run + 1}`, { direct: direct.ms, wrapped: wrapped.ms, status: wrapped.status === "ok" ? direct.status : wrapped.status }));
      }
      report.cases[`${mode}-${size}`] = { size, mode, ...measures(samples), failures };
    }
  }

  const deltaGrowth = report.cases[`delta-${sizes.at(-1)}`].overhead.median / Math.max(1, report.cases[`delta-${sizes[0]}`].overhead.median);
  report.deltaGrowth = Number(deltaGrowth.toFixed(2));

  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`fixture   ${fixture.root}`);
    console.log(`target    ${target} (PATH shim), ${runs} runs per case\n`);
    console.log("case            events   avenic p50/p95   direct p50   overhead p50/p95");
    for (const size of sizes) {
      for (const mode of ["materialize", "delta"]) {
        const data = report.cases[`${mode}-${size}`];
        console.log(
          `${mode.padEnd(14)} ${String(size).padStart(7)}   `
          + `${String(data.wrapped.median).padStart(5)} /${String(data.wrapped.p95).padStart(6)}   `
          + `${String(data.direct.median).padStart(8)}   `
          + `${String(data.overhead.median).padStart(5)} /${String(data.overhead.p95).padStart(6)}`,
        );
        if (data.failures.length > 0) console.log(`${"".padEnd(15)} FAILED SAMPLES ${data.failures.join(", ")}`);
      }
    }
    console.log(`\ndelta overhead ${sizes[0]} → ${sizes.at(-1)} events: x${report.deltaGrowth} (a switch costs its delta, not the history)`);
    const largest = report.cases[`delta-${sizes.at(-1)}`].overhead.median;
    console.log(`budget: a delta switch stays under 500 ms — largest measured ${largest} ms ${largest <= 500 ? "PASS" : "FAIL"}`);
  }

  await fixture.dispose();
  if (Object.values(report.cases).some((data) => data.failures.length > 0)) process.exitCode = 1;
}

await main();
