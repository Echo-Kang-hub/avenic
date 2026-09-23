// Visual regression harness for the dashboard webview.
//
// It renders the *real* media files (view.html's structure, style.css, main.js)
// in headless Edge — the same Chromium family VS Code's webview embeds — with a
// fixture DashboardData payload and a dark/light theme variable set, then writes
// a PNG at the requested viewport plus a geometry dump (getBoundingClientRect of
// the layout anchors) so the implementation can be compared against the
// reference image's measured pixel positions.
//
// No npm dependencies: Edge is invoked directly; the fixture is whichever JSON
// file is passed. Fixture data is invented (visual tests only) — production
// never renders it.
//
// Usage:
//   node test/visual/shot.mjs --payload fixtures/overview-a.json --out shots/overview.png [--width 1536] [--height 1024] [--theme dark]
//
// Outputs: <out>.png (screenshot) and <out>.geometry.json (anchor rectangles).
//
// The two are one artifact: the PNG is deleted before the capture and checked
// afterwards for existence, for a write from this run and for exactly the
// requested size, and the dump has to report that same viewport. A picture and a
// set of numbers that came from different layouts are worse than neither, and
// this harness has already gated one against the other once.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(here, "..", "..");
const media = path.join(packageDir, "media", "dashboard");

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i];
  if (key.startsWith("--")) args.set(key.slice(2), process.argv[i + 1]);
}

const payloadPath = path.resolve(process.cwd(), args.get("payload") ?? path.join(here, "fixtures", "a-reference.json"));
const outPath = path.resolve(process.cwd(), args.get("out") ?? path.join(process.cwd(), "shot.png"));
// The reference screenshot is a 1536-wide window; 45px of it are VS Code's own
// activity bar, so the webview itself is 1491 wide (measured, not assumed: the
// reference's sidebar is 45..246 and the dashboard starts at 247).
const width = Number(args.get("width") ?? 1491);
const height = Number(args.get("height") ?? 1024);
const theme = args.get("theme") ?? "dark";
// --reading: click Refresh and then refuse to answer for longer than the panel's
// own half-second, so the line a slow read draws can be checked on a real render.
const readingRun = args.has("reading");
// --keyboard: drive the first tab strip the way a keyboard does — focus it,
// press the right arrow — and report where focus and the selection landed. The
// roles and attributes can all be right on a widget nobody can operate.
const keyboardRun = args.has("keyboard");
// --section <id>: click that item in the sidebar before dumping, so the five
// destinations that are not the reference screenshot get rendered and checked
// too. The click is the real handler; nothing here knows how a section draws.
const sectionArg = args.get("section") ?? null;
// --tab <label>: click that tab by the words on it before dumping, so a pane that
// only exists behind a tab — the registry, where a cache that was never synced is
// the whole content — is rendered and checked like any other. Same rule as
// --section: the click is the real handler.
const tabArg = args.get("tab") ?? null;

const EDGE_CANDIDATES = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];
// Resolved when the run starts rather than when the file is read: this module is
// importable, and the geometry checks are tested without a browser at all.
function browser() {
  const found = EDGE_CANDIDATES.find((candidate) => existsSync(candidate));
  if (found === undefined) throw new Error("Microsoft Edge not found — install Edge or pass an alternate browser path.");
  return found;
}

// VS Code theme values the webview reads through --vscode-* variables. The dark
// set mirrors "Dark Modern"; the light set mirrors "Light Modern". Only the
// variables the dashboard actually consumes are listed.
const THEME_VARIABLES = {
  dark: {
    "--vscode-font-family": "'Segoe UI', system-ui, sans-serif",
    "--vscode-font-size": "13px",
    "--vscode-foreground": "#cccccc",
    "--vscode-descriptionForeground": "#9d9d9d",
    "--vscode-editor-background": "#1f1f1f",
    "--vscode-editorWidget-background": "#202020",
    "--vscode-panel-border": "#2b2b2b",
    "--vscode-widget-border": "#313131",
    "--vscode-focusBorder": "#0078d4",
    "--vscode-button-background": "#0078d4",
    "--vscode-button-foreground": "#ffffff",
    "--vscode-button-hoverBackground": "#026ec1",
    "--vscode-button-secondaryBackground": "#313131",
    "--vscode-button-secondaryForeground": "#cccccc",
    "--vscode-button-secondaryHoverBackground": "#3c3c3c",
    "--vscode-input-background": "#313131",
    "--vscode-input-foreground": "#cccccc",
    "--vscode-input-border": "#3c3c3c",
    "--vscode-list-hoverBackground": "#2a2d2e",
    "--vscode-list-activeSelectionBackground": "#04395e",
    "--vscode-terminal-ansiGreen": "#23d18b",
    "--vscode-terminal-ansiYellow": "#f5f543",
    "--vscode-terminal-ansiRed": "#f14c4c",
    "--vscode-errorForeground": "#f85149",
    "--vscode-textLink-foreground": "#4daafc",
  },
  light: {
    "--vscode-font-family": "'Segoe UI', system-ui, sans-serif",
    "--vscode-font-size": "13px",
    "--vscode-foreground": "#3b3b3b",
    "--vscode-descriptionForeground": "#717171",
    "--vscode-editor-background": "#ffffff",
    "--vscode-editorWidget-background": "#f8f8f8",
    "--vscode-panel-border": "#e5e5e5",
    "--vscode-widget-border": "#d4d4d4",
    "--vscode-focusBorder": "#005fb8",
    "--vscode-button-background": "#005fb8",
    "--vscode-button-foreground": "#ffffff",
    "--vscode-button-hoverBackground": "#0258a8",
    "--vscode-button-secondaryBackground": "#e5e5e5",
    "--vscode-button-secondaryForeground": "#3b3b3b",
    "--vscode-button-secondaryHoverBackground": "#d9d9d9",
    "--vscode-input-background": "#ffffff",
    "--vscode-input-foreground": "#3b3b3b",
    "--vscode-input-border": "#cecece",
    "--vscode-list-hoverBackground": "#e8e8e8",
    "--vscode-list-activeSelectionBackground": "#e4e6f1",
    "--vscode-terminal-ansiGreen": "#107c10",
    "--vscode-terminal-ansiYellow": "#b89500",
    "--vscode-terminal-ansiRed": "#cd3131",
    "--vscode-errorForeground": "#f85149",
    "--vscode-textLink-foreground": "#005fb8",
  },
};

