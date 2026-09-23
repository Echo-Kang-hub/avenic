import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendCanonicalEvents,
  createCanonicalSession,
  formatSessionDiagnostics,
  findCanonicalSessionForNative,
  getSessionAdapter,
  importProjectSessions,
  listCanonicalSessionRecords,
  readCanonicalSession,
  syncNativeMapping,
} from "../packages/core/src/index.mjs";

async function withStore(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-canonical-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("canonical store creates a versioned session and filters credential-like metadata", async () => {
  await withStore(async (projectRoot) => {
    const created = await createCanonicalSession(projectRoot, {
      title: "Interop fixture",
      source: "claude",
      metadata: { apiKey: "must-not-persist", safe: "kept" },
    });
    assert.match(created.id, /^[0-9a-f-]{36}$/);
    const stored = await readCanonicalSession(projectRoot, created.id);
    assert.equal(stored.session.schemaVersion, 1);
    assert.deepEqual(stored.state, {
      schemaVersion: 1,
      goal: null,
      currentTask: null,
      completed: [],
      pending: null,
      decisions: [],
      relevantFiles: [],
      blockers: [],
      warnings: [],
    });
    assert.equal(stored.session.title, "Interop fixture");
    assert.equal(stored.session.metadata.safe, "kept");
    assert.equal("apiKey" in stored.session.metadata, false);
  });
});

test("canonical event append is deterministic, idempotent, and preserves unknown native fields", async () => {
  await withStore(async (projectRoot) => {
    const { id } = await createCanonicalSession(projectRoot, { source: "codex" });
    const event = {
      id: "codex:message-1",
      role: "assistant",
      createdAt: "2026-09-14T00:00:00.000Z",
      content: [{ type: "text", text: "B" }],
      extensions: { codex: { future_field: { retained: true } } },
    };
    assert.deepEqual(await appendCanonicalEvents(projectRoot, id, [event]), { added: 1, duplicate: 0 });
    assert.deepEqual(await appendCanonicalEvents(projectRoot, id, [event]), { added: 0, duplicate: 1 });
    const stored = await readCanonicalSession(projectRoot, id);
    assert.deepEqual(stored.events, [event]);
  });
});

// 「像凭证」和「是凭证」不是一件事。名字里出现 secret/token/auth 就算秘密的规则会把
// 用户的字段一起丢掉：`author` 挂着作者，`tokens` 是用量计数（OpenCode 每条消息都
// 带），`input_tokens` 是每一次请求的账。整词末尾对不上，就不是秘密。
test("a stored event drops a credential by name and keeps a name that only resembles one", async () => {
  await withStore(async (projectRoot) => {
    const { id } = await createCanonicalSession(projectRoot, { source: "opencode" });
    const value = "fixture-not-a-real-secret";
    await appendCanonicalEvents(projectRoot, id, [{
      id: "opencode:message-1",
      role: "assistant",
      createdAt: "2026-09-24T00:00:00.000Z",
      content: [{ type: "tool_use", name: "search", input: { author: "A fixture author", tokens: { input: 12 }, apiKey: value } }],
      extensions: { opencode: { message: { tokens: { input: 12, output: 34 }, credentials: value, cookie: value } } },
    }]);
    const stored = (await readCanonicalSession(projectRoot, id)).events[0];
    assert.deepEqual(stored.content[0].input, { author: "A fixture author", tokens: { input: 12 } }, "长得像凭证的名字是用户的数据");
    assert.deepEqual(stored.extensions.opencode.message, { tokens: { input: 12, output: 34 } }, "用量计数留住，凭证容器丢掉");
  });
});

// 同一场对话有三处可能同时追加：启动器的退出那一遍、耐久看门狗、编辑器宿主。追加是
// 「读整份、改、写回」——没有门的话，后写回的那一份拿自己的旧快照盖上去，另一支笔
// 刚写的事件整段消失；而游标会记住「那份 native 已导入过」，之后不会再读它一次。
test("two writers appending at the same time both land, and the record agrees with the log", async () => {
  await withStore(async (projectRoot) => {
    for (let round = 0; round < 6; round += 1) {
      const { id } = await createCanonicalSession(projectRoot, { source: "claude" });
      const event = (side, index) => ({
        id: `${side}:${index}`,
        role: "user",
        createdAt: `2026-09-24T00:00:0${index}.000Z`,
        content: [{ type: "text", text: `${side} ${index}` }],
      });
      const [first, second] = await Promise.all([
        appendCanonicalEvents(projectRoot, id, [event("a", 1), event("a", 2)]),
        appendCanonicalEvents(projectRoot, id, [event("b", 3), event("b", 4)]),
      ]);
      assert.equal(first.added + second.added, 4, `round ${round}: both writers' events counted`);
      const stored = await readCanonicalSession(projectRoot, id);
      assert.deepEqual(stored.events.map((entry) => entry.id).sort(), ["a:1", "a:2", "b:3", "b:4"], `round ${round}: nothing lost`);
      const record = JSON.parse(await readFile(path.join(projectRoot, ".agents", "sessions", "canonical", id, "session.json"), "utf8"));
      assert.equal(record.eventCount, 4, `round ${round}: the record's count is the log's count`);
      assert.equal(record.lastEventId, stored.events.at(-1).id, `round ${round}: and its end is the log's end`);
    }
  });
});

test("native mappings retain stable projection identity and revision hashes", async () => {
  await withStore(async (projectRoot) => {
    const { id } = await createCanonicalSession(projectRoot, { source: "opencode" });
    await syncNativeMapping(projectRoot, id, {
      agentId: "opencode",
      nativeSessionId: "ses_123",
      nativeRevision: "native-hash",
      canonicalRevision: "canonical-hash",
    });
    await syncNativeMapping(projectRoot, id, {
      agentId: "opencode",
      nativeSessionId: "ses_123",
      nativeRevision: "native-hash-2",
      canonicalRevision: "canonical-hash-2",
    });
    const stored = await readCanonicalSession(projectRoot, id);
    assert.equal(stored.mappings.projections.opencode.nativeSessionId, "ses_123");
    assert.equal(stored.mappings.projections.opencode.nativeRevision, "native-hash-2");
    assert.equal(Object.keys(stored.mappings.projections).length, 1);
  });
});

test("a session named after its first turn takes the name its store gains later", async () => {
  await withStore(async (projectRoot) => {
    const claudeHome = path.join(projectRoot, "claude-config");
    const native = path.join(claudeHome, "projects", getSessionAdapter("claude").claudeProjectKey(projectRoot), "rename-me.jsonl");
    await mkdir(path.dirname(native), { recursive: true });
    const turn = JSON.stringify({ type: "user", uuid: "u", sessionId: "rename-me", cwd: projectRoot, timestamp: "2026-09-16T00:00:00.000Z", message: { role: "user", content: "what does this project do" } });

    // The first capture happens before the conversation has a name of its own,
    // so it is named after the first thing the user said.
    await writeFile(native, `${turn}\n`);
    await importProjectSessions(projectRoot, "claude", { environment: { CLAUDE_CONFIG_DIR: claudeHome } });
    assert.equal((await readCanonicalSession(projectRoot, "claude-rename-me")).session.title, "what does this project do");

    // The user renames the conversation in the agent itself: the transcript
    // gains a summary record, which is where that store keeps the name. That
    // name is the authority for this session, and it must reach the shared
    // record — a session named by an early capture could otherwise never take
    // the name its own store gained, and the dashboard would keep showing the
    // first sentence forever.
    await writeFile(native, `${JSON.stringify({ type: "summary", summary: "Project orientation", sessionId: "rename-me" })}\n${turn}\n`);
    await importProjectSessions(projectRoot, "claude", { environment: { CLAUDE_CONFIG_DIR: claudeHome } });
    assert.equal((await readCanonicalSession(projectRoot, "claude-rename-me")).session.title, "Project orientation");
  });
});

test("a corrupt session record does not take its neighbours down with it", async () => {
  await withStore(async (projectRoot) => {
    const kept = await createCanonicalSession(projectRoot, { id: "aaaa-kept", title: "Kept session", source: "claude" });
    const broken = await createCanonicalSession(projectRoot, { id: "zzzz-broken", title: "Broken session", source: "claude" });
    // What a half-written file, a full disk, or an edit outside Avenic leaves
    // behind: the record is there and it is not JSON. One such file must cost
    // its own session and nothing else — a list that throws shows the user no
    // shared history at all, which is how a single bad file becomes every bad
    // file. Both files are corrupted so the assertion does not depend on the
    // order the directory happens to come back in.
    const canonicalRoot = path.join(projectRoot, ".agents", "sessions", "canonical");
    await writeFile(path.join(canonicalRoot, broken.id, "session.json"), "{ not json", "utf8");
    await writeFile(path.join(canonicalRoot, broken.id, "mappings.json"), "{ not json", "utf8");
    // A mapping an import would ask about, written where the finder looks.
    await writeFile(path.join(canonicalRoot, kept.id, "mappings.json"), JSON.stringify({
      schemaVersion: 1,
      canonicalSessionId: kept.id,
      projections: { claude: { nativeSessionId: "native-kept" } },
    }), "utf8");

    const records = await listCanonicalSessionRecords(projectRoot);
    assert.deepEqual(records.map((record) => record.id), [kept.id]);
    // The capture path asks a question of the same tree: a corrupt mappings
    // file next door must not stop it finding the mapping that is there.
    assert.equal(await findCanonicalSessionForNative(projectRoot, "claude", "native-kept"), kept.id);
  });
});

test("canonical files stay inside the canonical session root", async () => {
  await withStore(async (projectRoot) => {
    await assert.rejects(() => createCanonicalSession(projectRoot, { id: "../escape" }), /safe session id/i);
    const canonicalRoot = path.join(projectRoot, ".agents", "sessions", "canonical");
    const entries = await readFile(path.join(canonicalRoot, "..", "..", "runtime.json"), "utf8").catch(() => null);
    assert.equal(entries, null);
  });
});

test("project native import creates a canonical mapping and stays idempotent", async () => {
  await withStore(async (projectRoot) => {
    const claudeHome = path.join(projectRoot, "claude-config");
    const native = path.join(claudeHome, "projects", getSessionAdapter("claude").claudeProjectKey(projectRoot), "legacy-claude.jsonl");
    await (await import("node:fs/promises")).mkdir(path.dirname(native), { recursive: true });
    await (await import("node:fs/promises")).writeFile(native, `${JSON.stringify({ type: "user", uuid: "u", sessionId: "legacy-claude", cwd: projectRoot, timestamp: "2026-09-16T00:00:00.000Z", message: { role: "user", content: "legacy" } })}\n`);

    const first = await importProjectSessions(projectRoot, "claude", { environment: { CLAUDE_CONFIG_DIR: claudeHome } });
    const second = await importProjectSessions(projectRoot, "claude", { environment: { CLAUDE_CONFIG_DIR: claudeHome } });
    const stored = await readCanonicalSession(projectRoot, "claude-legacy-claude");
    assert.deepEqual({ discovered: first.discovered, imported: first.imported, unchanged: first.unchanged }, { discovered: 1, imported: 1, unchanged: 0 });
    assert.deepEqual({ discovered: second.discovered, imported: second.imported, unchanged: second.unchanged }, { discovered: 1, imported: 0, unchanged: 1 });
    assert.equal(stored.events.length, 1);
    assert.equal(stored.mappings.projections.claude.nativeSessionId, "legacy-claude");
  });
});

test("project native import reports malformed native history instead of silently returning zero", async () => {
  await withStore(async (projectRoot) => {
    const claudeHome = path.join(projectRoot, "claude-config");
    const native = path.join(claudeHome, "projects", getSessionAdapter("claude").claudeProjectKey(projectRoot), "broken.jsonl");
    await (await import("node:fs/promises")).mkdir(path.dirname(native), { recursive: true });
    await (await import("node:fs/promises")).writeFile(native, "{not json}\n");
    const result = await importProjectSessions(projectRoot, "claude", { environment: { CLAUDE_CONFIG_DIR: claudeHome } });
    assert.equal(result.discovered, 0);
    assert.equal(result.failed, 1);
    assert.match(formatSessionDiagnostics(result.diagnostics).warnings.at(-1), /could not be read|no session id/i);
  });
});

test("Codex project history imports to portable and canonical stores idempotently", async () => {
  await withStore(async (projectRoot) => {
    const codexHome = path.join(projectRoot, "codex-home");
    const rollout = path.join(codexHome, "sessions", "2026", "rollout.jsonl");
    await (await import("node:fs/promises")).mkdir(path.dirname(rollout), { recursive: true });
    const rows = [
      { type: "session_meta", payload: { id: "legacy-codex", cwd: projectRoot, model_provider: "openai" } },
      { type: "response_item", timestamp: "2026-09-16T00:00:00.000Z", payload: { id: "u", type: "message", role: "user", content: [{ type: "input_text", text: "A" }] } },
    ];
    await (await import("node:fs/promises")).writeFile(rollout, `${rows.map(JSON.stringify).join("\n")}\n`);
    const options = { environment: { CODEX_HOME: codexHome } };
    const first = await importProjectSessions(projectRoot, "codex", options);
    const second = await importProjectSessions(projectRoot, "codex", options);
    const stored = await readCanonicalSession(projectRoot, "codex-legacy-codex");
    assert.deepEqual([first.discovered, first.imported, first.unchanged], [1, 1, 0]);
    assert.deepEqual([second.discovered, second.imported, second.unchanged], [1, 0, 1]);
    assert.equal(stored.mappings.projections.codex.nativeSessionId, "legacy-codex");
  });
});
