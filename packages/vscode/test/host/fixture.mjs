// The project the Extension Host check drives, built by the production calls.
//
// The class of project matters more than the individual values: the dashboard
// answers a question about *a project*, and a fixture that is thinner than the
// projects it is meant to speak for (one account, one agent, no Skills) makes
// the screenshot an answer about nothing. So this is the same class of project
// the design reference shows:
//
//   Claude    — API, project scope: the project owns provider/endpoint/model,
//               written into Claude's own `.claude/settings.local.json`, with
//               the model block an earlier Avenic (or the user) put in the same
//               file's `env`.
//   Codex     — Account, project scope: the agent owns the sign-in and its
//               configuration home points into the project.
//   OpenCode  — session scope only: it answers for its own authentication,
//               provider and model, so its card is a real card, not a
//               "not configured" one.
//   Skills     — a real catalog, selected and installed through the same calls
//               the extension's own commands run.
//   Sessions   — fictional conversations on all three agents, written into each
//               agent's own portable store and imported with core's importer.
//
// Every value here is invented, and every credential-shaped one says "fixture".
// Nothing in this file launches or resumes an agent.
//
// Why it is a module rather than a block inside run.mjs: the same fixture runs
// without a desktop — `node test/host/fixture.mjs --out <dir>` builds it into a
// directory you name and prints what the panel would render — which is how a
// change to it is checked before a run spends a window on it.

import { build } from "esbuild";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, "..", "..", "..", "..");
const BUNDLE = path.join(REPO, "packages", "vscode", ".test-out", "host-fixture.mjs");
const ENTRY = path.join(here, "fixture-entry.ts");

/**
 * The production services, bundled. They are TypeScript whose neighbours import
 * `vscode`, so a plain `import()` cannot load them — the same esbuild step (and
 * the same externals) as test/visual/capture.mjs.
 */
export async function loadFixtureApi() {
  await build({
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: BUNDLE,
    entryPoints: [ENTRY],
    external: ["vscode", "esbuild"],
    logLevel: "silent",
  });
  return import(pathToFileURL(BUNDLE).href);
}

// The API configuration this project owns for Claude: a provider on an
// invented endpoint, and a credential that cannot be read as a real one.
const CLAUDE_API = {
  provider: "DeepSeek",
  baseUrl: "https://provider.fixture.invalid/v1",
  model: "claude-sonnet-5",
  credential: "fixture-avenic-host-check-not-a-real-credential",
};

// The model block Avenic does *not* write: `writeApiConfiguration` owns the
// base URL, the model and the token, and these five keys are what an earlier
// Avenic — or the user, or another tool — left in the same file. They are
// ordinary Claude Code configuration, so a project that has them is a project
// with answers on the card instead of empty rows. Plausible ids, no real
// account behind any of them.
const CLAUDE_MODEL_BLOCK = {
  ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5",
  ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-5",
  ANTHROPIC_DEFAULT_HAIKU_MODEL: "claude-haiku-4-5",
  CLAUDE_CODE_SUBAGENT_MODEL: "claude-sonnet-5",
  CLAUDE_CODE_EFFORT_LEVEL: "medium",
};

// Fictional conversations. Dates are fixed rather than relative so the project
// reads the same on every machine; the panel turns them into "2 days ago".
const CLAUDE_TRANSCRIPTS = [
  ["session-0001", "fixture-1", "2026-09-19T09:12:00Z", "claude-sonnet-5", "wire the retry policy into the fetch layer"],
  ["session-0002", "fixture-2", "2026-09-19T14:40:00Z", "claude-opus-5", "summarize the release notes for 0.5.5"],
  ["session-0003", "fixture-3", "2026-09-20T08:05:00Z", "claude-sonnet-5", "explain the snapshot restore order"],
  ["session-0004", "fixture-4", "2026-09-20T16:22:00Z", "claude-sonnet-5", "drop the unused vendor shim"],
];

const CODEX_THREADS = [
  ["0192f0aa-1111-7000-8000-000000000001", "2026-09-19T10:30:00Z", "review the ledger write path for a second writer"],
  ["0192f0aa-1111-7000-8000-000000000002", "2026-09-20T11:15:00Z", "add a test for the empty catalog"],
  ["0192f0aa-1111-7000-8000-000000000003", "2026-09-20T15:45:00Z", "why does the capture re-read every rollout?"],
];

