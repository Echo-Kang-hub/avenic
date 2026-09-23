import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
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

/** The mode the file has now, or `undefined` when there is no file yet. */
async function existingMode(file) {
  try {
    return (await stat(file)).mode & 0o7777;
  } catch {
    return undefined;
  }
}

export async function writeFileAtomic(file, value, { mode, renameFile = rename, removeFile = rm, writeFile: write = writeFile, attempts = ATTEMPTS, delayMs = DELAY_MS } = {}) {
  // The name ends in `.avenic-tmp` because that is the name the project's
  // ignore rules promise to cover: the temporary is a copy of its target, and a
  // target can hold a credential, so a kill between the write and the rename
  // must not leave something a `git add -A` could pick up.
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}.avenic-tmp`;
  await mkdir(path.dirname(file), { recursive: true });
  // The rename replaces the file — inode and all — so the temporary's mode is
  // the mode the target ends up with. A caller that says nothing about
  // permissions is saying "as it was": a file created owner-only because a
  // credential lives in it must not become world-readable because something
  // rewrote it. A caller that names a mode gets that mode.
  const permissions = mode ?? await existingMode(file);
  // The temporary file is Avenic's own, and a write that fails halfway through
  // is still a failed write: it leaves no more of itself behind than a failed
  // command leaves output. That holds for the write itself as much as for the
  // rename — anything else strands a half-written file beside the real one.
  const discard = () => removeFile(temporary, { force: true }).catch(() => {});
  try {
    await write(temporary, value, permissions === undefined ? { encoding: "utf8" } : { encoding: "utf8", mode: permissions });
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

/**
 * Create a file that is not there yet, and only then: `wx` asks the file system
 * for it in one step, so a file that appeared between "is it there?" and "write
 * it" is not overwritten — the answer is `false` and the file stays whoever's it
 * already was. A check followed by a write is two steps, and whatever the check
 * said was missing can be somebody's by the time the write runs; a write that
 * cannot replace anything has no such moment, and a caller that learns `false`
 * knows the file it was about to prepare is not the one it would be preparing.
 *
 * The mode is the caller's to name, because the files prepared this way hold
 * credentials: the configuration Avenic prepares for an agent is owner-only.
 */
export async function createFileExclusive(file, value, { mode, mkdir: makeDir = mkdir, writeFile: write = writeFile } = {}) {
  await makeDir(path.dirname(file), { recursive: true });
  try {
    await write(file, value, mode === undefined ? { encoding: "utf8", flag: "wx" } : { encoding: "utf8", flag: "wx", mode });
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  }
}
