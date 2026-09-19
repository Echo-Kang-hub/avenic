// The resolve hook behind module-log.mjs: append every file URL the process is
// about to load. Hooks run on a worker thread, so the log is append-only text.
import { appendFileSync } from "node:fs";

export async function resolve(specifier, context, next) {
  const resolved = await next(specifier, context);
  if (resolved.url.startsWith("file:")) appendFileSync(process.env.AVENIC_MODULE_LOG, `${resolved.url}\n`);
  return resolved;
}
