// What Avenic does with one event, once the vocabulary above has said what it is.
//
// `hooks.mjs` is the part that cannot lie about what the agents support; this is
// the part that decides whether anyone gets told. Three rules run through it:
//
//   * A notification fires only when HOOK_POLICY says it may. A turn that took
//     two seconds is not news, a turn that died is news at once, and the same
//     thing happening twice in the window is one banner — a user who is told
//     the same fact three times turns the feature off.
//   * A duration is measured or it is absent. The correlator is the pair
//     `turn.started` → `turn.completed`: the start records the moment, the
//     completion reads it back. A completion with no recorded start is still
//     reported, with the duration left out — a threshold cannot be applied to a
//     number nobody measured, and silently dropping the notification would read
//     as "the hook is broken", which is the one failure a user cannot debug.
//   * Nothing here touches the shared conversation. Hook traffic and the
//     semantic session model are separate systems: this module reads and writes
//     one small state file of timestamps, and knows nothing about sessions,
//     transcripts, cursors or the projection. That is a product invariant, not
//     a coincidence — the test behind it scans this module's imports.
//
// The actions themselves are deliberately plain: a desktop notification with no
// dependency, an HTTP POST, the OpenClaw gateway preset, and a user's own
// command. Everything they need from the outside world — the clock, the
// platform, the process spawner, fetch — arrives as `io`, so a test drives all
// four without opening a socket, showing a banner or running a shell.

import { spawn as spawnProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "./atomic-file.mjs";
import { HOOK_POLICY, hookCapability, hookFingerprint, normalizeHook } from "./hooks.mjs";
import { maskSecrets, parseJsonObject } from "./model-write.mjs";
import { runtimePaths } from "./project-paths.mjs";
import { stateRoot } from "../skills/paths.mjs";

/** The kinds a row in the actions file may name. */
export const HOOK_ACTION_KINDS = ["desktop", "openclaw", "webhook", "command"];

// OpenClaw's local gateway, and the hook entrypoint on it. The token is a hook
// token — its own thing, never the gateway's auth token — and it travels in a
// header; a credential in a query string ends up in every proxy log on the way.
const OPENCLAW_GATEWAY = "http://127.0.0.1:18789";
const OPENCLAW_PATH = "/hooks/avenic";

// The emit runs inside the agent's own hook, so every wait it takes is a wait
// the turn takes. These bound ONE action; the chain itself has one shared
// budget (HOOK_POLICY.dispatchBudgetSeconds), and an action may lower its own.
const DEFAULT_TIMEOUT_MS = 2000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 30_000;

const STATE_SCHEMA = 1;
// A turn older than this is not the turn that just finished. Starts are kept
// (not consumed) so that a second Stop reporting the same turn measures the
// same duration instead of reporting it a second time as unmeasured.
const TURN_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const TURN_LIMIT = 128;
const MESSAGE_LIMIT = 200;

// HOOK_POLICY names three events and the condition each one has; it says
// nothing about the other three. A session beginning or ending is not on its
// own worth interrupting anyone for, and a turn starting is the opposite of
// news — so those three are accepted (the emit exits 0) and no action runs for
// them. A start is still written down, because the completion needs it.
const REPORTED_EVENTS = new Set(["turn.completed", "turn.failed", "attention.required"]);

/** Where this project's actions are read from. */
export function hookActionsPath(projectRoot) {
  return path.join(runtimePaths(projectRoot).localRoot, "hook-actions.json");
}

// 项目级的动作在那个项目的 .agents/local/ 下。项目被 Avenic 配置过之后那里的 gitignore
// 规则会挡着它，而一条动作里可能有 hook token；没配过的项目没有这条规则，所以这个文件
// 自己也按 0600 写（见 writeHookActions）。全机的那一份跟着 Avenic 的机器状态走，和别的
// 全局配置一个家。
function globalHookActionsPath(environment) {
  return path.join(stateRoot(environment), "hook-actions.json");
}

/** One scope's own list, in the place that scope keeps it. Both scopes name their file through this. */
export function hookActionsPathAt(projectRoot, scope, environment = process.env) {
  if (scope !== "project" && scope !== "global") throw new Error(`Unknown hook action scope: ${scope}`);
  return scope === "global" ? globalHookActionsPath(environment) : hookActionsPath(projectRoot);
}

/** The one file the dedupe window and the turn starts live in. */
export function hookStatePath(projectRoot) {
  return path.join(runtimePaths(projectRoot).localRoot, "hook-state.json");
}

function readActionsFile(file) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // 读不出来就是没有动作。一个被手改坏的文件不该让每一轮 agent 的钩子都抛异常 ——
    // 用户看不到通知时会去读文件，而异常只会出现在 agent 的日志里。
    return [];
  }
  const entries = Array.isArray(parsed?.actions) ? parsed.actions : [];
  return entries
    .filter((entry) => entry !== null && typeof entry === "object" && typeof entry.id === "string" && entry.id.trim() !== "" && HOOK_ACTION_KINDS.includes(entry.kind))
    .map((entry) => ({ ...entry, id: entry.id.trim() }));
}

