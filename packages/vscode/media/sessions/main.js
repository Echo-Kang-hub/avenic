// Avenic Sessions webview：把 host 发来的一份共享对话画成时间线。
// 这一屏画的就是 `avenic sessions show <id>` 画的东西，用的是同一个模型
// （core 的 readTranscript → 与 CLI --json 逐字段相同的 transcript 模型），
// 所以面板与终端不会各说各话。
//
// 安全（同 dashboard/model 两页）：一切用户可影响字符串（会话标题、turn 正文、
// 工具参数、错误消息）只经 createElement + textContent 渲染——页面上没有任何
// 一条路径把字符串当 HTML 写进 DOM。
// 数据通路：只消费 { type: "data" | "error" }，只发送 ready / refresh / select / limit。
"use strict";

const vscode = acquireVsCodeApi();
const app = document.getElementById("app");

const state = { loading: true, error: null, data: null };
let transcriptPane = null;

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// 时间戳的切片与 CLI 的 printTranscript 逐字相同（"2026-09-19T10:02:11.000Z" →
// "2026-09-19 10:02"，或轮内的 "10:02"）：同一件事在终端与面板上长得一样。
function stamp(value) {
  if (!value) return "";
  return String(value).replace("T", " ").slice(0, 16);
}
function clock(value) {
  if (!value) return "";
  return String(value).slice(11, 16);
}

function topbar() {
  const bar = el("header", undefined, "topbar");
  const brand = el("div", undefined, "brand");
  brand.append(el("h1", "AVENIC"));
  const cursor = el("span", undefined, "cursor");
  cursor.setAttribute("aria-hidden", "true");
  brand.append(cursor);
  bar.append(brand);
  const refresh = el("button", "Refresh", "icon-button");
  refresh.setAttribute("type", "button");
  refresh.addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
  bar.append(refresh);
  return bar;
}

// 提示符行：这一屏对应的那条命令（读者可以照抄到终端里，看到同一份对话）。
function promptLine(text) {
  const line = el("p", undefined, "prompt-line");
  line.append(el("span", "$ ", "dollar"), el("span", text, "cmd"));
  return line;
}

/** 一条「标签  值」的信息行；content 可以是字符串或节点数组（值里带状态词时用后者）。 */
function field(label, content) {
  const line = el("p", undefined, "field");
  line.append(el("span", label, "field-label"));
  if (Array.isArray(content)) line.append(...content);
  else line.append(el("span", content));
  return line;
}

function toolLine(tool) {
  const mark = tool.kind === "result" ? "←" : "→";
  return el("p", `${mark}  [${tool.name}]${tool.detail ? ` ${tool.detail}` : ""}`, "tool");
}

// 一轮 = 一个人说的话，或一个代理说的话。工具流量挂在这一轮下面，不单独占一个说话人。
function turnBlock(turn) {
  const block = el("div", undefined, turn.kind === "user" ? "turn user" : "turn agent");
  const body = el("div", undefined, "turn-body");
  const head = el("p");
  // 说话人标签就是来源：人 = 绿（You），代理 = 青（代理解析出来的名字）。
  head.append(el("span", turn.speaker, turn.kind === "user" ? "chip you" : "chip agent"));
  if (turn.at) head.append(el("span", clock(turn.at), "at"));
  if (turn.model) head.append(el("span", turn.model, "model"));
  body.append(head);
  if (turn.text) body.append(el("p", turn.text, "turn-text"));
  for (const tool of turn.tools) body.append(toolLine(tool));
  block.append(body);
  return block;
}

function sessionRow(row, currentId, activeId) {
  const selected = row.id === currentId;
  const active = row.id === activeId;
  const button = el("button", undefined, `session-row${selected ? " selected" : ""}${active ? " active" : ""}`);
  button.setAttribute("type", "button");
  button.setAttribute("title", row.id);
  // 游标 ▸ = 正在读的这一条；◉/○ = 新启动是否加入它（与 CLI 的列表同一个意思）。
  button.append(el("span", selected ? "▸" : " ", "cursor-mark"));
  button.append(el("span", active ? "◉" : "○", "active-mark"));
  button.append(el("span", row.title, "row-title"));
  const meta = [`${row.events} events`];
  if (row.updatedAt) meta.push(stamp(row.updatedAt));
  button.append(el("span", meta.join("  ·  "), "row-meta"));
  button.append(el("span", row.id, "row-id"));
  button.addEventListener("click", () => vscode.postMessage({ type: "select", id: row.id }));
  return button;
}

