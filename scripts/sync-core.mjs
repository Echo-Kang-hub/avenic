import { cp, rm, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "packages", "core", "src");
const target = path.join(root, "packages", "cli", "vendor", "core-src");

// Copy beside the target, then swap: `pretest` runs this while a suite in
// another terminal may be importing from `target`, and an `rm -rf` followed by
// a recursive copy leaves that window open for the whole copy. The window here
// is one remove plus one rename, both metadata-only.
//
// The swap is retried because Windows can refuse it for a moment after the
// copy — a scanner or an open handle on a file that was just written — and a
// half-done sync is worse than a slow one. A sync that never lands keeps its
// complete copy on disk and says where, rather than removing the evidence.
const staging = `${target}.staging-${process.pid}`;
await rm(staging, { recursive: true, force: true });
await cp(source, staging, { recursive: true });
try {
  for (let attempt = 1; ; attempt += 1) {
    await rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    try {
      await rename(staging, target);
      break;
    } catch (error) {
      if (attempt >= 10) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
} catch (error) {
  console.error(`core sync failed; the complete copy is at ${staging}`);
  throw error;
}
// stderr: `npm pack --json` must stay machine-readable on stdout.
console.error(`core synced -> ${target}`);
