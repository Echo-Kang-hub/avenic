import path from "node:path";
import process from "node:process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  AGENTS,
  agentLabel,
  applyProjectConfiguration,
  agentEnvironment,
  agentExecutableAvailable,
  clearLocalAuth,
  deinitializeAgent,
  effectiveAgentConfig,
  getAgent,
  getActiveCanonicalSessionId,
  getSessionAdapter,
  git,
  initializeAgent,
  importProjectSessions,
  recoverSharedNativeSessions,
  loadRuntime,
  locateProjectRoot,
  listCanonicalSessions,
  captureCanonicalSession,
  reconcileCanonicalSession,
  continueCanonicalSession,
  continuationLaunchArguments,
  prepareCanonicalContinuation,
  projectCanonicalSession,
  readCanonicalSession,
  projectConfig,
  sessionsGitIgnored,
  setLocalAuth,
  setSessionsGitIgnored,
  setActiveCanonicalSession,
  transcriptModel,
  validateAuthMode,
  validateSessionInteropMode,
  validateSessionsMode,
} from "#core";
import { dispatchModel } from "./model-cli.mjs";
import { dispatchHub, dispatchSkills } from "./skills-cli.mjs";
import { updateAvenic } from "./self-update.mjs";
import { takeOption } from "./options.mjs";
import { banner, collectLines, confirm, field, intro, isInteractive, multiSelect, note, palette, searchableSelect, section, singleSelect } from "./prompts.mjs";
import { launchAgent, reportSessionDiagnostics } from "./launch.mjs";
import { loadTranscript, printTranscript, transcriptPreview } from "./transcript-cli.mjs";
import { dispatchStatusCommand } from "./status-cli.mjs";
import { mark, reportLaunchTiming, timed } from "#core/runtime/timing.mjs";

// Everything above this line is the price of being able to answer the command
// at all: node starting, then the CLI and core modules loading.
mark("modules");

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const packageVersion = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")).version;

// Skills verbs that are also accepted at the top level. Each one is the same
// command under `avenic skills`, so the top-level spelling says so and then
// runs the identical code path — there is no second implementation to keep in
// step, and nothing to remove later beyond these seven words.
const LEGACY_SKILLS_VERBS = new Set(["add", "remove", "adopt", "install", "uninstall", "packs", "tree"]);

function parseAgentList(value) {
  const agents = value.split(",").filter(Boolean);
  if (agents.length === 0) throw new Error("Select at least one agent");
  for (const agentId of agents) getAgent(agentId);
  return [...new Set(agents)];
}

// The configuration as rows: one per enabled agent, then the history mode.
function configurationRows(config) {
  const agentRows = Object.entries(config.agents)
    .map(([agentId, entry]) => [getAgent(agentId).displayName, `${entry.auth} auth · ${entry.sessions} sessions`]);
  return [["Agents", agentRows], ["History", [["Mode", config.sessionInterop]]]];
}

/**
 * A result block, drawn by the one terminal layer: the ◆ heading over the
 * project it is about, then a ◇ section per question with a │ line per answer.
 * Every command that reports what it did ends in this shape, so a result has
 * the same rails and colours as the wizard that produced it and as
 * `avenic status`. `labelWidth` is fixed per command rather than measured, so
 * a value column never re-flows between two runs of the same command.
 */
function printResult(title, projectRoot, groups, options = {}) {
  const { sink, flush } = collectLines(options.io ?? console);
  const labelWidth = options.labelWidth ?? 14;
  // A flat [[label, value], …] is one unnamed group; [[title, rows], …] is several.
  const sections = Array.isArray(groups[0]?.[1]) ? groups : [[null, groups]];
  intro(sink, title, { description: projectRoot });
  for (const [sectionTitle, rows] of sections) {
    sink.write("\n");
    if (sectionTitle) section(sink, sectionTitle);
    for (const [label, value] of rows) field(sink, label, value, { labelWidth });
  }
  flush();
}

// The registry is keyed by agent id; a picker needs the id next to the name.
function agentChoices() {
  return Object.entries(AGENTS).map(([id, agent]) => ({ value: id, label: agent.displayName }));
}

async function interactiveProjectDraft(projectRoot, editing = false, prompts = {}) {
  const state = await loadRuntime(projectRoot);
  const current = projectConfig(state);
  const selected = await multiSelect({
    ...prompts,
    title: editing ? "Select enabled agents" : "Select agents",
    options: agentChoices(),
    initial: Object.keys(current.agents),
    minSelected: 1,
  });
  if (selected === null) return null;
  if (selected.length === 0) throw new Error("Select at least one agent");
  const agents = {};
  for (const agentId of selected) {
    const previous = current.agents[agentId] ?? { auth: "global", sessions: "project" };
    const auth = await singleSelect({
      ...prompts,
      title: `${getAgent(agentId).displayName} authentication`,
      options: [
        { value: "global", label: "Global" },
        { value: "project", label: "Project" },
      ],
      initial: previous.auth === "project" ? 1 : 0,
    });
    if (auth === null) return null;
    const sessions = await singleSelect({
      ...prompts,
      title: `${getAgent(agentId).displayName} session storage`,
      options: [
        { value: "global", label: "Global" },
        { value: "project", label: "Project" },
      ],
      initial: previous.sessions === "project" ? 1 : 0,
    });
    if (sessions === null) return null;
    agents[agentId] = { auth, sessions };
  }
  const sessionInterop = await singleSelect({
    ...prompts,
    title: "Session history",
    options: [
      { value: "shared", label: "Shared — selected agents can continue the same Avenic history" },
      { value: "isolated", label: "Isolated — each agent keeps independent histories" },
    ],
    initial: current.sessionInterop === "isolated" ? 1 : 0,
  });
  if (sessionInterop === null) return null;
  return { agents, sessionInterop };
}

