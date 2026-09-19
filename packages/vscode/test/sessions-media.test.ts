import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildSessionsData } from "../src/sessions/state.ts";
import type { SessionsData } from "../src/sessions/protocol.ts";
import { allText, fire, lastPosted, plain, renderDataMessage, type Rendered, type StubNode } from "./fixtures/dom-stub.ts";
import { OLDER_ID, seedTranscriptProject } from "./fixtures/transcript-project.ts";

// The Sessions page, executed. The payload is not a hand-written object: it is
// what the real host builder (buildSessionsData → core → the CLI's JSON shape)
// produces for a fictional shared conversation, so these tests cover the whole
// path the extension takes from the store to the pixels.

const mediaRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "media", "sessions");
// ESC：终端转义序列的起始字符。写成 fromCharCode，源码里就不该出现真正的控制字符。
const ESCAPE = String.fromCharCode(27);

async function mediaSource(name: string): Promise<string> {
  return readFile(path.join(mediaRoot, name), "utf8");
}

async function withProject(run: (projectRoot: string) => Promise<void>): Promise<void> {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "avenic-sessions-page-"));
  try {
    await seedTranscriptProject(projectRoot);
    await run(projectRoot);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
}

/** 挂载树里的全部节点（面板 replaceChildren 之后的**当前**界面，不含游离节点）。 */
function mounted(rendered: Rendered): StubNode[] {
  const root = rendered.byId.get("app");
  if (root === undefined) return [];
  const found: StubNode[] = [];
  const walk = (node: StubNode): void => {
    for (const child of node.children) {
      found.push(child);
      walk(child);
    }
  };
  walk(root);
  return found;
}

function nodes(rendered: Rendered, matches: (node: StubNode) => boolean): StubNode[] {
  return mounted(rendered).filter(matches);
}

function descendants(node: StubNode): StubNode[] {
  const found: StubNode[] = [];
  const walk = (current: StubNode): void => {
    for (const child of current.children) {
      found.push(child);
      walk(child);
    }
  };
  walk(node);
  return found;
}

/** 一轮对话块（按说话人标签找）。 */
function turnBlock(rendered: Rendered, speaker: string): StubNode | undefined {
  return nodes(rendered, (node) => /(^|\s)turn(\s|$)/.test(node.className)
    && descendants(node).some((child) => child.className.startsWith("chip ") && child.textContent === speaker))[0];
}

/** 这一轮里出现的全部文本（说话人标签、时间戳、模型、正文、工具行）。 */
function turnText(rendered: Rendered, speaker: string): string {
  const block = turnBlock(rendered, speaker);
  assert.ok(block, `没有找到 ${speaker} 的一轮`);
  return descendants(block).map((child) => child.textContent).join("\n");
}

/** 一条信息行的值（标签与值是两个 span，桩的文本日志会按行分开，所以按节点读）。 */
function fieldValue(rendered: Rendered, label: string): string {
  const row = nodes(rendered, (node) => node.className === "field"
    && node.children.some((child) => child.className === "field-label" && child.textContent === label))[0];
  assert.ok(row, `没有找到信息行 ${label}`);
  return row.children.slice(1).map((child) => child.textContent).join("");
}

function rowButton(rendered: Rendered, title: string): StubNode | undefined {
  return nodes(rendered, (node) => node.tagName === "BUTTON"
    && node.children.some((child) => child.className === "row-title" && child.textContent === title))[0];
}

