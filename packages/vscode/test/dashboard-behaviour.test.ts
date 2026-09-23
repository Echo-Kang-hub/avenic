import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { allText, fire, lastPosted, renderDataMessage, type Rendered, type StubDocument, type StubNode } from "./fixtures/dom-stub.ts";

// 面板的行为层：把真实的 media/dashboard/main.js 放进一个够用的 DOM 里跑，再点它的
// 按钮。源码文本断言看不出「点了没反应」——而那正是本层存在的理由：一个真的会翻页
// 的链接和一具只会发消息的链接，字面上长得一模一样。
//
// fixture 是虚构的（test/visual/fixtures 的那一份，视觉套件照同一张图），这里改的只是
// 「现在是哪种状态」，不改文案。

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const media = path.join(pkgDir, "media", "dashboard");

interface Page {
  source: string;
  /** 模板里真的写着的那几个分区：页面自己也只按它建侧栏。 */
  sections: string[];
}

async function page(): Promise<Page> {
  const html = await readFile(path.join(media, "view.html"), "utf8");
  return {
    source: await readFile(path.join(media, "main.js"), "utf8"),
    sections: [...html.matchAll(/data-section="([a-z]+)"/g)].map((match) => match[1]),
  };
}

type Payload = Record<string, any>;

async function payload(patch: Payload = {}): Promise<Payload> {
  const base = JSON.parse(await readFile(path.join(pkgDir, "test", "visual", "fixtures", "a-reference.json"), "utf8"));
  return { ...base, ...patch };
}

// 页面外壳（侧栏的分区按钮）写在模板里，桩不解析模板：需要外壳的用例自己铺进去，
// 而且铺的就是模板里那几个名字。
function sidebar(sections: string[]): (document: StubDocument) => void {
  return (document) => {
    const nav = document.getElementById("nav");
    for (const section of sections) {
      const item = document.createElement("button");
      item.className = "nav-item";
      item.setAttribute("data-section", section);
      nav.append(item);
    }
  };
}

/** 按文案找一个按钮：面板的按钮都没有 id，能定位它们的只有它们说的话。 */
function findButton(rendered: Rendered, label: string): StubNode | undefined {
  return rendered.created.find((node) => node.tagName === "BUTTON" && node.textContent === label);
}

function button(rendered: Rendered, label: string): StubNode {
  const found = findButton(rendered, label);
  assert.ok(found, `面板上应当有一个「${label}」按钮`);
  return found;
}

/** 现在高亮着的分区：点完之后页面停在哪一页，看这个。 */
function activeSections(rendered: Rendered): string[] {
  return (rendered.byId.get("nav")?.querySelectorAll(".nav-item[data-section]") ?? [])
    .filter((item) => item.classList.contains("active"))
    .map((item) => item.getAttribute("data-section") ?? "");
}

/** 一个字段行的值：先按标签找到行，再从值里找要找的东西。 */
function fieldValue(rendered: Rendered, label: string): StubNode | undefined {
  const row = rendered.content.querySelectorAll(".field-row").find((candidate) =>
    candidate.children.some((cell) => cell.className === "field-label" && cell.children.some((span) => span.textContent === label)));
  return row?.children.find((cell) => cell.className === "field-value");
}

// 打开的这份对话：形状就是宿主送来的那一份（core 的 TranscriptModel 加上这一页
// 头部要的四格）。speaker 是 core 定下的称呼，role 是存在盘上的那个词——页面上
// 只准出现前者。
const TRANSCRIPT = {
  id: "s-fix-auth-env",
  title: "Fix authentication environment handling",
  active: false,
  participants: ["Claude", "Codex"],
  updated: "2025-09-20T20:30:00Z",
  updatedRelative: "2 hours ago",
  eventCount: 2,
  sync: { state: "current", label: "Synced" },
  diagnostics: { warnings: [], notes: [] },
  turns: [
    { id: "e1", kind: "user", speaker: "You", agent: null, role: "user", at: "2025-09-20T20:20:00Z", text: "Why does the token expire early?", tools: [], model: null },
    { id: "e2", kind: "agent", speaker: "Claude", agent: "claude", role: "assistant", at: "2025-09-20T20:21:00Z", text: "Because the environment is read once.", tools: [{ kind: "call", name: "Read", detail: "src/auth/env.ts" }], model: "claude-sonnet-4" },
  ],
};

test("a View All link turns the page itself, and tells the host where it went", async () => {
  const { source, sections } = await page();
  const rendered = renderDataMessage(await payload({ transcript: TRANSCRIPT }), source, { seed: sidebar(sections) });
  assert.deepEqual(activeSections(rendered), ["overview"], "初帧停在概览");

  fire(button(rendered, "View All Shared Sessions (12)"));
  assert.deepEqual(activeSections(rendered), ["sessions"], "链接自己就该翻到那一页，而不是只发一条消息");
  assert.equal(rendered.content.querySelectorAll(".transcript").length, 1, "翻过去之后看到的是那一页的内容");
  // 落点连「哪一页的哪一半」一起说：Sessions 页有两个标签，只说分区的话宿主记不住
  // 用户是从共享那一列进来的。
  assert.deepEqual(lastPosted(rendered, "navigate"), { type: "navigate", section: "sessions", tab: "shared" }, "同时把落点告诉宿主，下一次推送才不会把页面拽回去");
});

test("the shell says it in English first, and in Chinese too only where the editor is Chinese", async () => {
  const { source, sections } = await page();
  // 模板里的静态标签：英文写在标记里，键挂在 data-text 上，脚本按同一张表补另一半。
  const seed = (document: StubDocument): void => {
    sidebar(sections)(document);
    const label = document.createElement("span");
    label.className = "label";
    label.setAttribute("data-text", "nav.sessions");
    label.textContent = "Sessions";
    document.getElementById("nav").append(label);
  };
  const english = renderDataMessage(await payload(), source, { seed });
  const spanEn = english.byId.get("nav")?.querySelectorAll("[data-text]")[0];
  assert.equal(spanEn?.textContent, "Sessions", "英文是主标签，哪一种界面都不换");
  assert.equal(spanEn?.getAttribute("title"), "Sessions / 会话", "非中文界面里中文在 tooltip 与无障碍名里等着");
  assert.equal(spanEn?.querySelectorAll(".zh").length, 0, "非中文界面不把第二半挤进这一行");

  const chinese = renderDataMessage(await payload(), source, { seed, chinese: true });
  const spanZh = chinese.byId.get("nav")?.querySelectorAll("[data-text]")[0];
  assert.equal(spanZh?.textContent, "Sessions会话", "中文界面里两半都在，英文仍然在前");
  assert.equal(spanZh?.querySelectorAll(".zh")[0]?.textContent, "会话");
});

test("skipping to a section from the sidebar tells the host the same thing", async () => {
  const { source, sections } = await page();
  const rendered = renderDataMessage(await payload(), source, { seed: sidebar(sections) });

  // 按分区名找，不按序号：侧栏多一页（中心）就把后面每一格都推到下一个位置，而这一条
  // 问的是「点这一页会不会告诉宿主」。
  const skills = rendered.byId.get("nav")?.querySelectorAll(".nav-item[data-section]")
    .find((item) => item.getAttribute("data-section") === "skills");
  assert.ok(skills);
  fire(skills);
  assert.deepEqual(activeSections(rendered), ["skills"]);
  // 宿主记着这个落点：面板被再次唤起时落在同一页，靠的就是这条消息。
  assert.deepEqual(lastPosted(rendered, "navigate"), { type: "navigate", section: "skills" });
});

