// `avenic status` renders the core status model. It computes nothing about the
// project itself: the extension reads the same object and draws it as a tree,
// and `--json` prints it unchanged, so all three hosts answer the same
// question with the same answer.
import { LABELS, authenticationValue, collectStatus, methodLabel, scopedHomeValue, shortTimestamp, signInLabel } from "#core";
import { locateProjectRoot } from "#core/runtime/project-root.mjs";
import { collectLines, field, note, palette, section, table } from "./prompts.mjs";
import { compactBrand } from "./brand.mjs";

const SYNC_LABELS = {
  current: "current",
  running: "running",
  stale: "stale",
  missing: "missing",
  dirty: "dirty",
  none: "—",
};

const SYNC_REMEDIES = {
  stale: "run: avenic sessions continue <id> --agent <agent> to extend it",
  dirty: "a launch was interrupted — run: avenic sessions sync to finish it",
  running: "a launch is running in this project right now",
};

/**
 * `missing` 有两种：这个 agent 还没有任何副本（sync 就能导入 native 历史），以及
 * 映射指向的会话哪个存储里都没有了 —— 只有 continue 能从共享历史里重建它。而
 * continue 在 isolated 项目里会直接拒绝（它按定义要用共享历史），`missing` 却
 * 同样出现在那里。所以这条建议必须看着模式写：状态行给的是「下一步跑什么」，
 * 就不能把用户指向一个当场报错的命令。
 */
function missingRemedy(mode) {
  return mode === "shared"
    ? "run: avenic sessions continue <id> --agent <agent> to rebuild it, or avenic sessions sync"
    : "run: avenic sessions sync, or avenic change --history shared to rebuild it";
}

function scopeSummary(scope) {
  if (scope.state === "none") return "nothing installed";
  if (scope.state === "unreadable") return "installation record could not be read";
  const packs = scope.packs.length > 0 ? ` · ${scope.packs.map((pack) => pack.name).join(" + ")}` : "";
  return `${scope.installed} installed${packs} · ${scope.state}`;
}

function hubSummary(hub) {
  // 没有「未配置」这一态：spec 要么来自环境，要么是内置的默认值，总有一个。
  // 这台机器上到底有没有检出、检出的是不是锁文件钉的版本，由 cache 说。
  const revision = hub.revision ? hub.revision.slice(0, 7) : null;
  const detail = hub.cache === "missing"
    ? "not on this machine — run: avenic skills update"
    : hub.cache === "stale"
      ? `cache is ${revision ?? "unknown"}, installed from ${hub.pinned?.slice(0, 7) ?? "unknown"} — run: avenic skills update`
      : revision ?? "unknown";
  return `${hub.name} · ${hub.cache} · ${detail}`;
}

// Authentication and Sessions are two answers, so they are two columns: the
// answer with the scope it owns, and where this agent's sessions live. The
// facts a scope alone cannot give — the configuration file, the account scope,
// whether the sign-in has happened — belong to the lines below, not here.
function agentRow(agent) {
  const auth = agent.auth;
  return [
    agent.displayName,
    agent.available ? "found" : "not found",
    // 没有方法不等于没有初始化：一个项目可以只回答了「会话存哪儿」，把认证留到
    // 启动时再问（合法状态）。那一格该说的是「Not chosen」，不是「未初始化」。
    // 自管认证的 agent 那一格说的是面板上那句话：`native` 是内部的值，这一页
    // 是给人看的，同一个概念在四个宿主上必须是同一个词。
    auth ? authenticationValue({ authMethod: auth.method, authScope: auth.scope })
      : (agent.runtime ? methodLabel(agent.runtime) : (agent.initialized ? LABELS.notChosen : LABELS.notConfigured)),
    agent.initialized ? agent.sessions : "—",
    String(agent.history.sessions),
    SYNC_LABELS[agent.history.sync] ?? agent.history.sync,
  ];
}

