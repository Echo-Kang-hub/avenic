import assert from "node:assert/strict";
import test from "node:test";
import {
  buildProjection,
  projectableEvents,
  projectionItems,
  renderBriefing,
} from "../packages/core/src/index.mjs";
import { NATIVE_BUDGET } from "../packages/core/src/runtime/projection.mjs";

// The projection is what one agent is handed of another agent's work, so two
// things are load-bearing here: who the words belong to, and how much of the
// conversation travels. Both are decided in this module and nowhere else.

const TARGET = "codex";
const session = { id: "shared" };

const event = (id, agent, role, content, createdAt = "2026-09-19T00:00:01.000Z") => ({ id, agent, role, createdAt, content });
const said = (id, agent, role, text, createdAt) => event(id, agent, role, [{ type: "text", text }], createdAt);

test("a tool result is the agent's own machinery, not the user talking", () => {
  // The Anthropic API files a tool's answer under role "user": that is the
  // shape of the request it came back in, not a claim about who spoke. Handing
  // it on as an unlabelled user message puts another agent's tool output in the
  // user's mouth, which is the one thing a shared conversation must not do.
  const events = [
    said("claude:n1:1", "claude", "user", "please run the tests"),
    event("claude:n1:2", "claude", "assistant", [
      { type: "tool_use", name: "Bash", input: { command: "npm test" } },
      { type: "text", text: "Running them now." },
    ]),
    event("claude:n1:3", "claude", "user", [{ type: "tool_result", content: "3 failing tests in session.test.ts" }]),
    said("codex:n9:4", "codex", "assistant", "I will look at them."),
  ];
  const projection = buildProjection({ session, events, targetAgent: TARGET, nativeSessionId: "n2" });

  const briefing = renderBriefing(projection);
  assert.match(briefing, /^User: please run the tests$/m, "the person is still the person");
  assert.match(briefing, /Claude \(tool\): \[tool result: 3 failing tests in session\.test\.ts\]/, "the tool result is Claude's");
  assert.doesNotMatch(briefing, /^User: \[tool result/m, "and never the user's");

  const items = projectionItems(projection);
  const toolItem = items.find((item) => item.content[0].text.includes("tool result"));
  assert.ok(toolItem, "the tool traffic still travels — the next agent needs it to understand the answer");
  assert.equal(toolItem.role, "assistant", "delivered as the agent's turn, not the user's");
  assert.equal(toolItem.content[0].type, "output_text");
  assert.equal(toolItem.content[0].text, "Claude: [tool result: 3 failing tests in session.test.ts]");
  assert.deepEqual(items.map((item) => item.role), ["user", "assistant", "assistant", "assistant"]);

  // A turn that is a tool call *and* an explanation is still the agent speaking,
  // and is labelled as the agent either way.
  assert.equal(items[1].content[0].text, "Claude: [ran Bash npm test]\nRunning them now.");
  // The target's own words are never prefixed with a label of their own.
  assert.equal(items[3].content[0].text, "I will look at them.");
});

test("a projection is the delta after the event the target was already given", () => {
  const events = [
    said("claude:n1:1", "claude", "user", "first"),
    said("claude:n1:2", "claude", "assistant", "second"),
    said("claude:n1:3", "claude", "user", "third"),
    said("claude:n1:4", "claude", "assistant", "fourth"),
  ];
  const projection = buildProjection({ session, events, targetAgent: TARGET, sinceEventId: "claude:n1:2" });
  assert.deepEqual(projection.turns.map((turn) => turn.text), ["third", "fourth"], "what the target already holds does not travel again");
  assert.equal(projection.lastEventId, "claude:n1:4", "the delta still ends at the end of the conversation");

  // The cut is by identity, so a target that is handed a delta still is not sent
  // back its own turns.
  const owned = buildProjection({ session, events, targetAgent: TARGET, nativeSessionId: "n2", sinceEventId: "claude:n1:1" });
  assert.deepEqual(owned.turns.map((turn) => turn.text), ["second", "third", "fourth"]);

  // An id that is no longer in the history is ignored rather than guessed at:
  // re-sending too much costs tokens, sending too little loses the history.
  const unknown = buildProjection({ session, events, targetAgent: TARGET, sinceEventId: "claude:n1:gone" });
  assert.equal(unknown.turns.length, 4);
  assert.deepEqual(projectableEvents(events, { sinceEventId: null }).map((item) => item.id), events.map((item) => item.id));
});

test("the budget bounds the projection, never the turn", () => {
  const long = `START ${"word ".repeat(3_000)}END`;
  const events = [said("claude:n1:1", "claude", "user", "ask"), said("claude:n1:2", "claude", "assistant", long)];
  const projection = buildProjection({ session, events, targetAgent: TARGET, budget: NATIVE_BUDGET });
  assert.equal(projection.turns.length, 2, "a turn that fits the budget arrives whole");
  assert.match(projection.turns[1].text, /END$/, "including its ending");
  assert.equal(projection.checkpoint, null, "and nothing has to be condensed away");
});
