// The scenario matrix: every payload the panel can receive, at the sizes and
// themes a real window has, rendered through the same harness and checked.
//
// The reference geometry test answers "does this look like the reference at the
// reference's size". This answers the other questions: does a fresh project
// render, does an isolated-history project render, does a narrow window push
// anything off the edge, does the light theme leave an unreadable pair behind.
//
// Usage: node test/visual/matrix.mjs [--out <dir>] [--only <substring>]
//
// Exit code is 0 only when every render's checks pass, so it gates a release the
// same way the geometry compare does.
//
// The checks have been shown to fail: taking `max-width: 100%` back off
// `.field-select` — the one rule that lets the model trigger come in to the
// card's edge on a narrow window — turns the 1280 render red with
// `field-value · "claude-sonnet-4"` and its four siblings. A check nobody has
// ever seen fail is not evidence. The painted, timing and contrast gates were
// each shown to fail on 2026-09-21, after a review found the first of them
// hollow: the rendered page the review kept as a probe (a payload that makes
// the panel's render throw, leaving the shell's skeleton in the content area)
// records contentNodes 1 — the old "not zero" test passed it, and the run now
// goes red with "the content area still holds the shell's skeleton". The timing
// gate goes red with "no shell timing recorded" when the page cannot report the
// navigation entry, and the contrast floor with "too few to be a real page"
// when the measurement reads nothing. The two wait-indicator checks have been shown
// to fail the same way: a `return` after the line is drawn gives "replaced the
// content instead of sitting above it (0 of 3 blocks left)", and moving the
// half-second timer out to five gives "a slow read drew no wait indicator". The
// keyboard probe fails too: forcing the arrow key's step to 0 gives "the arrow
// key left the selection on tab 0 of 3".
//
// The two checks added on 2026-09-21 were each watched fail. `spilled` — the
// element-level half of the overflow question, red when something is painted
// outside the window — was made red on a render with `body{overflow-x:hidden}`
// and `.agent-grid` widened to 1800px: the dump names ten elements painting past
// the right edge and counts 42, which is the point — it reads geometry, not
// declarations. (That perturbation also turned the page-level check red: on this
// engine, body-only `overflow-x: hidden` still leaves documentElement.scrollWidth
// at 1800 against a 1461 client width. The layout that really hides the symptom
// from it is `overflow: hidden` on both axes at the root, which is the one a
// page-level check can never see.) A box a non-root ancestor does not hold is
// still reported, and the string names what holds it — `· held in by .card
// (overflow hidden)` — because "nothing clipping it" would be the opposite of
// what was measured. The tab check is the section check one level down, and
// the perturbation was the harness's own fault — a clickTab that took the first
// tab instead of the labelled one — which goes red with "the pane on screen is
// the Installed (0) tab, not the Official Registry tab that was clicked".
//
// The height check added on 2026-09-23 — the two panes' bottom edges against
// the content area's own — was watched fail on both of its halves, because the
// two ways a browser can fail to fill are different failures. Taking
// `position: absolute` back off `.sessions-browser` (the rule that keeps a
// 120-turn page from growing the document) leaves the run red with "the page
// scrolls vertically (6017 > 1024)": the panes still measure flush, because the
// content area grew with them, and only the page-level verdict notices. Moving
// that same box's bottom inset to 40px leaves it red with "the browser stops
// 40px short of the bottom of the content area (which ends at 1014)" — measured
// on all three boxes, the browser and the two panes. The collapsed check's
// unpainted-node guard was watched in the same sitting: collapsing a painted
// control (`.session-actions .btn`, height 0) still names both of them
// ("btn btn-sm icon-brand[]", "btn btn-sm btn-icon[]"), so the guard skips the
// closed menu without skipping a collapse a reader can see.
// The time budgets are the panel's promise — a shell inside 100ms, real data
// inside 300ms — and a render costs a quarter of each (about 20-27ms), so a red
// here means re-run before chasing: a loaded machine can spend 100ms on a page
// this size, and the number this file prints is the honest one either way.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(here, "..", "..");

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i];
  if (key.startsWith("--")) args.set(key.slice(2), process.argv[i + 1]);
}
const outDir = path.resolve(process.cwd(), args.get("out") ?? path.join(packageDir, "..", "..", "dist", "dashboard-visual", "shots", "matrix"));
const only = args.get("only") ?? null;
mkdirSync(outDir, { recursive: true });

