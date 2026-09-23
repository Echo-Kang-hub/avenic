// Turning the user's "tell me when the agent needs me" into each agent's own
// configuration.
//
// `runtime/hooks.mjs` says what each agent can report; this file puts Avenic on
// the other end of it, in the file that agent reads. Three mechanisms, three
// kinds of file, and one rule that holds for all of them: **the file is not
// Avenic's**. A user's settings carry their permissions, their own hooks, their
// comments and their whole history; a write here adds one identifiable block
// and returns everything else exactly as it was, and the uninstall returns the
// file to the bytes it had before.
//
//   Claude   the project's own settings file (`.claude/settings.local.json`) or
//            the agent home's `settings.json`. JSON, so it is parsed and
//            re-serialised by the one JSON writer the product has; the entries
//            Avenic owns are recognised by their command, never by position.
//
//   Codex    `config.toml` in the agent's home — the project's own home for
//            project scope, because Codex has no project configuration file at
//            all. TOML with the user's comments in it, so it is edited line by
//            line and only between Avenic's own two markers.
//
//   OpenCode a plugin file Avenic writes whole and owns outright: it is the one
//            mechanism where the file itself is the entry, so it carries a
//            version and an ownership marker, and a file without the marker is
//            never touched — by an install or by a removal.
//
// Nothing here decides what a notification is. Installing the hooks only makes
// the events arrive; `hook-actions.mjs` decides what, if anything, happens next.

import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { accountHome } from "./agent-home.mjs";
import { writeFileAtomic } from "./atomic-file.mjs";
import { environmentHome } from "./environment.mjs";
import { hookCapability, hookSupport } from "./hooks.mjs";
import { parseJsonObject } from "./model-write.mjs";
import { agentHomeRoot } from "./project-paths.mjs";

/** The file OpenCode loads, and the marker that says the file is Avenic's. */
export const OPENCODE_PLUGIN_FILE = "avenic-hooks.js";
const OWNED_MARKER = "avenic:hooks";
const CODEX_BEGIN = `# ${OWNED_MARKER} begin — installed by Avenic; \`avenic hook uninstall --agent codex\` removes this block`;
const CODEX_END = `# ${OWNED_MARKER} end`;

/**
 * The command every mechanism runs, and the only thing that identifies an entry
 * as Avenic's.
 *
 * Recognising our own work by its command rather than by a key of our own is
 * deliberate: it is the one part of the entry the agent itself has to
 * understand, so it cannot be lost to a schema that rejects unknown keys, and a
 * user who moved the entry, reformatted the file or reordered the array still
 * has exactly one entry of ours to replace.
 */
const commandFor = (agentId) => `avenic hook emit --agent ${agentId}`;
const OURS = /(?:^|[\\/ ])avenic(?:\.cmd|\.exe)?\s+hook\s+emit\b/;
const isOurs = (command) => typeof command === "string" && OURS.test(command);

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** Where one scope's hooks live, per agent. The one table, so nothing else guesses. */
function targetFile(agentId, scope, projectRoot, environment) {
  if (scope === "project") {
    if (agentId === "claude") return path.join(projectRoot, ".claude", "settings.local.json");
    if (agentId === "codex") return path.join(agentHomeRoot(projectRoot, "codex"), "config.toml");
    return path.join(projectRoot, ".opencode", "plugins", OPENCODE_PLUGIN_FILE);
  }
  if (agentId === "claude") return path.join(accountHome(projectRoot, "claude", "global", environment), "settings.json");
  if (agentId === "codex") return path.join(accountHome(projectRoot, "codex", "global", environment), "config.toml");
  const root = environment.XDG_CONFIG_HOME || path.join(environmentHome(environment), ".config");
  return path.join(root, "opencode", "plugins", OPENCODE_PLUGIN_FILE);
}

async function readText(file) {
  try {
    return await readFile(file, "utf8");
  } catch {
    return "";
  }
}

/** The events this agent can actually report, in the matrix's own order. */
function reportable(capability) {
  return Object.values(capability.events).filter((entry) => entry.native !== null);
}

// ---- Claude: the settings file, merged ---------------------------------------

function claudeGroup(agentId, entry) {
  // 一个机制只认一部分类型（Notification 是四种含义共用的事件名），那就把范围写在
  // matcher 上 —— 让 agent 自己筛，比 Avenic 收下全部再猜要准。
  return {
    ...(entry.reasons === undefined ? {} : { matcher: entry.reasons.join("|") }),
    hooks: [{ type: "command", command: commandFor(agentId) }],
  };
}

