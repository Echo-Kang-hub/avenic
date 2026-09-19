import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  appendCanonicalEvents,
  completeCanonicalContinuation,
  createCanonicalSession,
  readTranscript,
  transcriptSummary,
  transcriptTurns,
  turnPreview,
} from "../packages/core/src/index.mjs";

// The viewer exists so that a user can read the one conversation their agents
// share. These tests are about the reading, and about the promise that nothing
// in it is silently attributed to the wrong speaker.

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(packageRoot, "packages", "cli", "scripts", "skills.mjs");

function runAgent(cwd, argumentsList) {
  return spawnSync(process.execPath, [cli, ...argumentsList], { cwd, encoding: "utf8", windowsHide: true, env: { ...process.env, NO_COLOR: "1" } });
}

async function withProject(run) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "avenic-transcript-"));
  try {
    await run(projectRoot);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
}

const event = (id, role, text, extra = {}) => ({
  id,
  role,
  createdAt: "2026-09-19T00:00:00.000Z",
  content: [{ type: "text", text }],
  ...extra,
});

// A shared conversation that really did move between agents: the user asked
// Claude, Claude answered and ran a tool, then Codex answered.
async function seedShared(projectRoot) {
  await createCanonicalSession(projectRoot, { id: "shared", title: "Shared" });
  await appendCanonicalEvents(projectRoot, "shared", [
    event("claude:native-1:u1", "user", "why is the parser slow?"),
    event("claude:native-1:a1", "assistant", "It rescans the file per token.", {
      model: "claude-sonnet-5",
      content: [
        { type: "text", text: "It rescans the file per token." },
        { type: "tool_use", name: "Read", input: { file_path: "src/parser.ts" } },
      ],
    }),
    event("claude:native-1:t1", "tool", "", { content: [{ type: "tool_result", content: "export function parse() {}" }] }),
    event("codex:native-2:a2", "assistant", "I cached the token stream; it is fast now.", { model: "gpt-5" }),
  ]);
  return "shared";
}

test("turns keep who said what, and tool traffic belongs to the turn that ran it", async () => {
  await withProject(async (projectRoot) => {
    const id = await seedShared(projectRoot);
    const { summary, turns } = await readTranscript(projectRoot, id);

    assert.deepEqual(turns.map((turn) => turn.speaker), ["You", "Claude", "Codex"]);
    assert.deepEqual(turns.map((turn) => turn.kind), ["user", "agent", "agent"]);
    // Provenance is the point of a shared transcript: the second answer is
    // Codex's, and a viewer must be able to say so.
    assert.deepEqual(turns.map((turn) => turn.agent), ["claude", "claude", "codex"]);
    // Tool traffic is attached to the turn that ran it, in the order it
    // happened, and is not shown as a speaker of its own.
    assert.deepEqual(turns[1].tools.map((tool) => [tool.kind, tool.name]), [["call", "Read"], ["result", "result"]]);
    assert.deepEqual(turns[1].tools.map((tool) => tool.detail), ["src/parser.ts", "export function parse() {}"]);
    assert.equal(turns[1].text, "It rescans the file per token.");
    assert.equal(turns[1].model, "claude-sonnet-5");

    assert.equal(summary.turns, 3);
    assert.equal(summary.events, 4);
    assert.equal(summary.userTurns, 1);
    assert.deepEqual(summary.agents, ["claude", "codex"]);
    assert.equal(summary.lastEventId, "codex:native-2:a2");
  });
});

test("a tool result filed under the API's user role is the agent's, not the person's", async () => {
  await withProject(async (projectRoot) => {
    // Claude's own transcript files a tool result under role "user" — that is
    // the request shape it came back in, not a claim that the user ran it. A
    // viewer that reads the role as the speaker shows the user running Claude's
    // tools, which is the one reading this page exists to get right.
    await createCanonicalSession(projectRoot, { id: "api-shape", title: "Shared" });
    await appendCanonicalEvents(projectRoot, "api-shape", [
      event("claude:native-9:u1", "user", "why is the parser slow?"),
      event("claude:native-9:t1", "user", "", { content: [{ type: "tool_result", content: "export function parse() {}" }] }),
      event("claude:native-9:a1", "assistant", "It rescans the file per token."),
    ]);
    const { summary, turns } = await readTranscript(projectRoot, "api-shape");
    assert.deepEqual(turns.map((turn) => turn.speaker), ["You", "Claude", "Claude"]);
    assert.deepEqual(turns.map((turn) => turn.kind), ["user", "agent", "agent"]);
    assert.equal(summary.userTurns, 1, "only the person's own turn counts as theirs");
    assert.equal(turns[1].tools[0].detail, "export function parse() {}", "the tool traffic is still shown, under its own agent");
  });
});

