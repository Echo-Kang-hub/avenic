// Avenic dashboard renderer.
//
// Security rules (unchanged from the previous webview, see SEC-001):
//   * every user-influenced string (paths, session titles, skill names, errors)
//     is written through createElement + textContent — never innerHTML;
//   * outgoing messages carry a validated action name and at most an agent id
//     or a session id, both matched against the host's allowlist;
//   * no remote asset is ever loaded; the only image is the packaged brand mark.
//
// The shell (sidebar, nav, header placeholders) is static HTML, so the first
// paint never waits for data; this script only fills it in.
"use strict";

(function () {
  const vscode = acquireVsCodeApi();

  // 页面上每一个字都来自宿主注入的同一张表（`{{text}}` 那个 script）。英文是主标签，
  // 中文是它的另一半：英文界面里中文待在 tooltip 和 aria 里，中文界面里它才浮出来
  // 变成可见的第二行。表里没有的键不猜，直接把键名写出来——屏幕上一个 nav.sesions
  // 比一句没人写过的中文更容易被看见、被修掉。它排在最前面，因为下面每一句都要用它。
  const AVENIC_TEXT = globalThis.AVENIC_TEXT ?? {};
  const TEXT = AVENIC_TEXT.text ?? {};
  const ZH_VISIBLE = AVENIC_TEXT.zhVisible === true;
  const T = (key) => TEXT[key]?.en ?? key;
  const ZH = (key) => TEXT[key]?.zh ?? "";
  const PAIR = (key) => (ZH(key) ? `${T(key)} / ${ZH(key)}` : T(key));
  const TF = (key, values) => Object.entries(values).reduce((sentence, [name, value]) => sentence.replaceAll(`{${name}}`, String(value)), T(key));

  const state = {
    data: null,
    error: null,
    section: "overview",
    agentTab: null,
    skillsTab: "installed",
    reading: false,
    readingTimer: null,
    // Sessions 页自己那一份：看的是哪一半、搜什么、正在读哪一条、那一列画到了哪儿。
    // 这些都是这一页的事，宿主不需要知道——除了落点（见 go）。
    sessionsTab: "shared",
    openId: null,
    search: "",
    turnsWindow: 100,
    shownCount: 0,
    // 读者挑的读法属于这一页，不属于某一段对话：换一段会话、换一个分区，它都跟着，
    // 直到他自己在 ⋯ 里换回去（所以那一条回来的路必须一直在）。
    view: "conversation",
    listEl: null,
    footEl: null,
    // 现在这一页上读者在哪儿读：三种画法各有自己会滚的那一格，这里是当前的那一格，
    // 重画之后要落回同一个地方，靠的就是重画前先量它。
    scrollEl: null,
    viewEl: null,
    menuEl: null,
    factNodes: null,
    newChip: null,
    // Model Configuration 页那一份：看的是哪个 agent、简单还是高级、用户正在填的那张表，
    // 以及他刚敲进去的凭据（只活在这一页里，见 seedCenter）。
    centerAgent: null,
    centerDraft: null,
    centerCredential: "",
    centerAdvanced: false,
    // 刚为某一家取回来的模型名单，连着「它属于谁」。宿主刷新的那一刻它把这两样一起带回来，
    // 而载荷重画不给这一页留话（下一次 data 就没有结果了），所以住在这里（见 centerSection）。
    centerFetched: null,
    // 钩子那一页：看的是哪一档（项目里还是这台机器上），以及命令类那一档开没开。
    // 两个都是这一页自己的落点与档位——宿主那两档名单与它无关。
    hooksScope: "project",
    hooksAdvanced: false,
  };

  // 一次启动跑着没跑着，是 core 的一句话，这里只是它的英文：没有第三档，「不确定」
  // 不是一种状态——面板要么知道它在跑，要么知道它不在。idle 不说话（胶囊消失），
  // 因为「没在跑」是默认，不是一条新闻。
  const RUN_LABELS = { running: T("run.running"), interrupted: T("run.interrupted") };

  // 一段对话一次画多少轮：再往上滚可以够到更早的（载荷里给出来的那些）。
  const TURN_PAGE = 100;
  // 离底多近算「还在底部，新消息跟着走」，以及滚到顶的判定（这一列自己的圆角内不算）。
  const NEAR_BOTTOM = 24;
  const BOTTOM_SLOP = 4;

  /* ------------------------------------------------------------- helpers -- */

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className !== undefined) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /**
   * 一个键画到一个节点上：主标签永远是英文，中文两种去向——中文界面里追加成可见的
   * 第二半，其余界面里进 tooltip 与无障碍名。同一句话因此只有一处写它。
   */
  function label(node, key) {
    node.textContent = T(key);
    node.setAttribute("title", PAIR(key));
    if (ZH_VISIBLE) node.append(el("span", "zh", ZH(key)));
    return node;
  }

  /**
   * 静态外壳：模板里的英文字就是词表里的英文字（有测试盯着这两半一致），所以这里
   * 只补中文那一半与无障碍名。首帧仍然由模板给出，脚本不参与。
   */
  function paintShell() {
    for (const node of document.querySelectorAll("[data-text]")) {
      const key = node.getAttribute("data-text");
      if (node.children.length === 0) node.textContent = T(key);
      node.setAttribute("title", PAIR(key));
      if (ZH_VISIBLE && node.querySelector(".zh") === null) node.append(el("span", "zh", ZH(key)));
    }
    for (const node of document.querySelectorAll("[data-aria]")) node.setAttribute("aria-label", PAIR(node.getAttribute("data-aria")));
    for (const node of document.querySelectorAll("[data-title]")) node.setAttribute("title", PAIR(node.getAttribute("data-title")));
  }

  function icon(name, extraClass) {
    const node = el("span", extraClass ? "icon " + extraClass : "icon");
    node.setAttribute("data-icon", name);
    node.setAttribute("aria-hidden", "true");
    return node;
  }

  function button(options) {
    const className = ["btn"];
    if (options.variant === "primary") className.push("btn-primary");
    if (options.variant === "brand") className.push("btn-brand");
    if (options.size === "sm") className.push("btn-sm");
    if (options.iconOnly) className.push("btn-icon");
    // The reference paints some glyphs with the accent while their labels stay
    // neutral (Launch's play, Quick Actions' marks): a class, not a second rule.
    if (options.iconTone === "brand") className.push("icon-brand");
    const node = el("button", className.join(" "));
    node.type = "button";
    if (options.icon !== undefined) node.append(icon(options.icon));
    if (options.label !== undefined) node.append(el("span", undefined, options.label));
    // "Open Config File ↗": the destination glyphs sit after the words.
    if (options.trail !== undefined) node.append(icon(options.trail));
    if (options.iconOnly) node.setAttribute("aria-label", options.title ?? options.label ?? "");
    if (options.title !== undefined) node.title = options.title;
    if (options.disabled) node.disabled = true;
    if (options.onClick) node.addEventListener("click", options.onClick);
    return node;
  }

  function badge(text, tone, iconName) {
    const node = el("span", "badge " + (tone ?? "muted"));
    if (iconName) node.append(icon(iconName));
    node.append(el("span", undefined, text));
    return node;
  }

  // Every link in the reference trails its glyph ("Open Config File ↗",
  // "View All Skills ›"), so the label goes first.
  function link(label, iconName, onClick) {
    const node = el("button", "field-link");
    node.type = "button";
    node.append(el("span", undefined, label));
    if (iconName) node.append(icon(iconName));
    if (onClick) node.addEventListener("click", onClick);
    return node;
  }

  function post(message) {
    vscode.postMessage(message);
  }

  /* ⋯ 打开的必须是一份真的菜单：几件真事，点了就走。菜单是悬着的东西，所以「什么时候收起
   * 来」不归它管——点别处、按 Esc、页面换一帧，这三件事在这里各写一次，菜单只记着自己是屏幕
   * 上开着的那一张（state.menuEl）。 */
  function menuButton(options) {
    const box = el("div", "session-menu");
    box.hidden = true;
    for (const item of options.items) {
      box.append(button({ label: item.label, size: "sm", onClick: () => { closeMenu(); item.onClick(); } }));
    }
    const toggle = button({
      iconOnly: true,
      size: "sm",
      icon: "ellipsis",
      title: options.title,
      onClick: () => {
        const open = box.hidden;
        closeMenu();
        if (open) {
          box.hidden = false;
          state.menuEl = box;
        }
      },
    });
    const wrap = el("span", "menu-wrap");
    wrap.append(toggle);
    wrap.append(box);
    return wrap;
  }

  function closeMenu() {
    if (state.menuEl === null) return;
    state.menuEl.hidden = true;
    state.menuEl = null;
  }

  /* Which section the panel is on is the page's own state, so the page moves itself
   * and tells the host afterwards. The other way round — post a request and let the
   * host answer — made every "View All" link a dead control (the host only recorded
   * the request), and it made the next push of data drag the panel back to whichever
   * section the host had last sent, which is what turned a click on a session title
   * into a jump back to Overview. */
  function go(section, tab) {
    if (!sections.has(section)) return;
    state.section = section;
    // Sessions 有两个落点（哪一半），所以这一条消息连「哪一半」一起说：这一页站在哪儿
    // 是它自己的事，宿主知道自己被放在哪一页就够了。
    if (section === "sessions" && tab !== undefined) state.sessionsTab = tab;
    render();
    post(tab === undefined ? { type: "navigate", section } : { type: "navigate", section, tab });
  }

  /* A strip of chips that switches the pane under it is a tab list, and painted
   * chips alone are not one: without the roles a screen reader reads six
   * unrelated buttons, and without the selected state it cannot say which pane
   * is open. The arrow keys come with the pattern — a roving tabindex means Tab
   * leaves the strip instead of walking through every tab. */
  function tabStrip(options) {
    const strip = el("div", options.inline ? "tabs inline" : "tabs");
    strip.setAttribute("role", "tablist");
    strip.setAttribute("aria-label", options.label);
    const keys = options.tabs.map(([key]) => key);
    for (const [key, text] of options.tabs) {
      const active = key === options.active;
      const tab = el("button", active ? "tab active" : "tab");
      tab.type = "button";
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(active));
      tab.setAttribute("aria-controls", options.panelId);
      tab.tabIndex = active ? 0 : -1;
      tab.append(el("span", undefined, text));
      tab.addEventListener("click", () => {
        options.onSelect(key);
        focusSelected(options.panelId);
      });
      tab.addEventListener("keydown", (event) => {
        const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
        if (step === 0) return;
        event.preventDefault();
        options.onSelect(keys[(keys.indexOf(key) + step + keys.length) % keys.length]);
        focusSelected(options.panelId);
      });
      strip.append(tab);
    }
    return strip;
  }

  // The strip is rebuilt on every render, so the element that had focus is gone
  // by the time the new one exists: focus the tab that took its place.
  function focusSelected(panelId) {
    const next = document.querySelector(`.tab[aria-controls="${panelId}"][aria-selected="true"]`);
    if (next !== null) next.focus();
  }

  function tabPanel(id, label) {
    const node = el("div", "list-box");
    node.id = id;
    node.setAttribute("role", "tabpanel");
    node.setAttribute("aria-label", label);
    return node;
  }

  /* -------------------------------------------------------- agent marks -- */

  const SVG_NS = "http://www.w3.org/2000/svg";
  // The three marks below are the agents' own shapes, measured off the reference
  // rather than redrawn by eye: the sunburst's 12 spokes every 30° to 17px, the
  // knot's ink box 38px inside the 46px head, the loop 44×22px with a 5px ribbon.
  //
  // Claude: twelve spokes of equal length, one every 30°, drawn as strokes from
  // the centre with round caps (the caps are what make the hub solid and the
  // tips round — measured, the gaps between spokes close at r≈6px).
  const CLAUDE_RAYS = "M8 8L8.00 1.20M8 8L11.40 2.11M8 8L13.89 4.60M8 8L14.80 8.00M8 8L13.89 11.40M8 8L11.40 13.89M8 8L8.00 14.80M8 8L4.60 13.89M8 8L2.11 11.40M8 8L1.20 8.00M8 8L2.11 4.60M8 8L4.60 2.11";
  // Codex: the knot itself, filled. Its weave is negative space inside one
  // outline — stroking the outline instead gives a flower, which is what the
  // reference does not show.
  const CODEX_KNOT = "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z";
  // OpenCode: the loop in its name, drawn as one stroke — out of the crossing in
  // the middle, round the right ring, back through the crossing, round the left
  // ring, back to the crossing. Two plain circles side by side are not this.
  const OPENCODE_LOOP = "M12 12C12.9 9.4 14.6 7.57 17.74 7.57A4.43 4.43 0 1 1 17.74 16.43C14.6 16.43 12.9 14.6 12 12C11.1 9.4 9.4 7.57 6.26 7.57A4.43 4.43 0 1 0 6.26 16.43C9.4 16.43 11.1 14.6 12 12";

  function svgNode(tag, attrs) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    return node;
  }

  // Brand marks stay the agents' own: claude = starburst, codex = the knot,
  // opencode = the loop. They are drawn here, never fetched. Their hues live in
  // CSS (`mark-claude` and friends), because one context overrides them all: in
  // an agent card the reference draws every glyph white.
  function agentMark(agentId) {
    const svg = svgNode("svg", { viewBox: "0 0 24 24", class: "mark mark-" + agentId, "aria-hidden": "true" });
    const stroke = { fill: "none", stroke: "currentColor" };
    if (agentId === "claude") {
      svg.setAttribute("viewBox", "0 0 16 16");
      svg.append(svgNode("path", Object.assign({ d: CLAUDE_RAYS, "stroke-width": "1.6", "stroke-linecap": "round" }, stroke)));
    } else if (agentId === "codex") {
      svg.append(svgNode("path", { d: CODEX_KNOT, fill: "currentColor" }));
    } else {
      svg.append(svgNode("path", Object.assign({ d: OPENCODE_LOOP, "stroke-width": "2.6", "stroke-linecap": "round" }, stroke)));
    }
    return svg;
  }

  function agentChip(agentId, tone) {
    const chip = el("span", "agent-chip " + (tone ?? ""));
    chip.append(el("span", undefined, shortLabelOf(agentId)));
    return chip;
  }

  function shortLabelOf(agentId) {
    const card = (state.data?.agents ?? []).find((agent) => agent.id === agentId);
    return card?.short ?? card?.label ?? agentId;
  }

  /* --------------------------------------------------------- agent cards -- */

  // 状态胶囊：跑着的时候有字，没跑的时候什么都没有（连空节点也不留——一棵总是
  // 存在的空 span 会在 gap 里留下半个间隙）。
  function runPill(agentId, run) {
    const pill = el("span", "run-pill");
    pill.setAttribute("data-run-for", agentId);
    setRun(pill, run);
    return pill;
  }

  // 行上那枚说得更少：它说的是「参与这条会话的 agent 里有人正在跑」，是谁在下一个
  // 徽章上。没在跑时它也留着（空的，CSS 藏起来）——后面来的状态要有个东西可改。
  function rowRunPill(agents, running) {
    const pill = el("span", "run-pill");
    pill.setAttribute("data-run-agents", (agents ?? []).join(" "));
    setRun(pill, running ? "running" : "idle");
    return pill;
  }

  // 胶囊上的字只有那两句（跑着、没跑完），别的状态什么都不说——空的那一枚由
  // CSS 的 :empty 藏起来。画第一遍和收到推送时改的都是这一个函数。
  function setRun(pill, run) {
    pill.className = RUN_LABELS[run] ? "run-pill run-" + run : "run-pill";
    pill.textContent = RUN_LABELS[run] ?? "";
  }

  // 实时那一条：只有启动状态变了。整页重画会让人正在读的那一页跳一下，而这件事和
  // 那一页无关——所以这里改的是那几枚胶囊，别的一个字都不动。
  function paintRuns(runs) {
    for (const [agentId, run] of Object.entries(runs ?? {})) {
      const card = (state.data?.agents ?? []).find((agent) => agent.id === agentId);
      if (card) card.run = run;
      for (const pill of document.querySelectorAll('[data-run-for="' + agentId + '"]')) setRun(pill, run);
    }
    // Sessions 里的行说的是它自己的那几个参与者：谁在跑写在旁边的徽章上，行只说
    // 「参与它的人里有谁正在跑」。页面上这一秒看得见的每一枚胶囊都在这两个循环里。
    for (const pill of document.querySelectorAll("[data-run-agents]")) {
      const working = (pill.getAttribute("data-run-agents") ?? "").split(" ").filter(Boolean)
        .some((agentId) => runs?.[agentId] === "running");
      setRun(pill, working ? "running" : "idle");
    }
  }

  // `brief` is the Configure section's cut of the same card: the answers a
  // project gave, without the machinery those answers produce.
  function agentCard(agent, { brief = false } = {}) {
    const card = el("article", "agent-card");

    const head = el("div", "agent-head");
    // The agent's own id on the mark is what gives Claude its tile in CSS; the
    // other two are bare glyphs.
    const mark = el("div", "agent-mark " + agent.id);
    mark.append(agentMark(agent.id));
    head.append(mark);

    const id = el("div", "agent-id");
    id.append(el("div", "agent-name", agent.label));
    const status = el("div", "agent-state");
    if (agent.ready) status.append(el("span", "dot"));
    // The pill's words are core's answer ("Ready", "CLI not installed",
    // "Not configured"), not this file's guess: the renderer cannot know why an
    // agent is unavailable, and inventing a reason is worse than repeating one.
    status.append(el("span", undefined, agent.statusText));
    // Running 与「配好了」是两件事：能跑不代表正跑着，正跑着也不代表配置有问题。
    // 所以是第二枚胶囊，出现与消失都由 core 的状态决定（见 paintRuns）。
    status.append(runPill(agent.id, agent.run));
    id.append(status);
    head.append(id);
    head.append(el("div", "spacer"));

    card.append(head);
    if (brief) {
      // Configure shows the three answers this project gave — and the head above
      // is the same head, because "what did this project choose" is a question
      // about the agent. Everything downstream of those answers stays on the
      // Agents card, which is where it is changed.
      const fields = el("div", "agent-fields");
      // 认的是 core 给那一行起的键，不是它此刻的措辞：这一页认得它，但不改写它。
      const auth = (agent.fields ?? []).find((field) => field.key === "authentication");
      if (auth) fields.append(fieldRow(auth, agent.id));
      // 「Sessions」这一行和侧栏那一条是同一个词、同一个意思，所以用的是它那个键。
      fields.append(fieldRow({ label: T("nav.sessions"), icon: "folder", kind: "badge", tone: agent.sessions.tone, value: agent.sessions.label }, agent.id));
      fields.append(fieldRow({ label: T("agent.history"), icon: "history", kind: "badge", tone: agent.history.tone, value: agent.history.label }, agent.id));
      card.append(fields);
      return card;
    }

    const canLaunch = agent.actions?.launch !== false && agent.ready;
    head.append(button({
      label: T("agent.launch"),
      icon: "play",
      iconTone: "brand",
      size: "sm",
      disabled: !canLaunch,
      onClick: () => post({ type: "action", action: "launch", agent: agent.id }),
    }));
    head.append(button({
      label: T("agent.change"),
      icon: "gear",
      size: "sm",
      disabled: agent.actions?.change === false,
      onClick: () => post({ type: "action", action: "change", agent: agent.id }),
    }));

    const fields = el("div", "agent-fields");
    for (const field of agent.fields ?? []) fields.append(fieldRow(field, agent.id));
    card.append(fields);

    if (agent.detail) card.append(el("p", "agent-note", agent.detail));

    card.append(el("div", "agent-divider"));

    const runtime = el("div", "agent-fields agent-runtime");
    runtime.append(fieldRow({
      label: T("nav.sessions"),
      icon: "folder",
      kind: "badge",
      tone: agent.sessions.tone,
      // The card names the scope and stops there. The count is the tab's job
      // ("Claude (8)"), and the reference keeps the two apart.
      value: agent.sessions.label,
    }, agent.id));
    runtime.append(fieldRow({ label: T("agent.history"), icon: "history", kind: "badge", tone: agent.history.tone, value: agent.history.label }, agent.id));
    card.append(runtime);

    if (agent.configLink) {
      const foot = el("div", "agent-foot");
      foot.append(button({
        label: agent.configLink.label,
        icon: agent.configLink.icon,
        // Every link in the reference trails its glyph, and this one is a button
        // rather than body text: the box is what makes it a destination.
        trail: "link-external",
        size: "sm",
        onClick: () => post({ type: "action", action: "openConfig", agent: agent.id }),
      }));
      card.append(foot);
    }
    return card;
  }

  function fieldRow(field, agentId) {
    const row = el("div", "field-row");
    const label = el("div", "field-label");
    if (field.icon) label.append(icon(field.icon));
    label.append(el("span", undefined, field.label));
    row.append(label);

    const value = el("div", "field-value");
    if (field.kind === "badge") {
      value.append(badge(field.value, field.tone));
    } else if (field.kind === "status") {
      const state_ = el("span", "agent-state");
      // The dot is the fastest thing on the row, so it has to agree with the words
      // beside it: "Not signed in" under a green light is the panel telling two
      // stories at once. The tone comes from the host, which is the side that knows
      // why the answer is what it is.
      state_.append(el("span", "dot " + field.tone));
      state_.append(el("span", undefined, field.value));
      value.append(state_);
    } else if (field.kind === "select") {
      const select = el("button", "field-select");
      select.type = "button";
      select.title = (field.options ?? []).join(" · ");
      select.append(el("span", undefined, field.value));
      select.append(icon("chevron-down"));
      select.addEventListener("click", () => post({ type: "action", action: "change", agent: agentId }));
      value.append(select);
    } else if (field.href) {
      value.append(link(field.value, "link-external", () => post({ type: "action", action: "openConfig", agent: agentId })));
    } else {
      value.append(el("span", "field-plain", field.value));
    }
    row.append(value);
    return row;
  }

  /* -------------------------------------------------------- session rows -- */

  function sessionRow(row, options) {
    const withAgents = options?.showAgents !== false && (row.agents ?? []).length > 0;
    const classes = [withAgents ? "list-row with-agents" : "list-row"];
    if (row.active === true) classes.push("is-active");
    const line = el("div", classes.join(" "));
    line.append(icon("file-text", "list-icon"));

    const main = el("div", "row-main");
    // The title is the way into the conversation: clicking it opens the
    // transcript below the list, which is the only place a session can be read
    // and the only place it can be made the project's active one.
    const title = el("button", "row-title", row.title);
    title.type = "button";
    title.title = row.title;
    title.addEventListener("click", () => post({ type: "action", action: "viewSession", id: row.id }));
    main.append(title);
    if (row.active) main.append(el("span", "active-dot"));
    line.append(main);

    if (options?.showAgents !== false) {
      const chips = el("div", "row-agents");
      for (const agent of row.agents ?? []) chips.append(agentChip(agent, toneOfAgent(agent)));
      line.append(chips);
    }

    // Project rows carry the wider time column the reference gives them: the
    // shared card's times are right-aligned in 63px, the project card's start on
    // one fixed left edge in 123px.
    line.append(el("span", options?.native ? "row-time wide" : "row-time", row.relative));

    const actions = el("div", "row-actions");
    actions.append(button({
      label: T("sessions.continue"),
      icon: "play",
      size: "sm",
      onClick: () => (options?.native
        ? post({ type: "action", action: "continueNative", agent: options.native, id: row.id })
        : post({ type: "action", action: "continueShared", id: row.id })),
    }));
    if (options?.native) {
      // 行尾的 ⋯ 是一份菜单，不是第二个「打开」：这一行能做的几件事都在这儿。前两件在行上
      // 已经有入口（标题、Continue），「设为 Active」只在菜单里——一份菜单的价值就是让人在
      // 一个地方找齐，而不是记住哪个动作躲在哪一列。而它只在共享历史里才有意义：隔离模式下
      // CLI 自己就不列这一项（dispatcher 的会话菜单只在 shared 时给出），面板也不该给一条
      // 走不通的路 —— 与读取器头部那一个按钮是同一条规则，只是它读的是同一份 mode。
      actions.append(menuButton({
        title: T("sessions.actions"),
        items: [
          { label: T("sessions.open"), onClick: () => post({ type: "action", action: "viewSession", id: row.id }) },
          { label: TF("sessions.continue-in", { agent: shortLabelOf(options.native) }), onClick: () => post({ type: "action", action: "continueNative", agent: options.native, id: row.id }) },
          ...(state.data?.history?.mode === "shared"
            ? [{ label: T("transcript.set-active"), onClick: () => post({ type: "action", action: "setActive", id: row.id }) }]
            : []),
        ],
      }));
    }
    line.append(actions);
    return line;
  }

  function toneOfAgent(agentId) {
    if (agentId === "claude") return "brand";
    if (agentId === "codex") return "blue";
    return "purple";
  }

  /* ----------------------------------------------------------------- skill -- */

  // The reference gives every skill row its own tile hue. A skill carries no
  // colour of its own, so the name decides: same name, same tile, every render.
  function skillTint(name) {
    let hash = 0;
    for (const character of name) hash = (hash * 31 + character.codePointAt(0)) % 4;
    return "tint-" + hash;
  }

  function skillRow(skill) {
    const line = el("div", "list-row with-agents skill-line");
    const box = el("span", "skill-icon " + skillTint(skill.name));
    box.append(icon("sparkle"));
    line.append(box);

    const main = el("div", "row-main");
    main.append(el("span", "skill-name", skill.name));
    main.append(el("span", "skill-desc", skill.description));
    line.append(main);

    const marks = el("div", "skill-marks");
    for (const agent of skill.agents ?? []) marks.append(agentMark(agent));
    line.append(marks);

    // "Enabled": the reference's pill is the word alone — the green dot belongs
    // to the agent cards' status line, and at 7x the pill's leftmost stroke is
    // the E's own stem, not a separate glyph.
    line.append(badge(skill.enabled ? T("skills.enabled") : T("skills.disabled"), skill.enabled ? "green" : "muted"));
    // 这条行上原来有一个 ⋯，点下去去的是整页的「管理技能」——一个不动这份清单、也不属于
    // 这一行的选择器。一个不打开菜单的 ⋯ 和坏掉的是同一个东西，所以它没有了：装、卸、导入
    // 这些真动作在 Skills 页的头部与 Packs 那一半上，各自说自己要动谁。
    return line;
  }

  function cardHead(options) {
    const classes = ["card-head"];
    if (options.inlineSub) classes.push("inline-sub");
    if (options.sectionHead) classes.push("section-head");
    if (options.compact) classes.push("compact");
    const head = el("div", classes.join(" "));
    if (options.sectionIcon) {
      const box = el("span", "section-icon");
      box.append(icon(options.sectionIcon));
      head.append(box);
    }
    const titles = el("div", "card-titles");
    // 卡片标题是外壳那一层的话（`Shared Sessions` 在侧栏和卡片上是同一条），所以它走
    // label()：英文永远是主标签，中文界面里才多出第二行。
    titles.append(label(el("div", "card-title"), options.titleKey));
    if (options.subtitle) titles.append(el("div", "card-sub", options.subtitle));
    head.append(titles);
    return head;
  }

  /* -------------------------------------------------------------- sections -- */

  function overviewSection(data) {
    const nodes = [];

    // --- Agent configuration -------------------------------------------------
    const agents = el("section", "section");
    const head = cardHead({ sectionIcon: "organization", titleKey: "agents.title", subtitle: T("agents.subtitle"), sectionHead: true });
    head.append(el("div", "spacer"));
    head.append(button({ label: T("agents.open-terminal"), icon: "terminal", onClick: () => post({ type: "action", action: "openInTerminal" }) }));
    head.append(button({ iconOnly: true, icon: "ellipsis", title: T("agents.log"), onClick: () => post({ type: "action", action: "viewLogs" }) }));
    agents.append(head);
    const body = el("div", "section-body");
    const grid = el("div", "agent-grid");
    for (const agent of data.agents) grid.append(agentCard(agent));
    body.append(grid);
    agents.append(body);
    nodes.push(agents);

    // --- Sessions ------------------------------------------------------------
    const row = el("div", "cards-row");
    row.append(sharedCard(data));
    row.append(projectCard(data));
    nodes.push(row);

    // --- Skills + quick actions + activity ------------------------------------
    // The page's last row, and the one that takes the room the rows above it
    // left: the reference's Overview reaches its own bottom edge whatever the
    // project's lists happen to hold.
    const bottom = el("div", "cards-row bottom-row");
    bottom.append(skillsCard(data));
    const stack = el("div", "stack");
    stack.append(quickCard(data));
    stack.append(activityCard(data));
    bottom.append(stack);
    nodes.push(bottom);
    return nodes;
  }

  function sharedCard(data) {
    const card = el("section", "card");
    // 概览上的这两张卡是 Sessions 页那两半的摘要，所以它们用同一套词：同两个标题、
    // 同两句副标题——两张卡说的是两个列表，用两种叫法反而像四样东西。
    const head = cardHead({ sectionIcon: "share", titleKey: "sessions.shared.title", subtitle: T("sessions.shared.subtitle") });
    head.append(el("div", "spacer"));
    if (data.history.mode === "shared") {
      // Nothing to continue means nothing to click: the host drops an action
      // whose id it cannot validate, so the button says so instead of sending one.
      const newest = data.shared.rows[0];
      head.append(button({
        label: T("sessions.shared.continue"),
        // The reference draws this one as a "take it from here" download glyph,
        // not the play it uses for Launch.
        icon: "download",
        size: "sm",
        variant: "brand",
        disabled: newest === undefined,
        onClick: () => post({ type: "action", action: "continueShared", id: newest.id }),
      }));
    } else {
      head.append(button({ label: T("sessions.shared.switch"), icon: "history", size: "sm", variant: "brand", onClick: () => post({ type: "action", action: "switchHistory" }) }));
    }
    head.append(button({ iconOnly: true, icon: "ellipsis", size: "sm", title: T("sessions.shared.all"), onClick: () => go("sessions", "shared") }));
    card.append(head);

    const list = el("div", "list-box");
    if (data.history.mode !== "shared") {
      list.append(emptyState("sessions.shared.off-title", T("sessions.shared.off-detail")));
    } else if (data.shared.rows.length === 0) {
      list.append(emptyState("sessions.shared.empty-title", T("sessions.empty.start-detail")));
    } else {
      for (const item of data.shared.rows) list.append(sessionRow(item));
    }
    card.append(list);

    card.append(listFoot(data, {
      label: TF("sessions.shared.view-all", { total: data.shared.total }),
      section: "sessions",
      tab: "shared",
      shown: data.shared.rows.length,
      total: data.shared.total,
    }));
    return card;
  }

  /* 「View All」只在概览上是一句话：到了它指向的那一页，同一个链接就成了原地打转。
   * 取而代之的是那一页必须自己说清楚它列了多少条——一张只画前 50 行、却不说这个数
   * 的列表，看起来和「总共就这么多」没有区别。
   *
   * 落点连「哪一半」一起说：Sessions 页有两半，只说「Sessions」的话，从 Agent 那一
   * 张卡进去的人会落到共享那一半上。 */
  function listFoot(data, options) {
    const foot = el("div", options.compact ? "card-foot compact" : "card-foot");
    if (!data.detail) foot.append(link(options.label, "chevron-right", () => go(options.section, options.tab)));
    else if (options.total > options.shown) foot.append(el("span", "foot-note", TF("list.showing-newest", { shown: options.shown, total: options.total })));
    return foot;
  }

  function projectCard(data) {
    const card = el("section", "card");
    const head = cardHead({ sectionIcon: "database", titleKey: "sessions.agent.title", subtitle: T("sessions.agent.subtitle") });
    head.append(el("div", "spacer"));

    // The agent tabs sit in the head, not on their own strip.
    const active = state.agentTab ?? data.agents.find((agent) => data.native[agent.id]?.rows.length)?.id ?? data.agents[0]?.id;
    state.agentTab = active;
    head.append(tabStrip({
      label: T("sessions.agent.tabs-label"),
      panelId: "native-sessions",
      inline: true,
      active,
      // Short label: the reference's tabs read "Claude (8)", not "Claude Code (8)".
      tabs: data.agents.map((agent) => [agent.id, TF("sessions.agent.tab", { name: agent.short ?? agent.label, count: data.native[agent.id]?.total ?? 0 })]),
      onSelect: (key) => { state.agentTab = key; render(); },
    }));
    card.append(head);

    const list = tabPanel("native-sessions", TF("sessions.agent.panel", { name: shortLabelOf(active) }));
    const rows = data.native[active]?.rows ?? [];
    if (rows.length === 0) {
      list.append(emptyState("sessions.agent.empty-title", TF("sessions.agent.no-conversation", { name: shortLabelOf(active) })));
    } else {
      for (const item of rows) list.append(sessionRow(item, { native: active, showAgents: false }));
    }
    card.append(list);

    card.append(listFoot(data, {
      label: T("sessions.agent.view-all"),
      section: "sessions",
      tab: "agent",
      compact: true,
      shown: rows.length,
      total: data.native[active]?.total ?? rows.length,
    }));
    return card;
  }

  // `wide` is the Skills section, where the card spans the window instead of
  // sitting in the Overview's column: the name column the reference measured
  // (84px, its own names are short) cuts real skill names in that much room.
  function skillsCard(data, { wide = false } = {}) {
    const card = el("section", wide ? "card skills wide" : "card skills");
    const head = cardHead({ sectionIcon: "package", titleKey: "nav.skills", subtitle: T("skills.subtitle"), compact: true });
    head.append(el("div", "spacer"));
    head.append(button({ label: T("skills.import"), icon: "download", onClick: () => post({ type: "action", action: "importSkill" }) }));
    head.append(button({ label: T("shell.open-folder"), icon: "folder-opened", onClick: () => post({ type: "action", action: "openFolder" }) }));
    card.append(head);

    // Counts only where the reference carries them: Installed is tallied, Packs
    // and the registry are not. Whether the registry is synced is said inside
    // its pane, not by renaming the tab on the way in.
    card.append(tabStrip({
      label: T("skills.sources"),
      panelId: "skills-panel",
      active: state.skillsTab,
      tabs: [
        ["installed", TF("skills.tab.installed", { count: data.skills.installedTotal })],
        ["packs", T("skills.tab.packs")],
        ["hub", T("skills.tab.hub")],
      ],
      onSelect: (key) => { state.skillsTab = key; render(); },
    }));

    const list = tabPanel("skills-panel", T("skills.panel"));
    if (state.skillsTab === "packs") {
      if (data.skills.packs.length === 0) list.append(emptyState("skills.packs.empty-title", T("skills.packs.empty-detail")));
      for (const pack of data.skills.packs) {
        const line = el("div", "list-row");
        line.append(icon("package", "list-icon"));
        const main = el("div", "row-main");
        main.append(el("span", "skill-name", pack.name));
        main.append(el("span", "skill-desc", pack.description));
        line.append(main);
        line.append(badge(TF("skills.packs.count", { count: pack.count }), "muted"));
        // 装的是这一个 pack：面板把它的 id 交给宿主已有的那条安装命令，而不是把用户
        // 再丢回选择器里——那等于让他在自己刚点过的地方重新选一次。
        line.append(button({ label: pack.installed ? T("skills.pack.installed") : T("skills.pack.install"), size: "sm", disabled: pack.installed, onClick: () => post({ type: "action", action: "installPack", pack: pack.id }) }));
        list.append(line);
      }
    } else if (state.skillsTab === "hub") {
      const line = el("div", "list-row");
      line.append(icon("database", "list-icon"));
      const main = el("div", "row-main");
      main.append(el("span", "skill-name", data.hub.spec ?? T("skills.hub.none")));
      // 三态是 core 的答案：拉过一次但落后于远端时，说「已同步」等于把 stale 说成
      // current。面板照抄它的词，不自己把三态压成一个布尔。
      const revision = data.hub.revision ? data.hub.revision.slice(0, 12) : null;
      main.append(el("span", "skill-desc", revision === null
        ? T("skills.hub.never")
        : data.hub.state === "current" ? TF("skills.hub.up-to-date", { revision }) : TF("skills.hub.stale", { revision })));
      line.append(main);
      line.append(button({ label: data.hub.state === "current" ? T("skills.hub.sync-again") : T("skills.hub.sync"), size: "sm", onClick: () => post({ type: "action", action: "syncHub" }) }));
      list.append(line);
    } else if (data.skills.installed.length === 0) {
      list.append(emptyState("skills.empty.title", T("skills.empty.detail")));
    } else {
      for (const skill of data.skills.installed) list.append(skillRow(skill));
    }
    card.append(list);

    card.append(listFoot(data, {
      label: T("skills.view-all"),
      section: "skills",
      shown: data.skills.installed.length,
      total: data.skills.installedTotal,
    }));
    return card;
  }

  function quickCard(data) {
    const card = el("section", "card");
    card.append(cardHead({ sectionIcon: "zap", titleKey: "nav.quick", subtitle: T("quick.subtitle"), compact: true }));
    const body = el("div", "card-body");
    const grid = el("div", "quick-grid");
    const agentOf = (agentId) => data.agents.find((agent) => agent.id === agentId);
    const ready = (agentId) => agentOf(agentId)?.actions?.launch === true;
    const sharedId = data.shared.rows[0]?.id;
    // 三句「新建 …… Session」只差 agent 的名字，所以它们是一句话和一个洞。灰掉的那一个
    // 旁边那句话是 core 自己的说法（"CLI not installed"、"Not configured"），不是这里编的
    // ——面板不知道一个 agent 为什么不能启动，编一个理由比没有理由更糟。
    const definitions = [
      { label: TF("quick.new-session", { agent: "Claude" }), mark: "claude", action: { action: "launch", agent: "claude" }, enabled: ready("claude"), reason: agentOf("claude")?.statusText },
      { label: TF("quick.new-session", { agent: "Codex" }), mark: "codex", action: { action: "launch", agent: "codex" }, enabled: ready("codex"), reason: agentOf("codex")?.statusText },
      { label: TF("quick.new-session", { agent: "OpenCode" }), mark: "opencode", action: { action: "launch", agent: "opencode" }, enabled: ready("opencode"), reason: agentOf("opencode")?.statusText },
      // 共享历史是这个项目的一种设置：隔离模式下拉起一条共享会话，CLI 会直接拒绝
      // （它的会话菜单在隔离模式下连这一项都不列），所以这里也不给一条走不通的路。灰掉的原因
      // 有两种，说的分别是这两种：历史被设成隔离了，或者还没有可接着说的那一条。
      {
        label: T("quick.continue-shared"),
        icon: "share",
        action: { action: "continueShared", id: sharedId },
        enabled: data.history.mode === "shared" && sharedId !== undefined,
        reason: data.history.mode === "shared" ? T("quick.off-empty") : T("quick.off-isolated"),
      },
      { label: T("quick.manage-skills"), icon: "package", action: { action: "manageSkills" }, enabled: true },
      { label: T("quick.view-logs"), icon: "list", action: { action: "viewLogs" }, enabled: true },
    ];
    for (const definition of definitions) {
      // A quick action is the same buttons the cards already have, so it is
      // disabled by the same answer: an agent core says cannot launch has no
      // quick way in either.
      const node = el("button", "quick-btn");
      node.type = "button";
      if (definition.mark) node.append(agentMark(definition.mark));
      else node.append(icon(definition.icon));
      node.append(el("span", undefined, definition.label));
      if (definition.enabled) {
        const message = definition.action;
        node.addEventListener("click", () => post(Object.assign({ type: "action" }, message)));
        grid.append(node);
      } else {
        // 灰按钮自己不发光标事件，所以「为什么灰着」挂在包着它的那一格上：鼠标停在灰按钮上
        // 时事件落在盒子上，那句话就是盒子说的。
        node.disabled = true;
        const wrap = el("span", "quick-wrap");
        if (definition.reason) wrap.title = definition.reason;
        wrap.append(node);
        grid.append(wrap);
      }
    }
    body.append(grid);
    card.append(body);
    return card;
  }

  function activityCard(data) {
    const card = el("section", "card");
    card.append(cardHead({ sectionIcon: "clockface", titleKey: "activity.title", subtitle: T("activity.subtitle"), inlineSub: true }));
    const list = el("div", "activity-list");
    if (data.activity.length === 0) {
      list.append(emptyState("activity.empty-title", T("activity.empty-detail")));
    } else {
      for (const item of data.activity.slice(0, 3)) {
        const row = el("div", "activity-row");
        // Green is the dot's own colour, so it needs no class; every other tone does,
        // and a tone with no rule would be painted green — the one colour it is not.
        row.append(el("span", item.tone === "green" ? "activity-dot" : "activity-dot " + item.tone));
        row.append(el("span", "activity-text", item.text));
        row.append(el("span", "activity-time", item.time));
        list.append(row);
      }
      // The "view all" link takes the fourth cell of the two-column grid,
      // bottom right, exactly where the reference puts it.
      const more = el("div", "activity-row end");
      more.append(link(T("activity.view-all"), "chevron-right", () => post({ type: "action", action: "viewLogs" })));
      list.append(more);
    }
    card.append(list);
    return card;
  }

  // 空的时候要说一句话。标题收的是**键**不是句子：这一格是整块空白上唯一的标题，
  // 和卡片标题一样是外壳那一层的话，所以它也走 label()（中文界面里多出一行）。
  // detail 收的是已经渲染好的句子——有两处它是宿主给的错误原文，不是词表里的键。
  function emptyState(titleKey, detail) {
    const box = el("div", "empty");
    box.append(label(el("strong"), titleKey));
    if (detail) box.append(el("span", undefined, detail));
    return box;
  }

  function agentGrid(data, brief) {
    const grid = el("div", "agent-grid");
    for (const agent of data.agents) grid.append(agentCard(agent, { brief }));
    return grid;
  }

  function agentsSection(data) {
    return [agentGrid(data, false)];
  }

  // Configure is the same three agents asked a narrower question: what did this
  // project answer, one row each. The reference's sidebar names both, and two
  // entries that draw the same card would be one entry with two names.
  function configureSection(data) {
    return [agentGrid(data, true)];
  }

  /* -------------------------------------------------------- sessions page -- */
  //
  // Sessions 是这一页里唯一「读」的地方，所以它是两个窗格而不是两张卡片：左边一列
  // 会话，右边它们其中一条的对话。列表那一帧只读元数据——名字、参与者、时间、跑着没有
  // ——一段对话要等用户点开某一条才读。

  /* 一条会话没有标题时，用短 id 而不是整串 uuid：存储的编号不是它的名字，印在一行
   * 上就是把编号当成了名字。宿主那边已经这样回答了，这里再兜一次——载荷可以来自
   * 任何一版宿主，而「永远不印 uuid」这条不归版本管。 */
  function titleOf(row) {
    if (row.title) return row.title;
    const id = String(row.id ?? "");
    const tail = id.includes(":") ? id.slice(id.indexOf(":") + 1) : id;
    return tail.slice(0, 8);
  }

  // 哪一个是「这一列在看的 agent」：用户点过的那个，否则第一个真的有会话的，再否则
  // 第一个。概览的卡片和 Sessions 页说的是同一个选择，所以它只有一份。
  function activeAgent(data) {
    const chosen = state.agentTab ?? (data.agents ?? []).find((agent) => (data.native?.[agent.id]?.rows ?? []).length > 0)?.id;
    return chosen ?? data.agents?.[0]?.id;
  }

  function sessionsSection(data) {
    const browser = el("section", "sessions-browser");
    const panes = el("div", "sessions-panes");
    panes.append(sessionsListPane(data));
    panes.append(sessionReader(data));
    browser.append(panes);
    return [browser];
  }

  function sessionsListPane(data) {
    const shared = state.sessionsTab === "shared";
    const pane = el("aside", "card sessions-list-pane");
    pane.id = "sessions-list-pane";
    pane.setAttribute("role", "tabpanel");
    pane.setAttribute("aria-label", T("nav.sessions"));
    // 产品词是这两个：Shared Sessions 是这个项目跨 agent 的那一份历史，Agent Sessions
    // 是某个 agent 自己那份原生会话。两句话各自说清它列的是什么。
    pane.append(cardHead({
      sectionIcon: shared ? "share" : "database",
      titleKey: shared ? "sessions.shared.title" : "sessions.agent.title",
      subtitle: shared ? T("sessions.shared.subtitle") : T("sessions.agent.subtitle"),
    }));

    pane.append(tabStrip({
      label: T("sessions.which"),
      panelId: "sessions-list-pane",
      active: state.sessionsTab,
      tabs: [["shared", T("sessions.tab.shared")], ["agent", T("sessions.tab.agent")]],
      // 换一半是这一页自己的事（它记着用户站在哪一半），顺带告诉宿主它现在停在哪儿。
      onSelect: (key) => { if (key !== state.sessionsTab) go("sessions", key); },
    }));

    // 搜的是已经拿到的那一列，按标题与元数据过一遍：问宿主重新读一次盘不叫搜索。
    const search = el("input", "session-search");
    search.type = "search";
    search.value = state.search;
    search.placeholder = T("sessions.search");
    search.setAttribute("aria-label", T("sessions.search"));
    search.addEventListener("input", () => { state.search = search.value; paintRows(); });
    pane.append(search);

    if (!shared) pane.append(agentStrip(data));

    const list = el("div", "sessions-list");
    list.id = "sessions-agent-list";
    list.setAttribute("role", "tabpanel");
    list.setAttribute("aria-label", shared ? T("sessions.list.shared") : TF("sessions.agent.panel", { name: shortLabelOf(activeAgent(data)) }));
    list.append(...listChildren(data));
    pane.append(list);
    state.listEl = list;

    const foot = el("div", "sessions-foot");
    pane.append(foot);
    state.footEl = foot;
    paintFoot();

    // 两个词的区别要有一句话，否则「Shared Sessions」和「Agent Sessions」看起来
    // 只是同一个东西的两种叫法。
    pane.append(el("div", "sessions-note", T("sessions.note")));
    return pane;
  }

  // Agent 那一半列的是某一个 agent 自己的会话，所以它还要问是哪一个。这是换列内容
  // 的开关，和上面那一条一样是标签组——画成芯片而角色上不是，读屏软件读到的是三枚
  // 互不相干的按钮。
  function agentStrip(data) {
    const active = state.agentTab = activeAgent(data);
    return tabStrip({
      label: T("sessions.agent.tabs-label"),
      panelId: "sessions-agent-list",
      inline: true,
      active,
      // 短名：参考图的标签写的是「Claude (8)」，不是「Claude Code (8)」。
      tabs: (data.agents ?? []).map((agent) => [agent.id, TF("sessions.agent.tab", { name: agent.short ?? agent.label, count: data.native?.[agent.id]?.total ?? 0 })]),
      onSelect: (key) => { state.agentTab = key; render(); },
    });
  }

  function matchesSearch(row, needle) {
    if (needle === "") return true;
    // 一行是元数据：名字、参与者、时间。id 不在里面——按一个看不见的字段筛出来的行，
    // 用户没有办法知道它为什么在这儿。
    const haystack = [row.title, row.relative, ...(row.agents ?? []).map(shortLabelOf)].join(" ").toLowerCase();
    return haystack.includes(needle);
  }

  // 这一列此刻列出来的那几条（搜索过了一遍）。
  function listedRows(data) {
    const shared = state.sessionsTab === "shared";
    const source = shared ? (data.shared?.rows ?? []) : (data.native?.[activeAgent(data)]?.rows ?? []);
    const needle = state.search.trim().toLowerCase();
    return { shared, source, rows: source.filter((row) => matchesSearch(row, needle)) };
  }

  function listChildren(data) {
    const { shared, source, rows } = listedRows(data);
    if (rows.length > 0) return rows.map((row) => browserRow(row, { agents: shared }));
    if (source.length > 0) return [emptyState("sessions.no-match.title", TF("sessions.no-match.detail", { search: state.search.trim() }))];
    return [shared
      ? emptyState("sessions.empty.shared-title", T("sessions.empty.start-detail"))
      : emptyState("sessions.empty.agent-title", TF("sessions.agent.no-conversation", { name: shortLabelOf(activeAgent(data)) }))];
  }

  // 搜索和换 agent 都只动这一列：右边正在读的那一段不跟着动，读到的位置也就还在。
  function paintRows() {
    const list = state.listEl;
    if (list === null || state.data === null) return;
    list.replaceChildren(...listChildren(state.data));
    paintFoot();
  }

  function paintFoot() {
    const foot = state.footEl;
    if (foot === null || state.data === null) return;
    const { shared, rows } = listedRows(state.data);
    const total = shared ? (state.data.shared?.total ?? 0) : (state.data.native?.[activeAgent(state.data)]?.total ?? 0);
    foot.replaceChildren();
    // 一张只画前几行、却不说这个数的列表，看起来和「总共就这么多」没有区别——搜索的
    // 时候说的就是「筛出来的几条」。
    if (total <= rows.length) return;
    foot.append(el("span", "foot-note", state.search.trim() === ""
      ? TF("list.showing-newest", { shown: rows.length, total })
      : TF("sessions.foot.match", { shown: rows.length, total })));
  }

  function browserRow(row, options) {
    const line = el("div", "session-row");
    line.setAttribute("data-session", row.id);
    // 正在读的那一条要说出来：这一页的高亮不只是一种颜色，读屏软件也要读到它。
    if (state.openId === row.id) line.setAttribute("aria-current", "true");

    const title = el("button", "row-title", titleOf(row));
    title.type = "button";
    title.title = titleOf(row);
    title.addEventListener("click", () => post({ type: "action", action: "viewSession", id: row.id }));
    line.append(title);

    const meta = el("div", "row-meta");
    // 两枚胶囊各说各的：Active 是这个项目的当前会话，「Running」是参与它的 agent 里
    // 有人正在跑，「Stale」是这一份拷贝落后于共享历史了。合成一枚就会说错其中一件。
    if (row.active) meta.append(el("span", "active-chip", T("sessions.chip.active")));
    meta.append(rowRunPill(row.agents, row.sync?.running === true));
    if (row.sync?.state === "stale") meta.append(el("span", "stale-chip", T("sessions.chip.stale")));
    if (options.agents !== false) {
      for (const agent of row.agents ?? []) meta.append(agentChip(agent, toneOfAgent(agent)));
    }
    meta.append(el("span", "row-time", row.relative));
    line.append(meta);
    return line;
  }

  /* ------------------------------------------------------------ the reader -- */

  function sessionReader(data) {
    const view = el("section", "card session-view");
    const transcript = data.transcript;
    if (!transcript) {
      view.append(emptyState("transcript.empty-title", T("transcript.empty-detail")));
      return view;
    }

    const head = el("div", "session-head");
    const top = el("div", "session-head-top");
    const titles = el("div", "session-titles");
    titles.append(el("div", "session-title", titleOf(transcript)));
    // 一段对话是不是「三个 agent 共用的那一份」，取决于这个项目的设置。隔离模式下把
    // 同一条会话说成共享历史，就是在替这个项目回答它没做的那个选择。
    titles.append(el("div", "session-sub", data.history.mode === "shared"
      ? T("transcript.sub.shared")
      : T("transcript.sub.isolated")));
    top.append(titles);
    top.append(el("div", "spacer"));

    const actions = el("div", "session-actions");
    actions.append(button({
      label: T("sessions.continue"),
      icon: "play",
      iconTone: "brand",
      size: "sm",
      onClick: () => post(Object.assign({ type: "action" }, continueAction(transcript))),
    }));
    // The active session is the one `avenic continue` picks up when nobody names a
    // conversation, so marking it is a real action. 隔离模式下 CLI 不提供这一项
    // （它的菜单只在 shared 时列出「设为 Active」），于是这里也不提供——一条点了会被
    // 拒绝的按钮不是功能。
    if (data.history.mode === "shared" && !transcript.active) {
      actions.append(button({
        label: T("transcript.set-active"),
        icon: "check",
        size: "sm",
        onClick: () => post({ type: "action", action: "setActive", id: transcript.id }),
      }));
    }

    // ⋯ 后面是这一页自己的三种读法：Conversation 是对话本身，Raw 是这些轮的原样，
    // Diagnostics 是这条会话的投影说过什么。三者都在已到的载荷里——一个点了要等宿主
    // 回包的菜单项，等不到就是死的，而这三个视图永远不会有第二条答案。回来的那一条
    // 必须列在这里：重画不再把读法收回去了（那是读者的选择），所以页面上要是没有这条
    // 路，点过一次 Raw 的人就再也读不到对话。
    actions.append(menuButton({
      title: T("sessions.actions"),
      items: [
        { label: T("transcript.conversation"), onClick: () => showView("conversation") },
        { label: T("transcript.raw"), onClick: () => showView("raw") },
        { label: T("transcript.diagnostics"), onClick: () => showView("diagnostics") },
      ],
    }));
    top.append(actions);
    head.append(top);

    const facts = el("div", "session-facts");
    const fact = (label) => {
      const value = el("span", "fact-value");
      facts.append(el("div", "session-fact", label));
      facts.append(value);
      return value;
    };
    fact(T("transcript.fact.participants")).textContent = (transcript.participants ?? []).join(", ");
    const updated = fact(T("transcript.fact.updated"));
    const events = fact(T("transcript.fact.events"));
    const sync = fact(T("transcript.fact.sync"));
    paintFacts({ updated, events, sync }, transcript);
    head.append(facts);
    view.append(head);

    state.factNodes = { updated, events, sync };
    // 读者挑的是哪一种读法（对话 / 原始 / 诊断）：一次重画不该把它收回去，所以这里照
    // 他挑的那一种画。三种读法画在同一个挂载点里，只有一个会滚的盒子——`state.scrollEl`
    // 记的就是「现在这一页上，读者在哪儿读」。
    const body = el("div", "session-view-body");
    const shown = state.view === "raw" ? rawView(transcript) : state.view === "diagnostics" ? diagnosticsView(transcript) : conversationBox(transcript);
    state.scrollEl = shown;
    body.append(shown);
    state.viewEl = body;
    view.append(body);
    return view;
  }

  // 头部那几格是实时更新里唯一会变的东西：事件数、更新时间、同步状态。它们是同一批
  // 节点，改的是字而不是重建——重建会让正在读的人丢掉位置。
  function paintFacts(nodes, transcript) {
    nodes.events.textContent = TF("transcript.events", { count: transcript.eventCount });
    nodes.updated.textContent = transcript.updatedRelative;
    nodes.sync.textContent = transcript.sync?.label ?? "";
  }

  function continueAction(transcript) {
    // Agent 那一半接着说的是那个 agent 自己的会话，共享那一半接着说的是共享历史。
    if (state.sessionsTab === "agent") return { action: "continueNative", agent: activeAgent(state.data), id: transcript.id };
    return { action: "continueShared", id: transcript.id };
  }

  function conversationBox(transcript) {
    const box = el("div", "transcript");
    box.tabIndex = 0;
    paintTurns(box, transcript.turns ?? []);
    // 往上滚就是「想看得更早」：到底之后把剩下的补上，不再向宿主多要一次载荷。补的
    // 时候留住读者看的那一行——把内容接在上面会把正在读的那一段推下去。
    box.addEventListener("scroll", () => {
      if (box.scrollTop > BOTTOM_SLOP) return;
      const all = state.data?.transcript?.turns ?? [];
      if (state.shownCount >= all.length) return;
      state.turnsWindow += TURN_PAGE;
      const kept = box.scrollHeight - box.scrollTop;
      paintTurns(box, all);
      box.scrollTop = Math.max(0, box.scrollHeight - kept);
    });
    return box;
  }

  function paintTurns(box, turns) {
    const shown = turns.slice(-state.turnsWindow);
    state.shownCount = shown.length;
    const nodes = [];
    // 没画全部的时候要说出来：一列看起来完整的对话和一条被截断的，字面上没有区别。
    if (turns.length > shown.length) nodes.push(el("div", "turn-note", TF("transcript.showing-turns", { shown: shown.length, total: turns.length })));
    for (const turn of shown) nodes.push(turnBlock(turn));
    box.replaceChildren(...nodes);
  }

  function turnBlock(turn) {
    const block = el("article", "turn");
    const head = el("div", "turn-head");
    // 说话的人是 core 定下的称呼：键盘前的人只有一个名字（You），别的是发话的那个
    // agent。存在盘上的 role（user/assistant）是给程序看的词，不写在这一页上——这一页
    // 也不自己算一遍：`speaker` 就是那个答案。
    head.append(el("span", "turn-speaker", turn.speaker));
    if (turn.model) head.append(el("span", "turn-model", turn.model));
    block.append(head);
    if (turn.text) block.append(el("div", "turn-text", turn.text));
    for (const tool of turn.tools ?? []) block.append(toolRow(tool));
    return block;
  }

  // 工具不是自己说话的人：它属于让它跑起来的那个 agent，所以它是那一轮下面的一行，
  // 不是新的一轮——把它写成一条发言，就是把 agent 干的事放进了键盘前那个人的嘴里。
  function toolRow(tool) {
    const row = el("div", "tool-row");
    row.append(el("span", "tool-verb", tool.kind === "call" ? T("transcript.tool.ran") : T("transcript.tool.returned")));
    row.append(el("span", "tool-name", tool.name));
    // 括号里是宿主给的参数，外面那对括号是标点而不是句子：它在两种语言里长得一样，
    // 所以不进词表（见 src/i18n/text.ts 里 tool 那两句旁边的说明）。
    if (tool.detail) row.append(el("span", "tool-detail", `(${tool.detail})`));
    return row;
  }

  function showView(kind) {
    const transcript = state.data?.transcript;
    const body = state.viewEl;
    if (!transcript || !body) return;
    state.view = kind;
    // 换一种读法就是换掉这一列，搁在里面的那条提示跟着一起走（它说的是旧那一列的位置，
    // 本来就该走）。但状态里不能还留着它：不然「已经给过一条」这句话会替下一列把话说完，
    // 读者绕一圈回来之后，下面再来消息也发不出第二条提示了。
    state.newChip = null;
    if (kind === "conversation") {
      // 回到对话：这一列重新画一遍，原来读到哪儿就没了——这是换一种读法的代价。
      state.turnsWindow = TURN_PAGE;
      const box = conversationBox(transcript);
      state.scrollEl = box;
      body.replaceChildren(box);
      landToNewest();
      return;
    }
    const box = kind === "raw" ? rawView(transcript) : diagnosticsView(transcript);
    state.scrollEl = box;
    body.replaceChildren(box);
  }

  /* 画好的这一列落在哪儿。`kept` 是读者原来离结尾有多远：0 就是落在最新那一轮上（第一次
   * 打开一段会话、刚换过读法都是它）。落在开头等于把读的人送回一段他早读过的地方（一条长
   * 会话打开来看到的是第 100 轮之前，而右边那颗「继续」按钮说的是最新那一句），把从半路
   * 读的人拽到结尾则是把他正读的那一段抽走。这一句只在节点已经进了文档之后才写：那正是
   * 浏览器算得出真实 scrollHeight 的时刻，也正是这一列接下来要画的起点。 */
  function landToNewest(kept = 0) {
    const box = state.scrollEl;
    if (box) box.scrollTop = Math.max(0, box.scrollHeight - kept);
  }

  function rawView(transcript) {
    const box = el("div", "raw-view");
    box.append(el("div", "view-note", T("transcript.raw.note")));
    // 载荷里只有语义上的那几轮：控制行与 CLI 自己的回显在宿主那侧就没进来，所以这里
    // 不筛原始记录——它画的就是它拿到的。
    for (const turn of transcript.turns ?? []) box.append(el("div", "raw-line", JSON.stringify(turn)));
    return box;
  }

  function diagnosticsView(transcript) {
    const box = el("div", "diagnostics-view");
    const warnings = transcript.diagnostics?.warnings ?? [];
    const notes = transcript.diagnostics?.notes ?? [];
    box.append(el("div", "view-note", TF("transcript.diagnostics.note", { state: transcript.sync?.label ?? T("transcript.diagnostics.unknown") })));
    if (warnings.length === 0 && notes.length === 0) {
      box.append(emptyState("transcript.diagnostics.empty-title", T("transcript.diagnostics.empty-detail")));
      return box;
    }
    for (const [tone, lines] of [[T("transcript.diagnostics.warning"), warnings], [T("transcript.diagnostics.note-tone"), notes]]) {
      for (const text of lines) {
        const row = el("div", "diagnostic-row");
        row.append(el("span", "diagnostic-tone", tone));
        row.append(el("span", "diagnostic-text", text));
        box.append(row);
      }
    }
    return box;
  }

  /* 新消息落在哪儿：读到一半的人不能被拽到底部，也不能什么都不说——屏幕下沿给一条
   * 回去的路，点了才下去。本来就在底部的人跟着走，那才是「实时」。
   *
   * 三种答案，调用者按它决定要不要重画：能接就 "appended"；窗口满了（这一列画不下
   * 更多轮）是 "grown" —— 重画一次，窗口跟着往前挪一位；其余是 "same"。 */
  function appendNewTurns(previous) {
    const before = previous?.transcript;
    const now = state.data?.transcript;
    if (state.section !== "sessions" || state.scrollEl === null || state.view !== "conversation") return "same";
    if (!before || !now || before.id !== now.id) return "same";
    const added = (now.turns ?? []).length - (before.turns ?? []).length;
    if (added <= 0) return "same";
    // 前面那几轮必须是同一批：换了一段对话就整段重画，不能把新的一轮接到别人后面。
    for (let index = 0; index < before.turns.length; index += 1) if (before.turns[index].id !== now.turns[index].id) return "same";
    // 窗口已经满了：重画一次，窗口跟着挪一位——多出来的那些本来就该从最上面掉出去。
    if (state.shownCount + added > state.turnsWindow) return "grown";
    const box = state.scrollEl;
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight <= NEAR_BOTTOM;
    for (const turn of now.turns.slice(before.turns.length)) box.append(turnBlock(turn));
    state.shownCount += added;
    if (state.factNodes) paintFacts(state.factNodes, now);
    if (atBottom) box.scrollTop = box.scrollHeight;
    else newMessagesChip(box);
    return "appended";
  }

  /* 「下面有新消息」那条回去的路。已经有一条的不再给第二条：两枚一样的提示摞在一起。 */
  function newMessagesChip(box) {
    if (state.newChip !== null || box.querySelectorAll(".new-messages").length > 0) return;
    const chip = el("button", "new-messages", T("transcript.new-messages"));
    chip.type = "button";
    chip.addEventListener("click", () => {
      box.scrollTop = box.scrollHeight;
      chip.hidden = true;
    });
    box.append(chip);
    state.newChip = chip;
  }

  /* -------------------------------------------------- model configuration -- */
  //
  // 这一页问的是一个 agent 自己的 provider 怎么写进它自己的文件里：与 `avenic change`
  // 同一份模板、同一次合并（都在 core 里），所以它是同一件事的第二种看法，不是第二个存储。
  //
  // 它与别的页有一处根本的不同：它手里有用户正在填的表单，而载荷每回答一次就整份重发。
  // 所以草稿住在这一页（state.centerDraft），载荷只在换 agent 的时候用来播种——之后用户
  // 打的字归用户，一次重画不能把打到一半的模型名抹掉。
  //
  // 凭据只出不进：载荷里只有 credentialSet 一个布尔，输入框里的字从表单直奔宿主，不回填、
  // 不重画、不进标题、不进任何一句话——一个能把它印出来的面板就是一个会泄漏它的面板。

  function seedCenter(payload) {
    if (state.centerAgent === (payload?.agent ?? null)) return;
    state.centerAgent = payload?.agent ?? null;
    state.centerCredential = "";
    state.centerFetched = null;
    if (payload === null) {
      state.centerDraft = null;
      return;
    }
    const providers = payload.providers ?? [];
    state.centerDraft = {
      provider: payload.provider ?? providers.find((item) => item.selected)?.id ?? providers[0]?.id ?? "",
      baseUrl: payload.baseUrl ?? "",
      model: payload.model ?? "",
      // null 与空串是两件事：前者是「文件里那个别动」，后者是「我没给」。合并的那一半分得清
      // 这两句，这一页也得分开带着走。
      credential: null,
      roles: {},
      blocks: (payload.blocks ?? []).filter((block) => block.on).map((block) => block.id),
    };
  }

  function centerDraft() {
    const draft = state.centerDraft;
    return {
      provider: draft.provider,
      baseUrl: draft.baseUrl,
      model: draft.model,
      credential: state.centerCredential === "" ? null : state.centerCredential,
      roles: draft.roles ?? {},
      blocks: draft.blocks ?? [],
    };
  }

  // 屏幕上永远不该出现 key。宿主给的 diff 应当已经把它换掉了，但这一页不押那个注：手里有的
  // 那一个（用户刚敲进去的）在这里再抹一道。「文件里已经有一个」的那一种只有读得到文件的
  // 那一边抹得掉，所以那一道归宿主——两边都做，才不靠对方。
  function redact(text) {
    const secret = state.centerCredential;
    const value = String(text ?? "");
    return secret === "" ? value : value.split(secret).join("••••••");
  }

  // 一次问答的回答画在问它的那些按钮下面。失败的形状有好几种（认证、模型、网络、超时、
  // 不是那个 API、被拒），它们是供应商的七种不同的话，所以一句话一种，不合并成「错误」——
  // 用户要修的正是其中某一种。
  function centerResultNode(result, payload) {
    if (result === null || result === undefined) return null;
    const line = el("div", "center-result");
    line.setAttribute("role", "status");
    if (result.kind === "connection") {
      const good = result.state === "connected";
      line.classList.add(good ? "ok" : "bad");
      line.append(icon(good ? "check" : "error"));
      line.append(el("span", "center-result-text", T("center.connection." + result.state)));
      if (typeof result.status === "number") line.append(el("span", "center-hint", String(result.status)));
    } else if (result.kind === "catalog") {
      const good = result.state === "fetched";
      line.classList.add(good ? "ok" : "bad");
      line.append(icon(good ? "check" : "error"));
      // 刷新失败时说的是宿主带回来的那一句原话（超时、401、不是那个 API），没有才退到一句
      // 不编的「网络错误」。
      line.append(el("span", "center-result-text", good
        ? TF("center.catalog-fetched", { count: (result.models ?? []).length })
        : result.note ?? T("center.connection.network-error")));
    } else if (result.kind === "error") {
      line.classList.add("bad");
      line.append(icon("error"));
      line.append(el("span", "center-result-text", result.message));
    } else if (result.kind === "diff") {
      line.classList.add("diff");
      const lines = result.lines ?? [];
      // 「已写入」与「已经一致」只有真的写过那一次才说得出口：预览里的 written 是 false，
      // 一份非空的预览说「没有写入」就把一次预览说成了「不需要改」。
      if (result.written) line.append(el("div", "center-hint", TF("center.written", { file: payload.relative ?? "—" })));
      else if (lines.length === 0) line.append(el("div", "center-hint", TF("center.unchanged", { file: payload.relative ?? "—" })));
      const body = el("pre", "diff-body");
      for (const entry of lines) body.append(el("div", "diff-line diff-" + entry.kind, redact(entry.text)));
      line.append(body);
    }
    return line;
  }

  function centerSection(data) {
    const payload = data.center;
    seedCenter(payload);

    const section = el("section", "section center");
    const head = cardHead({ sectionIcon: "symbol-parameter", titleKey: "center.title", subtitle: T("center.subtitle"), sectionHead: true });
    head.append(el("div", "spacer"));

    // Simple/Advanced 换的是这一页画多少行，不换写进去的东西：高级里那些字段在简单里用的是
    // 同一份预置值，所以两档之间来回切不会丢掉已经填好的答案。
    const modes = el("div", "center-modes");
    for (const [level, key] of [["simple", "center.simple"], ["advanced", "center.advanced"]]) {
      const active = (level === "advanced") === state.centerAdvanced;
      const node = el("button", active ? "btn btn-sm center-mode active" : "btn btn-sm center-mode", T(key));
      node.type = "button";
      node.title = PAIR(key);
      node.setAttribute("aria-pressed", String(active));
      node.addEventListener("click", () => { state.centerAdvanced = level === "advanced"; render(); });
      modes.append(node);
    }
    head.append(modes);
    section.append(head);

    const agents = data.agents ?? [];
    const current = payload?.agent ?? agents[0]?.id;
    section.append(tabStrip({
      label: T("nav.agents"),
      panelId: "center-panel",
      active: current,
      tabs: agents.map((agent) => [agent.id, agent.label]),
      // 换 agent 是这一页的落点之一（同一张页面问另一个 agent 的同一个问题）：页面知道自己
      // 站在哪儿，宿主把那一个的配置读出来重发。
      onSelect: (key) => { if (key !== current) post({ type: "action", action: "centerOpen", agent: key }); },
    }));

    const body = el("div", "section-body center-body");
    body.id = "center-panel";
    body.setAttribute("role", "tabpanel");
    body.setAttribute("aria-label", T("center.title"));
    section.append(body);

    const draft = state.centerDraft;
    if (payload === null || draft === null) {
      body.append(emptyState("center.title", ""));
      return [section];
    }

    const card = agents.find((agent) => agent.id === payload.agent);
    const providers = payload.providers ?? [];
    // 名单是按供应商算的：模型名填错了，之后每一次请求都会失败。载荷里那一份说的是文件
    // 里那一家（宿主按文件读盘），刚取回来的那一份说的是取它时那一家——表单现在在哪一家，
    // 就只摆哪一家的名字。别家的名字摆在一个马上要写成别家的字段底下，不是「有点旧」。
    const fetched = state.centerFetched !== null && state.centerFetched.provider === draft.provider ? state.centerFetched.models : null;
    const models = draft.provider === payload.provider ? payload.models ?? [] : fetched ?? [];
    if (providers.length === 0) {
      // 有的 agent 自己管自己的供应商配置（OpenCode 装在自己的插件注册表里）：Avenic 这里
      // 没有可合并的东西。这时候画一张填不进去的表单才是骗人。
      body.append(emptyState("center.title", card?.detail ?? TF("center.not-owned", { name: payload.label })));
      return [section];
    }

    // 文件里那个算数，前提是这一页还在说这一家：换了供应商，它就成了上一家的钥匙，
    // 留空留下的会是一个配错地址的凭据（宿主也会照同一条规则把这一笔拒掉）。自定义
    // 供应商不在此列：地址是用户自己写的，那扇门收哪把钥匙由他说了算。
    const hasKey = state.centerCredential !== ""
      || (payload.credentialSet === true && (draft.provider === payload.provider || draft.provider === "custom"));
    // 缺什么就说什么：宿主的守卫会把缺字段的问题整条丢掉，而一个点了没反应的按钮和坏掉的
    // 没有区别。所以按钮灰着，旁边写着为什么——不是 tooltip：灰按钮不发光标事件，那上面的
    // tooltip 永远不会出现。
    const blocker = (needs) => {
      if (draft.provider === "") return "center.need-provider";
      if (draft.baseUrl === "") return "center.need-endpoint";
      if (needs.model && draft.model === "") return "center.need-model";
      if (needs.credential && !hasKey) return "center.need-credential";
      return null;
    };
    const blockers = [];
    // 这一页的按钮问的是同一张表的几种答法（连得上吗、要写什么、写下去、有哪些模型），
    // 所以它们的盒子、尺寸与「灰掉的规则」是同一件事，不一样的只有那一次发送。动作名按
    // 字面写在每一次调用上：面板与宿主对表的那一关读的正是这些字面量，一个拼错的字在这里
    // 不报错，只会静默消失一次点击。
    const ask = (key, iconName, needs, onClick, variant) => {
      const node = button({ label: T(key), icon: iconName, size: "sm", variant, onClick });
      blockers.push({ node, needs });
      return node;
    };

    // 这一页写的不是 Avenic 的配置目录，是这个 agent 的原生文件——把它印在第一行，因为
    // 「Apply 会写到哪儿」是这一页最该先回答的问题。认证方式那一枚胶囊用的是宿主卡片的词
    // （Account | API | Native），这一页不自己造词；认的是那一行的键（同 Configure）。
    const facts = el("div", "center-facts");
    const auth = (card?.fields ?? []).find((field) => field.key === "authentication");
    if (auth) facts.append(badge(auth.value, auth.tone));
    const target = el("span", "center-target");
    target.append(icon("file-code"));
    target.append(el("span", undefined, payload.relative ?? "—"));
    if (payload.scope) target.setAttribute("title", payload.scope);
    facts.append(target);
    body.append(facts);
    // 用账号认证的人在看着一张写 API 配置的表单，那么下一步会发生什么得说在前面。
    if (payload.auth === "account") body.append(label(el("p", "center-note"), "center.account-note"));

    const grid = el("div", "center-providers");
    for (const provider of providers) {
      const chosen = provider.id === draft.provider;
      const tile = el("button", chosen ? "provider-tile active" : "provider-tile");
      tile.type = "button";
      tile.setAttribute("aria-pressed", String(chosen));
      tile.append(el("span", "provider-name", provider.name));
      if (provider.baseUrl) tile.append(el("span", "provider-url", provider.baseUrl));
      // 点一次 = 用这个预设填一遍（Create 与 Reset 是同一件事）：已经选中的那个再点一次就是
      // 把改乱的字段要回预置值，所以那一下照发，而不是「已经选中了，什么都不做」。
      tile.addEventListener("click", () => post({ type: "action", action: "centerFill", agent: payload.agent, provider: provider.id }));
      grid.append(tile);
    }
    body.append(label(el("div", "center-caption"), "center.provider"));
    body.append(grid);
    const chosenProvider = providers.find((provider) => provider.id === draft.provider) ?? providers[0];
    body.append(link(T("center.provider-docs"), "link-external", () => post({ type: "action", action: "centerOpenDocs", agent: payload.agent, provider: chosenProvider.id })));

    const endpoint = el("input", "center-input");
    endpoint.type = "text";
    endpoint.value = draft.baseUrl;
    endpoint.placeholder = chosenProvider.baseUrl ?? "https://…";
    endpoint.spellcheck = false;
    endpoint.setAttribute("aria-label", T("center.endpoint"));
    endpoint.addEventListener("input", () => { draft.baseUrl = endpoint.value; paintActions(); });
    body.append(label(el("div", "center-caption"), "center.endpoint"));
    body.append(endpoint);

    body.append(label(el("div", "center-caption"), "center.model"));
    const modelRow = el("div", "center-row");
    const model = el("input", "center-input");
    model.type = "text";
    model.value = draft.model;
    model.spellcheck = false;
    model.setAttribute("aria-label", T("center.model"));
    if (models.length > 0) {
      // 三百个模型名不该变成三百个胶囊：装进 datalist，输入时才出现，不打字就一个都不占。
      const list = el("datalist");
      list.id = "center-models";
      for (const name of models) {
        const option = el("option");
        option.value = name;
        list.append(option);
      }
      model.setAttribute("list", "center-models");
      modelRow.append(list);
    }
    model.addEventListener("input", () => { draft.model = model.value; paintActions(); });
    modelRow.append(model);
    body.append(modelRow);

    // 模型列表是一次明确的请求（一次网络、一次缓存），所以它是这一行上的一个按钮，不是自动
    // 发生的：装个扩展不该顺带问一次供应商。
    const refresh = button({
      label: T("center.refresh-models"),
      icon: "refresh",
      size: "sm",
      onClick: () => post({ type: "action", action: "centerRefreshModels", agent: payload.agent, draft: centerDraft() }),
    });
    blockers.push({ node: refresh, needs: { model: false, credential: true } });
    modelRow.append(refresh);
    // 目录那一行说的是「手里现在有多少」与「上一次问的结果」：上一次失败的那句原话归宿主，
    // 它给了就引它的话，没给就数一遍。
    body.append(el("div", "center-hint", payload.catalog?.note
      ?? (models.length > 0 ? TF("center.catalog-fetched", { count: models.length }) : T("center.models-empty"))));

    body.append(label(el("div", "center-caption"), "center.credential"));
    const credential = el("input", "center-input");
    credential.type = "password";
    // 文件里那个不是拿来显示的东西：输入框空着、占位符说明空着是什么意思，用户要换才敲。
    credential.value = state.centerCredential;
    credential.placeholder = hasKey ? T("center.credential-keep") : "";
    credential.spellcheck = false;
    credential.autocomplete = "off";
    credential.setAttribute("aria-label", T("center.credential"));
    credential.addEventListener("input", () => { state.centerCredential = credential.value; paintActions(); });
    body.append(credential);
    if (payload.credentialSet) body.append(el("p", "center-hint", T("center.credential-set")));

    if (state.centerAdvanced) {
      const roles = payload.roles ?? [];
      if (roles.length > 0) {
        body.append(label(el("div", "center-caption"), "center.roles"));
        const table = el("div", "center-roles");
        for (const role of roles) {
          const row = el("div", "center-role");
          row.append(el("span", "center-role-name", role.id));
          const input = el("input", "center-input");
          input.type = "text";
          input.value = draft.roles[role.id] ?? role.current ?? "";
          input.placeholder = role.recommended ?? "";
          input.spellcheck = false;
          input.setAttribute("aria-label", role.id);
          input.addEventListener("input", () => { draft.roles[role.id] = input.value; });
          row.append(input);
          // 供应商推荐的那一个写在输入框里（占位符的位置），文件里现在的那一个写在框里：
          // 「它现在是什么」和「厂商说用什么」是两件事，混在一起就分不出还没改过。
          row.append(el("span", "center-hint", role.recommended ?? ""));
          table.append(row);
        }
        body.append(table);
      }
      const blocks = payload.blocks ?? [];
      if (blocks.length > 0) {
        body.append(label(el("div", "center-caption"), "center.options"));
        const box = el("div", "center-blocks");
        for (const block of blocks) {
          const item = el("label", "center-block");
          const tick = el("input");
          tick.type = "checkbox";
          tick.checked = draft.blocks.includes(block.id);
          tick.addEventListener("change", () => {
            draft.blocks = tick.checked ? draft.blocks.concat([block.id]) : draft.blocks.filter((id) => id !== block.id);
          });
          item.append(tick);
          item.append(el("span", undefined, block.name));
          box.append(item);
        }
        body.append(box);
      }
    }

    const actions = el("div", "center-actions");
    actions.append(ask("center.test", "zap", { model: true, credential: true },
      () => post({ type: "action", action: "centerTest", agent: payload.agent, draft: centerDraft() })));
    actions.append(ask("center.diff", "file-code", { model: true, credential: true },
      () => post({ type: "action", action: "centerPreview", agent: payload.agent, draft: centerDraft() })));
    actions.append(ask("center.apply", "check", { model: true, credential: true },
      () => post({ type: "action", action: "centerApply", agent: payload.agent, draft: centerDraft() }), "primary"));
    if (state.centerAdvanced && payload.relative !== null) {
      // 配置文件是高级那一档的事（简单那一档的用法是「填完就写完」）；没有文件时这个按钮没有
      // 可开的东西，所以它不画，而不是画一个点了没反应的。
      actions.append(button({
        label: T("center.open-file"),
        icon: "go-to-file",
        size: "sm",
        onClick: () => post({ type: "action", action: "centerOpenFile", agent: payload.agent }),
      }));
    }
    body.append(actions);

    // 灰按钮旁边那一块地方说的就是它为什么灰着：填上一个字段，这一行自己就变了——不重画，
    // 所以正在打的字不会被抹掉。
    const noteBox = el("div", "center-blocker");
    body.append(noteBox);
    function paintActions() {
      let first = null;
      for (const item of blockers) {
        const reason = blocker(item.needs);
        item.node.disabled = reason !== null;
        if (reason !== null && first === null) first = reason;
      }
      noteBox.replaceChildren();
      if (first === null) noteBox.hidden = true;
      else {
        noteBox.hidden = false;
        noteBox.append(label(el("span"), first));
      }
    }
    paintActions();

    const result = centerResultNode(data.centerResult, payload);
    if (result) body.append(result);
    return [section];
  }

  function quickSection(data) {
    return [quickCard(data), activityCard(data)];
  }

  function skillsSection(data) {
    return [skillsCard(data, { wide: true })];
  }

  /* ---------------------------------------------- hooks & notifications page -- */

  // 四种通知的名字与图标。画哪几个由 core 的 kinds 决定（顺序也是它的）：core 将来多出
  // 一种而这一页还没有词的时候，它不在这里冒充一个按钮——一个点下去什么都不发生的方块
  // 和一个坏掉的方块，用户看起来是一样的。
  const HOOK_KINDS = {
    desktop: { key: "hooks.kind-desktop", icon: "bell-dot" },
    openclaw: { key: "hooks.kind-openclaw", icon: "server-process" },
    webhook: { key: "hooks.kind-webhook", icon: "link-external" },
    command: { key: "hooks.kind-command", icon: "terminal" },
  };

  // 这一页问的是两个不同的问题，所以它是两张卡：上面一张是三个 agent 自己的机制（哪个
  // 文件、装没装、它自己有没有条件），下面一张是 Avenic 自己的通知名单。装与响不是同
  // 一件事，「装好了」从来不等于「会通知」。
  function hooksSection(data) {
    const payload = data.hooks;
    const section = el("section", "section hooks");
    const head = cardHead({ sectionIcon: "bell-dot", titleKey: "nav.hooks", subtitle: T("hooks.subtitle"), sectionHead: true });
    head.append(el("div", "spacer"));
    // 画的是「哪一档」：还没打开过这一页时是项目那一档（宿主的默认），打开过就以宿主
    // 读出来的那一档为准（载荷里的 scope 永远是对的）。
    head.append(scopeSwitch(payload === null ? state.hooksScope : payload.scope));
    section.append(head);
    if (payload !== null) state.hooksScope = payload.scope;

    if (payload === null) {
      // 这一页要读的每一个文件都在一个项目里：没有项目的时候，能说的只有这一句。
      section.append(emptyState("hooks.agents-title", T("shell.no-project")));
      return [section];
    }

    const body = el("div", "section-body hooks-body");
    const result = hooksResultNode(data.hooksResult);
    if (result) body.append(result);
    body.append(hookAgentsCard(payload));
    body.append(hookActionsCard(payload));
    section.append(body);
    return [section];
  }

  // 两个作用域的切换。它换的不是「用哪个账号认证」（那是卡片上的 Authentication），而是
  // 这份通知名单写在项目里还是写在这台机器上——换它不碰任何一份认证配置。
  // 点下去先按住这个选择、把落点交给宿主，等它把那一档读完：换一档是一次真的读盘（三个
  // agent 的文件与那一档的名单都不一样），所以这 500 毫秒会说的话由 startReading 说。
  function scopeSwitch(current) {
    const box = el("div", "scope-switch");
    box.setAttribute("role", "group");
    box.setAttribute("aria-label", PAIR("hooks.scope-label"));
    for (const scope of ["project", "global"]) {
      const active = scope === current;
      const node = el("button", active ? "btn btn-sm scope-pick active" : "btn btn-sm scope-pick", T(scope === "project" ? "hooks.scope-project" : "hooks.scope-global"));
      node.type = "button";
      node.title = PAIR("hooks.scope-label");
      node.setAttribute("aria-pressed", String(active));
      node.addEventListener("click", () => {
        if (scope === current) return;
        state.hooksScope = scope;
        startReading();
        render();
        post({ type: "action", action: "hooksOpen", scope });
      });
      box.append(node);
    }
    return box;
  }

  function hookAgentsCard(payload) {
    const card = el("section", "card");
    card.append(cardHead({ sectionIcon: "organization", titleKey: "hooks.agents-title", subtitle: T("hooks.agents-subtitle") }));
    const list = el("div", "hooks-list");
    for (const row of payload.agents) list.append(hookAgentRow(row, payload.scope));
    card.append(list);
    return card;
  }

  // 一个 agent 的一行：它自己的机制、这一档里的文件、装没装。装与卸各自是真实的动作，
  // 所以一行的右边只有一颗按钮——同一件事的两个名字里，灰着的那个是不用画的。
  function hookAgentRow(row, scope) {
    const line = el("div", "hook-row");
    const main = el("div", "row-main");
    const top = el("div", "hook-name-line");
    top.append(agentMark(row.agent));
    top.append(el("span", "hook-name", row.displayName));
    // 版本在这一行上是必须的：「不支持」那一句说的正是它（Unsupported by Codex 1.0.0）。
    if (row.version) top.append(badge(row.version, "muted"));
    // 文件读不出来时不画「Not installed」：那是一句我们不知道的话。品牌色，因为这不是
    // 一个装没装的状态，是一个要人去看一眼的状态。
    if (row.error) top.append(badge(T("hooks.unreadable"), "brand"));
    else top.append(badge(row.installed ? T("hooks.installed") : T("hooks.not-installed"), row.installed ? "green" : "muted"));
    main.append(top);
    const file = el("div", "hook-file");
    file.append(icon("file-code"));
    file.append(el("span", undefined, row.file));
    file.title = row.file;
    main.append(file);
    // 「不支持」是 core 的原话（它按编辑器语言说），它就在这一行上，不让人去别处找。
    if (row.supportNote) main.append(el("p", "hook-note", row.supportNote));
    // 读不动的原因也原话放上来：这句话里有文件名和 errno，而它是这一行唯一能给的下一步。
    if (row.error) main.append(el("p", "hook-note", row.error));
    // 机制自己带的条件（Codex 的钩子要审阅过才会响）：装了也可能是静音的，那就不算装好。
    if (row.caveat) main.append(el("p", "hook-note", row.caveat));
    line.append(main);

    const actions = el("div", "row-actions");
    if (row.error) {
      // 装、卸、预览都要读这个文件，点下去只会得到一次错误弹窗 —— 读不动的行上就一颗
      // 都不给，它的答案已经全在上面那句话里了。
    } else if (row.installed) {
      // 卸不需要「这个版本支持」：文件里有 Avenic 的东西就该拿得掉。
      if (row.supportNote === null) actions.append(button({ label: T("hooks.view-config"), icon: "file-code", size: "sm", onClick: () => post({ type: "action", action: "hookPlan", agent: row.agent, scope }) }));
      actions.append(button({ label: T("hooks.uninstall"), icon: "trash", size: "sm", onClick: () => post({ type: "action", action: "hookUninstall", agent: row.agent, scope }) }));
    } else if (row.supportNote === null) {
      // 装不上就没有「要写什么」可看：预览里那些字一个都不会被写下去，画出来是骗人。
      actions.append(button({ label: T("hooks.view-config"), icon: "file-code", size: "sm", onClick: () => post({ type: "action", action: "hookPlan", agent: row.agent, scope }) }));
      actions.append(button({ label: T("hooks.install"), icon: "download", size: "sm", variant: "primary", onClick: () => post({ type: "action", action: "hookInstall", agent: row.agent, scope }) }));
    }
    line.append(actions);
    return line;
  }

  function hookActionsCard(payload) {
    const card = el("section", "card");
    const head = cardHead({ sectionIcon: "bell-dot", titleKey: "hooks.actions-title", subtitle: T("hooks.actions-subtitle") });
    head.append(el("div", "spacer"));
    // Advanced 只决定「命令类能不能加」，不换这一页写下去的东西：与模型配置中心那一档
    // 同一个道理，档位本身是这一页的事，不必问宿主。
    const level = el("button", state.hooksAdvanced ? "btn btn-sm advanced-pick active" : "btn btn-sm advanced-pick", T("hooks.advanced"));
    level.type = "button";
    level.title = PAIR("hooks.advanced");
    level.setAttribute("aria-pressed", String(state.hooksAdvanced));
    level.addEventListener("click", () => { state.hooksAdvanced = !state.hooksAdvanced; render(); });
    head.append(level);
    card.append(head);

    const list = el("div", "hooks-list");
    if (payload.actions.length === 0) list.append(emptyState("hooks.actions-empty-title", T("hooks.actions-empty-detail")));
    for (const action of payload.actions) list.append(hookActionRow(action, payload.scope));
    card.append(list);

    // 加一条：四种各一颗按钮。命令类是这一页上唯一一条「会在这台机器上跑东西」的选项，
    // 所以要开 Advanced 才能加；灰按钮不发光标事件，所以那句话就在这一行下面。
    const add = el("div", "hook-add");
    add.append(label(el("span", "hook-add-label"), "hooks.add"));
    for (const kind of payload.kinds) {
      const meta = HOOK_KINDS[kind];
      if (meta === undefined) continue;
      add.append(button({
        label: T(meta.key),
        icon: meta.icon,
        size: "sm",
        disabled: kind === "command" && !state.hooksAdvanced,
        onClick: () => post({ type: "action", action: "hookActionAdd", scope: payload.scope, kind }),
      }));
    }
    card.append(add);
    if (payload.kinds.includes("command")) card.append(label(el("p", "hook-warning"), "hooks.command-warning"));

    // core 的门槛（一轮对话至少多少秒才算完成、同一条多久之内只响一次）写在页脚上：
    // 这两个数只从 core 读，页面从不自己记 20 这个数。
    const foot = el("div", "card-foot");
    foot.append(el("span", "foot-note", TF("hooks.threshold-note", { seconds: payload.completedMinSeconds, window: payload.dedupeSeconds })));
    card.append(foot);
    return card;
  }

  // 一条通知：认得出它的字样、它带了什么（有没有令牌、超时多久），以及改与删两颗按钮。
  // 令牌本身从来不在这一页上——这里只说「设了一个」或「从哪个变量取」。
  function hookActionRow(action, scope) {
    const line = el("div", "hook-row");
    const main = el("div", "row-main");
    const meta = HOOK_KINDS[action.kind];
    const top = el("div", "hook-name-line");
    top.append(badge(meta ? T(meta.key) : action.kind, "muted", meta?.icon));
    top.append(el("span", "hook-target", action.target || action.id));
    main.append(top);
    const facts = el("div", "hook-facts");
    facts.append(el("span", "hook-id", action.id));
    if (action.tokenSet) facts.append(badge(T("hooks.token-set"), "muted", "key"));
    else if (action.tokenEnv) facts.append(badge(TF("hooks.token-from", { name: action.tokenEnv }), "muted", "key"));
    if (typeof action.timeoutMs === "number") facts.append(el("span", "hook-timeout", TF("hooks.timeout-value", { ms: action.timeoutMs })));
    main.append(facts);
    line.append(main);

    const buttons = el("div", "row-actions");
    buttons.append(button({ label: T("hooks.edit"), icon: "edit", size: "sm", onClick: () => post({ type: "action", action: "hookActionEdit", scope, id: action.id }) }));
    buttons.append(button({ label: T("hooks.remove"), icon: "trash", size: "sm", onClick: () => post({ type: "action", action: "hookActionRemove", scope, id: action.id }) }));
    line.append(buttons);
    return line;
  }

  // 上一次问出来的答案：一份将写入的配置（逐行、已经由宿主打过码），或者一次写入的结果。
  // 预览那一档是等宽的整块，所以它排在这一页两张卡的前面——点「查看将写入的配置」的人
  // 要看的就是它。页面自己手里没有凭据（令牌只从宿主的密码框走过），所以这里不再抹一遍。
  function hooksResultNode(result) {
    if (result === null || result === undefined) return null;
    const line = el("div", "hook-result");
    line.setAttribute("role", "status");
    if (result.kind === "diff") {
      line.classList.add("diff");
      const lines = result.lines ?? [];
      line.append(el("div", "center-hint", lines.length === 0
        ? TF("hooks.result-plan-empty", { file: result.file })
        : TF("hooks.result-plan", { file: result.file })));
      const body = el("pre", "diff-body");
      for (const entry of lines) body.append(el("div", "diff-line diff-" + entry.kind, entry.text));
      line.append(body);
      return line;
    }
    const good = result.changed;
    line.classList.add(good ? "ok" : "muted");
    line.append(icon(good ? "check" : "history"));
    if (result.kind === "installed") {
      // 装不下那一次（版本在这一行画出来之后变了）说的是 core 自己的那句话，不是「已经装好」。
      line.append(el("span", "center-result-text", result.note
        ?? (good ? TF("hooks.result-installed", { file: result.file }) : TF("hooks.result-already-installed", { file: result.file }))));
    } else if (result.kind === "uninstalled") {
      line.append(el("span", "center-result-text", good ? TF("hooks.result-uninstalled", { file: result.file }) : TF("hooks.result-not-installed", { file: result.file })));
    } else {
      line.append(el("span", "center-result-text", good ? TF("hooks.result-saved", { file: result.file }) : TF("hooks.result-unchanged", { file: result.file })));
    }
    return line;
  }

  /* ------------------------------------------------------ settings & about -- */

  // 这一页不配置任何东西：它说这套安装是什么（版本、路径），以及这个项目的文件在哪里。
  // 每一行右边那个事实只有一个来源（清单、core、已经探过的那一次 CLI），而「可不可点」
  // 是宿主算的——页面的按钮只递回一个 key，它自己手里没有路径。
  function settingsSection(data) {
    const section = el("section", "section settings");
    const about = data.about;
    section.append(cardHead({ sectionIcon: "settings-gear", titleKey: "settings.title", subtitle: T("settings.subtitle"), sectionHead: true }));
    if (about === null) {
      section.append(emptyState("settings.title", ""));
      return [section];
    }
    const body = el("div", "section-body settings-body");
    const card = el("section", "card");
    const rows = el("div", "about-rows");
    for (const row of about.rows) {
      const line = el("div", "about-row");
      line.append(el("span", "about-label", row.label));
      line.append(el("span", "about-value", row.value));
      if (row.reveal) line.append(button({ label: T("settings.show"), icon: "folder-opened", size: "sm", onClick: () => post({ type: "action", action: "revealFile", key: row.key }) }));
      rows.append(line);
    }
    card.append(rows);
    // 唯一一条离开这一页的行：VS Code 自己的设置，按这个扩展过滤（查询字符串在宿主里）。
    const foot = el("div", "card-foot");
    foot.append(link(about.settings.label, "link-external", () => post({ type: "action", action: "openSettings" })));
    card.append(foot);
    body.append(card);
    body.append(label(el("p", "settings-note"), "settings.note"));
    section.append(body);
    return [section];
  }

  /* ------------------------------------------------------------------ shell -- */

  const content = document.getElementById("content");
  const nav = document.getElementById("nav");

  function renderHeader(data) {
    document.getElementById("project-title").textContent = data.project.name ? TF("shell.project-line", { name: data.project.name }) : T("shell.no-project");
    document.getElementById("project-root").textContent = data.project.root ?? "—";
    const pill = document.getElementById("configured-pill");
    const configuredLabel = document.getElementById("configured-label");
    if (data.project.configured) {
      pill.classList.remove("warn");
      configuredLabel.textContent = T("shell.configured");
    } else {
      pill.classList.add("warn");
      configuredLabel.textContent = T("shell.not-configured");
    }
    document.getElementById("last-updated").textContent = data.project.lastUpdated ? TF("shell.last-updated", { at: data.project.lastUpdated }) : "";
    const reconfigure = document.getElementById("reconfigure-button");
    // 标题栏问的是「这个项目怎么配」，答案里没有某一个 agent：那三个各有自己的
    // Change，在卡片上。
    reconfigure.onclick = () => post({ type: "action", action: data.project.configured ? "reconfigure" : "initialize" });
    // 路径后面那个箭头在参考图里就在那儿，所以它得是个真的落点：在文件管理器里打开
    // 这个项目。没开项目时它什么都不打开，也就该是灰的。
    const path = document.getElementById("project-path");
    path.disabled = data.project.root === null;
    path.onclick = () => post({ type: "action", action: "revealProject" });
    // 灰着的那一个也要说得出为什么——没有目录可开的时候，理由就是页头写着的那一句。
    path.title = PAIR(data.project.root === null ? "shell.no-project" : "shell.project-path-title");
    document.getElementById("refresh-button").onclick = () => { startReading(); post({ type: "refresh" }); };
    // 底部这一行说的是这台机器上真正在用的 Avenic CLI：探到之前只写「Avenic」——
    // 一个空着的「v」不是版本。扩展自己的版本不占这一行，悬停时和 CLI 的一起说。
    const version = document.getElementById("version");
    version.textContent = data.version ? `Avenic v${data.version}` : "Avenic";
    const details = data.versionDetails;
    const title = details
      ? `${details.cli ? `Avenic CLI ${details.cli}` : T("cli.missing")}${details.extension ? ` · ${TF("cli.extension-version", { version: details.extension })}` : ""}`
      : "";
    const line = document.getElementById("version-line");
    if (title) line.setAttribute("title", title);
    else line.removeAttribute("title");
    // 侧栏脚下那一枚说的是这台机器上真正在用的那份 CLI 在不在：探到了才是 Ready，探不到就
    // 直接说 PATH 里没有它。一句永远不改的 Ready 是一句假话——它读起来像「可以启动了」，
    // 而那时按 Launch 什么都不会发生。
    const ready = document.getElementById("ready-label");
    const readyDot = document.getElementById("ready-dot");
    if (details !== undefined && details.cli === "") {
      ready.textContent = T("cli.missing");
      ready.title = PAIR("cli.missing");
      if (ZH_VISIBLE) ready.append(el("span", "zh", ZH("cli.missing")));
      readyDot.className = "dot brand";
    } else {
      readyDot.className = "dot";
    }
  }

  /* A read that is still going half a second after it was asked for says so,
   * in place. Nothing is cleared to make room: the window keeps the content it
   * already had, and the answer replaces the line when it lands. Anything
   * quicker than half a second never draws it at all, so the common case costs
   * one timer and no movement. */
  function startReading() {
    clearTimeout(state.readingTimer);
    state.readingTimer = setTimeout(() => {
      state.reading = true;
      render();
    }, 500);
  }

  function stopReading() {
    clearTimeout(state.readingTimer);
    state.readingTimer = null;
    state.reading = false;
  }

  function render(moreTurns = false) {
    const data = state.data;
    if (!data) return;
    // 重画之前先量一下读者原来在哪儿：同一段对话的这一列要落回同样的地方（离结尾多远），
    // 换了一段对话就是新打开的，落它的结尾（kept = 0）。
    // 两个量不是一回事：`kept` 是离结尾有多远，落在结尾的人这个值有一整屏；`away` 是离
    // 屏幕下沿还有多远，落在结尾的人是 0。落点看前者（重画后同样的内容还占着同样的位置），
    // 「下面有新消息」那枚提示看后者（下面真的还有他没读的轮次）。
    const before = state.scrollEl;
    const same = before !== null && state.openId !== null && state.openId === data.transcript?.id;
    const kept = same ? Math.max(0, before.scrollHeight - before.scrollTop) : 0;
    const away = same ? Math.max(0, before.scrollHeight - before.scrollTop - before.clientHeight) : 0;
    // 整页重画之后，上一帧留下的那些节点引用一个都不能用了：实时追加要落到这一帧
    // 画出来的盒子上，否则新消息会加到一个已经不在页面上的地方。
    state.listEl = null;
    state.footEl = null;
    state.scrollEl = null;
    state.viewEl = null;
    state.menuEl = null;
    state.factNodes = null;
    state.newChip = null;
    state.turnsWindow = TURN_PAGE;
    state.shownCount = 0;
    if (data.transcript) state.openId = data.transcript.id;
    renderHeader(data);
    for (const item of nav.querySelectorAll(".nav-item")) {
      const active = item.getAttribute("data-section") === state.section;
      item.classList.toggle("active", active);
      if (active) item.setAttribute("aria-current", "page");
      else item.removeAttribute("aria-current");
    }
    content.replaceChildren();
    if (state.reading) {
      const line = el("div", "reading");
      line.setAttribute("role", "status");
      line.append(icon("refresh"));
      // 这一行是外壳的话，不是某一条数据的话：中文界面里它和侧栏一样多出第二半。
      line.append(label(el("span"), "shell.reading"));
      content.append(line);
    }
    if (state.error) {
      content.append(emptyState("shell.read-failed", state.error));
      return;
    }
    // 设置与关于那一页说的是这套安装本身，一个字都不需要项目（版本、路径、日志去哪儿
    // 看），所以「一个项目都没打开」拦不住它。钩子那一页要读的每一个文件都在项目里，
    // 所以照拦——它有自己的那句话。
    if (data.empty && state.section !== "settings") {
      // 「没打开项目」与「项目还没配置」是两种状态，下一步也不一样：没有目录可写的
      // 时候，「初始化」要打开的那场问答一步都走不下去。
      const opened = data.project.root !== null;
      const box = emptyState(opened ? "shell.not-set-up" : "shell.no-folder", data.empty);
      box.append(opened
        ? button({ label: T("shell.initialize"), variant: "primary", onClick: () => post({ type: "action", action: "initialize" }) })
        : button({ label: T("shell.open-folder"), variant: "primary", onClick: () => post({ type: "action", action: "openProject" }) }));
      content.append(box);
      return;
    }
    const renderers = {
      overview: overviewSection,
      configure: configureSection,
      agents: agentsSection,
      sessions: sessionsSection,
      skills: skillsSection,
      quick: quickSection,
      center: centerSection,
      hooks: hooksSection,
      settings: settingsSection,
    };
    for (const node of (renderers[state.section] ?? overviewSection)(data)) content.append(node);
    landToNewest(kept);
    // 重画之前读者下面还有没读的轮次，而这一次推送确实多出了轮次：给他一条回去的路，
    // 而不是替他翻页。
    if (moreTurns && state.view === "conversation" && state.scrollEl !== null && away > NEAR_BOTTOM) newMessagesChip(state.scrollEl);
  }

  // The sections the shell actually offers, read off the template: the host can
  // only navigate to one of these, and the renderer never invents a section.
  const sections = new Set([...document.querySelectorAll("[data-section]")].map((item) => item.getAttribute("data-section")));

  if (nav) {
    // The two items at the foot of the sidebar are not sections: they open
    // somewhere in the editor (the packaged README, this extension's settings).
    // So section switching only listens to the items that carry a section.
    for (const item of nav.querySelectorAll(".nav-item[data-section]")) {
      item.addEventListener("click", () => go(item.getAttribute("data-section")));
    }
    // The foot of the sidebar names its action in the markup, so the two lists
    // (what the template offers, what the host accepts) stay checkable against
    // each other by reading the files.
    for (const item of nav.querySelectorAll(".nav-item[data-action]")) {
      const name = item.getAttribute("data-action");
      item.addEventListener("click", () => post({ type: "action", action: name }));
    }
  }

  // 一张悬着的菜单不该等到页面重画才收起来：点别处、按 Esc，两件都在这一处写，因为这两件
  // 事不属于任何一张菜单。点它自己（或那个 ⋯）不算「别处」，所以问的是包着它们的那一格。
  document.addEventListener("click", (event) => {
    if (state.menuEl === null) return;
    if (state.menuEl.parentElement?.contains(event.target) === true) return;
    closeMenu();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeMenu();
  });

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || typeof message !== "object") return;
    if (message.type === "data") {
      stopReading();
      const previous = state.data;
      state.data = message.payload;
      state.error = null;
      // 一份载荷不替读者决定他停在哪一页：翻页是这一页自己的动作（宿主想让它翻页时走的是
      // 下面那条 navigate）——载荷到得晚一步，它要是在那一步里替人翻页，刚点了别处的人就
      // 会被拽回去。一次刷新取回来的名单则跟着它自己的供应商留下来：这个载荷之后就不再带
      // 着上一次的结果，而用户还要照这份名单挑一个名字（见 centerSection）。
      const catalog = message.payload?.centerResult;
      if (catalog?.kind === "catalog" && catalog.state === "fetched") state.centerFetched = { provider: catalog.provider, models: catalog.models ?? [] };
      // 正在读的那一段又长了一轮：接在它后面，而不是把整页重画一遍——重画会把读到的
      // 位置、左边那一列的选择、还有输入框里打到一半的字一起抹掉。
      const outcome = appendNewTurns(previous);
      if (outcome === "appended") { if (message.payload?.transcript) state.openId = message.payload.transcript.id; }
      else render(outcome === "grown");
    } else if (message.type === "navigate") {
      // The host naming a landing place ("Sessions" opens the panel on the
      // sessions section) is a local move: no answer is owed back.
      if (sections.has(message.section)) {
        state.section = message.section;
        render();
      }
    } else if (message.type === "draft") {
      // centerFill 的答案是一张**表**，不是状态：预设的值变成用户手里正握着的东西，而握着它
      // 的是这一页。所以它走自己的消息，而不是进载荷——进了载荷，每一次重画都会拿文件里的
      // 旧值去和用户正在打的字抢同一个位置。
      if (state.centerDraft === null || typeof message.draft !== "object" || message.draft === null) return;
      state.centerDraft = message.draft;
      state.centerCredential = message.draft.credential ?? "";
      render();
    } else if (message.type === "status") {
      // 一次启动的开始或结束：这不需要重读项目，也不该重画页面。
      paintRuns(message.runs);
    } else if (message.type === "error") {
      stopReading();
      state.error = typeof message.message === "string" ? message.message : T("shell.unknown-error");
      render();
    }
  });

  // 首帧由模板给出（英文），这里只是把同一张表的另一半补上：中文界面里可见，其它
  // 界面里进 tooltip 与无障碍名。数据还没到，所以这一步不碰任何要等数据的东西。
  paintShell();
  post({ type: "ready" });
})();