function claudeEdit(agentId, capability, before, { remove }) {
  const parsed = parseJsonObject(before);
  const merged = structuredClone(parsed);
  const hooks = isObject(merged.hooks) ? merged.hooks : {};
  for (const entry of reportable(capability)) {
    const groups = Array.isArray(hooks[entry.native]) ? hooks[entry.native] : [];
    // 一个组里可能既有 Avenic 的处理器又有用户自己的：只摘我们那一个，组里剩下的
    // 原样留下，空掉的组才消失。
    const kept = groups
      .map((group) => ({ ...group, hooks: (Array.isArray(group.hooks) ? group.hooks : []).filter((handler) => !isOurs(handler?.command)) }))
      .filter((group) => group.hooks.length > 0);
    if (remove) {
      if (kept.length === 0) delete hooks[entry.native];
      else hooks[entry.native] = kept;
    } else {
      hooks[entry.native] = [...kept, claudeGroup(agentId, entry)];
    }
  }
  if (Object.keys(hooks).length === 0) delete merged.hooks;
  else merged.hooks = hooks;
  const changed = JSON.stringify(merged) !== JSON.stringify(parsed);
  // 没改就一个字节都不动：用户把文件排成什么样是用户的事，一次「什么也没做」的安装
  // 不该顺手把它重排一遍。
  return { text: changed ? `${JSON.stringify(merged, null, 2)}\n` : before, changed, emptied: Object.keys(merged).length === 0 };
}

// ---- Codex: one marked block in a file full of the user's own -----------------

function codexBlock(agentId, capability) {
  // Codex 的 serde 里，事件表下挂的是 MatcherGroup（恰好 matcher / hooks 两个字段），
  // 处理器是内部打标签的枚举：`command` 必须待在自己那张嵌套表里，还带着 `type` 标签。
  // 直接写在事件表下面，读到的就是一个不认识的字段 —— 装上了永远不会响。
  const lines = [CODEX_BEGIN];
  for (const entry of reportable(capability)) {
    lines.push(
      `[[hooks.${entry.native}]]`,
      `  [[hooks.${entry.native}.hooks]]`,
      `  type = "command"`,
      `  command = "${commandFor(agentId)}"`,
      "",
    );
  }
  lines.push(CODEX_END, "");
  return lines.join("\n");
}

/**
 * The file with Avenic's block taken out, and whether there was one.
 *
 * `null` is a block that starts and never ends — a file someone edited by hand
 * into a state this code cannot interpret. Rewriting around a half-written
 * block is how the user's own tables after it would be lost, so the caller
 * refuses instead.
 */
function stripCodex(before) {
  const begin = before.indexOf(CODEX_BEGIN);
  if (begin === -1) return { text: before, found: false };
  const endMark = before.indexOf(CODEX_END, begin);
  if (endMark === -1) return null;
  const end = endMark + CODEX_END.length + (before[endMark + CODEX_END.length] === "\n" ? 1 : 0);
  let head = before.slice(0, begin);
  // 块在文件末尾时，它前面多出来的那个空行也是 Avenic 加的，跟着一起走 —— 卸载之后
  // 文件要回到原来的字节，差一个换行就不是了。
  if (end === before.length) head = head.replace(/\n$/, "");
  return { text: head + before.slice(end), found: true };
}

function codexEdit(agentId, capability, before, { remove }) {
  const stripped = stripCodex(before);
  if (stripped === null) throw new Error(`${CODEX_BEGIN} has no matching end marker — Avenic will not rewrite a file it cannot read`);
  if (remove) return { text: stripped.found ? stripped.text : before, changed: stripped.found, emptied: stripped.text.trim() === "" };
  const block = codexBlock(agentId, capability);
  const base = stripped.text;
  const text = base === "" ? block : `${base}\n${block}`;
  return { text, changed: text !== before, emptied: false };
}

// ---- OpenCode: a file Avenic owns ---------------------------------------------

/**
 * The plugin, whole. It does one thing: every event the session reports goes to
 * `avenic hook emit` flattened to the shape the capability matrix reads — the
 * native envelope keeps the session id inside `properties`, and the working
 * directory is the plugin's own input rather than a field of the event. Nothing
 * waits for the child: a notification is never a reason for the agent's own
 * turn to feel slower.
 *
 * The command runs through the shell because `avenic` is a shim on Windows
 * (`avenic.cmd`), and Node cannot execute a shim directly — a plugin that threw
 * ENOENT on every event would look exactly like an agent that never reports
 * anything. The event itself goes on stdin and is never interpolated into the
 * command line.
 */
export function opencodePlugin(agentId) {
  return [
    `// ${OWNED_MARKER} v1 — this file belongs to Avenic and is rewritten as a whole.`,
    `// Remove it with \`avenic hook uninstall --agent ${agentId}\`.`,
    'import { spawn } from "node:child_process";',
    "",
    "function report(event) {",
    `  const child = spawn("avenic hook emit --agent ${agentId}", { shell: true, stdio: ["pipe", "ignore", "ignore"], detached: true, windowsHide: true });`,
    "  child.on(\"error\", () => {});",
    "  child.stdin.end(JSON.stringify(event));",
    "  child.unref();",
    "}",
    "",
    "export const AvenicHooks = async ({ directory }) => ({",
    "  event: async ({ event }) => { report({ directory, ...event.properties, type: event.type }); },",
    "});",
    "",
  ].join("\n");
}

// ---- The plan every host reads -------------------------------------------------

