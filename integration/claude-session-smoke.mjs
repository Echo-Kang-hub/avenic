import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { toCanonical } from "../packages/core/src/runtime/adapters/claude.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "avenic-claude-smoke-"));
const project = path.join(root, "project");
const sessionId = "22222222-2222-4222-8222-222222222222";
const env = { ...process.env, HOME: root, CLAUDE_CONFIG_DIR: path.join(root, "claude") };
function run(args) {
  const result = spawnSync("claude", args, { cwd: project, env, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}
try {
  await mkdir(project, { recursive: true });
  const first = run(["-p", "--output-format", "json", "--session-id", sessionId, "Remember shared history A/B. Reply with exactly B."]);
  assert.equal(first.session_id, sessionId);
  assert.equal(first.result, "B");
  const second = run(["-p", "--output-format", "json", "--resume", sessionId, "Shared session delta: C. Reply with exactly D."]);
  assert.equal(second.session_id, sessionId);
  assert.equal(second.result, "D");
  const files = await readdir(path.join(env.CLAUDE_CONFIG_DIR, "projects"), { recursive: true });
  const jsonl = files.find((file) => file.endsWith(`${sessionId}.jsonl`));
  assert.ok(jsonl, "Claude must persist the resumed native session");
  // `readdir` already hands back the path of the record relative to `projects`
  // (`<munged cwd>/<session>.jsonl`); joining another directory onto it doubled
  // the first segment and read a path Claude never wrote.
  const content = await readFile(path.join(env.CLAUDE_CONFIG_DIR, "projects", jsonl), "utf8");
  const canonical = toCanonical(content, { nativeSessionId: sessionId });
  assert.ok(canonical.events.some((event) => event.content.some((part) => part.text === "D")));
  console.log(`Claude bootstrap/resume/capture smoke passed: ${sessionId}`);
} finally { await rm(root, { recursive: true, force: true }); }