// What the answer means on disk, said once per agent. An Account points at the
// scope and home the agent signs into itself; an API configuration names the
// file the launch reads and what that file selects — and says so as missing,
// with its remedy, rather than as an error, because a project whose
// configuration is not written yet still launches.
function authNotes(agent, at) {
  const auth = agent.auth;
  if (!auth) return [];
  const name = agent.displayName;
  if (auth.method === "api") {
    const configuration = auth.configuration ?? {};
    const file = configuration.relative ?? "—";
    // 「文件不在」「文件在但读不出来」「文件在、还没写」是三种处境：补救相同
    // （avenic change），事实不同，就说哪一种。整行必须活在 80 列以内，而补救
    // 排在事实后面 —— 所以事实要短到能把补救留在可见的那一段里：被截掉的补救
    // 命令等于没有。
    // 1.8.4 之前那份配置换了住处：新文件还没配好的时候要说它在哪儿，因为旧值只
    // 在那一份里，而升级不该看起来像 provider 自己失效了。
    const older = auth.legacy ? [[`${name}: ${auth.legacy.relative} still holds the earlier configuration`, { ...at, mark: "!" }]] : [];
    if (!configuration.exists) return [[`${name}: ${file} is missing — run: avenic change`, { ...at, mark: "!" }], ...older];
    if (!configuration.valid) return [[`${name}: ${file} cannot be read — run: avenic change`, { ...at, mark: "!" }], ...older];
    if (!configuration.configured) return [[`${name}: fill in ${file} — nothing in it yet`, { ...at, mark: "!" }], ...older];
    // 配置好了就只说文件里在的那两件事：这一页给的是面板同一批字段，而面板没有
    // Credential 这一行 —— 凭据从用户自己的环境来，不是这个文件的事。
    const provider = configuration.provider ? `, ${LABELS.provider} ${configuration.provider}` : "";
    const model = configuration.model ? `, ${LABELS.model} ${configuration.model}` : "";
    return [[`${name}: ${file}${provider}${model}`, at]];
  }
  const notes = [];
  // 作用域和承载它的家目录一起写：只写目录，读的人还得回头找它属于谁。
  if (auth.home !== null && auth.home !== undefined) notes.push([`${name}: ${LABELS.accountScope} ${scopedHomeValue(auth.scope, auth.home)}`, at]);
  if (auth.status === "signed-in") {
    // The positive answer is the one a reader most often wants, and it is the
    // only one the page can give without a remedy attached.
    notes.push([`${name}: ${LABELS.accountStatus} ${signInLabel(auth.status)}`, at]);
  } else if (auth.status === "not-signed-in") {
    notes.push([`${name}: ${LABELS.accountStatus} ${signInLabel(auth.status)} — run: avenic ${agent.id} to sign in`, { ...at, mark: "!" }]);
  } else if (auth.status === "unknown") {
    // Naming the uncertainty is the honest answer: this platform can hold the
    // credential somewhere no file read can see, and a probe is not a status.
    notes.push([`${name}: ${LABELS.accountStatus} ${signInLabel(auth.status)} — this platform may keep it outside ${auth.home ?? "the agent's own home"}`, at]);
  }
  // 文件在、却没生效：项目跑在账号上，而 API 那一份配置就摆在旁边。
  if (auth.detected) {
    notes.push([`${name}: ${LABELS.detectedButInactive} — ${auth.detected.relative} is present, and this project runs on an Account`, { ...at, mark: "!" }]);
  }
  return notes;
}

/**
 * `avenic status`, drawn: ◆ heading, one ◇ block per question, │ for what is
 * inside it, ! for what needs an action. The same blocks and the same wording
 * the editor's dashboard uses, because both read the one status object.
 */
export function renderStatus(status, io = console, options = {}) {
  const { project, history, agents, skills } = status;
  // One environment decides both: the colour depth and what the page reports.
  const colors = options.colors ?? palette(options.stdout ?? process.stdout, options.environment ?? process.env);
  // 这一页由多个「写一行」的助手拼成；收集它们，最后一次性交给 io.log。
  const { sink, line: blank, flush } = collectLines({ ...io, columns: (options.stdout ?? process.stdout).columns });
  const at = { colors };

  compactBrand(sink, { ...at, title: "Status", description: project.root });
  blank();
  section(sink, "Project", at);
  field(sink, "Name", project.name, at);
  field(sink, "Agents", project.agents.length > 0 ? project.agents.join(", ") : "none configured", at);
  blank();
  section(sink, "History", at);
  field(sink, "Mode", history.mode, at);
  field(sink, "Sessions", String(history.sessions), at);
  if (history.active) {
    field(sink, "Active", `${history.active}${history.activeTitle ? `  ${history.activeTitle}` : ""}`, at);
    field(sink, "Events", String(history.activeEvents ?? "unknown"), at);
  } else {
    field(sink, "Active", history.mode === "shared" ? "none — run: avenic sessions list" : "— (isolated history)", at);
  }
  field(sink, "Updated", shortTimestamp(history.updatedAt) ?? "—", at);
  blank();
  section(sink, "Agents", at);
  table(sink, ["Agent", "CLI", "Auth", "Sessions", "History", "Sync"], agents.map(agentRow), { colors });
  for (const agent of agents) {
    const remedy = agent.history.sync === "missing"
      ? missingRemedy(history.mode)
      : SYNC_REMEDIES[agent.history.sync];
    if (remedy) note(sink, `${agent.displayName}: ${SYNC_LABELS[agent.history.sync]} — ${remedy}`, { ...at, mark: "!" });
    else if (!agent.available) note(sink, `${agent.displayName}: the ${agent.command} CLI is not on PATH — Avenic still manages its history`, at);
    else if (!agent.initialized) note(sink, `${agent.displayName}: run: avenic ${agent.id} init`, at);
    // 路径放在行首：行尾会被终端宽度截掉，而「配置/账号在哪」正是这行必须活下来的部分。
    for (const [line, style] of authNotes(agent, at)) note(sink, line, style);
  }
  blank();
  section(sink, "Skills", at);
  field(sink, "Project", scopeSummary(skills.project), at);
  field(sink, "Global", scopeSummary(skills.global), at);
  field(sink, "Hub", hubSummary(skills.hub), at);
  flush();
  return 0;
}

export async function dispatchStatusCommand(argumentsList = [], options = {}) {
  const io = options.io ?? console;
  const [flag, ...rest] = argumentsList;
  const asJson = flag === "--json";
  if ((flag !== undefined && !asJson) || rest.length > 0) {
    throw new Error("Usage: avenic status [--json]");
  }
  const projectRoot = options.projectRoot ?? locateProjectRoot();
  const status = await collectStatus(projectRoot, { environment: options.environment ?? process.env });
  if (asJson) {
    io.log(JSON.stringify(status, null, 2));
    return 0;
  }
  return renderStatus(status, io, options);
}
