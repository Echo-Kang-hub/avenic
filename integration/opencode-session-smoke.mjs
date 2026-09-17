import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  appendCanonicalEvents,
  captureCanonicalSession,
  createCanonicalSession,
  projectCanonicalSession,
  readCanonicalSession,
} from "../packages/core/src/index.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "avenic-opencode-smoke-"));
const project = path.join(root, "project");
// Keep the user's existing OpenCode provider/auth runtime intact. Only the
// temporary project and its Avenic session store are isolated.
const environment = process.env;

async function resolveOpenCodeExecutable() {
  if (process.platform !== "win32") return "opencode";
  const pathEntries = (environment.Path ?? environment.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const directory of pathEntries) {
    for (const candidate of ["opencode.exe", "opencode.ps1", "opencode.cmd"]) {
      const file = path.join(directory, candidate);
      if (!existsSync(file)) continue;
      if (candidate.endsWith(".exe")) return file;
      if (candidate.endsWith(".cmd")) continue;
      const script = await readFile(file, "utf8");
      if (/\$basedir\/node_modules\/opencode-ai\/bin\/opencode\.exe/i.test(script)) {
        const direct = path.join(directory, "node_modules", "opencode-ai", "bin", "opencode.exe");
        if (existsSync(direct)) return direct;
      }
    }
  }
  return "opencode";
}

const openCodeExecutable = await resolveOpenCodeExecutable();
const runTimeoutMs = Number(process.env.OPENCODE_SMOKE_TIMEOUT_MS ?? 180000);

function run(argumentsList) {
  const result = spawnSync(openCodeExecutable, argumentsList, { cwd: project, env: environment, encoding: "utf8", windowsHide: true, timeout: runTimeoutMs });
  if (result.error?.code === "ETIMEDOUT") throw new Error(`OpenCode timed out after ${runTimeoutMs}ms: ${result.error.message}`);
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

function availableFreeModels() {
  const output = run(["models", "--pure", "--log-level", "ERROR"]);
  return output.split(/\r?\n/).map((line) => line.trim())
    .filter((line) => line.includes("/") && /-free$/.test(line));
}

function resumeWithCapabilityProbe(nativeSessionId) {
  const freeModels = availableFreeModels();
  // The default runtime was capability-probed separately and currently
  // retries indefinitely on a rate-limited model. Prefer a currently listed
  // low-latency free candidate for this bounded smoke; no model is persisted.
  const candidates = [
    // Prefer the currently advertised low-latency free tier.  The model
    // name is discovered from `opencode models`; nothing is persisted or
    // hard-coded in the runtime.
    ...freeModels.filter((model) => /lightning/i.test(model)),
    ...freeModels.filter((model) => /flash/i.test(model) && !/lightning/i.test(model)),
    ...freeModels.filter((model) => !/lightning|flash/i.test(model)),
  ];
  const failures = [];
  for (const model of candidates) {
    const args = ["run", "--session", nativeSessionId, "--format", "json"];
    if (model) args.push("--model", model);
    args.push("C");
    try {
      run(args);
      return model ?? "OpenCode default model";
    } catch (error) {
    failures.push(`${model}: ${error.message}`);
    }
  }
  throw new Error(`No currently available OpenCode model completed a call (${failures.join("; ")})`);
}

function resumeSameSession(nativeSessionId, model) {
  const args = ["run", "--session", nativeSessionId, "--format", "json"];
  if (model && model !== "OpenCode default model") args.push("--model", model);
  args.push("E");
  run(args);
}

try {
  await mkdir(project, { recursive: true });
  const canonicalId = `smoke-${randomUUID().slice(0, 8)}`;
  await createCanonicalSession(project, { id: canonicalId, source: "claude", title: "Avenic smoke" });
  await appendCanonicalEvents(project, canonicalId, [
    { id: "a", role: "user", createdAt: "2026-09-14T00:00:00.000Z", content: [{ type: "text", text: "A" }] },
    { id: "b", role: "assistant", parentId: "a", createdAt: "2026-09-14T00:00:01.000Z", content: [{ type: "text", text: "B" }] },
  ]);

  const firstProjection = await projectCanonicalSession(project, canonicalId, "opencode", { environment });
  console.log(`stage=projection imported=${firstProjection.imported} native=${firstProjection.nativeSessionId}`);
  assert.equal(firstProjection.imported, true);
  const secondProjection = await projectCanonicalSession(project, canonicalId, "opencode", { environment });
  assert.equal(secondProjection.imported, false, "a second projection must not create a native duplicate");
  const beforeResume = await readCanonicalSession(project, canonicalId);
  const nativeSessionId = beforeResume.mappings.projections.opencode.nativeSessionId;
  assert.equal(nativeSessionId, firstProjection.nativeSessionId);

  const listed = JSON.parse(run(["session", "list", "--format", "json"]));
  console.log(`stage=session-list count=${listed.length}`);
  assert.equal(listed.filter((entry) => entry.id === nativeSessionId).length, 1, "official list must expose exactly one mapped native session");
  const exported = JSON.parse(run(["export", nativeSessionId]));
  console.log(`stage=export messages=${exported.messages.length}`);
  assert.deepEqual(exported.messages.map((message) => message.info.role), ["user", "assistant"]);
  assert.deepEqual(exported.messages.map((message) => message.parts[0].text), ["A", "B"]);

  const selectedModel = resumeWithCapabilityProbe(nativeSessionId);
  console.log(`stage=resume complete model=${selectedModel}`);
  const captured = await captureCanonicalSession(project, canonicalId, "opencode", { environment });
  assert.equal(captured.added, 2, "resume must append the OpenCode user and assistant messages once");
  const afterCapture = await readCanonicalSession(project, canonicalId);
  assert.deepEqual(afterCapture.events.map((event) => event.role), ["user", "assistant", "user", "assistant"]);
  assert.deepEqual(afterCapture.events.slice(0, 3).map((event) => event.content[0]?.text), ["A", "B", "C"]);
  const response = afterCapture.events.at(-1).content.filter((part) => part.type === "text").map((part) => part.text).join("");
  assert.ok(response.trim(), "actual resumed OpenCode assistant response must be captured");
  resumeSameSession(nativeSessionId, selectedModel);
  const secondCapture = await captureCanonicalSession(project, canonicalId, "opencode", { environment });
  assert.equal(secondCapture.added, 2, "the same OpenCode native session must continue without a new id");
  assert.equal(secondCapture.nativeSessionId, nativeSessionId);
  const repeatedCapture = await captureCanonicalSession(project, canonicalId, "opencode", { environment });
  assert.equal(repeatedCapture.added, 0);
  assert.equal(repeatedCapture.duplicate, 6);
  assert.equal(repeatedCapture.nativeSessionId, nativeSessionId);
  console.log(`OpenCode canonical/import/resume/capture smoke passed: ${nativeSessionId}; assistant=${JSON.stringify(response)}`);
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 750 });
}
