// `avenic status` renders the core status model. It computes nothing about the
// project itself: the extension reads the same object and draws it as a tree,
// and `--json` prints it unchanged, so all three hosts answer the same
// question with the same answer.
import { LABELS, agentCardRows, collectStatus, historyLabel, shortTimestamp, signInLabel } from "#core";
import { locateProjectRoot } from "#core/runtime/project-root.mjs";
import { collectLines, field, note, palette, section, table } from "./prompts.mjs";
import { compactBrand } from "./brand.mjs";

// 同步状态自己就是它的词（current / running / stale / dirty / missing）；只有
// 「这个 agent 还没有可同步的东西」那一态要换个符号，而它不是一句话。
const syncLabel = (sync) => (sync === "none" ? "—" : sync);

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

// The table's five answers are the card's own rows, cell for cell: the
// authentication method with the scope it owns, where this agent's sessions
// live, and the project's history mode. A host may lay the rows out
// differently — a column here, a line there — but it may not answer
// differently, so none of these words is spelled out a second time here.
function agentRow(agent, historyMode) {
  const rows = agentCardRows(agent, historyMode);
  const valueOf = (key) => rows.find((row) => row.key === key)?.value ?? "—";
  return [
    agent.displayName,
    agent.available ? "found" : "not found",
    valueOf("authentication"),
    valueOf("sessions"),
    valueOf("history"),
    syncLabel(agent.history.sync),
  ];
}

// The rows the page has room for under the table. The table itself already
// answers Authentication, Sessions and History, and the rest of the card's
// model-role rows (Opus / Sonnet / Haiku Model, Reasoning Effort) belong to the
// card and to `avenic <agent> status` — this page names what a reader needs to
// recognize their configuration, not everything the file holds.
const FACT_KEYS = new Set(["configSource", "provider", "model", "subAgentModel", "effort", "accountStatus", "accountScope"]);

// The sentences `avenic status` and `avenic <agent> status` both print, one per
// fact, each with its remedy on the same line — a remedy beyond column 80 is not
// advice. The pages differ in what surrounds them (a column here, the whole card
// there) and in whether the agent's name is prefixed; they do not differ in what
// the file's state is called, because a user reading one command and then the
// other must not be told two things about one file.

/**
 * 「文件不在」「读不出来」「在但还没写」：三种处境各一句话。前两种给出下一步，
 * 第三种只说「把它填上」—— 因为在 80 列的终端里，补救和它救的那件事必须同时
 * 活得下来，而这一句没有别的补救要说。路径在两句话里都在前半段。
 */
export function configurationStateNote(auth) {
  const configuration = auth?.configuration ?? {};
  if (auth?.method !== "api" || configuration.configured) return null;
  const file = configuration.relative ?? "—";
  const text = !configuration.exists ? `${file} is missing — run: avenic change`
    : !configuration.valid ? `${file} cannot be read — run: avenic change`
      : `fill in ${file} — nothing in it yet`;
  return { text, mark: "!" };
}

/**
 * 签没签进来：只在它还能多说一句的时候存在（补救，或者这个平台上根本读不到）。
 * 签好了就什么都没多说 ——— 卡片行自己写着 Signed in。
 */
export function accountStatusNote(agent, auth) {
  if (auth?.method !== "account") return null;
  const value = `${LABELS.accountStatus} ${signInLabel(auth.status)}`;
  if (auth.status === "not-signed-in") return { text: `${value} — run: avenic ${agent.id} to sign in`, mark: "!" };
  // Naming the uncertainty is the honest answer: this platform can hold the
  // credential somewhere no file read can see, and a probe is not a status.
  if (auth.status === "unknown") return { text: `${value} — this platform may keep it outside ${auth.home ?? "the agent's own home"}`, mark: "·" };
  return null;
}

/** 1.8.4 之前那份配置换了住处：升级之后旧值只在那一份里，所以它得被说出来。 */
export function legacyNote(auth) {
  return auth?.legacy ? { text: `${auth.legacy.relative} still holds the earlier configuration`, mark: "!" } : null;
}

/** 文件在、却没生效：项目跑在账号上，而 API 那一份配置就摆在旁边。 */
export function detectedNote(auth) {
  return auth?.detected ? { text: `${LABELS.detectedButInactive} — ${auth.detected.relative} is present, and this project runs on an Account`, mark: "!" } : null;
}

// What the answer means on disk, said once per agent: the card's rows, one fact
// per line, because a fact the terminal cuts in half is a fact nobody read.
function authNotes(agent, historyMode, at) {
  const auth = agent.auth;
  if (!auth) return [];
  const name = agent.displayName;
  const line = (note) => [`${name}: ${note.text}`, { ...at, mark: note.mark }];
  const legacy = legacyNote(auth);
  const broken = configurationStateNote(auth);
  // 还没铺开的文件：这一页说得出的事实只有「哪一份、它怎么了」——provider、
  // model、effort 那些行此刻一行都没有，也不该有。
  if (broken) return [line(broken), ...(legacy ? [line(legacy)] : [])];
  const facts = agentCardRows(agent, historyMode)
    .filter((row) => FACT_KEYS.has(row.key))
    .map((row) => {
      // 账号那一行唯一会变的是签没签进来，而补救跟着它：另起一行说会把补救和它
      // 救的那件事分开。
      const status = row.key === "accountStatus" ? accountStatusNote(agent, auth) : null;
      return status ? line(status) : [`${name}: ${row.label} ${row.value}`, at];
    });
  const inactive = detectedNote(auth);
  return [...facts, ...(legacy ? [line(legacy)] : []), ...(inactive ? [line(inactive)] : [])];
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
  field(sink, "Mode", historyLabel(history.mode), at);
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
  table(sink, ["Agent", "CLI", LABELS.authentication, LABELS.sessions, LABELS.history, "Sync"], agents.map((agent) => agentRow(agent, history.mode)), { colors });
  for (const agent of agents) {
    const remedy = agent.history.sync === "missing"
      ? missingRemedy(history.mode)
      : SYNC_REMEDIES[agent.history.sync];
    if (remedy) note(sink, `${agent.displayName}: ${syncLabel(agent.history.sync)} — ${remedy}`, { ...at, mark: "!" });
    else if (!agent.available) note(sink, `${agent.displayName}: the ${agent.command} CLI is not on PATH — Avenic still manages its history`, at);
    else if (!agent.initialized) note(sink, `${agent.displayName}: run: avenic ${agent.id} init`, at);
    // 路径放在行首：行尾会被终端宽度截掉，而「配置/账号在哪」正是这行必须活下来的部分。
    for (const [line, style] of authNotes(agent, history.mode, at)) note(sink, line, style);
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
