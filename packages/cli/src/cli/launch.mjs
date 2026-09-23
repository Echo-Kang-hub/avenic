// Starting an Agent is the one command whose latency the user feels directly:
// everything here runs between "avenic claude" and the Agent's first paint, so
// this module loads the narrowest slice of core that a launch needs instead of
// the whole barrel. The work itself is the same work `avenic <agent> <command>`
// does — there is one implementation of a launch, and it lives here; the
// command dispatcher imports this module for it.
import process from "node:process";
import { getAgent } from "#core/runtime/agents.mjs";
import { LABELS } from "#core/labels.mjs";
import { machineEnvironment, agentRuntimeEnvironment, launchMethodQuestion, launchMethodReadiness, resolveEffectiveAgentRuntime } from "#core/runtime/agent-runtime.mjs";
import {
  effectiveAgentConfig,
  loadRuntime,
  projectConfig,
  setLocalAuth,
} from "#core/runtime/config.mjs";
import { formatSessionDiagnostics } from "#core/runtime/diagnostics.mjs";
import { locateProjectRoot } from "#core/runtime/project-root.mjs";
import { spawnExecutableSync } from "#core/runtime/process.mjs";
import { beginLaunch, finishLaunch } from "#core/runtime/session-interop.mjs";
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
  let state = await timed("config", () => loadRuntime(projectRoot));
  let config = effectiveAgentConfig(state, agentId);
  if (!config) {
    throw new Error(`${agent.displayName} is not initialized. Run: avenic ${agentId} init`);
  }
  // A project that has not answered — a freshly migrated one, or one whose
  // owner asked to be asked — is asked here, once, in one frame: which
  // authentication this launch runs under. Answering "remember" writes that
  // answer and nothing else. Reading only local state: no network, no model.
  // An agent that manages its own authentication is never asked: for it the
  // question does not exist, and there is no answer for a project to record.
  let launchMethod = null;
  if (!config.authMethod && !agent.managesOwnAuth) {
    const prompts = options.prompts ?? {};
    // Which of the two methods this project could already run under — a kept
    // API configuration, an account that has signed in here — so the question
    // says which are set up rather than offering two choices that look alike.
    // Read from local files only, and only on the path that asks.
    const question = launchMethodQuestion(agentId, await launchMethodReadiness(projectRoot, agentId, { config }));
    // The question's layer is imported here rather than at the top: a launch
    // that already knows its answer never draws a frame, and paying for the
    // terminal layer on every ordinary launch would be a cost with no reader.
    // The TTY test is the same one prompts.mjs makes, spelled inline for that
    // reason alone.
    const interactive = prompts.stdin !== undefined
      ? prompts.stdin?.isTTY === true && prompts.stdout?.isTTY === true
      : process.stdin.isTTY === true && process.stdout.isTTY === true;
    if (interactive && !options.capture) {
      const { confirm, singleSelect } = await import("./prompts.mjs");
      launchMethod = await singleSelect({ ...prompts, title: question.title, options: question.options });
      if (launchMethod === null || launchMethod === undefined) return 0; // Esc cancels the launch
      if (await confirm({ ...prompts, title: question.rememberTitle, initial: false })) {
        await setLocalAuth(projectRoot, agentId, { authMethod: launchMethod });
        state = await loadRuntime(projectRoot);
        config = effectiveAgentConfig(state, agentId);
      }
    } else {
      launchMethod = "account";
      console.log(`${agent.displayName}: ${LABELS.authentication} ${LABELS.notChosen} for this project — launching with its native account. Run \`avenic ${agentId} init\` to choose.`);
    }
  }
  const environment = options.environment ?? machineEnvironment();
  const sharedSessions = projectConfig(state).historyMode === "shared";
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
  // Both halves of that protocol — the group this launch joins and the capture
  // its exit runs — are core's, shared with the VS Code extension.
  // The run's native storage lives under the environment the agent itself will
  // run in — for a Project account that is the project's own home, not the
  // user's — so the snapshot, the watch and the exit capture all take this one
  // value rather than the caller's environment.
  const runtimeEnvironment = agentRuntimeEnvironment(projectRoot, agentId, config, environment);
  const { portable: portableSessions, member } = await timed("launch-storage", () =>
    beginLaunch(projectRoot, agentId, { config, environment: runtimeEnvironment, skipRestore: options.skipRestore }));
  if (portableSessions) {
    // Every project-scoped launch gets a durability watch, whether or not the
    // agent's native storage is isolated for the run. It starts *after* the
    // restore: a watch is a periodic capture of native storage, and one whose
    // first pass lands mid-restore reads a half-filled native tree — the exact
    // shape the capture's "native does not hold it" logic must never treat as
    // a deletion. The agent cannot have written anything before it starts, so
    // nothing is left unguarded by waiting.
    try {
      await timed("watchdog", () => spawnSessionWatchdog(agentId, projectRoot, member, runtimeEnvironment));
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
    launchMethod,
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
      closeLaunchWatch(agentId, projectRoot, member);
      const captured = await finishLaunch(projectRoot, agentId, {
        environment: runtimeEnvironment,
        member,
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