async function dispatchProjectSetup(argumentsList, editing = false, options = {}) {
  const prompts = options.prompts ?? {};
  const projectRoot = options.projectRootOverride ?? locateProjectRoot();
  let draft;
  if (argumentsList.length === 0 && isInteractive(prompts)) {
    banner(prompts.stdout);
    draft = await interactiveProjectDraft(projectRoot, editing, prompts);
    if (!draft) return 0;
    console.log();
    printResult("Avenic project configuration", projectRoot, configurationRows(draft), { labelWidth: 13 });
    console.log();
    if (await confirm({ ...prompts, title: "Apply configuration?" }) !== true) return 0;
  } else {
    const values = [...argumentsList];
    const replaceAgentsIndex = values.indexOf("--replace-agents");
    const replaceAgents = replaceAgentsIndex !== -1;
    if (replaceAgents) values.splice(replaceAgentsIndex, 1);
    const agentsOption = takeOption(values, "--agents");
    const auth = takeOption(values, "--auth");
    const sessions = takeOption(values, "--sessions");
    const history = takeOption(values, "--history");
    if (values.length > 0) throw new Error(`Unknown option: ${values[0]}`);
    const current = projectConfig(await loadRuntime(projectRoot));
    const ids = agentsOption ? parseAgentList(agentsOption) : Object.keys(current.agents);
    if (ids.length === 0) throw new Error("Usage: avenic init --agents <claude,codex,opencode> [--auth global|project] [--sessions global|project] [--history shared|isolated]");
    const authMode = auth ? validateAuthMode(auth) : null;
    const sessionsMode = sessions ? validateSessionsMode(sessions) : null;
    const sessionInterop = history ? validateSessionInteropMode(history) : current.sessionInterop;
    // `change --agents codex --auth project` updates Codex without silently
    // disabling Claude/OpenCode. Replacing the enabled set is explicit; the
    // interactive picker already has that explicit whole-list semantics.
    const agents = editing && !replaceAgents
      ? Object.fromEntries(Object.entries(current.agents).map(([agentId, entry]) => [agentId, { ...entry }]))
      : {};
    for (const agentId of ids) {
      const previous = current.agents[agentId] ?? { auth: "global", sessions: "project" };
      agents[agentId] = { auth: authMode ?? previous.auth, sessions: sessionsMode ?? previous.sessions };
    }
    draft = { agents, sessionInterop };
  }
  const result = await applyProjectConfiguration(projectRoot, draft);
  printResult(`Avenic project ${editing ? "updated" : "initialized"}`, projectRoot, configurationRows(result.config), { labelWidth: 13 });
  if (result.imported.length) console.log(`Imported native histories from ${result.imported.length} agent(s) into the shared workspace.`);
  // Reconfiguring is also a moment to look for history that was left behind,
  // since the next launch deliberately does not.
  if (result.config.sessionInterop === "shared" && result.imported.length === 0) {
    const { imported } = await reconcileSharedHistory(projectRoot, await loadRuntime(projectRoot));
    if (imported > 0) console.log(`Imported ${imported} session(s) into the shared workspace.`);
  }
  return 0;
}

