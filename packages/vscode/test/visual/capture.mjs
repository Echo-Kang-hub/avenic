// Capture the payloads the visual harness renders, from real projects.
//
// Every scenario below builds a throwaway project on disk with core's own calls
// (initialize / writeApiConfiguration / installPacks / importProjectSessions),
// then records what buildDashboardData — the exact function the panel calls —
// returns for it. The JSON files land in test/visual/fixtures/ and are what
// shot.mjs renders, so a scenario can never show data the host cannot produce.
//
// Usage: node test/visual/capture.mjs [--out fixtures] [--only b-fresh]
//
// Isolation: projects are made under os.tmpdir(), and each scenario runs inside
// withAgentHomes, which points CLAUDE_CONFIG_DIR / CODEX_HOME / XDG_CONFIG_HOME
// at a throwaway home for the length of the run. testEnv alone is not enough:
// it only strips AVENIC_*/AGENTHOME_* from the copy the scenarios pass around,
// while core's initialize/launch paths read the real process.env.
//
// One fixture here is not produced by this script: fixtures/a-reference.json is
// transcribed from the design image and carries a _provenance field saying which
// of its values are the reference's rather than a host's. Its `version` is the
// reference footer's "1.8.4", which is also the version this repo's own CLI
// ships — the footer names that CLI, not the extension.
//
// Writing into fixtures/ overwrites the checked-in payloads in place, so every
// file is hashed before and after and the summary names what actually changed.

import { createHash } from "node:crypto";
import { build } from "esbuild";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.resolve(here, "..", "..", ".test-out", "capture.mjs");

await build({
  bundle: true,
  format: "esm",
  platform: "node",
  outfile: bundlePath,
  entryPoints: [path.join(here, "capture-entry.ts")],
  external: ["vscode", "esbuild"],
});

const api = await import(pathToFileURL(bundlePath).href);
const { applyProjectConfiguration, buildDashboardData, initialize, invalidateAgentStatusCache, installPacks, importProjectSessions, makeCatalogFixture, select, testEnv, withAgentHomes, writeApiConfiguration } = api;

// The footer's two versions are the host's own: the panel passes the extension
// version it is running and the cached answer to "which Avenic CLI is on this
// machine" (panel.ts). Neither belongs to the fixture's project, and a capture
// running on a build machine cannot probe the machine that will read the
// fixture — so instead of guessing a host's answers, it pins the two versions
// this repo produces: the packaged extension's, and the CLI's. That keeps the
// fixture's footer saying what a host of this build would say. What it must not
// do is turn those digits into an expectation: they are this build's, and the
// reader may be running another (compare.mjs gates the footer's shape, not its
// number, for exactly that reason).
const extensionVersion = JSON.parse(await readFile(path.resolve(here, "..", "..", "package.json"), "utf8")).version;
const cliVersion = JSON.parse(await readFile(path.resolve(here, "..", "..", "..", "cli", "package.json"), "utf8")).version;

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i];
  if (key.startsWith("--")) args.set(key.slice(2), process.argv[i + 1]);
}
const outDir = path.resolve(process.cwd(), args.get("out") ?? path.join(here, "fixtures"));
const only = args.get("only") ?? null;

// A real Claude transcript line, written the way the CLI writes it. The panel
// never sees these bytes: core's import reads them and keeps only a title.
function claudeLine(sessionId, index, role, text) {
  return JSON.stringify({
    type: role,
    uuid: `fixture-${index}`,
    sessionId,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    cwd: "fixture",
    message: { role, model: "claude-sonnet-5", content: [{ type: "text", text }] },
  });
}

// The project's portable store — where the CLI leaves a transcript for Avenic to
// import. In a real machine this directory is written by the agent's own run.
async function seedClaudePortable(project, entries) {
  const dir = path.join(project, ".agents", "sessions", "claude");
  await mkdir(dir, { recursive: true });
  for (const [sessionId, lines] of entries) {
    await writeFile(path.join(dir, `${sessionId}.jsonl`), `${lines.join("\n")}\n`);
  }
}