const OPENCODE_SESSIONS = [
  ["ses_fixture0000000000000001", "2026-09-19T13:05:00Z", "test the Worktree Cleanup prompt"],
  ["ses_fixture0000000000000002", "2026-09-20T09:50:00Z", "port the TUI keypress budget to a benchmark"],
];

// A Claude transcript line, the shape the CLI writes into the project's own
// portable store. The panel never sees these bytes: core's import keeps a title
// and the conversation.
function claudeTranscript(sessionId, uuid, at, model, text, projectRoot) {
  return ["user", "assistant"].map((role, index) => JSON.stringify({
    type: role,
    uuid: `${uuid}-${role}`,
    sessionId,
    timestamp: new Date(Date.parse(at) + index * 4000).toISOString(),
    cwd: projectRoot,
    message: { role, model, content: [{ type: "text", text: index === 0 ? text : `Done: ${text}` }] },
  })).join("\n") + "\n";
}

// One Codex rollout: a session_meta line naming the thread and the workspace,
// then the turns. This is the same shape Codex writes under its own home, and
// the portable copy keeps it under the project.
function codexRollout(threadId, at, text, projectRoot) {
  return [
    JSON.stringify({ type: "session_meta", payload: { id: threadId, cwd: projectRoot, model_provider: "openai" } }),
    JSON.stringify({
      timestamp: at,
      type: "response_item",
      payload: { id: `${threadId}-user`, type: "message", role: "user", content: [{ type: "input_text", text }] },
    }),
    JSON.stringify({
      timestamp: new Date(Date.parse(at) + 30_000).toISOString(),
      type: "response_item",
      payload: { id: `${threadId}-assistant`, type: "message", role: "assistant", content: [{ type: "output_text", text: `Done: ${text}` }] },
    }),
  ].join("\n") + "\n";
}

// One OpenCode session export, which is what OpenCode's own CLI produces and
// what the project's portable store holds.
function openCodeExport(sessionId, at, title, text, projectRoot) {
  const created = Date.parse(at);
  const message = (role, offset, body) => ({
    info: { id: `${sessionId}-${role}`, role, time: { created: created + offset }, modelID: "gpt-5", providerID: "openai" },
    parts: [{ type: "text", text: body }],
  });
  return `${JSON.stringify({
    id: sessionId,
    info: { id: sessionId, title, directory: projectRoot },
    messages: [message("user", 0, text), message("assistant", 30_000, `Done: ${text}`)],
  }, null, 2)}\n`;
}

/**
 * Build the fixture project. `projectRoot` is created if it is not there; the
 * caller owns `stateDir` and `home` (the Avenic state root and the agent
 * configuration home, both kept inside the run's own directory).
 *
 * Returns a digest of what the panel will render, read back through
 * `buildDashboardData` — the exact function the dashboard calls — so a fixture
 * that carries no sessions, or a card with no rows, is visible here rather
 * than in a screenshot.
 */