export function printHelp(io = console) {
  io.log(`Avenic ${packageVersion}

CLI: avenic (shorthand: ave)

Everyday use:
  avenic init                         Set up this project (interactive on a terminal)
  avenic claude | codex | opencode    Start an agent's own TUI
  avenic status                       What this project is, and what state it is in
  avenic skills                       Manage Skills (interactive menu on a terminal)
  avenic sessions                     Manage shared sessions (interactive)
  avenic change                       Change auth, session storage or history mode
  avenic self-update                  Update Avenic from the registry
  avenic --version                    Print the installed version

Options for init/change:
  --agents <claude,codex,opencode>  --replace-agents  Replace the enabled set
  --auth global|project             Credentials from your machine, or from this project
  --sessions global|project         Keep sessions in the agent's own storage, or in the project
  --history shared|isolated         One shared history across agents, or separate histories
Shared history starts empty and is imported from whatever the agents already
have; isolated histories are imported on request with \`avenic sessions sync\`.

Sessions:
  avenic sessions list|status          Show shared history and per-agent cursors
  avenic sessions show <id> [--json]   Read one shared conversation as a transcript
  avenic sessions continue <id> --agent <claude|codex|opencode>
  avenic sessions sync                 Import native history into the shared workspace
  avenic sessions git [on|off|status]  Whether project session records are committed

Per-agent commands (thin wrappers over the project settings):
  avenic <claude|codex|opencode> init [--auth global|project] [--sessions global|project]
  avenic <claude|codex|opencode> deinit [--purge]
  avenic <claude|codex|opencode> auth [global|project|reset]
  avenic <claude|codex|opencode> status
  avenic <claude|codex|opencode> sessions [import|writeback|status]
  avenic <claude|codex|opencode> [official CLI arguments...]

Status:
  avenic status [--json]              Project, history, agents and Skills in one view

Skills:
  avenic skills                       Open the Skills menu (interactive on a terminal)
  avenic skills install [pack...]     Install Packs (no args: interactive multi-select on a terminal; scripts fall back to common)
  avenic skills [pack...]             Shorthand for skills install
  avenic skills add <owner/repo> [skill...] [-g]    Install directly from a GitHub repo
  avenic skills adopt <skill...> [-g] Adopt existing on-disk Skills into management
  avenic skills remove <skill...>     Remove external, unmanaged Skills
  avenic skills uninstall <pack...>   Remove Packs and unneeded managed Skills
  avenic skills uninstall             Remove all managed Skills (Yes/No confirm on a terminal)
  avenic skills tree [pack...]        Show source -> Skill tree
  avenic skills packs                 List available Packs
  avenic skills status [-g]           Show the installed tree
  -g, --global                        Use the global user scope

Hub:
  avenic hub add <spec>               Add a Hub source (owner/repo[#ref], URL, or local path) and preview its Packs
  avenic hub select [name|spec]       Pick the current Hub from registered ones (interactive picker on a terminal)
  avenic hub list                     List registered Hubs
  avenic hub sync                     Fetch or update the cached Hub
  avenic hub default                  Show the configured Hub spec
  Private repos use your local git credentials (gh auth login or SSH)
  avenic hub doctor|update|skill-add|remove|pack-add|pack-remove|source-add
                                      (run inside your Hub Git clone)

Deprecated, still working:
  avenic doctor                       Use: avenic status
  avenic add|remove|adopt|install|uninstall|packs|tree
                                      Use the same verb under: avenic skills
  avenic catalog                      Use: avenic hub

Models:
  avenic model                       Show library path, project binding and projection status
  avenic model list                  List local profiles (marks the one bound to this project)
  avenic model add --name <n> --base-url <u> --api-key <k> [--api <anthropic|openai-chat|openai-responses>] [--model <id>] [--id <id>]
  avenic model set|edit <id> […]     Update a profile in the local library
  avenic model use [id]              Bind a profile to this project (interactive picker on a terminal)
  avenic model clear                 Unbind this project and restore the previous settings
  avenic model remove <id>           Delete a profile from the local library
  avenic model test [id]             Send one minimal real request (exit code 2 on failure)
  avenic model presets               List built-in endpoint presets

Update Avenic:
  avenic self-update
`);
}

function printAgentStatus(agent, projectRoot, state) {
  const config = effectiveAgentConfig(state, agent.id);
  const rows = [
    ["Initialized", config ? "Yes" : "No"],
    ...(config ? [
      ["Configured auth", config.configuredAuth],
      ["Local override", config.localAuth ?? "None"],
      ["Effective auth", config.auth],
      ["Sessions", config.sessions === "global" ? "Global (native)" : "Project (portable)"],
    ] : []),
    ["Official CLI", agentExecutableAvailable(agent.id) ? "Available" : "Not found"],
  ];
  printResult(`${agent.displayName} status`, projectRoot, rows, { labelWidth: 20 });
}

