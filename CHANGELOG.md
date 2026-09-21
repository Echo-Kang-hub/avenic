# Changelog

## 1.8.4 / 1.6.5 / 0.5.5 - 2026-09-20

- **Authentication and model configuration are now two questions, and each one
  has exactly one owner.** A project answers **Authentication** for each agent —
  `Account` or `API` — and that answer decides the rest. `Account` means the
  agent signs in with its own account: Avenic configures no model, stores no
  credential, and invents no credential format. `API` means Avenic writes the
  provider, endpoint, model and credential into the agent's *own* configuration.
  The method carries its own scope (`Account` → global/project, `API` →
  global/project) and the two never coexist as separate truths: only the named
  method's scope is written, so a runtime file can no longer say `api` and
  `account` at the same time. A bare `auth: global|project` from 1.8.3 is
  migrated once, and a legacy project-auth file with usable content becomes that
  agent's API configuration rather than being thrown away.
- **The extension is one window now: a dashboard drawn from the same answers as
  `avenic status`.** The webview shows the project in a single panel — the
  Avenic mark, a fixed sidebar (Overview, Configure, Agents, Sessions, Skills,
  Quick Actions; Documentation and Settings at its foot, with the extension's
  own version and a readiness dot), a project header (name,
  the project's real root, configured or not, last updated, Refresh,
  Reconfigure), three agent cards, shared and per-agent sessions, skills, quick
  actions and recent activity. Every cell is a value core answered for *this*
  project: a field core cannot answer is not drawn rather than filled in, a
  session title is the one core recorded (native summary, then first user
  message, then a short id — never a UUID), a stored title that is itself a
  session id — bare, or written as the canonical id — is answered as no title
  at all rather than displayed, and no path, count or badge is a
  placeholder. The extension also stops keeping a tree that repeats what the
  panel already says: the activity bar holds one short list that opens the
  panel, and a command that names a destination ("Sessions") opens the panel on
  that section. Configure and Agents are the same three cards asked two
  different questions, so the two entries are not one entry with two names.
- **The window never waits on the project, and a slow read says so.** The shell
  is static markup and paints before any data arrives; the placeholder blocks
  are replaced when the answers land; and a refresh that takes longer than half
  a second draws a `Reading the project…` status line *above* the content it is
  waiting to replace instead of blanking the panel. Measured in a cold browser
  at the reference size: shell 15–28 ms, data 18–24 ms, both far inside the
  100 ms / 300 ms budgets. Reading is only ever a read: no network check, no
  model call, no login attempt.
- **The dashboard is held to a rendered reference, not to a description.** A
  headless harness renders the panel with real core data in both themes, at
  four window sizes, on every section, with the slow-read line drawn and with a
  tab strip driven by the arrow key — 22 views, each checked for clipped or
  overlapping text, icons without a glyph, controls with no accessible name,
  tab roles that do not match their state, text below WCAG AA, a wait line that
  drew when nothing was slow, and a wait line that failed to draw when
  something was. The checks have been shown to fail: removing the rule that
  lets a select shrink breaks the 1280 render, replacing the content with the
  wait line breaks two, and forcing the arrow key to do nothing breaks the
  keyboard one. Geometry is compared against the reference screenshot's own
  edges (47 anchors, ±2px) on every run. Two real defects came out of it and
  are fixed here: a render that threw left an empty page that passed every
  other check unnoticed, and the light theme's badge labels measured 4.08–4.37:1
  against the page behind them.
- **One supplied mark, carried in the package.** The extension icon, the
  activity-bar icon and the mark in the panel's own header are one asset, at
  three sizes, transparency preserved and never redrawn; the panel loads it
  through the webview's own URI, under a CSP that allows no other source, and
  `npm run release:verify` now reads the VSIX's table of contents and fails if
  any of the three files, or the manifest field that names them, is missing.