// The anchors whose rectangles get dumped for comparison with the reference
// measurements. Missing anchors are reported as null, which is itself a signal.
// Every anchor in fixtures/reference-geometry.json is dumped by name; these are
// extra boxes that explain a mismatch (a head, a foot, a row) but cannot fail.
const DIAGNOSTIC_ANCHORS = [
  ".side-brand",
  ".side-nav",
  ".side-foot",
  ".main",
  ".section-head",
  ".agent-head",
  ".field-row",
  ".cards-row",
  ".stack",
  ".card-head",
  ".card-foot",
  ".list-row",
  ".row-main",
  ".row-title",
  ".row-time",
  ".row-agents",
  ".badge",
  ".agent-chip",
  // The right-hand cluster of a row and the status pill's own parts: when a
  // label comes out wider than the reference's, the parts say which member of
  // the cluster moved and which one only inherited the shift.
  ".skill-line .btn",
  ".agent-foot .btn",
  ".agent-state",
  ".agent-state .dot",
  ".skill-marks",
  ".skill-marks .mark",
  ".tabs",
  ".quick-btn",
  ".activity-row",
  ".activity-list",
  ".proj-title",
  ".side-version",
];

// Selectors whose computed box model gets dumped alongside the rects — the
// fastest way to tell *why* a row came out taller than the reference.
const STYLE_PROBES = [
  ".field-row",
  ".field-value",
  ".field-label",
  ".badge",
  ".list-row",
  ".row-agents",
  ".badge",
  ".agent-chip",
  ".row-actions",
  ".card-head",
  ".agent-card",
  ".agent-fields",
  ".agent-head",
  ".section-head",
  ".card",
];

// The reference fixture is the comparison contract: shot.mjs dumps exactly the
// boxes it names, so "what is compared" can never drift from "what was measured".
const fixturePath = path.resolve(process.cwd(), args.get("fixture") ?? path.join(here, "fixtures", "reference-geometry.json"));

