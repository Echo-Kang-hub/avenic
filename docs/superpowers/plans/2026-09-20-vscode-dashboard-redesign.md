---
goal: Rebuild the Avenic VS Code extension dashboard to match the owner's final reference screenshot (image.png, 1536x1024) at near-pixel fidelity, on real core data and real operations, without regressing CLI/Core
version: 1.0
date_created: 2026-09-20
owner: Echo-Kang-hub
status: 'In progress'
tags: [feature, refactor, design, vscode, dashboard, visual-regression]
---

# Introduction

![Status: In progress](https://img.shields.io/badge/status-In%20progress-yellow)

The owner has fixed the extension's UI: `D:\FileDownload\Projects\agenthome-cli\image.png`
is the only visual source of truth. The current Overview webview (terminal-flavored
status list), the three TreeViews and the separate Sessions panel are replaced by one
dashboard webview whose Overview section is a near-pixel rebuild of the reference:
internal sidebar (Overview / Configure / Agents / Sessions / Skills / Quick Actions),
project header, three Agent Configuration cards, Shared/Project Sessions, Skills,
Quick Actions and Recent Activity. Every value shown comes from `@avenic/core` or the
extension's services layer over core; every control performs a real operation. No
static fixture data in production paths.

## 1. Requirements & Constraints

- **REQ-001**: Overview section matches the reference image in structure, geometry, spacing, colors, hierarchy (see VER-001 thresholds).
- **REQ-002**: All displayed data comes from core/services (status model, canonical sessions, skills, catalog); no hardcoded provider/model/session/skill strings in production code.
- **REQ-003**: All controls are real: Launch (per agent), Change (wizard), Continue (canonical continue), Import Skill (owner/repo), Manage Skills, View Logs, Refresh, Reconfigure, tabs, section navigation.
- **REQ-004**: Sidebar navigation switches sections in-webview: Overview, Configure, Agents, Sessions, Skills, Quick Actions. No per-section duplicated data loading (one data channel, one refresh).
- **REQ-005**: Sessions: shared list (title, participating agents, relative time, Continue, View history/transcript, Set active, View all); per-agent native list with tabs Claude/Codex/OpenCode; History-mode aware copy (Shared shows sessions; Isolated explains shared is off and offers Switch to Shared).
- **REQ-006**: Session rows never show raw session ids as titles (title priority: native summary/title > canonical title > first user message snippet > short id fallback; ids only in details).
- **REQ-007**: Skills: Installed/Available Packs/tab structure; rows show name, description (SKILL.md frontmatter), per-agent targets, enabled state; Import Skill takes `owner/repo` or git URL, discovers, multi-selects, installs via existing core service.
- **REQ-008**: Recent Activity shows only genuinely recorded events (in-memory ring buffer written at real operation points + real load timestamps); empty state "No recent activity."
- **REQ-009**: Empty/error/degraded states for: not initialized (show Initialize Avenic), no project, no sessions, no skills, hub not cached, agent CLI missing.
- **REQ-010**: First paint is immediate (shell renders before data); data-ready target < 300 ms with warm cache; anything > 500 ms non-blocking progress. Activation must not do network/hub/LLM/history-full-parse.
- **REQ-011**: Brand asset: the owner's `icon.png` (repo root) is the one official Avenic mark — never redrawn, recoloured or regenerated. Derived, losslessly cropped + resampled sizes ship inside the VSIX (`media/avenic.png` webview brand, `media/icon.png` Marketplace, `media/icon-activity.png` activity bar); the reference layout `[icon] AVENIC / AI Workflows. Yours.` is preserved in the sidebar; no runtime reference to any `D:\` path; every other Avenic logo location uses this same asset (no second brand mark). Agent marks (Claude/Codex/OpenCode) stay their own.
- **SEC-001**: Webview keeps CSP nonce, localResourceRoots, no remote loads; all user-affected strings via createElement/textContent (no innerHTML); message protocol is a validated allowlist with typed parameters; no secrets (API keys/tokens) ever cross to the webview — only present/absent.
- **SEC-002**: No file under `.agents/` is read by the assistant during this work; tests use invented fixtures only; no real session data or credentials in any artifact.
- **CON-001**: CLI/Core behavior, performance and Shared/Isolated, Account/API semantics must not change; core additions are additive and covered by tests.
- **CON-002**: Plugin presentation only: no second business implementation. Continue/launch/config/skills all call the same core paths the CLI uses.
- **CON-003**: Production code weight: business TS may not grow (delete replaced UI: old overview body, tree views/view-models, sessions panel); growth is confined to media (HTML/CSS/rendering JS).
- **GUD-001**: Design tokens only (`--avenic-*`, radii, spacing scale); no scattered magic numbers; theme-aware via `--vscode-*` with the reference's dark palette as the measured anchor; light theme stays legible.
- **GUD-002**: Skills actually used this round: using-superpowers, find-skills, frontend-design, test-driven-development, modern-javascript-patterns, typescript-advanced-types, verification-before-completion, requesting-code-review, receiving-code-review, create-implementation-plan (this file).
- **PAT-001**: TDD: every behavior change lands with a test that was watched failing first (vm-rendered webview tests via test/fixtures/dom-stub.ts; core tests against fixture projects).
- **PAT-002**: Visual regression: headless screenshot of the real media files at the reference viewport, diffed against image.png (crops + anchor geometry + color sampling), kept under dist/dashboard-visual/; failure gate before packaging.

## 2. Implementation Steps

### Implementation Phase 1 — Reference fixture & harnesses

- GOAL-001: Freeze the reference as a fixture and stand up the two harnesses (behavior + visual) that all later tasks depend on.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Copy image.png → `dist/dashboard-visual/reference.png`; measurements from `dist/dashboard-visual/measurements.json` (colors/geometry/typography, produced by the visual audit) become the token table in `media/dashboard/style.css`. | | |
| TASK-002 | Visual harness `packages/vscode/test/visual/shot.mjs`: renders `media/dashboard/view.html`'s body content by executing the real `main.js`/`style.css` against a fixture DashboardData payload in a headless Chromium (msedge `--headless=new --screenshot`), at 1536×1024 and additional widths (1280/1024/720). Injects a dark-theme `--vscode-*` variable set + `acquireVsCodeApi` stub that posts fixture data. Zero new npm dependencies. | | |
| TASK-003 | Diff tool `dist/dashboard-visual/compare.mjs`: side-by-side images + geometry probes (sidebar width, card edges, gaps, badge colors) measured on the implemented screenshot with the same sampler used for the reference; prints MATCH/DIFF per anchor. | | |
| TASK-004 | Behavior harness: extend `test/fixtures/dom-stub.ts` only as needed; new `test/dashboard-ui.test.ts` renders fixture DashboardData through the real `main.js` and asserts structure/actions (TDD home for Phase 4). | | |

### Implementation Phase 2 — Core data (additive, tested)

- GOAL-002: Core can answer everything the reference displays; nothing is parsed by the plugin itself.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-005 | Session titles: adapters extract native title/summary into `toCanonical` (claude: jsonl `summary` record else first user message snippet; codex: rollout thread name/meta else first user message snippet; opencode: stored session title); canonical session stores a stable displayTitle with upgrade-on-import (existing uuid-style titles replaced, never churned when unchanged); `readTranscript`/records expose it. Tests: per-adapter extraction, import upgrade, idempotence, no LLM, no added launch cost. | | |
| TASK-006 | Agent display facts in the status model: per-agent resolved configuration fields the card shows — method/scope/config source/provider/model/baseUrl (+ Claude sub-agent/effort fields and Codex reasoning effort only where the agent's own files really carry them), account signed-in state and home; read from the agent's own files where the product already writes them; absent stays absent (no invented rows). Tests per field, incl. "user's own file not written by Avenic" behavior. | | |
| TASK-007 | `lastUpdated` for the project header (configuration/runtime file mtime, real value) and per-agent native session records (id, title, updatedAt) via existing adapters/list functions where available; missing pieces get the minimal read-only function. Tests with fixture stores. | | |
| TASK-008 | Skills descriptors: description (SKILL.md frontmatter) and per-agent target ownership for installed skills, exposed through the existing skills status service; `owner/repo` discovery flow: discover (list without installing) + install-subset, with tests; reuse the exact core functions `avenic skills add` uses. | | |
| TASK-009 | `continueCanonicalSession` and native-session continue paths verified against CLI parity: extension will call the same functions; add nothing new unless the map shows a gap (then minimal core function + test). | | |

### Implementation Phase 3 — Extension data layer & actions

- GOAL-003: One DashboardData ViewModel + one validated message protocol drive every section and action; replaced UI deleted.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-010 | `src/dashboard/protocol.ts` v2: DashboardData {project{name,root,configured,lastUpdated}, agents[unified + modelFields[] + sessionSummary], history{mode,sharedCount}, sharedSessions[≤5 + total], agentSessions per agent [≤5 + total], skills{installed[≤5], counts, tabs}, hub{spec,revision,cached}, activity[≤6]}; incoming: navigate, refresh, action{launch|change|continueShared|continueNative|viewHistory|setActive|importSkill|manageSkills|viewLogs|openConfig|switchHistory|initialize}+params — each validated, unknown rejected. | | |
| TASK-011 | `src/dashboard/state.ts` builds the ViewModel from core/services only (status model, canonical records, skills snapshot, catalog cache, activity); ≤5 rows on Overview with real totals; no full history parse at activation; titles via TASK-005. Unit tests: fresh project, account/api/global/project/open-code-native, isolated mode, no sessions, no skills, hub uncached, agent missing. | | |
| TASK-012 | Activity recorder `src/ui/activity.ts`: ring buffer (≈20) + OutputChannel "Avenic"; record real points: dashboard load, wizard applied, launch prepared/finished, skills installed/imported, hub synced, sessions continued; used by dashboard and by View Logs. | | |
| TASK-013 | Actions in `src/commands/*` gain explicit-parameter entry points (launch(agentId), change(agentId→wizard), continueShared(sessionId)→agent pick→continueCanonicalSession→terminal, continueNative(agentId,id), importSkill flow, switchHistory). All reuse existing command bodies; palette behavior unchanged. Tests where the harness allows; manual Extension-Host checklist otherwise. | | |
| TASK-014 | Delete replaced UI: `views/*` tree providers + `view-models.ts` + their tests; `dashboard/sessions-panel.ts`, `media/sessions/*`, `sessions/protocol.ts` merged into dashboard; `avenic.sessions.open` reveals the dashboard Sessions section; keeps `sessions/state.ts` data builder. Manifest: activity-bar container holds the single `avenic.dashboard` webview view; menus cleaned; manifest.test updated. | | |
| TASK-015 | `src/dashboard/overview.ts` → dashboard host: template injection unchanged; action forwarding with parameter validation; navigate messages; deep-link select(id) for View history; keep the 1 s status cache + single refresh. | | |

### Implementation Phase 4 — Webview (the visual rebuild)

- GOAL-004: `media/dashboard/{view.html,style.css,main.js}` render the reference at near-pixel fidelity on real data.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-016 | Token layer in style.css from measurements (colors: bg/sidebar/surface/border/text/muted/orange/green/blue/purple; radii; spacing; type scale; control heights). Sidebar (logo, AVENIC, tagline, nav with active state, footer Documentation/Settings, version + Ready). | | |
| TASK-017 | Project header (name, real path chip, configured pill + last updated, Refresh secondary + Reconfigure primary), section header rows (icon + title + subtitle + right-side controls). | | |
| TASK-018 | Agent Configuration: three equal cards; header (icon, name, Ready dot, Launch/Change); field rows with badges; per-agent field lists from modelFields; divider; Sessions/History badges; footer config link; OpenCode native copy. | | |
| TASK-019 | Shared Sessions + Project Sessions cards: titles, agent badges, relative times, Continue, overflow, tabs for native agents, view-all footers; History-mode aware behavior incl. Isolated state and Switch to Shared. | | |
| TASK-020 | Skills card (tabs, rows with description/agent marks/Enabled, Import Skill/Open Folder, view all), Quick Actions grid (6 real actions), Recent Activity card (real events, empty state, View All). | | |
| TASK-021 | Sessions section (full manager): shared + per-agent lists, continue flows, transcript reader (ported from media/sessions/main.js into dashboard styling), turn limit expansion, set active; per REQ-005. | | |
| TASK-022 | Agents / Configure / Skills / Quick Actions sections: real content per REQ-004; not-initialized state with Initialize Avenic; loading shell first (REQ-010). | | |
| TASK-023 | Responsive: ≥1200 three agent cards, 900–1200 two+one, narrow single column; sessions pair stacks; sidebar collapses; no mobile-scale degradation of the desktop target. Accessibility: focus-visible, tab order, aria labels, badge semantics not color-only. | | |

### Implementation Phase 5 — Brand asset (owner-supplied icon.png)

- GOAL-006: One official Avenic mark, packaged with the extension, wired into the dashboard and every other logo slot.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-030 | Derive packaged sizes from `icon.png` with no redraw: alpha-scan the content box (threshold >16 skips the ~24k invisible alpha≤16 speckles), crop, centre-resample HighQualityBicubic → `media/avenic.png` (512, 4% pad), `media/icon.png` (256, 4%), `media/icon-activity.png` (48, 10%). Script kept at `dist/dashboard-visual/derive-icons.ps1`; original `icon.png` untouched. | ✅ | 2026-09-20 |
| TASK-031 | Manifest/asset audit: `package.json` `icon` → `media/icon.png` (Marketplace), activity-bar container icon → `media/icon-activity.png`; delete the superseded `media/icon.svg`; grep-verify no other logo reference remains; VSIX packaging keeps `media/**` (`.vscodeignore` audit). | ✅ | 2026-09-20 |
| TASK-032 | Dashboard sidebar brand block renders `[icon] AVENIC / AI Workflows. Yours.` at the reference geometry; the icon reaches the webview through `asWebviewUri` + CSP `img-src {{cspSource}}`, never base64 and never a local path. | | |
| TASK-033 | Visual regression includes the brand block: the harness feeds a real file:// data-URI-free `asWebviewUri` stub for `avenic.png`, and the sidebar-top crop is part of the compare set. | | |
| TASK-034 | VSIX verification: package, list contents (icon assets present), install into the real Extension Host, confirm the activity-bar mark and the dashboard brand mark render from packaged files; Marketplace icon dimensions/format check (PNG, square, ≥128px, no unsupported colour space). | | |

### Implementation Phase 6 — Visual convergence & verification

- GOAL-005: Screenshot gate passes, extension works in a real host, no regressions, artifacts produced.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-024 | Iterate TASK-016…023 against compare.mjs until anchors MATCH (VER-001); store final side-by-side + diff under dist/dashboard-visual/final/. | | |
| TASK-025 | Scenario matrix screenshots (fixture payloads): A reference-like (API/Account/native/Shared), B account·global + API·global + Isolated, C agent missing, D no sessions, E many sessions, F no skills, G hub uncached; widths 1536/1280/1024/720; light theme sanity pass. | | |
| TASK-026 | Performance: measure activation, first paint (shell), data ready, section switch — extension `markPerformance` + harness timings; record in release notes (REQ-010 thresholds). | | |
| TASK-027 | Full regression: `npm test` (Windows + WSL/Linux with `source ~/.nvm/nvm.sh`), `npm run test:vscode` (typecheck/build/tests), `npm run release:pack`/verify flow as applicable, dist guards. | | |
| TASK-028 | Real Extension Host: package VSIX, install into real VS Code, open this repository, verify Overview data equals real config, click Launch/Change/Continue/Import Skill/Refresh/View Logs; different window sizes + light/dark; screenshots. | | |
| TASK-029 | Code review round: requesting-code-review subagent → fix Critical/Important → receiving-code-review; verification-before-completion checklist; LOC before/after; version bumps (core + vscode as changed; CLI untouched); CHANGELOG/README; final artifacts (VSIX + any tgz) + SHA256SUMS + release notes in dist/release-<date>/; 19-item report. | | |

## 3. Alternatives

- **ALT-001**: Prettify the existing terminal-style Overview and keep TreeViews — rejected by the owner explicitly ("不要把当前 TreeView 稍微美化后就算完成").
- **ALT-002**: React/Vue webview framework — rejected: repo is vanilla TS + static media; bundle size and startup cost (REQ-010) favor semantic HTML + small render helpers.
- **ALT-003**: Dashboard parses runtime.json/settings.local.json itself — rejected (REQ-002/SEC-001): core is the only reader; plugin composes.
- **ALT-004**: Screenshot via VS Code's own `code --screenshot`-like tooling — not available; headless Edge of the same Chromium family is the closest reproducible substitute, with a real Extension-Host pass (TASK-028) as the final arbiter.

## 4. Dependencies

- **DEP-001**: Reference image `image.png` (present at repo root; copied to dist/dashboard-visual/reference.png).
- **DEP-002**: `dist/dashboard-visual/measurements.json|md` from the visual-audit subagent (colors/geometry/type) — gates TASK-016.
- **DEP-003**: core-api-map report (sessions/skills/status/continue exact signatures) — gates TASK-005…009 and TASK-011/013.
- **DEP-004**: Microsoft Edge (msedge) for headless screenshots; codicon.ttf already bundled.
- **DEP-005**: Real VS Code (`code --install-extension`) for TASK-028.
- **DEP-006**: Owner-supplied `icon.png` at the repo root (official brand asset) + PowerShell System.Drawing for the lossless derive step.

## 5. Files

- **FILE-001**: `packages/vscode/media/dashboard/view.html|style.css|main.js` — rebuilt (presentation).
- **FILE-002**: `packages/vscode/src/dashboard/{protocol.ts,state.ts,overview.ts}` — ViewModel/protocol/host.
- **FILE-003**: `packages/vscode/src/{views/*,views/view-models.ts,dashboard/sessions-panel.ts,media/sessions/*,src/sessions/protocol.ts}` — deleted (superseded UI).
- **FILE-004**: `packages/vscode/src/ui/activity.ts` — new, small.
- **FILE-005**: `packages/vscode/src/commands/*.ts` — parameterized entries.
- **FILE-006**: `packages/vscode/package.json` — contributes (single dashboard view, menus, version).
- **FILE-007**: `packages/core/src/runtime/{adapters/*,canonical-sessions.mjs,session-interop.mjs,transcript.mjs,status*.mjs}` — additive dashboard/title facts.
- **FILE-008**: `packages/vscode/test/*` — updated + new UI/data tests; `test/visual/shot.mjs`.
- **FILE-009**: `dist/dashboard-visual/*` — reference, measurements, shots, diffs.
- **FILE-010**: `CHANGELOG.md`, `packages/vscode/CHANGELOG.md`, `packages/vscode/README.md`, release notes.
- **FILE-011**: `packages/vscode/media/{avenic.png,icon.png,icon-activity.png}` (derived from root `icon.png`), `dist/dashboard-visual/derive-icons.ps1`; deleted: `packages/vscode/media/icon.svg`.

## 6. Testing

- **TEST-001**: Core title extraction/upgrade (per adapter, idempotent, snippet fallback).
- **TEST-002**: Core agent display facts (account/api × global/project, opencode native, user-owned files untouched).
- **TEST-003**: Skills descriptors + discover/install-subset (`owner/repo`).
- **TEST-004**: DashboardData ViewModel scenarios (TASK-011 list).
- **TEST-005**: Protocol validation (unknown actions/params rejected; no path/shell pass-through).
- **TEST-006**: Webview behavior via dom-stub (sections render, buttons post validated actions, empty states, History-mode copy).
- **TEST-007**: Visual regression compare (anchors MATCH) at 1536×1024 + 3 widths + light theme.
- **TEST-008**: Accessibility basics (focus order, focus-visible, aria on icon-only controls) — via DOM assertions + manual host pass.
- **TEST-009**: Perf measurements (activation/shell/data-ready/section switch) recorded.
- **TEST-010**: Full suites: core (Win+Linux), vscode suite, build/typecheck, VSIX install smoke.
- **TEST-011**: Brand asset: derived PNGs are transparent-background, same artwork (no recolour: sampled gradient stops match the source), correct dimensions; manifest icon paths resolve; VSIX contains all three; webview references the icon only through the templated URI (test asserts no absolute/local path and no data: URI in `main.js`/`view.html`).

## 7. Risks & Assumptions

- **RISK-001**: Core cannot resolve some reference fields (Claude sub-agent/effort, Codex reasoning effort) from files the product actually writes → show only what is real (REQ-002); the card must not fake rows.
- **RISK-002**: Native session titles have no reliable source in some formats → fallback chain (REQ-006) keeps ids out of the primary slot; snippet extraction is local and bounded.
- **RISK-003**: Headless Edge rendering ≠ Electron embedding font differences (±small AA pixels) — accepted per owner's allowed differences; geometry anchors make the comparison objective.
- **RISK-004**: Deleting tree views could hide rarely used actions → all remain as commands (palette) and in dashboard sections; manifest tests updated deliberately.
- **ASSUMPTION-001**: The reference's example values (agenthome-cli path, DeepSeek, counts) are illustrative; the real project's values render in the same slots.
- **ASSUMPTION-002**: `~/.claude`/`~/.codex` remain read-only for Avenic; account status shown only from the project's own home file's presence.

## 8. Related Specifications / Further Reading

- `image.png` (visual source of truth) · `dist/dashboard-visual/measurements.md`
- `docs/superpowers/specs/2026-09-06-vscode-extension-design.md` (prior extension design)
- `AGENTS.md` (product invariants) · `CHANGELOG.md` 1.8.4 entry (runtime model)