/**
 * The actions of one scope over the other's, project winning by id.
 *
 * Merged by id rather than concatenated because the two files answer the same
 * question at two levels: the machine's list is what this user wants
 * everywhere, and a project that names the same id is answering for itself.
 */
export function readHookActions(projectRoot, environment = process.env) {
  const byId = new Map();
  for (const file of [globalHookActionsPath(environment), hookActionsPath(projectRoot)]) {
    for (const action of readActionsFile(file)) byId.set(action.id, action);
  }
  return [...byId.values()].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

const byId = (left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

/** The actions of one scope, exactly as that scope's own file holds them. */
export function readHookActionsAt(projectRoot, scope, environment = process.env) {
  return readActionsFile(hookActionsPathAt(projectRoot, scope, environment)).sort(byId);
}

function checkedAction(action) {
  if (!isRecord(action)) throw new Error("every hook action has to be an object");
  if (typeof action.id !== "string" || action.id.trim() === "") throw new Error("every hook action needs an id");
  if (!HOOK_ACTION_KINDS.includes(action.kind)) throw new Error(`unknown hook action kind: ${String(action.kind)}`);
  return { ...action, id: action.id.trim() };
}

/**
 * One scope's list, written as the whole list.
 *
 * The page that edits notifications works on the list, not on a line in a file:
 * it reads a scope, changes one action, and hands the result back — so this is
 * the one writer, and the file it writes is Avenic's own (not an agent's
 * configuration), which is why there is no ownership marker here, only the
 * rules that keep a hand-edited file safe: nothing but the four kinds Avenic
 * can dispatch is accepted, a file that cannot be read is never overwritten,
 * and the file is written read-only to its owner — an action may carry a hook
 * token.
 */
export async function writeHookActions(projectRoot, scope, actions, { environment = process.env } = {}) {
  const file = hookActionsPathAt(projectRoot, scope, environment);
  const wanted = actions.map(checkedAction).sort(byId);
  for (let index = 1; index < wanted.length; index += 1) {
    if (wanted[index].id === wanted[index - 1].id) throw new Error(`two hook actions cannot share an id: ${wanted[index].id}`);
  }
  let before = "";
  try {
    before = readFileSync(file, "utf8");
  } catch {
    // 还没写过：那就是空的，不是错误。
  }
  const parsed = parseJsonObject(before);
  const value = `${JSON.stringify({ ...parsed, actions: wanted }, null, 2)}\n`;
  if (value === before) return { changed: false, file };
  await mkdir(path.dirname(file), { recursive: true });
  await writeFileAtomic(file, value, { mode: 0o600 });
  return { changed: true, file };
}

function readState(projectRoot) {
  try {
    const parsed = JSON.parse(readFileSync(hookStatePath(projectRoot), "utf8"));
    if (parsed?.schemaVersion === STATE_SCHEMA) {
      return { schemaVersion: STATE_SCHEMA, dedupe: isRecord(parsed.dedupe) ? parsed.dedupe : {}, turns: isRecord(parsed.turns) ? parsed.turns : {} };
    }
  } catch {
    // 这张表是缓存：丢了最多多发一条通知，绝不会少一条历史。
  }
  return { schemaVersion: STATE_SCHEMA, dedupe: {}, turns: {} };
}

// 按时间排序再落盘：文件的内容只随事实变化，不随插入顺序抖动，而且旧的先被丢掉。
function entriesWithin(map, now, maxAgeMs, limit) {
  const kept = Object.entries(map)
    .filter(([, at]) => typeof at === "number" && at <= now && now - at < maxAgeMs)
    .sort((left, right) => left[1] - right[1]);
  return limit === undefined ? kept : kept.slice(-limit);
}

async function saveState(projectRoot, state, now) {
  const file = hookStatePath(projectRoot);
  const value = `${JSON.stringify({
    schemaVersion: STATE_SCHEMA,
    dedupe: Object.fromEntries(entriesWithin(state.dedupe, now, HOOK_POLICY.dedupeSeconds * 1000)),
    turns: Object.fromEntries(entriesWithin(state.turns, now, TURN_MAX_AGE_MS, TURN_LIMIT)),
  }, null, 2)}\n`;
  try {
    if (existsSync(file) && readFileSync(file, "utf8") === value) return;
    await writeFileAtomic(file, value);
  } catch {
    // 写不下去也不能让这一轮失败：钩子是 agent 叫起来的，它没有权利把 agent 弄挂。
  }
}

// 一轮的身份：谁、在哪个会话、哪一回合。会话也是它的一部分 —— 两个 agent 的同一秒
// 是两件事，而一个会话里同时只有一轮。
const turnKey = (event) => [event.agent, event.sessionId ?? "", event.turnId ?? ""].join("|");

function measuredDuration(state, event, now) {
  const startedAt = state.turns[turnKey(event)];
  return typeof startedAt === "number" && now >= startedAt ? now - startedAt : null;
}

function formatDuration(milliseconds) {
  const seconds = Math.max(1, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const rest = seconds % 60;
  return rest === 0 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 60)}m ${rest}s`;
}

// 事件里的文本来自 agent，会进到别人的解释器和通知中心里（AppleScript、PowerShell、
// 通知中心自己的换行处理）。控制字符会把一条通知的其余部分吃掉，所以先去掉它们再限长。
// 这个字符类在运行时拼出来：写进源码的转义会以字符本身落地，而一个真的 NUL 字节会让
// 整个文件变成 grep 眼里的二进制。
const CONTROL_CHARACTERS = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]+`, "g");

function clean(value) {
  return typeof value === "string" ? value.replace(CONTROL_CHARACTERS, " ").trim().slice(0, MESSAGE_LIMIT) : "";
}

function notificationText(event, durationMs) {
  const name = hookCapability(event.agent)?.displayName ?? event.agent;
  if (event.event === "turn.completed") {
    return { title: name, body: durationMs === null ? `${name} finished a turn` : `${name} finished a turn (${formatDuration(durationMs)})` };
  }
  if (event.event === "turn.failed") {
    const reason = clean(event.reason);
    return { title: name, body: `${name} could not finish the turn${reason === "" || reason === "unknown" ? "" : ` — ${reason}`}` };
  }
  const detail = clean(event.detail);
  return { title: name, body: `${name} needs you${detail === "" ? "" : ` — ${detail}`}` };
}

/** One string literal for AppleScript: backslashes and quotes cannot escape it. */
function appleString(value) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** One string literal for PowerShell: a single quote is written twice. */
function powerShellString(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

function desktopCommand(text, platform) {
  if (platform === "darwin") {
    return { command: "osascript", args: ["-e", `display notification ${appleString(text.body)} with title ${appleString(text.title)}`] };
  }
  if (platform === "win32") {
    // Windows 上不需要装东西的那条路是托盘气泡。它属于进程，所以脚本自己多活一会儿：
    // 没有这一步，进程一退，通知就跟着没了。（真正需要 AppUserModelID 的 WinRT toast
    // 是应用的事，一个脚本编不出那个身份。）
    const script = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "$n = New-Object System.Windows.Forms.NotifyIcon",
      "$n.Icon = [System.Drawing.SystemIcons]::Information",
      "$n.Visible = $true",
      `$n.ShowBalloonTip(8000, ${powerShellString(text.title)}, ${powerShellString(text.body)}, 'Info')`,
      "$n.Visible = $false",
      "Start-Sleep -Milliseconds 8500",
      "$n.Dispose()",
    ].join("; ");
    return { command: "powershell", args: ["-NoProfile", "-NonInteractive", "-Command", script] };
  }
  if (platform === "linux") {
    return { command: "notify-send", args: ["--app-name", "Avenic", text.title, text.body] };
  }
  return null;
}

/**
 * A credential must not reach a command Avenic did not write.
 *
 * A `command` action is the user's own program, and the launch they configured
 * it in is usually a shell with a provider key exported into it. Those keys
 * belong to the agent the user started, not to every notifier they point at
 * their own turn — so they are dropped, and everything else (PATH above all) is
 * passed through, or the command would not run.
 */
const CREDENTIAL_VARIABLE = /^(ANTHROPIC|OPENAI|CLAUDE)_|(^|_)(API_KEY|KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?)($|_)/i;

function commandEnvironment(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !CREDENTIAL_VARIABLE.test(name)));
}

