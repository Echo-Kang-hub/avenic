import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  cachedCwd,
  cursorFilePath,
  loadCursors,
  rememberCwd,
  sameStamp,
  saveCursors,
  stampOf,
} from "../packages/core/src/runtime/cursors.mjs";

async function workspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-cursors-"));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("stampOf reports size and mtime and null for a missing file", async () => {
  const { root, cleanup } = await workspace();
  try {
    const file = path.join(root, "a.jsonl");
    assert.equal(await stampOf(file), null);
    await writeFile(file, "one\n");
    const first = await stampOf(file);
    assert.equal(first.size, 4);
    assert.equal(typeof first.mtimeMs, "number");
  } finally { await cleanup(); }
});

test("sameStamp compares size and mtime", () => {
  assert.equal(sameStamp({ size: 1, mtimeMs: 2 }, { size: 1, mtimeMs: 2 }), true);
  assert.equal(sameStamp({ size: 1, mtimeMs: 2 }, { size: 1, mtimeMs: 3 }), false);
  assert.equal(sameStamp(null, { size: 1, mtimeMs: 2 }), false);
  assert.equal(sameStamp({ size: 1, mtimeMs: 2 }, null), false);
});

test("cursor state lives outside the project tree", async () => {
  const { root, cleanup } = await workspace();
  try {
    assert.equal(cursorFilePath(root).startsWith(path.resolve(root)), false);
  } finally { await cleanup(); }
});

test("saveCursors round-trips", async () => {
  const { root, cleanup } = await workspace();
  try {
    const cursors = loadCursors(root);
    cursors.agents.codex = { files: { "rollout.jsonl": { native: { size: 3, mtimeMs: 4 } } } };
    await saveCursors(root, cursors);
    assert.deepEqual(loadCursors(root).agents.codex.files["rollout.jsonl"].native, { size: 3, mtimeMs: 4 });
  } finally { await cleanup(); }
});

test("saveCursors skips the write when nothing changed", async () => {
  const { root, cleanup } = await workspace();
  try {
    await saveCursors(root, loadCursors(root));
    const file = cursorFilePath(root);
    const before = await stat(file);
    await saveCursors(root, loadCursors(root));
    const after = await stat(file);
    assert.equal(after.mtimeMs, before.mtimeMs);
  } finally { await cleanup(); }
});

test("a damaged cursor file is a cache miss, not a failure", async () => {
  const { root, cleanup } = await workspace();
  try {
    await saveCursors(root, loadCursors(root));
    await writeFile(cursorFilePath(root), "{ not json");
    assert.deepEqual(loadCursors(root), { schemaVersion: 1, agents: {} });
  } finally { await cleanup(); }
});

test("cachedCwd returns only an exactly matching stamp", () => {
  const cursors = loadCursors(path.join(os.tmpdir(), "avenic-no-such-project"));
  const file = path.join(os.tmpdir(), "avenic-no-such-project", "a.jsonl");
  rememberCwd(cursors, "claude", file, { size: 10, mtimeMs: 20 }, "C:\\x");
  assert.equal(cachedCwd(cursors, "claude", file, { size: 10, mtimeMs: 20 }), "C:\\x");
  assert.equal(cachedCwd(cursors, "claude", file, { size: 11, mtimeMs: 20 }), null);
  assert.equal(cachedCwd(cursors, "claude", `${file}.other`, { size: 10, mtimeMs: 20 }), null);
  assert.equal(cachedCwd(cursors, "codex", file, { size: 10, mtimeMs: 20 }), null);
});
