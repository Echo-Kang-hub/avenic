// The fast path is a promise about what a launch does NOT do. `avenic claude`
// must not pay for the terminal layer — no prompt renderer, no brand module,
// above all no 6KB logo — and that is provable: run the real CLI with a loader
// hook that logs every module it resolves, then read the log.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { withClaudeProject } from "./helpers/session-fixture.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const moduleLog = pathToFileURL(path.join(here, "helpers", "module-log.mjs")).href;

test("a plain agent launch never loads the prompt or brand layers", async () => {
  await withClaudeProject(async ({ runCli, projectRoot }) => {
    const hook = {
      AVENIC_MODULE_LOG: path.join(projectRoot, "launch.log"),
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${moduleLog}`.trim(),
    };
    const launched = runCli(["claude"], hook);
    assert.equal(launched.status, 0, launched.stderr);
    const loaded = await readFile(hook.AVENIC_MODULE_LOG, "utf8");

    // The recorder watched this package (core modules are on the path), and the
    // layers a plain launch must never touch are absent from it.
    assert.match(loaded, /packages[\\/]cli[\\/]/, "no CLI module was logged — the log proves nothing");
    assert.doesNotMatch(loaded, /brand-logo\.mjs/, "a plain launch must not load the logo asset");
    assert.doesNotMatch(loaded, /brand\.mjs/, "a plain launch must not load the brand layer");
    assert.doesNotMatch(loaded, /prompts\.mjs/, "a plain launch must not load the prompt layer");
    assert.doesNotMatch(loaded, /dispatcher\.mjs/, "a plain launch must not load the dispatcher");

    // The other half of the proof: a command that does render the terminal
    // layer loads exactly those modules through the same hook.
    const rendered = runCli(["status"], { ...hook, AVENIC_MODULE_LOG: path.join(projectRoot, "status.log") });
    assert.equal(rendered.status, 0, rendered.stderr);
    const drawn = await readFile(path.join(projectRoot, "status.log"), "utf8");
    assert.match(drawn, /prompts\.mjs/, "the control command must load the prompt layer");
    assert.match(drawn, /brand\.mjs/, "the control command must load the brand layer");
  }, { sessions: 2, records: 4 });
});
