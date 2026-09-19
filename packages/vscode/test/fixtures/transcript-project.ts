import {
  appendCanonicalEvents,
  completeCanonicalContinuation,
  createCanonicalSession,
  setActiveCanonicalSession,
} from "@avenic/core";
import type { CanonicalEvent } from "@avenic/core";

// A shared conversation that really did move between agents, written through the
// same core calls a launch uses, so the viewer tests read a store core wrote
// rather than a hand-made file layout.
//
// Everything in it is invented: ids, titles, text and paths. No real session
// data, no credentials.

export const SHARED_ID = "handoff";
export const OLDER_ID = "archive";

function block(text: string): { type: string; text: string } {
  return { type: "text", text };
}

function event(id: string, role: CanonicalEvent["role"], createdAt: string, content: CanonicalEvent["content"], extra: Record<string, unknown> = {}): CanonicalEvent {
  return { id, role, createdAt, content, ...extra };
}

/**
 * The person asked, Claude answered and ran one tool, then the conversation was
 * handed to Codex and Codex answered.
 *
 * The mapping order is the point: Claude's cursor is completed before Codex's
 * turn is appended, so the store ends with one cursor `current` (Codex) and one
 * `stale` (Claude) — the states core derives, not states the test declares.
 */
export async function seedTranscriptProject(projectRoot: string): Promise<void> {
  await createCanonicalSession(projectRoot, { id: SHARED_ID, title: "Nightly export" });
  await createCanonicalSession(projectRoot, { id: OLDER_ID, title: "Report cleanup" });
  await setActiveCanonicalSession(projectRoot, SHARED_ID);
  await appendCanonicalEvents(projectRoot, SHARED_ID, [
    event("claude:session-a:1", "user", "2026-09-19T09:00:00.000Z", [block("the nightly export takes two hours now — where is it spending the time?")]),
    event("claude:session-a:2", "assistant", "2026-09-19T09:01:00.000Z", [
      block("It re-reads the whole ledger once per account."),
      { type: "tool_use", name: "Read", input: { file_path: "src/exporter.ts" } },
    ], { model: "claude-sonnet-5" }),
    event("claude:session-a:3", "tool", "2026-09-19T09:01:30.000Z", [
      { type: "tool_result", content: "exportLedger(accounts): reads ledger.tsv per account" },
    ]),
  ]);
  await completeCanonicalContinuation(projectRoot, SHARED_ID, "claude", { nativeSessionId: "session-a" });
  await appendCanonicalEvents(projectRoot, SHARED_ID, [
    event("codex:session-b:1", "assistant", "2026-09-19T09:05:00.000Z", [
      block("Indexed the ledger once before the loop; the same export now finishes in four minutes."),
    ], { model: "gpt-5-codex" }),
  ]);
  await completeCanonicalContinuation(projectRoot, SHARED_ID, "codex", { nativeSessionId: "session-b" });
}
