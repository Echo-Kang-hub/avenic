import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sessionLeasePath, WATCH_INTERVAL_MS } from "#core";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

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
  await mkdir(stateDir, { recursive: true });
  await writeFile(
    path.join(stateDir, "watchdog.json"),
    JSON.stringify({ member, parentPid: process.pid, agentId, projectRoot, environment, intervalMs }),
    { encoding: "utf8", mode: 0o600 },
  );
  const child = spawn(process.execPath, [path.join(packageRoot, "scripts", "watchdog.mjs"), stateDir], {
    cwd: os.tmpdir(),
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  return child;
}
