import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getSessionAdapter, importProjectSessions, readFirstJsonLine, samePath } from "../packages/core/src/index.mjs";
import { pathToFileURL } from "node:url";

const CLAUDE = `${JSON.stringify({ type: "user", uuid: "u1", sessionId: "claude-1", timestamp: "2026-09-14T00:00:00.000Z", message: { role: "user", content: "A" } })}\n${JSON.stringify({ type: "assistant", uuid: "a1", sessionId: "claude-1", timestamp: "2026-09-14T00:00:01.000Z", message: { role: "assistant", model: "claude-test", content: [{ type: "text", text: "B" }], future: "retained" } })}\n`;
const CODEX = `${JSON.stringify({ type: "session_meta", payload: { id: "codex-1", cwd: "/project", model_provider: "openai" } })}\n${JSON.stringify({ timestamp: "2026-09-14T00:00:00.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "A" }] } })}\n${JSON.stringify({ timestamp: "2026-09-14T00:00:01.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "B" }], model: "gpt-test", future: true } })}\n`;

// An adapter answers two questions: how to read its native session into
// canonical events, and how to give a canonical conversation back to its own
// agent. The second one is a projection — native history where the official
// surface supports it, a structured briefing where it does not — so that is
// what the contract asserts.
test("every registered adapter exposes the canonical reader and projection contract", () => {
  for (const agentId of ["claude", "codex", "opencode"]) {
    const adapter = getSessionAdapter(agentId);
    assert.equal(adapter.agentId, agentId);
    assert.equal(typeof adapter.toCanonical, "function", `${agentId}.toCanonical`);
    assert.equal(typeof adapter.readCanonical, "function", `${agentId}.readCanonical`);
    assert.equal(typeof adapter.projectCanonical, "function", `${agentId}.projectCanonical`);
    assert.equal(typeof adapter.resumeArguments, "function", `${agentId}.resumeArguments`);
    assert.ok(adapter.resumeArguments("native-id").length > 0, `${agentId} opens a named session`);
  }
});

test("Claude JSONL normalizes ordered messages and keeps unknown native fields", () => {
  const result = getSessionAdapter("claude").toCanonical(CLAUDE, { nativeSessionId: "claude-1" });
  assert.equal(result.nativeSessionId, "claude-1");
  assert.deepEqual(result.events.map((event) => event.content[0].text), ["A", "B"]);
  assert.equal(result.events[1].model, "claude-test");
  assert.equal(result.events[1].extensions.claude.message.future, "retained");
});

test("Claude JSONL skips malformed records without losing later history", () => {
  const input = `${CLAUDE}{broken\n${JSON.stringify({ type: "assistant", uuid: "a2", sessionId: "claude-1", message: { role: "assistant", content: "C" } })}\n`;
  const result = getSessionAdapter("claude").toCanonical(input, { nativeSessionId: "claude-1" });
  assert.deepEqual(result.events.map((event) => event.content[0].text), ["A", "B", "C"]);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.diagnostics[0].kind, "malformed-record");
  const tail = getSessionAdapter("claude").toCanonical(`${CLAUDE}{truncated`, { nativeSessionId: "claude-1" });
  assert.equal(tail.diagnostics[0].kind, "truncated-tail");
});

test("Codex JSONL normalizes response items and keeps native payload extensions", () => {
  const result = getSessionAdapter("codex").toCanonical(CODEX, { nativeSessionId: "codex-1" });
  assert.equal(result.nativeSessionId, "codex-1");
  assert.deepEqual(result.events.map((event) => event.content[0].text), ["A", "B"]);
  assert.equal(result.events[1].model, "gpt-test");
  assert.equal(result.events[1].extensions.codex.payload.future, true);
});

test("Claude and Codex native readers select the mapped session without scanning credentials", async () => {
  const root = await (await import("node:fs/promises")).mkdtemp(path.join(os.tmpdir(), "avenic-native-reader-"));
  try {
    const projectRoot = path.join(root, "project");
    const claudeHome = path.join(root, "claude-config");
    const codexHome = path.join(root, "codex-home");
    const claudeFile = path.join(claudeHome, "projects", getSessionAdapter("claude").claudeProjectKey(projectRoot), "claude-1.jsonl");
    const codexFile = path.join(codexHome, "sessions", "2026", "rollout.jsonl");
    await mkdir(path.dirname(claudeFile), { recursive: true });
    await mkdir(path.dirname(codexFile), { recursive: true });
    await writeFile(claudeFile, CLAUDE);
    await writeFile(codexFile, CODEX.replace('"/project"', JSON.stringify(projectRoot)));

    const claude = await getSessionAdapter("claude").readCanonical(projectRoot, "claude-1", { environment: { CLAUDE_CONFIG_DIR: claudeHome } });
    const codex = await getSessionAdapter("codex").readCanonical(projectRoot, "codex-1", { environment: { CODEX_HOME: codexHome } });
    assert.deepEqual(claude.events.map((item) => item.content[0].text), ["A", "B"]);
    assert.deepEqual(codex.events.map((item) => item.content[0].text), ["A", "B"]);
  } finally {
    await (await import("node:fs/promises")).rm(root, { recursive: true, force: true });
  }
});