// A compaction record is the one place Claude's own store carries a name for a
// session, and the title is taken from it exactly as written — the 80-character
// cap applies to a title derived from the first thing the user said, not to one
// the store already holds. This is how a long title really reaches the panel.
function claudeSummaryLine(sessionId, summary) {
  return JSON.stringify({ type: "summary", uuid: `fixture-summary-${sessionId}`, sessionId, summary });
}

// The launchers a scenario wants core to find. Core resolves each agent's CLI by
// name on PATH (classifyAgentExecutable -> resolveExecutable), so a directory
// holding a file called `codex` and nothing called `claude` *is* the state
// "Claude is not installed on this machine" — no mocking, no dead executable.
// The files are empty: nothing here ever runs them, and an extension-less name
// is what both the Windows and the POSIX extension lists accept.
async function shimPath(name, executables) {
  const dir = path.join(os.tmpdir(), "avenic-visual-shims", name);
  await mkdir(dir, { recursive: true });
  for (const executable of executables) await writeFile(path.join(dir, executable), "");
  return dir;
}

// PATH is the only thing that decides availability, so a scenario that means to
// show a missing CLI has to set it rather than inherit this machine's. Both
// spellings: Node on Windows hands a process `Path`, callers that build a
// minimal environment hand it `PATH`, and core reads whichever it finds first.
function pathOnlyTo(directory, env) {
  env.PATH = directory;
  env.Path = directory;
  return env;
}

