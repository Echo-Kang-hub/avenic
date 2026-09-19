// Starting an Agent is the one command whose latency the user feels directly:
// everything here runs between "avenic claude" and the Agent's first paint, so
// this module loads the narrowest slice of core that a launch needs instead of
// the whole barrel. The work itself is the same work `avenic <agent> <command>`
// does — there is one implementation of a launch, and it lives here; the
// command dispatcher imports this module for it.
import process from "node:process";
import { getAgent } from "#core/runtime/agents.mjs";
import { agentEnvironment, resolveEffectiveAgentRuntime } from "#core/runtime/agent-runtime.mjs";
import { getSessionAdapter } from "#core/runtime/adapters/index.mjs";
import {
  effectiveAgentConfig,
  loadRuntime,
  projectConfig,
} from "#core/runtime/config.mjs";
import { formatSessionDiagnostics } from "#core/runtime/diagnostics.mjs";
import { locateProjectRoot } from "#core/runtime/project-root.mjs";
import { spawnExecutableSync } from "#core/runtime/process.mjs";
import { finishLaunch, joinLaunchGroup } from "#core/runtime/session-interop.mjs";
import { markLaunchClosing } from "#core/runtime/sessions.mjs";
import { createInstallContext, managedSkillNames } from "#core/skills/install.mjs";
import { ensureSkillLinks, formatLinkSummary, linkSummaryChanged, logConflicts } from "#core/skills/links.mjs";
import { mark, reportLaunchTiming, timed } from "#core/runtime/timing.mjs";
import { spawnSessionWatchdog } from "./watchdog.mjs";

mark("modules");

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
function closeLaunchWatch(agentId, projectRoot, member) {
  if (!member) return;
  try {
    markLaunchClosing(agentId, projectRoot, member);
  } catch {}
}

// Session problems found while capturing history: one line per problem, once
// per command. `avenic <agent> sessions import` reports the same ones.
export function reportSessionDiagnostics(diagnostics, options = {}) {
  const { warnings, notes } = formatSessionDiagnostics(diagnostics, options);
  for (const note of notes) console.log(note);
  for (const warning of warnings) console.warn(`⚠ ${warning}`);
}

/**
 * Run `avenic <agent> [arguments]` as a launch: resolve the Agent's runtime
 * from the project configuration, hand it the project's session records, run
 * it in the foreground, then capture what it produced. `options` carries what
 * a test needs to drive the same path without a terminal: an explicit
 * `projectRoot`, a captured child, and hooks around the exit sequence.
 */
export async function launchAgent(agentId, argumentsList, options = {}) {
  const agent = getAgent(agentId);
  const projectRoot = options.projectRoot ?? await timed("project", () => locateProjectRoot());
  const state = await timed("config", () => loadRuntime(projectRoot));
  const config = effectiveAgentConfig(state, agentId);
  if (!config) {
    throw new Error(`${agent.displayName} is not initialized. Run: avenic ${agentId} init`);
  }
  const environment = options.environment ?? agentEnvironment(state, projectRoot, agentId);
  const adapter = getSessionAdapter(agentId);
  const portableSessions = config.sessions !== "global";
  const sharedSessions = projectConfig(state).sessionInterop === "shared";
  // Recovery for sessions another agent left behind belongs to the explicit
  // `sessions` and `change` commands. A plain launch reaches the official TUI
  // first — a new conversation, no projection work, whatever the project's
  // history mode — and captures its own agent's history on exit, while the
  // runtime watcher keeps that history durable while it runs. Continuing a
  // shared conversation is an explicit act (`avenic sessions continue`), which
  // is also where recovery and reconciliation happen.
  // Sessions created during a run live only in the project: the first launch
  // of a project+agent group snapshots the native storage and the last exit
  // reverts it. Launches of the same project+agent may run concurrently.
  // opencode's storage is managed by the official CLI, so it captures without
  // snapshotting or reverting; the group is null for it.
  const group = portableSessions ? await timed("launch-group", () => joinLaunchGroup(projectRoot, agentId, { environment })) : null;
  if (portableSessions && !options.skipRestore) {
    // Project session records take priority on launch: conflicting native
    // copies are overwritten silently. Native storage is never written to
    // proactively; only `avenic <agent> sessions writeback` writes project
    // records back to native storage.
    try {
      await timed("restore", () => adapter.restore(projectRoot, { environment }));
    } catch (error) {
      if (group) {
        // Leaving the group reverts native storage when this was the only
        // launch in it.
        try {
          await group.release();
        } catch {}
      }
      throw error;
    }
  }
  if (portableSessions) {
    // Every project-scoped launch gets a durability watch, whether or not the
    // agent's native storage is isolated for the run. It starts *after* the
    // restore: a watch is a periodic capture of native storage, and one whose
    // first pass lands mid-restore reads a half-filled native tree — the exact
    // shape the capture's "native does not hold it" logic must never treat as
    // a deletion. The agent cannot have written anything before it starts, so
    // nothing is left unguarded by waiting.
    try {
      await timed("watchdog", () => spawnSessionWatchdog(agentId, projectRoot, group?.member ?? null, environment));
    } catch {}
  }
  // 启动补齐（spec §5.5）：会话适配器收尾之后、拉起 Agent 之前，按受管集合把缺席/失效的
  // 链接补回来。未安装过 Skills 的项目零副作用（受管集合为空 → 一个字节都不写）。
  // 失败绝不影响启动：打印一行警告后照常拉起 Agent（spec §11）。
  try {
    await timed("skills-repair", async () => {
      const installContext = createInstallContext(false, { cwd: projectRoot, environment: process.env });
      const managed = await managedSkillNames(installContext);
      if (managed.size > 0) {
        const linkResult = await ensureSkillLinks(installContext, managed, { silent: true });
        const { counts } = linkResult;
        if (linkSummaryChanged(counts)) {
          console.log(`Skills shared: ${formatLinkSummary(counts)}`);
        }
        logConflicts(console, linkResult.conflicts);
      }
    });
  } catch (error) {
    console.warn(`⚠ Skills repair skipped: ${error.code ?? error.message}`);
  }
  // The official CLI receives exactly the arguments the user typed — nothing
  // more. `avenic claude` is `claude`: it opens a new conversation every time,
  // even in a project whose history mode is Shared with an active conversation.
  // Shared history says what the project *can* do, never what this launch must
  // do; a resumed conversation is chosen by the user, through
  // `avenic sessions continue <canonical-id> --agent <agent>` or the agent's
  // own `/resume`. Injecting a session into a plain launch turned a stale
  // mapping into `claude --resume <gone-session>` ("No conversation found with
  // session ID …") and silently forked conversations that were meant to be new.
  const launchArguments = argumentsList;
  const runtime = await timed("agent-runtime", () => resolveEffectiveAgentRuntime(projectRoot, agentId, {
    state,
    environment,
    argumentsList: launchArguments,
    io: console,
  }));
  if (runtime.note) console.log(runtime.note);
  let status;
  let launchResult;
  reportLaunchTiming();
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
      closeLaunchWatch(agentId, projectRoot, group?.member ?? null);
      const captured = await finishLaunch(projectRoot, agentId, {
        environment,
        member: group?.member ?? null,
        setActive: !options.skipCanonical && sharedSessions,
        // The continuation reader must still see the native session this run
        // produced, so it runs before the last member reinstates the snapshot.
        beforeRevert: options.onExit,
      });
      reportSessionDiagnostics(captured.diagnostics);
    }
  }
  return options.capture ? launchResult : status;
}