test("Claude discovery matches native cwd metadata when Claude's project directory is not derivable", async () => {
  const root = await (await import("node:fs/promises")).mkdtemp(path.join(os.tmpdir(), "avenic-claude-discovery-"));
  try {
    const projectRoot = path.join(root, "Project With Space");
    const claudeHome = path.join(root, "claude-config");
    const nativeFile = path.join(claudeHome, "projects", "claude-private-directory-name", "claude-1.jsonl");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(path.dirname(nativeFile), { recursive: true });
    await writeFile(nativeFile, CLAUDE.replace('"timestamp"', `"cwd":${JSON.stringify(projectRoot)},"timestamp"`));

    const result = await getSessionAdapter("claude").capture(projectRoot, { environment: { CLAUDE_CONFIG_DIR: claudeHome } });
    const portableRoot = path.join(projectRoot, ".agents", "sessions", "claude");
    assert.equal(result.count, 1);
    assert.deepEqual((await readdir(portableRoot)).filter((name) => name.endsWith(".jsonl")), ["claude-1.jsonl"]);
  } finally {
    await (await import("node:fs/promises")).rm(root, { recursive: true, force: true });
  }
});

test("project identity accepts Windows separators, trailing separators, and file URIs", async () => {
  const root = path.join(os.tmpdir(), "avenic project identity");
  const slashForm = root.replace(/\\/g, "/");
  assert.equal(samePath(root, `${slashForm}${path.sep}`), true);
  assert.equal(samePath(root, pathToFileURL(root).href), true);
  if (process.platform === "win32") {
    assert.equal(samePath(root, root[0].toLowerCase() + root.slice(1)), true);
  }
});

// Discovery compares this project's root against the cwd recorded in every
// session on the machine, so the same handful of spellings is compared
// thousands of times per pass. Resolving a spelling through the filesystem is
// the only expensive part, and repeating it per comparison is what made a
// machine with a long unrelated history slow down launch bookkeeping, so an
// unchanged pair must be answerable from memory.
test("repeatedly comparing the same two identities never revisits the filesystem", async () => {
  const root = path.join(os.tmpdir(), "avenic identity repeat");
  const other = path.join(os.tmpdir(), "avenic identity other");
  samePath(root, other); // The first comparison is allowed to resolve both sides.
  const started = process.hrtime.bigint();
  let consistent = true;
  for (let index = 0; index < 5000; index += 1) {
    consistent = consistent && samePath(root, other) === false && samePath(root, root) === true;
  }
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.equal(consistent, true);
  assert.ok(ms < 50, `5000 repeated identity comparisons took ${ms.toFixed(0)} ms`);
});

// A native session file is identified from its first line, so the read stops
// at the head. Only a head that is one enormous single line falls back to the
// whole file, and every shape must still answer with that first line.
test("the first record of a native session file is read whatever the file size", async () => {
  const root = await (await import("node:fs/promises")).mkdtemp(path.join(os.tmpdir(), "avenic-head-read-"));
  try {
    const header = JSON.stringify({ type: "session_meta", payload: { id: "codex-1", cwd: "/project" } });
    const body = `${JSON.stringify({ type: "response_item", payload: { type: "message", role: "user", content: [] } })}\n`;
    const cases = {
      "huge-body.jsonl": `${header}\n${body.repeat(20000)}`,
      "long-header.jsonl": `${JSON.stringify({ type: "session_meta", payload: { id: "codex-1", cwd: "/project", instructions: "x".repeat(80 * 1024) } })}\n${body}`,
      "single-line.jsonl": header,
    };
    for (const [name, content] of Object.entries(cases)) {
      const file = path.join(root, name);
      await writeFile(file, content);
      assert.equal((await readFirstJsonLine(file)).type, "session_meta", name);
    }
  } finally {
    await (await import("node:fs/promises")).rm(root, { recursive: true, force: true });
  }
});

