import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createCanonicalSession,
  getActiveCanonicalSessionId,
  loadRuntime,
  projectConfig,
  setActiveCanonicalSession,
  setSessionInteropMode,
} from "../packages/core/src/index.mjs";
import { runCli } from "../packages/cli/src/cli/dispatcher.mjs";
import { FakeTTY, fakeStdout, keys } from "./helpers/fake-tty.mjs";
import { keepingHostProject } from "./helpers/host-project.mjs";

// `avenic sessions` with no arguments is the only place a user meets Shared
// and Isolated mode, and the only way to change the active shared session
// without continuing one. It is drawn by the same prompt code the rest of the
// CLI uses, so it is driven here through the same fake TTY.

async function waitFor(condition, description, timeout = 8000) {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeout) {
      throw new Error(`timeout waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Every row the second prompt has painted: a frame's option lines. */
function paintedRows(stdout, title) {
  const text = stdout.text().replace(/\x1b\[[0-9;]*m/g, ""); // 位置由字形决定，颜色与它无关
  return [...text.slice(text.lastIndexOf(title)).matchAll(/│ {2}▸ ◉ {2}([^\n]+)/g)].map((row) => row[1]);
}

async function withSessionsProject(run) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "avenic-sessions-menu-"));
  const logged = [];
  const realLog = console.log;
  try {
    await mkdir(path.join(projectRoot, ".agents"), { recursive: true });
    await setSessionInteropMode(projectRoot, "shared");
    await createCanonicalSession(projectRoot, { id: "alpha", title: "alpha" });
    await setActiveCanonicalSession(projectRoot, "alpha");
    // The menu lists the most recently updated session first; beta is created
    // after alpha so the first row is the one that is *not* active.
    await new Promise((resolve) => setTimeout(resolve, 20));
    await createCanonicalSession(projectRoot, { id: "beta", title: "beta" });
    console.log = (...parts) => logged.push(parts.join(" "));
    await keepingHostProject(() => run({
      projectRoot,
      logged,
      /** Open the interactive menu the way a terminal would. */
      menu() {
        const stdin = new FakeTTY();
        const stdout = fakeStdout();
        return { stdin, stdout, promise: runCli({ argumentsList: ["sessions"], prompts: { stdin, stdout }, projectRootOverride: projectRoot }) };
      },
      async interop() {
        return projectConfig(await loadRuntime(projectRoot)).sessionInterop;
      },
    }));
  } finally {
    console.log = realLog;
    await rm(projectRoot, { recursive: true, force: true });
  }
}

test("the Sessions menu shows shared history and Esc leaves the project unchanged", async () => {
  await withSessionsProject(async ({ projectRoot, menu }) => {
    const { stdin, stdout, promise } = menu();
    await waitFor(() => /◆ {2}Sessions \(shared\)/.test(stdout.text()), "the sessions menu");
    for (const label of ["Continue shared session", "List sessions", "Import histories", "Set active session", "Status", "Back"]) {
      assert.ok(stdout.text().includes(label), `shared menu is missing "${label}"`);
    }
    assert.ok(!stdout.text().includes("Switch to Shared"), "a shared project is not offered the isolated→shared switch");
    keys(stdin, "\x1b");
    assert.equal(await promise, 0);
    assert.equal(await getActiveCanonicalSessionId(projectRoot), "alpha", "cancelling changes nothing");
  });
});

test("the Sessions menu sets the active shared session to the one the user picked", async () => {
  await withSessionsProject(async ({ projectRoot, logged, menu }) => {
    const { stdin, stdout, promise } = menu();
    await waitFor(() => /◆ {2}Sessions \(shared\)/.test(stdout.text()), "the sessions menu");
    keys(stdin, "\x1b[B", "\x1b[B", "\x1b[B", "\r"); // continue → list → import → set active
    await waitFor(() => paintedRows(stdout, "◆  Set active session").length > 0, "the session list");
    const picked = paintedRows(stdout, "◆  Set active session").at(-1);
    assert.notEqual(picked, "alpha", "the newest session is listed first, so the cursor starts on a different session");
    keys(stdin, "\r");
    assert.equal(await promise, 0);
    assert.equal(await getActiveCanonicalSessionId(projectRoot), picked);
    assert.ok(logged.includes(`Active shared session: ${picked}`), `user was not told what changed: ${JSON.stringify(logged)}`);
  });
});

test("the Sessions menu offers the isolated→shared switch and Back leaves mode alone", async () => {
  await withSessionsProject(async ({ projectRoot, menu, interop }) => {
    await setSessionInteropMode(projectRoot, "isolated");
    const { stdin, stdout, promise } = menu();
    await waitFor(() => /◆ {2}Sessions \(isolated\)/.test(stdout.text()), "the sessions menu");
    assert.ok(stdout.text().includes("Switch to Shared"));
    assert.ok(!stdout.text().includes("Continue shared session"), "an isolated project has no shared session to continue");
    assert.ok(!stdout.text().includes("Set active session"), "an isolated project has no active shared session");
    keys(stdin, "\x1b[B", "\x1b[B", "\x1b[B", "\x1b[B", "\r"); // → Back
    assert.equal(await promise, 0);
    assert.equal(await interop(), "isolated");
  });
});
