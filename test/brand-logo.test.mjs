// The AVENIC logo is a fixed brand asset, not a drawing routine: the bytes the
// CLI writes must be the bytes the design source (scripts/brand/avenic-logo.sh)
// prints. This file pins that — line count, visible width, the exact ANSI
// payload per line, and the colour-off rendering — so a well-meaning redesign
// fails here instead of shipping.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturePath = path.join(here, "fixtures", "brand", "avenic-logo.ansi");
const { LOGO_LINES } = await import("../packages/cli/src/cli/brand-logo.mjs");
const { fullLogo, compactBrand, displayWidth } = await import("../packages/cli/src/cli/brand.mjs");

const ANSI = /\x1b\[[0-9;]*m/g;

async function fixtureLines() {
  const raw = await readFile(fixturePath, "utf8");
  return raw.split(/\r?\n/).filter((line) => line.length > 0);
}

function fakeStdout(options = {}) {
  const parts = [];
  return {
    isTTY: options.isTTY ?? true,
    columns: options.columns,
    write(chunk) {
      parts.push(String(chunk));
      return true;
    },
    text() {
      return parts.join("");
    },
  };
}

test("the generated constants are the design source, byte for byte", async () => {
  const lines = await fixtureLines();
  assert.equal(lines.length, 12, "设计源是十二行");
  assert.equal(LOGO_LINES.length, lines.length);
  for (const [index, line] of lines.entries()) {
    assert.equal(LOGO_LINES[index], line, `第 ${index + 1} 行与设计源不一致`);
  }
});

test("every row is the same 76 columns wide, and nothing is left un-reset", async () => {
  const lines = await fixtureLines();
  for (const [index, line] of lines.entries()) {
    assert.equal(displayWidth(line), 76, `第 ${index + 1} 行宽 ${displayWidth(line)}`);
    assert.ok(line.endsWith("\x1b[0m"), `第 ${index + 1} 行没有复位`);
  }
});

test("the colour vocabulary is the seven SGR pairs the design uses, and nothing else", async () => {
  const lines = await fixtureLines();
  const seen = new Set();
  for (const line of lines) {
    for (const match of line.matchAll(/\x1b\[([0-9;]+)m/g)) seen.add(match[1]);
    for (const stray of line.replace(ANSI, "").matchAll(/\x1b/g)) {
      assert.fail(`游离的 ESC：${JSON.stringify(stray)}`);
    }
  }
  assert.deepEqual([...seen].sort(), [
    "0", "0;31", "0;37", "0;37;41", "0;90", "0;90;47", "0;91", "0;91;41", "0;91;47",
    "0;93", "0;93;41", "0;93;47", "0;97", "0;97;41", "0;97;47",
  ].sort(), "换了颜色就是改了品牌资产");
});

test("on a terminal the logo is exactly the design bytes; with NO_COLOR only the colour goes", async () => {
  const lines = await fixtureLines();

  const coloured = fakeStdout({ columns: 100 });
  await fullLogo(coloured, { environment: { FORCE_COLOR: "1" } });
  assert.equal(coloured.text(), `${lines.join("\n")}\n\n`);

  const plain = fakeStdout({ columns: 100 });
  await fullLogo(plain, { environment: { NO_COLOR: "1" } });
  assert.doesNotMatch(plain.text(), /\x1b/);
  const stripped = lines.map((line) => line.replace(ANSI, ""));
  assert.equal(plain.text(), `${stripped.join("\n")}\n\n`);
  for (const [index, row] of plain.text().trimEnd().split("\n").entries()) {
    assert.equal(displayWidth(row), 76, `第 ${index + 1} 行去掉颜色后仍占满 76 列`);
  }
});

test("a terminal too narrow for the mark gets the one-line brand instead", async () => {
  const narrow = fakeStdout({ columns: 40 });
  await fullLogo(narrow, { environment: { NO_COLOR: "1" } });
  assert.equal(narrow.text(), "AVENIC\n");
});

test("the README shows the same mark the terminal prints", async () => {
  // The wordmark in the README is the asset, copied — not a second drawing of
  // it. A redesign that updates one and not the other is a documentation bug
  // nobody would notice by reading either alone.
  const readme = await readFile(path.join(here, "..", "packages", "cli", "README.md"), "utf8");
  const block = readme.match(/## 终端外观[\s\S]*?```\n([\s\S]*?)```/);
  assert.ok(block, "README 的终端外观一节要有品牌图形");
  const shown = block[1].replace(/\n$/, "");
  const lines = (await fixtureLines()).map((line) => line.replace(ANSI, "").replace(/[ \t]+$/, ""));
  assert.equal(shown, lines.join("\n"), "README 里的图形必须与终端一致");
});

test("the compact brand names the product and the page, and fits the terminal", () => {
  const stdout = fakeStdout({ columns: 40 });
  compactBrand(stdout, { environment: { NO_COLOR: "1" }, title: "Status", description: "/some/really/long/project/root/that/will/not/fit/in/forty/columns" });
  const rows = stdout.text().trimEnd().split("\n");
  assert.equal(rows.length, 2);
  assert.equal(rows[0], "AVENIC · Status");
  for (const row of rows) assert.ok(displayWidth(row) <= 40, row);
  assert.match(rows[1], /^│ {2}\/some\/really/);
});
