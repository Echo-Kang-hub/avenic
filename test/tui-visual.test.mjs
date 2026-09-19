// The terminal surfaces, pinned. Every screen the CLI can paint is rendered
// through the production code and compared to test/fixtures/tui/*.ansi, so a
// change to the mark, the rail or a colour shows up as a diff here instead of as
// a surprise in someone's terminal. The last two tests go the other way: they
// run the real CLI on a real terminal, because a frame only repaints when
// stdout is a TTY and nothing below a pty can prove that.
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { renderAll } from "./helpers/tui-scenarios.mjs";
import { capturePty, ptyAvailable, stripControl } from "./helpers/pty-capture.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const goldenDir = path.join(here, "fixtures", "tui");
const cli = path.join(here, "..", "packages", "cli", "scripts", "skills.mjs");

test("every terminal surface matches its golden", async () => {
  const fixtures = await renderAll();
  const missing = [];
  const differing = [];
  for (const [name, text] of fixtures) {
    let golden;
    try {
      golden = await readFile(path.join(goldenDir, `${name}.ansi`), "utf8");
    } catch {
      missing.push(name);
      continue;
    }
    if (golden !== text) differing.push(name);
  }
  const stale = (await readdir(goldenDir)).filter((name) => name.endsWith(".ansi") && !fixtures.has(name.replace(/\.ansi$/, "")));
  assert.deepEqual({ missing, differing, stale }, { missing: [], differing: [], stale: [] },
    `goldens moved — review the diff, then: node scripts/tui-visual.mjs --update`);
  assert.ok(fixtures.size >= 18, `expected the full set of surfaces, rendered ${fixtures.size}`);
});

test("the marks carry the brand, and green is never a brand colour", async () => {
  const fixtures = await renderAll(["sessions-menu", "wizard-select-enabled-agents", "status-page"]);
  const menu = fixtures.get("sessions-menu");
  // ▸ and ◉ are the brand; the unselected ○ is dim; the rail is dim; the
  // heading is the terminal's own text colour.
  assert.match(menu, /\{brandStrong\}▸\{\/\} \{brand\}◉\{\/\}/, "the cursor and the selected mark are the brand");
  assert.match(menu, /\{muted\}○\{\/\}/, "unselected rows are dim");
  assert.match(menu, /\{muted\}│\{\/\}/, "the rail is dim");
  assert.match(menu, /\{brand\}◆\{\/\}  \{strong\}Sessions \(shared\)\{\/\}/, "the heading marker is the brand");

  // Green survives only as a success/current mark, never on a selection or a
  // heading: strip the success lines and no green may remain anywhere.
  const withoutSuccess = [...fixtures.values()].join("\n").split("\n")
    .filter((line) => !/Installed|Done|current|ok\b/.test(line)).join("\n");
  assert.doesNotMatch(withoutSuccess, /\{success\}/, "green must not stand in for the brand");
});

test("a command that does not draw chrome does not print the logo", async () => {
  const fixtures = await renderAll(["logo-", "compact-"]);
  const logo = fixtures.get("logo-truecolor");
  const rows = logo.split("\n").filter((line) => line.length > 0);
  assert.equal(rows.length, 12, "the full logo is twelve rows");
  assert.match(fixtures.get("logo-nocolor"), /^[^\x1b]*█/m, "NO_COLOR keeps the artwork, drops the paint");
  assert.equal(fixtures.get("logo-narrow"), "{brandStrong}AVENIC{/}\n", "a narrow terminal gets the wordmark only");
  assert.match(fixtures.get("compact-status"), /^\{brandStrong\}AVENIC\{\/\}\{muted\} · \{\/\}\{strong\}Status\{\/\}/, "the compact brand is one line");
});

test("the CLI paints a real screen on a real terminal", { skip: ptyAvailable() ? false : "no pseudoconsole on this platform" }, async () => {
  // The terminal is named by the test, not inherited: whether this machine has
  // NO_COLOR set, or a TERM this process happened to be started with, decides
  // what the child paints. A colour assertion has to be about the product, so
  // it asks for a TrueColor terminal explicitly — the depths below it are
  // covered by the fixtures, which pin each one.
  const terminal = { cwd: path.join(here, ".."), columns: 100, rows: 40, timeoutMs: 60_000, environment: { COLORTERM: "truecolor", TERM: "xterm-256color", NO_COLOR: "" } };
  const version = capturePty(process.execPath, [cli, "--version"], terminal);
  assert.equal(version.status, "ok", version.detail ?? version.output);
  assert.match(stripControl(version.output), /Avenic \d+\.\d+\.\d+/);

  const status = capturePty(process.execPath, [cli, "status"], terminal);
  assert.equal(status.status, "ok", status.detail ?? status.output);
  const screen = stripControl(status.output);
  assert.match(screen, /AVENIC · Status/, "the status page leads with the compact brand");
  assert.match(screen, /│ {2}/, "the rail is drawn");
  // A TrueColor terminal gets the TrueColor brand — the same three colours the
  // palette module declares, not a 16-colour approximation of them.
  const branded = /\x1b\[(?:1;)?38;2;255;(?:122;24|77;46|158;94)m/.test(status.output);
  assert.ok(branded, `the brand colour reaches a real terminal (got: ${JSON.stringify(status.output.slice(0, 120))})`);

  // And a terminal that asks for no colour at all gets none of it, while the
  // screen it draws is still the same screen. It is read as content rather than
  // compared byte for byte: a console that repaints over its own frame writes
  // unchanged runs of spaces as cursor moves, so two captures of the same
  // screen differ in what the terminal did, not in what is on it. The fixtures
  // are where the layout is pinned character by character.
  const plain = capturePty(process.execPath, [cli, "status"], { ...terminal, environment: { ...terminal.environment, NO_COLOR: "1" } });
  assert.equal(plain.status, "ok", plain.detail ?? plain.output);
  assert.doesNotMatch(plain.output, /\x1b\[[0-9;]*3[0-9]m/, "NO_COLOR reaches a real terminal too");
  const plainScreen = stripControl(plain.output);
  for (const row of ["AVENIC · Status", "◇  Project", "│  Agents", "│  Claude Code"]) {
    assert.ok(plainScreen.includes(row), `NO_COLOR keeps the layout: ${row}\n${plainScreen.slice(0, 400)}`);
  }
});
