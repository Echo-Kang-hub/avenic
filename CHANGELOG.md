# Changelog

## 1.5.2 / 1.4.2 - 2026-09-19

- Remember what was already read: Claude and Codex native history is captured
  and imported by what changed since the last run instead of by re-reading
  every session file, so a plain launch reaches the official agent TUI without
  walking history it has already seen. First run pays for the history; every
  run after it pays for the delta, and a truncated or rewritten file is still
  read in full.
- Keep a running agent's sessions durable instead of waiting for it to exit:
  the launch group mirrors the project's native storage before the agent
  starts, a background pass captures while it runs, and the exit path
  reconciles what is left — so an abrupt exit loses at most the writes still in
  flight, and a second Avenic launch joins the group rather than racing it.
- Write canonical history back into native storage only where the two sides
  disagree. Both stamps are recorded per file, so a repeated restore costs one
  comparison, a lost cursor costs one re-render, and neither can lose history.
- Give every malformed native-history problem one report and one wording,
  printed once per run. Native files are still never modified, and the valid
  records around the broken line are still imported.
- Make Hub sync a real network operation that can be diagnosed, using the
  system's own git credentials. Failures name their kind — authentication,
  repo-missing, ref-missing, git-missing, network, cache-filesystem or unknown
  — and Avenic still does not create its own GitHub token system.
- Reconcile shared history when the user opens the Sessions view, not on every
  launch.
- Ask OpenCode which sessions moved instead of exporting its whole history
  again.
- Decide what an agent CLI version is, and whether it is usable, in one place
  shared by the CLI and the VS Code extension; the probe never blocks the UI.
- Decide unmanaged Skills against the managed set rather than against what the
  catalog happens to display, so a Skill the catalog no longer lists can still
  be removed.
- Answer "which Skills are unmanaged", how the Skill catalog is laid out, and
  how everything is uninstalled from one place each, in core.
- Pick the active editor's workspace folder by core's path containment, so
  roots that end in a separator and filesystem roots are matched on Windows
  too.
- Fix a launch in a project whose native session directory exists but holds
  nothing — Claude Code creates that directory on startup, so this was the
  normal state of a project the agent had only been opened in.
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
