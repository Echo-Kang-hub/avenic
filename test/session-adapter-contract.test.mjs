import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getSessionAdapter, samePath } from "../packages/core/src/index.mjs";
import { pathToFileURL } from "node:url";

const CLAUDE = `${JSON.stringify({ type: "user", uuid: "u1", sessionId: "claude-1", timestamp: "2026-09-14T00:00:00.000Z", message: { role: "user", content: "A" } })}\n${JSON.stringify({ type: "assistant", uuid: "a1", sessionId: "claude-1", timestamp: "2026-09-14T00:00:01.000Z", message: { role: "assistant", model: "claude-test", content: [{ type: "text", text: "B" }], future: "retained" } })}\n`;
const CODEX = `${JSON.stringify({ type: "session_meta", payload: { id: "codex-1", cwd: "/project", model_provider: "openai" } })}\n${JSON.stringify({ timestamp: "2026-09-14T00:00:00.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "A" }] } })}\n${JSON.stringify({ timestamp: "2026-09-14T00:00:01.000Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "B" }], model: "gpt-test", future: true } })}\n`;

test("every registered adapter exposes the canonical reader contract", () => {
  for (const agentId of ["claude", "codex", "opencode"]) {
    const adapter = getSessionAdapter(agentId);
    assert.equal(adapter.agentId, agentId);
    assert.equal(typeof adapter.toCanonical, "function");
    assert.equal(typeof adapter.fromCanonical, "function");
  }
});

test("Claude JSONL normalizes ordered messages and keeps unknown native fields", () => {
  const result = getSessionAdapter("claude").toCanonical(CLAUDE, { nativeSessionId: "claude-1" });
  assert.equal(result.nativeSessionId, "claude-1");
  assert.deepEqual(result.events.map((event) => event.content[0].text), ["A", "B"]);
  assert.equal(result.events[1].model, "claude-test");
  assert.equal(result.events[1].extensions.claude.message.future, "retained");
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
    await writeFile(codexFile, CODEX);

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

test("Claude discovery reports a missing configured session root instead of silently returning zero", async () => {
  const root = await (await import("node:fs/promises")).mkdtemp(path.join(os.tmpdir(), "avenic-claude-empty-"));
  try {
    const result = await getSessionAdapter("claude").capture(path.join(root, "project"), {
      environment: { CLAUDE_CONFIG_DIR: path.join(root, "missing-config") },
    });
    assert.equal(result.count, 0);
    assert.match(result.diagnostics[0], /session root not found/i);
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
    assert.match(result.diagnostics[0], /session root not found/i);
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

test("OpenCode projection gives untitled canonical sessions an official string title", () => {
  const projected = getSessionAdapter("opencode").fromCanonical([], { canonicalSessionId: "untitled" });
  assert.equal(projected.data.info.title, "Avenic session untitled");
});