test("a status the host calls muted does not paint the green dot", async () => {
  const { source, sections } = await page();
  const base = await payload();
  const agents = base.agents.map((agent: Payload, index: number) => index === 0
    ? {
        ...agent,
        fields: [
          { label: "Authentication", kind: "badge", value: "Account (Global)", tone: "blue", icon: "account" },
          { label: "Account Status", kind: "status", value: "Not signed in", tone: "muted", icon: "account" },
        ],
      }
    : agent);
  const rendered = renderDataMessage({ ...base, agents }, source, { seed: sidebar(sections) });

  const value = fieldValue(rendered, "Account Status");
  assert.ok(value, "Account Status 这一行应当在卡片上");
  const dot = value.querySelectorAll(".dot")[0];
  assert.ok(dot, "状态行有它自己的圆点");
  // 一个绿点画在「Not signed in」旁边，是界面上唯一一处「字与图互相矛盾」的地方。
  assert.equal(dot.className, "dot muted", `圆点要说出它旁边那句话的口气，实际是「${dot.className}」`);
});

test("the pack row's Install asks for that pack, not for a picker", async () => {
  const { source, sections } = await page();
  const rendered = renderDataMessage(await payload(), source, { seed: sidebar(sections) });

  fire(button(rendered, "Available Packs"));
  fire(button(rendered, "Install"));
  assert.deepEqual(lastPosted(rendered, "action"), { type: "action", action: "installPack", pack: "release-kit" });
});

test("the registry pane's Sync syncs the registry", async () => {
  const { source, sections } = await page();
  const rendered = renderDataMessage(await payload(), source, { seed: sidebar(sections) });

  fire(button(rendered, "Official Registry"));
  fire(button(rendered, "Sync again"));
  assert.deepEqual(lastPosted(rendered, "action"), { type: "action", action: "syncHub" });
});

test("an isolated project is offered no shared-history action", async () => {
  const { source, sections } = await page();
  const rendered = renderDataMessage(await payload({
    history: { mode: "isolated", sharedCount: 12 },
    transcript: TRANSCRIPT,
  }), source, { seed: sidebar(sections) });

  // CLI 自己的会话菜单在隔离模式下连这两项都不列出来（dispatcher 的 sessionActions
  // 只在 shared 时提供），面板也不该给一条走不通的路。
  assert.equal(button(rendered, "Continue Shared Session").disabled, true, "隔离模式下「继续共享会话」是走不通的那条路");
  assert.equal(button(rendered, "Switch to Shared").disabled, false, "而换成共享的那一步在");
});

test("a shared project keeps the Active action, and an isolated one does not offer it", async () => {
  const { source, sections } = await page();
  const shared = renderDataMessage(await payload({ transcript: TRANSCRIPT }), source, { seed: sidebar(sections) });
  fire(button(shared, "View All Shared Sessions (12)"));
  assert.equal(findButton(shared, "Set as Active")?.disabled, false, "共享项目里这条会话可以被设为 Active");

  const isolated = renderDataMessage(await payload({
    history: { mode: "isolated", sharedCount: 12 },
    transcript: TRANSCRIPT,
  }), source, { seed: sidebar(sections) });
  fire(button(isolated, "View All Shared Sessions (12)"));
  assert.equal(findButton(isolated, "Set as Active"), undefined, "隔离模式下 CLI 不提供这一项，面板也不提供");
});

test("with no folder open the panel offers to open one, not to initialise one", async () => {
  const { source, sections } = await page();
  const rendered = renderDataMessage(await payload({
    project: { name: "", root: null, configured: false, lastUpdated: null },
    empty: "Open a project folder to see its Avenic state.",
  }), source, { seed: sidebar(sections) });

  fire(button(rendered, "Open Folder"));
  assert.deepEqual(lastPosted(rendered, "action"), { type: "action", action: "openProject" });
});

test("an unconfigured project folder is still offered initialisation", async () => {
  const { source, sections } = await page();
  const rendered = renderDataMessage(await payload({ empty: "This project has no Avenic configuration yet." }), source, { seed: sidebar(sections) });

  fire(button(rendered, "Initialize Avenic"));
  assert.deepEqual(lastPosted(rendered, "action"), { type: "action", action: "initialize" });
});

test("the header's Reconfigure names no agent of its own", async () => {
  const { source, sections } = await page();
  const rendered = renderDataMessage(await payload(), source, { seed: sidebar(sections) });

  const handler = rendered.byId.get("reconfigure-button")?.onclick;
  assert.ok(handler, "标题栏的按钮由脚本挂载");
  handler();
  // 面板上的每个动作都说得出它问的是谁；这一问的答案是「这个项目」，不是某个 agent。
  assert.deepEqual(lastPosted(rendered, "action"), { type: "action", action: "reconfigure" });
});

// 「CLI 已经退出、面板还写着 Running」是这一层最贵的一个 bug：状态是面板唯一会说谎的
// 地方，而它说谎的样子看起来完全正常。两件事要一起成立——跑着的时候卡片说了，
// 宿主说它结束时那句话当场消失，且不留下一张重画过的页面（正在读的人不该被拽走）。
async function running(): Promise<Payload> {
  const base = await payload();
  return { ...base, agents: base.agents.map((agent: Payload) => ({ ...agent, run: agent.id === "claude" ? "running" : "idle" })) };
}

function runPill(rendered: Rendered, agentId: string): StubNode | undefined {
  return rendered.content.querySelectorAll(`.run-pill[data-run-for="${agentId}"]`)[0];
}

test("a launch that ended takes its Running pill with it, and changes nothing else", async () => {
  const { source, sections } = await page();
  const rendered = renderDataMessage(await running(), source, { seed: sidebar(sections) });
  const pill = runPill(rendered, "claude");
  assert.ok(pill, "跑着的 agent 卡片上有一枚状态胶囊");
  assert.equal(pill.textContent, "Running");
  const before = rendered.created.length;

  rendered.send({ type: "status", runs: { claude: "idle", codex: "idle", opencode: "idle" } });

  assert.equal(pill.textContent, "", "退出之后那句话必须当场消失，而不是等下一次推送");
  assert.equal(pill.className, "run-pill");
  assert.equal(rendered.content.querySelectorAll(".run-pill")[0], pill, "改的是那一枚胶囊本身，不是把整页重画一遍");
  assert.equal(rendered.created.length, before, "一次启动的开始或结束不新建任何节点");
  assert.equal(rendered.posted.some((message) => (message as { type?: string }).type === "refresh"), false, "也不向宿主再要一份载荷");
});

test("a launch that died says so instead of looking idle", async () => {
  const { source, sections } = await page();
  const rendered = renderDataMessage(await payload(), source, { seed: sidebar(sections) });
  assert.equal(runPill(rendered, "claude")?.textContent, "", "没在跑就没有那句话");

  rendered.send({ type: "status", runs: { claude: "interrupted", codex: "idle", opencode: "idle" } });

  const pill = runPill(rendered, "claude");
  assert.equal(pill?.textContent, "Interrupted", "没跑完的那一次不能看起来和「没在跑」一样");
  assert.equal(pill?.className, "run-pill run-interrupted");
  assert.equal(runPill(rendered, "codex")?.textContent, "", "别的 agent 不受影响");
});

