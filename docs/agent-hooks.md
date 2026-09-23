# What each agent can tell Avenic, verified on this machine

Accessed 2026-09-24. Installed versions: **claude 2.1.274 · codex-cli 0.154.0 ·
opencode 1.18.30**. Every claim was re-read from the installed binaries — their
embedded hook reference and their serialization schemas — because the doc sites
were not reachable from the sandbox; the URL each section belongs to is cited
anyway. Live behaviour was checked by driving `codex app-server` JSON-RPC against
a throwaway `CODEX_HOME` in the system temp directory.

This is the evidence behind the capability matrix the code carries
(`packages/core`, one row per agent). Where a capability does not exist, Avenic
says "Unsupported by <agent> <version>" rather than pretending.

## The three mechanisms

| Agent | Mechanism | Where it goes | Ownership |
|---|---|---|---|
| Claude Code | settings `hooks` | `.claude/settings.json` (project) or `~/.claude/settings.json` | merge one entry into the user's file; Avenic-marked |
| Codex | config hooks | `~/.codex/config.toml` `[[hooks.<Event>]]` (or a sibling `hooks.json` with a `description`/`hooks` envelope) | merge; project hooks are gated on the project being trusted |
| OpenCode | plugin | `.opencode/plugins/<name>.ts` (project) or `~/.config/opencode/plugins/` (global) | a file Avenic owns outright — installable, removable, versioned |

## What exists, per agent

| | turn completed | needs attention | turn failed | duration |
|---|---|---|---|---|
| Claude Code | `Stop` | `Notification` (`permission_prompt`, `idle_prompt`, `agent_needs_input`, `agent_completed`) and `PermissionRequest` | `StopFailure` (matcher `error`: rate_limit, overloaded, authentication_failed, billing_error, model_not_found, server_error, …) | per tool (`PostToolUse.duration_ms`); no per-turn field |
| Codex | `Stop` | `PermissionRequest` | **no event** — only the app server's `turn/completed` with `status: failed` | none in the hook payload; `Turn.durationMs` over the app server |
| OpenCode | `session.idle` | `permission.asked` | `session.error` | `message.updated` timestamps |

Claude's `Stop` fires right before the response concludes; `StopFailure` fires
*instead of* it when the turn died on an API error. Codex's hook payloads carry
the same vocabulary (`session_id`, `hook_event_name`, `stop_hook_active`,
`turn_id`) but a different event set — 12 events, no failure and no notification
event. OpenCode's plugin gets the Bun shell (`$`), `directory` and `sessionID`
directly, so it can call `avenic hook emit` without a shim.

## Traps worth writing down

- **Codex ignores `timeoutSec`.** The TOML key is `timeout` (seconds, default
  600); `timeoutSec` is the app-server protocol name and is silently dropped.
- **Codex hooks are untrusted until reviewed.** Every freshly written hook reads
  `trustStatus: "untrusted"`, and project-local hooks do not load at all until
  the project is trusted (`trust_level = "trusted"` in the user config, or the
  user reviews `/hooks`). A generated config therefore does not fire unattended,
  and Avenic must say so instead of reporting a hook that never runs.
- **Claude has no `turn_id` on `Stop`.** `prompt_id` is the turn-grain correlator
  ("correlating a user prompt with all subsequent events until the next prompt").
- **Claude's exit codes matter per event.** `Stop` exit 2 continues the
  conversation; `StopFailure` ignores exit codes entirely — so failure must never
  be inferred from an exit code.
- **Claude hooks merge across scopes** rather than override.
- **OpenCode spells the property `sessionID`**, and `permission.updated` does not
  exist in 1.18.30 — the events are `permission.asked` / `permission.replied`.
- Claude's `hooks` block also accepts `http`, `prompt`, `agent` and `mcp_tool`
  handlers, each with an `if` condition and a timeout; `http` is not available for
  `SessionStart`/`Setup`.

## Avenic's shape

`avenic hook emit --agent claude|codex|opencode` reads the native payload on
stdin, normalizes it to one small event (`turn.started`, `turn.completed`,
`turn.failed`, `attention.required`, `session.started`, `session.ended`) and
dispatches to the notification actions. It works with VS Code closed and the
extension never activated, and it never writes hook traffic into the shared
conversation — the semantic session model and the automation event bus are
separate.

The other half is the install, and it is the same CLI (`avenic hook install |
uninstall | status`, with `--dry-run` showing the diff before anything is
written). It writes into the file each mechanism above names — project scope for
this project, global scope for the machine — merges rather than rewrites, and
recognises its own entries by the command they run, so a user's own hooks in the
same file survive an install, an upgrade and an uninstall. Codex's caveat is
printed whenever its hooks are installed: written is not the same as trusted.

`avenic hook test` fires one synthetic completion so a user can watch the
notification chain with VS Code closed, and it prints the first hop next to the
last one: whether this agent's hooks are installed for this project in the
first place. A test that proves the actions work and then says nothing about
the file is how a user ends up staring at a silent hook they never installed.

The emit path is charged to the turn, so it is measured: on Windows 11 the
whole `avenic hook emit` process costs ~230 ms end to end, of which ~170 ms is
Node's own start-up on this machine and single-digit milliseconds are Avenic's
dispatch. The entry routes `hook` before the dispatcher (a loader test proves
the process never resolves the dispatcher, the prompt layer, or core's session
machinery), and every wait inside the dispatch — webhook, command — is bounded
by the action's own budget rather than by the far side answering.

## Could not be confirmed

- Whether Codex's `Stop` also fires when a turn dies on an API error (no failure
  hook exists; `Interrupt` covers user interrupts only).
- Whether an `untrusted` Codex hook is actually skipped at runtime — inferred
  from the trust status and the review UI, not observed.
- What fires Claude's `Notification` type `agent_completed`.
- Whether an OpenCode plugin loads under headless `opencode run`.
- Codex's `prompt` / `agent` / `mcp_tool` handlers were accepted by the schema but
  never exercised.

Sources: https://code.claude.com/docs/en/hooks ·
https://developers.openai.com/codex/hooks · https://opencode.ai/docs/plugins
(the pages themselves were unreachable from this network; the same reference text
is embedded in each installed binary and was read there).