// An agent's history root also holds derived lookups — Codex's
// `session_index.jsonl`, Claude's `sessions-index.json`. Copying one into the
// project is harmless, but importing it as a conversation is not: it is not a
// session, and reporting it as a failed import would train the user to ignore
// the count that does matter.
test("derived session indexes are never imported as conversations", async () => {
  const root = await (await import("node:fs/promises")).mkdtemp(path.join(os.tmpdir(), "avenic-portable-index-"));
  try {
    const projectRoot = path.join(root, "project");
    const portable = path.join(projectRoot, ".agents", "sessions", "claude");
    await mkdir(portable, { recursive: true });
    await writeFile(path.join(portable, "claude-1.jsonl"), CLAUDE.replace('"timestamp"', `"cwd":${JSON.stringify(projectRoot)},"timestamp"`));
    await writeFile(path.join(portable, "sessions-index.json"), `${JSON.stringify({ version: 1, entries: [{ sessionId: "claude-1" }] }, null, 2)}\n`);

    const result = await importProjectSessions(projectRoot, "claude", { skipCapture: true, environment: {} });
    assert.equal(result.failed, 0);
    assert.equal(result.imported, 1);
    assert.deepEqual(result.diagnostics, []);
  } finally {
    await (await import("node:fs/promises")).rm(root, { recursive: true, force: true });
  }
});

test("Claude discovery reports a missing configured session root instead of silently returning zero", async () => {
  const root = await (await import("node:fs/promises")).mkdtemp(path.join(os.tmpdir(), "avenic-claude-empty-"));
  try {
    const result = await getSessionAdapter("claude").capture(path.join(root, "project"), {
      environment: { CLAUDE_CONFIG_DIR: path.join(root, "missing-config") },
    });
    assert.equal(result.count, 0);
    assert.match(result.diagnostics[0].message, /session root not found/i);
  } finally {
    await (await import("node:fs/promises")).rm(root, { recursive: true, force: true });
  }
});

test("Codex discovery reports a missing configured session root instead of silently returning zero", async () => {
  const root = await (await import("node:fs/promises")).mkdtemp(path.join(os.tmpdir(), "avenic-codex-empty-"));
  try {
    const result = await getSessionAdapter("codex").capture(path.join(root, "project"), {
      environment: { CODEX_HOME: path.join(root, "missing-home") },
    });
    assert.equal(result.count, 0);
    assert.match(result.diagnostics[0].message, /session root not found/i);
  } finally {
    await (await import("node:fs/promises")).rm(root, { recursive: true, force: true });
  }
});

test("OpenCode import data is read through its official exported message shape", () => {
  const exported = {
    id: "open-1",
    messages: [
      { info: { id: "u1", role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "A" }] },
      { info: { id: "a1", role: "assistant", time: { created: 2 }, modelID: "model" }, parts: [{ type: "text", text: "B" }] },
    ],
  };
  const result = getSessionAdapter("opencode").toCanonical(JSON.stringify(exported));
  assert.equal(result.nativeSessionId, "open-1");
  assert.deepEqual(result.events.map((event) => event.content[0].text), ["A", "B"]);
});

test("OpenCode projection emits the official export envelope with ordered portable text messages", () => {
  const projected = getSessionAdapter("opencode").fromCanonical([
    { id: "canon-a", role: "user", createdAt: "2026-09-14T00:00:00.000Z", content: [{ type: "text", text: "A" }] },
    { id: "canon-b", role: "assistant", createdAt: "2026-09-14T00:00:01.000Z", content: [{ type: "text", text: "B" }] },
  ], { canonicalSessionId: "canonical-1", title: "Avenic projection", directory: "C:/fixture" });
  assert.equal(projected.format, "opencode-export-v1");
  assert.equal(projected.data.info.title, "Avenic projection");
  assert.deepEqual(projected.data.messages.map((message) => message.info.role), ["user", "assistant"]);
  assert.deepEqual(projected.data.messages.map((message) => message.parts[0].text), ["A", "B"]);
  assert.match(projected.data.messages[0].info.id, /^msg_/);
  assert.equal(projected.diagnostics.length, 0);
});

test("OpenCode projection keeps an explicitly selected session model on every projected message", () => {
  const projected = getSessionAdapter("opencode").fromCanonical([
    { id: "canon-a", role: "user", createdAt: "2026-09-14T00:00:00.000Z", content: [{ type: "text", text: "A" }] },
    { id: "canon-b", role: "assistant", createdAt: "2026-09-14T00:00:01.000Z", content: [{ type: "text", text: "B" }] },
  ], {
    canonicalSessionId: "canonical-model",
    model: { id: "nemotron-3.5-lightning-free", providerID: "opencode", variant: "default" },
  });
  assert.deepEqual(projected.data.info.model, { id: "nemotron-3.5-lightning-free", providerID: "opencode", variant: "default" });
  assert.equal(projected.data.messages[0].info.model.modelID, "nemotron-3.5-lightning-free");
  assert.equal(projected.data.messages[1].info.modelID, "nemotron-3.5-lightning-free");
});

test("OpenCode projection gives untitled canonical sessions an official string title", () => {
  const projected = getSessionAdapter("opencode").fromCanonical([], { canonicalSessionId: "untitled" });
  assert.equal(projected.data.info.title, "Avenic session untitled");
});