/* ------------------------------------------------------------ sessions page -- */
//
// Sessions 是这一页里唯一「读」的地方：左边一列会话，右边一段对话。它坏掉的样子
// 大多不像坏掉——一列没有参与者的行、一段把工具调用写成用户发言的对话、滚动时被拽
// 到底部——所以每一条都由下面的用例盯着一个具体的动作。

/** Sessions 页的两半：左边这一列，和右边那一段对话。 */
function browser(rendered: Rendered): StubNode {
  const node = rendered.content.querySelectorAll(".sessions-browser")[0];
  assert.ok(node, "Sessions 分区应当是两个窗格的浏览器，而不是两张和概览一样的卡");
  return node;
}

function listRows(rendered: Rendered): StubNode[] {
  return browser(rendered).querySelectorAll(".session-row");
}

function rowTitle(row: StubNode): string {
  return row.querySelectorAll(".row-title")[0]?.textContent ?? "";
}

/** 从概览翻到 Sessions 页：真实的那条路是「View All」链接。 */
function openSessions(rendered: Rendered, label = "View All Shared Sessions (12)"): void {
  fire(button(rendered, label));
}

/** 只有图标的那种按钮：它不说自己叫什么，能定位它的只有它挂着的那个名字。 */
function iconButton(scope: StubNode, label: string): StubNode {
  const found = scope.querySelectorAll(`button[aria-label="${label}"]`)[0];
  assert.ok(found, `这里应当有一个叫「${label}」的图标按钮`);
  return found;
}

/** 头部的一格：按标签找它右边那一格说的值。 */
function factValue(scope: StubNode, label: string): string {
  const facts = scope.querySelectorAll(".session-fact");
  const index = facts.findIndex((node) => node.textContent === label);
  assert.ok(index >= 0, `头部应当有一格「${label}」，实际是 ${facts.map((node) => node.textContent).join(" | ")}`);
  return scope.querySelectorAll(".fact-value")[index]?.textContent ?? "";
}

test("the Sessions page is a two-pane browser, and every row is metadata", async () => {
  const { source, sections } = await page();
  const base = await payload({ transcript: TRANSCRIPT });
  const rendered = renderDataMessage(base, source, { seed: sidebar(sections) });
  openSessions(rendered);

  const panes = browser(rendered);
  assert.equal(panes.querySelectorAll(".sessions-list-pane").length, 1, "左边是一列会话");
  assert.equal(panes.querySelectorAll(".session-view").length, 1, "右边是打开的对话");

  const rows = listRows(rendered);
  assert.deepEqual(rows.map(rowTitle), base.shared.rows.map((row: Payload) => row.title), "每一行说的是这条会话的名字");
  // 一行是「元数据」：名字、参与者、时间。uuid 不是其中任何一样，出现它就是把存储
  // 的编号当成产品的名字。
  for (const row of rows) {
    for (const id of base.shared.rows.map((item: Payload) => item.id)) {
      assert.equal(row.textContent.includes(id), false, `行里不该出现会话 id「${id}」`);
    }
  }
  assert.ok(rows[0].textContent.includes("2 hours ago"), "行上有相对时间");
  assert.equal(rows[0].querySelectorAll(".agent-chip").length, 2, "行上有参与者徽章");
});

test("a row says when its agents are working, and when the copy is behind", async () => {
  const { source, sections } = await page();
  const base = await payload();
  const rows = [...base.shared.rows];
  rows[0] = { ...rows[0], sync: { state: "current", running: true } };
  rows[1] = { ...rows[1], sync: { state: "stale", running: false } };
  const rendered = renderDataMessage({ ...base, shared: { rows, total: base.shared.total } }, source, { seed: sidebar(sections) });
  openSessions(rendered);

  const list = listRows(rendered);
  // 「正跑着」这件事 core 已经说了（启动组状态），行上就不用再说第二遍：同一个词
  // 出现在卡片和行上，说的是同一件事。
  const pill = list[0].querySelectorAll(".run-pill")[0];
  assert.ok(pill, "有 agent 正在跑的会话，行上有一枚状态胶囊");
  assert.equal(pill.textContent, "Running");
  // 投影掉在 canonical 历史后面时，行说的是「这份拷贝落后了」，而不是「没事」。
  assert.ok(list[1].textContent.includes("Stale"), "落后于共享历史的投影要在行上说出来");
  // 没在跑的行不说话。胶囊本身在 DOM 里（空的，由 CSS 的 :empty 藏起来）——它得在
  // 那儿，宿主说「开始跑了」时才有东西可改，这和卡片上那枚是同一套做法。
  assert.equal(list[2].querySelectorAll(".run-pill")[0]?.textContent ?? "", "", "没在跑也没有落后的行，行上不说 Running");
});

test("a run that ends while the list is open takes the row's Running with it", async () => {
  const { source, sections } = await page();
  const base = await payload();
  const rows = [...base.shared.rows];
  rows[0] = { ...rows[0], sync: { state: "current", running: true } };
  const rendered = renderDataMessage({ ...base, shared: { rows, total: base.shared.total } }, source, { seed: sidebar(sections) });
  openSessions(rendered);
  assert.ok(listRows(rendered)[0].textContent.includes("Running"), "跑着的那条会话，行上有一枚状态胶囊");
  const before = rendered.created.length;

  rendered.send({ type: "status", runs: { claude: "idle", codex: "idle", opencode: "idle" } });

  assert.equal(listRows(rendered)[0].textContent.includes("Running"), false, "列表开着的时候那次启动结束了，行上那句话必须当场消失");
  assert.equal(rendered.created.length, before, "一次启动的开始或结束不新建任何节点");
  assert.equal(rendered.posted.some((message) => (message as { type?: string }).type === "refresh"), false, "也不向宿主再要一份载荷");
});

test("a run that starts while the list is open says Running on the rows its agents are in", async () => {
  const { source, sections } = await page();
  const rendered = renderDataMessage(await payload(), source, { seed: sidebar(sections) });
  openSessions(rendered);
  assert.equal(listRows(rendered)[0].textContent.includes("Running"), false, "开工之前行上不说 Running");

  rendered.send({ type: "status", runs: { claude: "running", codex: "idle", opencode: "idle" } });

  // 行说的只是它自己的参与者：claude 开工，带 claude 的那几行说 Running，只有
  // codex 和 opencode 的那一行不受影响——不然行就在替别的会话发言了。
  const list = listRows(rendered);
  assert.ok(list[0].textContent.includes("Running"), "第一个会话有 claude 参与，行上要说 Running");
  assert.equal(list[2].textContent.includes("Running"), false, "第三个会话里没有 claude，行上不该跟着说 Running");

  rendered.send({ type: "status", runs: { claude: "running", codex: "running", opencode: "idle" } });

  assert.ok(list[2].textContent.includes("Running"), "codex 也开工之后，第三个会话的行才说 Running");
});