export async function buildHostFixture(projectRoot, { catalogDir, stateDir, home }) {
  const api = await loadFixtureApi();
  const { buildDashboardData, importProjectSessions, initialize, installPacks, invalidateAgentStatusCache, makeCatalogFixture, select, testEnv, withAgentHomes, writeApiConfiguration } = api;
  for (const directory of [projectRoot, catalogDir, stateDir, home]) mkdirSync(directory, { recursive: true });
  // testEnv is the copy the services get; the agent homes are redirected for
  // the length of the build, so nothing this fixture writes can land in a real
  // `~/.claude`, `~/.codex` or `~/.config`.
  const environment = testEnv(stateDir);

  return withAgentHomes(home, async () => {
    // 1. Claude: the project owns the API configuration.
    await initialize(projectRoot, "claude", { authMethod: "api", configScope: "project", sessionScope: "project" });
    await writeApiConfiguration(projectRoot, "claude", "project", CLAUDE_API);
    // The file Avenic just wrote, given the model block that belongs to the
    // project's own configuration rather than to Avenic's ledger.
    const settingsFile = path.join(projectRoot, ".claude", "settings.local.json");
    const settings = JSON.parse(readFileSync(settingsFile, "utf8"));
    settings.env = { ...settings.env, ...CLAUDE_MODEL_BLOCK };
    writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);

    // 2. Codex: a project-scoped account — the agent's own sign-in, its own
    // configuration home, and nothing for Avenic to write.
    await initialize(projectRoot, "codex", { authMethod: "account", accountScope: "project", sessionScope: "project" });

    // 3. OpenCode answers for its own authentication, provider and model; the
    // project records the session scope and nothing else.
    await initialize(projectRoot, "opencode", { sessionScope: "project" });

    // 4. Skills: a real catalog, selected, then one real pack install into the
    // project (the same three calls the extension's own commands make).
    await makeCatalogFixture(catalogDir);
    await select(catalogDir, environment);
    await installPacks("project", ["common"], projectRoot, environment);

    // 5. Sessions, one portable store per agent, each imported by core.
    const claudeDir = path.join(projectRoot, ".agents", "sessions", "claude");
    mkdirSync(claudeDir, { recursive: true });
    for (const [sessionId, uuid, at, model, text] of CLAUDE_TRANSCRIPTS) {
      writeFileSync(path.join(claudeDir, `${sessionId}.jsonl`), claudeTranscript(sessionId, uuid, at, model, text, projectRoot));
    }
    await importProjectSessions(projectRoot, "claude", { environment, skipCapture: true });

    // Codex keeps its rollouts under a date tree; the project's copy mirrors
    // it, which is where core's importer reads from.
    const codexDir = path.join(projectRoot, ".agents", "sessions", "codex", "sessions", "2026", "09");
    mkdirSync(codexDir, { recursive: true });
    for (const [threadId, at, text] of CODEX_THREADS) {
      const day = at.slice(8, 10);
      const directory = path.join(codexDir, day);
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, `rollout-${at.replaceAll(/[:.]/g, "-")}-${threadId}.jsonl`), codexRollout(threadId, at, text, projectRoot));
    }
    await importProjectSessions(projectRoot, "codex", { environment, skipCapture: true });

    const openCodeDir = path.join(projectRoot, ".agents", "sessions", "opencode");
    mkdirSync(openCodeDir, { recursive: true });
    for (const [sessionId, at, text] of OPENCODE_SESSIONS) {
      writeFileSync(path.join(openCodeDir, `${sessionId}.json`), openCodeExport(sessionId, at, text, text, projectRoot));
    }
    await importProjectSessions(projectRoot, "opencode", { environment, skipCapture: true });

    invalidateAgentStatusCache();
    const payload = await buildDashboardData(projectRoot, environment, { now: Date.now() });
    return {
      environment,
      digest: {
        project: payload.project.name,
        configured: payload.project.configured,
        agents: payload.agents.map((agent) => ({
          id: agent.id,
          status: agent.statusText,
          fields: agent.fields.map((field) => `${field.label}: ${field.value}`),
        })),
        sessions: {
          shared: payload.shared.total,
          claude: payload.native.claude.total,
          codex: payload.native.codex.total,
          opencode: payload.native.opencode.total,
        },
        skills: {
          installed: payload.skills.installedTotal,
          packs: payload.skills.packsTotal,
          names: payload.skills.installed.map((skill) => skill.name),
        },
        hub: payload.hub.state,
      },
    };
  });
}

// ---------------------------------------------------------------- standalone
// `node test/host/fixture.mjs [--out <dir>] [--keep]` — build one and print the
// digest, so the fixture can be read without a desktop. Removed afterwards
// unless --keep, because a fixture nobody is looking at is just litter.
const isEntry = process.argv[1] !== undefined && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isEntry) {
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 1) {
    const key = process.argv[index];
    if (key.startsWith("--")) args.set(key.slice(2), process.argv[index + 1] ?? true);
  }
  const root = typeof args.get("out") === "string" ? path.resolve(args.get("out")) : await mkdtemp(path.join(os.tmpdir(), "avenic-host-fixture-"));
  try {
    const projectRoot = path.join(root, "project");
    const built = await buildHostFixture(projectRoot, {
      catalogDir: path.join(root, "catalog"),
      stateDir: path.join(root, "state"),
      home: path.join(root, "home"),
    });
    console.log(`project ${built.digest.project} (${projectRoot})`);
    console.log(`configured ${built.digest.configured} · shared ${built.digest.sessions.shared} · claude ${built.digest.sessions.claude} · codex ${built.digest.sessions.codex} · opencode ${built.digest.sessions.opencode}`);
    console.log(`skills installed ${built.digest.skills.installed} (${built.digest.skills.names.join(", ") || "none"}) · packs ${built.digest.skills.packs} · hub ${built.digest.hub}`);
    for (const agent of built.digest.agents) console.log(`  ${agent.id.padEnd(9)} ${agent.status.padEnd(15)} ${agent.fields.join(" | ")}`);
  } finally {
    if (args.get("keep") !== true) rmSync(root, { recursive: true, force: true });
  }
}
