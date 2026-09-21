import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const visualDir = path.join(pkgDir, "test", "visual");

// The comparison's verdict is the whole point of the file, so it is exercised as
// a process: a fixture on disk, a dump on disk, and the exit code a release would
// read. No browser is launched and nothing under dist/ is needed — the dump is
// written by hand, exactly as shot.mjs would have written it.
const scratch: string[] = [];
after(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
});

// `structure` and `gates` describe the dump's structural table and the fixture's
// structural gate list. They default to one gate the synthetic page satisfies, so
// the anchor tests below stay about anchors; the tests that follow replace them to
// show that half of the comparison can fail (and that it refuses to run blind).
async function pair(
  anchors: unknown[],
  viewport: { clientW: number; clientH: number; dpr?: number },
  rects: Record<string, unknown>,
  structure: Record<string, unknown> | null = { "card.width": 10 },
  gates: unknown[] | null = [{ name: "card.width", key: "card.width", expect: 10, tol: 0, note: "the synthetic page's own width" }],
): Promise<{ geometry: string; fixture: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "avenic-compare-"));
  scratch.push(dir);
  const fixture = path.join(dir, "fixture.json");
  const geometry = path.join(dir, "shot.geometry.json");
  const declared = gates === null ? {} : { structure: gates };
  const measured = structure === null ? {} : { structure };
  await writeFile(fixture, `${JSON.stringify({ meta: { source: "reference.png (100x50)", activityBar: 0, tolerance: 2 }, anchors, ...declared }, null, 2)}\n`, "utf8");
  await writeFile(geometry, `${JSON.stringify({ viewport: { dpr: 1, ...viewport }, anchors: rects, ...measured }, null, 1)}\n`, "utf8");
  return { geometry, fixture };
}

// The anchor's reference band is [0,9] in both axes; a 10x10 rect at the origin is
// its exact DOM equivalent (right/bottom edges are exclusive).
const anchor = { name: "card", selector: ".card", ref: { x0: 0, x1: 9, y0: 0, y1: 9 } };
const rect = { x: 0, y: 0, w: 10, h: 10 };

function compare(files: { geometry: string; fixture: string }, extra: string[] = []): { status: number; output: string } {
  try {
    return {
      status: 0,
      output: execFileSync(process.execPath, [path.join(visualDir, "compare.mjs"), "--fixture", files.fixture, "--geometry", files.geometry, ...extra], { encoding: "utf8" }),
    };
  } catch (error) {
    const failure = error as { status?: number | null; stdout?: string; stderr?: string };
    return { status: failure.status ?? -1, output: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
}

// A run with nothing to compare is a broken fixture or a broken dump, not a clean
// comparison: `0/0 … PASS` was published from this directory once, and every
// check downstream of it read as agreement.
test("a fixture that lists no anchors fails instead of passing on nothing", async () => {
  const result = compare(await pair([], { clientW: 100, clientH: 50 }, {}));
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /no anchors/);
});

test("anchors the dump does not carry fail instead of passing on nothing", async () => {
  const result = compare(await pair([anchor], { clientW: 100, clientH: 50 }, {}));
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /none could be compared/);
});

test("a fixture and a dump that agree pass", async () => {
  const result = compare(await pair([anchor], { clientW: 100, clientH: 50 }, { card: rect }));
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /PASS/);
});

test("an edge outside its tolerance still fails the run", async () => {
  const result = compare(await pair([anchor], { clientW: 100, clientH: 50 }, { card: { ...rect, x: 40 } }));
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /card/);
});

// The comparison turns the reference image's own pixels into webview coordinates,
// so a dump measured at another size describes a layout the reference never had.
test("a dump measured at another viewport than the fixture's reference is refused", async () => {
  const result = compare(await pair([anchor], { clientW: 800, clientH: 600 }, { card: rect }));
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /800x600/);
  assert.match(result.output, /100x50/);
});

test("--width/--height is the size the dump is held to", async () => {
  const result = compare(await pair([anchor], { clientW: 100, clientH: 50 }, { card: rect }), ["--width", "640", "--height", "480"]);
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /640x480/);
});

// A page can put every anchored edge where the reference put it and still not be
// the dashboard: the structure gates are the half that notices, and each of them
// is only worth having if it can go red on a page (or a dump) that disagrees.
test("a structural gate the dump disagrees with fails the run", async () => {
  const result = compare(await pair([anchor], { clientW: 100, clientH: 50 }, { card: rect }, { "card.width": 40 }));
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /card\.width/);
  assert.match(result.output, /structural gate/);
});