test("the two-way toggle says which history each list is, and the note explains the terms", async () => {
  const { source, sections } = await page();
  const base = await payload({ transcript: TRANSCRIPT });
  const rendered = renderDataMessage(base, source, { seed: sidebar(sections) });
  openSessions(rendered);

  const shared = browser(rendered).querySelectorAll(".card-title").map((node) => node.textContent);
  assert.ok(shared.includes("Shared Sessions"), `共享那一半的表头是产品词，实际是 ${shared.join(" | ")}`);
  assert.ok(browser(rendered).textContent.includes("Native sessions and projections for each agent."));

  fire(button(rendered, "Agent"));
  const agent = browser(rendered).querySelectorAll(".card-title").map((node) => node.textContent);
  assert.ok(agent.includes("Agent Sessions"), `Agent 那一半的表头是产品词，实际是 ${agent.join(" | ")}`);
  assert.ok(browser(rendered).textContent.includes("Independent histories for each agent."));
  // 解释这两个词的那句话只能用这两个词：`Session Storage` 是自己造的第三个词，
  // 上一个版本用它来讲区别，现在它连一个字符串都不该出现。
  const note = browser(rendered).querySelector(".sessions-note")?.textContent ?? "";
  assert.ok(/Shared Sessions/.test(note) && /Agent Sessions/.test(note), `两种会话的区别要用产品词说清楚，实际是 ${note}`);
  assert.equal(/Session Storage|Project Sessions/.test(note), false, "解释两个词的那句话不造第三个词");

  // 「Project Sessions / Project History」是这份产品不要的词：它把「每个 agent 自己的
  // 会话」说成了这个项目的会话，而这两件事在隔离模式下正好相反。
  const written = allText(rendered);
  assert.equal(/Project Sessions|Project History/.test(written), false, "页面上不该再出现 Project Sessions / Project History");
});

test("the toggle tells the host which tab is showing, and the search never asks it", async () => {
  const { source, sections } = await page();
  const base = await payload();
  const rendered = renderDataMessage(base, source, { seed: sidebar(sections) });
  openSessions(rendered);
  assert.deepEqual(lastPosted(rendered, "navigate"), { type: "navigate", section: "sessions", tab: "shared" }, "默认那一半是共享");

  fire(button(rendered, "Agent"));
  assert.deepEqual(lastPosted(rendered, "navigate"), { type: "navigate", section: "sessions", tab: "agent" });
  const agentTitles = listRows(rendered).map(rowTitle);
  assert.deepEqual(agentTitles, base.native.claude.rows.map((row: Payload) => row.title), "Agent 那一半列的是这个 agent 自己的会话");

  // 搜索是这一页自己的事：在客户端过一遍已经拿到的那列，问宿主一次新的读盘不叫搜索。
  const posted = rendered.posted.length;
  const search = browser(rendered).querySelectorAll(".session-search")[0];
  assert.ok(search, "搜索框在列表上方");
  search.value = "TUI";
  fire(search, "input");
  assert.equal(browser(rendered).querySelectorAll(".session-row").length, 1, "只剩标题里带 TUI 的那一条");
  assert.equal(rendered.posted.length, posted, "搜索不向宿主发消息");

  search.value = "";
  fire(search, "input");
  assert.equal(browser(rendered).querySelectorAll(".session-row").length, agentTitles.length, "清空搜索就又都回来了");
});

test("a session with no title of its own is named by a short id, never a raw uuid", async () => {
  const { source, sections } = await page();
  const base = await payload();
  const rows = [...base.shared.rows];
  rows[0] = { ...rows[0], id: "bee6f9b7-4a1c-4f2e-9d3b-7c1a55e0f2ab", title: "" };
  const rendered = renderDataMessage({ ...base, shared: { rows, total: base.shared.total } }, source, { seed: sidebar(sections) });
  openSessions(rendered);

  const first = listRows(rendered)[0];
  assert.equal(rowTitle(first), "bee6f9b7", "没有标题时用的是短 id（至多 8 个字符）");
  assert.equal(allText(rendered).includes("bee6f9b7-4a1c-4f2e-9d3b-7c1a55e0f2ab"), false, "整页都不该印出那个 uuid");
});

test("the open conversation is marked in the list, and the reader names its speakers", async () => {
  const { source, sections } = await page();
  const rendered = renderDataMessage(await payload({ transcript: TRANSCRIPT }), source, { seed: sidebar(sections) });
  openSessions(rendered);

  const marked = listRows(rendered).filter((row) => row.getAttribute("aria-current") === "true");
  assert.equal(marked.length, 1, "正在读的那一条只有一个");
  assert.equal(rowTitle(marked[0]), TRANSCRIPT.title, "而且就是右边这一段");
  assert.equal(listRows(rendered).filter((row) => row.getAttribute("aria-current") === null).length, listRows(rendered).length - 1, "别的行没有标记");

  const reader = browser(rendered).querySelectorAll(".session-view")[0];
  assert.equal(reader.textContent.includes("Fix authentication environment handling"), true, "右边说的是这条会话的名字");
  assert.equal(reader.textContent.includes("Claude, Codex"), true, "参与者按 core 的叫法列出");
  assert.equal(reader.textContent.includes("Synced"), true, "同步状态是宿主给的答案");
  const speakers = reader.querySelectorAll(".turn-speaker").map((node) => node.textContent);
  assert.deepEqual(speakers, ["You", "Claude"], "话说出口的人是谁：键盘前的人、还是某个 agent");
  // 存在盘上的 role 是「user/assistant」，它是数据库的词，不是这一页的词。
  assert.equal(["user", "assistant"].some((word) => speakers.includes(word)), false, "说话人不能是 role 的原词");
});

test("tool traffic is folded under the agent's turn, never put in the user's mouth", async () => {
  const { source, sections } = await page();
  const rendered = renderDataMessage(await payload({ transcript: TRANSCRIPT }), source, { seed: sidebar(sections) });
  openSessions(rendered);

  const turns = browser(rendered).querySelectorAll(".turn");
  assert.equal(turns.length, 2, "一轮话一个块");
  const tool = turns[1].querySelectorAll(".tool-row")[0];
  assert.ok(tool, "工具调用挂在发起它的那一轮下面");
  assert.ok(tool.textContent.includes("Read"), "工具行说的是它跑了什么");
  assert.ok(tool.textContent.includes("src/auth/env.ts"), "以及跑在哪上面");
  assert.equal(turns[0].querySelectorAll(".tool-row").length, 0, "键盘前的那个人没有跑过工具");
  // 被语义层拿掉的那些记录（控制行、CLI 自己的回显）根本不在载荷里：这一页不筛原始
  // 记录，它只画载荷已经给出来的那几轮。
  assert.equal(rendered.content.querySelectorAll(".turn").length, turns.length, "画出来的轮数就是载荷里的轮数");
});