- **Project-scoped Account isolates the agent's own login — in the agent's own
  home.** Choosing Account + Project points the agent's own configuration-root
  variable (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) at
  `<project>/.agents/local/<agent>` for that project, and nothing else: the
  agent's own `login` writes its own files there, in its own format, and the
  working directory stays the project root. Your `~/.claude` and `~/.codex` are
  not read into that home, never written, and never deleted. This is the one
  case that moves a configuration root, and it is the case that means to — an
  earlier cut of this round refused any redirection and left project sign-in
  with nowhere honest to live. A launch, its capture and its durability watch
  all take the environment from the same core function
  (`agentRuntimeEnvironment`), so the run that writes to the project's home and
  the code that reads it back can no longer disagree about where it is.
- **API mode writes the agent's own file, and can give back exactly what it
  wrote.** Claude's project scope prefers `.claude/settings.local.json` —
  Claude's own project settings — written key by key through an ownership
  ledger: keys you wrote are preserved byte-for-byte, a key you change after
  Avenic wrote it is reported as a conflict and kept, and re-applying the same
  answers does not churn the file. Codex has no project-scoped configuration
  file, so it receives the project's answer the way Codex documents for a single
  run: `-c model=…` / `-c model_provider=…` / `-c model_providers.<id>.*` on
  that launch. A credential is reported as present or absent and never printed, never
  written into canonical history, launch state, status JSON or logs. Editing an API
  project re-opens the questions on the answers it already has: provider, endpoint
  and model are read back from the file Avenic wrote, and the credential field is
  deliberately left empty — a secret is never echoed, so it can never be retyped,
  and an answer set that does not name it keeps it rather than removing it. Running
  `avenic change` (or Configure Project) and pressing Enter through the questions
  therefore changes nothing at all, byte for byte.
- **The device-level model library is gone.** Provider profiles, the machine
  library at `~/.config/avenic/models.json`, project bindings
  (`.agents/model.json` and its projection ledger), endpoint presets,
  `avenic model add|list|use|test|clear` and the extension's model panel are
  removed, not deprecated: a model configuration belongs to a project and lives
  in the agent's own configuration file, and Avenic ships no provider catalogue
  of its own. Nothing is hardcoded — no default provider, endpoint or model id
  anywhere in the product — and a stale `~/.config/avenic/models.json` or
  `.agents/model.json` in your project is simply never read again; deleting
  either is safe.
- **One wizard, in core, drawn by both hosts.** `avenic init`, `avenic change`
  and the extension's Configure Project walk the same questions in the same
  order from the same source: select agents → per agent **Authentication**
  (Account / API) → that method's scope → the API fields when API was chosen →
  session storage → OpenCode is asked about sessions only → shared/isolated
  history → the keep/remove question below → summary and apply. Answered steps
  stay on screen in dim grey, the current step expands, `Shift+Tab` goes back,
  and `Esc`/`Ctrl+C` cancels with nothing written — verified for both hosts, and
  the CLI's own dispatcher no longer keeps a second copy of the step list.
- **Switching method keeps the old configuration unless you say otherwise.**
  After the new answers are collected and before anything is written, the wizard
  asks `Existing Account/API configuration detected. Keep previous configuration?`
  with **Keep** as the default. Choosing Remove happens *after* the new
  configuration is written, is limited to what Avenic provably wrote for this
  project (the ledger, or an Avenic-owned key) and asks for confirmation before
  destroying anything. It never deletes a user's global account, never touches
  `~/.claude` or `~/.codex`, never touches another project, and never removes
  `.claude/settings.local.json` merely because you switched to Account.
  Switching an agent back to its previous method does not even ask.
- **Status says the method, the scope, and where that state actually is.** An
  Account reports its home and whether a sign-in has happened — read from the
  agent's own credential file, reported as `signed-in` / `not-signed-in` /
  `unknown` — and an API configuration reports which file carries it, the
  selected provider and model, or says that the file holds nothing Avenic wrote
  when it has not been written yet.
  Nothing is probed: no network check, no model call, no login attempt on your
  behalf, from `init`, `change`, `status`, the dashboard or a launch. A fact the
  reader cannot establish is reported as unknown rather than guessed.
