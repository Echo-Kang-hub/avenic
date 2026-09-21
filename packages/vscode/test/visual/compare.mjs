// Reference-vs-implementation geometry comparison for the dashboard webview.
//
// shot.mjs renders the real media files and dumps the boxes named by
// fixtures/reference-geometry.json; this script converts the reference's
// source-image measurements into webview coordinates and reports edge deltas.
//
// It gates two different things, and the second is why the file is longer than a
// table of deltas:
//
//   * edges — every anchor in the fixture, against the reference's own pixels;
//   * structure — the boxes can all be right and the page still not be this
//     dashboard. Three agent cards in the wrong order, a two-column row folded
//     into one, Skills moved under Sessions: each of those can keep an anchor
//     where the reference put it, or land there for reasons of its own. The
//     fixture's `structure` list names the measurements that settle it, and
//     shot.mjs dumps them as its `structure` table.
//
// Both are fatal, and both refuse to run on nothing: a fixture that lists no
// anchors or no structural gates, and a dump that carries no rectangles or no
// structure table, are broken inputs rather than clean runs.
//
// It is deliberately a separate step from `npm test`: it needs a browser and it
// is a measurement, not a unit test. Run it through `npm run test:visual`, or:
//
//   node test/visual/compare.mjs --geometry ../../dist/dashboard-visual/shots/v2-overview.geometry.json
//   node test/visual/compare.mjs --geometry <dump> --fixture <fixture> --width 1491 --height 1024
//
// Exit code is 0 only when every compared edge is inside its tolerance, every
// structural gate passes, *and* there was something to compare: a fixture that
// lists no anchors, a dump none of them are in, a dump measured at another
// viewport than the reference's, and an anchor whose `ref` names no edge at all
// are all failures, so it can gate a release the same way the test suite does.
//
// The size is the fixture's own source image less the activity bar, or whatever
// --width/--height says; the dump has to have been measured at it.
//
// Coordinates: the reference PNG is a 1536-wide window whose leftmost 45px are
// VS Code's own activity bar. Reference x is therefore shifted by -45; y is
// shared. Edges are compared as DOM rect edges (left/right are inclusive
// positions, so the reference's inclusive pixel band [x0,x1] is the rect
// [x0, x1 + 1)).

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i];
  if (key.startsWith("--")) args.set(key.slice(2), process.argv[i + 1]);
}

const geometryPath = path.resolve(process.cwd(), args.get("geometry") ?? path.join(here, "..", "..", "..", "..", "dist", "dashboard-visual", "shots", "v2-overview.geometry.json"));
const fixturePath = path.resolve(process.cwd(), args.get("fixture") ?? path.join(here, "fixtures", "reference-geometry.json"));

const geometry = JSON.parse(readFileSync(geometryPath, "utf8"));
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
const bar = fixture.meta.activityBar;
const defaultTolerance = fixture.meta.tolerance ?? 2;

const EDGES = ["left", "right", "top", "bottom"];

function reference(anchor) {
  const { x0, x1, y0, y1 } = anchor.ref;
  const out = {};
  if (x0 !== undefined) out.left = x0 - bar;
  if (x1 !== undefined) out.right = x1 - bar + 1;
  if (y0 !== undefined) out.top = y0;
  if (y1 !== undefined) out.bottom = y1 + 1;
  return out;
}

function measured(rect) {
  return { left: rect.x, right: rect.x + rect.w, top: rect.y, bottom: rect.y + rect.h };
}

const rows = [];
for (const anchor of fixture.anchors) {
  const rect = geometry.anchors?.[anchor.name] ?? null;
  const want = reference(anchor);
  const tolerance = anchor.tol ?? defaultTolerance;
  if (rect === null) {
    // A node the dump has no rectangle for is a measurement that never happened,
    // not a row to skip: it fails below with its own reason, the same as an
    // anchor outside tolerance.
    rows.push({ name: anchor.name, selector: anchor.selector, edges: [], passed: false, missing: true, noEdges: false, reportOnly: false });
    continue;
  }
  const got = measured(rect);
  const edges = [];
  for (const edge of EDGES) {
    if (want[edge] === undefined) continue;
    const delta = +(got[edge] - want[edge]).toFixed(1);
    // A text anchor's vertical box is a line box, which sits above the ink the
    // reference measured; its x is the glyph run and is compared for real.
    const textEdge = anchor.text !== undefined && (edge === "top" || edge === "bottom");
    // `infoEdges` marks an edge the reference settles with type metrics this
    // build cannot own (a run's advance under a different face): reported, not
    // gated. It is a per-edge variant of the same honesty as `tol`.
    const infoEdge = (anchor.infoEdges ?? []).includes(edge);
    const gated = !textEdge && !infoEdge;
    edges.push({ edge, reference: want[edge], implemented: got[edge], delta, tolerance, passed: !gated || Math.abs(delta) <= tolerance, gated });
  }
  // A `ref` that names none of x0/x1/y0/y1 leaves nothing to compare, and
  // `[].every(...)` is true: the anchor used to read as a pass while its row had
  // no edges in it. A fixture that ships one is broken, not clean, so it fails.
  const noEdges = edges.length === 0;
  // Every edge declared informational — a text anchor's line box, an `infoEdges`
  // run the reference's face settles — means the fixture asked for this anchor to
  // be printed, not gated. It is named as report-only in the summary and never
  // counted as coverage; an anchor cannot reach this state without declaring
  // each edge of its own `ref` ungated.
  const reportOnly = !noEdges && edges.every((edge) => !edge.gated);
  rows.push({ name: anchor.name, selector: anchor.selector, edges, passed: !noEdges && edges.every((edge) => edge.passed), missing: false, noEdges, reportOnly });
}

