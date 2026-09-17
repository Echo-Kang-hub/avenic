import path from "node:path";
import { randomUUID } from "node:crypto";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  AGENTS,
  acquireSessionLease,
  agentExecutableAvailable,
  bindProject,
  clearLocalAuth,
  createInstallContext,
  deinitializeAgent,
  effectiveAgentConfig,
  ensureSkillLinks,
  formatLinkSummary,
  getAgent,
  getActiveCanonicalSessionId,
  getSessionAdapter,
  initializeAgent,
  importProjectSessions,
  loadRuntime,
  locateProjectRoot,
  logConflicts,
  listCanonicalSessions,
  captureCanonicalSession,
  reconcileCanonicalSession,
  continueCanonicalSession,
  continuationLaunchArguments,
  managedSkillNames,
  projectCanonicalSession,
  readCanonicalSession,
  projectAuthEnvironment,
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
  validateSessionsMode,
} from "#core";
import { dispatchModel } from "./model-cli.mjs";
import { dispatchHub, dispatchSkills } from "./skills-cli.mjs";
import { updateAvenic } from "./self-update.mjs";
import { spawnSessionWatchdog } from "./watchdog.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

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

export function printHelp(io = console) {
  io.log(`Avenic

CLI: avenic (shorthand: ave)

Agent runtimes:
  avenic <claude|codex|opencode> init [--auth global|project] [--sessions global|project]
  avenic <claude|codex|opencode> deinit [--purge]
  avenic <claude|codex|opencode> auth [global|project|reset]
  avenic <claude|codex|opencode> status
  avenic <claude|codex|opencode> sessions [import|writeback|status]
  avenic <claude|codex|opencode> [official CLI arguments...]
  avenic sessions list                 List unified canonical sessions
  avenic sessions continue <id> --agent <claude|codex|opencode>
  avenic sessions git [on|off|status]
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
    if (action === "import" && result.discovered === 0 && result.diagnostics?.length) {
      console.log(`Note      ${result.diagnostics[0]}`);
    }
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
  const environment = options.environment ?? (config.auth === "project"
    ? { ...process.env, ...projectAuthEnvironment(agentId, projectRoot) }
    : process.env);
  const adapter = getSessionAdapter(agentId);
  const portableSessions = config.sessions !== "global";
  // Project sessions always follow the active canonical session. This keeps
  // the ordinary `avenic <agent>` path identical to `sessions continue` and
  // prevents an older native/portable rollout from winning by mtime.
  if (portableSessions && !options.skipCanonical && argumentsList.length === 0) {
    let activeCanonicalId = await getActiveCanonicalSessionId(projectRoot);
    if (!activeCanonicalId) {
      // Legacy project sessions are imported once before the first unified
      // launch. This is migration, not a second launch/recovery pipeline.
      await importProjectSessions(projectRoot, agentId, { environment });
      activeCanonicalId = (await listCanonicalSessions(projectRoot))[0]?.id ?? null;
      if (activeCanonicalId) await setActiveCanonicalSession(projectRoot, activeCanonicalId);
    }
    if (activeCanonicalId) {
      return dispatchSessions(["continue", activeCanonicalId, "--agent", agentId], { projectRootOverride: projectRoot });
    }
  }
  // Sessions created during a run live only in the project: the first launch
  // of a project+agent group snapshots the native storage and the last exit
  // reverts it. Launches of the same project+agent may run concurrently.
  // opencode's storage is managed by the official CLI, so it captures without
  // snapshotting or reverting.
  const isolatesNative = typeof adapter.snapshotNative === "function"
    && typeof adapter.revertNative === "function";
  let leaveLaunchGroup = null;
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
    try {
      await spawnSessionWatchdog(agentId, projectRoot, lease.member, environment);
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
  try {
    status = launchExecutable(runtime.executable, runtime.argumentsList, { cwd: projectRoot, environment: runtime.environment, input: options.input });
  } finally {
    if (portableSessions) {
      try {
        await adapter.capture(projectRoot, { environment });
        if (typeof options.onExit === "function") await options.onExit({ environment, projectRoot });
      } finally {
        if (leaveLaunchGroup) {
          await leaveLaunchGroup();
        }
      }
    }
  }
  return status;
}

async function dispatchStatus() {
  const projectRoot = locateProjectRoot();
  const state = await loadRuntime(projectRoot);
  console.log("Avenic Status\n");
  console.log(`Project  ${projectRoot}\n`);
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

async function dispatchSessions(argumentsList, options = {}) {
  const [command, mode = "status", ...extra] = argumentsList;
  const projectRoot = options.projectRootOverride ?? locateProjectRoot();
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
    const config = effectiveAgentConfig(state, agentId);
    if (!config) throw new Error(`${getAgent(agentId).displayName} is not initialized. Run: avenic ${agentId} init`);
    const environment = config.auth === "project"
      ? { ...process.env, ...projectAuthEnvironment(agentId, projectRoot) }
      : process.env;
    if (agentId === "opencode") {
      const projection = await projectCanonicalSession(projectRoot, mode, agentId, { environment });
      try {
        return await dispatchAgent(agentId, ["--session", projection.nativeSessionId], { projectRoot, environment });
      } finally {
        await captureCanonicalSession(projectRoot, mode, agentId, { environment });
      }
    }

    const targetAdapter = getSessionAdapter(agentId);
    const targetStored = await readCanonicalSession(projectRoot, mode);
    const targetMapping = targetStored.mappings.projections[agentId];
    // Codex's native history is an opaque rollout projection. If its cursor
    // is behind the canonical tail, rehydrate a fresh official thread rather
    // than reopening an old transcript (the old thread remains untouched).
    const forceBootstrap = agentId === "codex"
      && Boolean(targetMapping?.nativeSessionId)
      && targetMapping.lastCanonicalEventId !== targetStored.events.at(-1)?.id;
    let capturedDuringLaunch = null;
    const result = await continueCanonicalSession({
      projectRoot,
      canonicalId: mode,
      targetAgent: agentId,
      environment,
      forceBootstrap,
      // Every call resolves the normal auth/runtime environment for that
      // agent. Sessions never manufacture or migrate credential directories.
      captureKnown: async () => {
        const results = await reconcileCanonicalSession(projectRoot, mode, {
          environmentForAgent: (sourceAgent) => {
            const sourceConfig = effectiveAgentConfig(state, sourceAgent);
            if (!sourceConfig) return process.env;
            return sourceConfig.auth === "project"
              ? { ...process.env, ...projectAuthEnvironment(sourceAgent, projectRoot) }
              : process.env;
          },
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
        const nativeSessionId = continuation.nativeSessionId
          ?? (agentId === "claude" ? randomUUID() : null);
        const launch = continuationLaunchArguments({ ...continuation, nativeSessionId });
        const launchStartedAt = Date.now() - 1000;
        console.log(`Continuing ${mode} with ${getAgent(agentId).displayName}: ${continuation.mode}; delta ${continuation.handoff.delta.length} event(s).`);
        const status = await dispatchAgent(agentId, launch.argumentsList, {
          projectRoot,
          environment,
          input: launch.input,
          skipCanonical: true,
          skipRestore: true,
          onExit: async () => {
            const nativeId = nativeSessionId ?? await targetAdapter.discoverNativeSession(projectRoot, { environment, notBefore: launchStartedAt });
            capturedDuringLaunch = await targetAdapter.readCanonical(projectRoot, nativeId, { environment, canonicalSessionId: mode });
          },
        });
        if (status !== 0) throw new Error(`${getAgent(agentId).displayName} exited with status ${status}`);
        const discoveredId = nativeSessionId
          ?? await targetAdapter.discoverNativeSession(projectRoot, { environment, notBefore: launchStartedAt });
        return { nativeSessionId: discoveredId, projectionHash: continuation.handoff.hash, capturedDuringLaunch };
      },
    });
    for (const diagnostic of result.diagnostics ?? []) console.warn(diagnostic);
    await setActiveCanonicalSession(projectRoot, mode);
    return result.launched.status ?? 0;
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
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return 0;
  }
  if (Object.hasOwn(AGENTS, command)) {
    return dispatchAgent(command, remainingArguments);
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
