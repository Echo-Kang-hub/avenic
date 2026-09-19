// Regenerate packages/cli/src/cli/brand-logo.mjs from the golden fixture.
//
// The fixture (test/fixtures/brand/avenic-logo.ansi) is captured from the
// design source (scripts/brand/avenic-logo.sh) and is the ground truth for the
// logo's bytes. The logo is a fixed brand asset: never hand-edit the generated
// module, never approximate the art — change the design source, recapture the
// fixture, and run this script.
//
//   bash scripts/brand/avenic-logo.sh > test/fixtures/brand/avenic-logo.ansi
//   node scripts/brand/gen-logo.mjs
import { readFileSync, writeFileSync } from "node:fs";

const FIXTURE = "test/fixtures/brand/avenic-logo.ansi";
const TARGET = "packages/cli/src/cli/brand-logo.mjs";
const LINES = 12;

const bytes = readFileSync(FIXTURE, "utf8").replace(/\n$/, "");
const lines = bytes.split("\n");
if (lines.length !== LINES) {
  throw new Error(`expected ${LINES} logo lines, found ${lines.length} — recapture the fixture first`);
}

const header = `// AVENIC brand logo — generated static constants. Do not hand-edit.
//
// The art, its characters, spacing, line count and colours are a fixed brand
// asset defined by scripts/brand/avenic-logo.sh. This module is regenerated
// from the golden fixture with \`node scripts/brand/gen-logo.mjs\`, and
// rendering writes these strings unchanged: no figlet, no per-character
// colour maths, no subprocess, no filesystem read. \`test/brand-logo.test.mjs\`
// proves the bytes match the fixture, and the fixture matches the design
// source. The module is imported lazily (only when the full logo is drawn) so
// a plain agent launch never pays for it.

/** The ${LINES} lines of the AVENIC wordmark, ANSI payload included. */
export const LOGO_LINES = Object.freeze([`;
const body = lines.map((line) => `  ${JSON.stringify(line)},`).join("\n");
const footer = `]);
`;
writeFileSync(TARGET, `${header}\n${body}\n${footer}`, "utf8");
console.log(`wrote ${TARGET}: ${lines.length} lines, ${Buffer.byteLength(bytes)} bytes of art`);