// One gate cannot compare a value: the footer names whichever CLI the reader is
// running, so the number in it belongs to the machine. The gate is the pattern,
// and the digits are reported rather than compared — which is only worth doing if
// both halves hold: a different number passes and is still printed, a string that
// is not the pattern fails.
test("a pattern gate passes on another machine's digits and still reports them", async () => {
  const gate = { name: "sidebar.footer.version", key: "sidebar.footer", match: "^Avenic v[0-9]+\\.[0-9]+\\.[0-9]+$", note: "the footer's shape, not its digits" };
  const files = await pair([anchor], { clientW: 100, clientH: 50 }, { card: rect }, { "sidebar.footer": "Avenic v1.8.3" }, [gate]);
  const result = compare(files);
  assert.equal(result.status, 0, result.output);
  const sidecar = JSON.parse(await readFile(files.geometry.replace(/\.geometry\.json$/, ".compare.json"), "utf8")) as {
    structural: { rows: { name: string; measured: unknown }[] };
  };
  const row = sidecar.structural.rows.find((entry) => entry.name === "sidebar.footer.version");
  assert.equal(row?.measured, "Avenic v1.8.3", "the exact text the page drew is reported even though it is not gated");
  const other = compare(await pair([anchor], { clientW: 100, clientH: 50 }, { card: rect }, { "sidebar.footer": "Avenic" }, [gate]));
  assert.notEqual(other.status, 0, other.output);
  assert.match(other.output, /sidebar\.footer\.version/);
});

test("a dump with no structure table fails instead of passing its gates by absence", async () => {
  const result = compare(await pair([anchor], { clientW: 100, clientH: 50 }, { card: rect }, null));
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /no structure table/);
});

test("a fixture that declares no structural gates is refused", async () => {
  const result = compare(await pair([anchor], { clientW: 100, clientH: 50 }, { card: rect }, { "card.width": 10 }, null));
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /no structural gates/);
});

// Imported by URL rather than statically: shot.mjs is an entry script, and an
// import that inlined it would run its body (its entry guard compares
// import.meta.url with argv[1], which bundling rewrites to the test file).
const shot = (await import(pathToFileURL(path.join(visualDir, "shot.mjs")).href)) as {
  pngSize: (bytes: Buffer) => { width: number; height: number } | null;
  shotProblem: (file: string, width: number, height: number, startedAt: number) => string | null;
  viewportProblem: (rects: unknown, width: number, height: number) => string | null;
};

// A real 1x1 PNG, so the size reader is tested against an encoder's output rather
// than against a header this file wrote itself.
const ONE_PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

async function shotFile(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "avenic-shot-"));
  scratch.push(dir);
  const file = path.join(dir, "shot.png");
  await writeFile(file, ONE_PIXEL);
  return file;
}

test("the PNG's own header is what says how big it is", () => {
  assert.deepEqual(shot.pngSize(ONE_PIXEL), { width: 1, height: 1 });
  assert.equal(shot.pngSize(Buffer.from("this is not a png, but it is long enough")), null);
});

// The picture is the artifact a person trusts and the dump is what gets gated, so
// a file that was not written this run, or is not the size that was asked for,
// must stop the run instead of being published beside numbers for another layout.
test("a screenshot that was never written is refused", async () => {
  const file = await shotFile();
  const problem = shot.shotProblem(path.join(path.dirname(file), "absent.png"), 1, 1, Date.now());
  assert.match(String(problem), /no screenshot/);
});

test("a screenshot the browser did not overwrite is refused", async () => {
  const file = await shotFile();
  const past = new Date(Date.now() - 60_000);
  await utimes(file, past, past);
  assert.match(String(shot.shotProblem(file, 1, 1, Date.now())), /older than this run/);
});

test("a screenshot of another size than the requested one is refused", async () => {
  const file = await shotFile();
  const problem = String(shot.shotProblem(file, 800, 600, Date.now() - 60_000));
  assert.match(problem, /1x1/);
  assert.match(problem, /800x600/);
});

test("a fresh screenshot of the requested size passes", async () => {
  const file = await shotFile();
  assert.equal(shot.shotProblem(file, 1, 1, Date.now() - 60_000), null);
});

// --dump-dom reserves frame pixels, so shot.mjs re-takes the dump with a corrected
// window size. A correction that lands anywhere but the requested viewport leaves
// the gate measuring a layout the picture does not show — which has happened.
test("the dump's own viewport has to be the requested one", () => {
  assert.equal(shot.viewportProblem({ viewport: { clientW: 1491, clientH: 1024, dpr: 1 } }, 1491, 1024), null);
  assert.match(String(shot.viewportProblem({ viewport: { clientW: 1461, clientH: 1024, dpr: 1 } }, 1491, 1024)), /1461x1024/);
  assert.match(String(shot.viewportProblem({ viewport: { clientW: 1491, clientH: 1024, dpr: 1.5 } }, 1491, 1024)), /dpr/);
  assert.match(String(shot.viewportProblem({}, 1491, 1024)), /no viewport/);
});
