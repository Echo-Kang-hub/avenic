# Avenic session interoperability

## Purpose

The canonical store is Avenic's portable conversation layer. Native files remain agent-owned projections; Avenic never treats one agent's private on-disk format as another agent's format.

Canonical storage is the durable source of truth. Native Claude, Codex, and
OpenCode sessions are resumable projections/cache. Every project-session launch
reconciles all mapped native projections before selecting a target, so an abrupt
terminal or VS Code exit is recovered on the next launch. A missing projection
causes a safe rehydrate from canonical history; it never erases canonical events
or deletes the old native files.

## Store

Project mode uses `.agents/sessions/canonical/<id>/`:

- `session.json`: schema version, canonical id, project, title, timestamps, metadata and provenance.
- `events.jsonl`: append-only canonical event DAG.
- `state.json`: deterministic lightweight checkpoint for goal, current task,
  completed/pending work, decisions, files, blockers, and warnings.
- `mappings.json`: native identities, revision hashes, projection hashes and sync timestamps.
- `handoff.json` / `handoff.md`: the latest versioned, hashed target handoff;
  it contains only the target delta plus the compact checkpoint.
- `attachments/`: optional content-addressed files with validated relative names.

Legacy `.agents/sessions/{claude,codex,opencode}` remains unchanged and is retained as the native projection/cache layer.

## Canonical event rules

Each event has a stable id, role, typed content blocks, created timestamp, optional parent id, model/provider information, provenance, and `extensions` for native-only data. Block types include text, image, file, tool_call, tool_result, reasoning_summary, and native_extension. An adapter must preserve unmapped fields under `extensions.<agent>` or emit a diagnostic; it must not silently discard them.

Canonical identity is independent of native identity. `mappings.json` maps canonical id to every native id with source/native/canonical hashes and sync timestamps. Import uses native id plus normalized source revision; event identity uses native event id when present, otherwise a deterministic content hash. Re-importing a native session therefore does not create another session or another message.

## Security

Native input is data, never executable code. Canonical persistence removes credential-like fields (`api key`, token, authorization, cookie, secret, and environment credential fields), rejects malformed records, and validates all attachment paths as relative paths beneath `attachments/`. Auth, hooks, policies and runtime configuration are deliberately outside the canonical format.

## Sync and conflict model

A plain launch is the agent's own run: `avenic <agent>` hands the official CLI
exactly the arguments the user typed and nothing else, so it opens a new
conversation every time — whatever the project's history mode, and whatever any
mapping happens to record. Shared history says what the project *can* do, never
what a launch must do. The conversation a run produced is imported into
canonical storage at exit; nothing is projected or resumed on the way in.
Existing native snapshot/restore/lease/watchdog remains responsible for
project-mode storage isolation.

Continuing is explicit and only explicit: `avenic sessions continue <canonical-id>
--agent <agent>`, the continuation entry in the sessions menu, or the agent's own
`/resume`. That is the path that projects shared history into the target agent's
native storage, and it does so only where the target has a verified resumable
writer — resuming the mapped native session when the project can still produce
it, and bootstrapping with a handoff when it cannot. A mapping whose session the
project no longer holds is repaired there rather than resumed. Authentication
scope and session scope are independent, giving all four combinations
(global/project auth × global/project sessions) without copying credentials or
moving sessions.

The active canonical session pointer is project-scoped bookkeeping, not a launch
target: it is the conversation `avenic status` reports the project is on, and a
run's exit sets it to the conversation that run produced.

Events are append-oriented. When two projections append from the same parent, both events are retained as sibling branches. The store emits a conflict diagnostic and never uses silent last-write-wins. A later implementation may offer branch selection; it must not overwrite either branch.

## Rehydration handoff

`buildHandoff()` is a versioned, deterministic core-only builder. It derives a compact state checkpoint (goal, current task, completed work, pending work, decisions, relevant files, blockers, warnings and provenance) and a transcript delta after the target mapping's last canonical event. The handoff hash covers the target, checkpoint and delta. It is deliberately an L3a semantic context layer, not a native transcript writer: adapters submit it through documented agent prompt APIs only after their bootstrap/resume path has been verified. A target with a stale cursor resumes its existing native session and receives only the delta; bootstrap is reserved for missing or failed native sessions.

## Native formats and capability policy

- **Claude Code:** project JSONL at `~/.claude/projects/<encoded-cwd>/`; currently an undocumented/version-sensitive persistence format. Avenic uses official `--resume <session-id>` plus an explicit prompt for L3a and does not write Claude's private JSONL.
- **Codex:** rollout JSONL under `~/.codex/sessions/` plus `session_index.jsonl`; `session_meta` carries id/cwd and transcripts contain response/event records. Native writing requires index/projection consistency and a real resume oracle.
- **Codex 0.150.1 app-server research:** generated official protocol schema exposes `thread/start`, `thread/resume`, `thread/fork`, persisted history reads and an operation to append raw Responses API items to model-visible history without starting a user turn. The CLI protocol is marked experimental and has not yet been isolated-smoke-tested by Avenic, so no L3b claim is made.
- **OpenCode 1.18.30:** Avenic uses official top-level `session list --format json`, `export <id>`, `import <file>`, and `run --session <id>`. The writer emits the version's validated export envelope; it does not write OpenCode's private database. Every projected text part carries `_avenic` provenance in official part metadata so re-capture retains canonical event identity. The isolated integration smoke proves `A/B → import → run --session → C/D → export → canonical`, including repeat import/capture idempotency. This is L3 for a single OpenCode projection; it is not yet L4 cross-agent sync.

Capability levels are documented from tests rather than inferred: L1 readable, L2 native import, L3 resumable, L4 bidirectional sync. Private/signed reasoning is never fabricated or transported.

## Known limitations

- **A switch carries at most 400,000 characters of turn text; the rest is condensed.** `buildProjection` (`packages/core/src/runtime/projection.mjs`) keeps the newest turns up to `NATIVE_BUDGET` and folds everything older into the deterministic checkpoint, which reaches the target as `[condensed]` lines: the count and date range of the events, the original request, the most recent requests, and the tool-call count — not the turns themselves. Measured through the core the installed CLI ships, on a synthetic 60-turn conversation of 867,580 characters: 27 turns and 396,387 characters were carried verbatim, 33 events were condensed. Within the budget the projection is exact — including the delta a mapping cuts, which is normally far under it — and the budget never triggers a model call, so the same history always projects to the same hash. The limitation is what condensation costs: a target switched into a conversation whose delta alone exceeds the budget reads a summary of the older part instead of its words.
  Recorded 2026-09-19 during the 1.8.1 distribution acceptance as next-version work, not a 1.8.1 blocker: reaching the limit needs a single delta of that size, which no verification run on the published artifacts produced. The next version decides whether to page the projection (several appends), raise the budget per agent, or leave the condensation and state it in the launch notice.

## References

- [OpenAI Codex transcript discussion](https://github.com/openai/codex/discussions/12668)
- [OpenCode session SDK](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/sdk.mdx)
- [session-migrate format research and resume testing](https://github.com/xhluca/session-migrate)
