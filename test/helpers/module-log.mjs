// `--import` this file (NODE_OPTIONS) to have a CLI process append the URL of
// every module it loads to $AVENIC_MODULE_LOG. It exists so a test can prove a
// negative — that a plain `avenic claude` never loads the brand or prompt
// layers — instead of trusting a source-level grep.
import { writeFileSync } from "node:fs";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

writeFileSync(process.env.AVENIC_MODULE_LOG, "");
register("./module-log-hook.mjs", pathToFileURL(import.meta.filename));
