// `avenic hook emit` — the process an agent's own hook calls, once per turn.
//
// It has three jobs and no fourth: read one native payload from stdin, hand it
// to core, and leave. Everything a user sees is off by default because this
// process's stdout belongs to the agent that called it — a stray line is not a
// log, it is input. `--verbose` is the same answer for a person, `--json` for a
// program.
//
// Which is also why this file loads as little as it can: core's hook modules
// and the project root, and not one line of the session machinery. The command
// runs on every turn of every agent, so its import graph is part of its
// contract (the test beside it scans this file's imports for exactly that).
import { HOOK_POLICY, hookCapability } from "#core/runtime/hooks.mjs";
import { emitHook, hookActionsPath, readHookActions } from "#core/runtime/hook-actions.mjs";
import { locateProjectRoot } from "#core/runtime/project-root.mjs";
import { takeOption } from "./options.mjs";

const AGENT_IDS = "claude|codex|opencode";
const EMIT_USAGE = `Usage: avenic hook emit --agent ${AGENT_IDS} [--verbose|--json]`;
const TEST_USAGE = `Usage: avenic hook test --agent ${AGENT_IDS}`;
// 写配置的那一半在另一个模块里，并且是**动态**引来的：这五个字符串讲得出它的用法，
// 而 `emit` 那条路（每一轮都要跑一次的那条）不该为它们付出加载成本。
const SETUP_VERBS = ["install", "uninstall", "status"];

// 一个钩子载荷是几 KB 的 JSON。上限不是防谁，是让读入有个尽头：stdin 是 agent 给的
// 管道，而一个永远不结束的管道不该让这一轮挂在这儿。字节上限拦得住大载荷，拦不住
// 永远不来的载荷 —— 那一个是时间，下面这一条。
const MAX_PAYLOAD_BYTES = 256 * 1024;
const READ_TIMEOUT_MS = 10_000;

function fail(io, message) {
  io.error(message);
  return 1;
}

function takeFlag(values, flag) {
  const index = values.indexOf(flag);
  if (index === -1) return false;
  values.splice(index, 1);
  return true;
}

function collectPayload(stdin) {
  return (async () => {
    const chunks = [];
    let size = 0;
    for await (const chunk of stdin) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      size += buffer.length;
      if (size > MAX_PAYLOAD_BYTES) return { error: `The payload on stdin is larger than ${MAX_PAYLOAD_BYTES / 1024} KB — that is not a hook event.` };
      chunks.push(buffer);
    }
    return { text: Buffer.concat(chunks).toString("utf8").trim() };
  })();
}

async function readPayload(stdin, timeoutMs) {
  if (stdin?.isTTY) return { error: "No payload on stdin — avenic hook emit reads one hook event as JSON from stdin." };
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => {
      // 把管道收掉：一个还在写的 agent 不该继续往一个不再读的进程里写。到点上报的是
      // 「什么时候停的」，不是载荷的任何内容。
      try { stdin.destroy?.(); } catch {}
      reject(new Error(`The payload on stdin did not finish arriving within ${timeoutMs} ms — nothing was emitted.`));
    }, timeoutMs);
  });
  let collected;
  try {
    collected = await Promise.race([collectPayload(stdin), expired]);
  } catch (error) {
    return { error: error?.message ?? String(error) };
  } finally {
    clearTimeout(timer);
  }
  if (collected.error !== undefined) return collected;
  const text = collected.text;
  if (text === "") return { error: "No payload on stdin — avenic hook emit reads one hook event as JSON from stdin." };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 不回显：JSON.parse 的消息本身会把载荷的头几个字符抄一遍，而这一段是 agent 的
    // 会话内容 —— 报「不是 JSON」就够了，改哪一行是它自己的事。
    return { error: "The payload on stdin is not JSON." };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { error: "The payload on stdin is not a hook event — a JSON object is expected." };
  }
  return { payload: parsed };
}