async function dispatchAgent(agentId, argumentsList, options = {}) {
  const agent = getAgent(agentId);
  const projectRoot = options.projectRoot ?? await timed("project", () => locateProjectRoot());
  const [command, ...remainingArguments] = argumentsList;

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return 0;
  }

  if (command === "init") {
    const initArguments = [...remainingArguments];
    const authOption = takeOption(initArguments, "--auth");
    const authMode = authOption ? validateAuthMode(authOption) : undefined;
    const sessionsOption = takeOption(initArguments, "--sessions");
    const sessionsMode = sessionsOption ? validateSessionsMode(sessionsOption) : undefined;
    if (initArguments.length > 0) {
      throw new Error(`Unknown option: ${initArguments[0]}`);
    }
    const result = await initializeAgent(projectRoot, agentId, authMode, sessionsMode);
    printResult("Avenic Runtime", projectRoot, [
      ["Agent", agent.displayName],
      ["Authentication", result.authMode],
      ["Sessions", result.sessionsMode === "global" ? "Global" : "Project"],
      ["Session Git", (await sessionsGitIgnored(projectRoot)) ? "Off" : "On"],
      ["Configuration", result.configChanged ? "Updated" : "Unchanged"],
      ["Git ignore", result.gitignoreChanged ? "Updated" : "Unchanged"],
      ["Structure", result.structureRepaired ? "Repaired" : "Intact"],
    ], { labelWidth: 16 });
    const changedSomething = result.configChanged || result.gitignoreChanged || result.structureRepaired;
    console.log(changedSomething ? "\nChanged:" : "\nAlready up to date — nothing changed.");
    if (result.configChanged) {
      console.log("  .agents/runtime.json          Runtime config (agent, auth, sessions)");
    }
    if (result.gitignoreChanged) {
      console.log("  .gitignore                    Added ignore rules for .agents/ and .claude/skills/");
    }
    if (result.structureRepaired) {
      console.log(`  .agents/sessions/${agentId}/       Portable sessions (in Git by default)`);
      if (result.authMode === "project") {
        console.log(`  .agents/local/${agentId}/          Project credentials (gitignored)`);
      }
    }
    console.log(`\nUsage:
  avenic ${agentId}              Launch ${agent.displayName}
  avenic ${agentId} status       Show configuration
  avenic ${agentId} deinit       Undo init (--purge also deletes data)
  avenic ${agentId} auth         Switch global/project authentication\n`);
    console.log(
      "Project sessions may contain prompts, source code, command output, file paths, and secrets. Only commit sessions to repositories you trust.\n",
    );
    return 0;
  }

  if (command === "deinit") {
    const purge = remainingArguments.includes("--purge");
    const unknown = remainingArguments.find((argument) => argument !== "--purge");
    if (unknown) {
      throw new Error(`Unknown option: ${unknown}`);
    }
    const result = await deinitializeAgent(projectRoot, agentId, { purge });
    printResult(`${agent.displayName} deinitialization`, projectRoot, [
      ["Runtime", result.changed ? "Removed" : "Already absent"],
      ["Data", result.purged ? "Purged" : "Preserved"],
      ["Agents", `${result.remaining} remaining`],
    ], { labelWidth: 10 });
    if (!purge) {
      console.log(`\nReinitialize later without losing portable sessions:\n  avenic ${agentId} init`);
    }
    return 0;
  }

  if (command === "auth") {
    if (remainingArguments.length === 0) {
      printAgentStatus(agent, projectRoot, await loadRuntime(projectRoot));
      return 0;
    }
    if (remainingArguments.length !== 1) {
      throw new Error(`Usage: avenic ${agentId} auth [global|project|reset]`);
    }
    const mode = remainingArguments[0];
    const config = mode === "reset"
      ? await clearLocalAuth(projectRoot, agentId)
      : await setLocalAuth(projectRoot, agentId, mode);
    printResult(`${agent.displayName} authentication`, projectRoot, [
      ["Configured default", config.configuredAuth],
      ["Local override", config.localAuth ?? "None"],
      ["Effective", config.auth],
    ], { labelWidth: 20 });
    return 0;
  }

  if (command === "status") {
    printAgentStatus(agent, projectRoot, await loadRuntime(projectRoot));
    return 0;
  }

  if (command === "sessions") {
    const state = await loadRuntime(projectRoot);
    if (!effectiveAgentConfig(state, agentId)) {
      throw new Error(`${agent.displayName} is not initialized. Run: avenic ${agentId} init`);
    }
    const action = remainingArguments[0] ?? "status";
    if (remainingArguments.length > 1 || !["import", "writeback", "status"].includes(action)) {
      throw new Error(`Usage: avenic ${agentId} sessions [import|writeback|status]`);
    }
    const adapter = getSessionAdapter(agentId);
    if (action === "status") {
      const result = await adapter.status(projectRoot);
      printResult(`${agent.displayName} portable sessions`, projectRoot, [["Sessions", String(result.count)]], { labelWidth: 10 });
      return 0;
    }
    const result = action === "import" ? await importProjectSessions(projectRoot, agentId) : await adapter.restore(projectRoot);
    printResult(`${agent.displayName} session ${action}`, projectRoot, [
      ["Sessions", action === "import" ? `${result.discovered} discovered; ${result.imported} imported; ${result.unchanged} unchanged; ${result.failed} failed` : String(result.count)],
      [action === "import" ? "Portable" : "Written back", action === "import" ? (result.changed ? "Updated" : "Unchanged") : String(result.added + result.updated)],
    ], { labelWidth: 14 });
    if (action === "import") reportSessionDiagnostics(result.diagnostics, { missingRoots: true });
    if (result.conflicts > 0) {
      console.log(`Conflicts ${result.conflicts} (project sessions overwrote native storage)`);
    }
    return 0;
  }

  // The plain launch is its own module so that starting an Agent loads only
  // what starting an Agent needs. There is one implementation of it.
  return launchAgent(agentId, argumentsList, { ...options, projectRoot });
}

async function dispatchDoctor() {
  const projectRoot = locateProjectRoot();
  const state = await loadRuntime(projectRoot);
  console.log("Avenic Doctor\n");
  console.log(`Project root       OK  ${projectRoot}`);
  console.log(`Runtime config     ${state.runtime.agents ? "OK" : "ERROR"}`);
  for (const agentId of Object.keys(AGENTS)) {
    const agent = getAgent(agentId);
    console.log(`${agent.displayName.padEnd(18)} ${agentExecutableAvailable(agent.id) ? "OK" : "NOT FOUND"}`);
  }
  return 0;
}

// Sessions leave the Git index through the same git Avenic uses everywhere
// else, so a checkout with no git on PATH, or a locked index, is reported with
// one of the classified failure kinds instead of a bare "unable to remove".
async function untrackSessions(projectRoot) {
  const tracked = await git(["ls-files", "--", ".agents/sessions"], { cwd: projectRoot })
    // A project that is not a checkout has nothing tracked to remove — the same
    // answer as an empty index, and not a failure worth stopping the command.
    .catch((error) => (error.kind === "repo-missing" ? "" : Promise.reject(error)));
  if (!tracked) return 0;
  await git(["rm", "-r", "--cached", "--force", "--ignore-unmatch", "--", ".agents/sessions"], {
    cwd: projectRoot,
    stdio: "inherit",
  });
  return tracked.split(/\r?\n/).filter(Boolean).length;
}

// Shared history is reconciled when the user looks at it, never on the way
// into an agent. A run whose exit path never happened (closed terminal, killed
// editor, dead watchdog) is picked up here instead of costing every launch.
// Returns the diagnostics the caller must surface once.
async function reconcileSharedHistory(projectRoot, state) {
  if (projectConfig(state).sessionInterop !== "shared") return { imported: 0, diagnostics: [] };
  const agentIds = Object.keys(projectConfig(state).agents);
  if (agentIds.length === 0) return { imported: 0, diagnostics: [] };
  const results = await recoverSharedNativeSessions(projectRoot, agentIds, {
    environmentForAgent: (agentId) => agentEnvironment(state, projectRoot, agentId),
  });
  return {
    imported: results.reduce((total, result) => total + (result.imported ?? 0), 0),
    diagnostics: results.flatMap((result) => result.diagnostics ?? []).filter(Boolean),
  };
}