- **"Avenic wrote this" and "this is still in the file" are answered
  separately.** A configuration you edit or delete outside Avenic keeps its
  ledger record — that record is what proves which keys were Avenic's, and what
  a later removal gives back — but it is no longer reported as the
  configuration you are running under: `avenic status`, the auth page, the
  dashboard and a launch's own note all say the file no longer holds what
  Avenic wrote (or holds a provider configuration Avenic did not write, which
  is a different sentence and a different situation) — the CLI names the
  command that repairs it, the panel points at Change, and the launch note
  carries the command itself. A method is offered as `already written` only when the
  values are actually there, so a launch cannot be pointed at a configuration
  that no longer exists.
- **A removal says what it could not give back.** Releasing a previous
  configuration reports three outcomes instead of a single number: keys
  removed, keys kept because you changed them after Avenic wrote them — a value
  Avenic did not set is not Avenic's to delete — and the one that asks you to
  act: keys whose earlier value the ledger only ever held as a hash, which
  cannot be restored, named so you can re-enter them. The CLI and the extension
  report the same three facts, from the same core result.
- **`deinit --purge` keeps the agent's own sign-in unless asked twice.** A
  Project-scope Account home (`.agents/local/<agent>/`) holds a credential the
  agent wrote itself, so purging a project deletes Avenic's own data
  (`.agents/sessions/<agent>/`) and reports the one sign-in file it left in
  place, by path. Deleting that too is `--purge-credentials`, which means
  nothing on its own: the sign-in is never destroyed as a side effect of a flag
  that did not ask for it, and when it is deleted the command says the next
  launch will ask you to sign in again.
- **A launch asks only when the project has not answered, and says what is
  already here.** If the method is genuinely unanswered the launch asks once,
  with an optional `Remember for this project?` (default No) that writes the
  method and nothing else. The two options report the state a local read can
  establish — `already signed in here`, or which file is `already written` — so a
  project that kept an Account and an API configuration at the same time offers
  two choices that say which is which instead of two that look alike. Neither
  question appears once the project has answered. Readiness is read from the
  agent's own credential file and the ownership ledger: no probe, no network.
- **OpenCode stays entirely OpenCode's.** `avenic opencode init` asks about
  session storage only, `avenic opencode` launches straight into OpenCode's own
  flow, and no surface offers it an authentication or provider question —
  OpenCode's auth, provider and model are its own.
- **A method switch asks before it writes, and names what it would remove.**
  `avenic claude auth api` is a switch, not a fresh answer, and it now goes
  through the same policy the wizard uses: it asks whether to keep what the
  previous method left, names the file it would take back out when the answer
  is Remove (with a second confirmation, defaulting to no), and Esc or Ctrl+C
  cancels with nothing written at all and no result page. The order is
  ask → write → release, so a cancelled switch cannot leave a half-switched
  project, and the release removes only the keys Avenic itself wrote.
- **A Global API answer follows the environment it is given.** Where a Global
  account home is read and where a Global API configuration is written are
  decided by the `HOME` / `USERPROFILE` the caller passes in, never by the
  process's own: a host or a fixture that directs home gets that home, so no
  run can read or edit the developer's real `~/.claude/settings.json` by
  accident.
- **`npm test` checks this machine's own agent configuration.** The suite ends
  by scanning `~/.claude/settings.json` and `~/.codex/config.toml` for the
  fixtures' markers and failing the run if they appear, so a test that leaks
  made-up configuration into a real home is caught instead of passing quietly.
  A first full run of it found three such keys, left by the suite before this
  round; they were removed by hand, key by key, with every other key preserved.
- **A draft that changes the history mode writes everything it carries.** The
  mode decides how history is imported, never whether the project's answers
  reach their files: a pass that both moves an API configuration and flips
  Shared/Isolated writes the new one before the release takes the old one back,
  and can no longer leave a project with neither. The second, destructive
  keep/remove question opens on **Keep** in both hosts — the answer to the
  question before it is never what a bare Enter repeats. Reading native history
  follows the same rule as writing it: the snapshot, the exit capture and the
  mode-change import resolve `CLAUDE_CONFIG_DIR` / `CODEX_HOME` — and, failing
  those, the home — from the environment they are handed, so an Account ·
  Project run is imported from the project's own home and a machine-wide
  `~/.claude` or `~/.codex` is never read into its place.