/**
 * What one emit did, in the words a person reads on `--verbose`. A sentence is
 * printed even when nothing ran: silence on a bare `avenic hook emit` means
 * "no notification was due", and a user debugging a hook needs the difference
 * between that and "your action never fired".
 */
function describe(result, projectRoot, environment) {
  const lines = [];
  if (result.skipped === "deduped") lines.push(`Skipped: the same event was already reported within the last ${HOOK_POLICY.dedupeSeconds} seconds.`);
  else if (result.skipped === "too-short") lines.push(`Skipped: the turn was shorter than ${HOOK_POLICY.completedMinSeconds} seconds.`);
  else if (result.skipped === "unknown-event") lines.push("Skipped: this payload is not an event Avenic knows.");
  for (const item of result.results) lines.push(`${item.state}  ${item.id} (${item.kind}) — ${item.detail}`);
  if (lines.length === 0) {
    lines.push(readHookActions(projectRoot, environment).length === 0
      ? `No notification actions are configured — add one to ${hookActionsPath(projectRoot)}.`
      : `No notification is defined for ${result.event?.event ?? "this event"}.`);
  }
  return lines;
}

// 一次测试要看得见，所以它每次都是一个新会话：同一个指纹在去重窗口里只会响一次，
// 而「再跑一次测试看看」不该被自己去重掉。
function testPayload(capability) {
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const payload = { [capability.reads.event]: capability.events["turn.completed"].native };
  if (capability.reads.session !== null) payload[capability.reads.session] = `avenic-hook-test-${stamp}`;
  if (capability.reads.turn !== null) payload[capability.reads.turn] = `avenic-hook-test-${stamp}`;
  return payload;
}

function agentFrom(values, usage) {
  let agentId;
  try {
    agentId = takeOption(values, "--agent");
  } catch (error) {
    return { error: `${error.message}. ${usage}` };
  }
  if (agentId === null) return { error: `Missing --agent. ${usage}` };
  if (hookCapability(agentId) === null) return { error: `Unknown agent: ${agentId}. ${usage}` };
  return { agentId };
}

// The project this emit is about is the directory the hook process is in — the
// same answer every other command gives, and one no payload can steer.
const projectOf = (cwd) => locateProjectRoot(cwd);

async function emitVerb(argumentsList, context) {
  const { io, environment, cwd, stdin, emitIo, readTimeoutMs } = context;
  const values = [...argumentsList];
  const agent = agentFrom(values, EMIT_USAGE);
  if (agent.error !== undefined) return fail(io, agent.error);
  const asJson = takeFlag(values, "--json");
  const verbose = takeFlag(values, "--verbose");
  if (values.length > 0) return fail(io, `Unknown option for avenic hook emit: ${values[0]}. ${EMIT_USAGE}`);

  const read = await readPayload(stdin, readTimeoutMs ?? READ_TIMEOUT_MS);
  if (read.error !== undefined) return fail(io, read.error);

  const projectRoot = projectOf(cwd);
  const result = await emitHook({ agentId: agent.agentId, payload: read.payload, projectRoot, environment, ...(emitIo === undefined ? {} : { io: emitIo }) });
  // --json 是一份机器对象，所以它自己就是全部输出：再添几行英文，解析它的程序就得先
  // 学会跳过它们。
  if (asJson) io.log(JSON.stringify(result));
  else if (verbose) for (const text of describe(result, projectRoot, environment)) io.log(text);
  return 0;
}

/**
 * The first hop, next to the last one. `hook test` can only prove that Avenic
 * dispatches what it is handed; whether the agent ever hands it anything is a
 * question about the file — so the answer is printed with the test, in the
 * three states it has. Codex's caveat rides along, because a hook that is
 * installed but untrusted fails exactly like one that is not installed at all.
 *
 * Loaded lazily: the emit path next door runs on every turn and must not pay
 * for the install machinery's import graph.
 */