async function reportReconciliation(projectRoot) {
  const { diagnostics } = await reconcileSharedHistory(projectRoot, await loadRuntime(projectRoot));
  reportSessionDiagnostics(diagnostics);
}

// The outermost layer is the only place that reports what could not be read

// What a continuation is about to hand the target, in one phrase: how many
// turns a projection carried, or how many events a fallback prompt summarised.
function continuationDelta(continuation) {
  const turns = continuation?.projection?.turns?.length;
  if (typeof turns === "number") {
    const checkpoint = continuation.projection.checkpoint ? ", plus a condensed checkpoint" : "";
    return `projection of ${turns} turn(s)${checkpoint}`;
  }
  return `delta of ${continuation?.handoff?.delta?.length ?? 0} event(s)`;
}

// One continuation sequence for every agent: capture what the target already
// has, prepare the delta, let the official CLI run in the foreground, capture
// what it produced, and only then commit the mapping. Claude and Codex reach it
// by resuming their mapped native session; OpenCode reaches it with a fresh
// official session when the one Avenic projected will not start.
async function runCanonicalContinuation({ projectRoot, state, environment, mode, agentId, forceBootstrap = false }) {
  const targetAdapter = getSessionAdapter(agentId);
  // A stale cursor means the target needs a semantic delta, not a new native
  // thread. Let the official resume command preserve the target's native
  // context; only an unavailable mapping or a failed resume falls back to a
  // fresh official thread below.
  let capturedDuringLaunch = null;
  const result = await continueCanonicalSession({
    projectRoot,
    canonicalId: mode,
    targetAgent: agentId,
    environment,
    forceBootstrap,
    // Every call resolves the normal auth/runtime environment for that agent.
    // Sessions never manufacture or migrate credential directories.
    captureKnown: async () => {
      const results = await reconcileCanonicalSession(projectRoot, mode, {
        environmentForAgent: (sourceAgent) => agentEnvironment(state, projectRoot, sourceAgent),
      });
      for (const result of results.filter((entry) => entry.stale)) {
        console.warn(`${getAgent(result.agentId).displayName} native mapping is stale; rehydrating from canonical history.`);
      }
    },
    capture: async (stage, context = {}) => {
      if (stage === "after" && context.launched?.capturedDuringLaunch) return context.launched.capturedDuringLaunch;
      const nativeSessionId = context.launched?.nativeSessionId
        ?? context.continuation?.nativeSessionId
        ?? (await readCanonicalSession(projectRoot, mode)).mappings.projections[agentId]?.nativeSessionId;
      if (!nativeSessionId) return null;
      return targetAdapter.readCanonical(projectRoot, nativeSessionId, { environment });
    },
    launch: async (continuation) => {
      let launchedContinuation = continuation;
      // A projection names the native session it prepared; only the handoff
      // fallback has no native side yet, and only it needs discovery after the
      // run.
      let nativeSessionId = continuation.nativeSessionId ?? null;
      let launch = continuationLaunchArguments(continuation);
      const launchStartedAt = Date.now() - 1000;
      console.log(`Continuing ${mode} with ${getAgent(agentId).displayName}: ${continuation.mode}, ${continuationDelta(continuation)}.`);
      const launchOptions = {
        projectRoot,
        environment,
        input: launch.input,
        skipCanonical: true,
        skipRestore: true,
        onExit: async () => {
          const nativeId = nativeSessionId ?? await targetAdapter.discoverNativeSession(projectRoot, { environment, notBefore: launchStartedAt });
          capturedDuringLaunch = await targetAdapter.readCanonical(projectRoot, nativeId, { environment, canonicalSessionId: mode });
        },
      };
      let status = await dispatchAgent(agentId, launch.argumentsList, launchOptions);
      // A session the target will not open is not the end of the shared
      // conversation. Rebuild it natively first — that is still the target's
      // own session, just a fresh one — and only when the target cannot take a
      // projection at all hand it the bounded transcript. Escalate in that
      // order, and never repeat a command that already failed.
      const display = getAgent(agentId).displayName;
      const tried = new Set([JSON.stringify(launch.argumentsList)]);
      const rebuilds = [
        {
          message: `${display} session could not be opened; rebuilding it from shared canonical history.`,
          prepare: () => prepareCanonicalContinuation(projectRoot, mode, agentId, { environment, forceBootstrap: true }),
        },
        {
          message: `${display} could not be started with the projected session; continuing in a fresh official session from shared canonical history.`,
          prepare: () => prepareCanonicalContinuation(projectRoot, mode, agentId, { environment, handoff: true }),
        },
      ];
      for (const rebuild of status === 0 ? [] : rebuilds) {
        console.log(rebuild.message);
        const next = await rebuild.prepare();
        const nextLaunch = continuationLaunchArguments(next);
        const key = JSON.stringify(nextLaunch.argumentsList);
        if (tried.has(key)) continue;
        tried.add(key);
        launchedContinuation = next;
        launch = nextLaunch;
        nativeSessionId = next.nativeSessionId ?? null;
        status = await dispatchAgent(agentId, launch.argumentsList, { ...launchOptions, input: launch.input });
        if (status === 0) break;
      }
      if (status !== 0) throw new Error(`${display} exited with status ${status}`);
      const discoveredId = nativeSessionId
        ?? await targetAdapter.discoverNativeSession(projectRoot, { environment, notBefore: launchStartedAt });
      return {
        nativeSessionId: discoveredId,
        projectionHash: launchedContinuation.projection?.hash ?? launchedContinuation.handoff?.hash ?? null,
        capturedDuringLaunch,
      };
    },
  });
  reportSessionDiagnostics(result.diagnostics);
  await setActiveCanonicalSession(projectRoot, mode);
  return result;
}