// payload, width, height, theme, options. The reference size is 1491x1024: the
// reference screenshot is a 1536-wide window with VS Code's 45px activity bar in
// it. `reading: true` clicks Refresh and then withholds the answer, which is the
// only way to see the wait indicator: a read that answers inside half a second
// must not draw it.
const RUNS = [
  // The reference size, gated as a promise rather than only as a picture: this
  // window's document is exactly as tall as its viewport (scrollHeight 1024 in
  // 1024), which is what "the Overview is full to the bottom edge" means in
  // numbers. `fits` is declared here so a change that pushed the reference's own
  // render past its window goes red at the size the design was drawn for.
  ["a-reference", 1491, 1024, "dark", { fits: true }],
  ["a-reference", 1491, 1024, "light"],
  // The one state the reference cannot show: a launch that is running right now.
  // `a-reference` is the idle half of the pair — same payload, no pill — so the
  // two renders are a before/after of the card, not two different projects.
  ["k-running", 1491, 1024, "dark"],
  ["e-full", 1491, 1024, "dark"],
  ["e-full", 1491, 1024, "light"],
  ["b-fresh", 1491, 1024, "dark"],
  ["c-native", 1491, 1024, "dark"],
  ["a-reference", 1280, 900, "dark"],
  ["e-full", 1280, 900, "dark"],
  ["a-reference", 1024, 768, "dark"],
  ["b-fresh", 1024, 768, "dark"],
  ["a-reference", 720, 600, "dark"],
  ["c-native", 720, 600, "dark"],
  // 高窗口是这一轮要修的那一格：内容比窗口矮时，底下一排卡片会停在半空、留一大片
  // 背景——1440 高、1491 宽的窗口正是报告里说的那种「高高的 VS Code」。两列各自的
  // 最后一张卡必须贴到列的底边（检查在上面那一段，容差 2px），所以加这一个尺寸就等于
  // 把「占满」这句话变成可以失败的检查。
  ["a-reference", 1491, 1400, "dark"],
  ["e-full", 1491, 1400, "dark"],
  // 16:9 windows, which is what a maximised editor window actually is. The
  // 1600x900 window is rendered but its fit is deliberately not gated, and that
  // is a measurement rather than a missing check: the reference's own content
  // needs 1022px there (header 74 + the Agent Configuration panel 396.1 + the two
  // card rows 255 and 254 + the gaps and gutters), so the page scrolls 122px. The
  // mechanism that removes those 122px was built and measured on 2026-09-23 and
  // needs more than the four rules this round added: a definite shell height
  // (#root { height: 100vh } instead of min-height, so the rows have something to
  // shrink against) plus a zero-minimum track on .cards-row. That state fits a
  // 900px window exactly, and costs two visible things: the Agent Configuration
  // panel loses height instead of the rows (396.1px of content in a 274px box,
  // its last three field rows cut off, because it is the one flex item with no
  // floor), and the bottom row collapses to a 2px sliver on a 1366x768 window and
  // in the folded layout, where the deficit is larger than anything the rows can
  // give back. 1366x768 is absent for that reason, the same one the fit gate
  // below records: a size that cannot fit by construction gets no gate.
  ["a-reference", 1600, 900, "dark"],
  ["a-reference", 1920, 1080, "dark", { fits: true }],
  // The tall window the cap exists for: 62vh and 560px meet here, and the bottom
  // row stops at the cap instead of stretching over the 890px of leftover.
  ["a-reference", 2560, 1440, "dark", { fits: true, cap: 560 }],
  ["a-reference", 1491, 1024, "dark", { reading: true }],
  ["b-fresh", 1024, 768, "light", { reading: true }],
  ["a-reference", 1491, 1024, "dark", { keyboard: true }],
  // The five destinations that are not the reference screenshot. They answer to
  // the same checks: the reference says how Overview should look, and nothing
  // here says the other five may clip their text.
  ["a-reference", 1491, 1024, "dark", { section: "configure" }],
  ["a-reference", 1491, 1024, "dark", { section: "agents" }],
  ["a-reference", 1491, 1024, "dark", { section: "sessions" }],
  ["a-reference", 1491, 1024, "light", { section: "skills" }],
  ["a-reference", 1491, 1024, "dark", { section: "quick" }],
  ["a-reference", 1024, 768, "dark", { section: "sessions" }],
  // The Sessions browser is the one destination with a height to keep, so it is
  // rendered at both sizes the panel has to fill without a page-level scroll,
  // and at both of its halves: `k-running` and `a-reference` only ever show the
  // Shared tab, and the Agent half is the other list the same page draws —
  // including its own agent strip, whose counts come from the payload's
  // per-agent totals. The long transcript is the newest-100-of-120 cut (the
  // fixture holds 120 turns — the note it draws counts them off the payload,
  // so the number here has to come from the fixture too), which is the one
  // render where the turn note and the pane's own scroller are both on screen
  // at once.
  ["m-long-transcript", 1491, 1024, "dark", { section: "sessions" }],
  ["m-long-transcript", 1024, 768, "dark", { section: "sessions" }],
  ["a-reference", 1491, 1024, "light", { section: "sessions", tab: "Agent" }],
  ["e-full", 1491, 1024, "light", { section: "agents" }],
  // The states a payload can be in that the reference screenshot says nothing
  // about, because it is only ever one project on one machine: the project's
  // other history mode, an agent whose CLI is not installed (both agents, so the
  // wrong card cannot stand in for the right one), a project that is configured
  // and completely empty, a registry that was never synced, text longer than the
  // box it goes in, and a window narrower than the stylesheet's last breakpoint.
  ["d-isolated", 1491, 1024, "dark"],
  ["f-no-claude", 1491, 1024, "dark"],
  ["f-no-claude", 1024, 768, "light"],
  ["g-no-codex", 1491, 1024, "dark"],
  ["j-bare", 1491, 1024, "dark"],
  ["h-long-text", 1491, 1024, "dark"],
  ["h-long-text", 720, 600, "dark"],
  ["a-reference", 640, 800, "dark"],
  // The panes behind the Skills tabs. The Installed pane is what the reference
  // screenshot shows, so the other two — an empty pack list and a registry whose
  // answer is "never synced" — are only reachable by clicking their tab.
  ["j-bare", 1491, 1024, "dark", { section: "skills", tab: "Available Packs" }],
  ["j-bare", 1491, 1024, "dark", { section: "skills", tab: "Official Registry" }],
  ["e-full", 1491, 1024, "dark", { section: "skills", tab: "Official Registry" }],
];

