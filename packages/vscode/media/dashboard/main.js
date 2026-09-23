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
    view: "conversation",
    listEl: null,
    footEl: null,
    transcriptEl: null,
    viewEl: null,
    menuEl: null,
    factNodes: null,
    newChip: null,
  };

  // 一次启动跑着没跑着，是 core 的一句话，这里只是它的英文：没有第三档，「不确定」
  // 不是一种状态——面板要么知道它在跑，要么知道它不在。idle 不说话（胶囊消失），
  // 因为「没在跑」是默认，不是一条新闻。
  const RUN_LABELS = { running: "Running", interrupted: "Interrupted" };

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
      const auth = (agent.fields ?? []).find((field) => field.label === "Authentication");
      if (auth) fields.append(fieldRow(auth, agent.id));
      fields.append(fieldRow({ label: "Sessions", icon: "folder", kind: "badge", tone: agent.sessions.tone, value: agent.sessions.label }, agent.id));
      fields.append(fieldRow({ label: "History", icon: "history", kind: "badge", tone: agent.history.tone, value: agent.history.label }, agent.id));
      card.append(fields);
      return card;
    }

    const canLaunch = agent.actions?.launch !== false && agent.ready;
    head.append(button({
      label: "Launch",
      icon: "play",
      iconTone: "brand",
      size: "sm",
      disabled: !canLaunch,
      onClick: () => post({ type: "action", action: "launch", agent: agent.id }),
    }));
    head.append(button({
      label: "Change",
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
      label: "Sessions",
      icon: "folder",
      kind: "badge",
      tone: agent.sessions.tone,
      // The card names the scope and stops there. The count is the tab's job
      // ("Claude (8)"), and the reference keeps the two apart.
      value: agent.sessions.label,
    }, agent.id));
    runtime.append(fieldRow({ label: "History", icon: "history", kind: "badge", tone: agent.history.tone, value: agent.history.label }, agent.id));
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
      label: "Continue",
      icon: "play",
      size: "sm",
      onClick: () => (options?.native
        ? post({ type: "action", action: "continueNative", agent: options.native, id: row.id })
        : post({ type: "action", action: "continueShared", id: row.id })),
    }));
    if (options?.native) {
      actions.append(button({
        iconOnly: true,
        size: "sm",
        icon: "ellipsis",
        title: "Session actions",
        onClick: () => post({ type: "action", action: "viewSession", id: row.id }),
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
    line.append(badge(skill.enabled ? "Enabled" : "Disabled", skill.enabled ? "green" : "muted"));
    line.append(button({ iconOnly: true, size: "sm", icon: "ellipsis", title: "Skill actions", onClick: () => post({ type: "action", action: "manageSkills" }) }));
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
    titles.append(el("div", "card-title", options.title));
    if (options.subtitle) titles.append(el("div", "card-sub", options.subtitle));
    head.append(titles);
    return head;
  }

  /* -------------------------------------------------------------- sections -- */

  function overviewSection(data) {
    const nodes = [];

    // --- Agent configuration -------------------------------------------------
    const agents = el("section", "section");
    const head = cardHead({ sectionIcon: "organization", title: "Agent Configuration", subtitle: "Authentication, configuration and sessions for each agent.", sectionHead: true });
    head.append(el("div", "spacer"));
    head.append(button({ label: "Open in Terminal", icon: "terminal", onClick: () => post({ type: "action", action: "openInTerminal" }) }));
    head.append(button({ iconOnly: true, icon: "ellipsis", title: "Activity log", onClick: () => post({ type: "action", action: "viewLogs" }) }));
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
    const head = cardHead({ sectionIcon: "share", title: "Shared Sessions", subtitle: "Native sessions and projections for each agent." });
    head.append(el("div", "spacer"));
    if (data.history.mode === "shared") {
      // Nothing to continue means nothing to click: the host drops an action
      // whose id it cannot validate, so the button says so instead of sending one.
      const newest = data.shared.rows[0];
      head.append(button({
        label: "Continue in New Terminal",
        // The reference draws this one as a "take it from here" download glyph,
        // not the play it uses for Launch.
        icon: "download",
        size: "sm",
        variant: "brand",
        disabled: newest === undefined,
        onClick: () => post({ type: "action", action: "continueShared", id: newest.id }),
      }));
    } else {
      head.append(button({ label: "Switch to Shared", icon: "history", size: "sm", variant: "brand", onClick: () => post({ type: "action", action: "switchHistory" }) }));
    }
    head.append(button({ iconOnly: true, icon: "ellipsis", size: "sm", title: "All shared sessions", onClick: () => go("sessions", "shared") }));
    card.append(head);

    const list = el("div", "list-box");
    if (data.history.mode !== "shared") {
      list.append(emptyState("Shared history is off", "This project keeps each agent's sessions isolated. Switch to Shared and the conversations all three can pick up appear here."));
    } else if (data.shared.rows.length === 0) {
      list.append(emptyState("No shared sessions yet", "Start an agent session and import it — the conversation shows up here, ready to continue."));
    } else {
      for (const item of data.shared.rows) list.append(sessionRow(item));
    }
    card.append(list);

    card.append(listFoot(data, {
      label: `View All Shared Sessions (${data.shared.total})`,
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
    else if (options.total > options.shown) foot.append(el("span", "foot-note", `Showing the newest ${options.shown} of ${options.total}.`));
    return foot;
  }

  function projectCard(data) {
    const card = el("section", "card");
    const head = cardHead({ sectionIcon: "database", title: "Agent Sessions", subtitle: "Independent histories for each agent." });
    head.append(el("div", "spacer"));

    // The agent tabs sit in the head, not on their own strip.
    const active = state.agentTab ?? data.agents.find((agent) => data.native[agent.id]?.rows.length)?.id ?? data.agents[0]?.id;
    state.agentTab = active;
    head.append(tabStrip({
      label: "Agents with sessions in this project",
      panelId: "native-sessions",
      inline: true,
      active,
      // Short label: the reference's tabs read "Claude (8)", not "Claude Code (8)".
      tabs: data.agents.map((agent) => [agent.id, `${agent.short ?? agent.label} (${data.native[agent.id]?.total ?? 0})`]),
      onSelect: (key) => { state.agentTab = key; render(); },
    }));
    card.append(head);

    const list = tabPanel("native-sessions", `Sessions for ${shortLabelOf(active)}`);
    const rows = data.native[active]?.rows ?? [];
    if (rows.length === 0) {
      list.append(emptyState("No sessions here yet", `${shortLabelOf(active)} has no conversation in this project to continue.`));
    } else {
      for (const item of rows) list.append(sessionRow(item, { native: active, showAgents: false }));
    }
    card.append(list);

    card.append(listFoot(data, {
      label: "View All Agent Sessions",
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
    const head = cardHead({ sectionIcon: "package", title: "Skills", subtitle: "Manage and import skills for all agents.", compact: true });
    head.append(el("div", "spacer"));
    head.append(button({ label: "Import Skill", icon: "download", onClick: () => post({ type: "action", action: "importSkill" }) }));
    head.append(button({ label: "Open Folder", icon: "folder-opened", onClick: () => post({ type: "action", action: "openFolder" }) }));
    head.append(button({ iconOnly: true, icon: "ellipsis", title: "Skill actions", onClick: () => post({ type: "action", action: "manageSkills" }) }));
    card.append(head);

    // Counts only where the reference carries them: Installed is tallied, Packs
    // and the registry are not. Whether the registry is synced is said inside
    // its pane, not by renaming the tab on the way in.
    card.append(tabStrip({
      label: "Skill sources",
      panelId: "skills-panel",
      active: state.skillsTab,
      tabs: [
        ["installed", `Installed (${data.skills.installedTotal})`],
        ["packs", "Available Packs"],
        ["hub", "Official Registry"],
      ],
      onSelect: (key) => { state.skillsTab = key; render(); },
    }));

    const list = tabPanel("skills-panel", "Skills from the selected source");
    if (state.skillsTab === "packs") {
      if (data.skills.packs.length === 0) list.append(emptyState("No packs available", "Sync the registry and the packs you can install show up here."));
      for (const pack of data.skills.packs) {
        const line = el("div", "list-row");
        line.append(icon("package", "list-icon"));
        const main = el("div", "row-main");
        main.append(el("span", "skill-name", pack.name));
        main.append(el("span", "skill-desc", pack.description));
        line.append(main);
        line.append(badge(`${pack.count} skills`, "muted"));
        // 装的是这一个 pack：面板把它的 id 交给宿主已有的那条安装命令，而不是把用户
        // 再丢回选择器里——那等于让他在自己刚点过的地方重新选一次。
        line.append(button({ label: pack.installed ? "Installed" : "Install", size: "sm", disabled: pack.installed, onClick: () => post({ type: "action", action: "installPack", pack: pack.id }) }));
        list.append(line);
      }
    } else if (state.skillsTab === "hub") {
      const line = el("div", "list-row");
      line.append(icon("database", "list-icon"));
      const main = el("div", "row-main");
      main.append(el("span", "skill-name", data.hub.spec ?? "No registry configured"));
      // 三态是 core 的答案：拉过一次但落后于远端时，说「已同步」等于把 stale 说成
      // current。面板照抄它的词，不自己把三态压成一个布尔。
      const revision = data.hub.revision ? data.hub.revision.slice(0, 12) : null;
      main.append(el("span", "skill-desc", revision === null
        ? "Never synced"
        : data.hub.state === "current" ? `${revision} · up to date` : `${revision} · stale`));
      line.append(main);
      line.append(button({ label: data.hub.state === "current" ? "Sync again" : "Sync", size: "sm", onClick: () => post({ type: "action", action: "syncHub" }) }));
      list.append(line);
    } else if (data.skills.installed.length === 0) {
      list.append(emptyState("No skills installed", "Import one from owner/repo, or install a pack from the registry."));
    } else {
      for (const skill of data.skills.installed) list.append(skillRow(skill));
    }
    card.append(list);

    card.append(listFoot(data, {
      label: "View All Skills",
      section: "skills",
      shown: data.skills.installed.length,
      total: data.skills.installedTotal,
    }));
    return card;
  }

  function quickCard(data) {
    const card = el("section", "card");
    card.append(cardHead({ sectionIcon: "zap", title: "Quick Actions", subtitle: "Common tasks and workflows.", compact: true }));
    const body = el("div", "card-body");
    const grid = el("div", "quick-grid");
    const ready = (agentId) => data.agents.find((agent) => agent.id === agentId)?.actions?.launch === true;
    const sharedId = data.shared.rows[0]?.id;
    const definitions = [
      { label: "New Claude Session", mark: "claude", action: { action: "launch", agent: "claude" }, enabled: ready("claude") },
      { label: "New Codex Session", mark: "codex", action: { action: "launch", agent: "codex" }, enabled: ready("codex") },
      { label: "New OpenCode Session", mark: "opencode", action: { action: "launch", agent: "opencode" }, enabled: ready("opencode") },
      // 共享历史是这个项目的一种设置：隔离模式下拉起一条共享会话，CLI 会直接拒绝
      // （它的会话菜单在隔离模式下连这一项都不列），所以这里也不给一条走不通的路。
      { label: "Continue Shared Session", icon: "share", action: { action: "continueShared", id: sharedId }, enabled: data.history.mode === "shared" && sharedId !== undefined },
      { label: "Manage Skills", icon: "package", action: { action: "manageSkills" }, enabled: true },
      { label: "View Logs", icon: "list", action: { action: "viewLogs" }, enabled: true },
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
      if (!definition.enabled) node.disabled = true;
      else {
        const message = definition.action;
        node.addEventListener("click", () => post(Object.assign({ type: "action" }, message)));
      }
      grid.append(node);
    }
    body.append(grid);
    card.append(body);
    return card;
  }

  function activityCard(data) {
    const card = el("section", "card");
    card.append(cardHead({ sectionIcon: "clockface", title: "Recent Activity", subtitle: "View output and status.", inlineSub: true }));
    const list = el("div", "activity-list");
    if (data.activity.length === 0) {
      list.append(emptyState("No recent activity.", "What you do in this panel shows up here, newest first."));
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
      more.append(link("View All Activity", "chevron-right", () => post({ type: "action", action: "viewLogs" })));
      list.append(more);
    }
    card.append(list);
    return card;
  }

  function emptyState(title, detail) {
    const box = el("div", "empty");
    box.append(el("strong", undefined, title));
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
    pane.setAttribute("aria-label", "Sessions");
    // 产品词是这两个：Shared Sessions 是这个项目跨 agent 的那一份历史，Agent Sessions
    // 是某个 agent 自己那份原生会话。两句话各自说清它列的是什么。
    pane.append(cardHead({
      sectionIcon: shared ? "share" : "database",
      title: shared ? "Shared Sessions" : "Agent Sessions",
      subtitle: shared ? "Native sessions and projections for each agent." : "Independent histories for each agent.",
    }));

    pane.append(tabStrip({
      label: "Which history to list",
      panelId: "sessions-list-pane",
      active: state.sessionsTab,
      tabs: [["shared", "Shared"], ["agent", "Agent"]],
      // 换一半是这一页自己的事（它记着用户站在哪一半），顺带告诉宿主它现在停在哪儿。
      onSelect: (key) => { if (key !== state.sessionsTab) go("sessions", key); },
    }));

    // 搜的是已经拿到的那一列，按标题与元数据过一遍：问宿主重新读一次盘不叫搜索。
    const search = el("input", "session-search");
    search.type = "search";
    search.value = state.search;
    search.placeholder = "Search sessions";
    search.setAttribute("aria-label", "Search sessions");
    search.addEventListener("input", () => { state.search = search.value; paintRows(); });
    pane.append(search);

    if (!shared) pane.append(agentStrip(data));

    const list = el("div", "sessions-list");
    list.id = "sessions-agent-list";
    list.setAttribute("role", "tabpanel");
    list.setAttribute("aria-label", shared ? "Shared sessions" : `Sessions for ${shortLabelOf(activeAgent(data))}`);
    list.append(...listChildren(data));
    pane.append(list);
    state.listEl = list;

    const foot = el("div", "sessions-foot");
    pane.append(foot);
    state.footEl = foot;
    paintFoot();

    // 两个词的区别要有一句话，否则「Shared Sessions」和「Agent Sessions」看起来
    // 只是同一个东西的两种叫法。
    pane.append(el("div", "sessions-note", "Shared Sessions hold the conversation every agent can pick up; Agent Sessions are the ones an agent's own CLI opens."));
    return pane;
  }

  // Agent 那一半列的是某一个 agent 自己的会话，所以它还要问是哪一个。这是换列内容
  // 的开关，和上面那一条一样是标签组——画成芯片而角色上不是，读屏软件读到的是三枚
  // 互不相干的按钮。
  function agentStrip(data) {
    const active = state.agentTab = activeAgent(data);
    return tabStrip({
      label: "Agents with sessions in this project",
      panelId: "sessions-agent-list",
      inline: true,
      active,
      // 短名：参考图的标签写的是「Claude (8)」，不是「Claude Code (8)」。
      tabs: (data.agents ?? []).map((agent) => [agent.id, `${agent.short ?? agent.label} (${data.native?.[agent.id]?.total ?? 0})`]),
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
    if (source.length > 0) return [emptyState("No session matches", `Nothing in this list has “${state.search.trim()}” in its title, its agents or its time.`)];
    return [shared
      ? emptyState("No shared sessions yet.", "Start an agent session and import it — the conversation shows up here, ready to continue.")
      : emptyState("No sessions here yet.", `${shortLabelOf(activeAgent(data))} has no conversation in this project to continue.`)];
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
      ? `Showing the newest ${rows.length} of ${total}.`
      : `${rows.length} of ${total} sessions match.`));
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
    if (row.active) meta.append(el("span", "active-chip", "Active"));
    meta.append(rowRunPill(row.agents, row.sync?.running === true));
    if (row.sync?.state === "stale") meta.append(el("span", "stale-chip", "Stale"));
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
      view.append(emptyState("Nothing is open yet", "Pick a session on the left and its conversation is read here."));
      return view;
    }

    const head = el("div", "session-head");
    const top = el("div", "session-head-top");
    const titles = el("div", "session-titles");
    titles.append(el("div", "session-title", titleOf(transcript)));
    // 一段对话是不是「三个 agent 共用的那一份」，取决于这个项目的设置。隔离模式下把
    // 同一条会话说成共享历史，就是在替这个项目回答它没做的那个选择。
    titles.append(el("div", "session-sub", data.history.mode === "shared"
      ? "Shared history — the same conversation every agent sees."
      : "This project keeps its sessions isolated."));
    top.append(titles);
    top.append(el("div", "spacer"));

    const actions = el("div", "session-actions");
    actions.append(button({
      label: "Continue",
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
        label: "Set as Active",
        icon: "check",
        size: "sm",
        onClick: () => post({ type: "action", action: "setActive", id: transcript.id }),
      }));
    }

    // ⋯ 后面是这一页自己的两种读法：Raw 是这些轮的原样，Diagnostics 是这条会话的
    // 投影说过什么。两者都在已到的载荷里——一个点了要等宿主回包的菜单项，等不到就是
    // 死的，而这两个视图永远不会有第二条答案。
    const menu = el("div", "session-menu");
    menu.hidden = true;
    menu.append(button({ label: "Raw", size: "sm", onClick: () => showView("raw") }));
    menu.append(button({ label: "Diagnostics", size: "sm", onClick: () => showView("diagnostics") }));
    actions.append(button({
      iconOnly: true, size: "sm", icon: "ellipsis", title: "Session actions",
      onClick: () => { menu.hidden = !menu.hidden; },
    }));
    actions.append(menu);
    top.append(actions);
    head.append(top);

    const facts = el("div", "session-facts");
    const fact = (label) => {
      const value = el("span", "fact-value");
      facts.append(el("div", "session-fact", label));
      facts.append(value);
      return value;
    };
    fact("Participants").textContent = (transcript.participants ?? []).join(", ");
    const updated = fact("Updated");
    const events = fact("Event count");
    const sync = fact("Sync state");
    paintFacts({ updated, events, sync }, transcript);
    head.append(facts);
    view.append(head);

    state.factNodes = { updated, events, sync };
    state.menuEl = menu;
    const body = el("div", "session-view-body");
    body.append(conversationBox(transcript));
    state.viewEl = body;
    view.append(body);
    return view;
  }

  // 头部那几格是实时更新里唯一会变的东西：事件数、更新时间、同步状态。它们是同一批
  // 节点，改的是字而不是重建——重建会让正在读的人丢掉位置。
  function paintFacts(nodes, transcript) {
    nodes.events.textContent = `${transcript.eventCount} events`;
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
    state.transcriptEl = box;
    return box;
  }

  function paintTurns(box, turns) {
    const shown = turns.slice(-state.turnsWindow);
    state.shownCount = shown.length;
    const nodes = [];
    // 没画全部的时候要说出来：一列看起来完整的对话和一条被截断的，字面上没有区别。
    if (turns.length > shown.length) nodes.push(el("div", "turn-note", `Showing the newest ${shown.length} of ${turns.length} turns.`));
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
    row.append(el("span", "tool-verb", tool.kind === "call" ? "ran" : "returned"));
    row.append(el("span", "tool-name", tool.name));
    if (tool.detail) row.append(el("span", "tool-detail", `(${tool.detail})`));
    return row;
  }

  function showView(kind) {
    const transcript = state.data?.transcript;
    const body = state.viewEl;
    if (!transcript || !body) return;
    state.view = kind;
    if (state.menuEl) state.menuEl.hidden = true;
    if (kind === "raw") {
      state.transcriptEl = null;
      body.replaceChildren(rawView(transcript));
      return;
    }
    if (kind === "diagnostics") {
      state.transcriptEl = null;
      body.replaceChildren(diagnosticsView(transcript));
      return;
    }
    // 回到对话：这一列重新画一遍，原来读到哪儿就没了——这是换一种读法的代价。
    state.turnsWindow = TURN_PAGE;
    body.replaceChildren(conversationBox(transcript));
    landToNewest();
  }

  /* 一列刚画好的对话落在它的结尾。位置在重画里本来就丢了，丢的时候落在开头等于把
   * 读的人送回一段他早读过的地方——一条长会话打开来看到的是第 100 轮之前的那一段，
   * 而右边那颗「继续」按钮说的是最新的那一句。读的时候才会写这一下：画的时候这些
   * 节点还没进文档，浏览器算不出高度（真实的 scrollHeight 要挂上去才有）。 */
  function landToNewest() {
    const box = state.transcriptEl;
    if (box) box.scrollTop = box.scrollHeight;
  }

  function rawView(transcript) {
    const box = el("div", "raw-view");
    box.append(el("div", "view-note", "The turns this host sent, as they arrived — nothing added, nothing rewritten."));
    // 载荷里只有语义上的那几轮：控制行与 CLI 自己的回显在宿主那侧就没进来，所以这里
    // 不筛原始记录——它画的就是它拿到的。
    for (const turn of transcript.turns ?? []) box.append(el("div", "raw-line", JSON.stringify(turn)));
    return box;
  }

  function diagnosticsView(transcript) {
    const box = el("div", "diagnostics-view");
    const warnings = transcript.diagnostics?.warnings ?? [];
    const notes = transcript.diagnostics?.notes ?? [];
    box.append(el("div", "view-note", `Projection for this conversation: ${transcript.sync?.label ?? "unknown"}.`));
    if (warnings.length === 0 && notes.length === 0) {
      box.append(emptyState("Nothing to report", "No projection of this conversation has anything to say about it."));
      return box;
    }
    for (const [tone, lines] of [["Warning", warnings], ["Note", notes]]) {
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
   * 回去的路，点了才下去。本来就在底部的人跟着走，那才是「实时」。 */
  function appendNewTurns(previous) {
    const before = previous?.transcript;
    const now = state.data?.transcript;
    if (state.section !== "sessions" || state.transcriptEl === null || state.view !== "conversation") return false;
    if (!before || !now || before.id !== now.id) return false;
    const added = (now.turns ?? []).length - (before.turns ?? []).length;
    if (added <= 0) return false;
    // 前面那几轮必须是同一批：换了一段对话就整段重画，不能把新的一轮接到别人后面。
    for (let index = 0; index < before.turns.length; index += 1) if (before.turns[index].id !== now.turns[index].id) return false;
    // 窗口已经满了：重画一次，窗口跟着挪一位——多出来的那些本来就该从最上面掉出去。
    if (state.shownCount + added > state.turnsWindow) return false;
    const box = state.transcriptEl;
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight <= NEAR_BOTTOM;
    for (const turn of now.turns.slice(before.turns.length)) box.append(turnBlock(turn));
    state.shownCount += added;
    if (state.factNodes) paintFacts(state.factNodes, now);
    if (atBottom) box.scrollTop = box.scrollHeight;
    else if (state.newChip === null && box.querySelectorAll(".new-messages").length === 0) {
      const chip = el("button", "new-messages", "New messages ↓");
      chip.type = "button";
      chip.addEventListener("click", () => {
        box.scrollTop = box.scrollHeight;
        chip.hidden = true;
      });
      box.append(chip);
      state.newChip = chip;
    }
    return true;
  }

  function quickSection(data) {
    return [quickCard(data), activityCard(data)];
  }

  function skillsSection(data) {
    return [skillsCard(data, { wide: true })];
  }

  /* ------------------------------------------------------------------ shell -- */

  const content = document.getElementById("content");
  const nav = document.getElementById("nav");

  function renderHeader(data) {
    document.getElementById("project-title").textContent = data.project.name ? `Project: ${data.project.name}` : "No project open";
    document.getElementById("project-root").textContent = data.project.root ?? "—";
    const pill = document.getElementById("configured-pill");
    const configuredLabel = document.getElementById("configured-label");
    if (data.project.configured) {
      pill.classList.remove("warn");
      configuredLabel.textContent = "Avenic Configured";
    } else {
      pill.classList.add("warn");
      configuredLabel.textContent = "Not Configured";
    }
    document.getElementById("last-updated").textContent = data.project.lastUpdated ? `Last updated: ${data.project.lastUpdated}` : "";
    const reconfigure = document.getElementById("reconfigure-button");
    // 标题栏问的是「这个项目怎么配」，答案里没有某一个 agent：那三个各有自己的
    // Change，在卡片上。
    reconfigure.onclick = () => post({ type: "action", action: data.project.configured ? "reconfigure" : "initialize" });
    // 路径后面那个箭头在参考图里就在那儿，所以它得是个真的落点：在文件管理器里打开
    // 这个项目。没开项目时它什么都不打开，也就该是灰的。
    const path = document.getElementById("project-path");
    path.disabled = data.project.root === null;
    path.onclick = () => post({ type: "action", action: "revealProject" });
    document.getElementById("refresh-button").onclick = () => { startReading(); post({ type: "refresh" }); };
    // 底部这一行说的是这台机器上真正在用的 Avenic CLI：探到之前只写「Avenic」——
    // 一个空着的「v」不是版本。扩展自己的版本不占这一行，悬停时和 CLI 的一起说。
    const version = document.getElementById("version");
    version.textContent = data.version ? `Avenic v${data.version}` : "Avenic";
    const details = data.versionDetails;
    const title = details
      ? `${details.cli ? `Avenic CLI ${details.cli}` : "Avenic CLI not on PATH"}${details.extension ? ` · VS Code extension ${details.extension}` : ""}`
      : "";
    const line = document.getElementById("version-line");
    if (title) line.setAttribute("title", title);
    else line.removeAttribute("title");
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

  function render() {
    const data = state.data;
    if (!data) return;
    // 整页重画之后，上一帧留下的那些节点引用一个都不能用了：实时追加要落到这一帧
    // 画出来的盒子上，否则新消息会加到一个已经不在页面上的地方。
    state.listEl = null;
    state.footEl = null;
    state.transcriptEl = null;
    state.viewEl = null;
    state.menuEl = null;
    state.factNodes = null;
    state.newChip = null;
    state.view = "conversation";
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
      line.append(el("span", undefined, "Reading the project…"));
      content.append(line);
    }
    if (state.error) {
      content.append(emptyState("Could not read the project", state.error));
      return;
    }
    if (data.empty) {
      // 「没打开项目」与「项目还没配置」是两种状态，下一步也不一样：没有目录可写的
      // 时候，「初始化」要打开的那场问答一步都走不下去。
      const opened = data.project.root !== null;
      const box = emptyState(opened ? "Avenic is not set up here" : "No project folder is open", data.empty);
      box.append(opened
        ? button({ label: "Initialize Avenic", variant: "primary", onClick: () => post({ type: "action", action: "initialize" }) })
        : button({ label: "Open Folder", variant: "primary", onClick: () => post({ type: "action", action: "openProject" }) }));
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
    };
    for (const node of (renderers[state.section] ?? overviewSection)(data)) content.append(node);
    landToNewest();
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

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || typeof message !== "object") return;
    if (message.type === "data") {
      stopReading();
      const previous = state.data;
      state.data = message.payload;
      state.error = null;
      if (message.section) state.section = message.section;
      // 正在读的那一段又长了一轮：接在它后面，而不是把整页重画一遍——重画会把读到的
      // 位置、左边那一列的选择、还有输入框里打到一半的字一起抹掉。
      if (!appendNewTurns(previous)) render();
      else if (message.payload?.transcript) state.openId = message.payload.transcript.id;
    } else if (message.type === "navigate") {
      // The host naming a landing place ("Sessions" opens the panel on the
      // sessions section) is a local move: no answer is owed back.
      if (sections.has(message.section)) {
        state.section = message.section;
        render();
      }
    } else if (message.type === "status") {
      // 一次启动的开始或结束：这不需要重读项目，也不该重画页面。
      paintRuns(message.runs);
    } else if (message.type === "error") {
      stopReading();
      state.error = typeof message.message === "string" ? message.message : "Unknown error";
      render();
    }
  });

  post({ type: "ready" });
})();
