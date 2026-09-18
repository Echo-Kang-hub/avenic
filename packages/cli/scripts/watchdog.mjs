// Detached helper for `avenic <agent>` launches. While the agent runs it keeps
// the run's sessions durable, so a crash costs at most one interval; when the
// launching CLI process disappears without a normal exit (terminal closed,
// killed), it finishes the launch's cleanup: the run's sessions are captured
// into the project and, for the last launch of the group, the agent's native
// storage is restored to its pre-launch state.
import { appendFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import process from "node:process";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  finishLaunch,
  processAlive,
  startNativeWatch,
  WATCH_INTERVAL_MS,
} from "#core";

const stateDir = process.argv[2];
const config = JSON.parse(await readFile(path.join(stateDir, "watchdog.json"), "utf8"));
// The launcher writes this before it starts its own exit sequence: the run is
// over, so periodic capture stops and the exit path owns the last pass. A
// launcher that dies during that sequence is still finished below.
const closingMarker = path.join(stateDir, "closing");

const watch = startNativeWatch(config.projectRoot, config.agentId, {
  environment: config.environment,
  intervalMs: config.intervalMs ?? WATCH_INTERVAL_MS,
  onError: (error) => {
    appendFile(`${stateDir}.watchdog.log`, `${new Date().toISOString()} ${error?.stack ?? error}\n`).catch(() => {});
  },
});

// The same exit sequence the interrupt itself interrupted: capture what the
// run produced, then leave the launch group, whose last member restores the
// native storage the launch snapshotted.
function finish() {
  return finishLaunch(config.projectRoot, config.agentId, {
    environment: config.environment,
    member: config.member ?? null,
    setActive: false,
  });
}

try {
  // Wait for the launching CLI to go away. The group state directory is
  // removed on a normal exit, which also ends the watch.
  let watching = true;
  while (processAlive(config.parentPid) && existsSync(stateDir)) {
    if (watching && existsSync(closingMarker)) {
      await watch.drain();
      watching = false;
    }
    await delay(watching ? 1000 : 100);
  }
  await watch.drain();
  if (!processAlive(config.parentPid) && existsSync(stateDir)) {
    await finish();
  }
} catch (error) {
  await appendFile(`${stateDir}.watchdog.log`, `${new Date().toISOString()} ${error?.stack ?? error}\n`).catch(() => {});
}
