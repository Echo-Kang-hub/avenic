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
// Narrow imports on purpose: this process starts while the user is waiting
// for the Agent's first paint, and loading the whole of core here competes
// with the launch it exists to protect. It needs the watch and the finish
// sequence, not the CLI's surface.
import { WATCH_INTERVAL_MS, startNativeWatch } from "#core/runtime/native-watch.mjs";
import { launchFinished, launchMarkerPath, processAlive } from "#core/runtime/sessions.mjs";
import { finishLaunch } from "#core/runtime/session-interop.mjs";

const stateDir = process.argv[2];
const config = JSON.parse(await readFile(path.join(stateDir, "watchdog.json"), "utf8"));
// The launcher writes this before it starts its own exit sequence: the run is
// over, so periodic capture stops and the exit path owns the last pass. A
// launcher that dies during that sequence is still finished below.
const closingMarker = config.member ? launchMarkerPath(config.agentId, config.projectRoot, config.member, "closing") : null;

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
  // Wait for the launching CLI to go away. The group state outlives the launch
  // that created it, so the markers, not the directory, say whether anything
  // is left to finish: the launcher writes "done" when its own exit sequence
  // ran to the end, and only a launcher that died before that needs this one.
  let watching = true;
  while (processAlive(config.parentPid) && existsSync(stateDir)) {
    if (watching && closingMarker && existsSync(closingMarker)) {
      await watch.drain();
      watching = false;
    }
    await delay(watching ? 1000 : 100);
  }
  await watch.drain();
  const finished = Boolean(config.member) && launchFinished(config.agentId, config.projectRoot, config.member);
  if (!processAlive(config.parentPid) && existsSync(stateDir) && !finished) {
    await finish();
  }
} catch (error) {
  await appendFile(`${stateDir}.watchdog.log`, `${new Date().toISOString()} ${error?.stack ?? error}\n`).catch(() => {});
}