const timeoutOf = (action) => Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Number.isFinite(action.timeoutMs) ? action.timeoutMs : DEFAULT_TIMEOUT_MS));

function tokenOf(action, environment) {
  if (typeof action.token === "string" && action.token !== "") return action.token;
  const named = typeof action.tokenEnv === "string" ? environment[action.tokenEnv] : undefined;
  return typeof named === "string" && named !== "" ? named : null;
}

function headersOf(action, token) {
  const headers = { "content-type": "application/json", ...(isRecord(action.headers) ? action.headers : {}) };
  if (token !== null && headers.authorization === undefined && headers.Authorization === undefined) headers.Authorization = `Bearer ${token}`;
  return headers;
}

// 等，但不等过这个动作自己的上限，也不等过这条链子剩下的预算。计时器是 Avenic 自己的，
// 而不是交给运输方去守：这一段跑在 agent 的钩子里，它等多久用户这一轮就等多久，所以
// 「有个尽头」不能依赖 fetch 记不记得看 signal —— 一个不回答的地址在这里也只是慢，
// 不是卡死。signal 仍然传下去，它负责的是把请求放开。
function post(action, id, kind, url, event, token, toolkit, remainingMs) {
  const timeoutMs = Math.min(timeoutOf(action), remainingMs);
  return new Promise((resolve) => {
    const controller = new AbortController();
    let settled = false;
    const settle = (state, detail) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ id, kind, state, detail });
    };
    const timer = setTimeout(() => {
      controller.abort();
      settle("failed", `timed out after ${timeoutMs} ms`);
    }, timeoutMs);
    toolkit
      .fetch(url, { method: "POST", headers: headersOf(action, token), body: JSON.stringify(event), signal: controller.signal })
      .then(
        (response) => settle(response?.ok ? "sent" : "failed", `HTTP ${response?.status ?? "unknown"}`),
        // 运输方的原话可能带着整个地址，而地址可能是用户手写的、令牌就在查询串上：
        // 地址本身抹掉，名字像凭证的那些值也抹掉，剩下的还是要说出来 —— 一条没有理由
        // 的失败没法排查。
        (error) => settle("failed", maskSecrets(String(error?.message ?? error).replace(/https?:\/\/\S+/g, "<url>"))),
      );
  });
}