// FIXED, 2026-09-21 — the three narrow runs this block used to leave red. The
// spill check found them: a-reference-720x600-dark and c-native-720x600-dark
// (both green until the check existed) and h-long-text-720x600-dark. At those
// widths the status pill's label wraps — 36.25px tall inside a pill whose height
// was a fixed 29px — and the band itself was a fixed 74px, so the status block's
// overflow was centred *above* the band and painted from top -7, off the top of
// the document where no amount of scrolling reaches it. The fix is in style.css:
// the pill and the header band are min-height, so both grow to hold what they
// write. The same payloads at 1491 still measure a 74px band and a 29px pill.

const runName = ([payload, width, height, theme, options = {}]) =>
  `${payload}-${width}x${height}-${theme}${options.reading ? "-reading" : ""}${options.keyboard ? "-keyboard" : ""}${options.section ? `-${options.section}` : ""}${options.tab ? `-${options.tab.replaceAll(" ", "-").toLowerCase()}` : ""}`;

// How far the two columns of a row may differ and still be one pair. The
// reference's own draws measure a 1px difference between its session cards
// (image y747 vs y748), which is the drawing's own edge error, so the bound is
// twice that: it accepts a sub-pixel rounding and refuses a card that grew a row.
const GRID_TOL = 2;

// How far the Sessions browser's panes may miss the content area's own bottom
// edge, in either direction. Two pixels is the same sub-pixel allowance the
// grid gate gives a card edge; anything more is a visible strip of bare
// background under the panes, which is the thing the check exists to see.
const PANE_TOL = 2;

