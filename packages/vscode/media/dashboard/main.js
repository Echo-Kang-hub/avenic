// Avenic Dashboard webview 控制器（T11 视觉层：三态 + 卡片 + 快捷动作）。
// 安全铁律（设计 §4 / 规则 R3）：一切用户可影响字符串（项目路径、状态文本、Skill 名、
// revision、错误消息）只经 createElement + textContent 渲染；任何代码路径都不赋值 innerHTML。
// 数据通路（T10 SenderMessage）：只消费 { type: "data" | "error" }，其余消息忽略。
"use strict";

const vscode = acquireVsCodeApi();
const app = document.getElementById("app");

const state = { loading: true, error: null, data: null };

// ---- 快捷动作（白名单，见 src/dashboard/protocol.ts）----
// 点击向 host 转发 { type: "command" }；所涉命令均有无参数 QuickPick 回退，无需携带参数。
const ACTIONS = [
  { command: "catalog.sync", label: "同步 Hub", iconName: "sync" },
  { command: "skills.installPacks", label: "安装 Packs", iconName: "package" },
  { command: "skills.addDirect", label: "添加直装 Skill", iconName: "plus" },
  { command: "agents.init", label: "初始化 Agent", iconName: "robot" },
  { command: "agents.sessionsImport", label: "导入会话", iconName: "import" },
  // 模型配置（设计 §9.1 的第三个入口）：本机配置库是设备级的，未打开项目也能进。
  { command: "model.open", label: "模型配置", iconName: "settings-gear" },
];
// 依赖项目上下文的操作：未打开项目时置灰，避免点了才报错。
const PROJECT_SCOPED = new Set([
  "skills.installPacks",
  "skills.addDirect",
  "agents.init",
  "agents.sessionsImport",
]);

