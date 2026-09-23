import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

// Every one of the product's own files — a canonical session, the project
// config, the cursors, the state stamp — is written the same way: to a
// temporary name beside the target, then renamed over it, so a reader only
// ever sees a whole file. This is that one implementation.
//
// The rename is the part that needs care. On Windows, replacing a file that
// another process is holding is refused, and the holder is often not the user:
// a real experiment died mid-capture with
//
//   EPERM: operation not permitted, rename '…mappings.json.tmp-…' -> '…mappings.json'
//
// because a virus scanner had just opened the freshly written temporary file.
// That refusal is transient by nature — the holder lets go in milliseconds —
// so it is retried, briefly and a bounded number of times. Every other failure
// is the file system telling the truth and is reported immediately.

const REFUSED = new Set(["EPERM", "EACCES", "EBUSY"]);
const ATTEMPTS = 5;
const DELAY_MS = 50;

export async function writeFileAtomic(file, value, { mode, renameFile = rename, removeFile = rm, writeFile: write = writeFile, attempts = ATTEMPTS, delayMs = DELAY_MS } = {}) {
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  await mkdir(path.dirname(file), { recursive: true });
  // The temporary file is Avenic's own, and a write that fails halfway through
  // is still a failed write: it leaves no more of itself behind than a failed
  // command leaves output. That holds for the write itself as much as for the
  // rename — anything else strands a half-written file beside the real one.
  const discard = () => removeFile(temporary, { force: true }).catch(() => {});
  try {
    await write(temporary, value, mode === undefined ? { encoding: "utf8" } : { encoding: "utf8", mode });
  } catch (error) {
    await discard();
    throw error;
  }
  for (let attempt = 1; ; attempt += 1) {
    try {
      await renameFile(temporary, file);
      return file;
    } catch (error) {
      if (!REFUSED.has(error?.code) || attempt >= attempts) {
        await discard();
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
}
