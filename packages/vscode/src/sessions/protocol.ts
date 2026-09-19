// The Sessions page renders the same model `avenic sessions show <id> --json`
// prints: core reads the shared store once (`readTranscript`), and both the CLI
// and this page draw that one shape. Nothing here carries colour or terminal
// escapes — the page paints with CSS theme variables, and a reader that only
// wanted the data (a test, a future export) gets exactly what the terminal got.
//
// The turn shape is core's: a turn knows who spoke, whether it was the person
// at the keyboard or one of the agents, and which tool traffic belongs to it.

// The turn, tool and projection shapes are core's, imported rather than
// restated: a second copy of them here is exactly the drift this page exists to
// avoid. `packages/core/index.d.ts` is the authority.
import type { TranscriptSummary, TranscriptTurn } from "@avenic/core";
export type { TranscriptSummary, TranscriptTurn } from "@avenic/core";
export type TranscriptTool = TranscriptTurn["tools"][number];
export type TranscriptProjection = TranscriptSummary["projections"][number];

/** The summary as the CLI's JSON carries it: the schema version moves to the top. */
export type TranscriptSession = Omit<TranscriptSummary, "schemaVersion">;

/** One conversation as data: the CLI's JSON, and the page's input. */
export interface TranscriptModel {
  schemaVersion: number;
  session: TranscriptSession;
  turns: TranscriptTurn[];
}

/** A row of the session list. Counts come from the record, never from reading the log. */
export interface SessionRow {
  id: string;
  title: string;
  updatedAt: string | null;
  events: number;
}

export interface SessionsData {
  projectRoot: string | null;
  // The shared session new launches join (`getActiveCanonicalSessionId`).
  activeId: string | null;
  sessions: SessionRow[];
  // Agent display names of the selected conversation, from core's `agentLabel`.
  participants: string[];
  transcript: TranscriptModel | null;
}

// The webview may ask for a session id and for a turn limit, nothing else: no
// paths, no commands. The host resolves the id against the list it just read.
export type SessionsViewMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "select"; id: string }
  | { type: "limit"; limit: number };

export type SessionsSenderMessage =
  | { type: "data"; payload: SessionsData }
  | { type: "error"; message: string };

export function isSessionsViewMessage(value: unknown): value is SessionsViewMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  if (message.type === "ready" || message.type === "refresh") return true;
  if (message.type === "select") return typeof message.id === "string" && message.id.length > 0;
  if (message.type === "limit") return typeof message.limit === "number" && Number.isFinite(message.limit) && message.limit >= 0;
  return false;
}
