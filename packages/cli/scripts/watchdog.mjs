// Detached helper for `avenic <agent>` launches. When the launching CLI
// process disappears without a normal exit (terminal closed, killed), it
// finishes the launch's cleanup: the run's sessions are captured into the
// project and, for the last launch of the group, the agent's native storage
// is restored to its pre-launch state.
import { appendFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import process from "node:process";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  getSessionAdapter,
  observeSharedNativeSessions,
  processAlive,
  releaseSessionLease,
  sessionLeasePath,
} from "#core";

const stateDir = process.argv[2];
const config = JSON.parse(await readFile(path.join(stateDir, "watchdog.json"), "utf8"));
const adapter = getSessionAdapter(config.agentId);

async function finish() {
  // Capture first so the interrupted session is not lost, then leave the
  // launch group; the last one to leave restores the native storage.
  await observeSharedNativeSessions(config.projectRoot, config.agentId, {
    environment: config.environment,
    setActive: false,
    force: true,
  });
  await releaseSessionLease(config.agentId, config.projectRoot, config.member, {
    onLast: async () => {
      // A snapshot marker means the group's snapshot completed: only then is
      // a revert meaningful (the launch may have died mid-snapshot).
      if (existsSync(path.join(stateDir, "snapshot.ok"))) {
        await adapter.revertNative(path.join(stateDir, "snapshot"), config.projectRoot, {
          environment: config.environment,
        });
      }
    },
  });
}

try {
  // Wait for the launching CLI to go away. The group state directory is
  // removed on a normal exit, which also ends the watch.
  while (processAlive(config.parentPid) && existsSync(stateDir)) {
    await delay(1000);
  }
  if (!processAlive(config.parentPid) && existsSync(stateDir)) {
    await finish();
  }
} catch (error) {
  await appendFile(`${stateDir}.watchdog.log`, `${new Date().toISOString()} ${error?.stack ?? error}\n`).catch(() => {});
}