function buildPage(payload, fixture) {
  const html = readFileSync(path.join(media, "view.html"), "utf8");
  const themeCss = `body.${theme === "light" ? "vscode-light" : "vscode-dark"} {\n${Object.entries(THEME_VARIABLES[theme] ?? THEME_VARIABLES.dark)
    .map(([name, value]) => `  ${name}: ${value};`)
    .join("\n")}\n}`;
  const css = readFileSync(path.join(media, "style.css"), "utf8")
    // The bundled codicon font sits next to style.css; in the harness page the
    // CSS is inlined into a file elsewhere, so point the face at the real file.
    .replaceAll("url(\"./codicon.ttf\")", `url("file:///${path.join(media, "codicon.ttf").replaceAll("\\", "/")}")`);
  const js = readFileSync(path.join(media, "main.js"), "utf8");
  const geometry = `
(function () {
  // The same payload the page is about to be handed, kept where the structure
  // dump can reach it: several of those measurements are comparisons against the
  // data that produced the page ("the header prints the project this payload
  // names"), which is what makes them gates on the renderer rather than on the
  // fixture's own values.
  const FIXTURE = ${JSON.stringify(payload)};
  const api ={ postMessage: (m) => { window.__posted = window.__posted || []; window.__posted.push(m); } };
  window.acquireVsCodeApi = () => api;
  // A tab is clicked by the words a reader sees on it, never by an index: an
  // index would keep "working" after the tabs were reordered.
  const clickTab = (label) => {
    const tab = [...document.querySelectorAll('[role="tab"]')].find((node) => (node.textContent || "").trim() === label);
    if (tab === undefined) throw new Error("no tab labelled " + label);
    tab.click();
  };
  window.addEventListener("load", () => {
    // What the panel actually costs, measured in the page. Both numbers are CPU
    // time inside a task (parsing, style, layout), which the virtual clock does
    // not compress: the layout is forced with a synchronous read rather than
    // waited for, so it lands inside the window being measured.
    const navigation = performance.getEntriesByType("navigation")[0];
    const timing = {
      shellMs: navigation ? +(navigation.domContentLoadedEventEnd - navigation.startTime).toFixed(1) : null,
      loadMs: navigation ? +(navigation.loadEventEnd - navigation.startTime).toFixed(1) : null,
    };
    const beforeData = performance.now();
    window.dispatchEvent(new MessageEvent("message", { data: { type: "data", payload: ${JSON.stringify(payload)} } }));
    void document.getElementById("content").offsetHeight;
    timing.dataMs = +(performance.now() - beforeData).toFixed(1);
    const deadline = Date.now() + 4000;
    // How many blocks the content area held before Refresh was clicked. Only the
    // reading run ever clicks, so everywhere else this stays null.
    let contentBeforeTheClick = null;
    // Which tab the arrow key lands on, and whether focus went with it. Only the
    // keyboard run presses anything.
    let tabKeyboard = null;
    const probeKeyboard = () => {
      const first = document.querySelector('[role="tablist"]');
      if (first === null) return { ran: false, why: "no tablist on the page" };
      const strip = [...first.querySelectorAll('[role="tab"]')];
      if (strip.length < 2) return { ran: false, why: "the first strip has one tab" };
      strip[0].focus();
      const focusedBefore = document.activeElement === strip[0];
      strip[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      // The strip is rebuilt by the render that follows, so ask the document
      // again rather than trusting the old nodes.
      const now = document.querySelector('[role="tablist"]');
      const tabs = now === null ? [] : [...now.querySelectorAll('[role="tab"]')];
      const selected = tabs.filter((node) => node.getAttribute("aria-selected") === "true");
      return {
        ran: true,
        count: strip.length,
        focusedFirst: focusedBefore,
        selectedAfter: selected.length === 1 ? tabs.indexOf(selected[0]) : -1,
        focusAfter: tabs.indexOf(document.activeElement),
      };
    };
    const collect = () => {
      // Readiness is "the skeleton is gone": the shell renders immediately, so
      // the placeholder block is what tells render() apart from first paint.
      const content = document.getElementById("content");
      const painted = content !== null && content.children.length > 0 && content.querySelector(".skeleton") === null;
      if (painted || Date.now() > deadline) {
        const rects = {};
        // Viewport metrics: a scrollbar silently steals 15px of layout width,
        // which shifts every column and is invisible in a rect dump.
        rects.viewport = {
          clientW: document.documentElement.clientWidth,
          clientH: document.documentElement.clientHeight,
          scrollW: document.documentElement.scrollWidth,
          scrollH: document.documentElement.scrollHeight,
          innerW: window.innerWidth,
          innerH: window.innerHeight,
          dpr: window.devicePixelRatio,
        };
        const round = (r) => ({ x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) });
        rects.timing = timing;

        // A text node's range box is the closest a rect can get to ink: it is the
        // glyph advance box of one run, which is what a padding change moves.
        function firstTextNode(node) {
          for (const child of node.childNodes) {
            if (child.nodeType === 3 && child.nodeValue.trim() !== "") return child;
            if (child.nodeType === 1) { const found = firstTextNode(child); if (found !== null) return found; }
          }
          return null;
        }

        // An <img> with transparent padding has an ink box smaller than its
        // element box, so the mark is measured through a canvas: what the eye
        // sees, mapped back into page coordinates through object-fit: contain.
        function inkRect(img) {
          const nw = img.naturalWidth;
          const nh = img.naturalHeight;
          if (!nw || !nh) return null;
          const canvas = document.createElement("canvas");
          canvas.width = nw;
          canvas.height = nh;
          const ctx = canvas.getContext("2d");
          ctx.drawImage(img, 0, 0);
          let data;
          try { data = ctx.getImageData(0, 0, nw, nh).data; } catch (error) { return null; }
          let minX = nw, minY = nh, maxX = -1, maxY = -1;
          for (let y = 0; y < nh; y += 1) {
            for (let x = 0; x < nw; x += 1) {
              if (data[(y * nw + x) * 4 + 3] > 8) {
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
              }
            }
          }
          if (maxX < 0) return null;
          const box = img.getBoundingClientRect();
          const scale = Math.min(box.width / nw, box.height / nh);
          const offX = box.x + (box.width - nw * scale) / 2;
          const offY = box.y + (box.height - nh * scale) / 2;
          return round({ x: offX + minX * scale, y: offY + minY * scale, width: (maxX - minX + 1) * scale, height: (maxY - minY + 1) * scale });
        }

        rects.anchors = {};
        for (const anchor of ${JSON.stringify(fixture.anchors)}) {
          const node = [...document.querySelectorAll(anchor.selector)][anchor.index ?? 0];
          if (node === undefined) { rects.anchors[anchor.name] = null; continue; }
          if (anchor.ink === true) { rects.anchors[anchor.name] = inkRect(node); continue; }
          const range = anchor.text === true ? firstTextNode(node) : null;
          if (anchor.text === true) {
            if (range === null) { rects.anchors[anchor.name] = null; continue; }
            const textRange = document.createRange();
            textRange.selectNodeContents(range);
            rects.anchors[anchor.name] = round(textRange.getBoundingClientRect());
            continue;
          }
          if (anchor.text === "contents") {
            // The whole element's run: right for a label split across nodes
            // ("Avenic v" + <span>1.8.4</span>), where the first text node alone
            // would measure only the prefix.
            const wholeRange = document.createRange();
            wholeRange.selectNodeContents(node);
            rects.anchors[anchor.name] = round(wholeRange.getBoundingClientRect());
            continue;
          }
          rects.anchors[anchor.name] = round(node.getBoundingClientRect());
        }

        rects.diagnostic = {};
        for (const selector of ${JSON.stringify(DIAGNOSTIC_ANCHORS)}) {
          rects.diagnostic[selector] = [...document.querySelectorAll(selector)].map((node) => round(node.getBoundingClientRect()));
        }
        // A rect alone cannot explain an oversized row; the box model can.
        const styleKeys = ["display", "alignItems", "justifyContent", "height", "minHeight", "padding", "margin", "boxSizing", "gap", "flex", "fontSize", "lineHeight", "width", "maxWidth", "alignSelf", "order", "position", "top", "transform", "zoom", "verticalAlign", "float"];
        for (const probe of ${JSON.stringify(STYLE_PROBES)}) {
          const node = document.querySelector(probe);
          if (node === null) { rects["style:" + probe] = null; continue; }
          const computed = getComputedStyle(node);
          const dump = {};
          for (const key of styleKeys) dump[key] = computed[key];
          rects["style:" + probe] = dump;
        }
        // Child-by-child rects for a couple of rows: a computed height that
        // disagrees with the children usually means an unexpected node.
        for (const probe of [".field-value", ".row-agents"]) {
          const host = document.querySelector(probe);
          if (host === null) { rects["kids:" + probe] = null; continue; }
          rects["kids:" + probe] = [...host.children].map((kid) => {
            const r = kid.getBoundingClientRect();
            return { tag: kid.tagName, cls: kid.className, text: (kid.textContent || "").slice(0, 30), y: +r.y.toFixed(1), h: +r.height.toFixed(1) };
          });
          rects["html:" + probe] = host.outerHTML.replace(/\s+/g, " ").slice(0, 400);
          const computed = getComputedStyle(host);
          rects["all:" + probe] = [...computed].filter((name) => computed.getPropertyValue(name) !== "" && computed.getPropertyValue(name) !== "normal" && computed.getPropertyValue(name) !== "none" && computed.getPropertyValue(name) !== "auto" && computed.getPropertyValue(name) !== "0px" && computed.getPropertyValue(name) !== "visible" && computed.getPropertyValue(name) !== "static" && computed.getPropertyValue(name) !== "rgba(0, 0, 0, 0)" && computed.getPropertyValue(name) !== "baseline").map((name) => name + ":" + computed.getPropertyValue(name)).join(" | ");
        }
        // A box loses text when its content is wider than it is, something cuts
        // the overflow off, and the cut is bare — no ellipsis to say "there is
        // more". "Something" is usually not the box itself: the clip lives on an
        // ancestor (a card, a section, a list box) while the box that overflows
        // inside it keeps overflow: visible. So a box whose own overflow is
        // visible is only losing text when an ancestor clips it.
        //
        // The first version ended this test with "or it has children", which
        // classified every overflowing container as clipped even when the spill
        // was plainly visible on screen — a defect worth reporting, but not by
        // that name, and not by a rule that called a container with two children
        // clipped whatever its overflow was.
        const losesText = (node) => {
          if (node.scrollWidth <= node.clientWidth + 1) return false;
          const style = getComputedStyle(node);
          if (style.textOverflow === "ellipsis") return false;
          if (style.overflowX !== "visible") return true;
          for (let parent = node.parentElement; parent !== null; parent = parent.parentElement) {
            if (getComputedStyle(parent).overflowX !== "visible") return true;
          }
          return false;
        };
        const loser = (node) => (node.className || node.tagName) + ' · "' + (node.textContent ?? "").trim().slice(0, 28) + '"';

        // The other half of that defect, and the one nothing here could see: an
        // element that overflows *everything* — wider than the window, with no
        // ancestor clipping or scrolling it — is invisible to every check above.
        // losesText asks whether a box loses its own text inside a clip that
        // covers it, and the "overflowing" check only looks at leaves whose own
        // overflow is hidden; the page-level scrollWidth test goes quiet when the
        // page root itself hides the spill. That is overflow: hidden on both
        // axes at the root — measured on this engine, overflow-x: hidden on the
        // body alone still leaves documentElement.scrollWidth at the child's
        // width — and it is the one masking layout a page-level check cannot see
        // through. So this one is geometry, walked up the ancestor chain instead
        // of read off a declaration.
        //
        // Two rules keep it honest, and both of them are about refusing an
        // explanation that does not explain anything:
        //   * an ancestor explains a spill only if it really holds that element —
        //     its overflow is not "visible" AND the element is inside the
        //     ancestor's box, not merely overlapped by its rectangle. An ancestor
        //     the element has already escaped past holds nothing, so the walk
        //     continues above it — but the first such ancestor is named in the
        //     string ("· held in by .card (overflow hidden)"): whatever pokes out
        //     of it is cut off, not painted, and "nothing clipping it" would be the
        //     opposite of what was measured. It is still a failure either way:
        //     content that wants more width than its container is the same defect
        //     one step earlier;
        //   * the page root is never an explanation: content wider than the section
        //     holding it is a real spill whether or not the page hides it from the
        //     user and from scrollWidth, and this check exists to see through
        //     exactly that blanket.
        // The bottom edge is deliberately not reported: content under the fold is
        // what scrolling is for — and so is content above the top edge when an
        // ancestor scrolls, which is why the top edge is the one of the three that
        // is asked whether anything can bring the box back. What lands here is
        // painted where only a sideways page scroll could reach it, which this
        // dashboard must never need.
        // The top edge is not the left and right edges, and it is the one asked a
        // second question. Sideways, the page has no scrollbar by design, so a box
        // past either side edge is reachable only by a scroll this dashboard must
        // never need and is a failure wherever it sits. Vertically, scrolling is the
        // answer: a box above the window inside an ancestor that scrolls is content
        // the reader scrolled past, and the same gesture brings it back — the
        // Sessions conversation lands on its newest turn, so every earlier turn of a
        // long one sits thousands of pixels above the top edge and none of them is a
        // spill. A box above the top edge that no ancestor can scroll back is still
        // reported (a strip positioned above the document), and so is one whose
        // holding ancestor clips without scrolling: that box is cut off, not
        // scrolled away, and the string naming the ancestor is what tells them apart.
        const spilledOut = (node) => {
          const box = node.getBoundingClientRect();
          if (box.width <= 0 || box.height <= 0) return null;
          const right = document.documentElement.clientWidth;
          const sideways = box.right > right + 1 || box.left < -1;
          const above = box.top < -1;
          if (!sideways && !above) return null;
          let scrollsY = false;
          let held = null;
          for (let parent = node.parentElement; parent !== null; parent = parent.parentElement) {
            if (parent === document.body || parent === document.documentElement) break;
            const style = getComputedStyle(parent);
            if (style.overflowX === "visible" && style.overflowY === "visible") continue;
            const clip = parent.getBoundingClientRect();
            const inside = clip.left - 1 <= box.left && clip.right + 1 >= box.right && clip.top - 1 <= box.top && clip.bottom + 1 >= box.bottom;
            if (inside) return null;
            if (style.overflowY === "auto" || style.overflowY === "scroll") scrollsY = true;
            if (held === null) {
              const scrolls = [style.overflowX, style.overflowY].some((value) => value === "auto" || value === "scroll");
              held = (parent.className || parent.tagName) + (scrolls ? " (scrollable)" : " (overflow hidden)");
            }
          }
          const why = [];
          if (box.right > right + 1) why.push("right +" + Math.round(box.right - right));
          if (box.left < -1) why.push("left " + Math.round(box.left));
          if (above && !scrollsY) why.push("top " + Math.round(box.top));
          if (why.length === 0) return null;
          return why.join(" ") + (held === null ? "" : " · held in by " + held);
        };
        // Every element in the page, once: a spill can be the container as easily
        // as the words inside it, so this does not start from the leaves.
        const spilled = [...document.querySelectorAll("body *")]
          .map((node) => { const why = spilledOut(node); return why === null ? null : loser(node) + " · " + why; })
          .filter((entry) => entry !== null);
        // The candidate set the clipped check walks is a fixed selector list: if
        // those class names are renamed away, the list is empty, the failures are
        // empty, and the check passes every run from then on. The count goes into
        // the dump so compare.mjs can pin a floor (overflow.clippedCandidates) —
        // "measured nothing" and "found nothing" are different answers.
        const clippedTargets = [...document.querySelectorAll(".row-main, .skill-name, .field-value, .proj-title, .proj-path")];
        // Whole-page invariants, checked on every render whatever the payload,
        // size or theme. A screenshot shows that something looks wrong; these say
        // what, and they are the only checks the scenario payloads get — the
        // reference's own measurements belong to the reference fixture.
        // One measurement, two verdicts. Whether the document is taller than the
        // window is the page-level answer to "did this layout fill the window it
        // was given": the Overview's rows are meant to reach the window's bottom
        // edge, and a document that grew to 1022 in a 900-tall window has
        // scrolled instead of filled. pageScrolls is the symptom, which is what
        // the Sessions checks were written against; fits is the same fact
        // stated as the promise, which is what a run that declares fits has to
        // keep. Both come off this one read so they cannot disagree.
        const pageScrolls = document.documentElement.scrollHeight > document.documentElement.clientHeight + 1;
        rects.checks = {
          // Nothing may push the page sideways: a row that overflows its box is
          // invisible in a rect dump and obvious here.
          noHorizontalScroll: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
          // Every .icon must resolve to a glyph: an unmapped name renders an
          // empty ::before, which is a blank space on a real machine.
          glyphless: [...document.querySelectorAll(".icon")].filter((node) => {
            const before = getComputedStyle(node, "::before");
            return before.content === "none" || before.content === "normal" || before.content === "";
          }).map((node) => node.getAttribute("data-icon")),
          // An icon whose box collapsed (no glyph and no width) shifts every label
          // after it; caught separately from a missing glyph.
          //
          // An element with nothing painted is not collapsed. A closed menu is
          // display:none, and every box inside it is 0x0 by definition — flagging
          // that would make the check ask for overlays to be drawn while they are
          // shut. getClientRects() is empty exactly for that case: a box that is
          // rendered but has collapsed to nothing still returns one rect, so the
          // defect this check is for is still caught. (The contrast block below
          // refuses unpainted nodes the same way, with its width test.)
          collapsed: [...document.querySelectorAll(".icon, .badge, .btn, .list-row, .field-row")].filter((node) => {
            if (node.getClientRects().length === 0) return false;
            const box = node.getBoundingClientRect();
            return box.width < 2 || box.height < 2;
          }).map((node) => node.className + "[" + (node.getAttribute("data-icon") ?? "") + "]").slice(0, 10),
          // Text that ran out of room falls into two very different buckets: a
          // box that ends in an ellipsis is the design working, and a box that
          // just cuts the words off is a defect. Only the second is reported,
          // and it carries the text, because "field-value" alone does not say
          // which field lost its label on a real machine.
          clipped: clippedTargets.filter(losesText).map(loser).slice(0, 10),
          // How many boxes the line above actually looked at: zero would make it
          // a check that passes by having nothing to fail about. The renderer's
          // own matrix reads this number; the reference gate reads the copy in
          // the structure table below.
          clippedCandidates: clippedTargets.length,
          overflowing: [...document.querySelectorAll("body *")].filter((node) => node.children.length === 0 && (node.textContent ?? "").trim() !== "" && getComputedStyle(node).overflowX === "hidden").filter(losesText).map(loser).slice(0, 10),
          // Painted past the window's edge — the spill the two checks above
          // cannot name, and the one a page-level overflow: hidden hides from
          // noHorizontalScroll. Each entry names the ancestor holding it, if
          // there is one.
          spilled: spilled.slice(0, 10),
          // Where the two-column rows actually end. A grid whose columns stop at
          // two different heights is the one defect a screenshot shows plainly
          // and a rect dump cannot: every card is where it should be and the page
          // still reads as untidy, because two cards that sit side by side and
          // end 70px apart are not a pair. So each row reports, per column, the
          // box it drew and the boxes of the cards inside it — read off the
          // rendered geometry, never off the stylesheet, so a row that folded to
          // one column says so and a stack that stopped short of its column's
          // edge shows up as the card that did not reach it.
          rowEdges: [...document.querySelectorAll("#content > .cards-row")].map((row, index) => ({
            row: index,
            columns: [...row.children].map((child) => {
              const box = child.getBoundingClientRect();
              const cards = child.matches(".stack") ? [...child.children] : [child];
              const rectOf = (node) => {
                const rect = node.getBoundingClientRect();
                return {
                  title: (node.querySelector(".card-title")?.textContent ?? "").trim(),
                  top: +rect.top.toFixed(1),
                  bottom: +rect.bottom.toFixed(1),
                };
              };
              return { left: Math.round(box.left), top: +box.top.toFixed(1), bottom: +box.bottom.toFixed(1), cards: cards.map(rectOf) };
            }),
          })),
          // The height half of the layout question. Every check above is about
          // width or about ink, and none of them notices a two-pane page whose
          // panes stop halfway down the content area and leave the background
          // bare under them: the panes are the boxes that carry the surface, so
          // a gap at their bottom edge is a strip of nothing.
          //
          // The Sessions browser is the one section that fills, so it is measured
          // against #content's own bottom edge — not against the viewport, which
          // the header and the reading line move — and each number is that edge
          // minus the box's bottom: 0 is flush, positive is bare background, and
          // negative is a pane that ran past the area that holds it. On every
          // other destination the object says measured:false, which the caller
          // must not read as "flush".
          sessionsPanes: (() => {
            const content = document.getElementById("content");
            const browser = document.querySelector(".sessions-browser");
            if (content === null || browser === null) return { measured: false, why: "no sessions browser on the page" };
            const bottom = content.getBoundingClientRect().bottom;
            const gap = (node) => (node === null ? null : +(bottom - node.getBoundingClientRect().bottom).toFixed(1));
            return {
              measured: true,
              contentBottom: +bottom.toFixed(1),
              browser: gap(browser),
              list: gap(document.querySelector(".sessions-list-pane")),
              view: gap(document.querySelector(".session-view")),
            };
          })(),
          // The page-level half of that same question, as its own verdict: a
          // layout that reaches the bottom edge by making the document taller
          // than the window has not filled anything, it has scrolled.
          pageScrolls,
          // The same fact the other way up, for the runs that declare the layout
          // has to fit: the matrix fails a fits: true run on it, and the
          // reference fixture pins the same value through the structure table
          // below as overflow.fits.
          fits: !pageScrolls,
          // Controls a keyboard user cannot reach or read.
          unlabelledControls: [...document.querySelectorAll("button")].filter((node) => (node.textContent ?? "").trim() === "" && (node.getAttribute("aria-label") ?? "") === "" && (node.title ?? "") === "").length,
          // A strip of chips that switches what is listed under it is a tab
          // list, and a tab list that is only painted as tabs tells a screen
          // reader nothing: the roles and the selected state have to be there.
          tabsNotTabs: [...document.querySelectorAll(".tab")].filter((node) => node.getAttribute("role") !== "tab" || node.getAttribute("aria-selected") !== String(node.classList.contains("active"))).map((node) => (node.textContent ?? "").trim()),
          stripsNotTablists: [...document.querySelectorAll(".tabs")].filter((node) => node.getAttribute("role") !== "tablist").length,
          // Each tab says which panel it opens, and that panel is a panel.
          tabsWithoutPanels: [...document.querySelectorAll(".tab")].filter((node) => {
            const panel = document.getElementById(node.getAttribute("aria-controls") ?? "");
            return panel === null || panel.getAttribute("role") !== "tabpanel";
          }).map((node) => (node.textContent ?? "").trim()),
          // What the words actually measure against what is behind them, WCAG's
          // own arithmetic. Reported for every render; the theme's own floor is
          // asserted by the caller.
          contrast: (() => {
            const linear = (value) => { const c = value / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
            const luminance = (rgb) => 0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2]);
            const numbers = (value) => (value.match(/[0-9.]+/g) ?? []).map(Number);
            // What the text actually sits on: every translucent layer between it
            // and the first opaque one, composited bottom-up. Stopping at the
            // first opaque ancestor instead would report a badge label as white
            // on white, which is how a tinted pill is drawn but not what a
            // person sees.
            const behind = (node) => {
              const layers = [];
              let current = node;
              while (current !== null) {
                const bg = numbers(getComputedStyle(current).backgroundColor);
                if (bg.length >= 3) {
                  const alpha = bg[3] ?? 1;
                  if (alpha > 0) layers.push([bg[0], bg[1], bg[2], alpha]);
                  if (alpha >= 0.999) break;
                }
                current = current.parentElement;
              }
              let out = [255, 255, 255];
              for (let i = layers.length - 1; i >= 0; i -= 1) {
                const [r, g, b, a] = layers[i];
                out = [r * a + out[0] * (1 - a), g * a + out[1] * (1 - a), b * a + out[2] * (1 - a)];
              }
              return out;
            };
            const leaves = [...document.querySelectorAll("body *")].filter((node) => node.children.length === 0
              && (node.textContent ?? "").trim() !== ""
              && node.getAttribute("aria-hidden") !== "true"
              && !node.classList.contains("icon")
              && node.getBoundingClientRect().width > 0);
            const rows = leaves.map((node) => {
              const style = getComputedStyle(node);
              const bg = behind(node);
              const fg = numbers(style.color);
              const alpha = fg[3] ?? 1;
              const blended = [0, 1, 2].map((i) => fg[i] * alpha + bg[i] * (1 - alpha));
              const la = luminance(blended); const lb = luminance(bg);
              return {
                // The class, or the parent chain down to a class, so a caller can
                // allow-list a whole control family rather than one string.
                cls: node.className || (node.closest("[class]")?.className || node.tagName),
                size: parseFloat(style.fontSize),
                text: (node.textContent ?? "").trim().slice(0, 20),
                ratio: +((Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)).toFixed(2),
              };
            });
            return {
              measured: rows.length,
              worst: rows.length === 0 ? null : Math.min(...rows.map((row) => row.ratio)),
              // WCAG AA for body text. 3.0 is the large-text/non-text floor, and
              // anything under that is unreadable rather than merely dim.
              belowAA: rows.filter((row) => row.ratio < 4.5).map((row) => row.cls + " " + row.ratio + " (" + row.size + "px) '" + row.text + "'").slice(0, 12),
              below3: rows.filter((row) => row.ratio < 3).map((row) => row.cls + " " + row.ratio + " '" + row.text + "'").slice(0, 12),
            };
          })(),
          // A render that threw leaves the shell standing and the content empty,
          // and every other check here passes on an empty page. This is the one
          // that notices. The "shell" is what the template ships: the sidebar and
          // the header rule are always there, so their icons are not counted.
          //
          // The count alone was not enough: a shell that never rendered still
          // holds its placeholder block, so contentNodes was 1 and "not zero"
          // passed on a page where render() had thrown. painted is the same
          // readiness test the wait loop uses, recorded rather than only waited
          // on, so the gate can require it instead of inferring it from a count
          // that a skeleton satisfies.
          painted,
          contentNodes: document.getElementById("content").children.length,
          contentIcons: [...document.querySelectorAll(".icon")].filter((node) => node.closest("#content") !== null).length,
          // Whether the line a slow read draws is on the page, and whether the
          // content it was drawn above survived: a progress indicator that wipes
          // the window is not progress, it is a flicker. "Kept" is counted as
          // children of the content area other than the line itself, held against
          // the same count taken just before the click — a fresh project's empty
          // state is content too, and a count of sections would call it zero.
          readingLine: document.querySelector(".reading") !== null,
          readingKeptContent: [...document.getElementById("content").children].filter((node) => node.className !== "reading").length,
          contentBeforeReading: contentBeforeTheClick,
          readingRole: document.querySelector(".reading") === null ? null : document.querySelector(".reading").getAttribute("role"),
          tabKeyboard,
          // Which destination the sidebar says is showing, read back from the
          // markup rather than assumed from the flag that was passed in.
          section: document.querySelector(".nav-item.active")?.getAttribute("data-section") ?? null,
          // The same question about the tab strips, for the runs that click one:
          // a click that changed nothing would check the pane the page already
          // showed and call that coverage of the pane it asked for.
          tab: document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim() ?? null,
          buttons: document.querySelectorAll("button").length,
          icons: document.querySelectorAll(".icon").length,
        };

        // What the page *is*, as opposed to where its edges are. An anchor
        // comparison can be satisfied by a page that is not this dashboard: three
        // agent cards in the wrong order, a two-column row that folded into one,
        // a section that moved below another — all of them can keep every measured
        // edge where the reference put it, or (worse) match the reference's boxes
        // for reasons that have nothing to do with the reference. So the structure
        // is dumped as its own table of named measurements, and compare.mjs gates
        // the ones the reference settles.
        //
        // Two kinds of value live here and both are real: a measurement of the
        // rendered page (a width, a count, a hue), and a comparison of the rendered
        // page against the payload that produced it ("the header names the project
        // this payload carries"). The second kind is what makes a gate fail when
        // the renderer stops printing the data, without pinning the gate to one
        // fixture's strings.
        const textOf = (node) => (node === null || node === undefined) ? null : (node.textContent || "").trim();
        const css = (selector) => { const node = document.querySelector(selector); return node === null ? null : getComputedStyle(node); };
        // "251,110,39": a hue as three numbers, so a gate can allow a channel or
        // two of rounding without allowing a different colour.
        const rgbOf = (value) => {
          const parts = (value || "").match(/[0-9.]+/g) || [];
          return parts.length >= 3 ? [Math.round(+parts[0]), Math.round(+parts[1]), Math.round(+parts[2])].join(",") : null;
        };
        const distinctLefts = (nodes) => new Set(nodes.map((node) => Math.round(node.getBoundingClientRect().left))).size;
        const sameRow = (nodes) => {
          if (nodes.length === 0) return 0;
          const top = nodes[0].getBoundingClientRect().top;
          return nodes.filter((node) => Math.abs(node.getBoundingClientRect().top - top) <= 2).length;
        };
        const rows = [...document.querySelectorAll(".cards-row")];
        const agentCards = [...document.querySelectorAll(".agent-grid .agent-card")];
        const agentHeights = agentCards.map((node) => node.getBoundingClientRect().height);
        const navItems = [...document.querySelectorAll(".side-nav .nav-item[data-section]")];
        const activeNav = [...document.querySelectorAll(".nav-item.active")];
        const titles = [...document.querySelectorAll("#content .card-title")].map(textOf);
        const keys = {
          "sidebar": document.querySelector(".sidebar"),
          "header": document.querySelector(".proj-header"),
        };
        const sidebar = keys.sidebar;
        const mark = document.querySelector(".side-brand-mark");
        const footer = textOf(document.querySelector(".side-version"));
        const outer = [...document.querySelectorAll("#content > section, #content > .cards-row")]
          .flatMap((node) => node.matches(".cards-row") ? [...node.children] : [node]);
        // The cards a reader must be able to see at the size the window is: not
        // "everything is on screen" (content below the fold is what scrolling is
        // for) but "nothing is painted where only a sideways scroll could reach it".
        const keyCards = [...document.querySelectorAll(".sidebar, .proj-header")].concat(outer)
          .flatMap((node) => node.matches(".cards-row, .stack") ? [...node.children] : [node]);
        const clientW = document.documentElement.clientWidth;
        const pageBottom = document.documentElement.scrollHeight;
        const outside = keyCards.filter((node) => {
          const box = node.getBoundingClientRect();
          return box.left < -1 || box.right > clientW + 1 || box.top < -1 || box.bottom > pageBottom + 1;
        });
        const agentOrder = agentCards.map((node) => (node.querySelector(".agent-mark")?.className || "").replace("agent-mark", "").trim());
        // The same question the rowEdges check asks, stated as the numbers the
        // reference settles: how far apart the two session cards' edges are, and
        // how far the Skills card is from the two cards beside it. Deltas, not
        // four absolute boxes — the reference's own numbers are in the anchors,
        // and what the reference is evidence for is that the pairs line up.
        const boxOf = (node) => (node === null || node === undefined ? null : node.getBoundingClientRect());
        const spread = (a, b, edge) => (a === null || b === null ? null : +Math.abs(a[edge] - b[edge]).toFixed(1));
        const gridCards = rows.map((row) => [...row.querySelectorAll(":scope > .card")]);
        const stackNode = rows[1] === undefined ? null : rows[1].querySelector(":scope > .stack");
        const stackCards = stackNode === null ? [] : [...stackNode.children].map(boxOf);
        const gridDeltas = {
          "grid.sessions.topDelta": spread(boxOf(gridCards[0]?.[0]), boxOf(gridCards[0]?.[1]), "top"),
          "grid.sessions.bottomDelta": spread(boxOf(gridCards[0]?.[0]), boxOf(gridCards[0]?.[1]), "bottom"),
          "grid.bottom.topDelta": spread(boxOf(gridCards[1]?.[0]), stackCards[0], "top"),
          "grid.bottom.bottomDelta": spread(boxOf(gridCards[1]?.[0]), stackCards[stackCards.length - 1], "bottom"),
          // The filler's own edge against the column it fills: a Recent Activity
          // card that stopped short of its column's bottom would leave the hole
          // the pair measurement above cannot see, because both columns would
          // still end together.
          "grid.bottom.fillDelta": spread(stackCards[stackCards.length - 1], boxOf(stackNode), "bottom"),
        };
        rects.structure = {
          "theme": document.body.className,
          // Sidebar: the reference's own band is image x45..247, i.e. 202px of
          // webview (compare.mjs subtracts the activity bar). Measured, not the
          // CSS token: a token nothing applies is not a layout.
          "sidebar.present": sidebar !== null,
          "sidebar.width": sidebar === null ? null : +sidebar.getBoundingClientRect().width.toFixed(1),
          "sidebar.nav.items": navItems.length,
          "sidebar.nav.sections": navItems.map((node) => node.getAttribute("data-section")).join(","),
          "sidebar.active.count": activeNav.length,
          "sidebar.active.section": textOf(activeNav[0]) === null ? null : activeNav[0].getAttribute("data-section"),
          // The brand mark is an <img>, so "present" means the file resolved: a
          // broken src still has a box and would pass a rect test.
          "sidebar.brand.mark": mark !== null && mark.complete && mark.naturalWidth > 0,
          "sidebar.footer": footer,
          "sidebar.footer.opensWithBrand": typeof footer === "string" && footer.startsWith("Avenic v"),
          // The header: the four things a reader uses it for, and whether each one
          // carries this payload's answer rather than the renderer's default.
          "header.present": keys.header !== null
            && document.getElementById("project-title") !== null
            && document.getElementById("project-path") !== null
            && document.getElementById("configured-pill") !== null
            && document.getElementById("refresh-button") !== null
            && document.getElementById("reconfigure-button") !== null,
          "header.title": textOf(document.getElementById("project-title")),
          "header.title.matchesPayload": textOf(document.getElementById("project-title")) === "Project: " + FIXTURE.project.name,
          "header.root": textOf(document.getElementById("project-root")),
          "header.root.matchesPayload": textOf(document.getElementById("project-root")) === String(FIXTURE.project.root),
          "header.configured": textOf(document.getElementById("configured-label")),
          "header.configured.matchesPayload": textOf(document.getElementById("configured-label")) === (FIXTURE.project.configured ? "Avenic Configured" : "Not Configured"),
          "header.refresh": textOf(document.getElementById("refresh-button")),
          "header.height": keys.header === null ? null : +keys.header.getBoundingClientRect().height.toFixed(1),
          // Agent Configuration: three cards, in the payload's order, on one row at
          // a window this wide. The order comes off each card's own mark, not off
          // the payload, so a renderer that dropped or reordered a card shows here.
          "agents.cards": agentCards.length,
          "agents.order": agentOrder.join(","),
          "agents.row": sameRow(agentCards),
          "agents.names": agentCards.map((node) => textOf(node.querySelector(".agent-name"))).join(","),
          "agents.heightSpread": agentHeights.length === 0 ? null : +(Math.max(...agentHeights) - Math.min(...agentHeights)).toFixed(1),
          // Sessions: two cards side by side, and the pair the reference names.
          "sessions.cards": rows[0] === undefined ? 0 : [...rows[0].querySelectorAll(":scope > .card")].length,
          "sessions.columns": rows[0] === undefined ? 0 : distinctLefts([...rows[0].children]),
          "sessions.titles": rows[0] === undefined ? null : [...rows[0].querySelectorAll(":scope > .card")].map((node) => textOf(node.querySelector(".card-title"))).join("|"),
          // Skills and Quick Actions: the second two-column row, whose right-hand
          // column is a stack of Quick Actions over Recent Activity.
          "bottom.cards": rows[1] === undefined ? 0 : rows[1].querySelectorAll(".card").length,
          "bottom.columns": rows[1] === undefined ? 0 : distinctLefts([...rows[1].children]),
          "skills.present": document.querySelector("#content .card.skills") !== null,
          "quick.present": titles.includes("Quick Actions"),
          "quick.buttons": document.querySelectorAll(".quick-btn").length,
          "quick.rows": new Set([...document.querySelectorAll(".quick-btn")].map((node) => Math.round(node.getBoundingClientRect().top))).size,
          // The order the sections are stacked in, read off the rendered document:
          // the reference puts Agent Configuration first, then the sessions pair,
          // then Skills / Quick Actions / Recent Activity.
          "sections.order": titles.join(" | "),
          ...gridDeltas,
          // The brand accent, as painted: the token, the active nav item's glyph
          // and the primary button's fill. A palette change shows up here even when
          // every box stays put.
          "brand.token": (getComputedStyle(document.documentElement).getPropertyValue("--av-brand") || "").trim(),
          "brand.navActive.rgb": rgbOf(css(".nav-item.active .icon")?.color),
          "brand.primary.rgb": rgbOf(css(".btn-primary")?.backgroundColor),
          // Nothing a reader must see may be painted off the reachable page.
          "keyCards.count": keyCards.length,
          "keyCards.outside": outside.length,
          // The page-level overflow verdict and the element-level one, side by
          // side: the first is the symptom, the second names what did it.
          "overflow.page": document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
          "overflow.spilled": spilled.length,
          // The vertical half of that verdict, and the reason this table carries
          // its own copy: the reference window's render is exactly as tall as its
          // viewport (scrollHeight 1024 in 1024), so pinning it here is what
          // turns "the Overview fills the window" into a red gate at the size the
          // design was drawn for, instead of only at the sizes a scenario picks.
          "overflow.fits": rects.checks.fits,
          // The size of the set the clipped check measured, so a rename that
          // empties that set is a red gate rather than a silently vacuous check.
          "overflow.clippedCandidates": clippedTargets.length,
        };
        const script = document.createElement("script");
        script.type = "application/json";
        script.id = "avenic-geometry";
        script.textContent = JSON.stringify(rects);
        document.body.appendChild(script);
        document.title = "READY";
      } else {
        setTimeout(collect, 60);
      }
    };
    if (${readingRun}) {
      // A real click on the real button, then no answer: the virtual clock makes
      // the wait free and the line has to be there when the dump is taken.
      contentBeforeTheClick = document.getElementById("content").children.length;
      document.getElementById("refresh-button").click();
      setTimeout(collect, 700);
    } else if (${sectionArg === null ? "false" : "true"}) {
      const item = document.querySelector('[data-section="${sectionArg ?? ""}"]');
      if (item === null) throw new Error("no sidebar item for section ${sectionArg ?? ""}");
      item.click();
      if (${tabArg === null ? "false" : "true"}) clickTab(${JSON.stringify(tabArg ?? "")});
      setTimeout(collect, 120);
    } else if (${tabArg === null ? "false" : "true"}) {
      clickTab(${JSON.stringify(tabArg ?? "")});
      setTimeout(collect, 120);
    } else if (${keyboardRun}) {
      tabKeyboard = probeKeyboard();
      setTimeout(collect, 120);
    } else {
      collect();
    }
  });
})();`;
  // The page's script is assembled by string replacement, so a stray backtick or
  // quote inside the injected code is a syntax error that only surfaces as a
  // blank screenshot with a byte offset. Compile it here, where the failure
  // names the file and the line.
  try {
    new vm.Script(geometry + "\n" + js, { filename: "dashboard-page.js" });
  } catch (error) {
    const where = String(error.stack ?? "").split("\n").slice(0, 3).join("\n");
    throw new Error(`the page's inline script does not parse: ${error.message}\n${where}`);
  }
  return html
    .replace(/<meta http-equiv="Content-Security-Policy"[\s\S]*?\/>/, "")
    .replace("<body>", `<body class="${theme === "light" ? "vscode-light" : "vscode-dark"}">`)
    .replace("<link rel=\"stylesheet\" href=\"{{style}}\" />", `<style>\n${themeCss}\n${css}\n</style>`)
    .replace("<script nonce=\"{{nonce}}\" src=\"{{mainJs}}\"></script>", `<script>\n${geometry}\n${js}\n</script>`)
    // Stands in for asWebviewUri(): the harness points the brand mark at the
    // packaged file so the screenshot exercises the real asset.
    .replace("{{iconUri}}", `file:///${path.join(packageDir, "media", "avenic.png").replaceAll("\\", "/")}`);
}

