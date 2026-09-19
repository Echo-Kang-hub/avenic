# Changelog

## 1.8.1 / 1.6.2 / 0.5.2 - 2026-09-19

- **A resumed Codex thread is handed the delta, not the conversation.**
  Switching to Codex a second time used to re-inject everything the thread did
  not write itself: measured on a sixty-turn conversation, a resume that
  carried two new turns injected sixty-two items, starting at the first turn of
  the conversation. The thread then held the same exchange twice in its own
  model-visible history, and every later switch cost the whole history rather
  than its delta — the opposite of what the adapter documented and what these
  notes claimed. The projection now also cuts at the canonical event the
  mapping says the target was given, so a resume carries what arrived since;
  a thread that has to be created still receives the conversation whole, and a
  mapping whose recorded event is no longer in the history is read as "no cut"
  rather than as a guess.
- A tool result is filed by the Anthropic API under role `user` — the shape of
  the request it came back in, not a claim about who spoke. Read by role, one
  agent's tool output was handed to the next one as an unlabelled user message,
  and the Sessions page showed it under `You`. One rule now decides the speaker
  everywhere: only the person's own words are the person's, another agent's
  turn — including its tool traffic — arrives in the assistant role and named
  after the agent that produced it, and the viewer keeps tool traffic attached
  to the agent that ran it.
- `truncate` measured painted rows in raw bytes: a colour code counted as
  columns, so a selected or searched row could cut twenty columns early, and a
  cut could land inside a colour code and leave a half-written escape on the
  terminal. Colour costs no columns now, and a row cut while still painted
  closes itself instead of colouring what follows it.
- The pseudoconsole test asks for the terminal it asserts about. It inherited
  the machine's environment, so a developer with `NO_COLOR` set — or a bare
  `TERM` — saw "the brand reaches a real terminal" fail on a product that was
  degrading exactly as designed. The same assertion now holds under
  `NO_COLOR=1 TERM=xterm` and under `FORCE_COLOR=3 TERM=dumb`.

## 1.8.0 / 1.6.1 - 2026-09-19

- **The terminal has a face of its own.** Avenic's brand is red-orange, and it
  starts with the `AVENIC` wordmark: a fixed twelve-row asset that is the design
  it is meant to be — the same eleven rows every time, held byte for byte
  against the script that drew it, and printed only where it belongs (`init`,
  `change`, `sessions`, `skills`, the wizard). `status` and self-update answer
  with a one-line brand instead, and a plain `avenic claude` prints neither, so
  starting an agent costs nothing but the agent.
- The colour system is one module with names, not a scatter of escape codes:
  `◆` and `◇` sections, the `▸` cursor, `◉`/`○` selections, and the rows you
  have chosen are red-orange; green is left to mean only "success" and
  "current", yellow warns, red is an error, and grey is secondary. Every surface
  picks the same token for the same meaning, so no screen can drift from the
  others. TrueColor is used when the terminal advertises it, then 256 colours,
  then sixteen; `NO_COLOR` removes the colour and keeps the layout exactly as it
  was.
- Redrawing stayed that cheap on purpose. The mark renders in 0.03 ms at the
  median and the heaviest keypress paints its frame in 0.11 ms, measured from
  the write to the next console write, against budgets of 5 ms and 16 ms. No
  keypress reads the filesystem, the core, git, the registry or history: a
  filtered list is a repaint, not a lookup.
- Every terminal surface now has a golden that a machine cannot disagree with:
  eighteen screens — logo, wizard, a change, the Sessions menu, a Skills list
  with the search open and several rows chosen, the status page, a narrow
  terminal, `NO_COLOR`, a pipe, progress, a summary, an error — rendered through
  the production code and compared to a fixture that reads like the screen it
  describes. The goldens pin the colour depth, so a fixture rendered on one
  machine passes on the next one; the same suite runs green on Windows and on
  Linux.
- Those screens are also captured from a real terminal, because a frame only
  repaints when stdout is a TTY: a ConPTY pseudoconsole on Windows and a pty on
  Linux, both driven from the test harness. The `AVENIC` wordmark and every rail
  are identical on both.
