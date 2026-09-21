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
// outside the window with no ancestor clipping or scrolling it — was made red on
// a render whose page root hides the overflow (`body{overflow-x:hidden}`) while
// `.agent-grid` is widened to 1800px: `noHorizontalScroll` stays true and says
// nothing, while the dump names ten elements painting past the right edge and
// counts 42, which is exactly why this one is walked from geometry rather than
// read off a declaration. The tab check is the section check one level down, and
// the perturbation was the harness's own fault — a clickTab that took the first
// tab instead of the labelled one — which goes red with "the pane on screen is
// the Installed (0) tab, not the Official Registry tab that was clicked".
//
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
  ["a-reference", 1491, 1024, "dark"],
  ["a-reference", 1491, 1024, "light"],
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

const rows = [];
const failures = [];

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
  // check above cannot answer: something painted outside the window with no
  // ancestor clipping or scrolling it. A dump from a shot.mjs that predates this
  // check has nothing to read, which is a failure too — a check that is absent
  // passes every run it is absent from.
  if (checks.spilled === undefined) {
    problems.push("the geometry dump has no spilled check — shot.mjs produced an older shape");
  } else if (checks.spilled.length > 0) {
    problems.push(`painted outside the viewport with nothing clipping it: ${checks.spilled.join(", ")}`);
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
  console.log(`PASS — ${rows.length} renders, every check clean. Shots in ${path.relative(process.cwd(), outDir)}`);
} else {
  console.log(`FAIL — ${failures.length} of ${rows.length} renders have problems:`);
  for (const failure of failures) console.log(`  ${failure}`);
}
// The last word, so an empty run cannot be reset to green by the loop above.
process.exitCode = rows.length > 0 && failures.length === 0 ? 0 : 1;