// One conversation, read from the shared store. `stamp` here is the same slice
// the rest of the CLI prints, so a transcript and a status page never disagree
// about when something happened.
async function canonicalSessionsWithPreview(projectRoot) {
  const sessions = await listCanonicalSessions(projectRoot);
  const rows = [];
  for (const session of sessions) {
    const record = await readCanonicalSession(projectRoot, session.id);
    const transcript = await loadTranscript(projectRoot, session.id, { record });
    rows.push({ session, record, transcript });
  }
  return rows;
}

/**
 * The Sessions browser: List → pick a conversation → read it, continue it, or
 * make it the active one. Reading is the first thing offered because looking at
 * what the agents already said is what a user opens this menu to do.
 */
async function browseSessions(projectRoot, options = {}) {
  const prompts = options.prompts ?? {};
  const sessions = await listCanonicalSessions(projectRoot);
  if (sessions.length === 0) throw new Error("No shared sessions are available. Import histories or switch to Shared mode first.");
  const choices = [];
  for (const row of await canonicalSessionsWithPreview(projectRoot)) {
    choices.push({
      value: row.session.id,
      label: row.session.title ?? row.session.id,
      hint: `${row.transcript.summary.turns} turns · ${transcriptPreview(row.transcript, 40)}`,
    });
  }
  const selected = await searchableSelect({ ...prompts, title: "Sessions", options: choices });
  if (!selected) return 0;
  return sessionActions(projectRoot, selected, options);
}

async function sessionActions(projectRoot, sessionId, options = {}) {
  const prompts = options.prompts ?? {};
  const stdout = prompts.stdout ?? process.stdout;
  const transcript = await loadTranscript(projectRoot, sessionId);
  const interop = options.interop ?? projectConfig(await loadRuntime(projectRoot)).sessionInterop;
  const participants = transcript.summary.agents.map(agentLabel).join(", ") || "no agent turns yet";
  const action = await singleSelect({
    ...prompts,
    title: `Session ${transcript.summary.title}`,
    description: `${transcript.summary.turns} turns · ${participants}`,
    options: [
      { value: "view", label: "View history", hint: `${transcript.summary.events} events` },
      ...(interop === "shared" ? [
        { value: "continue", label: "Continue with an agent", hint: "the shared conversation, handed over natively" },
        { value: "active", label: "Set as active session", hint: "new launches join this one" },
      ] : []),
    ],
  });
  if (!action) return 0;
  if (action === "view") {
    printTranscript(stdout, transcript, { environment: options.environment });
    // Back to the same choices, so reading a long conversation and then
    // continuing it does not mean walking the whole menu again.
    return sessionActions(projectRoot, sessionId, options);
  }
  if (action === "active") {
    await setActiveCanonicalSession(projectRoot, sessionId);
    console.log(`Active shared session: ${sessionId}`);
    return 0;
  }
  const agentId = await singleSelect({ ...prompts, title: "Continue with", options: agentChoices() });
  if (!agentId) return 0;
  return dispatchSessions(["continue", sessionId, "--agent", agentId], options);
}