/**
 * What installing (or removing) this agent's hooks in this scope would do:
 * which file, whether the agent can carry them at all, what has to be said
 * about it, and the exact text that would be written.
 *
 * Read-only. The CLI and the dashboard both show this to the user before
 * anything is written (and `configurationDiff` turns `before`/`contents` into
 * the preview), which is why the plan carries the bytes rather than a promise
 * that they are right.
 */
export async function hookPlan(agentId, { scope, projectRoot, environment = process.env, version = null } = {}) {
  const capability = hookCapability(agentId);
  if (capability === null) throw new Error(`Unknown agent: ${agentId}`);
  if (scope !== "project" && scope !== "global") throw new Error(`Unknown hook scope: ${scope}`);
  const file = targetFile(agentId, scope, projectRoot, environment);
  const support = hookSupport(agentId, version);
  const before = await readText(file);
  const edit = editFor(agentId, before, { remove: false });
  const installed = agentId === "opencode" ? before.includes(OWNED_MARKER) : agentId === "claude" ? claudeInstalled(before) : codexInstalled(before);
  return {
    agent: agentId,
    displayName: capability.displayName,
    scope,
    mechanism: capability.mechanism,
    file,
    version,
    supported: support.supported,
    note: support.note,
    caveat: caveatFor(agentId, capability),
    installed,
    before,
    contents: edit.text,
  };
}

/** Whether any event array in a Claude settings file holds an entry of Avenic's. */
function claudeInstalled(before) {
  let parsed;
  try {
    parsed = parseJsonObject(before);
  } catch {
    // 读不懂的文件不能算「装过了」：安装本来就会拒绝它，这里说「没装」才是同一件事。
    return false;
  }
  const hooks = isObject(parsed.hooks) ? parsed.hooks : {};
  return Object.values(hooks).some((groups) =>
    Array.isArray(groups) && groups.some((group) => (Array.isArray(group?.hooks) ? group.hooks : []).some((handler) => isOurs(handler?.command))));
}

const codexInstalled = (before) => before.includes(CODEX_BEGIN);

/**
 * The sentence a screen shows next to the install button, when the mechanism
 * has a condition the user cannot see from here. Codex is the one that does: a
 * written hook stays untrusted until the user reviews it, and a project's hooks
 * do not load at all until the project is trusted, so "installed" would be a
 * claim the product cannot keep.
 */
export function caveatFor(agentId, capability) {
  if (agentId !== "codex") return "";
  return `Codex keeps a newly written hook untrusted until you review it (run /hooks in Codex${capability.events["turn.completed"].reliability === "conditional" ? "; project hooks also need the project to be trusted" : ""}) — until then the hook is installed but silent.`;
}

/**
 * Whether this scope currently has Avenic's hooks, without building a plan for
 * a write — the question a dashboard asks on every refresh.
 */
export async function hookStatus(agentId, options = {}) {
  const plan = await hookPlan(agentId, options);
  return { agent: plan.agent, scope: plan.scope, file: plan.file, installed: plan.installed, supported: plan.supported, note: plan.note, caveat: plan.caveat };
}

/** The one edit for one agent: which mechanism this file is, and what it becomes. */
function editFor(agentId, before, { remove }) {
  const capability = hookCapability(agentId);
  if (agentId === "claude") return claudeEdit(agentId, capability, before, { remove });
  if (agentId === "codex") return codexEdit(agentId, capability, before, { remove });
  return { text: opencodePlugin(agentId), changed: before !== opencodePlugin(agentId) };
}

async function write(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFileAtomic(file, text);
}

/**
 * Installing twice writes once, and never writes for an agent that cannot carry
 * the hooks.
 *
 * 真正动手之前重读一次文件：计划是一张快照，而用户可能刚在编辑器里改过它 ——
 * 我们要改的是文件现在的样子，不是我们刚才看到的样子。
 */
export async function installHooks(plan) {
  if (!plan.supported) return { changed: false, file: plan.file, skipped: plan.note };
  const edit = editFor(plan.agent, await readText(plan.file), { remove: false });
  if (!edit.changed) return { changed: false, file: plan.file };
  await write(plan.file, edit.text);
  return { changed: true, file: plan.file };
}

/**
 * Removing Avenic's hooks — and only Avenic's.
 *
 * A file that carries no marker is somebody else's file: the OpenCode plugin
 * refuses to be deleted, and the two merged formats simply have nothing to take
 * out. Neither ever truncates or rewrites a file it did not put something into.
 */
export async function uninstallHooks(plan) {
  const before = await readText(plan.file);
  if (plan.agent === "opencode") {
    if (!before.includes(OWNED_MARKER)) return { changed: false, file: plan.file };
    await rm(plan.file, { force: true });
    return { changed: true, file: plan.file };
  }
  const edit = editFor(plan.agent, before, { remove: true });
  if (!edit.changed) return { changed: false, file: plan.file };
  // 文件里剩下的东西一件不是用户的（它本来就只装过 Avenic 那些条目）：那就连文件一起
  // 收走，别留一个空壳让下一个人以为这里配置过什么。
  if (edit.emptied) {
    await rm(plan.file, { force: true });
    return { changed: true, file: plan.file };
  }
  await write(plan.file, edit.text);
  return { changed: true, file: plan.file };
}
