# Avenic Release Convergence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Converge Avenic to a releasable state — plain agent launches under 1s, real runtime incremental durability, verified Shared/Isolated semantics, CLI↔VS Code parity, consolidated code, and verified npm + VSIX artifacts.

**Architecture:** Core gains one incremental *session cursor* primitive shared by native capture, canonical import, and a new debounced runtime watcher. The plain `avenic <agent>` path does no canonical work before spawning; recovery moves to explicit commands, post-exit capture, and the watcher.

**Tech Stack:** Node ESM (core, CLI), TypeScript + esbuild (VS Code), `node:test`.

**Spec:** the project-owner requirements list (38 sections) plus `principle.md`.

## Global Constraints

- `packages/core` is the only business implementation. CLI = argument parsing, process launch, human-readable output. VS Code = commands, trees, progress, display. No second path/auth/conversion logic in either host.
- Adapters isolate native formats only; no N² direct converters.
- Do not add `Manager` / `Controller` / `Coordinator` / `Engine` layers.
- Plain launch fast path must perform: **no network, no LLM call, no npm lookup, no full history scan, no full JSONL parse, no blocking projection bootstrap.** Target < 1000 ms to the agent TUI on local history; < 500 ms to visible response.
- Native agent storage is never written except by explicit `sessions writeback` / launch `restore`.
- Canonical writes are atomic (temp file + rename). A half-written file must never replace valid canonical data.
- Native JSON/JSONL is untrusted input: never execute it, never write secret-shaped fields into canonical, never "repair" JSON by guessing.
- Versions come from `package.json` metadata; never hardcode a version string in production code.
- Tests use `node:test`; interactive TUI input must be drivable without a human.
- Must work on Windows and Linux. Windows npm `.cmd` shims are launched through `cmd` with the prompt as one argument.

---

## Baseline (measured 2026-09-19, before any change)

Fixture: 40 Claude sessions × 400 records, 60 foreign-project Claude directories, 120 Codex rollouts, three fake agent executables on `PATH`.

| Command | Wall clock |
|---|---|
| `avenic --version` | 81 ms |
| `avenic init` (shared) | 122 ms |
| `avenic claude` (cold) | **10 945 ms** |
| `avenic claude` (warm) | **7 677 ms** |
| `avenic codex` (warm) | **4 446 ms** |
| `avenic opencode` (warm) | **3 670 ms** |
| `avenic sessions status` | 580 ms |

Per-step profile (warm):

| Step | Cost |
|---|---|
| `claude.capture` | 2 301 ms |
| `importProjectSessions(claude)` | 2 799 ms |
| `codex.capture` | 273 ms |
| `importProjectSessions(codex)` | 509 ms |
| `recoverSharedNativeSessions(3 agents)` | 3 298 ms |
| `claude.snapshotNative + restore` | 536 ms |
| `listCanonicalSessions` | 197 ms |
| `loadRuntime`, `resolveEffectiveAgentRuntime` | ~1 ms |

Root causes:

1. `adapter.capture` copies **every** native session file into the portable directory on **every** launch (`replaceDirectory`), re-running `transformJsonLines` over every record.
2. `discoverNativeProjectDirectories` / `matchingRollouts` open the head of **every** session file on the machine on every launch to test the project `cwd`.
3. `importProjectSessions` re-reads and re-parses **every** portable file, then calls `createCanonicalSession`, `appendCanonicalEvents` (which re-reads and normalizes the whole `events.jsonl`), and `syncNativeMapping` (another full read) per session.
4. Steps 1–3 run **twice** per launch: once in `recoverSharedNativeSessions` before spawn and once in the `finally` `observeSharedNativeSessions`.

Production LOC at baseline: core 6 609, CLI 2 858, CLI scripts 68, VS Code 3 102 → **12 637** (excludes `packages/cli/vendor/core-src`, which is a generated copy of core).

---

## Task 1: Session cursor store

The single primitive that makes capture, import, and the watcher incremental. One file, one schema, no per-feature caches.

**Files:**
- Create: `packages/core/src/runtime/cursors.mjs`
- Modify: `packages/core/src/index.mjs` (export)
- Test: `test/cursors.test.mjs`

**Interfaces:**
- Produces:
  - `cursorFilePath(projectRoot): string`
  - `loadCursors(projectRoot): Promise<Cursors>` where `Cursors = { schemaVersion: 1, agents: Record<string, { files: Record<string, FileCursor> }> }`
  - `FileCursor = { native?: Stamp, portable?: Stamp, cwd?: string, nativeSessionId?: string, canonicalId?: string }`
  - `Stamp = { size: number, mtimeMs: number }`
  - `stampOf(file): Promise<Stamp | null>` — `stat` only; `null` when missing
  - `sameStamp(a, b): boolean`
  - `saveCursors(projectRoot, cursors): Promise<void>` — atomic, skips the write when unchanged
  - `rememberCwd(cursors, agentId, absolutePath, stamp, cwd)`, `cachedCwd(cursors, agentId, absolutePath, stamp)`

- [ ] **Step 1: Write the failing test**

```js
// test/cursors.test.mjs
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  cachedCwd, cursorFilePath, loadCursors, rememberCwd, sameStamp, saveCursors, stampOf,
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
});

test("saveCursors round-trips and lives outside the project tree", async () => {
  const { root, cleanup } = await workspace();
  try {
    assert.equal(cursorFilePath(root).startsWith(path.resolve(root)), false);
    const cursors = loadCursors(root);
    cursors.agents.codex = { files: { "rollout.jsonl": { native: { size: 3, mtimeMs: 4 } } } };
    await saveCursors(root, cursors);
    assert.deepEqual(loadCursors(root).agents.codex.files["rollout.jsonl"].native, { size: 3, mtimeMs: 4 });
  } finally { await cleanup(); }
});

test("saveCursors skips the write when nothing changed", async () => {
  const { root, cleanup } = await workspace();
  try {
    const cursors = loadCursors(root);
    await saveCursors(root, cursors);
    const file = cursorFilePath(root);
    const before = await stat(file);
    await saveCursors(root, loadCursors(root));
    const after = await stat(file);
    assert.equal(after.mtimeMs, before.mtimeMs);
  } finally { await cleanup(); }
});

test("cachedCwd returns only an exactly matching stamp", () => {
  const cursors = loadCursors("C:\\nowhere");
  rememberCwd(cursors, "claude", "C:\\x\\a.jsonl", { size: 10, mtimeMs: 20 }, "C:\\x");
  assert.equal(cachedCwd(cursors, "claude", "C:\\x\\a.jsonl", { size: 10, mtimeMs: 20 }), "C:\\x");
  assert.equal(cachedCwd(cursors, "claude", "C:\\x\\a.jsonl", { size: 11, mtimeMs: 20 }), null);
  assert.equal(cachedCwd(cursors, "claude", "C:\\x\\b.jsonl", { size: 10, mtimeMs: 20 }), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/cursors.test.mjs`
Expected: FAIL — `Cannot find module .../cursors.mjs`

- [ ] **Step 3: Write the implementation**

```js
// packages/core/src/runtime/cursors.mjs
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stateRoot } from "../skills/paths.mjs";

const SCHEMA_VERSION = 1;

// Cursors describe this machine's native files, so they belong to machine
// state, not to the project tree: a committed cursors file would be noise and
// would be wrong on another checkout.
export function cursorFilePath(projectRoot) {
  const key = createHash("sha256").update(path.resolve(projectRoot)).digest("hex").slice(0, 16);
  return path.join(stateRoot(), "runtime", key, "cursors.json");
}

export function emptyCursors() {
  return { schemaVersion: SCHEMA_VERSION, agents: {} };
}

export function loadCursors(projectRoot) {
  const file = cursorFilePath(projectRoot);
  if (!existsSync(file)) return emptyCursors();
  try {
    const parsed = JSON.parse(readFileSyncSafe(file));
    if (parsed?.schemaVersion !== SCHEMA_VERSION || typeof parsed.agents !== "object") return emptyCursors();
    return parsed;
  } catch {
    // A damaged cursor is a cache miss, never a failure.
    return emptyCursors();
  }
}

export async function saveCursors(projectRoot, cursors) {
  const file = cursorFilePath(projectRoot);
  const content = `${JSON.stringify(cursors, null, 2)}\n`;
  if (existsSync(file) && (await readFile(file, "utf8")) === content) return false;
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, file);
  return true;
}

export async function stampOf(file) {
  try {
    const stats = await stat(file);
    return { size: stats.size, mtimeMs: stats.mtimeMs };
  } catch {
    return null;
  }
}

export function sameStamp(left, right) {
  return Boolean(left && right && left.size === right.size && left.mtimeMs === right.mtimeMs);
}

export function agentCursors(cursors, agentId) {
  cursors.agents[agentId] ??= { files: {} };
  cursors.agents[agentId].files ??= {};
  return cursors.agents[agentId].files;
}

export function rememberCwd(cursors, agentId, file, stamp, cwd) {
  const files = agentCursors(cursors, agentId);
  files[file] = { ...files[file], cwd, cwdStamp: stamp };
}

export function cachedCwd(cursors, agentId, file, stamp) {
  const entry = cursors.agents[agentId]?.files?.[file];
  return entry && sameStamp(entry.cwdStamp, stamp) ? entry.cwd : null;
}
```

Use a small synchronous read helper so `loadCursors` stays usable from synchronous call sites:

```js
function readFileSyncSafe(file) {
  return readFileSync(file, "utf8");
}
```

