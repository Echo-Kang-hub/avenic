import {
  agentLabel,
  countCanonicalEvents,
  getActiveCanonicalSessionId,
  listCanonicalSessionRecords,
  readCanonicalSession,
  readTranscript,
  transcriptModel,
} from "@avenic/core";
import type { SessionRow, SessionsData } from "./protocol.ts";

// vscode-free data assembly (the plugin test suite has no editor): the page is
// handed the same model `avenic sessions show <id> --json` prints, so reading a
// conversation in VS Code and reading it in a terminal cannot disagree.

// A conversation can outlive any window: a page that renders ten thousand turns
// into the DOM stops being a page. The newest turns are what a reader opens it
// for, and the count of what is missing is shown with a way to ask for all of
// it (`limit: 0`).
export const DEFAULT_TURN_LIMIT = 200;

export interface SessionsOptions {
  id?: string | null;
  limit?: number;
}

export async function buildSessionsData(projectRoot: string | null, options: SessionsOptions = {}): Promise<SessionsData> {
  if (projectRoot === null) {
    return { projectRoot: null, activeId: null, sessions: [], participants: [], transcript: null };
  }
  const [activeId, records] = await Promise.all([
    getActiveCanonicalSessionId(projectRoot),
    listCanonicalSessionRecords(projectRoot),
  ]);
  // Counts come off the record: sizing a conversation by parsing its event log
  // is what made `avenic status` open tens of megabytes on a real project.
  const sessions: SessionRow[] = await Promise.all(records.map(async (record) => ({
    id: record.id,
    title: typeof record.title === "string" && record.title ? record.title : record.id,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : null,
    events: typeof record.eventCount === "number" ? record.eventCount : await countCanonicalEvents(projectRoot, record.id),
  })));
  // The active conversation is the one a reader came for; a selection that no
  // longer exists (the session was removed between two refreshes) falls back to
  // the same choice rather than erroring.
  const selected = [options.id, activeId, sessions[0]?.id]
    .find((candidate) => typeof candidate === "string" && sessions.some((row) => row.id === candidate)) ?? null;
  if (selected === null) {
    return { projectRoot, activeId, sessions, participants: [], transcript: null };
  }
  const stored = await readCanonicalSession(projectRoot, selected);
  const reading = await readTranscript(projectRoot, selected, { record: stored, limit: options.limit ?? DEFAULT_TURN_LIMIT });
  return {
    projectRoot,
    activeId,
    sessions,
    participants: reading.summary.agents.map(agentLabel),
    transcript: transcriptModel(reading),
  };
}
