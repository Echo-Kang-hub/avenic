import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { revertFrom, snapshotInto } from "../packages/core/src/runtime/sessions.mjs";
import { importProjectSessions } from "../packages/core/src/runtime/session-interop.mjs";
import { withClaudeProject } from "./helpers/session-fixture.mjs";

async function withTree(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-revert-"));
  try {
    await run({ root, native: path.join(root, "native"), snapshot: path.join(root, "snapshot") });
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
}

test("reverting unchanged native storage leaves the files untouched", async () => {
  await withTree(async ({ native, snapshot }) => {
    await mkdir(native, { recursive: true });
    await writeFile(path.join(native, "a.jsonl"), "one\n");
    await writeFile(path.join(native, "b.jsonl"), "two\n");
    const before = await stat(path.join(native, "a.jsonl"));

    await snapshotInto(native, snapshot);
    // A launch that changed nothing: the revert must be a no-op for content,
    // and must not touch the file stamps the incremental capture relies on.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await revertFrom(snapshot, native);

    assert.equal(await readFile(path.join(native, "a.jsonl"), "utf8"), "one\n");
    assert.equal((await stat(path.join(native, "a.jsonl"))).mtimeMs, before.mtimeMs, "identical files must keep their stamp");
  });
});

test("reverting discards run writes and restores changed files", async () => {
  await withTree(async ({ native, snapshot }) => {
    await mkdir(native, { recursive: true });
    await writeFile(path.join(native, "a.jsonl"), "before\n");
    await snapshotInto(native, snapshot);

    await writeFile(path.join(native, "a.jsonl"), "before\nappended during the run\n");
    await writeFile(path.join(native, "new.jsonl"), "created during the run\n");
    await revertFrom(snapshot, native);

    assert.equal(await readFile(path.join(native, "a.jsonl"), "utf8"), "before\n");
    await assert.rejects(() => readFile(path.join(native, "new.jsonl"), "utf8"), { code: "ENOENT" });
  });
});

// Claude Code creates the project's session directory when it starts and fills
// it once the first message goes out, so "the directory exists and holds
// nothing" is the normal state of a project the agent has only been opened in.
// Snapshotting it must terminate: an empty tree copies no file, and a code path
// that only creates the destination as a side effect of copying one then never
// creates it.
test("snapshotting an empty native tree terminates", { timeout: 5000 }, async () => {
  await withTree(async ({ native, snapshot }) => {
    await mkdir(native, { recursive: true });
    await snapshotInto(native, snapshot);
    assert.equal((await stat(snapshot)).isDirectory(), true, "the snapshot must exist as a directory");
    assert.deepEqual(await readdir(snapshot), []);
  });
});

test("reverting an empty snapshot terminates", { timeout: 5000 }, async () => {
  await withTree(async ({ native, snapshot }) => {
    await mkdir(snapshot, { recursive: true });
    await mkdir(native, { recursive: true });
    await revertFrom(snapshot, native);
    assert.deepEqual(await readdir(native), []);
  });
});

test("a reverting launch does not make the next capture re-import every session", async () => {
  await withClaudeProject(async ({ projectRoot, environment, sessionIds, snapshotAndRevert }) => {
    const first = await importProjectSessions(projectRoot, "claude", { environment });
    assert.equal(first.imported, sessionIds.length);

    // The launch group's exit path: snapshot before, revert after, nothing
    // changed in between.
    await snapshotAndRevert();

    const second = await importProjectSessions(projectRoot, "claude", { environment });
    assert.equal(second.imported, 0, "an unchanged native tree must not be re-imported after a revert");
    assert.equal(second.skipped, sessionIds.length);
  }, { sessions: 6, records: 40 });
});
