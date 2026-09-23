import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { connect } from "node:net";
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
// makes three things Avenic's business that are nobody else's: the name the
// session is created under, the model it will run on, and what to do when it
// cannot run at all.

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

test("a first OpenCode projection is named by OpenCode, not by Avenic", async () => {
  // OpenCode's provider console decodes the id it is handed: a session named by
  // Avenic is refused when the user runs it ("OpenCode's free tier can only be
  // used from within OpenCode"), while one OpenCode minted runs. So the first
  // projection asks OpenCode for the name — through the one surface that creates
  // a session without a model call — and every later projection keeps it.
  await withOpenCodeProject(async ({ projectRoot, environment, invocations }) => {
    await createCanonicalSession(projectRoot, { id: "shared", title: "Shared" });
    await appendCanonicalEvents(projectRoot, "shared", [event("a", "user", "A"), event("b", "assistant", "B")]);

    await projectCanonicalSession(projectRoot, "shared", "opencode", { environment });

    const projection = JSON.parse(await readFile(projectionFile(projectRoot, "shared"), "utf8"));
    assert.equal(projection.info.id, "ses_minted_1");
    // The name is the one a continuation launches: what the user's next
    // `opencode --session` carries.
    const stored = await readCanonicalSession(projectRoot, "shared");
    assert.equal(stored.mappings.projections.opencode.nativeSessionId, "ses_minted_1");
    const calls = await invocations();
    assert.ok(calls.some((line) => /^serve --port \d+$/.test(line)), `a server must be asked for the name, saw ${JSON.stringify(calls)}`);
  });
});

test("the session OpenCode mints for a projection is named after the shared session", async () => {
  // `opencode import` writes a payload's title into a session it creates, and
  // by the time the projection imports, the session exists — so the name has to
  // be given at the mint, or the user's OpenCode list shows "New session -
  // <timestamp>". The real CLI takes a title in POST /session and a later
  // import leaves it alone.
  await withOpenCodeProject(async ({ projectRoot, environment, mintedSessions }) => {
    await createCanonicalSession(projectRoot, { id: "shared", title: "Shared across agents" });
    await appendCanonicalEvents(projectRoot, "shared", [event("a", "user", "A")]);

    await projectCanonicalSession(projectRoot, "shared", "opencode", { environment });

    assert.deepEqual(await mintedSessions(), [{ id: "ses_minted_1", title: "Shared across agents" }]);
  });
});

test("the OpenCode server Avenic starts to name a session does not outlive the projection", async () => {
  // A server left behind holds its port and a lock on the store; a projection
  // is not a daemon. The check is the socket, not a process call: whoever is
  // listening there afterwards is a server nobody is going to stop.
  await withOpenCodeProject(async ({ projectRoot, environment, invocations }) => {
    await createCanonicalSession(projectRoot, { id: "shared", title: "Shared" });
    await appendCanonicalEvents(projectRoot, "shared", [event("a", "user", "A")]);

    await projectCanonicalSession(projectRoot, "shared", "opencode", { environment });

    const call = (await invocations()).find((line) => line.startsWith("serve --port "));
    assert.ok(call, "the projection must ask a server for the name");
    const port = Number(call.split(" ").pop());
    const reachable = await new Promise((resolve) => {
      const socket = connect({ port, host: "127.0.0.1" });
      socket.on("connect", () => { socket.destroy(); resolve(true); });
      socket.on("error", () => resolve(false));
    });
    assert.equal(reachable, false, "the server started for one projection must be stopped with it");
  });
});

test("a projection whose mapping is gone keeps the name OpenCode gave the session", async () => {
  // The mapping is what carries a native id forward, and it can be lost on its
  // own. Losing it must not manufacture a second conversation in OpenCode: the
  // projection Avenic already wrote names the session, so a session is only
  // ever asked to be named once.
  await withOpenCodeProject(async ({ projectRoot, environment, invocations }) => {
    await createCanonicalSession(projectRoot, { id: "shared", title: "Shared" });
    await appendCanonicalEvents(projectRoot, "shared", [event("a", "user", "A")]);
    const adapter = getSessionAdapter("opencode");

    const first = await projectCanonicalSession(projectRoot, "shared", "opencode", { environment });
    assert.equal(first.nativeSessionId, "ses_minted_1");
    const stored = await readCanonicalSession(projectRoot, "shared");
    const again = await adapter.writeCanonical(projectRoot, { id: "shared", title: stored.session.title, events: stored.events }, { environment });

    assert.equal(again.nativeSessionId, "ses_minted_1");
    const serves = (await invocations()).filter((line) => line.startsWith("serve "));
    assert.equal(serves.length, 1, "only a session with no name of its own needs to be named");
  });
});

test("an OpenCode build that cannot name a session still projects one", async () => {
  // The name is asked for, not required: a build without a server API has to
  // keep working, under an id derived from the session. What must not happen is
  // silence — the projection says which name it used and why.
  await withOpenCodeProject(async ({ projectRoot, environment, failServe }) => {
    await failServe();
    await createCanonicalSession(projectRoot, { id: "shared", title: "Shared" });
    await appendCanonicalEvents(projectRoot, "shared", [event("a", "user", "A")]);

    const result = await projectCanonicalSession(projectRoot, "shared", "opencode", { environment });

    const projection = JSON.parse(await readFile(projectionFile(projectRoot, "shared"), "utf8"));
    assert.match(projection.info.id, /^ses_[0-9a-f]{24}$/);
    assert.equal(result.nativeSessionId, projection.info.id);
    assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === "derived_session_id"), `expected the derived name to be reported, saw ${JSON.stringify(result.diagnostics)}`);
  });
});

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

test("a continuation started from a subdirectory runs OpenCode in the project, and says so", async () => {
  // The project root is found by walking up from where the person stands, so
  // running `avenic sessions continue` from a subdirectory asks for an agent in
  // the project while the shell is somewhere below it. The agent has to be told
  // the directory it is really started in: OpenCode reads PWD as its project,
  // and with the two disagreeing a projected session answered and then never
  // exited (the 2x2 in dist/logs/opencode-pwd-matrix.txt).
  await withOpenCodeProject(async ({ projectRoot, runCli, runContexts }) => {
    await initializeAgent(projectRoot, "opencode", { sessionScope: "global" });
    await setHistoryMode(projectRoot, "shared");
    await createCanonicalSession(projectRoot, { id: "shared", title: "Shared" });
    await appendCanonicalEvents(projectRoot, "shared", [event("a", "user", "A")]);
    const sub = path.join(projectRoot, "sub");
    await mkdir(sub, { recursive: true });

    const result = runCli(["sessions", "continue", "shared", "--agent", "opencode"], {}, { cwd: sub });
    assert.equal(result.status, 0, result.stderr);

    const contexts = await runContexts();
    const interactive = contexts.find((entry) => entry.argv.startsWith("--session "));
    assert.ok(interactive, `the continuation must reach the official CLI, saw ${JSON.stringify(contexts.map((entry) => entry.argv))}`);
    assert.deepEqual(
      { cwd: interactive.cwd, pwd: interactive.pwd },
      { cwd: projectRoot, pwd: projectRoot },
      "OpenCode must be started in the project and told the same directory",
    );
  });
});