test("the reader header answers what the conversation is, and Raw/Diagnostics are views of it", async () => {
  const { source, sections } = await page();
  const rendered = renderDataMessage(await payload({ transcript: TRANSCRIPT }), source, { seed: sidebar(sections) });
  openSessions(rendered);

  const reader = browser(rendered).querySelectorAll(".session-view")[0];
  // 头部那四格：谁在说、什么时候说的、说了多少、和原生会话对没对上账。四样都是宿主
  // 给的答案，这一页一份都不算。
  assert.equal(factValue(reader, "Participants"), "Claude, Codex");
  assert.equal(factValue(reader, "Updated"), "2 hours ago", "Updated 是相对时间");
  assert.equal(factValue(reader, "Event count"), "2 events", "事件数来自载荷");
  assert.equal(factValue(reader, "Sync state"), "Synced", "同步状态是宿主给的答案");

  // ⋯ 后面那两项是这一页自己的两种读法：Raw 是这些轮的原样，Diagnostics 是这条会话
  // 的投影说过什么。两者都不向宿主再要一次——一个点了会发消息的菜单项，等不到回包
  // 就是死的。
  fire(iconButton(reader, "Session actions"));
  const posted = rendered.posted.length;
  fire(button(rendered, "Raw"));
  assert.ok(browser(rendered).querySelectorAll(".raw-view")[0], "Raw 打开的是这些轮的原样");
  assert.ok(browser(rendered).textContent.includes("Because the environment is read once."), "原样里当然有正文");
  assert.equal(rendered.posted.length, posted, "Raw 不在客户端之外做任何事");

  fire(iconButton(reader, "Session actions"));
  fire(button(rendered, "Diagnostics"));
  assert.ok(browser(rendered).querySelectorAll(".diagnostics-view")[0], "Diagnostics 打开的是这条会话的投影诊断");
  assert.equal(rendered.posted.length, posted, "Diagnostics 也不发出站消息");
});

test("Continue and Set as Active keep the behaviour the Overview cards already had", async () => {
  const { source, sections } = await page();
  const shared = renderDataMessage(await payload({ transcript: TRANSCRIPT }), source, { seed: sidebar(sections) });
  openSessions(shared);

  const reader = browser(shared).querySelectorAll(".session-view")[0];
  // 这一条问的是「读的这一条能不能设成当前那条」，所以点的是右半边头部那一个：列表里
  // 每一行也有自己的（作用于那一行的原生会话），页面上同名的不止一个。
  const setActive = reader.querySelectorAll(".btn").find((node) => node.textContent.includes("Set as Active"));
  assert.ok(setActive, "右边这一段有个 Set as Active");
  fire(setActive);
  assert.deepEqual(lastPosted(shared, "action"), { type: "action", action: "setActive", id: TRANSCRIPT.id }, "共享历史里能把它设成当前那条");

  const continueButton = reader.querySelectorAll(".btn").find((node) => node.textContent.includes("Continue"));
  assert.ok(continueButton, "右边这一段有个 Continue");
  fire(continueButton);
  assert.deepEqual(lastPosted(shared, "action"), { type: "action", action: "continueShared", id: TRANSCRIPT.id }, "接着这条共享会话往下说");

  const isolated = renderDataMessage(await payload({ history: { mode: "isolated", sharedCount: 12 }, transcript: TRANSCRIPT }), source, { seed: sidebar(sections) });
  openSessions(isolated);
  assert.equal(findButton(isolated, "Set as Active"), undefined, "隔离模式下 CLI 不提供这一项，面板也不提供");
});

test("a new message is appended where the reader is, not re-rendered under them", async () => {
  const { source, sections } = await page();
  const base = await payload({ transcript: TRANSCRIPT });
  const rendered = renderDataMessage(base, source, { seed: sidebar(sections) });
  openSessions(rendered);
  const first = browser(rendered).querySelectorAll(".turn")[0];
  const rowsBefore = listRows(rendered);
  const createdBefore = rendered.created.length;

  const turns = [...TRANSCRIPT.turns, { id: "e3", kind: "agent", speaker: "Codex", agent: "codex", role: "assistant", at: "2025-09-20T20:31:00Z", text: "Handing the environment read over to the loader.", tools: [], model: null }];
  rendered.send({ type: "data", payload: { ...base, transcript: { ...TRANSCRIPT, turns, eventCount: 3, updatedRelative: "just now" } } });

  const after = browser(rendered).querySelectorAll(".turn");
  assert.equal(after.length, 3, "新来的那一轮接在后面");
  assert.equal(after[0], first, "已经在读的那几轮是同一批节点，不是重画出来的");
  assert.ok(after[2].textContent.includes("Handing the environment read over to the loader."));
  assert.equal(after[2].querySelectorAll(".turn-speaker")[0].textContent, "Codex", "新的一轮自己说出说话人");
  assert.deepEqual(listRows(rendered), rowsBefore, "左边那一列没有被动过");
  assert.ok(rendered.created.length > createdBefore, "只新建了新那一轮要的节点");
  assert.equal(browser(rendered).textContent.includes("3 events"), true, "头部的计数跟着走");
});

// 打开一条对话，落点是它的结尾。一列滚动条停在最上面的时候，读的人第一眼看到的
// 是这段对话的中间（长会话里就是第 100 轮之前的那一段），而消息的落点从来是最后
// 一条——「继续」这个按钮在右边，人却还在三天前。
test("a session opens on its newest turn, not on the top of the window", async () => {
  const { source, sections } = await page();
  const base = await payload({ transcript: TRANSCRIPT });
  const rendered = renderDataMessage(base, source, { seed: sidebar(sections) });
  openSessions(rendered);

  const transcript = browser(rendered).querySelectorAll(".transcript")[0];
  assert.ok(transcript, "对话自己是一个会滚的盒子");
  assert.ok(transcript.scrollHeight > 0, "这一列里有内容");
  assert.equal(transcript.scrollTop, transcript.scrollHeight, "刚打开就停在最新那一轮上");
});

test("a reader who scrolled up gets a way down instead of being yanked to the bottom", async () => {
  const { source, sections } = await page();
  const base = await payload({ transcript: TRANSCRIPT });
  const rendered = renderDataMessage(base, source, { seed: sidebar(sections) });
  openSessions(rendered);

  // 真实浏览器里这一列是有高度的：桩不排版，所以高度由用例铺给它。
  const transcript = browser(rendered).querySelectorAll(".transcript")[0];
  assert.ok(transcript, "对话自己是一个会滚的盒子");
  transcript.scrollHeight = 1200;
  transcript.clientHeight = 400;
  transcript.scrollTop = 0;

  const turns = [...TRANSCRIPT.turns, { id: "e3", kind: "agent", speaker: "Claude", agent: "claude", role: "assistant", at: "2025-09-20T20:31:00Z", text: "One more thing.", tools: [], model: null }];
  rendered.send({ type: "data", payload: { ...base, transcript: { ...TRANSCRIPT, turns, eventCount: 3 } } });

  const chip = browser(rendered).querySelectorAll(".new-messages")[0];
  assert.ok(chip, "读到一半来新消息时，屏幕下沿给一条回去的提示");
  assert.equal(transcript.scrollTop, 0, "没有把正在读的人拽到底部");

  fire(chip);
  assert.ok(transcript.scrollTop > 0, "点了它才下去");
});

test("a reader at the bottom is followed automatically", async () => {
  const { source, sections } = await page();
  const base = await payload({ transcript: TRANSCRIPT });
  const rendered = renderDataMessage(base, source, { seed: sidebar(sections) });
  openSessions(rendered);

  const transcript = browser(rendered).querySelectorAll(".transcript")[0];
  transcript.scrollHeight = 1200;
  transcript.clientHeight = 400;
  transcript.scrollTop = 800;

  const turns = [...TRANSCRIPT.turns, { id: "e3", kind: "user", speaker: "You", agent: null, role: "user", at: "2025-09-20T20:31:00Z", text: "And now?", tools: [], model: null }];
  rendered.send({ type: "data", payload: { ...base, transcript: { ...TRANSCRIPT, turns, eventCount: 3 } } });

  assert.equal(browser(rendered).querySelectorAll(".new-messages").length, 0, "本来就在底部的人不需要那枚提示");
  assert.equal(transcript.scrollTop, transcript.scrollHeight, "跟着新消息走");
});