// 载重物是事件本身（Avenic 的那六件事加上量出来的时长），不是原生载荷：读的人要的是
// 「哪一轮完了」，不是这个 agent 这一版碰巧把什么放进了 JSON。
function eventJson(event, durationMs, now) {
  return {
    agent: event.agent,
    event: event.event,
    sessionId: event.sessionId,
    turnId: event.turnId,
    cwd: event.cwd,
    reason: event.reason,
    detail: event.detail,
    durationMs,
    at: new Date(now).toISOString(),
  };
}

async function runDesktop(action, id, event, durationMs, toolkit) {
  const command = desktopCommand(notificationText(event, durationMs), toolkit.platform);
  if (command === null) return { id, kind: "desktop", state: "skipped", detail: `no desktop notification on ${toolkit.platform}` };
  try {
    // 发出去就不管了：这一轮该等的是 agent，不是通知中心。detached + unref 让子进程
    // 活过这个钩子进程，而钩子进程立刻返回。
    const child = toolkit.spawn(command.command, command.args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    child.unref?.();
    return { id, kind: "desktop", state: "sent", detail: command.command };
  } catch (error) {
    return { id, kind: "desktop", state: "failed", detail: String(error?.message ?? error) };
  }
}

function runCommand(action, id, event, durationMs, toolkit, environment, now, remainingMs) {
  const timeoutMs = Math.min(timeoutOf(action), remainingMs);
  const args = Array.isArray(action.args) ? action.args.map(String) : [];
  return new Promise((resolve) => {
    let child;
    let timer;
    let settled = false;
    const settle = (state, detail) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ id, kind: "command", state, detail });
    };
    try {
      child = toolkit.spawn(action.command, args, { stdio: ["pipe", "ignore", "ignore"], env: commandEnvironment(environment), windowsHide: true });
    } catch (error) {
      settle("failed", String(error?.message ?? error));
      return;
    }
    child.on("error", (error) => settle("failed", String(error?.message ?? error)));
    // 程序可能在读完之前就退出（不读 stdin 的命令、一上线就崩的命令）：管道这头收到的
    // 是一个 EPIPE。流上一个没人监听的 'error' 在 Node 里是抛出去的异常 —— 它会把这一个
    // 进程连同后面还没跑的动作一起带走，而去重窗口已经认领过这件事了。
    child.stdin.on("error", (error) => settle("failed", String(error?.message ?? error)));
    child.on("close", (code) => settle(code === 0 ? "sent" : "failed", `exit ${code}`));
    timer = setTimeout(() => {
      settle("failed", `timed out after ${timeoutMs} ms`);
      try { child.kill(); } catch {}
    }, timeoutMs);
    try {
      child.stdin.write(JSON.stringify(eventJson(event, durationMs, now)));
      child.stdin.end();
    } catch (error) {
      settle("failed", String(error?.message ?? error));
    }
  });
}

