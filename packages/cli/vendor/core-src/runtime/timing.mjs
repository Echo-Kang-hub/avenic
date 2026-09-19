import process from "node:process";

// Where a launch spends its time before the agent starts. Off by default: it
// writes to stderr and reads the clock per phase, so it is only ever switched
// on by a person measuring (AVENIC_LAUNCH_TIMING=1), never by a user's launch.
//
// Offsets are measured from the moment this process was created, which is the
// number that matters: everything before the agent's own process appears is
// time the user spent waiting for Avenic.
const enabled = process.env.AVENIC_LAUNCH_TIMING === "1";
const origin = enabled ? performance.now() - process.uptime() * 1000 : 0;
let previous = origin;
const marks = [];

/** Record that `name` has been reached. */
export function mark(name) {
  if (!enabled) return;
  const now = performance.now();
  marks.push({ name, at: now - origin, ms: now - previous });
  previous = now;
}

/** Record `name` as the time its work took, and continue the waterfall after it. */
export async function timed(name, work) {
  if (!enabled) return work();
  const before = performance.now();
  try {
    return await work();
  } finally {
    const now = performance.now();
    marks.push({ name, at: before - origin, ms: now - before });
    previous = now;
  }
}

/**
 * Print the waterfall. Called immediately before the agent's process is
 * created, because the launch blocks on it from that point on.
 */
export function reportLaunchTiming() {
  if (!enabled) return;
  for (const { name, at, ms } of marks) {
    console.error(`[launch] ${name.padEnd(26)} ${ms.toFixed(1).padStart(7)}ms  @${at.toFixed(0)}`);
  }
  console.error(`[launch] ${"total".padEnd(26)} ${"".padStart(7)}ms @${(performance.now() - origin).toFixed(0)}ms since process start`);
}
