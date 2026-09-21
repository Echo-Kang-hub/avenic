# AGENTS.md

Guidance for coding agents working in this repository.

## Project overview

Avenic is a multi-agent manager for **Claude Code**, **Codex** and **OpenCode**:
one CLI (`avenic`) and one VS Code extension that agree on how a project's
agents are configured, how their sessions are stored and shared, and which
Skills are installed.

Three packages, one direction of dependency:

| Package | Artifact | Role |
|---|---|---|
| `packages/core` | `@avenic/core` | All business logic. ESM, no runtime dependencies: project config, agent runtime (the Account/API answer and the configuration file API prepares), session adapters, canonical (shared) history, capture/durability, Skills and Hub, the status model, and the one label table. |
| `packages/cli` | `avenic` (bins: `avenic`, `ave` → `scripts/skills.mjs`) | The terminal UI. Vendors core. |
| `packages/vscode` | `avenic-agent-manager` (publisher `EchoKang`) | The extension. Consumes the same core API; renders QuickPick/Tree/Webview only. |

**Core decides, hosts render.** The CLI and the extension must never compute a
second answer to a question core already answers — no duplicated status model,
version rule, path rule or Skill classification. See `packages/core/src/status.mjs`
(`collectStatus`) for the pattern: one object, rendered as text by `status-cli.mjs`,
as JSON unchanged by `--json`, and as a dashboard by
`packages/vscode/src/dashboard/state.ts`.

Vocabulary is deliberately small: **ProjectConfig, AgentRuntime, Session/Capture,
Adapter/Projection, Skills/Hub**. There is no `Manager`, `Controller`,
`Coordinator` or `Engine` layer, and new code should not add one.