- **A turn of a shared conversation now travels whole.** Handing Claude or
  Codex the history it has not seen used to clip every turn to the budget meant
  for a summary, so a long answer arrived cut off in the middle and the
  receiving agent could not tell — the one failure Shared mode exists to
  prevent. The bound is now the whole projection rather than each turn, and
  Claude's context arrives as a file, so the size limit that once applied to a
  command-line argument no longer applies at all.
- The extension's Sessions and dashboard pages carry the same brand tokens
  (`--avenic-brand`, `--avenic-brand-strong`) instead of the old cyan, and still
  take every other colour from the editor's theme, so light, dark and
  high-contrast themes stay readable.

## 1.7.0 / 1.6.0 - 2026-09-19

- **Shared history is one conversation.** In Shared mode, Claude Code, Codex
  and OpenCode work on the same conversation rather than three private ones:
  every turn is recorded once, with who actually said it, and switching agent
  hands the target only the turns it has not seen. Ask Claude something, switch
  to Codex, and Codex answers with the whole exchange in hand — no briefing
  pasted in front of it, no history the other agent cannot see, and no
  re-sending of what it already knows.
- Read that conversation back with `avenic sessions list` and
  `avenic sessions show <id>`, or from the Sessions menu on a terminal. Each
  turn is shown under its real speaker — `You`, `Claude`, `Codex` — with the
  tool calls that turn ran underneath it and the model that answered. A shared
  history that hides which agent said what is not worth reading.
- Codex continuations go through Codex's own app-server: a thread is started,
  resumed or forked through the interface Codex publishes, and the delta is
  injected as items. Avenic reads and writes no private Codex storage of its
  own, so a Codex session Avenic handed over is a normal Codex session.
- The same is true of Claude Code: continuations use its own resume, and the
  conversation arrives as context rather than as words put in your mouth —
  another agent's answers are never presented as something you said.
- A switch costs its delta, not its history. Handing over a conversation of
  10 000 events prepares the target from the newest turns it has not seen —
  measured, that preparation costs tens of milliseconds whether the
  conversation holds a hundred events or ten thousand, because it projects the
  newest turns up to one bound rather than replaying the conversation in full.
- A launch that was interrupted is picked up again instead of restarted: a
  session Avenic wrote but never finished is recovered on the next run, and the
  conversation it was holding is still there. That recovery reads the native
  history this project already matched rather than searching the machine again,
  and the durability watch the killed run left behind is told the work is done
  instead of capturing the same tree a second time while the user waits.
- `avenic status` is one page of blocks — Project, History, Agents, Skills —
  under a single set of rails, with each agent's CLI, auth, session scope and
  cursor state on one row. `avenic status --json` is the same object unchanged.
  The Sessions and Skills menus are drawn from the same layer.
- Every command that reports what it did ends in that same page: `init` and
  `change` answer with a ◇ Agents and ◇ History block, `avenic claude init`
  and `deinit` and `auth` and `sessions` with their answers behind the same
  rail, and the wizard shows the configuration it is about to apply in that
  shape before it asks. A result used to be a hand-written column of text
  printed after a wizard drawn by the new layer — the seam was visible, and
  it is gone.
- The terminal UI is one layer: a readable `AVENIC` wordmark, `◆` sections over
  `│ ◇ ◆ └` rails, a `▸` cursor and `◉`/`○` selections that mean the same thing
  everywhere, arrows and `j`/`k` to move, space to toggle, typing to filter,
  `^a` to select all, Enter to confirm, Esc to cancel. Enter with nothing
  selected is refused in place rather than treated as "no", there is no
  "cancel" row to scroll past, and narrow windows, `NO_COLOR`, pipes and
  PowerShell all degrade to plain text rather than to broken boxes. There is no
  "Back" row either: Esc is the one way out of a menu, and the terminal layer's
  printed emitters all fall back to the real stdout on their own, so a command
  that reports a result cannot crash on a terminal that is not a test.
- An agent you have never run on this machine is no longer announced as a
  missing session root on every list; `avenic sessions import` still says where
  it looked when it finds nothing.
