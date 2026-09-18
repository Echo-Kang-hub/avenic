import path from "node:path";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  AGENTS,
  acquireSessionLease,
  applyProjectConfiguration,
  agentExecutableAvailable,
  bindProject,
  buildHandoff,
  clearLocalAuth,
  createInstallContext,
  deinitializeAgent,
  effectiveAgentConfig,
  ensureSkillLinks,
  formatLinkSummary,
  formatSessionDiagnostics,
  getAgent,
  getActiveCanonicalSessionId,
  getSessionAdapter,
  initializeAgent,
  importProjectSessions,
  observeSharedNativeSessions,
  recoverSharedNativeSessions,
  loadRuntime,
  locateProjectRoot,
  logConflicts,
  listCanonicalSessions,
  captureCanonicalSession,
  reconcileCanonicalSession,
  continueCanonicalSession,
  continuationLaunchArguments,
  prepareCanonicalContinuation,
  managedSkillNames,
  projectCanonicalSession,
  readCanonicalSession,
  projectAuthEnvironment,
  projectConfig,
  projectModelStatus,
  resolveProjectProfile,
  resolveEffectiveAgentRuntime,
  sessionLeasePath,
  sessionsGitIgnored,
  setLocalAuth,
  setSessionsGitIgnored,
  setActiveCanonicalSession,
  spawnExecutableSync,
  validateAuthMode,
  validateSessionInteropMode,
  validateSessionsMode,
} from "#core";
import { dispatchModel } from "./model-cli.mjs";
import { dispatchHub, dispatchSkills } from "./skills-cli.mjs";
import { updateAvenic } from "./self-update.mjs";
import { spawnSessionWatchdog } from "./watchdog.mjs";
import { banner, confirm, isInteractive, multiselect, select } from "./prompts.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const packageVersion = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")).version;

function launchExecutable(executable, argumentsList, options = {}) {
  const result = spawnExecutableSync(executable, argumentsList, {
    cwd: options.cwd,
    env: options.environment,
    stdio: options.input !== undefined ? ["pipe", "inherit", "inherit"] : (options.capture ? "pipe" : "inherit"),
    input: options.input,
    windowsHide: Boolean(options.capture),
  });
  if (result.error) {
    throw new Error(`Unable to launch ${executable}: ${result.error.message}`);
  }
  return result.status ?? 1;
}

function launchCaptured(executable, argumentsList, options = {}) {
  const result = spawnExecutableSync(executable, argumentsList, {
    cwd: options.cwd,
    env: options.environment,
    stdio: "pipe",
    input: options.input,
    windowsHide: true,
    encoding: "utf8",
  });
  if (result.error) throw new Error(`Unable to launch ${executable}: ${result.error.message}`);
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

// Tell the detached durability watch that this launch is finishing, so it
// stops its periodic capture and leaves the exit sequence sole ownership of
// the last pass. Best-effort: a missing marker only costs a redundant capture.
function markLaunchClosing(agentId, projectRoot) {
  try {
    writeFileSync(path.join(sessionLeasePath(agentId, projectRoot), "closing"), "");
  } catch {}
}

function isActiveSessionError(output) {
  return /active writer|already in use|already active|session lock|thread-store conflict/i.test(output);
}

function takeOption(argumentsList, option) {
  const index = argumentsList.indexOf(option);
  if (index === -1) {
    return undefined;
  }
  const value = argumentsList[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`Missing value for ${option}`);
  }
  argumentsList.splice(index, 2);
  return value;
}

function parseAgentList(value) {
  const agents = value.split(",").filter(Boolean);
  if (agents.length === 0) throw new Error("Select at least one agent");
  for (const agentId of agents) getAgent(agentId);
  return [...new Set(agents)];
}

function configurationSummary(config) {
  const lines = [];
  for (const [agentId, entry] of Object.entries(config.agents)) {
    lines.push(`${getAgent(agentId).displayName}: ${entry.auth} auth · ${entry.sessions} sessions`);
  }
  lines.push(`History: ${config.sessionInterop}`);
  return lines;
}