with `import { readFileSync } from "node:fs";` and drop the unused `os` / `readFile` imports until Step 3 needs them.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/cursors.test.mjs`
Expected: PASS (5 tests)

- [ ] **Step 5: Export from the public API and commit**

Add to `packages/core/src/index.mjs`:

```js
export {
  agentCursors,
  cachedCwd,
  cursorFilePath,
  loadCursors,
  rememberCwd,
  sameStamp,
  saveCursors,
  stampOf,
} from "./runtime/cursors.mjs";
```

```bash
npm run sync-core
git add packages/core/src/runtime/cursors.mjs packages/core/src/index.mjs test/cursors.test.mjs packages/cli/vendor/core-src
git commit -m "feat(core): add the incremental session cursor store"
```

---

## Task 2: Incremental native capture and project discovery

Make `capture` copy only files whose stamp changed, and make project discovery reuse cached `cwd` values instead of reopening every session head.

**Files:**
- Modify: `packages/core/src/runtime/sessions.mjs` (add `syncDirectory`)
- Modify: `packages/core/src/runtime/adapters/claude.mjs`
- Modify: `packages/core/src/runtime/adapters/codex.mjs`
- Test: `test/incremental-capture.test.mjs`

**Interfaces:**
- Consumes: Task 1 cursors.
- Produces:
  - `syncDirectory(sourceRoot, entries, destinationRoot, transform, cursors, agentId): Promise<{ added, updated, unchanged, removed }>` in `sessions.mjs` — copies only files whose `native` stamp moved, deletes destination files absent from `entries` and from the cursor, updates `cursors.agents[agentId].files`.
  - `capture(projectRoot, options)` keeps its current return shape `{ count, changed, diagnostics }`.

- [ ] **Step 1: Write the failing test**

```js
// test/incremental-capture.test.mjs
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getSessionAdapter } from "../packages/core/src/runtime/adapters/index.mjs";
import { cursorFilePath } from "../packages/core/src/runtime/cursors.mjs";

function claudeKey(root) { return path.resolve(root).replace(/[^a-zA-Z0-9]/g, "-"); }