test("a long transcript shows the newest hundred turns and loads the rest at the top", async () => {
  const { source, sections } = await page();
  const base = await payload();
  const long = Array.from({ length: 150 }, (_, index) => ({
    id: `e${index}`,
    kind: index % 2 === 0 ? "user" : "agent",
    speaker: index % 2 === 0 ? "You" : "Claude",
    agent: index % 2 === 0 ? null : "claude",
    role: index % 2 === 0 ? "user" : "assistant",
    at: "2025-09-20T20:20:00Z",
    text: `Turn number ${index}`,
    tools: [],
    model: null,
  }));
  const rendered = renderDataMessage({ ...base, transcript: { ...TRANSCRIPT, turns: long, eventCount: 150 } }, source, { seed: sidebar(sections) });
  openSessions(rendered);

  const body = browser(rendered).querySelectorAll(".transcript")[0];
  assert.equal(body.querySelectorAll(".turn").length, 100, "先画最新的 100 轮");
  // 最新的 100 轮是第 50 到第 149 轮：更早的那 50 轮还没画。
  assert.equal(body.textContent.includes("Turn number 49"), false, "更早的那些还没画");
  assert.ok(body.textContent.includes("Showing the newest 100 of 150 turns."), "而且说清楚它没画全部");

  // 「往上滚」就是更早的意思：到底之后这一页把剩下的补上，不再向宿主多要一次载荷。
  const posted = rendered.posted.length;
  body.scrollTop = 0;
  fire(body, "scroll");
  const grown = browser(rendered).querySelectorAll(".transcript")[0].querySelectorAll(".turn");
  assert.equal(grown.length, 150, "再往上就都补齐了");
  assert.ok(grown[0].textContent.includes("Turn number 0"), "补上的是开头那几轮");
  assert.equal(rendered.posted.length, posted, "虚拟化是这一页自己的切片，数据还是那一份");
});

test("the Sessions page says what is missing instead of drawing an empty box", async () => {
  const { source, sections } = await page();
  const bare = await payload({
    shared: { rows: [], total: 0 },
    native: {
      claude: { rows: [], total: 0 },
      codex: { rows: [], total: 0 },
      opencode: { rows: [], total: 0 },
    },
  });
  const rendered = renderDataMessage(bare, source, { seed: sidebar(sections) });
  // 这份载荷里一条共享会话都没有，概览那张卡上的链接也就写着 (0)：真实的那条路
  // 长的就是它当时的那个样子。
  openSessions(rendered, "View All Shared Sessions (0)");

  // 桩的选择器没有后代组合子：先找到那一格，再在它里面找。
  const panes = browser(rendered);
  const listPane = panes.querySelectorAll(".sessions-list-pane")[0];
  const readerPane = panes.querySelectorAll(".session-view")[0];
  assert.ok(listPane?.querySelectorAll(".empty").length > 0, "一列空的时候，那一列要说一句话");
  assert.ok(readerPane?.querySelectorAll(".empty").length > 0, "右边没有可读的对话时也要说一句话，而不是一块空地");
  assert.ok(panes.textContent.includes("No shared sessions yet."));

  fire(button(rendered, "Agent"));
  assert.ok(browser(rendered).querySelectorAll(".sessions-list-pane")[0].querySelectorAll(".empty").length > 0, "换到 Agent 那一半，空仍然是空的，话也在");
});

test("the two View All links land on the tab they name", async () => {
  const { source, sections } = await page();
  const rendered = renderDataMessage(await payload(), source, { seed: sidebar(sections) });

  fire(button(rendered, "View All Agent Sessions"));
  assert.deepEqual(lastPosted(rendered, "navigate"), { type: "navigate", section: "sessions", tab: "agent" }, "「View All Agent Sessions」落的是 Agent 那一半");
  const selected = browser(rendered).querySelectorAll('.tab[aria-selected="true"]').map((node) => node.textContent);
  assert.deepEqual(selected.slice(0, 1), ["Agent"], "而且那一半已经选上了");

  const again = renderDataMessage(await payload(), source, { seed: sidebar(sections) });
  openSessions(again);
  assert.deepEqual(lastPosted(again, "navigate"), { type: "navigate", section: "sessions", tab: "shared" }, "共享那一条落的是 Shared 那一半");
});

// 哪一半是页面自己的状态：面板和它的 webview 同生共死，所以页面手上那一份永远不比
// 宿主记的更旧——宿主再记一份只等于把「用户站在哪儿」存两遍。这条钉的是「谁说了算」：
// 翻页是页面自己动的，它只把结果告诉宿主；一次推送不替它重选。
test("a plain push leaves the half where the reader put it", async () => {
  const { source, sections } = await page();
  const base = await payload();
  const rendered = renderDataMessage(base, source, { seed: sidebar(sections) });
  openSessions(rendered);
  fire(button(rendered, "Agent"));

  rendered.send({ type: "data", payload: base });
  const titles = browser(rendered).querySelectorAll(".card-title").map((node) => node.textContent);
  assert.ok(titles.includes("Agent Sessions"), `一次推送不该换掉用户选的那一半，实际表头有 ${titles.join(" | ")}`);
});

/* --------------------------------------------------- hooks & notifications -- */
//
// 这一页最贵的三件事都不是「画错了」那一类，所以每一条都由用例盯着一件具体的动作：
//   1. 换一档作用域必须真的去读那一档（不是只换一个高亮）。
//   2. 每一行右边那颗按钮必须发出它自己那一件事（装、卸、预览、改、删），
//      一颗什么都不发生的按钮和一个坏掉的按钮，用户看起来是一样的。
//   3. 命令类那一颗在 Advanced 之前是灰的，理由就写在它下面。
//
// 阈值那两个数只从载荷读：用例故意给一组不是 20/5 的数，页面要是自己记着默认值，
// 「42 秒」那一句就会露馅。

const HOOK_ACTIONS = [
  { id: "openclaw", kind: "openclaw", target: "http://127.0.0.1:18789/hooks/avenic", tokenSet: false, tokenEnv: "OPENCLAW_HOOK_TOKEN", timeoutMs: null },
  { id: "webhook-release", kind: "webhook", target: "https://example.test/hook", tokenSet: true, tokenEnv: null, timeoutMs: 30000 },
];

const HOOKS: Payload = {
  scope: "project",
  agents: [
    { agent: "claude", displayName: "Claude Code", mechanism: "settings-hooks", version: "2.1.0", supported: true, supportNote: null, file: "/p/.claude/settings.json", installed: true, caveat: "" },
    { agent: "codex", displayName: "Codex", mechanism: "config-hooks", version: "0.9.7", supported: true, supportNote: null, file: "/p/.codex/config.toml", installed: false, caveat: "Codex only runs a hook you have reviewed." },
    { agent: "opencode", displayName: "OpenCode", mechanism: "plugin", version: "1.4.2", supported: false, supportNote: "Unsupported by OpenCode 1.4.2", file: "/p/.config/opencode/plugin/avenic.js", installed: false, caveat: "" },
  ],
  actions: HOOK_ACTIONS,
  actionsFile: "/p/.avenic/hook-actions.json",
  kinds: ["desktop", "openclaw", "webhook", "command"],
  completedMinSeconds: 42,
  dedupeSeconds: 7,
};