- **Less code, not more.** Production source across the three `src` trees (tests,
  vendored copies and build output excluded) is 17,544 lines in 81 files,
  against 17,962 in 103 files at 1.8.3: **−418 lines net and 22 files fewer**,
  with the model library, both hosts' private wizard copies and the overlays
  they needed deleted rather than layered. Counted where it is written, the
  extension's presentation shrank too: three webviews' 2,418 lines of script
  and style (overview, sessions, model) became one panel's 1,985, **−433**,
  while the panel gained the sections the three used to split between them. No
  dependency was added — no framework, no bundler runtime, no icon package (the
  glyphs are the font VS Code already ships) — and the `@avenic/core` barrel
  exposes 245 names against 300: 55 fewer, while gaining the canonical
  API-configuration module (584 lines) and the shared project wizard (353).
- **Upgrading.** A runtime file from 1.8.3 is migrated on first read: the method
  is derived from what the project actually said — a legacy project-auth file
  with usable content becomes API, an unambiguous `auth` scope becomes the
  matching method — and an ambiguous record is left unanswered so the launch
  asks instead of guessing. If you ran 1.8.3 with Project scope, the
  substitution it performed may have left `.agents/local/<agent>/` holding that
  run's files; under 1.8.4 that directory is the project's Account home, so
  treat what is in it as the project's own and clear it if you did not put it
  there. Existing `.claude/settings.local.json`, `settings.json` and
  `.agents/model.json` files are never rewritten, and `deinit` (without
  `--purge`) keeps them.

## 1.8.3 / 1.6.4 / 0.5.4 - 2026-09-19

- **A plain launch is a new conversation — every time.** `avenic claude` used to
  continue the project's active shared conversation whenever the history mode
  was Shared, by prepending the agent's own resume arguments before spawning it.
  That handed the official CLI a session nobody had chosen. Two failures came
  out of the same line: a launch that was meant to start fresh silently forked
  the shared thread, and any mapping whose native session had since gone
  produced `claude --resume <gone-session>`, which dies with "No conversation
  found with session ID …" before the TUI ever appears. Native storage is
  reverted on every exit, so a mapping that was fine when it was written is
  routinely stale by the next launch — the second failure was reachable on
  ordinary use, and was reproduced on the published 1.8.2 against a real
  project. The official CLI now receives exactly the arguments the user typed,
  in every mode: Shared says what the project *can* do, never what one launch
  must do. Three plain runs produce three conversations, each discoverable;
  continuing one is explicit and unchanged — `avenic sessions continue <id>
  --agent <agent>`, the sessions menu, or the agent's own `/resume`.
- **Capture is additive: a native file's absence no longer deletes the
  project's copy.** The capture pass copied native sessions into
  `.agents/sessions/<agent>` and then removed every destination file whose
  native source was gone — but native storage is a cache the run borrows and
  gives back, empty of every earlier session most of the time. So the pass
  deleted precisely the sessions the project had just saved: portable files
  disappeared while the canonical history they had already been imported into
  stayed, which is a project whose canonical side names conversations its
  portable side cannot produce. Capture now only ever copies; the one caller
  whose native store genuinely reflects deletions (opencode, whose store Avenic
  neither snapshots nor reverts) asks for removal explicitly. This is the
  defect that made a real project's `.agents/sessions/canonical/` hold many
  `claude-*` sessions while `.agents/sessions/claude/` held far fewer.
- **A conversation claimed by a pass that may not select still becomes the
  active one.** A clean exit could fail to record which conversation had just
  run: when the background durability watch imported the session's final bytes
  first, the exit pass found the very stamp the watch recorded and skipped the
  file — and marking the active conversation lives on the import path, so
  nothing was ever marked. Imports made by a pass that may not select now leave
  a pending claim that the next pass which may select resolves, by the rule an
  import has always used: the conversation that moved last. The durability
  watch also no longer starts before the native restore it would otherwise
  photograph half-filled.
