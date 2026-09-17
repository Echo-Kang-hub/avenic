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

At launch, Avenic imports the source native session into canonical storage, projects canonical history to the selected target when that target has a verified resumable writer, then launches the agent. At exit it imports the target native delta. Existing native snapshot/restore/lease/watchdog remains responsible for project-mode storage isolation.

The active canonical session pointer is project-scoped. `avenic claude`,
`avenic codex`, `avenic opencode`, and `avenic sessions continue` use the same
continuation path when project sessions are enabled. Authentication scope and
session scope are independent, giving all four combinations (global/project
auth x global/project sessions) without copying credentials or moving sessions.

Events are append-oriented. When two projections append from the same parent, both events are retained as sibling branches. The store emits a conflict diagnostic and never uses silent last-write-wins. A later implementation may offer branch selection; it must not overwrite either branch.

## Rehydration handoff

`buildHandoff()` is a versioned, deterministic core-only builder. It derives a compact state checkpoint (goal, current task, completed work, pending work, decisions, relevant files, blockers, warnings and provenance) and a transcript delta after the target mapping's last canonical event. The handoff hash covers the target, checkpoint and delta. It is deliberately an L3a semantic context layer, not a native transcript writer: adapters submit it through documented agent prompt APIs only after their bootstrap/resume path has been verified. A target with a stale cursor resumes its existing native session and receives only the delta; bootstrap is reserved for missing or failed native sessions.

## Native formats and capability policy

- **Claude Code:** project JSONL at `~/.claude/projects/<encoded-cwd>/`; currently an undocumented/version-sensitive persistence format. Avenic uses official `--resume <session-id>` plus an explicit prompt for L3a and does not write Claude's private JSONL.
- **Codex:** rollout JSONL under `~/.codex/sessions/` plus `session_index.jsonl`; `session_meta` carries id/cwd and transcripts contain response/event records. Native writing requires index/projection consistency and a real resume oracle.
- **Codex 0.150.1 app-server research:** generated official protocol schema exposes `thread/start`, `thread/resume`, `thread/fork`, persisted history reads and an operation to append raw Responses API items to model-visible history without starting a user turn. The CLI protocol is marked experimental and has not yet been isolated-smoke-tested by Avenic, so no L3b claim is made.
- **OpenCode 1.18.30:** Avenic uses official top-level `session list --format json`, `export <id>`, `import <file>`, and `run --session <id>`. The writer emits the version's validated export envelope; it does not write OpenCode's private database. Every projected text part carries `_avenic` provenance in official part metadata so re-capture retains canonical event identity. The isolated integration smoke proves `A/B → import → run --session → C/D → export → canonical`, including repeat import/capture idempotency. This is L3 for a single OpenCode projection; it is not yet L4 cross-agent sync.

Capability levels are documented from tests rather than inferred: L1 readable, L2 native import, L3 resumable, L4 bidirectional sync. Private/signed reasoning is never fabricated or transported.

## References

- [OpenAI Codex transcript discussion](https://github.com/openai/codex/discussions/12668)
- [OpenCode session SDK](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/sdk.mdx)
- [session-migrate format research and resume testing](https://github.com/xhluca/session-migrate)