// Each scenario gets a fresh tmp root, a project directory and an isolated
// AVENIC_STATE_DIR; main() runs it inside withAgentHomes so the agent config
// homes point into that same tmp root. The return value is the project and
// environment buildDashboardData reads.
const SCENARIOS = {
  // A folder nobody has configured yet: three agents, no answers, and the
  // prompt to run Configure.
  async "b-fresh"(root) {
    const project = path.join(root, "my-app");
    await mkdir(project, { recursive: true });
    return { project, env: testEnv(path.join(root, "state")) };
  },

  // OpenCode manages its own authentication and provider; the project keeps
  // isolated history. This is the "we own nothing here" card.
  async "c-native"(root) {
    const project = path.join(root, "worker");
    await mkdir(project, { recursive: true });
    const env = testEnv(path.join(root, "state"));
    await initialize(project, "opencode", { sessionScope: "project" });
    await initialize(project, "claude", { authMethod: "account", accountScope: "global", sessionScope: "project" });
    return { project, env };
  },

  // Everything at once: an API-managed Claude, a project-account Codex, real
  // installed skills from a catalog, and more sessions than the overview lists.
  async "e-full"(root) {
    const project = path.join(root, "atlas");
    const catalogDir = path.join(root, "catalog");
    await mkdir(project, { recursive: true });
    const env = testEnv(path.join(root, "state"));
    await initialize(project, "claude", { authMethod: "api", configScope: "project", sessionScope: "project" });
    await writeApiConfiguration(project, "claude", "project", {
      provider: "DeepSeek",
      baseUrl: "https://provider.fixture.invalid/v1",
      model: "deepseek-chat",
      credential: "fixture-value-not-a-real-credential",
    });
    await initialize(project, "codex", { authMethod: "account", accountScope: "project", sessionScope: "project" });
    await initialize(project, "opencode", { sessionScope: "project" });
    await makeCatalogFixture(catalogDir);
    await select(catalogDir, env);
    await installPacks("project", ["common"], project, env);
    await seedClaudePortable(project, [
      ["session-0001", [claudeLine("session-0001", 1, "user", "wire the retry policy into the fetch layer")]],
      ["session-0002", [claudeLine("session-0002", 1, "user", "why does the ledger re-read every account?")]],
      ["session-0003", [claudeLine("session-0003", 1, "user", "drop the unused vendor shim")]],
      ["session-0004", [claudeLine("session-0004", 1, "user", "add a test for the empty catalog")]],
      ["session-0005", [claudeLine("session-0005", 1, "user", "explain the snapshot restore order")]],
      ["session-0006", [claudeLine("session-0006", 1, "user", "summarise this week's changes")]],
    ]);
    await importProjectSessions(project, "claude", { environment: env, skipCapture: true });
    invalidateAgentStatusCache();
    return { project, env };
  },

  // The other history mode: the project keeps one conversation list per agent,
  // so the Shared Sessions card draws its "shared history is off" state and its
  // header offers the switch — a branch no other fixture reaches.
  async "d-isolated"(root) {
    const project = path.join(root, "solo");
    await mkdir(project, { recursive: true });
    const env = pathOnlyTo(await shimPath("d-isolated", ["claude", "codex", "opencode"]), testEnv(path.join(root, "state")));
    await initialize(project, "claude", { authMethod: "api", configScope: "project", sessionScope: "project" });
    await writeApiConfiguration(project, "claude", "project", {
      provider: "DeepSeek",
      baseUrl: "https://provider.fixture.invalid/v1",
      model: "deepseek-chat",
      credential: "fixture-value-not-a-real-credential",
    });
    await seedClaudePortable(project, [
      ["session-0001", [claudeLine("session-0001", 1, "user", "make the isolated list show what it has")]],
      ["session-0002", [claudeLine("session-0002", 1, "user", "why is this project's history its own?")]],
    ]);
    await importProjectSessions(project, "claude", { environment: env, skipCapture: true });
    // The wizard's own commit path, which is what the dashboard's "Switch to
    // Shared" action goes through in reverse: the mode is a project answer, so
    // it is written as one.
    await applyProjectConfiguration(project, { historyMode: "isolated" }, { environment: env });
    return { project, env };
  },

  // Configured for all three, but Claude's CLI is not on this machine. Its card
  // is the only one that says "CLI not installed", and its Launch is off while
  // Change stays on — the state where the remedy is an install, not a config.
  async "f-no-claude"(root) {
    const project = path.join(root, "half-installed");
    await mkdir(project, { recursive: true });
    const env = pathOnlyTo(await shimPath("f-no-claude", ["codex", "opencode"]), testEnv(path.join(root, "state")));
    await initialize(project, "claude", { authMethod: "account", accountScope: "project", sessionScope: "project" });
    await initialize(project, "codex", { authMethod: "account", accountScope: "project", sessionScope: "project" });
    await initialize(project, "opencode", { sessionScope: "project" });
    return { project, env };
  },

  // The same gap on the other agent, so "one card says CLI not installed" cannot
  // pass by pointing at the wrong card.
  async "g-no-codex"(root) {
    const project = path.join(root, "half-installed");
    await mkdir(project, { recursive: true });
    const env = pathOnlyTo(await shimPath("g-no-codex", ["claude", "opencode"]), testEnv(path.join(root, "state")));
    await initialize(project, "claude", { authMethod: "account", accountScope: "project", sessionScope: "project" });
    await initialize(project, "codex", { authMethod: "account", accountScope: "project", sessionScope: "project" });
    await initialize(project, "opencode", { sessionScope: "project" });
    return { project, env };
  },

  // Everything configured and ready, and nothing to show: no session imported,
  // no pack installed, the registry never synced. The Overview's empty states
  // are the whole picture here.
  async "j-bare"(root) {
    const project = path.join(root, "empty-shelf");
    await mkdir(project, { recursive: true });
    const env = pathOnlyTo(await shimPath("j-bare", ["claude", "codex", "opencode"]), testEnv(path.join(root, "state")));
    await initialize(project, "claude", { authMethod: "account", accountScope: "project", sessionScope: "project" });
    await initialize(project, "codex", { authMethod: "account", accountScope: "project", sessionScope: "project" });
    await initialize(project, "opencode", { sessionScope: "project" });
    return { project, env };
  },

  // Text that is longer than the room it gets: a session whose own store named
  // it in a full sentence, and an API configuration whose provider and model are
  // as long as real ones get. Both are ordinary values, not malformed input —
  // the question is whether the cards ellipsize them or push them over an edge.
  async "h-long-text"(root) {
    const project = path.join(root, "long-names");
    await mkdir(project, { recursive: true });
    const env = pathOnlyTo(await shimPath("h-long-text", ["claude", "codex", "opencode"]), testEnv(path.join(root, "state")));
    await initialize(project, "claude", { authMethod: "api", configScope: "project", sessionScope: "project" });
    await writeApiConfiguration(project, "claude", "project", {
      provider: "DeepSeek Internal Platform Team (apac-production-cluster-2)",
      baseUrl: "https://provider.fixture.invalid/v1",
      model: "deepseek-ai/DeepSeek-V3.2-Reasoning-Preview-2026-08-14",
      credential: "fixture-value-not-a-real-credential",
    });
    await seedClaudePortable(project, [
      ["session-0001", [
        claudeSummaryLine("session-0001", "Refactor the retry policy so a capped account backs off instead of failing the whole batch, and keep the ledger's ordering guarantees intact while the writer is paused."),
        claudeLine("session-0001", 1, "user", "the summary above is the title"),
      ]],
      ["session-0002", [claudeLine("session-0002", 1, "user", "short one, for contrast")]],
    ]);
    await importProjectSessions(project, "claude", { environment: env, skipCapture: true });
    return { project, env };
  },
};