/** 安全的元素构造：文本只经 textContent 写入。 */
function el(tag, text, className) {
  const node = document.createElement(tag);
  if (className !== undefined) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Codicon 图标（规则 R1）：本地随包 codicon 字体（style.css @font-face），data-icon 名称 → 字形映射在 style.css。 */
function icon(name, extraClass) {
  const node = el("span", undefined, extraClass ? "icon " + extraClass : "icon");
  node.setAttribute("data-icon", name);
  node.setAttribute("aria-hidden", "true");
  return node;
}

const ICON_BY_HINT = { "pass-filled": "pass-filled", "circle-outline": "circle-outline" };
function hintIconName(hint) {
  return ICON_BY_HINT[hint] ?? "circle-outline";
}

// ---- Agent 品牌标记（单色 inline SVG，currentColor，无远程资产） ----
// 规则 R1（无远程）：纯 DOM 构建（createElementNS），不经 innerHTML；
// 规则 R3（文本安全）：不存在文本内容。品牌形状取自官方标记的路径数据：
// claude=八向星芒（示意）、codex=六边形环结+水平短杠（OpenAI Codex 官方标记，
// 数据取自 LobeHub 官方静态图标库 codex.svg）、opencode=方框回字形（SST
// opencode 官方「回字方框 O」标记，方框+偏下内块）。窗格横向压缩到最终态时
// （容器查询 ≤180px，见 style.css），agent 行文字全部隐藏，只剩「品牌图标 + 状态点」。
const SVG_NS = "http://www.w3.org/2000/svg";
function svgNode(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}
// OpenAI Codex 官方标记（24×24，fill-rule=evenodd，单 path）
const CODEX_D = "M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z";
function agentMark(agentId) {
  const svg = svgNode("svg", { viewBox: "0 0 24 24", class: "agent-mark" });
  svg.setAttribute("aria-hidden", "true");
  if (agentId === "claude") {
    // 星芒：八向光线（claude code 风格标记）；viewBox 沿用 16×16
    svg.setAttribute("viewBox", "0 0 16 16");
    const path = svgNode("path", { d: "M8 1.5v13M1.5 8h13M3.4 3.4l9.2 9.2M12.6 3.4L3.4 12.6", fill: "none", stroke: "currentColor" });
    path.setAttribute("stroke-width", "1.8");
    path.setAttribute("stroke-linecap", "round");
    svg.append(path);
  } else if (agentId === "codex") {
    // 六边形环结 + 水平短杠（OpenAI Codex 官方标记，单色 currentColor）
    const path = svgNode("path", { d: CODEX_D, fill: "currentColor" });
    path.setAttribute("fill-rule", "evenodd");
    svg.append(path);
  } else {
    // 回字方框 O：外框镂空 + 偏下内块（opencode 官方标记；内块半透明）
    const frame = svgNode("path", { d: "M2 2h20v20H2V2zm5 5h10v10H7V7z", fill: "currentColor" });
    frame.setAttribute("fill-rule", "evenodd");
    svg.append(frame);
    const inner = svgNode("rect", { x: "7", y: "12", width: "10", height: "5", fill: "currentColor" });
    inner.setAttribute("opacity", "0.4");
    svg.append(inner);
  }
  return svg;
}

// ---- 三态：loading / error / empty-friendly data ----

function renderLoading() {
  const box = el("div", undefined, "state state-loading");
  box.append(icon("refresh", "spin"), el("p", "加载中…"));
  app.replaceChildren(box);
}

function renderError(message) {
  const box = el("div", undefined, "state state-error");
  box.append(
    icon("error"),
    el("p", "加载失败："),
    el("p", message, "error-message"),
    el("p", "请检查「Avenic 输出」面板确认原因，或点击下方按钮重试。", "hint"),
  );
  const retry = el("button", "重试", "button");
  retry.addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
  box.append(retry);
  app.replaceChildren(box);
}

function topbar() {
  const bar = el("header", undefined, "topbar");
  const brand = el("div", undefined, "brand");
  brand.append(el("h1", "AVENIC"));
  const cursor = el("span", undefined, "cursor");
  cursor.setAttribute("aria-hidden", "true");
  brand.append(cursor);
  bar.append(brand);
  const refresh = el("button", undefined, "icon-button");
  refresh.setAttribute("title", "刷新");
  refresh.setAttribute("aria-label", "刷新");
  refresh.append(icon("refresh"));
  refresh.addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
  bar.append(refresh);
  return bar;
}

/** 终端提示符行：$ avenic status（文本安全，仅 textContent 组装）。 */
function promptLine() {
  const line = el("p", undefined, "prompt-line");
  line.append(el("span", "$ ", "dollar"), el("span", "avenic status", "cmd"));
  return line;
}

/** 顶部信息卡片（项目 / Hub），空态友好：null 值渲染占位文本 + 提示行。 */
function infoCard(headIcon, title, valueText, metaText, hintText) {
  const card = el("section", undefined, "card");
  const head = el("header", undefined, "card-head");
  head.append(icon(headIcon), el("h3", title));
  card.append(head);
  card.append(el("p", valueText, "value"));
  if (metaText !== undefined) card.append(el("p", metaText, "meta"));
  if (hintText !== undefined) card.append(el("p", hintText, "hint"));
  return card;
}

// 区块标题为终端注释行「# 标题」（# 前缀由 CSS ::before 渲染）：不加图标，让标题本身安静
function blockTitle(title, count) {
  const box = el("div", undefined, "block-title");
  box.append(el("h2", title));
  if (count !== undefined) box.append(el("span", String(count), "count"));
  return box;
}

// sync 是 core 状态模型的六个词之一（none / current / stale / missing / running / dirty）。
// 只有 current 是安静态：其余都是「有事情可做」，用终端告警色标出来。
function syncChip(sync) {
  const quiet = sync === "current" || sync === "none";
  const chip = el("span", sync, quiet ? "sync-chip" : "sync-chip warn");
  chip.setAttribute("data-sync", sync);
  return chip;
}

function agentCard(a) {
  const card = el("div", undefined, "card agent-card");
  // 悬停 tooltip：压缩态（图标化）下唯一的信息来源
  card.title = `${a.label} · ${a.statusText} · ${a.executableAvailable ? "可执行文件就绪" : "可执行文件缺失"}`;
  const head = el("div", undefined, "agent-head");
  head.append(agentMark(a.id));
  head.append(icon(hintIconName(a.iconHint)));
  head.append(el("span", a.label, "agent-name"));
  if (typeof a.sync === "string" && a.sync !== "none") head.append(syncChip(a.sync));
  card.append(head);
  card.append(el("p", a.statusText, "agent-status"));
  card.append(el("p", a.executableAvailable ? "可执行文件就绪" : "可执行文件缺失", "agent-meta"));
  return card;
}

function agentsBlock(agents) {
  const box = el("section", undefined, "block");
  box.append(blockTitle("Agents", agents.length));
  const grid = el("div", undefined, "agent-grid");
  for (const a of agents) grid.append(agentCard(a));
  box.append(grid);
  return box;
}

function skillsBlock(rows) {
  const box = el("section", undefined, "block");
  box.append(blockTitle("Skills 健康"));
  const list = el("div", undefined, "skill-rows");
  if (rows.length === 0) {
    list.append(el("p", "暂无 Skills 数据。", "hint"));
  } else {
    for (const s of rows) {
      const row = el("div", undefined, "skill-row");
      // 终端标记 [✓]/[✗]：颜色走 terminal-ansi 变量，仅 textContent 渲染
      row.append(el("span", s.ok ? "[OK]" : "[!!]", "mark " + (s.ok ? "ok" : "bad")));
      row.append(el("span", s.label, "skill-label"));
      row.append(el("span", s.details, "skill-details"));
      list.append(row);
    }
  }
  box.append(list);
  return box;
}

function actionsBlock(projectOpen) {
  const box = el("section", undefined, "block quick-actions");
  box.append(blockTitle("快捷操作"));
  const grid = el("div", undefined, "action-grid");
  for (const a of ACTIONS) {
    const button = el("button", undefined, "button action-button");
    button.append(icon(a.iconName), el("span", a.label));
    if (PROJECT_SCOPED.has(a.command) && !projectOpen) {
      button.disabled = true;
      button.title = "未打开项目";
    }
    button.setAttribute("aria-label", a.label);
    button.addEventListener("click", () => vscode.postMessage({ type: "command", command: a.command }));
    grid.append(button);
  }
  box.append(grid);
  return box;
}

function renderData(data) {
  const pages = [topbar(), promptLine()];

  // 顶部状态行：项目 + Hub（未打开项目 → “未打开项目”+ 提示；未选 Hub → 同理）
  const grid = el("section", undefined, "status-grid");
  const projectHint = data.projectRoot === null
    ? "打开项目后将自动加载 Agents 与 Skills 状态。"
    : undefined;
  grid.append(infoCard("folder-opened", "项目", data.projectRoot ?? "未打开项目", undefined, projectHint));
  // 未打开项目时不读 Hub（它随项目锁定文件一起报）；打开后自动补上，提示行说明这一点。
  const catalogHint = data.catalog === null
    ? "打开项目后读取 Hub 状态，或直接点击下方「同步 Hub」。"
    : undefined;
  grid.append(infoCard(
    "repo", "Hub",
    data.catalog?.spec ?? "未打开项目",
    // 短修订（与 `avenic status` 的 Hub 行同样的 8 位）：完整 sha 在卡片里只会被省略号截掉
    data.catalog === null ? undefined : "修订：" + String(data.catalog.revision).slice(0, 8),
    catalogHint,
  ));
  // 共享历史（core 状态模型的 history 块）：与 `avenic status` 的 History 段同源。
  const history = data.history;
  grid.append(infoCard(
    "history", "共享历史",
    history === null ? "未打开项目" : `${history.mode} · ${history.sessions} 条会话`,
    history === null || history.activeTitle === null ? undefined : "活动：" + history.activeTitle,
    history !== null && history.sessions === 0 ? "还没有共享会话；启动一次 Agent 即会记录。" : undefined,
  ));
  pages.push(grid);

  pages.push(agentsBlock(data.agents), skillsBlock(data.skillsHealth), actionsBlock(data.projectRoot !== null));
  app.replaceChildren(...pages);
}

function render() {
  if (state.loading) return renderLoading();
  if (state.error !== null) return renderError(state.error);
  if (state.data !== null) return renderData(state.data);
  renderLoading();
}

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (msg === null || typeof msg !== "object") return;
  if (msg.type === "data") {
    state.loading = false;
    state.error = null;
    state.data = msg.payload;
    render();
  } else if (msg.type === "error") {
    state.loading = false;
    state.error = msg.message;
    render();
  }
});

render();
// 脚本就绪即宣告：provider 对 resolver 期间的早期发送会被丢弃，ready 后补发一轮
vscode.postMessage({ type: "ready" });