test("a mapping's cursor state is described, not guessed", async () => {
  await withProject(async (projectRoot) => {
    const id = await seedShared(projectRoot);
    await completeCanonicalContinuation(projectRoot, id, "codex", { nativeSessionId: "native-2" });
    const { summary } = await readTranscript(projectRoot, id);
    const codex = summary.projections.find((projection) => projection.agentId === "codex");
    assert.equal(codex.nativeSessionId, "native-2");
    assert.equal(codex.state, "current", "the mapped session was brought up to the last canonical event");
    assert.equal(summary.projections.some((projection) => projection.agentId === "claude"), false);
  });
});

test("summary alone does not require reading turns twice", () => {
  const events = [event("claude:n:1", "user", "hi"), event("codex:n2:2", "assistant", "hello")];
  const summary = transcriptSummary({ id: "s", title: "S" }, events, { mappings: { projections: {} } });
  assert.equal(summary.turns, 2);
  assert.equal(turnPreview(transcriptTurns(events)[1]), "Codex: hello");
});

test("`avenic sessions show` prints the conversation in order, with provenance", async () => {
  await withProject(async (projectRoot) => {
    const id = await seedShared(projectRoot);
    const result = runAgent(projectRoot, ["sessions", "show", id]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /◆ {2}Session Shared/);
    assert.match(result.stdout, /◇ {2}Conversation/);
    // Read the timeline only: the header lists the participants too, and that
    // list is not a transcript.
    const [, timeline] = result.stdout.split("◇  Conversation");
    assert.ok(timeline, `the viewer must draw the conversation:\n${result.stdout}`);
    const order = ["You", "Claude", "Codex"].map((speaker) => timeline.indexOf(speaker));
    assert.ok(order.every((index) => index >= 0), `every speaker must appear:\n${timeline}`);
    assert.deepEqual([...order].sort((left, right) => left - right), order, "the timeline keeps its order");
    assert.match(timeline, /why is the parser slow\?/);
    assert.match(timeline, /src\/parser\.ts/, "the tool the turn ran is shown with it");
    assert.match(timeline, /Codex {2}\d\d:\d\d/, "each turn is stamped and attributed");
  });
});

test("`avenic sessions show --json` is the model, with no terminal codes", async () => {
  await withProject(async (projectRoot) => {
    const id = await seedShared(projectRoot);
    const result = runAgent(projectRoot, ["sessions", "show", id, "--json"]);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /\x1b\[/, "--json must stay machine-readable");
    const model = JSON.parse(result.stdout);
    assert.equal(model.session.id, id);
    assert.deepEqual(model.turns.map((turn) => turn.speaker), ["You", "Claude", "Codex"]);
    assert.deepEqual(model.turns.map((turn) => turn.agent), ["claude", "claude", "codex"]);
    assert.equal(model.turns[1].tools[0].detail, "src/parser.ts");
  });
});

test("`avenic sessions show --limit` keeps the newest turns and says how many were hidden", async () => {
  await withProject(async (projectRoot) => {
    const id = await seedShared(projectRoot);
    const result = runAgent(projectRoot, ["sessions", "show", id, "--limit", "2"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1 earlier turn\(s\) not shown/);
    assert.doesNotMatch(result.stdout, /why is the parser slow\?/);
    assert.match(result.stdout, /cached the token stream/);
  });
});

test("a session that does not exist is an error, not an empty transcript", async () => {
  await withProject(async (projectRoot) => {
    const missing = runAgent(projectRoot, ["sessions", "show", "nope"]);
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /Unknown canonical session: nope/);

    const usage = runAgent(projectRoot, ["sessions", "show"]);
    assert.equal(usage.status, 1);
    assert.match(usage.stderr, /Usage: avenic sessions show <id>/);

    const unknown = runAgent(projectRoot, ["sessions", "show", "nope", "--verbose"]);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /Unknown option for avenic sessions show: --verbose/);
  });
});
