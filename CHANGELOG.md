# Changelog

## 1.5.2 / 1.4.2 - 2026-09-18

- Make the shared init/change agent selector require at least one selection,
  without changing generic optional multi-select behavior.
- Add the compact interactive Avenic terminal banner and complete the Sessions
  menu's active-session and Shared-mode transition actions.
- Keep Codex v2 parent-thread recovery, crash-safe canonical capture, and
  malformed native-history diagnostics on the single core lifecycle path.

## 1.5.1 / 1.4.1 - 2026-09-18

- Keep global native sessions outside project portable/shared capture during
  ordinary launches.
- Keep crash recovery and shared capture idempotent without a background
  native-history poller or an additional inventory cache.
- Resolve nested Codex multi-agent v2 child threads to their resumable parent
  before calling the official resume path, with cycle-safe fallback.
- If the Codex app-server still rejects a resume, rehydrate a new official
  thread from the complete canonical handoff instead of dropping an empty delta.
- Keep continuation prompts one command-line argument for Windows npm `.cmd`
  shims, preserving cross-agent handoffs containing line breaks.
- Neutralize command-shell metacharacters only in the Windows launch prompt;
  canonical event and handoff artifacts remain unchanged.

## 1.4.8 / 1.3.6 - 2026-09-17

- Tolerate malformed Claude JSONL records and continue importing valid records.
- Deduplicate reconciliation diagnostics and keep plain launches responsive.
- Run resume-catalog preparation asynchronously so the foreground TUI is not
  blocked by bootstrap or native-session discovery.

## 1.4.7 / 1.3.5 - 2026-09-17

- Prepare the active canonical session for the official Claude/Codex resume
  catalog without automatically selecting it in the foreground TUI.
- Add idempotent native projection materialization with canonical cursor and
  provenance tracking.
- Resume an existing Codex native session when only the canonical cursor is
  stale, injecting the deterministic delta; bootstrap is now fallback-only.
- Persist deterministic `state.json` and `handoff.json`/`handoff.md` artifacts
  without writing Claude or Codex private session storage.

## 1.4.6 - 2026-09-17

- Keep ordinary `avenic <agent>` launches transparent: shared canonical
  continuation is now opt-in via `avenic sessions continue`.
- Make `self-update` report registry/current/active versions and verify the
  executable actually selected by PATH after installation.

## 1.4.5 - 2026-09-17

- Keep Claude, Codex, and OpenCode foreground launches attached to the user's
  terminal; continuation handoff is passed as an initial prompt instead of a
  non-interactive stdin pipe.
- Use official interactive Codex `resume`/bootstrap commands for TUI sessions.

## 1.4.4 - 2026-09-17

- Restrict Codex native capture to rollouts belonging to the current project
  directory, preventing cross-project history capture during rehydration.

## 1.4.3 - 2026-09-17

- Safely rehydrate a canonical continuation into a new Codex native thread when
  the mapped thread is already occupied by another Codex process.
- Preserve canonical source-of-truth history, abrupt-exit reconciliation, stale
  native projection recovery, historical session import, and independent
  Auth × Sessions modes.
- Keep Claude/Codex continuation at semantic L3a; Codex native-faithful L3b is
  not claimed.

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
