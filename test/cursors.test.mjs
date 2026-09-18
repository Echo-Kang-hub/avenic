import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  cachedHead,
  cursorFilePath,
  loadCursors,
  rememberHead,
  sameStamp,
  saveCursors,
  stampOf,
} from "../packages/core/src/runtime/cursors.mjs";

async function workspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-cursors-"));
  const projectRoot = path.join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  return {
    root,
    projectRoot,
    environment: { AVENIC_STATE_DIR: path.join(root, "state") },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("stampOf reports size and mtime and null for a missing file", async () => {
  const { projectRoot, cleanup } = await workspace();
  try {
    const file = path.join(projectRoot, "a.jsonl");
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
  const { projectRoot, environment, cleanup } = await workspace();
  try {
    assert.equal(cursorFilePath(projectRoot, environment).startsWith(path.resolve(projectRoot)), false);
  } finally { await cleanup(); }
});

test("saveCursors round-trips", async () => {
  const { projectRoot, environment, cleanup } = await workspace();
  try {
    const cursors = loadCursors(projectRoot, environment);
    cursors.agents.codex = { files: { "rollout.jsonl": { native: { size: 3, mtimeMs: 4 } } } };
    await saveCursors(projectRoot, cursors, environment);
    assert.deepEqual(
      loadCursors(projectRoot, environment).agents.codex.files["rollout.jsonl"].native,
      { size: 3, mtimeMs: 4 },
    );
  } finally { await cleanup(); }
});

test("saveCursors skips the write when nothing changed", async () => {
  const { projectRoot, environment, cleanup } = await workspace();
  try {
    await saveCursors(projectRoot, loadCursors(projectRoot, environment), environment);
    const file = cursorFilePath(projectRoot, environment);
    const before = await stat(file);
    await saveCursors(projectRoot, loadCursors(projectRoot, environment), environment);
    const after = await stat(file);
    assert.equal(after.mtimeMs, before.mtimeMs);
  } finally { await cleanup(); }
});

test("a damaged cursor file is a cache miss, not a failure", async () => {
  const { projectRoot, environment, cleanup } = await workspace();
  try {
    await saveCursors(projectRoot, loadCursors(projectRoot, environment), environment);
    await writeFile(cursorFilePath(projectRoot, environment), "{ not json");
    assert.deepEqual(loadCursors(projectRoot, environment), { schemaVersion: 1, agents: {} });
  } finally { await cleanup(); }
});

test("cachedHead returns only an exactly matching stamp", async () => {
  const { projectRoot, environment, cleanup } = await workspace();
  try {
    const cursors = loadCursors(projectRoot, environment);
    const file = path.join(projectRoot, "a.jsonl");
    rememberHead(cursors, "claude", file, { size: 10, mtimeMs: 20 }, { cwd: "C:\\x" });
    assert.deepEqual(cachedHead(cursors, "claude", file, { size: 10, mtimeMs: 20 }), { cwd: "C:\\x" });
    assert.equal(cachedHead(cursors, "claude", file, { size: 11, mtimeMs: 20 }), undefined);
    assert.equal(cachedHead(cursors, "claude", `${file}.other`, { size: 10, mtimeMs: 20 }), undefined);
    assert.equal(cachedHead(cursors, "codex", file, { size: 10, mtimeMs: 20 }), undefined);
  } finally { await cleanup(); }
});

test("a known-unreadable head is cached as a hit, not re-read every time", async () => {
  const { projectRoot, environment, cleanup } = await workspace();
  try {
    const cursors = loadCursors(projectRoot, environment);
    const file = path.join(projectRoot, "a.jsonl");
    rememberHead(cursors, "claude", file, { size: 1, mtimeMs: 2 }, null);
    assert.equal(cachedHead(cursors, "claude", file, { size: 1, mtimeMs: 2 }), null);
  } finally { await cleanup(); }
});

test("file state and head state never share a key space", async () => {
  const { projectRoot, environment, cleanup } = await workspace();
  try {
    const cursors = loadCursors(projectRoot, environment);
    cursors.agents.claude = { files: { "a.jsonl": { native: { size: 1, mtimeMs: 2 } } } };
    rememberHead(cursors, "claude", "a.jsonl", { size: 1, mtimeMs: 2 }, { cwd: "C:\\x" });
    assert.equal(cursors.agents.claude.files["a.jsonl"].native.size, 1);
    assert.equal(cursors.agents.claude.heads["a.jsonl"].head.cwd, "C:\\x");
  } finally { await cleanup(); }
});