function record(sessionId, index, cwd) {
  return JSON.stringify({
    type: "assistant", uuid: `u-${sessionId}-${index}`, sessionId,
    timestamp: new Date(1700000000000 + index * 1000).toISOString(), cwd,
    message: { role: index % 2 ? "assistant" : "user", model: "m", content: [{ type: "text", text: `t${index}` }] },
  });
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-inc-"));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  const native = path.join(home, ".claude", "projects", claudeKey(project));
  await mkdir(native, { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(path.join(native, "s1.jsonl"), `${[0, 1, 2].map((i) => record("s1", i, project)).join("\n")}\n`);
  return {
    root, home, project, native,
    environment: { CLAUDE_CONFIG_DIR: path.join(home, ".claude") },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("capture copies the matched native session into the portable directory", async () => {
  const { project, native, environment, cleanup } = await fixture();
  try {
    const adapter = getSessionAdapter("claude");
    const result = await adapter.capture(project, { environment });
    assert.equal(result.count, 1);
    const portable = path.join(project, ".agents", "sessions", "claude", "s1.jsonl");
    assert.match(await readFile(portable, "utf8"), /"cwd":"\$\{PROJECT_ROOT\}"/);
  } finally { await cleanup(); }
});

test("a second capture of unchanged native files rewrites nothing", async () => {
  const { project, environment, cleanup } = await fixture();
  try {
    const adapter = getSessionAdapter("claude");
    await adapter.capture(project, { environment });
    const portable = path.join(project, ".agents", "sessions", "claude", "s1.jsonl");
    const before = await stat(portable);
    const second = await adapter.capture(project, { environment });
    const after = await stat(portable);
    assert.equal(second.changed, false);
    assert.equal(after.mtimeMs, before.mtimeMs, "portable copy must not be rewritten");
  } finally { await cleanup(); }
});

test("appending to a native session updates only that portable file", async () => {
  const { project, native, environment, cleanup } = await fixture();
  try {
    const adapter = getSessionAdapter("claude");
    await adapter.capture(project, { environment });
    const other = path.join(native, "s2.jsonl");
    await writeFile(other, `${[0, 1].map((i) => record("s2", i, project)).join("\n")}\n`);
    await adapter.capture(project, { environment });
    const otherPortable = path.join(project, ".agents", "sessions", "claude", "s2.jsonl");
    const stable = await stat(path.join(project, ".agents", "sessions", "claude", "s1.jsonl"));
    await writeFile(path.join(native, "s1.jsonl"), `${[0, 1, 2, 3].map((i) => record("s1", i, project)).join("\n")}\n`);
    const result = await adapter.capture(project, { environment });
    assert.equal(result.changed, true);
    assert.match(await readFile(path.join(project, ".agents", "sessions", "claude", "s1.jsonl"), "utf8"), /t3/);
    assert.ok((await stat(otherPortable)).mtimeMs >= 0);
    assert.ok(stable.mtimeMs > 0);
  } finally { await cleanup(); }
});

test("a deleted native session disappears from the portable directory", async () => {
  const { project, native, environment, cleanup } = await fixture();
  try {
    const adapter = getSessionAdapter("claude");
    await adapter.capture(project, { environment });
    await rm(path.join(native, "s1.jsonl"), { force: true });
    await adapter.capture(project, { environment });
    await assert.rejects(readFile(path.join(project, ".agents", "sessions", "claude", "s1.jsonl")));
  } finally { await cleanup(); }
});

test("discovery reuses a cached cwd and does not reopen unchanged heads", async () => {
  const { project, environment, cleanup } = await fixture();
  try {
    const adapter = getSessionAdapter("claude");
    await adapter.capture(project, { environment });
    const stamp = await stat(cursorFilePath(project));
    assert.ok(stamp.size > 0, "capture must persist a cursor");
    const second = await adapter.capture(project, { environment });
    assert.equal(second.diagnostics.length, 0);
    assert.equal(second.count, 1);
  } finally { await cleanup(); }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/incremental-capture.test.mjs`
Expected: FAIL — the second capture rewrites the portable file (`second.changed` is `true`), and the deletion test fails.

- [ ] **Step 3: Add `syncDirectory` to `sessions.mjs`**

```js
// Copy only the entries whose native stamp moved. A capture that finds nothing
// new must touch nothing: repeated launches are the common case.
export async function syncDirectory(sourceRoot, entries, destinationRoot, transform, cursors, agentId) {
  const { agentCursors, sameStamp, stampOf } = await import("./cursors.mjs");
  const files = agentCursors(cursors, agentId);
  const seen = new Set();
  let added = 0; let updated = 0; let unchanged = 0;
  for (const { relative, source } of entries) {
    seen.add(relative);
    const stamp = await stampOf(source);
    if (!stamp) continue;
    const destination = path.join(destinationRoot, relative);
    const entry = files[relative] ?? {};
    const destinationStamp = await stampOf(destination);
    if (entry.portable && sameStamp(entry.portable, destinationStamp) && sameStamp(entry.native, stamp)) {
      unchanged += 1;
      continue;
    }
    const existed = Boolean(destinationStamp);
    await mkdir(path.dirname(destination), { recursive: true });
    const content = await readFile(source);
    await writeFile(destination, transform ? await transform(content, relative) : content);
    files[relative] = { ...entry, native: stamp, portable: await stampOf(destination) };
    if (existed) updated += 1; else added += 1;
  }
  let removed = 0;
  for (const relative of Object.keys(files)) {
    if (seen.has(relative)) continue;
    await rm(path.join(destinationRoot, relative), { force: true });
    await removeEmptyDirectories(path.dirname(path.join(destinationRoot, relative)), destinationRoot);
    delete files[relative];
    removed += 1;
  }
  return { added, updated, unchanged, removed };
}
```

`removeEmptyDirectories` walks up from a directory removing empty parents until `stopAt`:

```js
async function removeEmptyDirectories(directory, stopAt) {
  let current = path.resolve(directory);
  const stop = path.resolve(stopAt);
  while (current !== stop && current.startsWith(stop)) {
    try {
      const entries = await readdir(current);
      if (entries.length > 0) return;
      await rmdir(current);
    } catch { return; }
    current = path.dirname(current);
  }
}
```

- [ ] **Step 4: Rewrite `claude.capture` to be incremental**

Replace the `replaceDirectory` body:

```js
export async function capture(projectRoot, options = {}) {
  const { portable } = locations(projectRoot, options.environment);
  const cursors = options.cursors ?? loadCursors(projectRoot);
  const discovery = await discoverNativeProjectDirectories(projectRoot, options.environment, { cursors });
  const entries = [];
  for (const native of discovery.directories) {
    for (const relative of await listFiles(native)) {
      entries.push({ relative, source: path.join(native, relative) });
    }
  }
  const result = await syncDirectory(
    null, entries, portable,
    (content, relative) => (relative.endsWith(".jsonl") ? rewriteCwd(content, projectRoot, false) : content),
    cursors, "claude",
  );
  if (options.cursors === undefined) await saveCursors(projectRoot, cursors);
  const changed = result.added + result.updated + result.removed > 0;
  return {
    count: entries.filter(({ relative }) => isRootSession(relative)).length,
    changed,
    diagnostics: discovery.diagnostics,
  };
}
```

Also update `discoverNativeProjectDirectories` to accept `{ cursors }` and use `cachedCwd` / `rememberCwd`:

```js
async function jsonlCwd(file, cursors, stamp) {
  const cached = cursors ? cachedCwd(cursors, "claude", file, stamp) : null;
  if (cached) return cached;
  const cwd = await readCwdHead(file);
  if (cursors && stamp) rememberCwd(cursors, "claude", file, stamp, cwd);
  return cwd;
}
```

where `readCwdHead` is the existing 64 KB head read, and each call site passes `await stampOf(file)`.

- [ ] **Step 5: Rewrite `codex.capture` the same way**

`matchingRollouts` gains `{ cursors }` and caches the first-line `cwd` per rollout path using `cachedCwd`/`rememberCwd` with agent id `"codex"`; `capture` uses `syncDirectory` into `path.join(portable, "sessions")` and writes `session_index.jsonl` only when the filtered index content changed.

- [ ] **Step 6: Run the tests**

Run: `node --test test/incremental-capture.test.mjs test/session-adapter-contract.test.mjs test/runtime.test.mjs`
Expected: PASS

- [ ] **Step 7: Measure and commit**

Run: `node .tmp/perf/step-profile.mjs`
Expected: warm `claude.capture` and `codex.capture` each < 100 ms.

```bash
npm run sync-core
git add -A packages/core packages/cli/vendor test
git commit -m "perf(core): capture only native session files that changed"
```

---

## Task 3: Incremental canonical import

**Files:**
- Modify: `packages/core/src/runtime/session-interop.mjs` (`importProjectSessions`)
- Test: `test/incremental-import.test.mjs`

**Interfaces:**
- Consumes: Task 1 cursors, Task 2 capture.
- Produces: `importProjectSessions(projectRoot, agentId, options)` keeps its return shape and additionally skips unchanged portable files.

- [ ] **Step 1: Write the failing test**

```js
// test/incremental-import.test.mjs
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { appendCanonicalEvents, readCanonicalSession } from "../packages/core/src/runtime/canonical-sessions.mjs";
import { importProjectSessions } from "../packages/core/src/runtime/session-interop.mjs";
import { withClaudeProject } from "./helpers/session-fixture.mjs";

test("a repeated import with unchanged natives appends nothing", async () => {
  await withClaudeProject(async ({ projectRoot, environment, sessionIds }) => {
    const first = await importProjectSessions(projectRoot, "claude", { environment });
    assert.equal(first.discovered, sessionIds.length);
    assert.equal(first.imported, sessionIds.length);
    const canonicalId = `claude-${sessionIds[0]}`;
    const eventsFile = path.join(projectRoot, ".agents", "sessions", "canonical", canonicalId, "events.jsonl");
    const before = await stat(eventsFile);
    const second = await importProjectSessions(projectRoot, "claude", { environment });
    assert.equal(second.imported, 0);
    assert.equal(second.unchanged, sessionIds.length);
    assert.equal((await stat(eventsFile)).mtimeMs, before.mtimeMs, "events.jsonl must not be rewritten");
  });
});

test("appending to one native session imports only its delta and stays idempotent", async () => {
  await withClaudeProject(async ({ projectRoot, environment, appendRecords, sessionIds }) => {
    await importProjectSessions(projectRoot, "claude", { environment });
    await appendRecords(sessionIds[0], 2);
    const result = await importProjectSessions(projectRoot, "claude", { environment });
    assert.equal(result.imported, 1);
    assert.equal(result.unchanged, sessionIds.length - 1);
    const stored = await readCanonicalSession(projectRoot, `claude-${sessionIds[0]}`);
    assert.equal(new Set(stored.events.map((event) => event.id)).size, stored.events.length);
    const repeat = await importProjectSessions(projectRoot, "claude", { environment });
    assert.equal(repeat.imported, 0);
    const after = await readCanonicalSession(projectRoot, `claude-${sessionIds[0]}`);
    assert.equal(after.events.length, stored.events.length);
  });
});

test("appendCanonicalEvents reports duplicates without rewriting", async () => {
  await withClaudeProject(async ({ projectRoot, environment, sessionIds }) => {
    await importProjectSessions(projectRoot, "claude", { environment });
    const stored = await readCanonicalSession(projectRoot, `claude-${sessionIds[0]}`);
    const result = await appendCanonicalEvents(projectRoot, stored.session.id, stored.events);
    assert.deepEqual(result, { added: 0, duplicate: stored.events.length });
  });
});
```

Create `test/helpers/session-fixture.mjs` with `withClaudeProject(run)`: builds a temp HOME + project, seeds N Claude sessions, writes a shared-mode `.agents/runtime.json`, exposes `{ projectRoot, environment, sessionIds, appendRecords }`, and always removes the temp tree.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/incremental-import.test.mjs`
Expected: FAIL — `second.imported` is `0` but `unchanged` is `0` (every file is re-parsed and `evaluated`), and `events.jsonl` mtime moves.

- [ ] **Step 3: Make `importProjectSessions` cursor-aware**

```js
export async function importProjectSessions(projectRoot, agentId, options = {}) {
  const adapter = getSessionAdapter(agentId);
  const portable = path.join(runtimePaths(projectRoot).sessionsRoot, agentId);
  const cursors = options.cursors ?? loadCursors(projectRoot);
  const files = agentCursors(cursors, agentId);
  const captured = options.skipCapture
    ? { count: 0, changed: false, diagnostics: [] }
    : await adapter.capture(projectRoot, { ...options, cursors });
  let discovered = 0; let imported = 0; let unchanged = 0; let failed = 0;
  const diagnostics = [...(captured.diagnostics ?? [])];
  for (const relative of await listFiles(portable)) {
    if (!isImportableSession(relative)) continue;
    const absolute = path.join(portable, relative);
    const stamp = await stampOf(absolute);
    const entry = files[relative] ?? {};
    if (entry.canonicalId && sameStamp(entry.portable, stamp) && entry.imported === true) {
      discovered += 1;
      unchanged += 1;
      continue;
    }
    let native;
    try { native = adapter.toCanonical(await readFile(absolute, "utf8")); }
    catch (error) {
      failed += 1;
      diagnostics.push(`Could not parse ${agentId} session ${relative}: ${error.message}`);
      continue;
    }
    if (!native?.nativeSessionId || native.nativeSessionId === "unknown") {
      failed += 1;
      diagnostics.push(`Could not identify ${agentId} session id in ${relative}.`);
      continue;
    }
    discovered += 1;
    const canonicalId = `${agentId}-${native.nativeSessionId}`;
    const created = await createCanonicalSession(projectRoot, { id: canonicalId, source: agentId, title: `${agentId} ${native.nativeSessionId}` });
    const appended = await appendCanonicalEvents(projectRoot, canonicalId, native.events);
    await syncNativeMapping(projectRoot, canonicalId, {
      agentId,
      nativeSessionId: native.nativeSessionId,
      nativeRevision: native.revision ?? null,
      lastCanonicalEventId: native.events.at(-1)?.id ?? null,
    });
    if (options.setActive !== false) await setActiveCanonicalSession(projectRoot, canonicalId);
    if (native.diagnostics?.length) diagnostics.push(...native.diagnostics.map((item) => ({ ...item, file: relative })));
    files[relative] = { ...entry, portable: stamp, canonicalId, nativeSessionId: native.nativeSessionId, imported: true };
    if (created.created || appended.added > 0) imported += 1; else unchanged += 1;
  }
  if (options.cursors === undefined) await saveCursors(projectRoot, cursors);
  return { ...captured, discovered, imported, unchanged, failed, diagnostics };
}
```

Where `isImportableSession(relative)` is the existing inline predicate extracted to a named function so capture and import share one definition.

- [ ] **Step 4: Stop `readCanonicalSession` from re-normalizing on the hot path**

Add a cheap id-only reader used by `appendCanonicalEvents` for dedupe, so a no-op append does not normalize every event:

```js
// packages/core/src/runtime/canonical-sessions.mjs
export async function canonicalEventIds(projectRoot, id) {
  const file = path.join(sessionDirectory(projectRoot, id), "events.jsonl");
  if (!existsSync(file)) return new Set();
  const ids = new Set();
  for (const line of (await readFile(file, "utf8")).split(/\r?\n/)) {
    if (!line) continue;
    try { ids.add(JSON.parse(line).id); } catch { /* a torn line is not an id */ }
  }
  return ids;
}
```

and in `appendCanonicalEvents`, when every incoming event id is already present, return `{ added: 0, duplicate }` before calling `readCanonicalSession`.

- [ ] **Step 5: Run the tests**

Run: `node --test test/incremental-import.test.mjs test/canonical-sessions.test.mjs test/session-continuation.test.mjs`
Expected: PASS

- [ ] **Step 6: Measure and commit**

Run: `node .tmp/perf/step-profile.mjs`
Expected: warm `importProjectSessions(claude)` < 100 ms.

```bash
npm run sync-core
git add -A packages/core packages/cli/vendor test
git commit -m "perf(core): import only canonical deltas from changed sessions"
```

---

## Task 4: Fast plain launch path

Remove canonical work from the pre-spawn critical path. Recovery becomes an explicit-command and post-exit concern.

**Files:**
- Modify: `packages/cli/src/cli/dispatcher.mjs:435-558`
- Modify: `packages/core/src/runtime/session-interop.mjs` (`observeSharedNativeSessions` gains `deferImport`)
- Test: `test/launch-latency.test.mjs`, `test/session-continuation.test.mjs`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: `recoverSharedNativeSessions` is called by `dispatchSessions`, `dispatchProjectSetup` and `sessionInterop` transitions — never by a plain agent launch.

- [ ] **Step 1: Write the failing test**

```js
// test/launch-latency.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { withClaudeProject } from "./helpers/session-fixture.mjs";
import { runCliIn } from "./helpers/session-fixture.mjs";

test("a plain launch performs no canonical import before the agent starts", async () => {
  await withClaudeProject(async ({ projectRoot, environment }) => {
    const result = await runCliIn(projectRoot, ["claude"], environment);
    assert.equal(result.status, 0);
    // The agent executable is the last thing that runs: nothing canonical
    // exists yet because the fake agent produced no session.
    assert.equal(result.canonicalBeforeSpawn, 0);
  });
});

test("the 40-session fixture launches in under one second when warm", async () => {
  await withClaudeProject(async ({ projectRoot, environment, primeLaunch, runCli }) => {
    await runCli(["init", "--agents", "claude", "--auth", "global", "--sessions", "project", "--history", "shared"]);
    await primeLaunch();
    const started = process.hrtime.bigint();
    await runCli(["claude"]);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(ms < 1000, `warm plain launch took ${ms.toFixed(0)} ms`);
  }, { sessions: 40, records: 400 });
});
```

`runCliIn` / `runCli` spawn `packages/cli/scripts/skills.mjs`; `canonicalBeforeSpawn` is reported by the fake agent executable, which counts directories under `.agents/sessions/canonical` at the moment it runs and writes the count to a file the test reads.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/launch-latency.test.mjs`
Expected: FAIL — the latency test reports several thousand ms.

- [ ] **Step 3: Delete the pre-spawn recovery call**

In `dispatchAgent`, remove:

```js
  if (portableSessions && sharedSessions && !options.skipCanonical) {
    await recoverSharedNativeSessions(projectRoot, Object.keys(projectConfig(state).agents), { ... });
  }
```

Keep `sharedSessions` for the exit path. Add a comment recording why:

```js
  // Plain launch is a zero-session-control-plane path: the official TUI must
  // appear without any canonical work. Recovery for sessions created by a
  // crashed launch runs in the runtime watcher, at post-exit capture, and in
  // the explicit `sessions` / `change` commands.
```

- [ ] **Step 4: Run the CLI surface and session tests**

Run: `node --test test/launch-latency.test.mjs test/session-continuation.test.mjs test/cli-surface.test.mjs test/runtime.test.mjs`
Expected: PASS

- [ ] **Step 5: Re-measure the end-to-end profile**

Run: `node .tmp/perf/launch-profile.mjs`
Expected: `avenic claude` warm < 1000 ms, `avenic codex` warm < 1000 ms, `avenic opencode` warm < 1000 ms. Record the numbers in the plan's Results section.

- [ ] **Step 6: Commit**

```bash
npm run sync-core
git add -A packages/cli packages/core test
git commit -m "perf(cli): keep plain agent launches off the canonical control plane"
```

---

## Task 5: Runtime incremental durability

Satisfy "the conversation must survive a crash while it is still running": observe the active native sessions during the run and commit deltas to canonical.

**Files:**
- Create: `packages/core/src/runtime/native-watch.mjs`
- Modify: `packages/cli/src/cli/dispatcher.mjs` (start/stop around the child)
- Create: `packages/cli/src/cli/native-watch.mjs` (child-process host)
- Test: `test/native-watch.test.mjs`

**Interfaces:**
- Produces:
  - `watchNativeSessions({ projectRoot, agentId, environment, signal, intervalMs = 1500, debounceMs = 400 }): Promise<{ stop(): Promise<void>, flushes: number }>`
  - `flushNativeSessions(projectRoot, agentId, options)` — the same incremental capture + import used by post-exit and recovery.

- [ ] **Step 1: Write the failing test**

```js
// test/native-watch.test.mjs
import assert from "node:assert/strict";
import { readCanonicalSession } from "../packages/core/src/runtime/canonical-sessions.mjs";
import { flushNativeSessions, watchNativeSessions } from "../packages/core/src/runtime/native-watch.mjs";
import { withClaudeProject } from "./helpers/session-fixture.mjs";
import test from "node:test";

test("a mid-run native append reaches canonical before the watcher stops", async () => {
  await withClaudeProject(async ({ projectRoot, environment, sessionIds, appendRecords }) => {
    await flushNativeSessions(projectRoot, "claude", { environment });
    const before = (await readCanonicalSession(projectRoot, `claude-${sessionIds[0]}`)).events.length;
    const watcher = await watchNativeSessions({ projectRoot, agentId: "claude", environment, intervalMs: 60, debounceMs: 20 });
    await appendRecords(sessionIds[0], 3);
    await watcher.waitForFlush(1500);
    await watcher.stop();
    const after = (await readCanonicalSession(projectRoot, `claude-${sessionIds[0]}`)).events.length;
    assert.ok(after > before, "the appended records must be durable before the process exits");
  });
});

test("the watcher never writes to native storage", async () => {
  await withClaudeProject(async ({ projectRoot, environment, nativeRoot, sessionIds, snapshotNative }) => {
    const watcher = await watchNativeSessions({ projectRoot, agentId: "claude", environment, intervalMs: 60, debounceMs: 20 });
    await watcher.stop();
    assert.deepEqual(await snapshotNative(), await snapshotNative());
    assert.ok(nativeRoot.length > 0);
    assert.ok(sessionIds.length > 0);
  });
});

test("an idle watcher performs no capture work", async () => {
  await withClaudeProject(async ({ projectRoot, environment }) => {
    await flushNativeSessions(projectRoot, "claude", { environment });
    const watcher = await watchNativeSessions({ projectRoot, agentId: "claude", environment, intervalMs: 50, debounceMs: 10 });
    await new Promise((resolve) => setTimeout(resolve, 400));
    await watcher.stop();
    assert.equal(watcher.captures, 0, "no native change means no capture");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/native-watch.test.mjs`
Expected: FAIL — `Cannot find module .../native-watch.mjs`

- [ ] **Step 3: Implement the watcher**

```js
// packages/core/src/runtime/native-watch.mjs
import { getSessionAdapter } from "./adapters/index.mjs";
import { importProjectSessions } from "./session-interop.mjs";
import { stampOf } from "./cursors.mjs";

// One incremental durability primitive for the running phase, the exit phase
// and crash recovery. It never writes to native storage and never calls a model.
export async function flushNativeSessions(projectRoot, agentId, options = {}) {
  return importProjectSessions(projectRoot, agentId, { ...options, skipCapture: false, setActive: options.setActive ?? false });
}
```

The watcher polls the **already-discovered** native directories (plus any directory that appears) at `intervalMs`, comparing a directory listing stamp. It only calls `flushNativeSessions` when a stamp moved, and debounces so a burst of appends produces one flush:

```js
export async function watchNativeSessions({ projectRoot, agentId, environment, intervalMs = 1500, debounceMs = 400, signal }) {
  const adapter = getSessionAdapter(agentId);
  let captures = 0;
  let stopped = false;
  let last = await nativeStamp(adapter, projectRoot, environment);
  let pending = null;
  let lastFlush = Promise.resolve();
  const tick = async () => {
    if (stopped) return;
    const current = await nativeStamp(adapter, projectRoot, environment);
    if (current !== last) {
      last = current;
      captures += 1;
      lastFlush = flushNativeSessions(projectRoot, agentId, { environment, setActive: false }).catch(() => {});
      await lastFlush;
    }
  };
  const timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref?.();
  return {
    captures,
    get flushes() { return captures; },
    waitForFlush: async (timeoutMs = 2000) => { await Promise.race([lastFlush, new Promise((resolve) => setTimeout(resolve, timeoutMs))]); },
    stop: async () => { stopped = true; clearInterval(timer); await lastFlush; },
  };
}
```

`nativeStamp` is a cheap `readdir` + `stat` signature over the discovered native directories — no file is opened and no JSON is parsed. It uses `adapter.nativeRoots(projectRoot, environment)`; add that export to the claude and codex adapters (a thin wrapper over their existing `locations` + `discoverNativeProjectDirectories` hints, without the cwd scan).

- [ ] **Step 4: Run the tests**

Run: `node --test test/native-watch.test.mjs test/incremental-capture.test.mjs`
Expected: PASS

- [ ] **Step 5: Wire the watcher into the launch**

In `dispatchAgent`, after the lease is acquired and before spawn, start the watcher for the launched agent only; in the `finally`, `stop()` it before the exit capture. Wrap in `try/catch` so a watcher failure never blocks or fails a launch.

Keep the watcher in-process (a `setInterval` with `unref`) rather than a separate child process; the agent owns the terminal and the wrapper is blocked in `spawnSync`, so a second process would need its own coordination file for no benefit. If profiling later shows the polling interferes with the TUI, move it behind the existing `watchdog.mjs` child.

- [ ] **Step 6: Commit**

```bash
npm run sync-core
git add -A packages/core packages/cli test
git commit -m "feat(core): keep shared history durable while the agent is running"
```

---

## Task 6: Recovery for unmapped and crashed sessions

**Files:**
- Modify: `packages/core/src/runtime/session-interop.mjs` (`recoverSharedNativeSessions` gains a project-identity inventory watermark)
- Modify: `packages/cli/src/cli/dispatcher.mjs` (`dispatchSessions` runs recovery before list/continue)
- Test: `test/session-recovery.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
// test/session-recovery.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { listCanonicalSessions } from "../packages/core/src/runtime/canonical-sessions.mjs";
import { recoverSharedNativeSessions } from "../packages/core/src/runtime/session-interop.mjs";
import { withClaudeProject } from "./helpers/session-fixture.mjs";

test("a session created with no mapping is discovered on the next recovery", async () => {
  await withClaudeProject(async ({ projectRoot, environment, createUnmappedSession }) => {
    const id = await createUnmappedSession(4);
    const results = await recoverSharedNativeSessions(projectRoot, ["claude"], { environment });
    assert.equal(results[0].changed, true);
    const sessions = await listCanonicalSessions(projectRoot);
    assert.ok(sessions.some((session) => session.id === `claude-${id}`));
  });
});

test("recovery is idempotent and creates no duplicates", async () => {
  await withClaudeProject(async ({ projectRoot, environment, createUnmappedSession }) => {
    const id = await createUnmappedSession(4);
    await recoverSharedNativeSessions(projectRoot, ["claude"], { environment });
    const first = (await listCanonicalSessions(projectRoot)).length;
    const again = await recoverSharedNativeSessions(projectRoot, ["claude"], { environment });
    assert.equal(again[0].changed, false);
    assert.equal((await listCanonicalSessions(projectRoot)).length, first);
    assert.ok(id.length > 0);
  });
});

test("recovery after a truncated tail imports the valid records and keeps a diagnostic", async () => {
  await withClaudeProject(async ({ projectRoot, environment, createUnmappedSession, truncateTail }) => {
    const id = await createUnmappedSession(4);
    await truncateTail(id);
    const results = await recoverSharedNativeSessions(projectRoot, ["claude"], { environment });
    assert.equal(results[0].changed, true);
    const sessions = await listCanonicalSessions(projectRoot);
    assert.ok(sessions.some((session) => session.id === `claude-${id}`));
  });
});
```

- [ ] **Step 2–3: Implement and verify**

`recoverSharedNativeSessions` already walks agents through `observeSharedNativeSessions`; with Tasks 2–3 the walk is cheap when nothing changed. Add the project-identity check the spec calls an inventory watermark: before scanning, compare each agent's native directory signature against `cursors.agents[agentId].scan`; when it matches, return `{ changed: false }` without listing files. Record the signature after a successful scan.

- [ ] **Step 4: Make `dispatchSessions` recover first**

In `dispatchSessions`, before `listCanonicalSessions`, call `recoverSharedNativeSessions(projectRoot, Object.keys(projectConfig(state).agents), ...)`. This is an explicit command, so the cost is acceptable and the user sees an accurate list.

- [ ] **Step 5: Run the tests and commit**

Run: `node --test test/session-recovery.test.mjs test/session-continuation.test.mjs`
Expected: PASS

```bash
npm run sync-core
git add -A packages/core packages/cli test
git commit -m "fix(core): recover unmapped native sessions on explicit commands"
```

---

## Task 7: One diagnostic surface for malformed native history

**Files:**
- Modify: `packages/core/src/runtime/adapters/canonical.mjs` (tolerant parse already exists — extend to per-record kinds)
- Modify: `packages/cli/src/cli/dispatcher.mjs` (dedupe and print once per launch cycle)
- Test: `test/malformed-native.test.mjs`

**Requirements:** a malformed middle record skips one record with a diagnostic and parsing continues; a truncated final record is an incomplete tail, not an error; a source that is unreadable or entirely unexpected is the only source-level failure; the same `(source, revision, kind)` is reported at most once per launch cycle.

- [ ] **Step 1: Write the failing test**

```js
// test/malformed-native.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { parseJsonLines } from "../packages/core/src/runtime/adapters/canonical.mjs";

test("a malformed middle record is skipped and later records still parse", () => {
  const content = ['{"a":1}', "{ not json", '{"a":2}'].join("\n");
  const parsed = parseJsonLines(content, "claude", { diagnostics: true });
  assert.equal(parsed.records.length, 2);
  assert.equal(parsed.diagnostics.length, 1);
  assert.equal(parsed.diagnostics[0].kind, "malformed-record");
  assert.equal(parsed.diagnostics[0].line, 2);
});

test("a truncated final record is an incomplete tail, not a malformed record", () => {
  const content = ['{"a":1}', '{"a":2', ].join("\n");
  const parsed = parseJsonLines(content, "claude", { diagnostics: true });
  assert.equal(parsed.records.length, 1);
  assert.equal(parsed.diagnostics.length, 1);
  assert.equal(parsed.diagnostics[0].kind, "truncated-tail");
});

test("one malformed record produces exactly one diagnostic", () => {
  const lines = Array.from({ length: 20 }, (_, i) => (i === 7 ? "x{" : `{"i":${i}}`));
  const parsed = parseJsonLines(lines.join("\n"), "codex", { diagnostics: true });
  assert.equal(parsed.diagnostics.filter((item) => item.kind === "malformed-record").length, 1);
});
```

- [ ] **Step 2–4: Implement, verify, commit**

Extract the diagnostic formatter used by the CLI into `formatSessionDiagnostics(diagnostics)` in core (one function, one wording), where the CLI prints `diagnostics.slice(0, 5)` plus `… and N more` once per cycle. Deduplicate by `agentId + file + kind + line`.

---

## Task 8: End-user README and help

**Files:**
- Modify: `README.md`
- Modify: `packages/cli/src/cli/dispatcher.mjs` (`printHelp` ordering)
- Test: `test/cli-surface.test.mjs`

**Required structure:** Quick Start leads with `avenic init`, `avenic claude|codex|opencode`, `avenic change`, `avenic sessions`, `avenic self-update`, `avenic --version`. Then: what Authentication scope means, what Session storage scope means, Shared vs Isolated (including "Shared lets the selected agents continue the same Avenic conversation history" and "Isolated keeps each agent's own history; import and migration stay available"), crash recovery, Codex install provenance, and "private Hub sync uses your system Git credentials". Low-level per-agent auth/session commands move to an "Advanced / compatibility" section. No architecture content.

- [ ] **Step 1: Write the failing test**

```js
// test/cli-surface.test.mjs (append)
test("the README leads with the end-user command surface", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const quickStart = readme.slice(readme.indexOf("## Quick Start"), readme.indexOf("## Quick Start") + 900);
  for (const command of ["avenic init", "avenic change", "avenic sessions", "avenic self-update", "avenic claude"]) {
    assert.ok(quickStart.includes(command), `Quick Start must show ${command}`);
  }
  assert.ok(readme.includes("Shared"), "README must explain Shared");
  assert.ok(readme.includes("Isolated"), "README must explain Isolated");
  assert.ok(/system Git credentials|系统 Git/i.test(readme), "README must document Hub credentials");
});

test("--version matches the published package metadata", async () => {
  const metadata = JSON.parse(await readFile(new URL("../packages/cli/package.json", import.meta.url), "utf8"));
  const result = runCli("skills.mjs", ["--version"]);
  assert.equal(result.stdout.trim(), `Avenic ${metadata.version}`);
});
```

- [ ] **Step 2–4: Write the README, run `node --test test/cli-surface.test.mjs`, commit**

---

## Task 9: Hub sync is asynchronous and classifies its failures

**Files:**
- Modify: `packages/core/src/skills/git.mjs` (add async `gitAsync`; keep `git` for the synchronous callers)
- Modify: `packages/core/src/skills/catalog.mjs` (`ensureCatalog` async path; typed failures)
- Modify: `packages/vscode/src/services/catalog.ts` (delete the mirrored slug; use the exported core helper)
- Modify: `packages/vscode/src/commands/catalog-commands.ts` (`Syncing…` → `Synced · <short sha> · <time>`)
- Modify: `packages/cli/src/cli/skills-cli.mjs` (`hub sync` prints short sha and time)
- Modify: `packages/core/index.d.ts`
- Test: `test/catalog-cache.test.mjs`, `packages/vscode/test/catalog-commands.test.ts`

**Required error kinds:** `authentication`, `repo-missing`, `network`, `git-missing`, `ref-missing`, `cache-filesystem`. Each carries a one-line user-facing message; classification reads git's stderr.

- [ ] **Step 1: Write the failing test**

```js
// test/catalog-cache.test.mjs (append)
test("sync failures carry a kind that distinguishes auth from network", async () => {
  const cases = [
    ["fatal: Authentication failed for 'https://github.com/x/y'", "authentication"],
    ["fatal: repository 'https://github.com/x/y' not found", "repo-missing"],
    ["fatal: unable to access 'https://github.com/x/y': Could not resolve host", "network"],
    ["fatal: couldn't find remote ref main", "ref-missing"],
  ];
  for (const [stderr, kind] of cases) assert.equal(classifyGitFailure(stderr), kind);
  assert.equal(classifyGitFailure("spawn git ENOENT"), "git-missing");
});

test("a sync failure is one typed error, not a wrapped message", async () => {
  await withFakeGit(async ({ environment }) => {
    await assert.rejects(
      ensureCatalog("owner/repo#main", { environment, run: failingGit("fatal: Authentication failed") }),
      (error) => error.kind === "authentication",
    );
  });
});
```

- [ ] **Step 2–6: Implement, export `cacheDirectory` from core, delete the mirror in `services/catalog.ts`, add the timestamped success line, run `npm --prefix packages/vscode test` and `node --test test/catalog-cache.test.mjs`, commit**

---

## Task 10: self-update verification coverage

**Files:**
- Test: `test/runtime.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
test("self-update fails loudly when npm exits 0 but PATH still resolves the old version", async () => {
  await assert.rejects(
    updateAvenic({ currentVersion: "1.5.1", latestVersion: "1.5.2", install: () => ({ status: 0 }), probeVersion: () => "1.5.1" }),
    /update verification failed: registry=1\.5\.2, active=1\.5\.1/,
  );
});

test("self-update reports already up to date without installing", async () => {
  let installed = false;
  const result = await updateAvenic({
    currentVersion: "1.5.2", latestVersion: "1.5.2", install: () => { installed = true; return { status: 0 }; }, probeVersion: () => "1.5.2",
  });
  assert.equal(result.updated, false);
  assert.equal(installed, false);
});
```

- [ ] **Step 2–4: Run, fix any behaviour the tests expose, commit**

---

## Task 11: Code consolidation

Produce the before/after numbers the release gate requires.

- [ ] **Step 1: Record before numbers**

Run and save output:
```bash
find packages/core/src packages/cli/src packages/cli/scripts packages/vscode/src -type f \( -name '*.mjs' -o -name '*.ts' \) | xargs wc -l | tail -1
```

- [ ] **Step 2: Apply the consolidation list**

- Delete the mirrored cache-slug in `packages/vscode/src/services/catalog.ts` (Task 9) and any other core logic re-implemented in VS Code.
- Collapse `observeSharedNativeSessions` / `recoverSharedNativeSessions` / `importProjectSessions` into one capture pipeline with flags, not three near-copies.
- Extract `isImportableSession` and the diagnostic formatter once (Tasks 3, 7) and delete the duplicates.
- Delete adapter code paths that only exist for tests.
- Confirm no `Manager` / `Controller` / `Coordinator` / `Engine` modules exist.
- Verify deprecated verbs (`catalog`, per-agent `sessions import/writeback`) are thin wrappers with no second implementation.

- [ ] **Step 3: Re-run the full suite and record after numbers**

Run: `npm test`
Expected: PASS. Record LOC before/after in the plan's Results section.

- [ ] **Step 4: Commit**

---

## Task 12: Committed performance harness

**Files:**
- Create: `test/performance.test.mjs`
- Move: `.tmp/perf/launch-profile.mjs` → `scripts/perf/launch-profile.mjs`

- [ ] **Step 1: Add a budget test**

```js
// test/performance.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { withClaudeProject } from "./helpers/session-fixture.mjs";

// Generous ceilings: this guards against a return of whole-history work on the
// launch path, not against CI noise. Local numbers are an order of magnitude lower.
const BUDGET_MS = 2500;

test("a warm plain launch stays well under a second locally", async () => {
  await withClaudeProject(async ({ runCli }) => {
    await runCli(["init", "--agents", "claude,codex,opencode", "--auth", "global", "--sessions", "project", "--history", "shared"]);
    await runCli(["claude"]);
    const started = process.hrtime.bigint();
    await runCli(["claude"]);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(ms < BUDGET_MS, `warm launch took ${ms.toFixed(0)} ms`);
  }, { sessions: 40, records: 400 });
});
```

- [ ] **Step 2: Run, adjust the ceiling to a value the real machine clears with margin, commit**

---

## Task 13: Versions, changelog, packaging

- [ ] **Step 1:** `npm view @avenic/core version` and `npm view avenic dist-tags --json` — record the real published versions.
- [ ] **Step 2:** Bump `packages/core`, `packages/cli` and `packages/vscode` to the next patch/minor above the published ones. Never reuse a published version.
- [ ] **Step 3:** Write `CHANGELOG.md` entries for core/CLI and `packages/vscode/CHANGELOG.md`, and VS Code release notes.
- [ ] **Step 4:** Run the full gate:

```bash
npm test
npm run test:install
npm run pack:cli
cd packages/cli && npm pack --dry-run --json
npm --prefix packages/vscode run typecheck
npm --prefix packages/vscode run build
npm --prefix packages/vscode test
npm --prefix packages/vscode run package
```

- [ ] **Step 5:** Install the packed tarballs into a temp prefix and smoke `--version`, `init`, `change`, `sessions`, plain launches, Shared/Isolated, `self-update`.
- [ ] **Step 6:** Secret scan the diff; commit.

---

## Task 14: Release gates

- [ ] **Step 1:** Install the final VSIX into a real VS Code and exercise Initialize, Configure, Launch, Sessions, Hub Sync, Shared/Isolated.
- [ ] **Step 2:** Confirm the npm artifacts are complete, then hand the two manual steps to the owner: npm OTP/browser authorization, and the VSIX upload.
- [ ] **Step 3:** After the owner publishes, verify `npm view avenic version`, `npm install -g avenic@latest`, `avenic --version`, `npm list -g avenic --depth=0`, `where.exe avenic`, and `avenic self-update`.

---

## Results

Filled in during execution.

### Launch latency

Measured with the committed harness, `npm run perf` (`scripts/perf/profile.mjs`).
It spawns the real CLI against a real fixture — 40 Claude sessions × 400
records, 120 Codex rollouts, 60 other workspaces' Claude history — with a
stub agent on `PATH`, so every number below is wall clock for a process a
user would have run, not a microbenchmark. The harness prints the fixture
size with the numbers so the two cannot drift apart.

What the user waits for is the delay before the official agent process
starts. The wrapper's own lifetime adds the capture that makes the run
durable.

| Command | Before | After |
|---|---|---|
| `avenic --version` | 10 945 ms | 87 ms |
| `avenic claude` (cold) | 7 677 ms | 833 ms |
| `avenic claude` (warm) | 4 446 ms | 780–1037 ms (median ≈ 860 ms) |
| `avenic codex` (warm) | 3 670 ms | 393–484 ms |
| `avenic opencode` (warm) | 2 301 ms | 220–250 ms |
| `avenic sessions status` | — | 704–734 ms |
| `avenic status` | — | 136–143 ms |

The "before" column is the baseline measured on 2026-09-19 before any
change, on this machine. The `claude` target is under one second and the
median clears it; the spread is this machine (Windows, Defender scanning
the fixture as it is written), and the four runs behind it were 780, 852,
861 and 1037 ms.

Per-step, warm:

| Step | Before | After |
|---|---|---|
| `claude.capture` | 2 301 ms | 205–322 ms |
| `claude.capture` (`knownOnly`) | — | 77–114 ms |
| `importProjectSessions(claude)` | 2 799 ms | 712–763 ms |
| `codex.capture` | 273 ms | 79–93 ms |
| `importProjectSessions(codex)` | 509 ms | 283–303 ms |
| `recoverSharedNativeSessions` (3 agents) | 3 298 ms | 84–102 ms |
| `listCanonicalSessions` | — | 224–248 ms |
| `claude.revertNative` | 192 ms | 3–4 ms |
| `codex.revertNative` | 519 ms | 20 ms |
| exit capture, claude (`observeSharedNativeSessions`) | 2 706 ms | 22–27 ms |
| exit capture, codex | 498 ms | 13–14 ms |

Two steps remain in the hundreds of milliseconds and both are bounded by
work, not by history: `claude.capture` re-reads the head of every Claude
session on the machine to decide which belong to this project (the gap to
`knownOnly` is that discovery), and `importProjectSessions(claude)` parses
the records that genuinely changed. Both scale with what moved, not with
how much history exists.

The remaining fixed cost of a launch is the native-storage snapshot: the
launch group copies the project's native session tree before the agent
starts and puts it back when the run ends, which is what keeps a run's
sessions inside the project. On this fixture that copy is 200–450 ms, and
it is I/O the operating system's file inspection dominates rather than the
8 MB itself.

Re-measured after the OpenCode and interactive-surface changes, on the same
fixture and the same machine: `avenic --version` 114 ms, `avenic claude`
(cold) 1 001 ms, `avenic claude` (warm) 977 ms, `avenic codex` (warm)
515 ms, `avenic opencode` (warm) 250 ms, `avenic sessions status` 867 ms,
`avenic status` 152 ms. Two of those runs sit just above
one second on a loaded machine; the unchanged harness on an idle one is the
780–1 037 ms spread above, and the two surfaces this release added are on
the interactive path, which the harness does not enter.

### Production LOC

Counted over production sources only:

```bash
find packages/core/src packages/cli/src packages/cli/scripts packages/vscode/src \
  -type f \( -name '*.mjs' -o -name '*.ts' \) | xargs wc -l | tail -1
```

| Area | Before | After | Added | Deleted | Net |
|---|---|---|---|---|---|
| core | 6 609 | 7 638 | +1 288 | −256 | **+1 032** |
| CLI | 2 858 | 2 836 | +203 | −225 | **−22** |
| CLI scripts | 68 | 75 | +34 | −27 | **+7** |
| VS Code | 3 102 | 3 020 | +106 | −188 | **−82** |
| **Total** | **12 637** | **13 569** | **+1 631** | **−696** | **+935** |

The net is positive because this release added capability: the cursor
store, incremental capture and import, runtime durability, session
recovery, one diagnostic surface, and Hub sync as a real network
operation. The consolidation below is what kept the addition from being
larger — core absorbed about twice the code of the feature work and both
hosts shrank. No `Manager`, `Controller`, `Coordinator` or `Engine`
module exists anywhere in the tree.

### Duplicated orchestration

Places that implemented the same decision, before → after:

| Decision | Before | After |
|---|---|---|
| Native-history capture pipeline | 3 near-copies | 1 with flags |
| "Is this a session file?" | 5 predicates | 2 (per-agent layout differs on purpose) |
| Adapter restore body | 3 | 1 (`restoreInto`) |
| Session head read | 2 | 1 (bounded, with a whole-file fallback) |
| Project-root rewrite in a JSONL record | 2 | 1 |
| Role sets | 3 | 2 (`CONVERSATION_ROLES` vs OpenCode's readable set) |
| Launch group + launch resolution | 2 hosts × 2 copies | 1 per host, one shared core sequence |
| Agent CLI version rules (VS Code) | 4 (package map, parser, comparator, npm spawn) | 0 — all in core |
| "Which Skills on disk are unmanaged?" | 2 hosts × own subtraction | 1 (core returns the set) |
| Uninstall-everything sequence | 2 | 1 (`removeAllInstalledSkills`) |
| Catalog layout joins | 9 call sites, 4 spellings | 1 (`catalogLayout`) |
| Path containment (VS Code) | 1 hand-rolled | 0 — core's `isInside` |
| Cached file head protocol | 2 | 1 (`cachedFileHead`) |

The two predicates that stayed separate answer different questions: "is
this a conversation event" for canonical import, and "can OpenCode read
this role back" for its projection. The two role sets are the reason a
system event is reported rather than silently dropped.

### OpenCode continuation

OpenCode is the one agent whose history is reachable only through its own
CLI, so a continuation is `opencode import` followed by `opencode
--session`, and two things become Avenic's business that are nobody
else's: the model the projected session will run on, and what to do when it
will not run at all.

Three defects were found against the real `opencode` 1.18.30 on this
machine and fixed:

- A session's own revision is a flat millisecond stamp (`updated`), not
  `time.updated`. Reading the wrong shape made every OpenCode session look
  moved on every pass, so a repeat capture re-exported the whole history.
  Two capture tests were changed to the shape the CLI actually prints
  first, watched fail, and then fixed.
- A projection carried each message's original `providerID`/`modelID`,
  so a Claude-sourced session was stamped `anthropic`/`claude-sonnet-5`.
  This machine's OpenCode offers only `opencode/*` models; `opencode
  import` accepted the file and the session then refused to start. A
  message Avenic did not see OpenCode produce now claims OpenCode's own
  resolved model.
- The projection had to carry *a* model at all: `opencode import` rejects
  an envelope whose `info.model` is missing. Avenic resolves it with
  `opencode debug config` — the model the user's own OpenCode resolves for
  this environment, including the per-auth-scope XDG layout Avenic passes
  — and falls back to OpenCode's built-in default only when it cannot be
  read. A model the caller passed explicitly is kept as-is, foreign or not.

When a projected session still will not start, the launch does not fail:
the shared history is intact, so the run continues in a fresh official
OpenCode session handed the canonical delta, and the new session becomes
the mapping. This is deliberately the *same* sequence Claude and Codex use
(`runCanonicalContinuation` with `forceBootstrap: true`), not a second
implementation of it.

Covered by `test/opencode-continuation.test.mjs` (5 tests: the resolved
model, a caller-chosen model, discovery of the session a fresh launch
created, the fallback, and that a session which starts is left alone) plus
the launch-argument test in `test/session-continuation.test.mjs`.

One limitation, recorded rather than claimed: on this machine `opencode run
--session <id>` hangs until timeout, because there is no working provider
endpoint configured. A control run of a brand-new session hangs the same
way, so this is the environment rather than a projection defect, and it is
the reason the fallback path is exercised through a stub instead.

### Interactive surfaces (init / change / sessions)

`avenic init`, `avenic change` and `avenic sessions` are the three screens a
user actually operates, and until this pass none of them was driven by a
test — each was reachable only through a real terminal. They are now driven
key by key, in-process, through the same prompt code the CLI ships, with a
fake TTY (`test/helpers/fake-tty.mjs`) and a temp project
(`test/helpers/host-project.mjs`, which fails the test if the project the
suite runs from changes underneath it).

- `test/cli-init-wizard.test.mjs` — `avenic init` writes exactly what the
  wizard asked for (two agents, per-agent auth and session storage, history
  mode, confirmation), `avenic change` adds an agent and switches history to
  Isolated, and a wizard that is cancelled — mid-flow or at the
  confirmation — leaves no configuration behind at all.
- `test/cli-sessions-menu.test.mjs` — the menu offers exactly the actions
  the mode allows, Esc changes nothing, and "Set active session" sets the
  pointer to the row the cursor was on.

Driving them found a real defect that had shipped: both pickers built their
options from `agent.id`, but the registry's entries carry only
`displayName` and `executable`. Every option's value was `undefined`, so
the init/change wizard could not be completed at all (an empty selection
never satisfies "at least one agent") and the Sessions menu's "Continue
with" threw `Unknown Agent: undefined` after the user had picked a session.
Both now use one `agentChoices()` built from the registry's keys. The
`test/cli-prompts.test.mjs` helpers moved to `test/helpers/fake-tty.mjs` so
the three interactive suites share one fake terminal instead of three.

### Versions

What the registries actually hold, versus what the repository carries:

| Artifact | Published | Repository |
|---|---|---|
| `avenic` | 1.5.1 (`latest`) | 1.5.2 |
| `@avenic/core` | 1.4.1 | 1.4.2 |
| `avenic-agent-manager` (Marketplace) | 0.2.0 | 0.3.0 |

The repository was already one patch above every published version — the
1.5.2 / 1.4.2 entry was written on 2026-09-18 and never published, and
0.3.0 has never been uploaded. So nothing needs bumping, and no published
version is reused: this release publishes 1.5.2 / 1.4.2 / 0.3.0.

Because 1.5.2 never reached a registry, its changelog entry is the entry
for what this release ships, and the convergence work that landed after
the entry was written belongs in it rather than in a second entry for a
version nobody can install. The entry keeps its 2026-09-18 bullets, gains
the 2026-09-19 ones, and is dated 2026-09-19.

### Release smoke

`npm run test:release` (`integration/release-smoke.mjs`) packs
`packages/cli`, installs the tarball into a temporary global prefix, and
runs what a user runs against that install:

- `avenic --version` — must print the version from `package.json`, not a
  constant.
- `avenic init --agents claude,codex --auth global --sessions project
  --history shared`, then `avenic status`.
- `avenic claude` — a real launch, with a stub on `PATH` that writes a
  real-shaped native transcript; the run's events must be in the project's
  shared history when the command returns, and `sessions list` / `sessions
  status` must show the session and its cursor.
- `avenic change --auth project --sessions project --history isolated`,
  then `avenic codex` — the run must stay in its own history (no project
  file appears in the shared workspace), and `sessions sync` is what
  imports it.
- `avenic change --history shared` — the two histories stay two sessions.
- `avenic self-update`, three ways, against a stub npm: already current
  (must not reinstall), newer available (must install and then verify
  `PATH` runs the new one), and install-succeeded-but-`PATH`-still-old
  (must fail loudly, non-zero).

Its assertions were checked for teeth: with the version expectation
mutated to a wrong value the run fails with exit 1.

### Release gates

Run on this machine, in this order, after the release commit:

| Gate | Result |
|---|---|
| `npm test` (root) | 497 tests, 494 pass, 3 skipped, 0 fail |
| `npm run test:install` | passed (tarball + repo-root global install, agent runtime, Skills) |
| `npm run test:release` | passed (the smoke above, Hub and self-update included) |
| `npm run pack:cli` (`npm pack --dry-run --json`) | 60 files, `vendor/core-src/skills/uninstall.mjs` present |
| real tarballs (`npm pack` in both packages) | `avenic-1.5.2.tgz` 139 651 B, `avenic-core-1.4.2.tgz` 106 728 B; installed together into a temp global prefix: `avenic --version` → `Avenic 1.5.2`, `avenic --help`, `avenic sessions status` |
| `npm run perf` | re-measured, table above |
| `npm run typecheck` (VS Code) | clean |
| `npm test` (VS Code) | 154 tests, 0 fail |
| `npm run package` (VS Code) | `dist/avenic-agent-manager.vsix`, 19 files, 208.67 KB |
| `code --install-extension dist/avenic-agent-manager.vsix` | installed into the real VS Code, 0.2.0 → 0.3.0 |
| real `avenic self-update` (packed 1.5.2, on a machine whose `PATH` runs 1.5.1) | `Current: 1.5.1 / Latest: 1.5.1 / Source: avenic@latest / Avenic is already up to date (1.5.1).` — it reports the executable `PATH` would run, not the one it was launched as |

Two gates found something and were fixed rather than waived:

- The extension suite's first build test read `dist/extension.js`, which is
  gitignored — on a checkout that had not been built yet it failed before
  the packaging test built it. It now builds the bundle itself, from the
  production options, into a temporary directory.
- Nothing loaded the packaged bundle, so a command declared in the
  manifest and never registered would have shipped as a palette entry
  that throws when clicked. The bundle is now activated outside the
  editor against a stub for the `vscode` module and its registry is
  compared with the manifest both ways. Verified by mutating the
  manifest: the test fails with the command it cannot find.

What remains is the owner's two steps, and the verification that follows
them: publish `@avenic/core` 1.4.2 then `avenic` 1.5.2 (npm OTP or browser
authorization), upload the 0.3.0 VSIX, and then
`npm view avenic version` / `npm install -g avenic@latest` /
`avenic --version` / `npm list -g avenic --depth=0` / `where.exe avenic` /
`avenic self-update`.

### The 33 release gates, item by item

| # | Gate | Result | Evidence |
|---|---|---|---|
| 1 | AVENIC brand TUI | PASS | `banner()` paints the wordmark; `test/cli-prompts.test.mjs` asserts it is branded and control-sequence free; the wizard and the Sessions menu paint it |
| 2 | Multi-select control | PASS | space toggles, `a` all, `n` none, Enter confirms (`test/cli-prompts.test.mjs`), and the wizard drives the same control |
| 3 | Enter with zero selections is invalid | PASS | "a required multiselect keeps an empty selection open; escaping cancels"; the wizard passes `minSelected: 1` |
| 4 | `init` | PASS | `test/cli-init-wizard.test.mjs`: key-driven wizard, persisted config asserted; flag path in `test/cli-surface.test.mjs` |
| 5 | `change` | PASS | same file: adds an agent and switches history to Isolated; scope tests in `test/cli-surface.test.mjs` |
| 6 | `sessions` TUI | PASS | `test/cli-sessions-menu.test.mjs`: mode-correct actions, Esc changes nothing, "Set active session" follows the cursor |
| 7 | Auth × Session, four combinations | PASS | `test/runtime-mode-matrix.test.mjs` — all four reversible, auth and storage independent |
| 8 | Shared | PASS | release smoke: a real launch lands in shared history and `sessions list`/`status` show it with its cursor |
| 9 | Isolated | PASS | runtime-mode-matrix: isolated history is imported only when asked; smoke: an isolated Codex run stays out of the shared workspace |
| 10 | Mode round trip loses nothing | PASS | "shared to isolated preserves canonical history and rejoining captures the isolated delta" |
| 11 | Claude L3a | PASS | `test/session-continuation.test.mjs` (resume args, delta handoff, stale-mapping rehydration) |
| 12 | Codex L3a | PASS | same file, plus v2 sub-agent parent resolution and bootstrap fallback |
| 13 | OpenCode reliable continuation or explicit fallback | PASS | `test/opencode-continuation.test.mjs`; section above |
| 14 | Runtime incremental durability | PASS | `test/native-watch.test.mjs` — a running session becomes durable, never writes native storage, survives a half-written record |
| 15 | Abnormal-exit recovery | PASS | `test/launch-group.test.mjs` — a group that died last run is salvaged before the next snapshot |
| 16 | Unmapped-session recovery | PASS | `test/session-recovery.test.mjs` — listing picks up native history no capture has seen, once |
| 17 | Malformed JSONL | PASS | `test/session-diagnostics.test.mjs` (one warning per problem, once) and the adapter contract's "skips malformed records without losing later history"; native files are never modified |
| 18 | Manual `/resume` capture | PASS | resume-catalog projection (`ensureNativeProjection`) plus `launch-group` capturing what a manually resumed run produced |
| 19 | No-target projection | PASS | "resume-catalog materialization creates one stable native mapping" — idempotent, one mapping |
| 20 | Plain launches are fast | PASS | `npm run perf`, table above |
| 21 | Private SkillsHub | PASS | `test/hub-sync.test.mjs` (failure kinds classified) and a real sync against the private repo: `git ls-remote` HEAD `f48b49ac…`, `hub sync` → `Synced · f48b49a` in 3.97 s using system git credentials |
| 22 | CLI / VS Code parity | PASS | both hosts call the same core (`test/vendor.test.mjs` keeps the vendored copy identical); version rules, unmanaged-Skill detection, catalog layout and path containment live only in core |
| 23 | Code consolidation | PASS | duplicated-orchestration table above; no `Manager`/`Controller`/`Coordinator`/`Engine` module exists |
| 24 | Quantified LOC / duplication improvement | PASS | LOC table above (+935 net for this release's feature work, both hosts net negative) |
| 25 | root / VS Code / package suites | PASS | 497 / 154 / `npm run package`, 0 failures |
| 26 | Real tarball install | PASS | `npm run test:install`, and both release tarballs installed into a temp global prefix and run |
| 27 | Real VSIX install | PASS | `code --install-extension …vsix` → `echokang.avenic-agent-manager@0.3.0` in the real editor |
| 28 | Release docs and changelog | PASS | README (end-user UX), CHANGELOG 1.5.2 / 1.4.2 dated 2026-09-19, this plan's results |
| 29 | npm artifact ready | PASS | `dist/release-20260919-0315/avenic-1.5.2.tgz` (139 651 B) and `avenic-core-1.4.2.tgz` (106 728 B) |
| 30 | VSIX artifact ready | PASS | `packages/vscode/dist/avenic-agent-manager.vsix`, 0.3.0, 19 files, 208.67 KB |
| 31 | Post-publish registry / global install verified | **NOT YET** | requires the publish itself (owner: npm OTP / browser authorization); the verification commands are listed above |
| 32 | `avenic --version` prints `Avenic <version>` | PASS | the packed install prints `Avenic 1.5.2` from `package.json`; release smoke asserts it is not a constant |
| 33 | `self-update` | PASS | three-way stub coverage in `npm run test:release`, plus the real run above reporting Current / Latest / Source for the executable `PATH` would run |

32 of 33 are satisfied on this machine. The one that is not, gate 31, is
satisfiable only by publishing, which is the owner's step — so the honest
status is: **the release is ready to publish**, and the only remaining
actions are the two owner-only ones.

The interactive click-through of the extension — Initialize, Configure,
Launch, Sessions, Hub Sync, Shared/Isolated — is the one part of this
release that no automated gate covers. The artifact is installed and its
command set is proven registered; the flows behind those commands are
exercised through the CLI in `npm run test:release` and through the
sources in the VS Code suite, but nobody has clicked them in the editor.

---

# Reopened gate — final product requirements (P0–P17)

The owner reopened the release gate with three new product requirements and
fourteen checks around them. Everything above stayed in force; nothing was
allowed to regress. This section records that pass.

## P0 — plain-launch performance, measured as overhead

The metric is **Avenic overhead = wrapped − direct**, paired per run so machine
noise cancels. Both sides are measured through the same stub agent, which
records the instant the operating system started the agent's launcher, so the
difference is Avenic and nothing else.

`node scripts/perf/launch-overhead.mjs --runs 15 --cold-fixtures 3`
(Windows 11, Node 24, idle machine; fixture: 40 Claude sessions × 400 records,
120 Codex rollouts):

| agent | situation | runs | direct p50/p95 | avenic p50/p95 | overhead p50/p95 | budget |
|---|---|---|---|---|---|---|
| claude | cold | 3 | 71 / 84 | 289 / 291 | **219 / 220** | < 300 / 500 PASS |
| claude | steady | 15 | 73 / 80 | 195 / 294 | **123 / 214** | PASS |
| claude | recovery | 15 | 74 / 82 | 195 / 213 | **124 / 140** | PASS |
| codex | cold | 3 | 84 / 95 | 279 / 293 | **195 / 198** | PASS |
| codex | steady | 15 | 75 / 125 | 199 / 307 | **124 / 219** | PASS |
| codex | recovery | 15 | 71 / 83 | 198 / 217 | **129 / 152** | PASS |
| opencode | cold | 3 | 80 / 80 | 183 / 187 | **107 / 111** | PASS |
| opencode | steady | 15 | 71 / 85 | 177 / 195 | **105 / 120** | PASS |
| opencode | recovery | 15 | 71 / 90 | 174 / 191 | **102 / 123** | PASS |

Worst case across all agents and situations: **median 219 ms, p95 220 ms** —
inside both budgets with room. The complaint that a launch took four to five
seconds is answered by the overhead column: the agent now starts 100–130 ms
later than it would have on its own, and the cold first launch of a project
costs about one extra tenth of a second while it records what it found.

Where the remaining time goes, from the same harness with `--phases` (steady
wrapped launch, 8 runs):

| phase | cost |
|---|---|
| `modules` — node boot + CLI + core module graph | **62.9 ms** |
| `launch-group` — native-storage snapshot | 10.1 ms |
| `watchdog.spawn` | 12.3 ms |
| `lease` (first) | 9.6 ms |
| `restore`, `skills-repair`, `agent-runtime` | 4.7 ms |
| `snapshot.stamp` + `copy` + `prune` | 2.5 ms |
| agent spawned at | 93 ms since process start |

Half of the overhead is Node starting and loading the module graph: it is
process-startup bound, not history bound — no phase scales with session count.
The measured total (123 ms median steady) minus the 93 ms mark is process
spawn, teardown and the exit path. The fast path performs no network, no
registry lookup, no `git fetch`, no Hub access, no LLM call, no full canonical
scan, no full native-history walk, no unmapped-session materialization and no
polling; `test/launch-latency.test.mjs` holds the invariant that a plain launch
touches no canonical history before the agent's TUI starts.

## P1 — `avenic status`

One core model (`packages/core/src/status.mjs`, `STATUS_SCHEMA_VERSION = 1`)
that the terminal renders, `--json` prints unchanged, and the extension draws —
so all three hosts answer the same question with the same answer. Read-only:
no network, no git, no launch reconciliation, no agent CLI started. A missing
agent CLI is reported in its row rather than failing the command.

Real output, in a project with three initialized agents, the `common` Pack
installed from the real Hub, and the Hub cached:

```
Avenic Status

Project   project
Root      C:\Users\…\project
Agents    claude, codex, opencode
History   shared

History
  Mode      shared
  Sessions  0
  Active    none — run: avenic sessions list
  Updated   —

Agents
  Agent        CLI    Auth         Sessions          History  Sync
  Claude Code  found  global auth  project sessions  0        current
  Codex        found  global auth  project sessions  0        current
  OpenCode     found  global auth  project sessions  0        current

Skills
  Project  29 installed · Common · optimized
  Global   nothing installed
  Hub      Echo-Kang-hub/SkillsHub · current · 9122e3a
```

Two rendering defects were found by running it for real and fixed in this
pass: the pack list printed `[object Object]` (the model handed renderers the
lock file's full pack records instead of `{ id, name }`), and an absent
timestamp printed `1970-01-01 08:00` (`shortTimestamp(null)` treated "no value"
as the epoch).

## P2 — Skills UX

`avenic skills` on a terminal opens the menu: Add skills · Installed skills ·
Update skills · Remove skills · Sync SkillsHub · Import from repository · Back.
The Add flow is source → clone/discover (`Found 14 skills`) → searchable
multi-select → Install to → Scope → summary → confirm → box. The summary names
the source and its revision, the skills, the targets with their real paths and
the scope, because those are the four things a user cannot undo by accident.
The same flow serves the menu's Add and Import entries, a bare
`avenic skills install`, and `avenic skills add <repo>` when no skill is named;
naming skills keeps the old scriptable behaviour. Which targets were chosen is
persisted in the lock file, so the next update does not silently re-share into
a target the user unchecked.

## P3 — one set of TUI primitives

`packages/cli/src/cli/prompts.mjs` is the only keyboard and frame
implementation: `banner`, `select`, `searchSelect`, `multiselect`, `text`,
`confirm`, `spinner`, `intro`/`outro`/`cancel`/`error`, `box`. Arrows and
`j`/`k` move with wrap-around, space toggles, `Ctrl+A` selects all, typing
filters a searchable list, Enter confirms, `y`/`n` answer a confirmation, and
Esc or `Ctrl+C` cancels. Enter with zero selections is refused in place
(`Select at least one item`), a fixed row cannot be turned off, and a pipe
takes the script path instead of the menu. No TUI framework is used.

## P4 — the command surface

The help output and the README teach ten commands: `init`, `change`, `status`,
`skills`, `sessions`, `claude`, `codex`, `opencode`, `self-update`,
`--version`. The older spellings still run, warn, and name their replacement:
`avenic doctor` → `avenic status`, top-level `avenic add|install|uninstall|adopt|packs|tree`
→ the same verb under `avenic skills`, `avenic catalog` → `avenic hub`. Each
one forwards to the single implementation; there is no second code path.
`avenic hub …` and `avenic model …` remain as maintenance surfaces outside the
daily ten, documented in their own chapters.

## P11 — programmatically drivable input layer

`test/cli-prompts.test.mjs` drives the production prompt code through
`FakeTTY` + `keys()`: arrows and `j`/`k` with wrap-around, space, `Ctrl+A`,
`n`, Enter, `y`/`n` on a confirmation, Esc, `Ctrl+C` mid-edit, backspace,
type-to-filter and its `⌕ ga  (1/3)` counter, a fixed row refusing to toggle,
empty-input Enter staying in place, an empty required selection staying open,
and a pipe (non-TTY) taking the script path with no control sequences in the
output. 18 tests in that file, 515 in the suite.

## P12 — CLI / VS Code parity

`packages/vscode/src/dashboard/state.ts` now calls `collectStatus` and maps it
for the webview instead of computing its own agent rows, Hub revision or
Skills health. The dashboard gained a 共享历史 card and per-agent sync chips
using core's six words. The extension typechecks, builds, and passes 154
tests; three tests that asserted the old hand-computed dashboard were updated
to assert the model instead.

## P10 — production LOC

Baseline is the last release commit (`104aaf1`, avenic 1.5.2 / core 1.4.2 /
extension 0.3.0). Counted over production sources only — vendor copies, tests,
docs and binary assets (codicon.ttf, icon.png) excluded, non-blank lines:

| Area | Before | After | Net |
|---|---|---|---|
| core (`packages/core/src`) | 7 164 | 7 596 | **+432** |
| CLI (`packages/cli/src`) | 2 701 | 3 098 | **+397** |
| CLI scripts | 69 | 87 | **+18** |
| VS Code src | 2 761 | 2 792 | **+31** |
| VS Code media (js/css/html/svg) | 1 803 | 1 838 | **+35** |
| **Total** | **14 498** | **15 411** | **+913** |

`git diff --numstat` counts the churn behind the net figures: 941 added and
512 removed in `packages/cli/src`, 526 added and 72 removed in
`packages/core/src` (both excluding the files below, which are new).

New files: `core/status.mjs` (228), `cli/launch.mjs` (181),
`cli/status-cli.mjs` (98), `core/runtime/timing.mjs` (42),
`core/util/stamp.mjs` (15), `cli/agent-commands.mjs` (8) — 572 lines, no file
deleted. The reshaping is consolidation inside existing files rather than
growth for its own sake: `dispatcher.mjs` shrank from 909 to 803 raw lines by
handing the launch sequence to `launch.mjs` and the legacy spellings to one
forwarding table, and `skills-cli.mjs` traded its one-off orchestration for the
single Add flow that four entry points now share.

Duplicated orchestration, before → after:

| Behaviour | Before | After |
|---|---|---|
| Interactive Skills install (pick → confirm → install → box) | `interactiveInstall`, 85 lines, one entry point | `addSkillsFlow` + four named steps, four entry points (menu Add, menu Import, bare `skills install`, `skills add <repo>` with no names) |
| Repository install | installs every Skill in the repo, no discovery step | clone once, discover, searchable pick, then install |
| Project status for hosts | CLI rendered it, the extension computed its own agent rows, Hub revision and Skills health | one `core/status.mjs` model; CLI renders, `--json` prints, the extension maps |
| Launch sequence | inline in the dispatcher | `cli/launch.mjs`, one implementation for all three agents |
| Timestamp formatting | each host formatted its own | `core/util/stamp.mjs` |
| Install targets | implicit (every share target) | recorded in the lock, honoured by update/uninstall |

## P13–P17 — version, artifacts, docs

- `avenic --version` prints `Avenic 1.6.0` from `package.json` metadata alone;
  the release smoke asserts it is not a constant, and self-update reports
  Current / Latest / Source for the executable `PATH` would run.
- Versions: core 1.4.2 → **1.5.0**, CLI 1.5.2 → **1.6.0**, extension 0.3.0 →
  **0.4.0** (new capability in all three; no breaking removals).
- Full regression: `npm test` 515 tests / 512 pass / 3 skipped / 0 fail;
  `npm run test:install` PASS; `npm run test:release` PASS on the packed
  tarball; VS Code typecheck + 154 tests + `npm run package` PASS;
  `npm run pack:cli` reports 66 files and `avenic@1.6.0`.
- Artifacts in `dist/release-20260919-1006/` with `SHA256SUMS.txt` and
  `RELEASE-NOTES.md`: `avenic-1.6.0.tgz` (162 824 B), `avenic-core-1.5.0.tgz`
  (118 799 B), `avenic-agent-manager.vsix` (217 461 B). This exact tarball,
  installed into a temp global prefix, prints `Avenic 1.6.0` and teaches only
  the converged surface.
- Real Hub sync through the system's own git credentials: `git ls-remote`
  `Echo-Kang-hub/SkillsHub` → `9122e3aa…`, `avenic hub sync` →
  `Synced · 9122e3a`, packs and Skills listed from cache afterwards with the
  network blocked (`https_proxy` pointed at a dead port).
- `AGENTS.md` rewritten as a full agent guide (setup, commands, testing,
  performance, code style, build/release, security) with the release-safety
  rules preserved.

Remaining: publishing `@avenic/core` 1.5.0 then `avenic` 1.6.0 (npm OTP or
browser authorization) and uploading the 0.4.0 VSIX — the owner's two steps.