async function dispatchSessions(argumentsList, options = {}) {
  const [command, mode = "status", ...extra] = argumentsList;
  const prompts = options.prompts ?? {};
  const projectRoot = options.projectRootOverride ?? locateProjectRoot();
  if (!command && isInteractive(prompts)) {
    banner(prompts.stdout);
    const interop = projectConfig(await loadRuntime(projectRoot)).sessionInterop;
    const action = await singleSelect({
      ...prompts,
      title: `Sessions (${interop})`,
      options: [
        ...(interop === "shared" ? [{ value: ["continue"], label: "Continue shared session" }] : []),
        { value: ["list"], label: "List sessions" },
        { value: ["sync"], label: "Import histories" },
        ...(interop === "shared" ? [{ value: ["active"], label: "Set active session" }] : []),
        ...(interop === "isolated" ? [{ value: ["migrate"], label: "Switch to Shared" }] : []),
        { value: ["status"], label: "Status" },
      ],
    });
    if (!action) return 0;
    if (action[0] === "migrate") return dispatchProjectSetup([], true, options);
    // Continue and Set active list shared history directly, so reconcile
    // before the choices are drawn.
    if (action[0] === "active" || action[0] === "continue") await reportReconciliation(projectRoot);
    if (action[0] === "active") {
      const sessions = await listCanonicalSessions(projectRoot);
      if (sessions.length === 0) throw new Error("No shared sessions are available. Import histories or switch to Shared mode first.");
      const sessionId = await singleSelect({ ...prompts, title: "Set active session", options: sessions.map((session) => ({ value: session.id, label: session.title ?? session.id })) });
      if (!sessionId) return 0;
      await setActiveCanonicalSession(projectRoot, sessionId);
      console.log(`Active shared session: ${sessionId}`);
      return 0;
    }
    if (action[0] === "list") {
      // Reading a conversation must show what the agents have already said, not
      // what the last import happened to catch.
      await reportReconciliation(projectRoot);
      return browseSessions(projectRoot, options);
    }
    if (action[0] !== "continue") return dispatchSessions(action, options);
    const sessions = await listCanonicalSessions(projectRoot);
    if (sessions.length === 0) throw new Error("No shared sessions are available. Import histories or switch to Shared mode first.");
    const sessionId = await singleSelect({ ...prompts, title: "Continue shared session", options: sessions.map((session) => ({ value: session.id, label: session.title ?? session.id })) });
    if (!sessionId) return 0;
    const agentId = await singleSelect({ ...prompts, title: "Continue with", options: agentChoices() });
    if (!agentId) return 0;
    return dispatchSessions(["continue", sessionId, "--agent", agentId], options);
  }
  if (!command) return dispatchSessions(["status"], options);
  // `sync` reconciles every agent itself, in every mode.
  if (command === "list" || command === "status" || command === "continue") {
    await reportReconciliation(projectRoot);
  }
  if (command === "show") {
    const id = mode === "status" ? null : mode;
    let json = false;
    let limit = 0;
    for (let index = 0; index < extra.length; index += 1) {
      const value = extra[index];
      if (value === "--json") { json = true; continue; }
      if (value === "--limit") { limit = Number.parseInt(extra[index + 1] ?? "", 10) || 0; index += 1; continue; }
      throw new Error(`Unknown option for avenic sessions show: ${value}`);
    }
    if (!id) throw new Error("Usage: avenic sessions show <id> [--json] [--limit <turns>]");
    // Reading is a pure read of the shared store: no capture, no projection, no
    // network. `sessions list` is what brings native history up to date.
    const transcript = await loadTranscript(projectRoot, id);
    if (json) {
      // Machine output is the model, never the drawing.
      process.stdout.write(`${JSON.stringify(transcriptModel(transcript), null, 2)}\n`);
      return 0;
    }
    printTranscript(prompts.stdout ?? process.stdout, transcript, { limit, environment: options.environment });
    return 0;
  }
  if ((command === "list" || command === "status") && argumentsList.length === 1) {
    const out = prompts.stdout ?? process.stdout;
    const colors = palette(out, options.environment ?? process.env);
    const activeCanonicalId = await getActiveCanonicalSessionId(projectRoot);
    const rows = await canonicalSessionsWithPreview(projectRoot);
    intro(out, command === "status" ? "Canonical session status" : "Canonical sessions", { colors, description: projectRoot });
    field(out, "Active", activeCanonicalId ?? "none", { colors });
    if (rows.length === 0) {
      note(out, "No canonical sessions are available yet. Import histories or switch to Shared mode.", { colors });
      return 0;
    }
    for (const { session, record, transcript } of rows) {
      const latestEventId = record.events.at(-1)?.id ?? null;
      section(out, `${session.title ?? "Untitled"}`, { colors, description: session.id });
      field(out, "counts", `${record.events.length} events  ·  ${transcript.summary.turns} turns  ·  revision ${record.session.revision ?? "derived"}`, { colors });
      field(out, "updated", String(session.updatedAt ?? "unknown"), { colors });
      field(out, "last", transcriptPreview(transcript, 72), { colors });
      const projections = Object.entries(record.mappings.projections ?? {}).filter(([, mapping]) => mapping?.nativeSessionId);
      if (projections.length === 0) {
        field(out, "native", "no agent session yet", { colors });
        continue;
      }
      for (const [agentId, mapping] of projections) {
        const current = mapping.lastCanonicalEventId === latestEventId;
        // The cursor is the whole story of a switch: it says how far the
        // agent's own session has been brought, and whether the next launch
        // needs a delta or nothing at all.
        const state = command === "status"
          ? `${current ? colors.ok("current") : colors.warn("stale")}  @${mapping.lastCanonicalEventId ?? "none"}`
          : `${current ? colors.ok("current") : colors.warn("stale")}`;
        field(out, agentLabel(agentId), `${mapping.nativeSessionId}  ${state}`, { colors });
      }
    }
    return 0;
  }
  if (command === "continue") {
    if (extra.length !== 2 || extra[0] !== "--agent" || !["claude", "codex", "opencode"].includes(extra[1])) {
      throw new Error("Usage: avenic sessions continue <id> --agent <claude|codex|opencode>");
    }
    const agentId = extra[1];
    const state = await loadRuntime(projectRoot);
    if (projectConfig(state).sessionInterop !== "shared") {
      throw new Error("Shared continuation is disabled for this project. Run: avenic change --history shared");
    }
    if (!effectiveAgentConfig(state, agentId)) {
      throw new Error(`${getAgent(agentId).displayName} is not initialized. Run: avenic ${agentId} init`);
    }
    const environment = agentEnvironment(state, projectRoot, agentId);
    if (agentId === "opencode") {
      // OpenCode's history is only reachable through its own CLI, so the
      // projection is created by `opencode import` and continued with
      // `opencode --session`. When that session will not start — most often a
      // message, or a configured model, naming a provider this machine does not
      // have — the shared history is still intact, so continue it the way the
      // other agents do: a fresh official session handed the canonical delta.
      const projection = await projectCanonicalSession(projectRoot, mode, agentId, { environment });
      const status = await dispatchAgent(agentId, ["--session", projection.nativeSessionId], { projectRoot, environment });
      await captureCanonicalSession(projectRoot, mode, agentId, { environment });
      if (status === 0) return 0;
      console.warn(`${getAgent(agentId).displayName} could not be started with the projected session (exit ${status}); continuing in a fresh official session from shared canonical history.`);
      const fallback = await runCanonicalContinuation({ projectRoot, state, environment, mode, agentId, forceBootstrap: true });
      return fallback.launched.status ?? 0;
    }

    const result = await runCanonicalContinuation({ projectRoot, state, environment, mode, agentId });
    return result.launched.status ?? 0;
  }
  if (command === "sync" && argumentsList.length === 1) {
    const state = await loadRuntime(projectRoot);
    const results = [];
    for (const agentId of Object.keys(projectConfig(state).agents)) {
      const environment = agentEnvironment(state, projectRoot, agentId);
      results.push({ agentId, ...(await importProjectSessions(projectRoot, agentId, { environment, setActive: false })) });
    }
    console.log(`Synced ${results.reduce((total, item) => total + (item.imported ?? 0), 0)} native session(s).`);
    reportSessionDiagnostics(results.flatMap((result) => result.diagnostics ?? []), { missingRoots: true });
    return 0;
  }
  if (command !== "git") {
    throw new Error("Usage: avenic sessions git [on|off|status]");
  }
  if (extra.length > 0 || !["on", "off", "status"].includes(mode)) {
    throw new Error("Usage: avenic sessions git [on|off|status]");
  }
  if (mode === "off") {
    const changed = await setSessionsGitIgnored(projectRoot, true);
    const untracked = await untrackSessions(projectRoot);
    console.log("Session Git sync\n");
    console.log(`Project    ${projectRoot}`);
    console.log("Status     Off");
    console.log(`Git ignore ${changed ? "Updated" : "Unchanged"}`);
    console.log(`Untracked  ${untracked}`);
    return 0;
  }
  if (mode === "on") {
    const changed = await setSessionsGitIgnored(projectRoot, false);
    console.log("Session Git sync\n");
    console.log(`Project    ${projectRoot}`);
    console.log("Status     On");
    console.log(`Git ignore ${changed ? "Updated" : "Unchanged"}`);
    return 0;
  }
  console.log(`Session Git sync: ${(await sessionsGitIgnored(projectRoot)) ? "Off" : "On"}`);
  return 0;
}