**The final VS Code Dashboard is the canonical source of truth for Avenic
user-facing terminology. CLI, status, Configure and documentation must use the
same vocabulary.** The words live once, in `packages/core/src/labels.mjs`, and
every surface renders from there — `avenic init`'s summary and rail,
`avenic status`, the extension's Configure wizard and the dashboard's cards,
the tree view, and these documents. The pinned set is small and exact:
**Account** / **API** (the Authentication answer), **Account Scope** and
**Configuration Scope** (each answer's own scope, Global or Project),
**Sessions** (Global/Project), **History** (Shared/Isolated), and OpenCode's
**Native (OpenCode UI)**. Values read as `API (Project)` / `Account (Project)`.
The implementation words are banned from anything a user reads: **Runtime**,
Runtime scope, Authentication method, Model configuration, Model configuration
scope, Session storage, Session history. `test/vocabulary.test.mjs` scans the
hosts' string literals for them and compares four surfaces on one project; a
host that wants a different word has to change it for every host at once.

The canonical runtime schema has exactly these names (`runtime.json`,
`schemaVersion: 3`): per agent `authMethod` (`account` \| `api`), the scope of
*that* method (`accountScope` for Account, `configScope` for API — never both),
and `sessionScope`; per project `historyMode`. Anything derived is computed
(`viewOf`, `effectiveAgentConfig`), never stored. A second spelling of one of
these — `authScope`, `interop`, `mode` — is a bug, not a synonym.

The CLI reaches core through the `#core` / `#core/*` import maps, which resolve
to `packages/cli/vendor/core-src` — a generated copy. Never edit that copy by
hand; edit `packages/core/src` and run the sync.

## Two non-negotiable product requirements

These are product requirements, not preferences. A change that breaks either one
is a bug even when every test passes.

### 1. The terminal UI is part of the product

Every surface a user reads — `init`, `change`, `sessions`, `skills`, `status`,
self-update, progress and results — is rendered by the one terminal layer in
`packages/cli/src/cli/prompts.mjs` over the one brand layer in
`packages/cli/src/cli/brand.mjs`, and it has to look like a modern
skills-CLI: the fixed `AVENIC` mark (a 12-row asset, not a drawing routine), a
hierarchy of `◆`/`◇` sections over `│ ◇ ◆ └` rails, and one colour system in
which red-orange is the brand — `◆`/`◇`/`▸`/`◉`, selected rows and the active
cursor — while green is left to mean success/current and nothing else, yellow
warns, red errors, and dim grey is secondary.

Rules that follow from that:

- The logo is a fixed asset: `scripts/brand/avenic-logo.sh` is the design
  source, `test/fixtures/brand/avenic-logo.ansi` is its output,
  `packages/cli/src/cli/brand-logo.mjs` holds it as constants, and
  `test/brand-logo.test.mjs` pins the three together byte for byte. Never
  redraw it, re-font it, resize it, or generate it at runtime.
- Two banner shapes and no more: `fullLogo()` for `init`/`change`/`sessions`/
  `skills`, `compactBrand()` (one line) for `status`/self-update and for any
  terminal too narrow for the mark. A plain `avenic claude|codex|opencode`
  launch prints neither.
- ANSI numbers live only in `brand.mjs` as semantic tokens
  (`brand`, `brandStrong`, `brandSoft`, `cursor`, `selected`, `selectedStrong`,
  `muted`, `text`, `strong`, `success`, `warning`, `error`); they degrade
  TrueColor → 256 → 16 and vanish under `NO_COLOR` without touching layout.

- The cursor (`▸`) and the selection (`◉`/`○`) are different marks: a user must
  always be able to tell where they are from what they have chosen.
- Every list shares one keyboard: `↑↓` or `j`/`k` to move, space to toggle,
  `^a` for all, typing to filter, enter to confirm, `esc` to cancel. Nothing
  proceeds with zero items selected, and there is no "cancel" row inside a list.
- One implementation: never add a second prompt, raw-mode or keypress handler.
- Degrade, never break: narrow terminals, `NO_COLOR`, a non-TTY stdout, Windows
  PowerShell, Linux and SSH all render correctly, and non-TTY output carries no
  control sequences. No emoji in layout.

### 2. Shared means one conversation, not three

In Shared mode the user has **one** conversation. `avenic` keeps it once, in
canonical form, and switching agents changes only who answers next — never what
the user has to copy, paste, re-explain or rebuild.

Agent provenance is metadata on an event, not a boundary: every event keeps its
id, role, content, agent, tool call and result, timestamp, order and branch, and
a projection must never let provenance break continuity. Concretely:

- A plain launch is a new conversation. `avenic claude` spawns the official CLI
  with exactly the arguments the user typed — never the project's active
  conversation, in any mode. Shared says what the project *can* do, never what
  one launch must do. Entering the shared conversation is explicit: `avenic
  sessions continue <id> --agent <agent>`, the sessions menu, or the agent's
  own `/resume`. Resume arguments on an unrequested launch were the P0 of the
  1.8.2 that shipped; 1.8.3 removes them.
- The target agent receives the *delta* it has not seen — its own turns are
  never sent back to it — projected through the agent's official surface
  (`session-interop.mjs`, `projection.mjs`, `adapters/*`).
- A summary handoff is the last resort, never the design. Never compress a
  shared history into one giant user prompt.
- Avenic owns the transcript a user can always read back: `avenic sessions
  show` and the extension's Sessions view render `transcript.mjs` — You /
  Claude / Codex turns in order with provenance labels, never internal JSON.
- The launch path stays free of this work: a plain `avenic claude` pays no
  projection cost, and a switch costs its delta, not the whole history.

Known limitation, recorded 2026-09-19 as next-version work (not a 1.8.x
blocker): **long-session native projection checkpointing** — when the canonical
model-visible context exceeds `NATIVE_BUDGET`, the projection condenses the
oldest turns into the deterministic checkpoint rather than summarizing them:
canonical keeps every event, but a target whose delta alone exceeds the budget
reads a summary of the older part instead of its words. The next version
decides whether canonical history past the budget should be summarized or
checkpointed instead of dropped from the target projection. Details and the
measured numbers: `docs/session-interop-design.md` → "Known limitations".

## Agent environment invariants

These are permanent. They are the code of the converged model: the
**Authentication** answer and the **configuration it points at** are two
different questions, and each one is answered by whichever party owns it — the
agent, or the project.

1. **The Authentication answer and everything it implies are separate.**
   A project answers `authMethod: account | api` for each agent, and that answer
   decides who owns the rest: Account means the agent owns the sign-in and Avenic
   configures no model; API means the agent reads its provider, endpoint, model
   and credential from its *own* configuration file — which is the user's to fill
   in, and which Avenic prepares and never writes into. The scope each answer
   carries is its own (`accountScope`, `configScope`) and only one of them exists
   at a time; `sessionScope` and the project's `historyMode` are independent of
   both. Nothing derived is stored twice.

2. **Account mode delegates the sign-in to the agent.** Avenic does not log in,
   does not store a credential, and does not invent a credential format. A
   project-scoped account is isolated by pointing the agent's *own*
   configuration-home variable — `CLAUDE_CONFIG_DIR` for Claude, `CODEX_HOME` for
   Codex — at `<project>/.agents/local/<agent>`, where the agent's own `login`
   writes its own files; `cwd` stays the project root. The user's global account
   (`~/.claude`, `~/.codex`) is never read into that home, never written, and
   never deleted. The one definition of that redirect is
   `agentRuntimeEnvironment` (`runtime/agent-runtime.mjs`); the resolver,
   `beginLaunch`, the durability watchdog and `finishLaunch` all take it from
   that one function, because a launch and its capture that disagree about the
   configuration root capture nothing and revert the wrong tree.

3. **API prepares the agent's own configuration, and never writes into it.**
   Avenic is not a provider or model configurator. It makes sure the file the
   agent reads is where the agent will look — Claude's project scope is
   `<project>/.claude/settings.local.json`, its global scope is
   `$CLAUDE_CONFIG_DIR/settings.json` (or `~/.claude/settings.json`); Codex has
   no project-scoped file of its own, so a Project answer lives in
   `<project>/.agents/local/codex/config.toml` and reaches Codex through its own
   `CODEX_HOME` variable at launch — and then it gets out of the way. A missing
   file is created empty (`{}` for JSON, empty for TOML, mode 0600); a file that
   is there is preserved byte for byte; nothing Avenic did not create is edited,
   reformatted or deleted. Provider, endpoint, model and credential are the
   user's to fill in (by hand or with their own tool) and the surfaces read them
   back out of the file. A credential is reported as present or absent and is
   never printed, copied into canonical history, or written into launch state.

4. **An agent's native settings stay the agent's.** `.claude/settings.local.json`
   and `config.toml` are the agent's own configuration, not Avenic's: Avenic
   creates one only when it is missing, records that in the ownership ledger
   (path, `createdByAvenic`, the hash of what it wrote — never a value out of the
   file), and may give back only a file it provably created and nobody has
   changed since. It is never deleted merely because the project switched to
   Account, and an existing file is never overwritten because a command ran.

5. **OpenCode answers for its own authentication, provider and model.** Avenic
   records only its session scope, and its Authentication renders as
   `Native (OpenCode UI)`; `avenic opencode` launches straight into OpenCode's
   own flow, and no `init`/`change`/Configure step may add an authentication or
   configuration question for it.

6. **Live and durable environments are two different things.**
   `durableEnvironment` narrows what a detached watchdog *persists* (an
   allow-list that refuses credential-shaped names). It is never the source of a
   live spawn's environment. "Do not persist secrets" must not become "strip
   secrets from the running agent": the child that pays for the run keeps its
   environment; the files that outlive it never see the values.

7. **Capture and revert touch session/transcript storage only**
   (`projects/<key>`, `sessions/`, …, and the same paths under a project-scoped
   account home). Credential files, Claude's settings files, skills and
   worktrees are never snapshotted, rewritten, or treated as session artifacts —
   a sequence of launches leaves their bytes untouched.

8. **Switching method keeps the old configuration unless the user says
   otherwise.** The question is asked after the new answers are collected and
   before anything is applied, and it names the file it is about:
   `◇ Existing Claude Code configuration │ .claude/settings.local.json is still
   present.` then `◆ What should Avenic do? ▸ ◉ Keep ○ Remove`, default Keep.
   Remove is asked a second time, as its own step that opens on **No**, while
   `esc` can still mean nothing has happened; a file Avenic cannot prove it
   created is never asked about. Removal happens after the new configuration is
   written and is limited to files Avenic provably created for *this* project and
   nobody has changed since. It may never `rm -rf` a managed whole directory,
   never touch the user's global account or an agent's own sign-in, and never
   touch another project. **If it cannot be proven that Avenic generated a
   thing, that thing stays.**

9. **Nothing is guessed and nothing is probed.** Unknown or ambiguous state is
   asked about once at launch (with an optional "Remember for this project?",
   default No); sign-in status is read from the agent's own credential file and
   reported as signed-in / not-signed-in / unknown. Nothing about who signs in
   or which model is configured is ever discovered by asking anyone: no network
   check, no model call, no login attempt on the user's behalf, ever, from
   `init`, `change`, `status`, the extension or a launch.
   One deliberate exception, and it is not about state: the extension's agent
   rows (the "可升级" mark) and `avenic self-update` read the published *version
   numbers* from the npm registry. That lookup is cached (10 minutes), tolerates
   failure (no answer is `null`, never an error), never runs inside a launch,
   and decides nothing about authentication or configuration.

## Setup

```bash
npm install                      # root: dev tooling only, no runtime deps
npm run sync-core                # copy packages/core/src → packages/cli/vendor/core-src
npm --prefix packages/vscode install
```

## Everyday commands

```bash
npm run sync-core                # required after ANY change under packages/core/src
npm test                         # root suite (pretest runs sync-core for you)
npm run test:vscode              # extension: tsc --noEmit + node --test
npm run perf                     # launch/capture profile on a generated fixture
npm run perf:tui                 # keypress→paint and logo render budgets
npm run tui:visual               # compare every screen to its golden
npm run tui:capture              # real-terminal screenshots into dist/tui-captures
npm run pack:cli                 # npm pack --dry-run --json for the CLI
npm run release:pack             # build the publishable artifacts into pack/
npm run release:verify           # install those artifacts and run them
node packages/cli/scripts/skills.mjs <args>   # run the CLI from source
```

To work on the extension: `cd packages/vscode && node build.mjs` (esbuild →
`dist/extension.js`), `npm test`, `npm run package` (VSIX → `dist/`).

## Testing

- Root tests live in `test/*.test.mjs` and run with `node --test` (files in
  parallel, so the suite is far slower under load than on an idle machine).
- Focus a single file or case while iterating:
  `node --test test/cli-prompts.test.mjs`,
  `node --test --test-name-pattern="searchable" test/cli-prompts.test.mjs`.
- Interactive surfaces are driven for real, not snapshotted: `FakeTTY` +
  `keys()` from `test/helpers/fake-tty.mjs` write key sequences into the
  production prompt code, and `test/helpers/session-fixture.mjs` writes
  real-shaped native history (Claude JSONL, Codex rollouts, OpenCode storage).
- `npm run test:install` — dual-mode global install, agent runtime, Skills.
- `npm run test:release` — packs the CLI, installs the tarball into a temp
  global prefix, and runs version/init/launch/sessions/change/Shared/Isolated/
  Hub/status/self-update against it. This is the gate that must pass before a
  release; it is what proves the artifact, not the sources.
- `npm run release:pack` then `npm run release:verify` — build the files a
  version is published from into `pack/`, then install those exact files
  (CLI tarball into a scratch prefix, `@avenic/core` on its own, the VSIX into
  the editor) and run them. The versions come from the manifests, so this is
  the same two commands for every release. `pack/` is a build output and is
  never committed; publishing it still needs npm authentication and the
  VSIX upload.
- Every terminal surface also has a golden:
  `test/helpers/tui-scenarios.mjs` renders each screen through the production
  code, `test/fixtures/tui/*.ansi` holds them, and
  `test/tui-visual.test.mjs` compares them inside `npm test`. The fixtures are
  normalized — a colour is the token `{brand}`, a repaint is `{repaint}` — so
  they read like a screen and diff like a design change. A fixture must never
  depend on the machine that rendered it: no local timestamps, no ambient
  `COLORTERM`; colour depth is pinned per scenario.
- `node scripts/tui-visual.mjs --update` rewrites the goldens (only after
  reviewing the diff); `npm run tui:capture` runs the same screens on a real
  terminal and leaves the screenshots in `dist/` — those are acceptance
  artifacts, they can contain real session data, and they are never committed.
- A real terminal for tests means a pseudoconsole: ConPTY through
  `test/helpers/conpty-capture.ps1` on Windows, `script -qfec` elsewhere, both
  behind `test/helpers/pty-capture.mjs`. A frame only repaints when stdout is a
  TTY, so nothing below a pty proves a screen.
- VS Code tests are TypeScript, compiled by `build-tests.mjs` into `.test-out/`.

Add or update tests with every behaviour change. A fix without a test that
fails before it and passes after it is not finished.

## Performance

Avenic's own cost is the wait it adds in front of an agent, measured as
`wrapped − direct` per launch situation, on an idle machine:

```bash
node scripts/perf/launch-overhead.mjs --runs 15 --cold-fixtures 3
node scripts/perf/launch-overhead.mjs --runs 5 --phases     # where the time goes
```

Budgets are median < 300 ms and p95 < 500 ms; `test/launch-latency.test.mjs`
holds the smaller subset that runs on every commit. Never measure while
another build, test suite or agent run is competing for the machine.

The terminal layer has its own budgets, held by `npm run perf:tui`
(`scripts/perf/tui-render.mjs`): the logo renders in under 5 ms and a keypress
paints its frame in under 16 ms, measured from the write to the next console
write. Nothing on that path may touch the filesystem, the core, git, the
registry or history — a keypress is a repaint, never a lookup.

The fast path must stay free of: network, registry lookups, `git fetch`, Hub
access, LLM calls, full canonical scans, full native-history scans, and
polling or sleeping. One launch scans a given source at most once, reads a
given config at most once, and shares one filesystem snapshot.

## Code style

- ESM everywhere, `node:` prefixed builtins, `async`/`await`; no top-level
  side effects outside entry points.
- Comments say **why**, not what. Core and tests are commented in English;
  the CLI's user-facing surfaces and the extension's UI code carry Chinese
  comments consistent with the surrounding files. Match the file you are in.
- `packages/core/index.d.ts` is hand-maintained: update it in the same change
  as `packages/core/src/index.mjs`. The extension typechecks against it.
- Prompt/TUI code lives in `packages/cli/src/cli/prompts.mjs` — one keyboard,
  one frame renderer. Do not add a second raw-mode or keypress implementation.
- Deprecate, don't delete, user-facing spellings: warn, name the replacement,
  and forward to the one implementation (see `LEGACY_SKILLS_VERBS` in
  `packages/cli/src/cli/dispatcher.mjs`).
- Anything a user reads in the terminal should be checkable: prefixed, aligned,
  and free of terminal control sequences when stdout is not a TTY.

## Build and release

Versions move core → CLI → VS Code, in that order, and only when the change
warrants a semver bump:

```bash
npm run test:release                     # after `npm test` and `npm run test:vscode`
npm run release:gate                     # pack → verify → vscode → visual → host → host:upgrade → host:upgrade:open; Windows desktop, the last three legs open a window
npm pack "$PWD/packages/cli"  --pack-destination "$PWD/dist/release-<stamp>"
npm pack "$PWD/packages/core" --pack-destination "$PWD/dist/release-<stamp>"
cp packages/vscode/dist/avenic-agent-manager.vsix "$PWD/dist/release-<stamp>/"
```

Use absolute paths with `npm pack` — a relative package directory is read as a
registry spec and fails on an unrelated git error. Packing the CLI runs
`prepack` → `sync-core`, so the vendored core in the tarball always matches
`packages/core`.

Ship with: version bumps, `CHANGELOG.md` entries (root for core+CLI,
`packages/vscode/CHANGELOG.md` for the extension), a release-notes file, the
tarballs and VSIX in `dist/release-<stamp>/`, and `SHA256SUMS.txt` beside them.
Publishing to npm and uploading the VSIX are the owner's steps; do not attempt
them. `npm publish` runs **inside each package** — `packages/core` first, then
`packages/cli`. The root manifest is `private: true` on purpose (it is the
workspace root, never a published package), so a publish from the repository
root stops with `EPRIVATE` and publishes nothing.

**In-place updates are a supported path, not a fresh install.** The Marketplace
replaces the extension under a running window, so for a moment the new manifest
is served by the previous release's code. Two rules follow, and both are
enforced by tests (`test/manifest.test.ts`, `test/dashboard-open.test.ts`):

- The Dashboard view id has **one** source, `packages/vscode/src/views/view-ids.ts`.
  The manifest, the `createTreeView` registration and every `view == …` menu
  binding read it; a second literal is a bug. When the manifest's id and the
  running code's differing ids meet, VS Code paints its own
  `No view is registered with id: …` into the activity bar — a sentence with no
  cause and no action in it.
- `activate()` mounts the view provider **first**, before anything that can
  throw or await, and everything after it is inside a guarded shell. A data load
  that fails may not be the reason the entry point is missing, and no open path
  may ever surface that VS Code sentence: Avenic says
  `Avenic Dashboard could not be opened.` and offers **Reload Window** /
  **View Logs**, while the raw reason goes to the Avenic output channel.
- Old command ids are reached only through the O(1) alias table in
  `packages/vscode/src/views/legacy.ts` — no probing old state, no filesystem
  scan, no CLI spawn on a keystroke's path. The table's keys are deliberately
  absent from the manifest, so the palette never offers a name that is gone.
- `npm run test:host:upgrade` installs the newest previously released VSIX,
  starts a window with it, updates over it with `--force` while that window
  runs, reloads, and requires the Dashboard to open with no view error;
  `test:host:upgrade:open` does the same with the old page left open. Both run
  in the release gate, in an isolated profile, offline.

## Security and data safety

- **Never commit** tokens, credentials, `.npmrc` files, or real session data.
  Test fixtures are invented and must stay invented.
- Avenic creates **no GitHub token system of its own**: Hub sync uses the
  machine's own git credentials (SSH, credential helper, `gh`, git config).
- Never write API keys, auth headers or credentials into canonical sessions,
  and never execute session content.
- Capture reads native agent files and never modifies them; malformed JSONL is
  skipped with one diagnostic per problem, and the valid records around it are
  still imported.
- Publishing uses a temporary npm user config or an injected environment
  credential, removed immediately afterwards.