/** 翻到某一页：走的是侧栏那一格，和用户走的是同一条路。 */
function openSection(rendered: Rendered, section: string): void {
  const item = rendered.byId.get("nav")?.querySelectorAll(".nav-item[data-section]").find((node) => node.getAttribute("data-section") === section);
  assert.ok(item, `侧栏上应当有「${section}」这一格`);
  fire(item);
}

async function hooksPage(patch: Payload = {}): Promise<Rendered> {
  const { source, sections } = await page();
  const rendered = renderDataMessage(await payload({ hooks: HOOKS, ...patch }), source, { seed: sidebar(sections) });
  openSection(rendered, "hooks");
  return rendered;
}

/** 一张卡里的一行：agent 那一张与通知那一张的行长得一样，先认出是哪一张。 */
function hookRow(rendered: Rendered, text: string): StubNode {
  const found = rendered.content.querySelectorAll(".hook-row").find((row) => row.textContent.includes(text));
  assert.ok(found, `这一页上应当有一行提到「${text}」，实际是 ${rendered.content.querySelectorAll(".hook-row").map((row) => row.textContent).join(" | ")}`);
  return found;
}

/** 行里有没有这么一颗按钮。「没有」本身也是一种答案（装着的行不给第二颗「安装」）。 */
function findRowButton(row: StubNode, label: string): StubNode | undefined {
  return row.querySelectorAll("button").find((node) => node.textContent === label);
}

/** 行里的按钮：两行可能都有同名的一颗（「View Generated Config」就有两颗），所以按行取。 */
function rowButton(row: StubNode, label: string): StubNode {
  const found = findRowButton(row, label);
  assert.ok(found, `这一行上应当有一颗「${label}」，实际是 ${row.querySelectorAll("button").map((node) => node.textContent).join(" | ")}`);
  return found;
}

// 桩记着「这一页一共创建过什么」，所以重画之后按文案找按钮要取**当前树上**那一颗：
// 第一颗是上一帧的，它上面的字与灰不灰都是上一帧的答案。
function liveButton(rendered: Rendered, label: string): StubNode {
  const found = rendered.content.querySelectorAll("button").find((node) => node.textContent === label);
  assert.ok(found, `这一页上应当有一颗「${label}」，实际是 ${rendered.content.querySelectorAll("button").map((node) => node.textContent).join(" | ")}`);
  return found;
}

test("the hooks page's scope switch asks the host for that scope, and never claims it before the rows arrive", async () => {
  const rendered = await hooksPage();
  assert.equal(liveButton(rendered, "Project").getAttribute("aria-pressed"), "true", "打开时读的是项目那一档");
  assert.equal(liveButton(rendered, "Global").getAttribute("aria-pressed"), "false");

  fire(liveButton(rendered, "Global"));

  // 换它换的是「这份名单写在哪里」，所以它是一次真的读盘：页面把落点交给宿主，请它读那一档。
  assert.deepEqual(lastPosted(rendered, "action"), { type: "action", action: "hooksOpen", scope: "global" });
  // 整页刷新会把用户从这一页拽走：换一档要的是那一档的数据，不是重开一次面板。
  assert.equal(rendered.posted.some((message) => (message as { type?: string }).type === "refresh"), false, "换一档不是重读整份载荷");
  // 回包之前高亮不动：此刻画在纸上的三行与那份名单都是项目那一档的，「已选全局」会是这一页
  // 上唯一一句与事实相反的话（中心那一栏换 agent 用的是同一条规矩：载荷画哪儿，哪儿才亮）。
  assert.equal(liveButton(rendered, "Project").getAttribute("aria-pressed"), "true", "回包之前不替宿主宣布答案");

  // 宿主把那一档读回来，高亮与内容一起换过去。
  rendered.send({ type: "data", payload: await payload({ hooks: { ...HOOKS, scope: "global" } }) });
  assert.equal(liveButton(rendered, "Global").getAttribute("aria-pressed"), "true", "宿主说读的是哪一档，高亮就在哪一档");
  assert.equal(liveButton(rendered, "Project").getAttribute("aria-pressed"), "false");
  fire(rowButton(hookRow(rendered, "Webhook"), "Edit"));
  // 改与删报的是**画出来的那一档**：页面不是凭自己的高亮记的，是凭载荷说的。
  assert.deepEqual(lastPosted(rendered, "action"), { type: "action", action: "hookActionEdit", scope: "global", id: "webhook-release" });
});

test("every agent row offers exactly what this scope can do, and says what Avenic cannot", async () => {
  const rendered = await hooksPage();

  const installed = hookRow(rendered, "Claude Code");
  assert.ok(installed.textContent.includes("2.1.0"), "行上写着装的是哪个版本——「不支持」那一句说的就是它");
  assert.ok(installed.textContent.includes("Installed"));
  assert.ok(installed.textContent.includes("/p/.claude/settings.json"), "行上写着这份机制是哪个文件");
  rowButton(installed, "Uninstall");
  assert.equal(findRowButton(installed, "Install"), undefined, "装着的行不给第二颗「安装」");
  fire(rowButton(installed, "View Generated Config"));
  assert.deepEqual(lastPosted(rendered, "action"), { type: "action", action: "hookPlan", agent: "claude", scope: "project" });
  fire(rowButton(installed, "Uninstall"));
  assert.deepEqual(lastPosted(rendered, "action"), { type: "action", action: "hookUninstall", agent: "claude", scope: "project" });

  const missing = hookRow(rendered, "Codex");
  assert.ok(missing.textContent.includes("Not installed"));
  assert.ok(missing.textContent.includes("Codex only runs a hook you have reviewed."), "机制自己带的条件就在这一行上，不让用户去别处找");
  fire(rowButton(missing, "Install"));
  assert.deepEqual(lastPosted(rendered, "action"), { type: "action", action: "hookInstall", agent: "codex", scope: "project" });

  // 不支持的行：core 说的是哪一句就在行上，而且它一颗按钮都不给——一颗点下去什么都不会发生
  // 的按钮，和一颗坏掉的按钮，看起来是一样的。
  const unsupported = hookRow(rendered, "OpenCode");
  assert.ok(unsupported.textContent.includes("Unsupported by OpenCode 1.4.2"), "「不支持」是哪个版本不支持，说清楚");
  assert.deepEqual(unsupported.querySelectorAll("button"), [], "不支持的行没有可点的东西");
});

