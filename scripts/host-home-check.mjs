// The machine's own agent configuration is not a test fixture. A test that
// writes a Global API answer without saying which home it means lands in the
// developer's own `~/.claude/settings.json` or `~/.codex/config.toml` — and the
// run still looks green, because nothing in it ever reads that path.
//
// This runs after the suite and fails the run if either file holds a value this
// repository invents. It names the file and the marker it found, never a value:
// a real credential may sit beside the fixture, and this check reads it only to
// look for strings it already knows.
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

// The shapes every fixture in this repository is built from, matched as tokens
// rather than as five literals a later fixture can walk past: the match ignores
// case, so `FixtureProvider`, `Fixture Provider` and `fixture-provider` are one
// marker, and `fixture-credential-not-a-real-secret` is caught by the token it
// shares with the rest. A leak that carried only its credential still fails.
const FIXTURES = [
  "fixture-model", "fixture-provider", "fixtureprovider", "fixture provider",
  "fixture-token", "fixture-credential", "fixture-value", "fixture_api_key",
  "provider.fixture.invalid",
];
const files = [
  path.join(os.homedir(), ".claude", "settings.json"),
  path.join(os.homedir(), ".codex", "config.toml"),
];

const found = [];
for (const file of files) {
  if (!existsSync(file)) continue;
  const text = readFileSync(file, "utf8");
  for (const marker of FIXTURES) {
    if (text.toLowerCase().includes(marker)) found.push(`${file} · ${marker}`);
  }
}
if (found.length > 0) {
  console.error("the suite wrote fixture data into this machine's own agent configuration:");
  for (const line of found) console.error(`  ${line}`);
  console.error("a Global answer belongs in the home the caller's environment names (see test/project-method-switch.test.mjs)");
  process.exitCode = 1;
}
