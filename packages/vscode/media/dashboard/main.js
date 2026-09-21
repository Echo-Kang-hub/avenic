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
  };

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
  function go(section) {
    if (!sections.has(section)) return;
    state.section = section;
    render();
    post({ type: "navigate", section });
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
  // The Codex mark's own outline. It is stroked, not filled: at 46px a filled
  // knot reads as a blob, and the reference draws the weave as a ring with the
  // middle left open. This is the mark's outer contour alone — the prompt glyph
  // it cuts out is not part of the silhouette.
  const CODEX_RING = "M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457z";

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
      const rays = svgNode("g", Object.assign({ "stroke-width": "1.6", "stroke-linecap": "round" }, stroke));
      for (const d of ["M8 2.2v11.6", "M2.2 8h11.6", "M3.9 3.9l8.2 8.2", "M12.1 3.9L3.9 12.1"]) {
        rays.append(svgNode("path", { d }));
      }
      svg.append(rays);
    } else if (agentId === "codex") {
      svg.append(svgNode("path", Object.assign({ d: CODEX_RING, "stroke-width": "2.1", "stroke-linejoin": "round" }, stroke)));
    } else {
      // OpenCode's mark is the loop in its name: two rings sharing one edge.
      for (const cx of ["6.7", "17.3"]) {
        svg.append(svgNode("circle", Object.assign({ cx, cy: "12", r: "5.4", "stroke-width": "2.3" }, stroke)));
      }
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
    const head = cardHead({ sectionIcon: "organization", title: "Agent Configuration", subtitle: "Authentication, model configuration and sessions for each agent.", sectionHead: true });
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
    const bottom = el("div", "cards-row");
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
    const head = cardHead({ sectionIcon: "share", title: "Shared Sessions", subtitle: "Available across all configured agents." });
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
    head.append(button({ iconOnly: true, icon: "ellipsis", size: "sm", title: "All shared sessions", onClick: () => post({ type: "navigate", section: "sessions" }) }));
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
      shown: data.shared.rows.length,
      total: data.shared.total,
    }));
    return card;
  }

  /* 「View All」只在概览上是一句话：到了它指向的那一页，同一个链接就成了原地打转。
   * 取而代之的是那一页必须自己说清楚它列了多少条——一张只画前 50 行、却不说这个数
   * 的列表，看起来和「总共就这么多」没有区别。 */
  function listFoot(data, options) {
    const foot = el("div", options.compact ? "card-foot compact" : "card-foot");
    if (!data.detail) foot.append(link(options.label, "chevron-right", () => go(options.section)));
    else if (options.total > options.shown) foot.append(el("span", "foot-note", `Showing the newest ${options.shown} of ${options.total}.`));
    return foot;
  }

  function projectCard(data) {
    const card = el("section", "card");
    const head = cardHead({ sectionIcon: "database", title: "Project Sessions", subtitle: "Isolated to this project." });
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
      label: "View All Project Sessions",
      section: "sessions",
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

  function sessionsSection(data) {
    const nodes = [];
    const row = el("div", "cards-row");
    row.append(sharedCard(data));
    row.append(projectCard(data));
    nodes.push(row);
    if (data.transcript) nodes.push(transcriptCard(data.transcript, data.history.mode));
    return nodes;
  }

  function transcriptCard(transcript, mode) {
    const shared = mode === "shared";
    const card = el("section", "card");
    const head = cardHead({
      sectionIcon: "file-text",
      title: transcript.title,
      // 一段对话是不是「三个 agent 共用的那一份」，取决于这个项目的设置。隔离模式
      // 下把同一条会话说成共享历史，就是在替这个项目回答它没做的那个选择。
      subtitle: shared ? "Shared history — the same conversation every agent sees." : "This project keeps its sessions isolated — read-only here.",
    });
    // The active session is the one `avenic continue` picks up when nobody names
    // a conversation, so marking it is a real action. On the session that is
    // already active the button would only ask the user to confirm what holds.
    // 隔离模式下 CLI 不提供这一项（它的菜单只在 shared 时列出「设为 Active」），
    // 于是这里也不提供——一条点了会被拒绝的按钮不是功能。
    if (shared && !transcript.active) {
      head.append(el("div", "spacer"));
      head.append(button({
        label: "Set as Active",
        icon: "check",
        size: "sm",
        onClick: () => post({ type: "action", action: "setActive", id: transcript.id }),
      }));
    }
    card.append(head);
    const body = el("div", "transcript");
    for (const turn of transcript.turns ?? []) {
      const node = el("div", "turn");
      node.append(el("div", "turn-role", turn.role));
      node.append(el("div", "turn-text", turn.text));
      body.append(node);
    }
    card.append(body);
    return card;
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
      state.data = message.payload;
      state.error = null;
      if (message.section) state.section = message.section;
      render();
    } else if (message.type === "navigate") {
      // The host naming a landing place ("Sessions" opens the panel on the
      // sessions section) is a local move: no answer is owed back.
      if (sections.has(message.section)) {
        state.section = message.section;
        render();
      }
    } else if (message.type === "error") {
      stopReading();
      state.error = typeof message.message === "string" ? message.message : "Unknown error";
      render();
    }
  });

  post({ type: "ready" });
})();
