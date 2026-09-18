// Interactive tests write a real project configuration, so they run against a
// temp project. This wrapper fails the test if the project the suite was
// launched from changed underneath it — the accident that turns "drive the
// TUI" into "reconfigure the developer's own repository".
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

export async function keepingHostProject(run) {
  const hostConfig = path.join(process.cwd(), ".agents", "runtime.json");
  const snapshot = () => readFile(hostConfig, "utf8").catch(() => null);
  const before = await snapshot();
  const result = await run();
  assert.equal(await snapshot(), before, `the test reconfigured ${hostConfig}, the project it runs from`);
  return result;
}