test("view.html carries the CSP placeholders and no remote resources", async () => {
  const html = await mediaSource("view.html");
  assert.match(html, /\{\{nonce\}\}/);
  assert.match(html, /\{\{cspSource\}\}/);
  assert.match(html, /\{\{mainJs\}\}/);
  assert.match(html, /\{\{style\}\}/);
  assert.match(html, /content-security-policy/i);
  assert.equal(/https?:\/\//.test(html.replaceAll("{{cspSource}}", "")), false);
});

test("the page never assigns user data through innerHTML, and carries no terminal escapes", async () => {
  const script = await mediaSource("main.js");
  assert.equal(script.includes("innerHTML"), false);
  assert.equal(script.includes(ESCAPE), false, "颜色是 CSS 的事，脚本里不该有转义序列");
  assert.match(script, /acquireVsCodeApi/);
  assert.match(script, /textContent/);
  assert.equal(/https?:\/\//.test(script), false);
});

test("the page uses the product's colour roles, and refuses to scroll sideways", async () => {
  const style = await mediaSource("style.css");
  assert.match(style, /--vscode-/);
  assert.equal(style.includes(ESCAPE), false);
  assert.equal(/https?:\/\//.test(style), false);
  // 与 CLI 调色板同一套角色：品牌红橙（--avenic-brand*）、成功绿、警告黄、错误红、
  // 次要灰（descriptionForeground）。绿色只表示「成功/当前」，不参与品牌。
  for (const role of ["--avenic-brand", "--avenic-brand-strong", "--vscode-terminal-ansiGreen", "--vscode-terminal-ansiYellow", "--vscode-terminal-ansiRed", "--vscode-descriptionForeground"]) {
    assert.ok(style.includes(role), `缺少配色角色 ${role}`);
  }
  assert.equal(style.includes("--vscode-terminal-ansiCyan"), false, "品牌不再是青色");
  // 长对话只能竖着读：横向裁掉，正文换行（overflow-wrap:anywhere 处理长路径/长单词）。
  assert.match(style, /overflow-x:\s*hidden/);
  assert.match(style, /overflow-wrap:\s*anywhere/);
  assert.match(style, /white-space:\s*pre-wrap/);
});

test("the page draws the shared timeline with each turn's own speaker", async () => {
  await withProject(async (projectRoot) => {
    const data = await buildSessionsData(projectRoot);
    const rendered = renderDataMessage(data, await mediaSource("main.js"));
    const text = allText(rendered);

    // 来源：说话人标签就是代理名（人是 You）。Codex 那一轮属于 Codex，不属于用户。
    assert.deepEqual(nodes(rendered, (node) => node.className === "chip you").map((node) => node.textContent), ["You"]);
    assert.deepEqual(nodes(rendered, (node) => node.className === "chip agent").map((node) => node.textContent), ["Claude", "Codex"]);
    assert.match(turnText(rendered, "Codex"), /Indexed the ledger once before the loop/);
    assert.match(turnText(rendered, "Codex"), /gpt-5-codex/);
    assert.doesNotMatch(turnText(rendered, "Claude"), /Indexed the ledger once/, "外来的回答不得混进上一轮");
    // 工具流量是这一轮下的暗色一行，格式与 CLI 相同（→ 调用 / ← 结果）。
    assert.match(text, /→ {2}\[Read\] src\/exporter\.ts/);
    assert.match(text, /← {2}\[result\] exportLedger\(accounts\): reads ledger\.tsv per account/);
    // 轮内时间戳是 CLI 打印的那个切片。
    assert.match(turnText(rendered, "You"), /^09:00$/m);
    assert.equal(text.includes(ESCAPE), false, "画到界面上的文本不得含转义序列");
  });
});

test("the summary row names the session, its counts, and each agent's cursor", async () => {
  await withProject(async (projectRoot) => {
    const rendered = renderDataMessage(await buildSessionsData(projectRoot), await mediaSource("main.js"));
    const text = allText(rendered);
    assert.match(text, /Session Nightly export/);
    assert.match(text, /handoff {2}· {2}4 events {2}· {2}3 turns/);
    assert.equal(fieldValue(rendered, "Recorded"), "2026-09-19 09:00 → 2026-09-19 09:05");
    assert.equal(fieldValue(rendered, "Agents"), "Claude, Codex");
    // 每个代理从哪条原生会话回答、游标是 current 还是 stale —— 用 core 的词，不另写一套。
    assert.equal(fieldValue(rendered, "Claude"), "session-a  stale");
    assert.equal(fieldValue(rendered, "Codex"), "session-b  current");
    const stale = nodes(rendered, (node) => node.className === "state-stale");
    const current = nodes(rendered, (node) => node.className === "state-current");
    assert.deepEqual(stale.map((node) => node.textContent), ["stale"]);
    assert.deepEqual(current.map((node) => node.textContent), ["current"]);
  });
});

test("the session list marks what you are reading and what new launches would join", async () => {
  await withProject(async (projectRoot) => {
    const rendered = renderDataMessage(await buildSessionsData(projectRoot), await mediaSource("main.js"));
    const shared = rowButton(rendered, "Nightly export");
    const older = rowButton(rendered, "Report cleanup");
    assert.ok(shared && older, "两条会话都要在列表里");
    assert.match(shared.className, /selected/, "正在读的那条带游标");
    assert.match(shared.className, /active/, "活动会话（新启动会加入它）单独标出");
    assert.doesNotMatch(older.className, /selected|active/);
    assert.equal(shared.children.some((child) => child.textContent === "◉"), true);
    assert.equal(older.children.some((child) => child.textContent === "○"), true);
    assert.equal(shared.children.some((child) => child.className === "row-meta" && /4 events/.test(child.textContent)), true);

    // 点另一条 → 只发一个 select（id 是 core 的会话 id，不是路径）。
    const before = rendered.posted.length;
    fire(older);
    const sent = plain(rendered.posted.slice(before));
    assert.deepEqual(sent, [{ type: "select", id: OLDER_ID }]);
  });
});

test("a long conversation says what is missing and offers the whole thing", async () => {
  await withProject(async (projectRoot) => {
    const limited = await buildSessionsData(projectRoot, { limit: 2 });
    const rendered = renderDataMessage(limited, await mediaSource("main.js"));
    assert.match(allText(rendered), /1 earlier turn\(s\) not shown/);
    const showAll = nodes(rendered, (node) => node.tagName === "BUTTON" && node.textContent === "Show every turn")[0];
    assert.ok(showAll, "缺轮数旁边必须有「全部展开」");
    const before = rendered.posted.length;
    fire(showAll);
    assert.deepEqual(plain(rendered.posted.slice(before)), [{ type: "limit", limit: 0 }]);
    // 全部展开时不出现「有轮次未显示」这句话。
    const full = renderDataMessage(await buildSessionsData(projectRoot, { limit: 0 }), await mediaSource("main.js"));
    assert.doesNotMatch(allText(full), /not shown/);
  });
});

test("picking another session redraws that one, including an empty conversation", async () => {
  await withProject(async (projectRoot) => {
    const data = await buildSessionsData(projectRoot);
    const rendered = renderDataMessage(data, await mediaSource("main.js"));
    rendered.send({ type: "data", payload: await buildSessionsData(projectRoot, { id: OLDER_ID }) });
    assert.match(allText(rendered), /Session Report cleanup/);
    assert.match(allText(rendered), /This session has no recorded turns yet\./);
    assert.equal(rowButton(rendered, "Report cleanup")?.className.includes("selected"), true);
  });
});

test("empty states say what to do next, in core's words", async () => {
  const source = await mediaSource("main.js");
  const noProject: SessionsData = { projectRoot: null, activeId: null, sessions: [], participants: [], transcript: null };
  assert.match(allText(renderDataMessage(noProject, source)), /Open a project folder to read its shared sessions\./);
  const noSessions: SessionsData = { projectRoot: "/repo/proj-a", activeId: null, sessions: [], participants: [], transcript: null };
  assert.match(allText(renderDataMessage(noSessions, source)), /No canonical sessions are available yet\. Import histories or switch to Shared mode\./);
  // 错误态：把 host 的错误消息原样贴出来，并给一个重试按钮。
  const rendered = renderDataMessage(noProject, source);
  rendered.send({ type: "error", message: "Unknown canonical session: gone" });
  assert.match(allText(rendered), /Unknown canonical session: gone/);
  const retry = nodes(rendered, (node) => node.tagName === "BUTTON" && node.textContent === "Retry")[0];
  assert.ok(retry, "错误态必须有重试");
  fire(retry);
  assert.deepEqual(lastPosted(rendered, "refresh"), { type: "refresh" });
});