async function dispatchSkillsCommand(argumentsList) {
  return dispatchSkills(argumentsList, {
    io: console,
    cwd: process.cwd(),
    environment: process.env,
  });
}

// The interactive surfaces (the project wizard and the Sessions menu) draw on
// whatever terminal the caller hands them, and resolve the project from the
// caller's root. Production passes neither; a test drives the real prompts
// with a fake TTY this way instead of re-implementing them.
function terminalOptions(options) {
  return { prompts: options.prompts, projectRootOverride: options.projectRootOverride };
}

export async function runCli(options = {}) {
  const argumentsList = options.argumentsList ?? process.argv.slice(2);
  const forcedAgent = options.forcedAgent;
  if (forcedAgent) {
    return dispatchAgent(forcedAgent, argumentsList);
  }
  const [command, ...remainingArguments] = argumentsList;
  mark("command");
  if (command === "--version" || command === "-v" || command === "version") {
    console.log(`Avenic ${packageVersion}`);
    return 0;
  }
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return 0;
  }
  if (Object.hasOwn(AGENTS, command)) {
    return dispatchAgent(command, remainingArguments);
  }
  if (command === "init") {
    return dispatchProjectSetup(remainingArguments, false, terminalOptions(options));
  }
  if (command === "change") {
    return dispatchProjectSetup(remainingArguments, true, terminalOptions(options));
  }
  if (command === "skills") {
    return dispatchSkillsCommand(remainingArguments);
  }
  if (command === "hub" || command === "catalog") {
    // `catalog` 是弃用别名：继续可用，但警告（与 AGENTHOME_* 环境变量的弃用风格一致）
    if (command === "catalog") console.warn("warning: `avenic catalog` is deprecated; use `avenic hub`");
    return dispatchHub(remainingArguments, {
      io: console,
      cwd: process.cwd(),
      environment: process.env,
    });
  }
  if (command === "model") {
    return dispatchModel(remainingArguments, {
      io: console,
      cwd: process.cwd(),
      environment: process.env,
    });
  }
  if (command === "sessions") {
    return dispatchSessions(remainingArguments, terminalOptions(options));
  }
  if (command === "update") {
    if (remainingArguments.length > 0) {
      throw new Error("Usage: avenic self-update");
    }
    await updateAvenic(packageRoot);
    return 0;
  }
  if (command === "status") {
    return dispatchStatusCommand(remainingArguments, { io: console, environment: process.env });
  }
  if (command === "doctor") {
    console.warn("warning: `avenic doctor` is deprecated; use `avenic status`");
    return dispatchDoctor();
  }
  // Anything left is either a legacy top-level command (add, install,
  // uninstall, packs, tree, ...) or a Pack id. A bare Pack id is how a Pack is
  // installed and is not an alias of anything; the rest are the older spelling
  // of a Skills verb, so each one names the spelling that replaces it.
  if (LEGACY_SKILLS_VERBS.has(command)) {
    console.warn(`warning: \`avenic ${command}\` is deprecated; use \`avenic skills ${command}\``);
  }
  return dispatchSkills(argumentsList, {
    io: console,
    cwd: process.cwd(),
    environment: process.env,
  });
}