// The structural gates, read the same way the anchors are: the fixture names a
// measurement, shot.mjs's `structure` table carries what the page measured, and
// the two are held against each other. Each gate therefore has to say *what* it
// asserts (`key`), *what it expects* and *how far off it may be* (`tol`) — a
// gate without a tolerance is a gate nobody can keep.
//
// A number compares within its tolerance; a "r,g,b" triple compares per channel
// under the same tolerance, because a hue has no single meaningful delta; a
// `match` gate compares the shape of a string and not its contents, for the one
// measurement whose contents belong to the machine rather than to the design —
// the footer names whichever CLI the reader is running, so its digits move
// between machines and only "Avenic v" and a dotted number are the page's own
// promise. The measured string is still reported (`rows[].measured`), because
// what it said is the useful half of the answer; it is simply not the gate.
// Every other value compares exactly, since "true", "overview" and a section
// order are answers rather than measurements.
const NUMBERS = /^-?\d+(?:\.\d+)?(?:,-?\d+(?:\.\d+)?)*$/;

function measure(gate, value) {
  if (value === undefined) return { passed: false, delta: null, detail: `no measurement named ${gate.key} in the geometry dump` };
  const tolerance = gate.tol ?? 0;
  if (typeof gate.match === "string") {
    const pattern = new RegExp(gate.match);
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return { passed: pattern.test(text), delta: null, detail: `/${gate.match}/ vs ${JSON.stringify(text)}` };
  }
  if (typeof gate.expect === "number" || typeof value === "number") {
    if (typeof gate.expect !== "number" || typeof value !== "number") {
      return { passed: false, delta: null, detail: `${JSON.stringify(value)} is not a number` };
    }
    const delta = +(value - gate.expect).toFixed(1);
    return { passed: Math.abs(delta) <= tolerance, delta, detail: `${gate.expect} → ${value} (${delta > 0 ? "+" : ""}${delta}, tol ${tolerance})` };
  }
  if (typeof gate.expect === "string" && NUMBERS.test(gate.expect) && typeof value === "string" && NUMBERS.test(value)) {
    const want = gate.expect.split(",").map(Number);
    const got = value.split(",").map(Number);
    if (want.length !== got.length) return { passed: false, delta: null, detail: `${gate.expect} → ${value}` };
    const deltas = got.map((channel, index) => channel - want[index]);
    const worst = deltas.reduce((worst, delta) => (Math.abs(delta) > Math.abs(worst) ? delta : worst), 0);
    return { passed: deltas.every((delta) => Math.abs(delta) <= tolerance), delta: worst, detail: `${gate.expect} → ${value} (worst channel ${worst > 0 ? "+" : ""}${worst}, tol ${tolerance})` };
  }
  return { passed: gate.expect === value, delta: null, detail: `${JSON.stringify(gate.expect)} → ${JSON.stringify(value)}` };
}

const structure = geometry.structure ?? null;
const declaredGates = Array.isArray(fixture.structure) ? fixture.structure : [];
const structuralRows = declaredGates.map((gate) => ({ ...gate, measured: structure === null ? undefined : structure[gate.key], ...measure(gate, structure === null ? undefined : structure[gate.key]) }));

const failures = rows.filter((row) => !row.passed);
const structuralFailures = structuralRows.filter((row) => !row.passed);
const missing = rows.filter((row) => row.missing);
const edgeLess = rows.filter((row) => row.noEdges);
const reportOnly = rows.filter((row) => row.reportOnly);
const gatedAnchors = rows.length - reportOnly.length;
const compared = rows.reduce((sum, row) => sum + row.edges.filter((edge) => edge.gated).length, 0);
const passed = rows.reduce((sum, row) => sum + row.edges.filter((edge) => edge.gated && edge.passed).length, 0);

