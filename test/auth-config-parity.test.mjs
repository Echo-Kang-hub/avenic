import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { machineEnvironment, initializeAgent, resolveEffectiveAgentRuntime } from "../packages/core/src/index.mjs";
import { sessionLeasePath } from "../packages/core/src/runtime/sessions.mjs";
import { withClaudeProject } from "./helpers/session-fixture.mjs";

// The first promise of the product is that `avenic claude` is `claude`. A user
// who configured a provider in `.claude/settings.local.json` (a third-party
// endpoint, a model, an API credential) must keep exactly that configuration
// when the launch goes through Avenic: same config root, same credentials, same
// project settings, same provider environment.
//
// Exactly one answer moves the agent's own configuration root, and it is the
// one that means to: **Account at the project scope**, where the project's
// sign-in has to live in the project. Everything else — a global account, and
// both API scopes, whose configuration is the agent's native file — hands the
// agent the world it would have had. The user's own environment is never
// mutated in place to achieve either.
//
// These tests pin the invariants where they can be checked honestly: what the
// agent process can actually see at spawn.

const CONFIG_ROOT_VARIABLE = {
  claude: "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
  opencode: "XDG_CONFIG_HOME",
};

const PROVIDER_ENVIRONMENT = {
  ANTHROPIC_BASE_URL: "https://api.deepseek.invalid/anthropic",
  ANTHROPIC_AUTH_TOKEN: "FAKE-not-a-real-token-000000000000",
  ANTHROPIC_MODEL: "deepseek-flash",
  ANTHROPIC_DEFAULT_FABLE_MODEL: "deepseek-flash",
};

async function filesUnder(directory) {
  const found = [];
  const walk = async (current) => {
    let entries = [];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(target);
      else found.push(target);
    }
  };
  await walk(directory);
  return found;
}

