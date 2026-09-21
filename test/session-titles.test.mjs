import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createCanonicalSession,
  getSessionAdapter,
  importProjectSessions,
  listCanonicalSessionRecords,
  readCanonicalSession,
  readCanonicalSessionRecord,
  readTranscript,
} from "../packages/core/src/index.mjs";

// A session's title is what a reader sees first, and a raw id is never an
// answer: the dashboard lists conversations by what they were about. The
// fixtures below are invented native stores — one per agent — written into a
// temp tree, and every assertion is about the title a host would render.

// Two shapes of native session id: a Claude/Codex uuid, whose first eight
// characters are what the last-resort title may show, and a short opaque one.
const UUID_A = "3f9a1c2b-4d5e-4f60-8a1b-2c3d4e5f6071";
const UUID_B = "11111111-2222-4333-8444-555555555555";

// The developer's own CLAUDE_*/ANTHROPIC_* variables are not part of a fixture
// world: this machine may be running against a custom endpoint, and the launch
// environment is not what these tests are about.
function fixtureEnvironment(overrides) {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:ANTHROPIC_|CLAUDE_)/.test(key)));
  return {
    ...inherited,
    AVENIC_STATE_DIR: overrides.stateDir,
    ...overrides.vars,
  };
}

async function withTempTree(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-titles-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** One record shaped like a real Claude Code transcript line. */
function claudeRecord(sessionId, index, cwd, { role, text } = {}) {
  const turn = role ?? (index % 2 === 0 ? "user" : "assistant");
  return JSON.stringify({
    type: turn,
    uuid: `${sessionId}-record-${index}`,
    sessionId,
    timestamp: new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString(),
    cwd,
    message: { role: turn, model: "claude-sonnet-5", content: [{ type: "text", text: text ?? `message ${index}` }] },
  });
}

/** A tool result, which the API files under the user's role but the user never said. */
function claudeToolResult(sessionId, index, cwd) {
  return JSON.stringify({
    type: "user",
    uuid: `${sessionId}-tool-${index}`,
    sessionId,
    timestamp: new Date(Date.UTC(2026, 0, 2) + index * 1000).toISOString(),
    cwd,
    message: { role: "user", content: [{ type: "tool_result", content: "export function parse() {}" }] },
  });
}

/** The compaction record Claude Code writes at the top of a summarized session. */
function claudeSummary(text) {
  return JSON.stringify({ type: "summary", summary: text, leafUuid: "leaf-0000" });
}

async function withClaudeStore(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-titles-claude-"));
  const projectRoot = path.join(root, "project");
  const claudeHome = path.join(root, "claude-home");
  const nativeRoot = path.join(claudeHome, "projects", getSessionAdapter("claude").claudeProjectKey(projectRoot));
  await mkdir(nativeRoot, { recursive: true });
  await mkdir(path.join(projectRoot, ".agents"), { recursive: true });
  const environment = fixtureEnvironment({ stateDir: path.join(root, "state"), vars: { CLAUDE_CONFIG_DIR: claudeHome } });
  const helpers = {
    projectRoot,
    environment,
    nativeFile: (sessionId) => path.join(nativeRoot, `${sessionId}.jsonl`),
    canonicalDirectory: (canonicalId) => path.join(projectRoot, ".agents", "sessions", "canonical", canonicalId),
    sessionFile: (canonicalId) => path.join(projectRoot, ".agents", "sessions", "canonical", canonicalId, "session.json"),
    writeNative: async (sessionId, lines) => writeFile(path.join(nativeRoot, `${sessionId}.jsonl`), `${lines.join("\n")}\n`),
    import: (options = {}) => importProjectSessions(projectRoot, "claude", { environment, ...options }),
  };
  try {
    await run(helpers);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("a Claude summary record names the session ahead of anything the user said", async () => {
  await withClaudeStore(async ({ writeNative, import: importSessions, projectRoot }) => {
    await writeNative(UUID_A, [
      claudeSummary("Refactor the parser loop"),
      claudeRecord(UUID_A, 0, projectRoot, { text: "the parser is slow again" }),
      claudeRecord(UUID_A, 1, projectRoot, { text: "It rescans the file per token." }),
    ]);
    await importSessions();
    const stored = await readCanonicalSession(projectRoot, `claude-${UUID_A}`);
    assert.equal(stored.session.title, "Refactor the parser loop");
  });
});

test("a Claude session with no summary is titled by its first user message, collapsed to one line", async () => {
  await withClaudeStore(async ({ writeNative, import: importSessions, projectRoot }) => {
    await writeNative(UUID_A, [
      claudeRecord(UUID_A, 0, projectRoot, { text: "  why\n\n  is   the parser\tso  slow?  " }),
      claudeRecord(UUID_A, 1, projectRoot, { text: "It rescans the file per token." }),
    ]);
    await importSessions();
    const stored = await readCanonicalSession(projectRoot, `claude-${UUID_A}`);
    assert.equal(stored.session.title, "why is the parser so slow?");
  });
});

test("a long first message is capped at 80 characters with no added ellipsis", async () => {
  await withClaudeStore(async ({ writeNative, import: importSessions, projectRoot }) => {
    await writeNative(UUID_B, [
      claudeRecord(UUID_B, 0, projectRoot, { text: `walk me through ${"the long tail of this refactor ".repeat(6)}` }),
      claudeRecord(UUID_B, 1, projectRoot, { text: "Sure." }),
    ]);
    await importSessions();
    const { title } = (await readCanonicalSession(projectRoot, `claude-${UUID_B}`)).session;
    assert.equal(title.length, 80);
    assert.equal(title, ("walk me through " + "the long tail of this refactor ".repeat(3)).slice(0, 80));
    assert.equal(title.includes("…"), false, "a title is cut, not finished with an ellipsis");
  });
});

test("a session whose only user records are tool results is titled by its short id, never a uuid", async () => {
  await withClaudeStore(async ({ writeNative, import: importSessions, projectRoot }) => {
    await writeNative(UUID_A, [
      claudeToolResult(UUID_A, 0, projectRoot),
      claudeRecord(UUID_A, 1, projectRoot, { text: "I read the file." }),
    ]);
    await importSessions();
    const { title } = (await readCanonicalSession(projectRoot, `claude-${UUID_A}`)).session;
    assert.equal(title, "claude 3f9a1c2b");
  });
});

test("a Codex rollout with no metadata title is titled by its first user message", async () => {
  await withTempTree(async (root) => {
    const projectRoot = path.join(root, "project");
    const codexHome = path.join(root, "codex-home");
    const rollout = path.join(codexHome, "sessions", "2026", "rollout-2026-01-01T00-00-00-codex-1.jsonl");
    await mkdir(path.dirname(rollout), { recursive: true });
    await mkdir(path.join(projectRoot, ".agents"), { recursive: true });
    await writeFile(rollout, `${[
      JSON.stringify({ type: "session_meta", payload: { id: "codex-1", cwd: projectRoot, model_provider: "openai" } }),
      JSON.stringify({
        timestamp: "2026-01-01T00:00:01.000Z",
        type: "response_item",
        payload: { id: "codex-1-user", type: "message", role: "user", content: [{ type: "input_text", text: "switch the invoice export to CSV" }] },
      }),
      JSON.stringify({
        timestamp: "2026-01-01T00:00:02.000Z",
        type: "response_item",
        payload: { id: "codex-1-assistant", type: "message", role: "assistant", content: [{ type: "output_text", text: "Done." }] },
      }),
    ].join("\n")}\n`);

    const environment = fixtureEnvironment({ stateDir: path.join(root, "state"), vars: { CODEX_HOME: codexHome } });
    await importProjectSessions(projectRoot, "codex", { environment });
    const stored = await readCanonicalSession(projectRoot, "codex-codex-1");
    assert.equal(stored.session.title, "switch the invoice export to CSV");
  });
});

test("an OpenCode export is titled by the session title OpenCode stored", async () => {
  await withTempTree(async (root) => {
    const projectRoot = path.join(root, "project");
    const portable = path.join(projectRoot, ".agents", "sessions", "opencode");
    await mkdir(portable, { recursive: true });
    await writeFile(path.join(portable, "ses_revenue.json"), JSON.stringify({
      info: { id: "ses_revenue", title: "Quarterly revenue report", time: { created: 1, updated: 2 } },
      messages: [
        { info: { id: "ses_revenue-1", role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "pull the numbers together" }] },
        { info: { id: "ses_revenue-2", role: "assistant", time: { created: 2 } }, parts: [{ type: "text", text: "Here they are." }] },
      ],
    }));

    const environment = fixtureEnvironment({ stateDir: path.join(root, "state"), vars: {} });
    // Capture would ask the OpenCode CLI; the portable copy is what is imported.
    const result = await importProjectSessions(projectRoot, "opencode", { skipCapture: true, environment });
    assert.equal(result.imported, 1);
    assert.equal((await readCanonicalSession(projectRoot, "opencode-ses_revenue")).session.title, "Quarterly revenue report");
  });
});

test("an OpenCode export that carries its title under `data` is read the same way", () => {
  // The installed CLI answers with `info` at the top level, and the reader
  // already tolerates `data.messages`; wherever the payload nests, the title is
  // the session's own name and not the first thing the user typed.
  const exported = JSON.stringify({
    data: {
      info: { id: "ses_nested", title: "Migrate the billing schema", time: { created: 1, updated: 2 } },
      messages: [{ info: { id: "ses_nested-1", role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "start the migration" }] }],
    },
  });
  const native = getSessionAdapter("opencode").toCanonical(exported, { nativeSessionId: "ses_nested" });
  assert.equal(native.title, "Migrate the billing schema");
});

// Sessions imported before titles existed are named `<agent> <native id>`, and
// the id is a uuid the user never chose. The next import replaces it — and the
// import after that must not touch the file at all.
test("an import replaces a placeholder title once and never rewrites the session again", async () => {
  await withClaudeStore(async ({ writeNative, import: importSessions, projectRoot, sessionFile }) => {
    await writeNative(UUID_A, [
      claudeRecord(UUID_A, 0, projectRoot, { text: "why is the parser slow?" }),
      claudeRecord(UUID_A, 1, projectRoot, { text: "It rescans the file per token." }),
    ]);
    const canonicalId = `claude-${UUID_A}`;
    await createCanonicalSession(projectRoot, { id: canonicalId, source: "claude", title: `claude ${UUID_A}` });

    const first = await importSessions();
    assert.equal(first.imported, 1);
    assert.equal((await readCanonicalSession(projectRoot, canonicalId)).session.title, "why is the parser slow?");

    const file = sessionFile(canonicalId);
    const before = await readFile(file, "utf8");
    const stamp = await stat(file);
    const second = await importSessions();
    assert.equal(second.imported, 0);
    assert.equal((await readCanonicalSession(projectRoot, canonicalId)).session.title, "why is the parser slow?");
    assert.equal(await readFile(file, "utf8"), before, "a title that did not move must not be written back");
    assert.equal((await stat(file)).mtimeMs, stamp.mtimeMs, "the session file must not be touched at all");
  });
});

test("an import never overwrites a title a person set", async () => {
  await withClaudeStore(async ({ writeNative, import: importSessions, projectRoot }) => {
    await writeNative(UUID_A, [
      claudeRecord(UUID_A, 0, projectRoot, { text: "why is the parser slow?" }),
      claudeRecord(UUID_A, 1, projectRoot, { text: "It rescans the file per token." }),
    ]);
    const canonicalId = `claude-${UUID_A}`;
    await createCanonicalSession(projectRoot, { id: canonicalId, source: "claude", title: "Parser performance" });
    await importSessions();
    assert.equal((await readCanonicalSession(projectRoot, canonicalId)).session.title, "Parser performance");
  });
});

// A title can be an id without wearing the shape Avenic itself writes: a file
// edited by hand or written by a foreign tool may store the raw id — bare, or
// as the canonical id. Neither is a name, so a reader must not be shown one.
test("a stored title that is itself a session id is replaced like any placeholder", async () => {
  await withClaudeStore(async ({ projectRoot }) => {
    const cases = [
      { canonicalId: `claude-${UUID_A}`, native: UUID_A, stored: UUID_A, short: "claude 3f9a1c2b" },
      { canonicalId: `claude-${UUID_B}`, native: UUID_B, stored: `claude-${UUID_B}`, short: "claude 11111111" },
    ];
    for (const { canonicalId, native, stored } of cases) {
      await createCanonicalSession(projectRoot, { id: canonicalId, source: "claude", title: stored });
      await appendFile(path.join(projectRoot, ".agents", "sessions", "canonical", canonicalId, "events.jsonl"),
        `${JSON.stringify({
          id: `claude:${native}:u1`,
          role: "user",
          createdAt: "2026-01-01T00:00:00.000Z",
          content: [{ type: "text", text: "why is the parser slow?" }],
        })}\n`);
    }

    // The record-only read has only the ids to fall back to.
    for (const { canonicalId, short } of cases) {
      assert.equal((await readCanonicalSessionRecord(projectRoot, canonicalId)).session.title, short);
    }
    // The full read has the turns in hand, so it can do better.
    for (const { canonicalId } of cases) {
      assert.equal((await readCanonicalSession(projectRoot, canonicalId)).session.title, "why is the parser slow?");
    }
  });
});

test("a title a host reads is never a raw session id, with or without the event log", async () => {
  await withClaudeStore(async ({ projectRoot, sessionFile }) => {
    const canonicalId = `claude-${UUID_A}`;
    await createCanonicalSession(projectRoot, { id: canonicalId, source: "claude", title: `claude ${UUID_A}` });
    // A session stored the way the old import left it, with a real first turn.
    await appendFile(path.join(projectRoot, ".agents", "sessions", "canonical", canonicalId, "events.jsonl"),
      `${JSON.stringify({
        id: `claude:${UUID_A}:u1`,
        role: "user",
        createdAt: "2026-01-01T00:00:00.000Z",
        content: [{ type: "text", text: "why is the parser slow?" }],
      })}\n`);

    // A listing reads the record only: the id it can derive is the short one.
    const [record] = await listCanonicalSessionRecords(projectRoot);
    assert.equal(record.title, "claude 3f9a1c2b");
    assert.equal((await readCanonicalSessionRecord(projectRoot, canonicalId)).session.title, "claude 3f9a1c2b");

    // Reading the whole session has the turns in hand, so it can do better.
    const stored = await readCanonicalSession(projectRoot, canonicalId);
    assert.equal(stored.session.title, "why is the parser slow?");
    assert.equal((await readTranscript(projectRoot, canonicalId)).summary.title, "why is the parser slow?");
    assert.equal((await readTranscript(projectRoot, canonicalId)).session.title, "why is the parser slow?");

    // None of that wrote anything: the placeholder is still on disk for the
    // next import to upgrade.
    assert.equal(JSON.parse(await readFile(sessionFile(canonicalId), "utf8")).title, `claude ${UUID_A}`);
  });
});

test("no produced title anywhere in the store contains a session id", async () => {
  await withClaudeStore(async ({ writeNative, import: importSessions, projectRoot }) => {
    await writeNative(UUID_A, [
      claudeSummary("Refactor the parser loop"),
      claudeRecord(UUID_A, 0, projectRoot, { text: "go on" }),
    ]);
    await writeNative(UUID_B, [claudeToolResult(UUID_B, 0, projectRoot), claudeRecord(UUID_B, 1, projectRoot, { text: "I read the file." })]);
    await importSessions();

    const records = await listCanonicalSessionRecords(projectRoot);
    assert.equal(records.length, 2);
    for (const record of records) {
      assert.equal(typeof record.title, "string");
      assert.ok(record.title.length > 0, `${record.id} must have a title`);
      for (const id of [UUID_A, UUID_B]) assert.equal(record.title.includes(id), false, `${record.title} leaks ${id}`);
      assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(record.title), false, `${record.title} looks like a uuid`);
    }
  });
});
