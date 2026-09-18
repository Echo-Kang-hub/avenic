import assert from "node:assert/strict";
import { existsSync } from "node:fs";
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

// 快照会记下取快照时每个 native 文件的戳；回滚据此判定「这次运行有没有动过它」，
// 从而只把动过的文件写回去。戳相同但内容不同的文件必须仍然被还原，否则跳过就是丢数据。
test("a revert restores a file the run rewrote under the same size", async () => {
  await withTree(async ({ native, snapshot }) => {
    await mkdir(native, { recursive: true });
    await writeFile(path.join(native, "a.jsonl"), "before\n");
    await snapshotInto(native, snapshot);

    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(path.join(native, "a.jsonl"), "after!\n"); // 与 before 等长
    await revertFrom(snapshot, native);

    assert.equal(await readFile(path.join(native, "a.jsonl"), "utf8"), "before\n");
  });
});

test("a revert leaves the files the run never touched alone", async () => {
  await withTree(async ({ native, snapshot }) => {
    await mkdir(native, { recursive: true });
    await writeFile(path.join(native, "a.jsonl"), "one\n");
    await writeFile(path.join(native, "b.jsonl"), "two\n");
    await snapshotInto(native, snapshot);
    const untouched = await stat(path.join(native, "a.jsonl"));

    await writeFile(path.join(native, "b.jsonl"), "two\nthe run's work\n");
    await revertFrom(snapshot, native);

    assert.equal(await readFile(path.join(native, "b.jsonl"), "utf8"), "two\n");
    const after = await stat(path.join(native, "a.jsonl"));
    assert.equal(after.mtimeMs, untouched.mtimeMs, "未改动的会话文件不能被重写");
  });
});

// 还原工程把项目会话写回 native，而 native 每次运行结束都会被还原成运行前的样子——
// 于是同样几个文件会被反复渲染、反复写回同样的字节。游标记下两侧的戳，跳过没动过的
// 文件；两侧任一变化都必须重新写回，否则项目副本就再也到不了 native。
test("a restore skips what is already in place and still repairs what is not", async () => {
  await withClaudeProject(async ({ projectRoot, environment, sessionIds, nativeFile, portableFile }) => {
    const { getSessionAdapter } = await import("../packages/core/src/runtime/adapters/index.mjs");
    const adapter = getSessionAdapter("claude");
    await importProjectSessions(projectRoot, "claude", { environment });
    await adapter.restore(projectRoot, { environment });

    const before = await Promise.all(sessionIds.map((id) => stat(nativeFile(id))));
    const repeat = await adapter.restore(projectRoot, { environment });
    assert.equal(repeat.unchanged, sessionIds.length);
    assert.equal(repeat.added + repeat.updated, 0);
    const after = await Promise.all(sessionIds.map((id) => stat(nativeFile(id))));
    assert.deepEqual(after.map((stats) => stats.mtimeMs), before.map((stats) => stats.mtimeMs));

    // native 被删掉：游标不能把它当成「已就位」
    await rm(nativeFile(sessionIds[0]), { force: true });
    await adapter.restore(projectRoot, { environment });
    assert.equal(existsSync(nativeFile(sessionIds[0])), true);

    // native 被改写：项目副本覆盖回去，且写回的是还原过的根路径
    await writeFile(nativeFile(sessionIds[1]), "tampered\n");
    await adapter.restore(projectRoot, { environment });
    const restored = await readFile(nativeFile(sessionIds[1]), "utf8");
    assert.equal(JSON.parse(restored.split("\n", 1)[0]).cwd, projectRoot);

    // 项目一侧有了新内容：也要写回去（游标必须同时校验两侧）
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(portableFile(sessionIds[2]), `${await readFile(portableFile(sessionIds[2]), "utf8")}\n`);
    const grown = await adapter.restore(projectRoot, { environment });
    assert.equal(grown.added + grown.updated, 1);
  }, { sessions: 3, records: 4 });
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