function rail(data) {
  const box = el("nav", undefined, "rail");
  const head = el("div", undefined, "list-head");
  head.append(el("h2", "Sessions", "section-title"), el("span", String(data.sessions.length), "count"));
  box.append(head);
  for (const row of data.sessions) {
    box.append(sessionRow(row, data.transcript === null ? null : data.transcript.session.id, data.activeId));
  }
  return box;
}

function emptyState(data) {
  const box = el("div", undefined, "empty");
  if (data.projectRoot === null) {
    box.append(el("p", "Open a project folder to read its shared sessions.", "hint"));
  } else if (data.sessions.length === 0) {
    // 与 CLI 同一句话：没有共享会话时该做什么是 core 的说法，不是面板另写一句。
    box.append(el("p", "No canonical sessions are available yet. Import histories or switch to Shared mode.", "hint"));
  } else {
    box.append(el("p", "Select a session to read its conversation.", "hint"));
  }
  return box;
}

function transcriptSection(data) {
  const pane = el("section", undefined, "transcript");
  const transcript = data.transcript;
  if (transcript === null) {
    pane.append(emptyState(data));
    return pane;
  }
  const session = transcript.session;
  pane.append(el("h2", `Session ${session.title}`, "page-title"));
  pane.append(el("p", `${session.id}  ·  ${session.events} events  ·  ${session.turns} turns`, "page-desc"));
  pane.append(field("Recorded", session.startedAt ? `${stamp(session.startedAt)} → ${stamp(session.endedAt)}` : "unknown"));
  pane.append(field("Agents", data.participants.length > 0 ? data.participants.join(", ") : "none"));
  // 每个代理从哪条原生会话回答、游标是否跟上了共享历史（core 判定的三个词）。
  for (const projection of session.projections) {
    pane.append(field(projection.label, [
      el("span", projection.nativeSessionId),
      el("span", "  "),
      el("span", projection.state, `state-${projection.state}`),
    ]));
  }
  if (transcript.turns.length === 0) {
    pane.append(el("p", "This session has no recorded turns yet.", "note"));
    return pane;
  }
  // 长对话默认只画最新的一段：缺了多少轮明说，并把「全部展开」放在同一处。
  const missing = session.turns - transcript.turns.length;
  if (missing > 0) {
    pane.append(el("p", `${missing} earlier turn(s) not shown`, "note"));
    const showAll = el("button", "Show every turn", "button");
    showAll.setAttribute("type", "button");
    showAll.addEventListener("click", () => vscode.postMessage({ type: "limit", limit: 0 }));
    pane.append(showAll);
  }
  pane.append(el("h3", "Conversation", "section-title"));
  for (const turn of transcript.turns) pane.append(turnBlock(turn));
  return pane;
}

function renderLoading() {
  const box = el("div", undefined, "state state-loading");
  box.append(el("p", "Reading the shared sessions…"));
  app.replaceChildren(topbar(), box);
}

function renderError(message) {
  const box = el("div", undefined, "state state-error");
  box.append(el("p", "Could not read the shared sessions:"), el("p", message, "error-message"));
  const retry = el("button", "Retry", "button");
  retry.setAttribute("type", "button");
  retry.addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
  box.append(retry);
  app.replaceChildren(topbar(), box);
}

function renderData(data) {
  transcriptPane = null;
  const selected = data.transcript === null ? null : data.transcript.session.id;
  const command = selected === null ? "avenic sessions list" : `avenic sessions show ${selected}`;
  const pages = [topbar(), promptLine(command)];
  if (data.sessions.length === 0) {
    pages.push(emptyState(data));
    app.replaceChildren(...pages);
    return;
  }
  const layout = el("div", undefined, "layout");
  const pane = transcriptSection(data);
  transcriptPane = pane;
  layout.append(rail(data), pane);
  pages.push(layout);
  app.replaceChildren(...pages);
  scrollToNewest();
}

// 最新的一轮就在手边：打开一屏对话时停在尾部（终端里也是最后一行最新）。
function scrollToNewest() {
  const pane = transcriptPane;
  if (pane && typeof pane.scrollTo === "function") pane.scrollTo(0, pane.scrollHeight);
}

function render() {
  if (state.loading) return renderLoading();
  if (state.error !== null) return renderError(state.error);
  if (state.data !== null) return renderData(state.data);
  renderLoading();
}

window.addEventListener("message", (event) => {
  const message = event.data;
  if (message === null || typeof message !== "object") return;
  if (message.type === "data") {
    state.loading = false;
    state.error = null;
    state.data = message.payload;
    render();
  } else if (message.type === "error") {
    state.loading = false;
    state.error = message.message;
    render();
  }
});

render();
// 脚本就绪即宣告：resolver 期间的早期发送会被丢弃，ready 后 host 补发一轮
vscode.postMessage({ type: "ready" });
