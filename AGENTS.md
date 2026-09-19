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
| `packages/core` | `@avenic/core` | All business logic. ESM, no runtime dependencies: project config, agent runtime, session adapters, canonical (shared) history, capture/durability, Skills and Hub, the status model, the model library. |
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
them.

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
