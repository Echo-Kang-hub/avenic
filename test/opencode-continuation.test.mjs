import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  appendCanonicalEvents,
  createCanonicalSession,
  initializeAgent,
  projectCanonicalSession,
  readCanonicalSession,
  setHistoryMode,
} from "../packages/core/src/index.mjs";
import { getSessionAdapter } from "../packages/core/src/runtime/adapters/index.mjs";
import { withOpenCodeProject } from "./helpers/session-fixture.mjs";

// OpenCode is the one agent whose whole conversation API is its own CLI, so a
// continuation is `opencode import` followed by `opencode --session`. That
// makes two things Avenic's business that are nobody else's: the model the
// projected session will run on, and what to do when it cannot run at all.

const event = (id, role, text, extra = {}) => ({
  id,
  role,
  createdAt: "2026-09-19T00:00:00.000Z",
  content: [{ type: "text", text }],
  ...extra,
});

function projectionFile(projectRoot, canonicalId) {
  return path.join(projectRoot, ".agents", "local", "opencode", "canonical", `${canonicalId}.json`);
}

test("an OpenCode projection runs on the model OpenCode resolved for this environment", async () => {
  await withOpenCodeProject(async ({ projectRoot, environment, setConfiguredModel }) => {
    await setConfiguredModel("opencode/nemotron-3.5-lightning-free");
    await createCanonicalSession(projectRoot, { id: "shared", title: "Shared" });
    await appendCanonicalEvents(projectRoot, "shared", [
      event("a", "user", "written in Claude Code"),
      event("b", "assistant", "answered by Claude", { provider: "anthropic", model: "claude-sonnet-5" }),
      event("c", "assistant", "answered by OpenCode", { provider: "opencode", model: "big-pickle" }),
    ]);

    await projectCanonicalSession(projectRoot, "shared", "opencode", { environment });
    const projection = JSON.parse(await readFile(projectionFile(projectRoot, "shared"), "utf8"));

    // The user's own choice, read from OpenCode rather than assumed by Avenic.
    assert.deepEqual(projection.info.model, { id: "nemotron-3.5-lightning-free", providerID: "opencode", variant: "default" });
    const [fromClaude, fromOpenCode] = projection.messages.filter((message) => message.info.role === "assistant");
    // A Claude message projected into OpenCode must not claim to have been run
    // by anthropic: on a machine without that provider the session the user
    // then reopens is one OpenCode answers with 403.
    assert.equal(fromClaude.info.providerID, "opencode");
    assert.equal(fromClaude.info.modelID, "nemotron-3.5-lightning-free");
    // OpenCode's own message keeps the model that actually produced it.
    assert.equal(fromOpenCode.info.providerID, "opencode");
    assert.equal(fromOpenCode.info.modelID, "big-pickle");
  });
});

test("an OpenCode projection keeps a model the caller selected, foreign or not", async () => {
  // `projectCanonicalSession` may be handed an explicit model (the CLI's
  // `--model`, a caller's own choice). Resolving the target's default must not
  // override a decision that was already made.
  await withOpenCodeProject(async ({ projectRoot, environment, setConfiguredModel }) => {
    await setConfiguredModel("opencode/nemotron-3.5-lightning-free");
    await createCanonicalSession(projectRoot, { id: "shared", title: "Shared" });
    await appendCanonicalEvents(projectRoot, "shared", [
      event("a", "user", "hello"),
      event("b", "assistant", "answered by Claude", { provider: "anthropic", model: "claude-sonnet-5" }),
    ]);

    await projectCanonicalSession(projectRoot, "shared", "opencode", { environment, model: { id: "chosen-model", providerID: "opencode", variant: "default" } });
    const projection = JSON.parse(await readFile(projectionFile(projectRoot, "shared"), "utf8"));
    assert.equal(projection.info.model.id, "chosen-model");
    assert.equal(projection.messages[1].info.modelID, "chosen-model");
  });
});

test("discovery names the session a fresh official launch created", async () => {
  await withOpenCodeProject(async ({ projectRoot, environment, createSession, setNextSessionId, launchAgent }) => {
    await createSession("ses_older", { updated: 1 });
    const adapter = getSessionAdapter("opencode");
    const launchStartedAt = Date.now() - 1000;
    await setNextSessionId("ses_fresh");
    const started = launchAgent(["--prompt", "handoff"]);
    assert.equal(started.status, 0, started.stderr);

    assert.equal(await adapter.discoverNativeSession(projectRoot, { environment, notBefore: launchStartedAt }), "ses_fresh");
    await assert.rejects(
      adapter.discoverNativeSession(projectRoot, { environment, notBefore: Date.now() + 60_000 }),
      /did not create a discoverable native session/,
    );
  });
});

test("an OpenCode session that cannot be started continues in a fresh official session", async () => {
  await withOpenCodeProject(async ({ projectRoot, environment, failProjectedContinue, setNextSessionId, invocations, runCli }) => {
    await initializeAgent(projectRoot, "opencode", { sessionScope: "global" });
    await setHistoryMode(projectRoot, "shared");
    await createCanonicalSession(projectRoot, { id: "shared", title: "Shared" });
    await appendCanonicalEvents(projectRoot, "shared", [
      event("a", "user", "A"),
      event("b", "assistant", "B"),
    ]);
    await failProjectedContinue();
    await setNextSessionId("ses_fresh");

    const result = runCli(["sessions", "continue", "shared", "--agent", "opencode"]);
    assert.equal(result.status, 0, result.stderr);
    // The failure is reported as a warning, so it belongs on stderr — but a
    // user reading either stream must see why their session changed.
    assert.match(`${result.stdout}${result.stderr}`, /could not be started/);

    const calls = await invocations();
    const projected = calls.find((line) => line.startsWith("--session "));
    assert.ok(projected, `a projected session must be tried first, saw ${JSON.stringify(calls)}`);
    const fallback = calls.find((line) => line.startsWith("--prompt "));
    assert.ok(fallback, "the fallback must start a fresh official session with the handoff");
    // The user's own history is what the fresh session is handed.
    assert.match(fallback, /- user: A/);
    assert.match(fallback, /- assistant: B/);

    const stored = await readCanonicalSession(projectRoot, "shared");
    assert.equal(stored.mappings.projections.opencode.nativeSessionId, "ses_fresh");
  });
});

test("a projected OpenCode session that starts is left alone", async () => {
  // The fallback is for a session that cannot run. A session that runs must
  // stay the user's session, with no second launch behind their back.
  await withOpenCodeProject(async ({ projectRoot, environment, invocations, runCli }) => {
    await initializeAgent(projectRoot, "opencode", { sessionScope: "global" });
    await setHistoryMode(projectRoot, "shared");
    await createCanonicalSession(projectRoot, { id: "shared", title: "Shared" });
    await appendCanonicalEvents(projectRoot, "shared", [event("a", "user", "A")]);

    const result = runCli(["sessions", "continue", "shared", "--agent", "opencode"]);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /could not be started/);
    const calls = await invocations();
    assert.ok(calls.some((line) => line.startsWith("--session ")));
    assert.equal(calls.some((line) => line.startsWith("--prompt ")), false, "a session that starts must not be replaced");
  });
});