- The Hub is cache-first as documented. `avenic skills tree` and
  `avenic skills packs` — and the editor's Hub tree — read the local cache and
  run no git and no network at all; an unsynced cache says to run
  `avenic hub sync` instead of fetching behind your back or reporting git's
  error. An install the project lock has pinned to a revision that is already
  cached installs from the cache without fetching: the same bytes, no round
  trip, and reproducible offline as well as across machines. Deciding what the
  cache can answer now lives in core (`cachedCatalog`) rather than in each
  front end's own idea of a usable cache directory.
- Nothing that was said is lost when the native root is gone. A project-scoped
  launch reverts native storage when it exits, so the portable copies under
  `.agents/sessions` are the only record of that conversation; a capture that
  finds no native root at all now reads as "nothing new to copy" instead of
  deleting every one of them. Removing a portable file whose native source was
  actually deleted still works exactly as before.
- The launch path stays quiet: no network, no Hub, no registry, no full history
  scan before the agent starts, and `avenic perf` measures the wrapper's own
  cost per agent and separately for a Shared switch.

## 1.6.0 / 1.5.0 - 2026-09-19

- Ask one command what state this project is in. `avenic status` prints the
  project's configuration, its shared history, one row per agent, the Skills
  and the Hub from a single read-only model — no network, no git fetch, no
  agent CLI started, and an agent whose CLI is not installed is reported
  rather than fatal. `avenic status --json` is that same object unchanged, so
  the CLI, the editor and any script cannot disagree about what they saw.
- The extension's dashboard is that model, drawn. Agent rows, the shared
  history block, the Hub revision and the Skills health all come from the
  same `collectStatus` the terminal uses, so a project cannot read as
  `current` in one host and uninitialized in the other.
- `avenic skills` on a terminal opens the Skills menu: Add skills, Installed
  skills, Update skills, Remove skills, Sync SkillsHub, Import from
  repository, Back. Adding from the Hub or from a Git repository clones once,
  reports what it found ("Found 14 skills"), lets you pick from a searchable
  list, asks where to install it and in which scope, then shows the source,
  revision, Skill count, targets and scope before it asks to confirm.
- Which install targets a Skill is shared into is now remembered in the
  lock file, so unchecking one target in the install step is not silently
  undone by the next update.
- Every prompt is one implementation with one keyboard: arrows and j/k move,
  space toggles, Ctrl+A selects all, typing filters a searchable list,
  Enter confirms, `y`/`n` answer a confirmation, and Esc or Ctrl+C cancels
  without changing anything. Enter with nothing selected is refused in place
  rather than treated as "no"; a pipe gets the script path instead of the
  menu.
- A launch measures itself: the wrapper's own cost — the part of the wait
  that is Avenic rather than the agent — is recorded per agent and per
  situation, and the launch path does no network, no registry, no Hub, no
  history walk and no full canonical scan before handing over to the agent.
- Timestamps are written one way in one place, so a session's "updated at"
  reads the same in the terminal and in the editor, and an absent timestamp
  reads as "—" instead of a 1970 date.
- The command surface is the ten commands the README teaches. The older
  spellings still work and say which one replaced them: `avenic doctor` →
  `avenic status`, top-level `avenic add|install|uninstall|adopt|packs|tree`
  → the same verb under `avenic skills`, `avenic catalog` → `avenic hub`.
- **Security:** a launch no longer writes your credentials to disk. The
  detached helper that keeps a run's sessions durable is handed its
  environment through a file in the temp directory, and that file used to
  hold the whole environment — so a shell that exported `ANTHROPIC_AUTH_TOKEN`
  or an API key left it in plain text for as long as the launch state lived.
  The file now carries only what locates an agent's native storage and home,
  chosen from an allow-list that refuses anything credential-shaped. Anyone
  who ran an earlier version should delete the stale `avenic-launch-*`
  directories in their temp directory and rotate what was exported.

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
  again, and read the revision current builds actually report.
- Continue OpenCode on the model the user's own OpenCode resolves, instead of
  one Avenic picked, and keep another agent's provider and model out of the
  projected session — a session naming a provider this machine does not have
  is one OpenCode refuses to start. When a projected session still will not
  start, continue in a fresh official session handed the shared history rather
  than failing the launch.
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
- Name the agents in the interactive pickers: the init/change wizard could not
  be completed, and the Sessions menu's "Continue with" could not start
  anything, because both offered the registry's entries without their ids.
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