test("the command kind stays shut until Advanced, and the page reads core's threshold instead of its own", async () => {
  const rendered = await hooksPage();

  // Advanced 之前：那一颗是灰的，理由（会在这台机器上跑一个程序）就写在它下面。
  assert.equal(liveButton(rendered, "Command").disabled, true, "没开 Advanced 时命令类加不了");
  assert.ok(rendered.content.textContent.includes("A command notification runs a program on this machine every time a hook fires."), "灰着的那一颗必须把理由写出来");

  fire(liveButton(rendered, "Advanced"));
  assert.equal(liveButton(rendered, "Command").disabled, false, "开了 Advanced，命令类那一颗就可用");
  assert.ok(liveButton(rendered, "Advanced").className.includes("active"));
  fire(liveButton(rendered, "Command"));
  assert.deepEqual(lastPosted(rendered, "action"), { type: "action", action: "hookActionAdd", scope: "project", kind: "command" });

  // 别的三种一直在：它们不在 Advanced 后面。
  for (const label of ["Desktop notification", "OpenClaw gateway", "Webhook"]) {
    assert.equal(liveButton(rendered, label).disabled, false, `「${label}」不该被 Advanced 挡着`);
  }

  // 门槛只从载荷读：这一份给的是 42 秒 / 7 秒，页面要是自己记着 20，这两句就对不上。
  const foot = rendered.content.querySelectorAll(".foot-note").map((node) => node.textContent).join(" ");
  assert.ok(foot.includes("42s"), `页脚要说载荷里的那个门槛，实际是「${foot}」`);
  assert.ok(foot.includes("7s"), `页脚要说载荷里的那个去重窗口，实际是「${foot}」`);
  assert.equal(foot.includes("20s"), false, "页面不自己记 20 这个数");
});

test("a notification row names the entry and where its token comes from, never the token", async () => {
  const rendered = await hooksPage();

  const openclaw = hookRow(rendered, "http://127.0.0.1:18789/hooks/avenic");
  assert.ok(openclaw.textContent.includes("OpenClaw gateway"), "行上认得出这是哪一种通知");
  assert.ok(openclaw.textContent.includes("openclaw"), "行上有它的 id，改与删报的就是它");
  assert.ok(openclaw.textContent.includes("Token from OPENCLAW_HOOK_TOKEN"), "有令牌时说的是它从哪个变量取，而不是令牌");
  assert.equal(openclaw.textContent.includes("Token set"), false, "从变量取的那种不说「已设令牌」");

  const webhook = hookRow(rendered, "https://example.test/hook");
  assert.ok(webhook.textContent.includes("Webhook"));
  assert.ok(webhook.textContent.includes("Token set"), "存在文件里的那种说「已设令牌」");
  assert.ok(webhook.textContent.includes("30000 ms timeout"), "超时是行上的一个事实");

  // 出站消息逐字相等：页面把令牌回传进载荷的写法，会在这里多出一个字段。
  fire(rowButton(webhook, "Edit"));
  assert.deepEqual(lastPosted(rendered, "action"), { type: "action", action: "hookActionEdit", scope: "project", id: "webhook-release" });
  fire(rowButton(webhook, "Remove"));
  assert.deepEqual(lastPosted(rendered, "action"), { type: "action", action: "hookActionRemove", scope: "project", id: "webhook-release" });

  const empty = await hooksPage({ hooks: { ...HOOKS, actions: [] } });
  assert.ok(empty.content.textContent.includes("No notifications yet"), "一条都没有的时候这一页说一句话，而不是一张空卡");
});

test("a preview shows the lines the host computed, and the result of a write says what core said", async () => {
  const rendered = await hooksPage({
    hooksResult: { kind: "diff", agent: "claude", file: "/p/.claude/settings.json", lines: [{ kind: "add", text: '+  "hooks": {}' }, { kind: "remove", text: '-  "old": true' }] },
  });

  assert.ok(rendered.content.textContent.includes("What an install would change in /p/.claude/settings.json"), "预览说的是这份计划会改哪个文件");
  assert.deepEqual(rendered.content.querySelectorAll(".diff-line.diff-add").map((node) => node.textContent), ['+  "hooks": {}']);
  assert.deepEqual(rendered.content.querySelectorAll(".diff-line.diff-remove").map((node) => node.textContent), ['-  "old": true']);
  // 预览是加在这一页上的，不是替掉这一页：看完还得能装。
  assert.equal(rendered.content.querySelectorAll(".hook-row").length, HOOK_ACTIONS.length + HOOKS.agents.length, "预览不换掉下面的两张卡");

  // core 拒绝写的那一次（这一行画出来之后版本变了）：说的是 core 那句话，不是「本来就装着」。
  const refused = await hooksPage({
    hooksResult: { kind: "installed", agent: "codex", file: "/p/.codex/config.toml", changed: false, note: "Codex 0.9.8 no longer reads hooks." },
  });
  const line = refused.content.querySelectorAll(".hook-result")[0];
  assert.ok(line?.textContent.includes("Codex 0.9.8 no longer reads hooks."), "拒绝的那一次说 core 的理由");
  assert.equal(line?.textContent.includes("Already installed"), false, "「本来就装着」是另一件事，不能拿来顶替");
});

/* ------------------------------------------------------------ settings page -- */

test("Settings answers without a project open, and its rows hand back a key, not a path", async () => {
  const { source, sections } = await page();
  const rendered = renderDataMessage(await payload({
    project: { name: "", root: null, configured: false, lastUpdated: null },
    empty: "Open a project folder to see its Avenic state.",
    about: {
      rows: [
        { key: "extension", label: "Extension", value: "Avenic Agent Manager 0.6.0", reveal: false },
        { key: "cli", label: "Avenic CLI", value: "1.8.2", reveal: false },
        { key: "core", label: "Avenic core", value: "1.6.3", reveal: false },
        { key: "project", label: "Project root", value: "No project open", reveal: false },
        { key: "logs", label: "Logs", value: "Output panel → Avenic", reveal: false },
        { key: "storage", label: "Extension storage (this profile)", value: "/home/u/.vscode/avenic", reveal: true },
      ],
      settings: { label: "Open VS Code Settings" },
    },
  }), source, { seed: sidebar(sections) });
  openSection(rendered, "settings");

  const rows = rendered.content.querySelectorAll(".about-row");
  assert.equal(rows.length, 6, "每一行一个事实");
  assert.ok(rendered.content.textContent.includes("Avenic Agent Manager 0.6.0"), "扩展自己的版本在这一页上");
  assert.ok(rendered.content.textContent.includes("1.8.2"), "用的是哪一份 CLI 在这一页上");
  assert.ok(rendered.content.textContent.includes("Output panel → Avenic"), "日志去哪儿看是一个事实，不是一句「见文档」");

  // 「一个项目都没打开」拦不住这一页：它说的是这套安装本身。拦住了，用户在没有项目时
  // 连版本都问不出来。
  assert.deepEqual(rendered.content.querySelectorAll(".empty"), [], "没有项目时这一页仍然是这一页，不是「先打开一个文件夹」");
  assert.equal(rows.find((row) => row.textContent.includes("Extension storage"))?.querySelectorAll("button").length, 1, "路径真的在盘上的那一行才有一颗按钮");
  assert.equal(rows.find((row) => row.textContent.includes("Avenic CLI"))?.querySelectorAll("button").length, 0, "宿主说打不开的行没有按钮");

  const show = rows.find((row) => row.textContent.includes("Extension storage"))!.querySelectorAll("button")[0];
  fire(show);
  // 页面手里没有路径，也不该有：它递回的是那一行的 key，路径由宿主解析。
  assert.deepEqual(lastPosted(rendered, "action"), { type: "action", action: "revealFile", key: "storage" });
  assert.equal(allText(rendered).includes("/home/u/.vscode/avenic"), true, "行上写着那条路径");

  fire(liveButton(rendered, "Open VS Code Settings"));
  assert.deepEqual(lastPosted(rendered, "action"), { type: "action", action: "openSettings" }, "唯一一条离开这一页的行");
});