async function interactiveProjectDraft(projectRoot, editing = false) {
  const state = await loadRuntime(projectRoot);
  const current = projectConfig(state);
  const selected = await multiselect({
    title: editing ? "Select enabled agents" : "Select agents",
    options: Object.values(AGENTS).map((agent) => ({ value: agent.id, label: agent.displayName })),
    initial: Object.keys(current.agents),
    minSelected: 1,
  });
  if (selected === null) return null;
  if (selected.length === 0) throw new Error("Select at least one agent");
  const agents = {};
  for (const agentId of selected) {
    const previous = current.agents[agentId] ?? { auth: "global", sessions: "project" };
    const auth = await select({
      title: `${getAgent(agentId).displayName} authentication`,
      options: [
        { value: "global", label: "Global" },
        { value: "project", label: "Project" },
      ],
      initial: previous.auth === "project" ? 1 : 0,
    });
    if (auth === null) return null;
    const sessions = await select({
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
  const sessionInterop = await select({
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

async function dispatchProjectSetup(argumentsList, editing = false) {
  const projectRoot = locateProjectRoot();
  let draft;
  if (argumentsList.length === 0 && isInteractive()) {
    banner();
    draft = await interactiveProjectDraft(projectRoot, editing);
    if (!draft) return 0;
    console.log(`\nAvenic project configuration\n${configurationSummary(draft).map((line) => `  ${line}`).join("\n")}\n`);
    if (await confirm({ title: "Apply configuration?" }) !== true) return 0;
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
  console.log(`Avenic project ${editing ? "updated" : "initialized"}\n`);
  console.log(`Project  ${projectRoot}`);
  for (const line of configurationSummary(result.config)) console.log(`  ${line}`);
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

Diagnostics:
  avenic status                       Show all three agents
  avenic doctor                       Check the environment

Skills:
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
  Note: the deprecated verb 'catalog' still works, with a deprecation warning.

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
  console.log(`${agent.displayName}\n`);
  console.log(`Project             ${projectRoot}`);
  console.log(`Initialized         ${config ? "Yes" : "No"}`);
  if (config) {
    console.log(`Configured auth     ${config.configuredAuth}`);
    console.log(`Local override      ${config.localAuth ?? "None"}`);
    console.log(`Effective auth      ${config.auth}`);
    console.log(`Sessions            ${config.sessions === "global" ? "Global (native)" : "Project (portable)"}`);
  }
  console.log(`Official CLI        ${agentExecutableAvailable(agent.id) ? "Available" : "Not found"}`);
}

// 启动前解析当前项目绑定的 profile：dangling 时先安全回滚并提示（幂等），
// 然后按 agent 生成注入。任何异常都不阻断启动（配置问题不该让 Agent 打不开）。
async function resolveActiveProfileForLaunch(projectRoot, environment) {
  try {
    const resolved = await resolveProjectProfile(projectRoot, environment, console);
    if (resolved.message) console.log(resolved.message);
    if (!resolved.profile) return null;
    // Claude 的投影是项目内物化文件：指纹不一致时先刷新（事务写）
    const status = await projectModelStatus(projectRoot, environment);
    if (status.projection && !status.projection.fingerprintMatches) {
      await bindProject(projectRoot, environment, resolved.profile.id);
    }
    return resolved.profile;
  } catch (error) {
    console.log(`Model configuration skipped: ${error.message}`);
    return null;
  }
}

async function dispatchAgent(agentId, argumentsList, options = {}) {
  const agent = getAgent(agentId);
  const projectRoot = options.projectRoot ?? locateProjectRoot();
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
    console.log("Avenic Runtime\n");
    console.log(`Agent           ${agent.displayName}`);
    console.log(`Project         ${projectRoot}`);
    console.log(`Authentication  ${result.authMode}`);
    console.log(`Sessions        ${result.sessionsMode === "global" ? "Global" : "Project"}`);
    console.log(`Session Git     ${(await sessionsGitIgnored(projectRoot)) ? "Off" : "On"}`);
    console.log(`Configuration   ${result.configChanged ? "Updated" : "Unchanged"}`);
    console.log(`Git ignore      ${result.gitignoreChanged ? "Updated" : "Unchanged"}`);
    console.log(`Structure       ${result.structureRepaired ? "Repaired" : "Intact"}`);
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
    console.log(`${agent.displayName} deinitialization\n`);
    console.log(`Project   ${projectRoot}`);
    console.log(`Runtime   ${result.changed ? "Removed" : "Already absent"}`);
    console.log(`Data      ${result.purged ? "Purged" : "Preserved"}`);
    console.log(`Agents    ${result.remaining} remaining`);
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
    console.log(`${agent.displayName} authentication\n`);
    console.log(`Configured default  ${config.configuredAuth}`);
    console.log(`Local override      ${config.localAuth ?? "None"}`);
    console.log(`Effective           ${config.auth}`);
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
      console.log(`${agent.displayName} portable sessions\n\nProject  ${projectRoot}\nSessions ${result.count}`);
      return 0;
    }
    const result = action === "import" ? await importProjectSessions(projectRoot, agentId) : await adapter.restore(projectRoot);
    console.log(`${agent.displayName} session ${action}\n`);
    console.log(`Project   ${projectRoot}`);
    console.log(`Sessions  ${action === "import" ? `${result.discovered} discovered; ${result.imported} imported; ${result.unchanged} unchanged; ${result.failed} failed` : result.count}`);
    console.log(action === "import" ? `Portable  ${result.changed ? "Updated" : "Unchanged"}` : `Written back  ${result.added + result.updated}`);
    if (action === "import") reportSessionDiagnostics(result.diagnostics);
    if (result.conflicts > 0) {
      console.log(`Conflicts ${result.conflicts} (project sessions overwrote native storage)`);
    }
    return 0;
  }

  const state = await loadRuntime(projectRoot);
  const config = effectiveAgentConfig(state, agentId);
  if (!config) {
    throw new Error(`${agent.displayName} is not initialized. Run: avenic ${agentId} init`);
  }
  const environment = options.environment ?? agentEnvironment(state, projectRoot, agentId);
  const adapter = getSessionAdapter(agentId);
  const portableSessions = config.sessions !== "global";
  const sharedSessions = projectConfig(state).sessionInterop === "shared";
  // Recovery for sessions another agent left behind belongs to the explicit
  // `sessions` and `change` commands. A plain launch must reach the official
  // TUI first: it captures its own agent's history on exit, and the runtime
  // watcher keeps that history durable while it runs.
  // A plain agent launch is intentionally transparent: storage scope does not
  // imply a launch target. Shared-session continuation is opt-in via
  // `sessions continue`, while this path preserves the agent's native new/
  // default-session UX (including its own /resume command).
  // Plain launch is deliberately a zero-session-control-plane path. Do not
  // parse another agent's history, create projections, or call a model before
  // the official TUI appears. Explicit `sessions continue` performs recovery
  // and reconciliation; ordinary exits capture the selected native history.
  // Sessions created during a run live only in the project: the first launch
  // of a project+agent group snapshots the native storage and the last exit
  // reverts it. Launches of the same project+agent may run concurrently.
  // opencode's storage is managed by the official CLI, so it captures without
  // snapshotting or reverting.
  const isolatesNative = typeof adapter.snapshotNative === "function"
    && typeof adapter.revertNative === "function";
  let leaveLaunchGroup = null;
  let leaseMember = null;
  if (portableSessions && isolatesNative) {
    const snapshotRoot = path.join(sessionLeasePath(agentId, projectRoot), "snapshot");
    const lease = await acquireSessionLease(agentId, projectRoot, {
      onFirst: async (recovering) => {
        if (recovering) {
          // A previous launch group died without exiting: move its sessions
          // into the project and restore the pre-launch native state first.
          await adapter.capture(projectRoot, { environment });
          await adapter.revertNative(snapshotRoot, projectRoot, { environment });
        }
        await adapter.snapshotNative(projectRoot, snapshotRoot, { environment });
      },
      onLast: async () => {
        await adapter.revertNative(snapshotRoot, projectRoot, { environment });
      },
    });
    leaveLaunchGroup = lease.release;
    leaseMember = lease.member;
  }
  if (portableSessions) {
    // Every project-scoped launch gets a durability watch, whether or not the
    // agent's native storage is isolated for the run.
    try {
      await spawnSessionWatchdog(agentId, projectRoot, leaseMember, environment);
    } catch {}
  }
  if (portableSessions && !options.skipRestore) {
    // Project session records take priority on launch: conflicting native
    // copies are overwritten silently. Native storage is never written to
    // proactively; only `avenic <agent> sessions writeback` writes
    // project records back to native storage.
    try {
      await adapter.restore(projectRoot, { environment });
    } catch (error) {
      if (leaveLaunchGroup) {
        // Leaving the group reverts native storage when this was the only
        // launch in it.
        try {
          await leaveLaunchGroup();
        } catch {}
      }
      throw error;
    }
  }
  // 启动补齐（spec §5.5）：会话适配器收尾之后、拉起 Agent 之前，按受管集合把缺席/失效的
  // 链接补回来。未安装过 Skills 的项目零副作用（受管集合为空 → 一个字节都不写）。
  // 失败绝不影响启动：打印一行警告后照常拉起 Agent（spec §11）。
  try {
    const installContext = createInstallContext(false, { cwd: projectRoot, environment: process.env });
    const managed = await managedSkillNames(installContext);
    if (managed.size > 0) {
      const linkResult = await ensureSkillLinks(installContext, managed, { silent: true });
      const { counts } = linkResult;
      if (counts.linked > 0 || counts.repaired > 0 || counts.migrated > 0) {
        console.log(`Skills shared: ${formatLinkSummary(counts)}`);
      }
      logConflicts(console, linkResult.conflicts);
    }
  } catch (error) {
    console.warn(`⚠ Skills repair skipped: ${error.code ?? error.message}`);
  }
  const runtime = await resolveEffectiveAgentRuntime(projectRoot, agentId, {
    state,
    environment,
    argumentsList,
    io: console,
  });
  if (runtime.note) console.log(runtime.note);
  let status;
  let launchResult;
  try {
    launchResult = options.capture
      ? launchCaptured(runtime.executable, runtime.argumentsList, { cwd: projectRoot, environment: runtime.environment, input: options.input })
      : launchExecutable(runtime.executable, runtime.argumentsList, { cwd: projectRoot, environment: runtime.environment, input: options.input });
    status = options.capture ? launchResult.status : launchResult;
  } finally {
    if (portableSessions) {
      // The run is over: stop the detached durability watch before this
      // process starts its own exit sequence, so the two never capture the
      // same tree at once.
      markLaunchClosing(agentId, projectRoot);
      try {
        const captured = await observeSharedNativeSessions(projectRoot, agentId, {
          environment,
          setActive: !options.skipCanonical && sharedSessions,
        });
        reportSessionDiagnostics(captured.diagnostics);
        if (typeof options.onExit === "function") await options.onExit({ environment, projectRoot });
      } finally {
        if (leaveLaunchGroup) {
          await leaveLaunchGroup();
        } else {
          // Without a launch group nothing else removes the watch state.
          await rm(sessionLeasePath(agentId, projectRoot), { recursive: true, force: true });
        }
      }
    }
  }
  return options.capture ? launchResult : status;
}

async function dispatchStatus() {
  const projectRoot = locateProjectRoot();
  const state = await loadRuntime(projectRoot);
  console.log("Avenic Status\n");
  console.log(`Project  ${projectRoot}\n`);
  console.log(`History  ${projectConfig(state).sessionInterop}\n`);
  for (const agentId of Object.keys(AGENTS)) {
    const agent = getAgent(agentId);
    const config = effectiveAgentConfig(state, agentId);
    console.log(`${agent.displayName.padEnd(12)} ${config ? `Initialized (${config.auth} auth)` : "Not initialized"}`);
  }
  return 0;
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

function untrackSessions(projectRoot) {
  const tracked = spawnExecutableSync("git", ["ls-files", "--", ".agents/sessions"], {
    cwd: projectRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  if (tracked.status !== 0 || !tracked.stdout.trim()) return 0;
  const files = tracked.stdout.trim().split(/\r?\n/).filter(Boolean);
  const result = spawnExecutableSync(
    "git",
    ["rm", "-r", "--cached", "--force", "--ignore-unmatch", "--", ".agents/sessions"],
    { cwd: projectRoot, stdio: "inherit" },
  );
  if (result.status !== 0) throw new Error("Unable to remove sessions from the Git index");
  return files.length;
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
// from native history: one line per problem, once per command.
function reportSessionDiagnostics(diagnostics) {
  const { warnings, notes } = formatSessionDiagnostics(diagnostics);
  for (const note of notes) console.log(note);
  for (const warning of warnings) console.warn(`⚠ ${warning}`);
}

// The environment one agent normally runs with. Sessions never manufacture or
// migrate credential directories: project auth is a scope, not a login.
function agentEnvironment(state, projectRoot, agentId) {
  const config = effectiveAgentConfig(state, agentId);
  return config?.auth === "project"
    ? { ...process.env, ...projectAuthEnvironment(agentId, projectRoot) }
    : process.env;
}

async function dispatchSessions(argumentsList, options = {}) {
  const [command, mode = "status", ...extra] = argumentsList;
  const projectRoot = options.projectRootOverride ?? locateProjectRoot();
  if (!command && isInteractive()) {
    banner();
    const interop = projectConfig(await loadRuntime(projectRoot)).sessionInterop;
    const action = await select({
      title: `Sessions (${interop})`,
      options: [
        ...(interop === "shared" ? [{ value: ["continue"], label: "Continue shared session" }] : []),
        { value: ["list"], label: "List sessions" },
        { value: ["sync"], label: "Import histories" },
        ...(interop === "shared" ? [{ value: ["active"], label: "Set active session" }] : []),
        ...(interop === "isolated" ? [{ value: ["migrate"], label: "Switch to Shared" }] : []),
        { value: ["status"], label: "Status" },
        { value: ["back"], label: "Back" },
      ],
    });
    if (!action) return 0;
    if (action[0] === "back") return 0;
    if (action[0] === "migrate") return dispatchProjectSetup([], true);
    // Continue and Set active list shared history directly, so reconcile
    // before the choices are drawn.
    if (action[0] === "active" || action[0] === "continue") await reportReconciliation(projectRoot);
    if (action[0] === "active") {
      const sessions = await listCanonicalSessions(projectRoot);
      if (sessions.length === 0) throw new Error("No shared sessions are available. Import histories or switch to Shared mode first.");
      const sessionId = await select({ title: "Set active session", options: sessions.map((session) => ({ value: session.id, label: session.title ?? session.id })) });
      if (!sessionId) return 0;
      await setActiveCanonicalSession(projectRoot, sessionId);
      console.log(`Active shared session: ${sessionId}`);
      return 0;
    }
    if (action[0] !== "continue") return dispatchSessions(action, options);
    const sessions = await listCanonicalSessions(projectRoot);
    if (sessions.length === 0) throw new Error("No shared sessions are available. Import histories or switch to Shared mode first.");
    const sessionId = await select({ title: "Continue shared session", options: sessions.map((session) => ({ value: session.id, label: session.title ?? session.id })) });
    if (!sessionId) return 0;
    const agentId = await select({ title: "Continue with", options: Object.values(AGENTS).map((agent) => ({ value: agent.id, label: agent.displayName })) });
    if (!agentId) return 0;
    return dispatchSessions(["continue", sessionId, "--agent", agentId], options);
  }
  if (!command) return dispatchSessions(["status"], options);
  // `sync` reconciles every agent itself, in every mode.
  if (command === "list" || command === "status" || command === "continue") {
    await reportReconciliation(projectRoot);
  }
  if ((command === "list" || command === "status") && argumentsList.length === 1) {
    const sessions = await listCanonicalSessions(projectRoot);
    const activeCanonicalId = await getActiveCanonicalSessionId(projectRoot);
    console.log(command === "status" ? "Canonical session status\n" : "Canonical sessions\n");
    console.log(`Project  ${projectRoot}`);
    console.log(`Active   ${activeCanonicalId ?? "none"}`);
    if (sessions.length === 0) {
      console.log("No canonical sessions");
      return 0;
    }
    for (const session of sessions) {
      const stored = await readCanonicalSession(projectRoot, session.id);
      const latestEventId = stored.events.at(-1)?.id ?? null;
      if (command === "status") {
        console.log(`  events ${stored.events.length}  revision ${stored.session.revision ?? "derived"}`);
      }
      const projections = Object.entries(stored.mappings.projections)
        .filter(([, mapping]) => mapping?.nativeSessionId)
        .map(([agentId, mapping]) => `${agentId}:${mapping.nativeSessionId}`)
        .join(", ") || "none";
      const latest = Object.entries(stored.mappings.projections)
        .filter(([, mapping]) => mapping?.lastSyncedAt)
        .sort(([, left], [, right]) => right.lastSyncedAt.localeCompare(left.lastSyncedAt))[0]?.[0] ?? "none";
      console.log(`${session.id}  ${session.title ?? "Untitled"}  updated ${session.updatedAt}`);
      console.log(`  native ${projections}  last agent ${latest}`);
      if (command === "status") {
        for (const [agentId, mapping] of Object.entries(stored.mappings.projections ?? {})) {
          if (!mapping?.nativeSessionId) continue;
          const cursor = mapping.lastCanonicalEventId === latestEventId ? "current" : "stale";
          console.log(`  ${agentId} cursor ${cursor} @${mapping.lastCanonicalEventId ?? "none"}`);
        }
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
      const projection = await projectCanonicalSession(projectRoot, mode, agentId, { environment });
      try {
        return await dispatchAgent(agentId, ["--session", projection.nativeSessionId], { projectRoot, environment });
      } finally {
        await captureCanonicalSession(projectRoot, mode, agentId, { environment });
      }
    }

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
      // Every call resolves the normal auth/runtime environment for that
      // agent. Sessions never manufacture or migrate credential directories.
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
        let nativeSessionId = continuation.nativeSessionId
          ?? (agentId === "claude" ? randomUUID() : null);
        const launch = continuationLaunchArguments({ ...continuation, nativeSessionId });
        const launchStartedAt = Date.now() - 1000;
        console.log(`Continuing ${mode} with ${getAgent(agentId).displayName}: ${continuation.mode}; delta ${continuation.handoff.delta.length} event(s).`);
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
        let status;
        if (continuation.mode === "resume") {
          const statusFromInteractiveResume = await dispatchAgent(agentId, launch.argumentsList, launchOptions);
          if (statusFromInteractiveResume !== 0 && agentId === "codex") {
            // A Codex v2 sub-agent may be known to canonical history but be
            // unresumable by the current app-server. Rebuild from canonical,
            // rather than reusing an incremental (possibly empty) handoff.
            const fallbackContinuation = await prepareCanonicalContinuation(projectRoot, mode, agentId, {
              environment,
              forceBootstrap: true,
            });
            launchedContinuation = fallbackContinuation;
            const bootstrap = continuationLaunchArguments({
              ...fallbackContinuation,
              nativeSessionId: null,
            });
            nativeSessionId = null;
            console.log(`${getAgent(agentId).displayName} session could not be resumed; starting a new native thread from shared canonical history.`);
            status = await dispatchAgent(agentId, bootstrap.argumentsList, {
              ...launchOptions,
              input: bootstrap.input,
            });
          } else {
            status = statusFromInteractiveResume;
          }
        } else {
          status = await dispatchAgent(agentId, launch.argumentsList, launchOptions);
        }
        if (status !== 0) throw new Error(`${getAgent(agentId).displayName} exited with status ${status}`);
        const discoveredId = nativeSessionId
          ?? await targetAdapter.discoverNativeSession(projectRoot, { environment, notBefore: launchStartedAt });
        return { nativeSessionId: discoveredId, projectionHash: launchedContinuation.handoff.hash, capturedDuringLaunch };
      },
    });
    reportSessionDiagnostics(result.diagnostics);
    await setActiveCanonicalSession(projectRoot, mode);
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
    reportSessionDiagnostics(results.flatMap((result) => result.diagnostics ?? []));
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
    const untracked = untrackSessions(projectRoot);
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

export async function runCli(options = {}) {
  const argumentsList = options.argumentsList ?? process.argv.slice(2);
  const forcedAgent = options.forcedAgent;
  if (forcedAgent) {
    return dispatchAgent(forcedAgent, argumentsList);
  }
  const [command, ...remainingArguments] = argumentsList;
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
    return dispatchProjectSetup(remainingArguments);
  }
  if (command === "change") {
    return dispatchProjectSetup(remainingArguments, true);
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
    return dispatchSessions(remainingArguments);
  }
  if (command === "update") {
    if (remainingArguments.length > 0) {
      throw new Error("Usage: avenic self-update");
    }
    await updateAvenic(packageRoot);
    return 0;
  }
  if (command === "status") {
    return dispatchStatus();
  }
  if (command === "doctor") {
    return dispatchDoctor();
  }
  // Anything left is either a legacy top-level command (add, self-update,
  // uninstall, packs, tree, ...) or a Pack id. Pack ids are user-defined, so
  // the catalog is the only source of truth for telling Packs from typos;
  // delegate to the skills dispatcher, which resolves known commands locally
  // before any catalog work.
  return dispatchSkills(argumentsList, {
    io: console,
    cwd: process.cwd(),
    environment: process.env,
  });
}
