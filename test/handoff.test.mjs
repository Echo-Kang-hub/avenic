import assert from "node:assert/strict";
import test from "node:test";
import { buildHandoff } from "../packages/core/src/runtime/handoff.mjs";

const session = {
  id: "shared-1",
  project: { cwd: "C:/project" },
  provenance: { source: "claude" },
};
const events = [
  { id: "a", role: "user", createdAt: "2026-09-14T00:00:00.000Z", content: [{ type: "text", text: "Goal: fix parser" }] },
  { id: "b", role: "assistant", createdAt: "2026-09-14T00:01:00.000Z", content: [{ type: "text", text: "Completed lexer." }] },
  { id: "c", role: "user", createdAt: "2026-09-14T00:02:00.000Z", content: [{ type: "text", text: "Next: add tests" }] },
];

test("handoff is deterministic and sends only the target delta", () => {
  const first = buildHandoff({ session, events, targetAgent: "codex", lastCanonicalEventId: "a" });
  const second = buildHandoff({ session, events, targetAgent: "codex", lastCanonicalEventId: "a" });
  assert.equal(first.hash, second.hash);
  assert.deepEqual(first.delta.map((event) => event.id), ["b", "c"]);
  assert.match(first.markdown, /Completed lexer/);
  assert.doesNotMatch(first.markdown, /- user: Goal: fix parser/);
  assert.equal(first.state.goal, "Goal: fix parser");
  assert.equal(first.lastCanonicalEventId, "c");
});
