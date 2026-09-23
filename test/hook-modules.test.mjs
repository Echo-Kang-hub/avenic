// `avenic hook emit` runs once per turn of every agent, so its import graph is
// part of its cost: the process exists to read one payload and leave, and it
// must not pay for the dispatcher's whole world — the prompt renderer, the
// brand, the session machinery. That is a negative, and it is provable the same
// way the launch fast path's is: run the real entry with a loader hook that
// logs every module it resolves, then read the log.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(packageRoot, "packages", "cli", "scripts", "skills.mjs");
const moduleLog = pathToFileURL(path.join(packageRoot, "test", "helpers", "module-log.mjs")).href;

test("a hook emit never loads the dispatcher or the terminal layer", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-hook-modules-"));
  try {
    const project = path.join(root, "project");
    const home = path.join(root, "home");
    await Promise.all([mkdir(project, { recursive: true }), mkdir(home, { recursive: true })]);
    const environment = {
      HOME: home,
      USERPROFILE: home,
      CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
      CODEX_HOME: path.join(home, ".codex"),
      AVENIC_STATE_DIR: path.join(root, "state"),
    };
    const run = (argumentsList, { input, log }) =>
      spawnSync(process.execPath, [entry, ...argumentsList], {
        cwd: project,
        input,
        encoding: "utf8",
        env: { ...environment, AVENIC_MODULE_LOG: log, NODE_OPTIONS: `--import ${moduleLog}` },
      });

    const emitLog = path.join(root, "emit.log");
    const emitted = run(["hook", "emit", "--agent", "claude", "--json"], {
      input: JSON.stringify({ hook_event_name: "Stop", session_id: "modules-session", prompt_id: "modules-turn", cwd: project }),
      log: emitLog,
    });
    assert.equal(emitted.status, 0, emitted.stderr);
    assert.equal(JSON.parse(emitted.stdout).accepted, true);
    const loaded = await readFile(emitLog, "utf8");
    assert.match(loaded, /hooks-cli\.mjs/, "no CLI module was logged — the log proves nothing");
    for (const layer of ["dispatcher\\.mjs", "prompts\\.mjs", "brand\\.mjs", "launch\\.mjs", "status-cli\\.mjs", "self-update\\.mjs", "skills-cli\\.mjs"]) {
      assert.doesNotMatch(loaded, new RegExp(layer), `a hook emit must not load ${layer}`);
    }

    // The other half of the proof: a command that does render the terminal layer
    // loads exactly those modules through the same logger.
    const helpLog = path.join(root, "help.log");
    const helped = run(["--help"], { log: helpLog });
    assert.equal(helped.status, 0, helped.stderr);
    const drawn = await readFile(helpLog, "utf8");
    assert.match(drawn, /dispatcher\.mjs/, "the control command must load the dispatcher");
    assert.match(drawn, /prompts\.mjs/, "the control command must load the prompt layer");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