// A PNG's own header is the only thing that says what the file is: the signature,
// then the IHDR chunk, whose first two fields are the pixel size.
export function pngSize(bytes) {
  if (bytes.length < 24) return null;
  if (bytes.readUInt32BE(0) !== 0x89504e47 || bytes.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  if (bytes.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

// What is wrong with the screenshot, or null when it is the picture this run
// asked for: one the browser never wrote, one it refused to overwrite — a locked
// file leaves the previous run's shot in place — or one at another size, which
// would be published beside numbers describing a layout it does not show.
export function shotProblem(file, width, height, startedAt) {
  if (!existsSync(file)) return `no screenshot at ${file} — the browser wrote nothing`;
  const written = statSync(file);
  if (written.mtimeMs < startedAt) return `${file} is older than this run (written ${written.mtime.toISOString()}) — the browser did not overwrite it`;
  const size = pngSize(readFileSync(file));
  if (size === null) return `${file} is not a PNG`;
  if (size.width !== width || size.height !== height) return `${file} is ${size.width}x${size.height}, not the requested ${width}x${height}`;
  return null;
}

// --dump-dom reserves frame pixels, so the corrected pass is the one that has to
// land back on the requested viewport; a page that measured at another dpr is in
// other units again, and neither number would be the PNG's own pixels.
export function viewportProblem(rects, width, height) {
  const viewport = rects.viewport;
  if (viewport === undefined) return "the geometry dump records no viewport";
  if (viewport.dpr !== 1) return `the page measured at dpr ${viewport.dpr}, not 1 — the PNG's pixels and the dumped rects are then in different units`;
  if (viewport.clientW !== width || viewport.clientH !== height) return `the dump measured a ${viewport.clientW}x${viewport.clientH} viewport, not the requested ${width}x${height}`;
  return null;
}

function main() {
  const edge = browser();
  mkdirSync(path.dirname(outPath), { recursive: true });
  const payload = JSON.parse(readFileSync(payloadPath, "utf8"));
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
  const page = buildPage(payload, fixture);
  const pagePath = path.join(path.dirname(outPath), path.basename(outPath, ".png") + ".html");
  writeFileSync(pagePath, page, "utf8");

  const profile = path.join(path.dirname(outPath), ".edge-profile");
  const common = [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    "--virtual-time-budget=6000",
    // The brand mark is measured through a canvas; a file:// image taints it
    // without this flag and the ink box would silently come back null.
    "--allow-file-access-from-files",
    `--user-data-dir=${profile}`,
  ];
  const url = `file:///${pagePath.replaceAll("\\", "/")}`;

  function screenshot(windowWidth, windowHeight) {
    execFileSync(edge, [...common, `--window-size=${windowWidth},${windowHeight}`, `--screenshot=${outPath}`, url], { stdio: ["ignore", "pipe", "pipe"] });
  }

  function dump(windowWidth, windowHeight) {
    const dom = execFileSync(edge, [...common, `--window-size=${windowWidth},${windowHeight}`, "--dump-dom", url], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    const match = dom.match(/<script type="application\/json" id="avenic-geometry">([\s\S]*?)<\/script>/);
    return match === null ? null : JSON.parse(match[1]);
  }

  // The two passes do not agree on what --window-size means, and both halves of
  // this harness depend on knowing which: --screenshot lays the page out at the
  // window size and writes an image that size, while --dump-dom reserves frame
  // pixels (30x95 on the machine this was built on) and lays it out smaller.
  //
  // So the screenshot is taken once, at the requested size — it is already the
  // viewport the reference was measured in — and only the dump is re-taken,
  // corrected by the reserve it reports. Correcting both (the obvious reading of
  // "the window is bigger than the viewport") silently widened the PNG's layout
  // by 30px, so the picture on screen was never the geometry the compare step
  // gated: the card columns sat 28px right of the numbers that called them perfect.
  const startedAt = Date.now();
  rmSync(outPath, { force: true });
  screenshot(width, height);
  const unwritten = shotProblem(outPath, width, height, startedAt);
  if (unwritten !== null) throw new Error(unwritten);
  let rects = dump(width, height);
  if (rects?.viewport) {
    const dw = width - rects.viewport.clientW;
    const dh = height - rects.viewport.clientH;
    if (dw !== 0 || dh !== 0) rects = dump(width + dw, height + dh);
  }

  if (rects === null) {
    console.error("geometry dump missing — the page never rendered #app content");
    process.exitCode = 1;
    return;
  }
  const remeasured = viewportProblem(rects, width, height);
  if (remeasured !== null) throw new Error(remeasured);
  const geometryPath = outPath.replace(/\.png$/, "") + ".geometry.json";
  writeFileSync(geometryPath, JSON.stringify(rects, null, 1), "utf8");
  const vp = rects.viewport;
  console.log(`shot ${outPath} (${vp.clientW}x${vp.clientH} viewport, ${theme}) + ${geometryPath}`);
}

// Entry guard, not a bare call: importing this file must not launch a browser,
// so the checks above can be tested on their own.
const isEntry = process.argv[1] !== undefined && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isEntry) main();