async function installationLines(agentId, projectRoot, environment) {
  const [{ hookPlan }, { detectAgentInstallationAsync }] = await Promise.all([import("#core/runtime/hook-install.mjs"), import("#core/runtime/versions.mjs")]);
  const installation = await detectAgentInstallationAsync(agentId, { environment });
  const plan = await hookPlan(agentId, { scope: "project", projectRoot, environment, version: installation.version });
  if (!plan.supported) return [`Hooks: ${plan.note}`];
  if (!plan.installed) return [`Hooks: not installed for this project — run: avenic hook install --agent ${agentId} --scope project`];
  const lines = [`Hooks: installed — ${plan.file}`];
  if (plan.caveat !== "") lines.push(`${plan.displayName}: ${plan.caveat}`);
  return lines;
}

async function testVerb(argumentsList, context) {
  const { io, environment, cwd, emitIo } = context;
  const values = [...argumentsList];
  const agent = agentFrom(values, TEST_USAGE);
  if (agent.error !== undefined) return fail(io, agent.error);
  if (values.length > 0) return fail(io, `Unknown option for avenic hook test: ${values[0]}. ${TEST_USAGE}`);

  const capability = hookCapability(agent.agentId);
  const projectRoot = projectOf(cwd);
  const installation = await installationLines(agent.agentId, projectRoot, environment);
  // 这条命令测的是**动作那一条链**（Avenic 自己的名单，与哪个 agent 无关），第一跳只是
  // 印在旁边的一行事实。所以 version too old / 没装 / 什么都还没配，都不拦这一发：拦下来
  // 用户就没有任何办法验证自己的通知，而他想知道的正是这个。
  const configured = readHookActions(projectRoot, environment);
  const result = await emitHook({ agentId: agent.agentId, payload: testPayload(capability), projectRoot, environment, ...(emitIo === undefined ? {} : { io: emitIo }) });
  io.log(`Test event: a synthetic turn.completed for ${capability.displayName} — nothing happened in your agent.`);
  for (const line of installation) io.log(line);
  for (const item of result.results) io.log(`${item.state}  ${item.id} (${item.kind}) — ${item.detail}`);
  if (configured.length === 0) {
    io.log(`No actions are configured — add one to ${hookActionsPath(projectRoot)} to receive notifications.`);
  } else {
    io.log("The message carries no duration: no turn start was recorded for it, and a real turn measures one between its own start and its end.");
  }
  return 0;
}

/**
 * The `hook` verb of the CLI. Returns the process's exit code: 0 when the emit
 * was accepted or deliberately skipped, 1 only for a usage mistake or a payload
 * that could not be read — an action that failed is reported and still exits 0,
 * because a webhook that is down must never fail the turn that reported it.
 */
export async function dispatchHookCommand(argumentsList, options = {}) {
  const context = {
    io: options.io ?? console,
    environment: options.environment ?? process.env,
    cwd: options.cwd ?? process.cwd(),
    stdin: options.stdin ?? process.stdin,
    // 动作层（时钟、平台、spawn、fetch）是可注入的，测试用它把网络、桌面和 shell 都
    // 换成记录器；生产里一个都不传，用的就是真的那几个。读数那条等待也一样（readTimeoutMs）。
    emitIo: options.emitIo,
    readTimeoutMs: options.readTimeoutMs,
  };
  const [verb, ...rest] = Array.isArray(argumentsList) ? argumentsList : [];
  if (verb === "emit") return emitVerb(rest, context);
  if (verb === "test") return testVerb(rest, context);
  if (verb === "help" || verb === "--help" || verb === "-h") {
    const { SETUP_USAGE } = await import("./hooks-install-cli.mjs");
    context.io.log([EMIT_USAGE, TEST_USAGE, ...SETUP_USAGE].join("\n"));
    return 0;
  }
  if (SETUP_VERBS.includes(verb)) {
    const { dispatchHookSetup } = await import("./hooks-install-cli.mjs");
    return dispatchHookSetup(verb, rest, context);
  }
  return fail(context.io, `${verb === undefined ? "Missing hook command." : `Unknown hook command: ${verb}.`} ${EMIT_USAGE}`);
}