- **A mapping whose conversation is held nowhere is dropped, not resumed.** The
  projection asks whether the session a mapping names still exists in either
  store — a question Claude's and Codex's stores can answer directly; when the
  answer is no, the mapping is discarded and the conversation is rebuilt from
  canonical history, which is the one path that always works. `avenic status`
  reports the same state as `missing` — asked of the conversation the mapping
  names, not of the project's session count, since a project with fifty healthy
  sessions and one ghost mapping is not current.
- **`avenic init` initializes the directory you are in.** It used to walk up to
  the repository root, so running it in a subdirectory configured the whole
  checkout. It now configures exactly `process.cwd()`; `--root <path>` names
  another directory. A directory inside another Avenic project asks first —
  "Current directory is inside another Avenic project: <parent>. Initialize this
  directory as a separate project?" — and a non-interactive run refuses instead
  of guessing. `avenic change` still edits the project the directory belongs to.
- **The setup wizard is one rail.** Every question of `avenic init` and
  `avenic change` now renders as a single continuous record: answered steps
  collapse to a `◇` title with a dim summary under it, the active step is the
  only expanded one (`◆`, in the brand's own orange), and the cursor, selection
  and help line are the same in every prompt. Shift+Tab re-opens the previous
  step with the answer it already has, keeping later answers in memory and
  submitting only the agents still enabled; Esc and Ctrl+C cancel the whole
  wizard, and nothing is written before the final Confirm. Once Apply is
  writing, the keyboard stops counting: a second Enter is not a second write,
  and a late Esc cannot turn a configuration that landed into a reported
  cancel. Ctrl+C is the exception — it is not an answer to the question, so it
  ends the frame as an interruption rather than leaving a stalled write with no
  way out of the prompt. The two flows share
  one state machine and one set of questions, which the VS Code extension
  consumes as well, so a host decides how to draw a step and never what the
  steps are.
- **Esc is answered at once.** Node's key decoder holds a lone escape for its
  sequence timeout (500 ms) waiting for the rest of an escape sequence, and
  every prompt in the product runs through that one decoder — so dismissing a
  prompt cost half a second of nothing. The timeout is now 50 ms, far longer
  than the gap inside a real escape sequence and far shorter than anyone can
  feel. Measured: 507 ms → 83 ms from keypress to the cancelled frame.
- **The extension's Initialize and Configure are the same wizard.** The
  project-configuration command walks the shared steps as QuickPicks: the
  question in the title bar with its position, answered steps folded above it,
  the current value highlighted, and VS Code's own Back button on every step
  but the first. It configures the selected workspace folder exactly — a folder
  inside a repository is never promoted to the repository root — and the
  extension's per-agent Initialize keeps its single combined choice.

## 1.8.2 / 1.6.3 / 0.5.3 - 2026-09-19

- **A launch always leaves its conversation active.** A clean exit could fail
  to record which conversation had just run: when the background durability
  pass happened to import the session's final bytes first, the exit pass found
  nothing left to import — and marking the active conversation lives on the
  import path, so nothing was ever marked. The next launch saw no active
  conversation, started a fresh one, and said nothing; the shared thread was
  silently forked. Found and reproduced four times on the published 1.8.1
  during post-publish acceptance, most visibly in the VS Code Sessions page,
  which correctly showed that no conversation was active after a run that had
  clearly just happened. Imports made by a pass that may not select — the
  durability watch, startup recovery, `sessions sync` — now leave a pending
  claim, and the next pass that may select resolves it: the conversation
  written last, for a launch's exit pass, the run that just ended — whatever
  the watch imported first.
- **Codex's own client context is not the user's words.** Codex writes its
  plugin list, environment and instruction files into a thread as `role:
  "user"` records ahead of anything the user typed. Captured, entries like
  `<recommended_plugins>` appeared in the shared conversation under `You`, and
  were handed to the next agent as a user turn. The record itself says what
  each item is; a user-role record that carries item kinds and none of them is
  the user's own text is the client talking to the model, and is now skipped —
  the same way Avenic's own injected projection already was.

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