// A comparison that compared nothing is a broken input, not a clean run: both
// halves of it arrive from disk, either can be empty, and every check below
// passes on an empty table. `0/0 … PASS` was published from this directory once,
// with the geometry gate reading as agreement for a dashboard nothing measured.
function whyNothing() {
  if (missing.length === rows.length) {
    return `the geometry dump has no rectangle for any of them (${missing[0].name}, \`${missing[0].selector}\`, is the first)`;
  }
  if (missing.length > 0) return `${missing.length} of them are absent from the geometry dump (${missing[0].name} is the first)`;
  if (edgeLess.length > 0) return `${edgeLess.length} of them name no edge to compare at all (${edgeLess[0].name}, \`${edgeLess[0].selector}\`, is the first)`;
  return `all ${reportOnly.length} of them are report-only — a text anchor's line box or an \`infoEdges\` run, printed but never gated`;
}

// The reference's own viewport: the fixture's source image, less the activity
// bar, unless the caller says otherwise. It is what the dumped rectangles have
// to have been measured at — the comparison converts that image's pixel
// positions, and at another size the layout has simply reflowed.
function requestedViewport() {
  const width = Number(args.get("width"));
  const height = Number(args.get("height"));
  if (Number.isFinite(width) && Number.isFinite(height)) return { width, height, from: "passed with --width/--height" };
  const source = /(\d+)\s*[x×]\s*(\d+)/.exec(fixture.meta?.source ?? "");
  if (source === null) return null;
  const measured = { width: Number(source[1]) - Number(bar), height: Number(source[2]) };
  if (!Number.isFinite(measured.width) || !Number.isFinite(measured.height)) return null;
  return { ...measured, from: `the fixture's source image, ${source[1]}x${source[2]}, less the ${bar}px activity bar` };
}

const requested = requestedViewport();
const problems = [];
if (rows.length === 0) problems.push("the fixture lists no anchors");
else if (compared === 0) problems.push(`the fixture lists ${rows.length} anchor(s) but none could be compared — ${whyNothing()}`);
// The structural half, with the same two ways of being vacuous: a fixture that
// declares no gates, and a dump that carries nothing to measure them against.
// Either one turns every gate below it green by absence, which is the failure
// mode this file has already been caught by once (see whyNothing above).
if (declaredGates.length === 0) {
  problems.push("the fixture declares no structural gates — the reference's own structure (the sidebar, the three agent cards, the two-column rows, the section order) would then not be compared at all");
} else if (structure === null) {
  problems.push(`the geometry dump carries no structure table, so all ${declaredGates.length} structural gate(s) are unmeasured — shot.mjs produced an older shape`);
} else if (structuralFailures.length > 0) {
  problems.push(`${structuralFailures.length} of ${declaredGates.length} structural gate(s) failed: ${structuralFailures.map((row) => row.name).join(", ")}`);
}
if (edgeLess.length > 0) problems.push(`${edgeLess.length} anchor(s) name no reference edge to compare: ${edgeLess.map((row) => row.name).join(", ")}`);
if (geometry.viewport === undefined) {
  problems.push("the geometry dump records no viewport, so it cannot be held to the size the reference was measured at");
} else if (requested === null) {
  problems.push(`the fixture does not say which viewport the reference was measured at (source: ${JSON.stringify(fixture.meta?.source ?? null)}) — pass --width and --height`);
} else if (geometry.viewport.clientW !== requested.width || geometry.viewport.clientH !== requested.height) {
  problems.push(`the geometry dump was measured at ${geometry.viewport.clientW}x${geometry.viewport.clientH}, not the requested ${requested.width}x${requested.height} (${requested.from})`);
}
if (missing.length > 0) problems.push(`${missing.length} anchor(s) absent from the geometry dump: ${missing.map((row) => row.name).join(", ")}`);
const outsideTolerance = failures.filter((row) => !row.noEdges && !row.missing);
if (outsideTolerance.length > 0) problems.push(`${outsideTolerance.length} anchor(s) outside tolerance: ${outsideTolerance.map((row) => row.name).join(", ")}`);