const rows = [];
const failures = [];
// How many two-column rows the grid gate above actually measured. See the floor
// at the bottom of this file: a rename or a fold that empties this set has to be
// a red run, not a quiet one.
let gridRows = 0;

for (const [payload, width, height, theme, options = {}] of RUNS) {
  const name = runName([payload, width, height, theme, options]);
  if (only !== null && !name.includes(only)) continue;
  const stem = path.join(outDir, name);
  // Only the Overview at the reference size is the screenshot the anchors were
  // measured from; a section click draws something the reference never showed.
  const fixture = payload === "a-reference" && !options.section
    ? path.join(here, "fixtures", "reference-geometry.json")
    : path.join(here, "fixtures", "checks-only.json");
  const shotArgs = [
    path.join(here, "shot.mjs"),
    "--payload", path.join(here, "fixtures", `${payload}.json`),
    "--out", `${stem}.png`,
    "--fixture", fixture,
    "--width", String(width),
    "--height", String(height),
    "--theme", theme,
  ];
  if (options.reading) shotArgs.push("--reading");
  if (options.keyboard) shotArgs.push("--keyboard");
  if (options.section) shotArgs.push("--section", options.section);
  if (options.tab) shotArgs.push("--tab", options.tab);
  try {
    execFileSync("node", shotArgs, { stdio: ["ignore", "pipe", "pipe"], cwd: packageDir });
  } catch (error) {
    // The browser's own last line, not a 200-character slice: a truncated
    // message says `Command failed: msedge --headless=new ...` and nothing else.
    const stderr = String(error.stderr ?? error).trim().split(/\r?\n/).filter((line) => line.trim() !== "");
    failures.push(`${name}: render failed — ${stderr.slice(-2).join(" / ") || "(no output)"}`);
    continue;
  }
  // The dump is read inside a guard for the same reason the render is: one bad
  // run must not abort the other twenty-one. Without this, a shot that exits 0
  // without writing geometry (or a future edit that moves the write) dies as an
  // uncaught ENOENT after N-1 runs, taking the summary with it.
  let geometry;
  try {
    geometry = JSON.parse(readFileSync(`${stem}.geometry.json`, "utf8"));
  } catch (error) {
    failures.push(`${name}: no geometry dump — ${error.code ?? error.message}`);
    continue;
  }
  if (geometry.checks === undefined || geometry.viewport === undefined) {
    failures.push(`${name}: the geometry dump has no checks — shot.mjs produced an older shape`);
    continue;
  }
  const checks = geometry.checks;
  const problems = [];
  // First, because every other check passes on an empty page: a render that
  // threw leaves the shell standing and the content gone.
  // (An unconfigured project legitimately draws an icon-less empty state, which
  // is why the icon count below is reported rather than gated.)
  //
  // `painted` is the load-bearing half of this gate: a render that threw leaves
  // the shell's skeleton in the content area, so `contentNodes` is 1 and "not
  // zero" passes on exactly the page this check exists to catch. A real empty
  // state — an unconfigured project — has its own markup and no skeleton, so it
  // paints, which is the distinction the screenshot cannot make.
  if (checks.painted !== true) {
    problems.push(checks.contentNodes === 0
      ? "the content area is empty — the render threw"
      : "the content area still holds the shell's skeleton — the render never finished (it threw)");
  }
  if (!checks.noHorizontalScroll) problems.push(`horizontal overflow (${geometry.viewport.scrollW} > ${geometry.viewport.clientW})`);
  // A family of checks passes vacuously when its subject disappears: no .icon in
  // the markup means no glyphless icon and no collapsed icon, and the run stays
  // green about a dashboard whose icons are gone. The floors below fix the
  // counts where the subject is required. b-fresh is exempt on purpose: a
  // project with nothing configured draws a real empty state with no icons.
  // (Tab strips' presence is gated by the --keyboard run, which fails when the
  // page has no tablist at all.)
  if (payload !== "b-fresh" && checks.contentIcons < 1) {
    problems.push("no icons in the content area — either the dashboard lost them or the .icon class was renamed away");
  }
  if (checks.contrast.measured < 5) {
    problems.push(`only ${checks.contrast.measured} text node(s) measured for contrast — too few to be a real page`);
  }
  if (checks.glyphless.length > 0) problems.push(`icons without a glyph: ${checks.glyphless.join(", ")}`);
  if (checks.collapsed.length > 0) problems.push(`collapsed boxes: ${checks.collapsed.join(", ")}`);
  if (checks.clipped.length > 0) problems.push(`text clipped without ellipsis: ${checks.clipped.join(", ")}`);
  if (checks.overflowing.length > 0) problems.push(`content overflowing a clipped box: ${checks.overflowing.join(", ")}`);
  // The element-level half of the overflow question, and the one the page-level
  // check above cannot answer: something painted past the window's edge. Each
  // entry names the ancestor holding it, if there is one — the page root never
  // counts as one — so the string says what was measured rather than what was
  // hoped for. A dump from a shot.mjs that predates this check has nothing to
  // read, which is a failure too: a check that is absent passes every run it is
  // absent from.
  if (checks.spilled === undefined) {
    problems.push("the geometry dump has no spilled check — shot.mjs produced an older shape");
  } else if (checks.spilled.length > 0) {
    problems.push(`painted outside the viewport: ${checks.spilled.join(", ")}`);
  }
  // The grid gate. A two-column row is one row of cards, and two cards in it that
  // end at different heights are not a pair however correct each one is on its
  // own: that is the ragged bottom a reader sees first and no rect dump shows.
  // Rows that folded to a single column are skipped by construction — stacked
  // cards are supposed to start where the one above them ended — and the count of
  // rows that were gated goes into the summary, so a fold at the reference's own
  // width cannot quietly turn this check off.
  if (checks.rowEdges === undefined) {
    problems.push("the geometry dump has no rowEdges — shot.mjs produced an older shape");
  } else {
    for (const row of checks.rowEdges) {
      const byLeft = new Map();
      for (const column of row.columns) {
        if (!byLeft.has(column.left)) byLeft.set(column.left, []);
        byLeft.get(column.left).push(column);
      }
      const columns = [...byLeft.values()].filter((group) => group.length === 1).map((group) => group[0]).filter((column) => column.cards.length > 0);
      if (columns.length < 2) continue;
      gridRows += 1;
      const name = (column) => column.cards.map((card) => card.title || "(untitled)").join(" + ");
      const edges = (edge) => Math.max(...columns.map((column) => column[edge])) - Math.min(...columns.map((column) => column[edge]));
      const topSpread = +edges("top").toFixed(1);
      const bottomSpread = +edges("bottom").toFixed(1);
      if (topSpread > GRID_TOL) problems.push(`the two columns of row ${row.row} start ${topSpread}px apart (${columns.map((column) => `${name(column)} at ${column.top}`).join(" vs ")})`);
      if (bottomSpread > GRID_TOL) problems.push(`the two columns of row ${row.row} end ${bottomSpread}px apart (${columns.map((column) => `${name(column)} at ${column.bottom}`).join(" vs ")})`);
      for (const column of columns) {
        // Inside a column the cards are a stack, and the stack has to reach both
        // of its own edges: the top card at the column's top (a stack floating in
        // the middle of its column) and the bottom card at the column's bottom
        // (the hole the pair measurement above cannot see, because both columns
        // would still end together).
        const first = column.cards[0];
        const last = column.cards[column.cards.length - 1];
        const topGap = +(first.top - column.top).toFixed(1);
        const bottomGap = +(column.bottom - last.bottom).toFixed(1);
        if (topGap > GRID_TOL) problems.push(`the ${first.title} card starts ${topGap}px below the top of its column`);
        if (bottomGap > GRID_TOL) problems.push(`the ${last.title} card stops ${bottomGap}px short of the bottom of its column (${name(column)} ends at ${last.bottom}, the column at ${column.bottom})`);
      }
    }
  }
  // The size of the set the clipped check measured. Zero candidates means the
  // selector list no longer matches anything, which is how that check goes
  // vacuously green — "measured nothing" is not "found nothing".
  if (checks.clippedCandidates === undefined) {
    problems.push("the geometry dump has no clippedCandidates count — shot.mjs produced an older shape");
  } else if (checks.clippedCandidates === 0) {
    problems.push("the clipped-text check measured no candidates at all — its selector list is stale");
  }
  if (checks.unlabelledControls > 0) problems.push(`${checks.unlabelledControls} control(s) with no accessible name`);
  if (checks.tabsNotTabs.length > 0) problems.push(`chips that are not tabs: ${checks.tabsNotTabs.join(", ")}`);
  if (checks.stripsNotTablists > 0) problems.push(`${checks.stripsNotTablists} tab strip(s) with no tablist role`);
  if (checks.tabsWithoutPanels.length > 0) problems.push(`tabs whose panel is missing: ${checks.tabsWithoutPanels.join(", ")}`);
  // The wait indicator. On a read that answers at once there must not be one; on
  // a read that is left hanging there must be, and it must sit *above* the
  // content rather than replacing it — a spinner that blanks the panel is worse
  // than no spinner.
  if (options.reading) {
    if (!checks.readingLine) problems.push("a slow read drew no wait indicator");
    if (checks.readingKeptContent < checks.contentBeforeReading) {
      problems.push(`the wait indicator replaced the content instead of sitting above it (${checks.readingKeptContent} of ${checks.contentBeforeReading} blocks left)`);
    }
    if (checks.readingRole !== "status") problems.push(`the wait indicator is not a status region (role=${checks.readingRole})`);
  } else if (checks.readingLine) {
    problems.push("a read that answered at once still drew the wait indicator");
  }
  // A section run has to be showing the section it clicked: a click that lands
  // nowhere would otherwise check the Overview six times and call it coverage.
  if (options.section && checks.section !== options.section) {
    problems.push(`the sidebar says it is showing ${checks.section}, not the ${options.section} that was clicked`);
  }
  // The same question one level down: a tab click that landed nowhere leaves the
  // pane the page already had on screen, and a run that asked for another pane
  // would be checking that one twice.
  if (options.tab && checks.tab !== options.tab) {
    problems.push(`the pane on screen is the ${checks.tab} tab, not the ${options.tab} tab that was clicked`);
  }
  // The Sessions browser's height, which is the one thing no other check here
  // can state: "the page has no horizontal overflow" is true of a page whose
  // panes end a third of the way down. Only a Sessions run has the browser on
  // screen, so this is gated where it is measured rather than on every render —
  // and a dump that does not carry the measurement at all is a failure, not a
  // skip, because a check that is absent passes every run it is absent from.
  // The page-level promise, gated where a run declares it. An Overview whose
  // rows have grown past the window's bottom edge has not filled the window, it
  // has scrolled — the same defect the screenshot shows as a bare strip of
  // background, one step further along. It is per-run because whether a page can
  // fit depends on the window as well as on the layout: a folded 720x600 window
  // holds more content than room by construction, and a gate that fired there
  // would have to be loosened until it stopped meaning anything. A dump with no
  // `fits` in it is a failure rather than a skip, the same way an empty set is:
  // a check that is absent passes every run it is absent from.
  if (options.fits) {
    if (checks.fits === undefined) {
      problems.push("the geometry dump has no fits — shot.mjs produced an older shape");
    } else if (!checks.fits) {
      problems.push(`the page does not fit its window: document ${geometry.viewport.scrollH} in a ${geometry.viewport.clientH} viewport, ${geometry.viewport.scrollH - geometry.viewport.clientH}px past the bottom edge`);
    }
  }
  // The other half of "full", and the reason the two are gated separately: a row
  // that stretches to reach a tall window's bottom edge has to stop somewhere.
  // The bottom row's own content is 254px at the reference width, and on a
  // 1440-tall window the leftover is ~890px -- a Skills list stretched over that
  // is a row of items above a screen of empty border. The cap itself lives in
  // style.css (.cards-row.bottom-row's max-height); what is declared here is that
  // a run is a size where it is reachable, because only a window tall enough to
  // reach it can measure it.
  if (typeof options.cap === "number") {
    const edges = checks.rowEdges ?? [];
    const last = edges[edges.length - 1];
    if (last === undefined) {
      problems.push("the geometry dump has no rowEdges — shot.mjs produced an older shape");
    } else {
      const tallest = Math.max(...last.columns.map((column) => +(column.bottom - column.top).toFixed(1)));
      if (tallest > options.cap + GRID_TOL) {
        problems.push(`the bottom row is ${tallest}px tall, past the ${options.cap}px cap — the row is stretching into the window instead of stopping at its maximum`);
      }
    }
  }
  if (options.section === "sessions") {
    const panes = checks.sessionsPanes;
    if (panes === undefined) {
      problems.push("the geometry dump has no sessionsPanes — shot.mjs produced an older shape");
    } else if (!panes.measured) {
      problems.push(`the two panes' bottom edges could not be measured: ${panes.why}`);
    } else {
      const boxes = [["the browser", panes.browser], ["the list pane", panes.list], ["the conversation pane", panes.view]];
      for (const [what, gap] of boxes) {
        if (gap === null) problems.push(`${what} is not on the page`);
        // A null gap is the pane missing, which the line above has already said:
        // reporting it twice as "ran 0px past" would name a measurement nobody took.
        else if (Math.abs(gap) > PANE_TOL) {
          problems.push(`${what} ${gap > 0 ? `stops ${gap}px short of` : `runs ${-gap}px past`} the bottom of the content area (which ends at ${panes.contentBottom})`);
        }
      }
    }
    if (checks.pageScrolls === undefined) {
      problems.push("the geometry dump has no pageScrolls — shot.mjs produced an older shape");
    } else if (checks.pageScrolls) {
      problems.push(`the page scrolls vertically (${geometry.viewport.scrollH} > ${geometry.viewport.clientH}) — a browser that grows the document has not filled the area it was given`);
    }
  }
  // Roles make a tab strip describable; only the arrow key makes it usable.
  if (options.keyboard) {
    const keys = checks.tabKeyboard ?? { ran: false, why: "the probe never ran" };
    if (!keys.ran) problems.push(`the keyboard probe could not run: ${keys.why}`);
    else {
      if (!keys.focusedFirst) problems.push("a tab could not take focus");
      if (keys.selectedAfter !== 1) problems.push(`the arrow key left the selection on tab ${keys.selectedAfter} of ${keys.count}`);
      if (keys.focusAfter !== 1) problems.push(`focus followed the arrow to tab ${keys.focusAfter}, not the selected one`);
    }
  }
  // The budgets the panel promises: a shell on screen inside 100ms, real data
  // inside 300ms. What is measured here is the render in a cold browser, so the
  // numbers are the page's own cost, not the extension host's.
  const timing = geometry.timing ?? {};
  // A missing number used to skip its budget silently, so a page that stopped
  // recording a measurement read as a page inside budget. A budget nobody can
  // measure is not met; it is unmeasured.
  if (typeof timing.shellMs !== "number") problems.push("no shell timing recorded — the page never reported one");
  else if (timing.shellMs >= 100) problems.push(`shell took ${timing.shellMs}ms (budget 100ms)`);
  if (typeof timing.dataMs !== "number") problems.push("no data timing recorded — the page never reported one");
  else if (timing.dataMs >= 300) problems.push(`data took ${timing.dataMs}ms (budget 300ms)`);
  // Unreadable text is a defect in every theme; the floor is WCAG's 3:1, the
  // loosest bound anyone publishes. AA (4.5) is reported alongside, because the
  // dark palette is sampled from the reference screenshot and the reference
  // itself puts some of its 12px labels under AA — that is a deliberate
  // likeness, not an oversight, so it is measured and printed rather than
  // silently passed.
  // The gate is WCAG AA (4.5:1) on every text node in both themes, with one
  // allowance that is the reference's own: the primary button's label is white
  // on the sampled brand fill (#fb6e27, 2.85:1), and darkening that fill would
  // be a visible departure from the screenshot every other check holds this
  // build to. So that ratio is printed on every run and only a *new* failure —
  // text on a surface this build chose itself — can break the gate.
  const allowed = checks.contrast.belowAA.filter((entry) => entry.includes("btn-primary"));
  const notAllowed = checks.contrast.belowAA.filter((entry) => !entry.includes("btn-primary"));
  if (notAllowed.length > 0) problems.push(`text under AA (4.5:1): ${notAllowed.join(", ")}`);
  // Every text node failing the filter above means the measurement read nothing,
  // and a contrast gate with nothing to measure passes for free. The dashboard
  // always has text, so zero is a broken measurement, not a sparse page.
  // The floor is 5 rather than 1 because the smallest real page in this matrix
  // measures 10 text nodes (a fresh project), so 5 keeps margin while still
  // failing a page that rendered nearly nothing.
  rows.push({ name, viewport: `${geometry.viewport.clientW}x${geometry.viewport.clientH}`, icons: checks.icons, buttons: checks.buttons, contrast: checks.contrast, allowed: allowed.length, timing, reading: options.reading === true, problems });
  if (problems.length > 0) failures.push(`${name}: ${problems.join("; ")}`);
}

