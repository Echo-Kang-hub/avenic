import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendCanonicalEvents,
  createCanonicalSession,
  getActiveCanonicalSessionId,
  loadRuntime,
  projectConfig,
  setActiveCanonicalSession,
  setHistoryMode,
} from "../packages/core/src/index.mjs";
import { runCli } from "../packages/cli/src/cli/dispatcher.mjs";
import { FakeTTY, fakeStdout, keys, visible } from "./helpers/fake-tty.mjs";
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
  const text = visible(stdout.text()); // 位置由字形决定，颜色与它无关
  return [...text.slice(text.lastIndexOf(title)).matchAll(/│ {2}▸ ◉ {2}([^\n]+)/g)].map((row) => row[1]);
}

async function withSessionsProject(run) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "avenic-sessions-menu-"));
  const logged = [];
  const realLog = console.log;
  try {
    await mkdir(path.join(projectRoot, ".agents"), { recursive: true });
    await setHistoryMode(projectRoot, "shared");
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
      async historyMode() {
        return projectConfig(await loadRuntime(projectRoot)).historyMode;
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
    await waitFor(() => /◆ {2}Sessions \(shared\)/.test(visible(stdout.text())), "the sessions menu");
    for (const label of ["Continue shared session", "List sessions", "Import histories", "Set active session", "Status"]) {
      assert.ok(stdout.text().includes(label), `shared menu is missing "${label}"`);
    }
    assert.ok(!stdout.text().includes("Switch to Shared"), "a shared project is not offered the isolated→shared switch");
    // 离开一层菜单是 Esc，不是一行选项：行里出现 Back 就等于给同一个动作两个名字，
    // 而这一行还做不到它承诺的事 —— `avenic sessions` 之上没有可以回去的菜单。
    assert.doesNotMatch(stdout.text(), /○\s+(Back|cancel|Cancel)\b/);
    keys(stdin, "\x1b");
    assert.equal(await promise, 0);
    assert.equal(await getActiveCanonicalSessionId(projectRoot), "alpha", "cancelling changes nothing");
  });
});

test("the Sessions menu sets the active shared session to the one the user picked", async () => {
  await withSessionsProject(async ({ projectRoot, logged, menu }) => {
    const { stdin, stdout, promise } = menu();
    await waitFor(() => /◆ {2}Sessions \(shared\)/.test(visible(stdout.text())), "the sessions menu");
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

test("the Sessions menu reads one shared conversation as a timeline", async () => {
  await withSessionsProject(async ({ projectRoot, menu }) => {
    // A conversation that really moved between agents: the user asked, Claude
    // answered, then Codex did.
    await appendCanonicalEvents(projectRoot, "beta", [
      { id: "claude:n1:u1", role: "user", createdAt: "2026-09-19T01:00:00.000Z", content: [{ type: "text", text: "what does the parser do?" }] },
      { id: "claude:n1:a1", role: "assistant", createdAt: "2026-09-19T01:00:01.000Z", content: [{ type: "text", text: "It walks the token stream." }] },
      { id: "codex:n2:a2", role: "assistant", createdAt: "2026-09-19T01:00:02.000Z", content: [{ type: "text", text: "And now it caches it." }] },
    ]);
    const { stdin, stdout, promise } = menu();
    await waitFor(() => /◆ {2}Sessions \(shared\)/.test(visible(stdout.text())), "the sessions menu");
    keys(stdin, "\x1b[B", "\r"); // Continue shared session → List sessions
    await waitFor(() => /◆ {2}Sessions/.test(visible(stdout.text())) && stdout.text().includes("beta"), "the session list");
    keys(stdin, "\r"); // the newest session is first
    await waitFor(() => stdout.text().includes("View history"), "the session actions");
    keys(stdin, "\r");
    await waitFor(() => visible(stdout.text()).includes("◆  Session beta"), "the transcript heading");
    const text = stdout.text();
    // The timeline, with each answer attributed to the agent that gave it.
    for (const speaker of ["You", "Claude", "Codex"]) {
      assert.ok(text.includes(speaker), `the transcript must name ${speaker}`);
    }
    assert.ok(text.includes("what does the parser do?"), "the user's own words are in the transcript");
    assert.ok(text.includes("And now it caches it."), "the other agent's answer is in the transcript");
    // Reading is not a dead end: the same choices come back.
    await waitFor(() => text.split("View history").length > 2, "the session actions return");
    keys(stdin, "\x1b", "\x1b");
    assert.equal(await promise, 0);
  });
});

test("the Sessions menu offers the isolated→shared switch and Esc leaves mode alone", async () => {
  await withSessionsProject(async ({ projectRoot, menu, historyMode }) => {
    await setHistoryMode(projectRoot, "isolated");
    const { stdin, stdout, promise } = menu();
    await waitFor(() => /◆ {2}Sessions \(isolated\)/.test(visible(stdout.text())), "the sessions menu");
    assert.ok(stdout.text().includes("Switch to Shared"));
    assert.ok(!stdout.text().includes("Continue shared session"), "an isolated project has no shared session to continue");
    assert.ok(!stdout.text().includes("Set active session"), "an isolated project has no active shared session");
    keys(stdin, "\x1b");
    assert.equal(await promise, 0);
    assert.equal(await historyMode(), "isolated");
  });
});