async function digest(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

test("only a project-scoped account repoints an agent's config root", async () => {
  // A machine where the user has pointed the agents at their own config homes
  // is the machine this must hold on. A global account and both API scopes
  // leave that machine alone; a project account points that one agent at the
  // project's own home — and even then, only the copy handed to the child
  // changes, never the process environment it was built from.
  //
  // The sentinel homes are real temporary directories, not a path spelled out
  // to look unwritable: an API answer at the global scope *does* prepare a file
  // in the user's own config root — inside the test's own temp tree, and never
  // in the machine the test runs on.
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-auth-scope-"));
  const machine = await mkdtemp(path.join(root, "machine-home-"));
  const sentinels = {
    CLAUDE_CONFIG_DIR: path.join(machine, ".claude"),
    CODEX_HOME: path.join(machine, ".codex"),
    XDG_CONFIG_HOME: path.join(machine, ".config"),
  };
  const saved = Object.fromEntries(Object.keys(sentinels).map((name) => [name, process.env[name]]));
  Object.assign(process.env, sentinels);
  // Where each answer's file goes: the project's own, and the user's own.
  const targets = {
    claude: { project: ".claude/settings.local.json", global: path.join(sentinels.CLAUDE_CONFIG_DIR, "settings.json") },
    codex: { project: ".agents/local/codex/config.toml", global: path.join(sentinels.CODEX_HOME, "config.toml") },
  };
  try {
    for (const agentId of ["claude", "codex"]) {
      const variable = CONFIG_ROOT_VARIABLE[agentId];
      for (const sessionScope of ["global", "project"]) {
        const answers = [
          { authMethod: "account", accountScope: "global" },
          { authMethod: "account", accountScope: "project" },
          { authMethod: "api", configScope: "global" },
          { authMethod: "api", configScope: "project" },
        ];
        for (const answer of answers) {
          const scope = answer.accountScope ?? answer.configScope;
          const label = `${agentId} ${answer.authMethod}/${scope}/${sessionScope}`;
          // One project per combination: "this answer prepared this file" is a
          // claim about a run, and a shared directory would carry the last run's
          // leftovers into the next one's negative half.
          const projectRoot = await mkdtemp(path.join(root, `${agentId}-${scope}-${sessionScope}-`));
          await initializeAgent(projectRoot, agentId, { ...answer, sessionScope });
          const runtime = await resolveEffectiveAgentRuntime(projectRoot, agentId, { environment: machineEnvironment() });
          // Two answers move the agent's own home, each for its own reason: a
          // project account, whose sign-in has to live in the project, and a
          // project Codex API configuration — Codex has no project-scope
          // configuration file of its own, so the project's answer *is* a home
          // the project owns, and it reaches Codex through Codex's own variable.
          const ownHome = scope === "project" && (answer.authMethod === "account" || agentId === "codex");
          assert.equal(
            runtime.environment[variable],
            ownHome ? path.join(projectRoot, ".agents", "local", agentId) : sentinels[variable],
            `${label} must hand the child ${ownHome ? "the project's own home" : "the user's own home"}`,
          );
          assert.equal(machineEnvironment()[variable], sentinels[variable], `${label} must not mutate the environment it reads from`);
          if (answer.authMethod === "api") {
            // The answer names a file, so the answer leaves that file where the
            // agent will look. And a global answer stays global: the project's
            // own file is not an alternative spelling of "the user's file".
            const named = scope === "project" ? path.join(projectRoot, targets[agentId].project) : targets[agentId].global;
            assert.equal(existsSync(named), true, `${label} prepares the file it names`);
            if (scope === "global") {
              assert.equal(existsSync(path.join(projectRoot, targets[agentId].project)), false, `${label} writes no project file`);
            }
          }
        }
      }
    }
    // OpenCode's configuration root is its own business whatever the project
    // answers: Avenic records a session choice for it and nothing else.
    await initializeAgent(root, "opencode", { sessionScope: "project" });
    assert.equal(machineEnvironment().XDG_CONFIG_HOME, sentinels.XDG_CONFIG_HOME);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("every method and scope hands Claude exactly the world it should", async () => {
  const combinations = [];
  for (const [authMethod, scope] of [["account", "global"], ["account", "project"], ["api", "global"], ["api", "project"]]) {
    for (const sessionScope of ["global", "project"]) combinations.push({ authMethod, scope, sessionScope });
  }
  for (const { authMethod, scope, sessionScope } of combinations) {
    const label = `${authMethod}/${scope}/${sessionScope}`;
    const entry = authMethod === "account"
      ? { authMethod, accountScope: scope, sessionScope }
      : { authMethod, configScope: scope, sessionScope };
    await withClaudeProject(async ({ projectRoot, home, environment, launch }) => {
      // The machine this is about: credentials exist in the user's config
      // root, and the project's own settings point at a third-party provider.
      // A launch that lands the agent somewhere it did not ask for forces a
      // fresh login and silently drops the provider.
      await writeFile(
        path.join(home, ".claude", ".credentials.json"),
        `${JSON.stringify({ fixture: "the user's own credentials live here" })}\n`,
      );
      await mkdir(path.join(projectRoot, ".claude"), { recursive: true });
      await writeFile(
        path.join(projectRoot, ".claude", "settings.local.json"),
        `${JSON.stringify({ env: PROVIDER_ENVIRONMENT }, null, 2)}\n`,
      );

      const result = await launch(["claude"]);
      assert.equal(result.status, 0, `${label}: ${result.stderr}`);
      const probe = result.probe;
      assert.ok(probe, `${label}: the agent must have started`);
      assert.equal(path.resolve(probe.cwd), path.resolve(projectRoot), `${label}: the agent runs in the project`);
      // The one answer that moves the config root, and where it moves it to.
      const isolated = authMethod === "account" && scope === "project";
      assert.equal(
        path.resolve(probe.configDir ?? probe.configRoot),
        path.resolve(isolated ? path.join(projectRoot, ".agents", "local", "claude") : environment.CLAUDE_CONFIG_DIR),
        `${label}: Claude's config root`,
      );
      assert.equal(probe.credentials, !isolated, `${label}: the user's own sign-in is visible exactly when the account is the user's`);
      assert.equal(probe.settingsLocal, true, `${label}: the project's settings stay where Claude looks for them`);
      assert.deepEqual(probe.argv, [], `${label}: a plain launch is a new conversation`);
    }, { agents: { claude: entry } });
  }
});

test("direct `claude` and `avenic claude` see the same world", async () => {
  await withClaudeProject(async ({ projectRoot, home, environment, launch, directAgent }) => {
    await writeFile(
      path.join(home, ".claude", ".credentials.json"),
      `${JSON.stringify({ fixture: "the user's own credentials live here" })}\n`,
    );
    await mkdir(path.join(projectRoot, ".claude"), { recursive: true });
    await writeFile(
      path.join(projectRoot, ".claude", "settings.local.json"),
      `${JSON.stringify({ env: PROVIDER_ENVIRONMENT }, null, 2)}\n`,
    );
    const overrides = { ...PROVIDER_ENVIRONMENT };

    const direct = await directAgent([], overrides);
    assert.equal(direct.status, 0, direct.stderr);
    const wrapped = await launch(["claude"], overrides);
    assert.equal(wrapped.status, 0, wrapped.stderr);
    assert.ok(direct.probe && wrapped.probe, "both legs must have started the agent");

    // Everything except the clock must be identical: same cwd, same argv, same
    // config root, same credentials visibility, same project settings, same
    // provider secrets. This is the differential the P0 was reported from.
    const strip = ({ startedAt, wroteAt, ...rest }) => rest;
    assert.deepEqual(strip(wrapped.probe), strip(direct.probe));
  }, { agents: { claude: { authMethod: "api", configScope: "project", sessionScope: "project" } } });
});

test("a launch keeps the terminal's own words, whatever the terminal is", async () => {
  // A terminal describes itself to the programs it runs: `TERM_PROGRAM=vscode`
  // and the VSCODE_* IPC handles are how the official CLI finds the editor it
  // was started from. A wrapper that dropped one of them would silently turn
  // off IDE integration — a change in how the terminal presents the agent,
  // which is not Avenic's to make. A wrapper that invented one would be
  // pretending to be a terminal it is not. So the differential is run inside a
  // terminal that says what VS Code's terminals say, and both legs must see
  // every one of those names.
  const vscodeTerminal = {
    TERM: "xterm-256color",
    TERM_PROGRAM: "vscode",
    TERM_PROGRAM_VERSION: "1.105.0",
    COLORTERM: "truecolor",
    VSCODE_INJECTION: "1",
    VSCODE_IPC_HOOK: "\\\\.\\pipe\\vscode-ipc-fixture",
    VSCODE_IPC_HOOK_CLI: "\\\\.\\pipe\\vscode-ipc-cli-fixture",
    VSCODE_GIT_IPC_HANDLE: "\\\\.\\pipe\\vscode-git-fixture",
    VSCODE_CWD: "fixture-workspace",
    VSCODE_PID: "4242",
    VSCODE_NLS_CONFIG: "fixture-locale",
  };
  await withClaudeProject(async ({ projectRoot, home, launch, directAgent }) => {
    await writeFile(
      path.join(home, ".claude", ".credentials.json"),
      `${JSON.stringify({ fixture: "the user's own credentials live here" })}\n`,
    );
    await mkdir(path.join(projectRoot, ".claude"), { recursive: true });
    await writeFile(
      path.join(projectRoot, ".claude", "settings.local.json"),
      `${JSON.stringify({ env: PROVIDER_ENVIRONMENT }, null, 2)}\n`,
    );
    const overrides = { ...PROVIDER_ENVIRONMENT, ...vscodeTerminal };

    const direct = await directAgent([], overrides);
    assert.equal(direct.status, 0, direct.stderr);
    const wrapped = await launch(["claude"], overrides);
    assert.equal(wrapped.status, 0, wrapped.stderr);
    assert.ok(direct.probe && wrapped.probe, "both legs must have started the agent");

    for (const name of Object.keys(vscodeTerminal)) {
      assert.equal(direct.probe.presentation[name], true, `the terminal's ${name} must reach a direct launch`);
      assert.equal(wrapped.probe.presentation[name], true, `the launch must not swallow the terminal's ${name}`);
    }
    // And the legs agree on the whole picture, presentation included.
    const strip = ({ startedAt, wroteAt, ...rest }) => rest;
    assert.deepEqual(strip(wrapped.probe), strip(direct.probe));
  }, { agents: { claude: { authMethod: "api", configScope: "project", sessionScope: "project" } } });
});

test("the live child keeps the provider secrets while the durable state never records them", async () => {
  // "Do not persist secrets" must never mean "strip secrets from the live
  // agent": the process that pays for the run needs them, the files that
  // outlive it must not have them.
  await withClaudeProject(async ({ projectRoot, nativeFile, launchAsync, root }) => {
    const FAKE_SECRETS = {
      ANTHROPIC_AUTH_TOKEN: "FAKE-auth-token-0000000000000000",
      ANTHROPIC_API_KEY: "FAKE-api-key-000000000000000000",
      OPENAI_API_KEY: "FAKE-openai-000000000000000000",
      DEEPSEEK_API_KEY: "FAKE-deepseek-0000000000000000",
      GITHUB_TOKEN: "FAKE-github-00000000000000000000",
    };
    const runId = "bbbb0000-0000-4000-8000-000000000001";
    const run = await launchAsync(["claude"], {
      ...FAKE_SECRETS,
      AVENIC_AGENT_WRITE: JSON.stringify({ file: nativeFile(runId), records: 4, sleepMs: 1200 }),
    }, { keepOutput: true });

    // While the agent is alive, the launch state file exists; it is the file
    // the P0-2 audit is about, so it must be the one that gets scanned.
    const stateDir = sessionLeasePath("claude", projectRoot);
    const watchdogFile = path.join(stateDir, "watchdog.json");
    const deadline = Date.now() + 6000;
    while (!existsSync(watchdogFile) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(existsSync(watchdogFile), true, "the launch state file under test must exist while the agent runs");
    const watched = await readFile(watchdogFile, "utf8");
    for (const [name, value] of Object.entries(FAKE_SECRETS)) {
      assert.equal(watched.includes(value), false, `${name} must never reach the launch state`);
    }

    const { status } = await run.completion;
    assert.equal(status, 0, run.output());
    const probe = await run.probe();
    for (const name of Object.keys(FAKE_SECRETS)) {
      assert.equal(probe.secretsSeen[name], true, `the live agent must have seen ${name}`);
    }

    // The durable stores the launch leaves behind: launch state, project
    // state, the fixture's state root. None may hold a fake secret's value.
    const stores = [stateDir, path.join(projectRoot, ".agents"), path.join(root, "state")];
    const scanned = [];
    for (const store of stores) {
      for (const file of await filesUnder(store)) {
        scanned.push(file);
        const content = await readFile(file, "utf8");
        for (const [name, value] of Object.entries(FAKE_SECRETS)) {
          assert.equal(content.includes(value), false, `${name} must not be written to ${path.relative(root, file)}`);
        }
      }
    }
    assert.ok(scanned.length > 0, "the scan itself must have looked at real files");
  }, { agents: { claude: { authMethod: "api", configScope: "project", sessionScope: "project" } } });
});

test("three launches leave .claude/settings.local.json byte-for-byte", async () => {
  await withClaudeProject(async ({ projectRoot, launch }) => {
    await mkdir(path.join(projectRoot, ".claude"), { recursive: true });
    const settingsFile = path.join(projectRoot, ".claude", "settings.local.json");
    await writeFile(settingsFile, `${JSON.stringify({ env: PROVIDER_ENVIRONMENT, permissions: { allow: ["Bash(ls:*)"] } }, null, 2)}\n`);
    const before = await digest(settingsFile);

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const result = await launch(["claude"]);
      assert.equal(result.status, 0, `launch ${attempt}: ${result.stderr}`);
      assert.equal(await digest(settingsFile), before, `launch ${attempt} must not move one byte of the project settings`);
    }

    // And it is not a session artifact anywhere else either: the project
    // state must not hold a copy of what is the user's file.
    const stored = await filesUnder(path.join(projectRoot, ".agents"));
    assert.equal(stored.some((file) => file.endsWith("settings.local.json")), false);
  }, { agents: { claude: { authMethod: "api", configScope: "project", sessionScope: "project" } } });
});

test(".claude is never a session artifact: capture and revert only touch session storage", async () => {
  await withClaudeProject(async ({ projectRoot, nativeFile, launchAsync }) => {
    await mkdir(path.join(projectRoot, ".claude", "skills", "demo"), { recursive: true });
    const settingsFile = path.join(projectRoot, ".claude", "settings.local.json");
    const skillFile = path.join(projectRoot, ".claude", "skills", "demo", "SKILL.md");
    await writeFile(settingsFile, `${JSON.stringify({ env: PROVIDER_ENVIRONMENT }, null, 2)}\n`);
    await writeFile(skillFile, "# demo\n");
    const settingsDigest = await digest(settingsFile);
    const skillDigest = await digest(skillFile);

    // A run that writes a real conversation, so snapshot/capture/revert do
    // actual work on this project's session storage.
    const runId = "cccc0000-0000-4000-8000-000000000001";
    const run = await launchAsync(["claude"], {
      AVENIC_AGENT_WRITE: JSON.stringify({ file: nativeFile(runId), records: 4, sleepMs: 0 }),
    }, { keepOutput: true });
    const { status } = await run.completion;
    assert.equal(status, 0, run.output());

    assert.equal(await digest(settingsFile), settingsDigest, "the user's settings must survive capture and revert");
    assert.equal(await digest(skillFile), skillDigest, "the project's skills must survive capture and revert");
    assert.equal(existsSync(nativeFile(runId)), false, "the run's session is still the session-storage side that moves");
  }, { agents: { claude: { authMethod: "api", configScope: "project", sessionScope: "project" } } });
});