async function runAction(action, event, durationMs, toolkit, environment, now, remainingMs) {
  const { id, kind } = action;
  if (kind === "desktop") return runDesktop(action, id, event, durationMs, toolkit);
  if (kind === "command") return runCommand(action, id, event, durationMs, toolkit, environment, now, remainingMs);
  const payload = eventJson(event, durationMs, now);
  if (kind === "webhook") {
    const url = typeof action.url === "string" ? action.url : "";
    // 凭据只走头：URL 会进日志、进 Referer、进别人的错误信息。
    if (url === "") return { id, kind, state: "failed", detail: "no url configured" };
    return post(action, id, kind, url, payload, tokenOf(action, environment), toolkit, remainingMs);
  }
  const gateway = typeof action.gateway === "string" && action.gateway !== "" ? action.gateway : OPENCLAW_GATEWAY;
  const route = typeof action.path === "string" && action.path !== "" ? action.path : OPENCLAW_PATH;
  const token = tokenOf(action, environment);
  // 没有专门的 hook token 就不发：一个不带的请求打到别人的网关上，只是把失败推给下一次。
  if (token === null) return { id, kind, state: "skipped", detail: "no hook token configured" };
  return post(action, id, kind, `${gateway.replace(/\/+$/, "")}${route.startsWith("/") ? route : `/${route}`}`, payload, token, toolkit, remainingMs);
}

