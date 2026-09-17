# Changelog

## 1.4.0 - 2026-09-16

- Added startup recovery for abrupt exits: canonical sessions remain durable,
  native projections are reconciled before launch, and missing projections are
  rehydrated without deleting native history.
- Added historical native-session import, active canonical-session selection,
  and independent global/project Auth and Sessions modes.

- Added unified canonical sessions for Claude Code, Codex, and OpenCode.
- Added Claude → Codex → Claude semantic continuation with incremental shared context.
- Preserved existing agent authentication, provider, cc-switch, and project auth behavior.
- Added Codex installation provenance and source-appropriate update handling.
- Made Skills and Catalog views cache-first, with coalesced refreshes and explicit network sync.
- Fixed Linux fresh-folder Skills and Catalog loading behavior.
