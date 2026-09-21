// Minimal-reproduction harness: renders a hand-written HTML fragment against
// the *real* style.css and dumps rects for the given selectors. Used to decide
// whether a layout surprise comes from the stylesheet or from what main.js
// builds, without guessing.
//
// Usage:
//   node test/visual/probe.mjs --fragment <file.html> --select ".field-row,.field-value,.badge" [--width 900]
//
// --width names a *viewport*, not a window: the dump pass reserves frame pixels
// (30x95 on this machine), so the run is corrected to the window size that
// actually lays the fragment out at width x 800, and the viewport the rects came
// from is printed above them.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(here, "..", "..");
const media = path.join(packageDir, "media", "dashboard");

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i];
  if (key.startsWith("--")) args.set(key.slice(2), process.argv[i + 1]);
}

const fragment = readFileSync(path.resolve(process.cwd(), args.get("fragment")), "utf8");
const selectors = (args.get("select") ?? ".field-row").split(",");
const width = Number(args.get("width") ?? 900);

const EDGE = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find((p) => existsSync(p));
if (EDGE === undefined) throw new Error("Edge not found");

const css = readFileSync(path.join(media, "style.css"), "utf8")
  .replaceAll('url("./codicon.ttf")', `url("file:///${path.join(media, "codicon.ttf").replaceAll("\\", "/")}")`);

const page = `<!doctype html>
<html><head><meta charset="utf-8"><style>
body.vscode-dark {
  --vscode-font-family: 'Segoe UI', system-ui, sans-serif;
  --vscode-font-size: 13px;
  --vscode-editor-font-family: 'Cascadia Mono', Consolas, monospace;
}
${css}
</style></head>
<body class="vscode-dark">
${fragment}
<script>
window.addEventListener("load", () => {
  const out = ${JSON.stringify(selectors)}.map((sel) => {
    const nodes = [...document.querySelectorAll(sel)];
    return [sel, nodes.length, nodes.slice(0, 12).map((n) => {
      const r = n.getBoundingClientRect();
      const c = getComputedStyle(n);
      return { y: +r.y.toFixed(1), h: +r.height.toFixed(1), w: +r.width.toFixed(1), x: +r.x.toFixed(1), display: c.display, alignItems: c.alignItems, minHeight: c.minHeight, flexWrap: c.flexWrap, kids: n.children.length };
    })];
  });
  const viewport = {
    clientW: document.documentElement.clientWidth,
    clientH: document.documentElement.clientHeight,
    dpr: window.devicePixelRatio,
  };
  const s = document.createElement("script");
  s.type = "application/json"; s.id = "probe";
  s.textContent = JSON.stringify({ viewport: viewport, selectors: out });
  document.body.appendChild(s);
  document.title = "READY";
});
</script></body></html>`;

const outDir = path.resolve(process.cwd(), args.get("out") ?? path.join(here, "probe-page.html"));
writeFileSync(outDir, page, "utf8");
const common = ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1", "--virtual-time-budget=4000", `--user-data-dir=${path.join(path.dirname(outDir), ".edge-profile")}`];
const url = `file:///${outDir.replaceAll("\\", "/")}`;

// The height the fragment is laid out at: --width names the other axis, the way
// shot.mjs's --height names one when it takes a picture.
const VIEWPORT_HEIGHT = 800;

function dump(windowWidth, windowHeight) {
  const dom = execFileSync(EDGE, [...common, `--window-size=${windowWidth},${windowHeight}`, "--dump-dom", url], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  const match = dom.match(/<script type="application\/json" id="probe">([\s\S]*?)<\/script>/);
  return match === null ? null : JSON.parse(match[1]);
}

// --dump-dom reserves frame pixels, so the window it is handed is not the
// viewport it lays the fragment out in: --width 900 measured a ~870-wide layout
// and the rects came back explaining a viewport nobody had named. The same
// two-pass correction shot.mjs uses: take the dump, correct the window by the
// reserve it reports, take it again, and print what actually landed.
let windowWidth = width;
let windowHeight = VIEWPORT_HEIGHT;
let result = dump(windowWidth, windowHeight);
if (result?.viewport) {
  windowWidth += width - result.viewport.clientW;
  windowHeight += VIEWPORT_HEIGHT - result.viewport.clientH;
  if (windowWidth !== width || windowHeight !== VIEWPORT_HEIGHT) result = dump(windowWidth, windowHeight);
}
if (result === null || result.viewport === undefined) {
  console.log("no probe output");
} else {
  const landed = result.viewport.clientW === width && result.viewport.clientH === VIEWPORT_HEIGHT;
  const where = `--window-size=${windowWidth},${windowHeight}`;
  console.log(`viewport ${width}x${VIEWPORT_HEIGHT} requested, ${result.viewport.clientW}x${result.viewport.clientH} measured (dpr ${result.viewport.dpr}) via ${where}${landed ? "" : " — MISMATCH: the rects below describe a different viewport"}`);
  if (!landed) process.exitCode = 1;
  console.log(JSON.stringify(result.selectors, null, 1));
}