// The floor on the grid gate, pinned the way compare.mjs pins the clipped
// candidates: a full run of this matrix measures this many two-column rows.
// A row that folded, a class that was renamed, a selector that stopped matching
// — each of them empties part of that set, and an empty set fails nothing.
// The floor is a property of the run, so a filtered run gets a proportionally
// smaller one: `--only k-running` renders one payload and legitimately measures
// two rows. What the floor exists to catch — every Overview folding to a single
// column at every width, so the gate passes by seeing nothing — is still caught,
// because it is a per-run count either way.
const GRID_ROWS_FLOOR = only === null ? 25 : 2;
if (gridRows < GRID_ROWS_FLOOR) {
  failures.push(`the grid gate measured ${gridRows} two-column row(s), not the ${GRID_ROWS_FLOOR} this run should show — rows it cannot see are rows it cannot fail`);
}

const width = Math.max(...rows.map((row) => row.name.length));
for (const row of rows) {
  const mark = row.problems.length === 0 ? "ok  " : "FAIL";
  const ms = (value) => (value === null || value === undefined ? "  n/a" : `${value}ms`);
  console.log(`${mark} ${row.name.padEnd(width)}  ${row.viewport.padEnd(9)} icons ${String(row.icons).padStart(3)} buttons ${String(row.buttons).padStart(2)} shell ${ms(row.timing.shellMs).padStart(6)} data ${ms(row.timing.dataMs).padStart(6)}${row.reading ? " reading" : "        "} contrast ${String(row.contrast.worst).padStart(5)} (${row.contrast.belowAA.length} under AA${row.allowed ? `, ${row.allowed} allowed` : ""})${row.problems.length ? "  " + row.problems.join("; ") : ""}`);
}
console.log("");
// A filter that matches nothing is a broken invocation, not a clean run — the
// same trap as an empty page passing every check. Renders that matched but
// never produced a row are a different failure, and saying "no render matched"
// about them hides the reason the run went red.
if (rows.length === 0 && failures.length > 0) {
  console.log(`FAIL — ${failures.length} renders never produced a result:`);
  for (const failure of failures) console.log(`  ${failure}`);
  process.exitCode = 1;
} else if (rows.length === 0) {
  console.log(`FAIL — no render matched${only === null ? "" : ` --only ${only}`}. Runs: ${RUNS.map(runName).join(", ")}`);
  process.exitCode = 1;
} else if (failures.length === 0) {
  console.log(`PASS — ${rows.length} renders, ${gridRows} two-column rows aligned, every check clean. Shots in ${path.relative(process.cwd(), outDir)}`);
} else {
  console.log(`FAIL — ${failures.length} of ${rows.length} renders have problems:`);
  for (const failure of failures) console.log(`  ${failure}`);
}
// The last word, so an empty run cannot be reset to green by the loop above.
process.exitCode = rows.length > 0 && failures.length === 0 ? 0 : 1;
