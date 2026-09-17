# Avenic Session Interoperability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Avenic sessions portable across Claude Code, Codex, and OpenCode while preserving existing project-session behavior.

**Architecture:** Keep the existing per-agent native caches for compatibility and add a versioned, append-oriented canonical store under `.agents/sessions/canonical`. Core owns schema validation, store mutation, adapters, and lifecycle sync; CLI and VS Code only call core services.

**Tech Stack:** Node.js ESM, `node:test`, existing `@avenic/core` runtime adapters, VS Code TypeScript extension.

**Spec:** `docs/session-interop-design.md`

## Global Constraints

- Root tests explicitly cover only repository `test/**/*.test.mjs`; VS Code tests remain in their independent job.
- Native parsers are untrusted-input readers and never execute transcript data.
- Existing `.agents/sessions/{claude,codex,opencode}` data and old commands remain supported.
- Canonical writes are atomic, deterministic, idempotent, and preserve unmapped native fields in extensions.
- Credentials and auth/configuration fields are filtered before canonical persistence.

---

### Task 1: Repair CI test isolation and cross-platform launch fixtures

**Files:** `package.json`, `test/model-launch-cli.test.mjs`

- [ ] Add an explicit root test glob and verify VS Code tests are absent from `npm test` discovery.
- [ ] Make fake agent shims `.cmd` on Windows and executable POSIX scripts elsewhere for Claude, Codex, and OpenCode.
- [ ] Assert argv, environment, PATH, and a space-containing argument reach the child process.
- [ ] Run root tests, install integration, CLI package dry run, and VS Code package workflow.

### Task 2: Define canonical schema and atomic store

**Files:** `packages/core/src/runtime/canonical-sessions.mjs`, `packages/core/src/index.mjs`, `test/canonical-sessions.test.mjs`, `docs/session-interop-design.md`

- [ ] Add failing tests for versioned session creation, event append/deduplication, mappings, secret filtering, malformed records, and safe attachment names.
- [ ] Implement versioned `session.json`, append-only `events.jsonl`, and `mappings.json` with atomic replacement.
- [ ] Export the core APIs and document schema, identity, security, and compatibility constraints.

### Task 3: Upgrade adapter contract and native readers

**Files:** `packages/core/src/runtime/adapters/{index,claude,codex,opencode}.mjs`, adapter fixture tests

- [ ] Define `discover`, `readNative`, `toCanonical`, `fromCanonical`, `writeNative`, and `revision` contract.
- [ ] Implement strict read-only Claude, Codex, and OpenCode native normalization with extension preservation.
- [ ] Add round-trip and malformed-input tests for every adapter.

### Task 4: Implement canonical synchronization and projections

**Files:** `packages/core/src/runtime/session-sync.mjs`, adapters, tests

- [ ] Add idempotent import/sync with native-to-canonical mappings and content/revision hashes.
- [ ] Add canonical-to-native projections only where a target native format is verified resumable.
- [ ] Add all six cross-agent projections, continuity A/B/C/D fixtures, and branch-conflict diagnostics.

### Task 5: Integrate launch, CLI, and VS Code

**Files:** CLI dispatcher, VS Code services/commands/views/package manifest, tests

- [ ] Add pre-launch sync/project and post-exit sync while retaining lease/snapshot/revert behavior.
- [ ] Add unified `avenic sessions list|status|sync|import|continue` commands while preserving legacy commands.
- [ ] Add a Sessions view and commands for import, sync, mapping/status, conflict display, and continue-with-agent.

### Task 6: Regression and documentation completion

**Files:** tests, `docs/session-interop-design.md`

- [ ] Run full root, packaging, integration, and VS Code verification in isolated temporary state.
- [ ] Record adapter capability levels and native-format restrictions from executable evidence.