const lines = [];
lines.push(`# Dashboard geometry: reference vs implemented`);
lines.push("");
lines.push(`reference: ${fixture.meta.source}`);
lines.push(`implemented: ${path.basename(geometryPath)} (${geometry.viewport.clientW}x${geometry.viewport.clientH} viewport, dpr ${geometry.viewport.dpr})`);
lines.push("");
lines.push(`Compared edges inside tolerance: ${passed}/${compared} across ${rows.length} anchors${reportOnly.length === 0 ? "" : `, of which ${reportOnly.length} are report-only and gate nothing (${reportOnly.map((row) => row.name).join(", ")})`}.`);
lines.push(`Structural gates passed: ${structuralRows.length - structuralFailures.length}/${structuralRows.length}${declaredGates.length === 0 ? " (the fixture declares none)" : ""}.`);
lines.push("");
lines.push("| anchor | element | edge | reference | implemented | delta | tol | verdict |");
lines.push("| --- | --- | --- | ---: | ---: | ---: | ---: | --- |");
for (const row of rows) {
  if (row.missing) {
    lines.push(`| ${row.name} | \`${row.selector}\` | — | — | — | — | — | MISSING |`);
    continue;
  }
  if (row.noEdges) {
    lines.push(`| ${row.name} | \`${row.selector}\` | — | — | — | — | — | NO EDGE |`);
    continue;
  }
  for (const edge of row.edges) {
    const mark = edge.gated ? (edge.passed ? "ok" : "**FAIL**") : "info";
    lines.push(`| ${row.name} | \`${row.selector}\` | ${edge.edge} | ${edge.reference} | ${edge.implemented} | ${edge.delta > 0 ? "+" : ""}${edge.delta} | ${edge.tolerance} | ${mark} |`);
  }
}
// The structural table: one row per declared gate, so a red names the thing that
// changed rather than the box it moved. The note column carries the reason a
// tolerance is what it is, next to the number it applies to.
if (structuralRows.length > 0) {
  lines.push("");
  lines.push("| structure gate | measurement | expected | measured | delta | tol | verdict |");
  lines.push("| --- | --- | --- | --- | ---: | ---: | --- |");
  for (const row of structuralRows) {
    // A `match` gate has no `expect`, so the column that would print it prints
    // the pattern instead — a table reading `undefined` next to a passing row
    // is exactly the kind of report nobody can use to check the gate.
    const pattern = typeof row.match === "string";
    const expected = pattern ? `\`/${row.match}/\`` : JSON.stringify(row.expect);
    // Its tolerance is the shape of the pattern, not a number of pixels: the
    // tol column says so rather than printing a 0 that would read as "exact".
    const tol = pattern ? "pattern" : (row.tol ?? 0);
    lines.push(`| ${row.name} | \`${row.key}\` | ${expected} | ${JSON.stringify(row.measured)} | ${row.delta === null ? "—" : (row.delta > 0 ? "+" : "") + row.delta} | ${tol} | ${row.passed ? "ok" : "**FAIL**"} |`);
  }
  const noted = structuralRows.filter((row) => typeof row.note === "string");
  for (const row of noted) lines.push(`- ${row.name}: ${row.note}`);
}
lines.push("");
lines.push(problems.length === 0
  ? `PASS — every compared edge is within tolerance and every structural gate holds.`
  : `FAIL — ${problems.join("; ")}`);
const report = lines.join("\n");

const stem = geometryPath.replace(/\.geometry\.json$/, "");
writeFileSync(`${stem}.compare.md`, `${report}\n`, "utf8");
writeFileSync(`${stem}.compare.json`, `${JSON.stringify({ viewport: geometry.viewport, requested, compared, passed, gatedAnchors, reportOnly: reportOnly.map((row) => row.name), noEdges: edgeLess.map((row) => row.name), missing: missing.map((row) => row.name), problems, failures: failures.map((row) => row.name), rows, structural: { declared: declaredGates.length, passed: structuralRows.length - structuralFailures.length, failures: structuralFailures.map((row) => row.name), rows: structuralRows } }, null, 1)}\n`, "utf8");

// The console view is the same table without the markdown pipes — the verdict's
// own reasons first, then one line per failing anchor and per failing structural
// gate, so a broken layout is readable without scrolling.
for (const problem of problems) console.log(`FAIL ${problem}`);
for (const row of failures) {
  const detail = row.missing
    ? "absent from the geometry dump"
    : row.noEdges
      ? "names no reference edge to compare"
      : row.edges.filter((edge) => !edge.passed).map((edge) => `${edge.edge} ${edge.reference}→${edge.implemented} (${edge.delta > 0 ? "+" : ""}${edge.delta} > ${edge.tolerance})`).join(", ");
  console.log(`FAIL ${row.name.padEnd(22)} ${detail}`);
}
for (const row of structuralFailures) {
  console.log(`FAIL structure:${row.name.padEnd(22)} ${row.key} — ${row.detail}`);
}
console.log(report.split("\n").slice(-1)[0]);
console.log(`edges ${passed}/${compared} ok · ${rows.length} anchors (${gatedAnchors} gated${reportOnly.length === 0 ? "" : `, ${reportOnly.length} report-only`}) · structure ${structuralRows.length - structuralFailures.length}/${structuralRows.length} gates · report: ${path.relative(process.cwd(), `${stem}.compare.md`)}`);
// The last word, so an empty run cannot be reset to green above.
process.exitCode = problems.length === 0 ? 0 : 1;