/**
 * One native payload in, one dispatch out: the event Avenic understood, the
 * fingerprint it is known by, and one result per action that tried.
 *
 * `accepted` says Avenic recognized the payload; `skipped` says why nothing was
 * reported. They are separate answers because they lead to separate exits: a
 * payload nobody mapped and a notification the window collapsed both end in 0,
 * while a payload that could not be read at all is the caller's problem.
 */
export async function emitHook({ agentId, payload, projectRoot, environment = process.env, io = {} }) {
  const toolkit = {
    now: io.now ?? Date.now,
    platform: io.platform ?? process.platform,
    spawn: io.spawn ?? spawnProcess,
    fetch: io.fetch ?? globalThis.fetch,
  };
  const event = normalizeHook(agentId, payload);
  if (event === null) {
    return { accepted: false, event: null, fingerprint: null, skipped: "unknown-event", results: [] };
  }
  const fingerprint = hookFingerprint(event);
  const now = toolkit.now();
  const state = readState(projectRoot);

  if (event.event === "turn.started") {
    state.turns[turnKey(event)] = now;
    await saveState(projectRoot, state, now);
    return { accepted: true, event, fingerprint, skipped: null, results: [] };
  }
  if (!REPORTED_EVENTS.has(event.event)) {
    return { accepted: true, event, fingerprint, skipped: null, results: [] };
  }
  const durationMs = event.event === "turn.completed" ? measuredDuration(state, event, now) : null;
  if (durationMs !== null && durationMs < HOOK_POLICY.completedMinSeconds * 1000) {
    // 太短的一轮什么都没发出去，所以它不占窗口：同一个指纹后面真的够长了，还是要报。
    return { accepted: true, event, fingerprint, skipped: "too-short", results: [] };
  }
  // 两套钩子报同一件事是常态，「同一个指纹在窗口内只响一次」是这里的规矩 —— 而窗口要在
  // 动作之前就认领。动作是一整条链子（网络、子进程），等它回来再记账，两个钩子进程在这
  // 几百毫秒里各自读到「没记过」的状态，同一件事就响两次。先记账再动手，重复的那一个
  // 在第一步就被挡住；剩下的是读与写之间不到一毫秒的缝，窄到不值得再为它养一份锁文件。
  const seenAt = state.dedupe[fingerprint];
  if (typeof seenAt === "number" && now - seenAt < HOOK_POLICY.dedupeSeconds * 1000) {
    return { accepted: true, event, fingerprint, skipped: "deduped", results: [] };
  }
  state.dedupe[fingerprint] = now;
  await saveState(projectRoot, state, now);

  // 一条链子共用一个总预算：动作是一个接一个跑的，所以「每个动作各自有上限」加起来
  // 仍然可以是一条没有尽头的链子。花完之后的动作一次都不发 —— 但也不能从答案里消失，
  // 那一行就是「为什么你配了它却没收到」的答案本身。
  const deadline = now + HOOK_POLICY.dispatchBudgetSeconds * 1000;
  const results = [];
  for (const action of readHookActions(projectRoot, environment)) {
    const remainingMs = deadline - toolkit.now();
    if (remainingMs <= 0) {
      results.push({ id: action.id, kind: action.kind, state: "skipped", detail: "the dispatch budget was spent by the actions before it" });
      continue;
    }
    results.push(await runAction(action, event, durationMs, toolkit, environment, now, remainingMs));
  }
  return { accepted: true, event, fingerprint, skipped: null, results };
}
