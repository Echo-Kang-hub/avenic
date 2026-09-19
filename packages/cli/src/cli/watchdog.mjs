import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { durableEnvironment, sessionLeasePath, WATCH_INTERVAL_MS } from "#core";
import { timed } from "#core/runtime/timing.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * What the detached watchdog reads back. The environment is narrowed to the
 * variables that resolve native storage and home — the state file sits in the
 * temp directory for as long as the launch group lives, so the token that
 * started the agent must not be in it.
 */
export function watchdogState(agentId, projectRoot, member, environment, intervalMs, parentPid = process.pid) {
  return {
    member,
    parentPid,
    agentId,
    projectRoot,
    environment: durableEnvironment(environment),
    intervalMs,
  };
}

// Start the detached watchdog that keeps this launch's sessions durable while
// the agent runs, and finishes the launch if the CLI process is killed without
// a normal exit (closed terminal, closed editor, crash): it captures the run's
// sessions into the project and restores the native storage. Detached and
// windowless, so closing the terminal does not kill it. Best-effort: launch
// continues without it if spawning fails.
export async function spawnSessionWatchdog(agentId, projectRoot, member, environment) {
  const stateDir = sessionLeasePath(agentId, projectRoot);
  const intervalMs = Number(process.env.AVENIC_WATCH_INTERVAL_MS) || WATCH_INTERVAL_MS;
  // Without a launch group (an agent that manages its own native storage) the
  // state directory exists only for this watch.
  await timed("watchdog.state", async () => {
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      path.join(stateDir, "watchdog.json"),
      JSON.stringify(watchdogState(agentId, projectRoot, member, environment, intervalMs)),
      { encoding: "utf8", mode: 0o600 },
    );
  });
  const child = await timed("watchdog.spawn", async () =>
    spawn(process.execPath, [path.join(packageRoot, "scripts", "watchdog.mjs"), stateDir], {
      cwd: os.tmpdir(),
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }),
  );
  child.unref();
  return child;
}