const short = (value) => createHash("sha256").update(value).digest("hex").slice(0, 12);

// null when the file does not exist yet, so the summary can tell "new" from
// "changed".
async function hashOf(file) {
  try {
    return short(await readFile(file));
  } catch {
    return null;
  }
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const names = Object.keys(SCENARIOS).filter((name) => only === null || name === only);
  const changed = [];
  for (const name of names) {
    const root = await mkdtemp(path.join(os.tmpdir(), `avenic-visual-${name}-`));
    // The redirected home is a fixed path rather than a directory under the
    // random tmp root: a payload that reports a global-scope location (c-native's
    // Claude account) would otherwise carry this run's mkdtemp suffix and make
    // the fixture differ on every capture for no reason.
    const home = path.join(os.tmpdir(), "avenic-visual-home", name);
    try {
      // The scenario, and the payload built from it, run with the agent config
      // homes pointed into that throwaway home — the same redirect the host
      // check and the test suite use (testEnv only trims the env copy).
      const captured = await withAgentHomes(home, async () => {
        const { project, env } = await SCENARIOS[name](root);
        invalidateAgentStatusCache();
        const payload = await buildDashboardData(project, env, { cliVersion, extensionVersion });
        // Paths under this throwaway root are this machine's, not the panel's
        // subject: keep the last segment (the folder's own name) and drop the rest.
        const local = (value) => (typeof value === "string" && value.includes(root) ? path.basename(value) : value);
        const fixture = {
          ...payload,
          project: { ...payload.project, root: local(payload.project.root) },
          hub: { ...payload.hub, spec: local(payload.hub.spec) },
        };
        const text = `${JSON.stringify(fixture, null, 2)}\n`;
        const file = path.join(outDir, `${name}.json`);
        const before = await hashOf(file);
        await writeFile(file, text, "utf8");
        return { payload, file, before, after: short(text) };
      });
      const { payload } = captured;
      const rel = path.relative(process.cwd(), captured.file).replaceAll("\\", "/");
      const how = captured.before === null
        ? `new ${captured.after}`
        : captured.before === captured.after
          ? `unchanged ${captured.after}`
          : `changed ${captured.before} → ${captured.after}`;
      if (captured.before !== null && captured.before !== captured.after) changed.push(rel);
      console.log(`captured ${name.padEnd(10)} agents ${payload.agents.map((a) => `${a.id}:${a.fields.length}f`).join(" ")} · sessions ${payload.shared.total}+${Object.values(payload.native).reduce((n, r) => n + r.total, 0)} · skills ${payload.skills.installedTotal}`);
      console.log(`  ${rel}  ${how}`);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(home, { recursive: true, force: true });
    }
  }
  if (changed.length > 0) console.log(`\nrewrote ${changed.length} fixture file(s): ${changed.join(", ")} — review the diff before committing`);
}

await main();
