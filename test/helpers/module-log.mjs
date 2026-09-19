// `--import` this file (NODE_OPTIONS) to have a CLI process append the URL of
// every module it loads to $AVENIC_MODULE_LOG. It exists so a test can prove a
// negative — that a plain `avenic claude` never loads the brand or prompt
// layers — instead of trusting a source-level grep.
import { writeFileSync } from "node:fs";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

// A launch spawns the agent as a child process, and it inherits NODE_OPTIONS:
// the child imports this file too, into the same log. Truncating on every
// import let that child erase the modules its parent had already recorded —
// the assertion then read a log holding only the agent's own file, and failed
// as if the CLI had loaded nothing. Only the process that owns the log starts
// it empty; every process below appends.
if (!process.env.AVENIC_MODULE_LOG_OWNER) {
  writeFileSync(process.env.AVENIC_MODULE_LOG, "");
  process.env.AVENIC_MODULE_LOG_OWNER = String(process.pid);
}
register("./module-log-hook.mjs", pathToFileURL(import.meta.filename));
