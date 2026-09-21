import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { fire, lastPosted, renderDataMessage, type Rendered, type StubDocument, type StubNode } from "./fixtures/dom-stub.ts";

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

const TRANSCRIPT = {
  id: "s-fix-auth-env",
  title: "Fix authentication environment handling",
  active: false,
  turns: [{ role: "user", text: "Why does the token expire early?" }],
};

test("a View All link turns the page itself, and tells the host where it went", async () => {
  const { source, sections } = await page();
  const rendered = renderDataMessage(await payload({ transcript: TRANSCRIPT }), source, { seed: sidebar(sections) });
  assert.deepEqual(activeSections(rendered), ["overview"], "初帧停在概览");

  fire(button(rendered, "View All Shared Sessions (12)"));
  assert.deepEqual(activeSections(rendered), ["sessions"], "链接自己就该翻到那一页，而不是只发一条消息");
  assert.equal(rendered.content.querySelectorAll(".transcript").length, 1, "翻过去之后看到的是那一页的内容");
  assert.deepEqual(lastPosted(rendered, "navigate"), { type: "navigate", section: "sessions" }, "同时把落点告诉宿主，下一次推送才不会把页面拽回去");
});

test("skipping to a section from the sidebar tells the host the same thing", async () => {
  const { source, sections } = await page();
  const rendered = renderDataMessage(await payload(), source, { seed: sidebar(sections) });

  const skills = rendered.byId.get("nav")?.querySelectorAll(".nav-item[data-section]")[4];
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
