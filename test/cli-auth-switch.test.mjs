// `avenic <agent> auth` replaces an answer, and the answer it replaces may have
// left a file behind. These tests drive the command on a fake terminal: the
// keep/remove question is asked before anything is written, the destructive
// question names the file it would delete, `esc` at either question leaves the
// project exactly as it was, a file the user has written into is never deleted,
// and a previous Account — the agent's own sign-in — is never asked about as if
// it were Avenic's to delete. Every fixture here is invented: no real
// credential, home or session record is read or written.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { effectiveAgentConfig, loadRuntime, readModelConfiguration } from "../packages/core/src/index.mjs";
import { runCli } from "../packages/cli/src/cli/dispatcher.mjs";
import { FakeTTY, fakeStdout, keys, visible } from "./helpers/fake-tty.mjs";
import { keepingHostProject } from "./helpers/host-project.mjs";
import { claudeConfiguration } from "./helpers/api-fixture.mjs";

const TOKEN = "fixture-token-not-a-real-secret";
const userFilled = claudeConfiguration({
  baseUrl: "https://provider.fixture.invalid/v1",
  model: "fixture-model",
  credential: TOKEN,
});
const projectFile = path.join(".claude", "settings.local.json");
const SWITCH_QUESTION = "What should Avenic do?";
const DESTRUCTIVE_QUESTION = "Remove old configuration?";

async function waitFor(condition, description, timeout = 8000) {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeout) throw new Error(`timeout waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * A project configured with one method, and an output sink the tests read
 * instead of the terminal running them. The host's own home is never the
 * subject: `HOME`/`USERPROFILE` point at an empty temp home and the project is
 * a temp directory, so a sign-in look-up reads fixtures and nothing else.
 *
 * An API answer leaves the file Avenic prepared — empty, and Avenic's. `fill`
 * is what the user does to it afterwards, in their own editor or with their own
 * tool, and it is the only thing that makes the file theirs.
 */
async function withConfiguredProject(options, run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-auth-switch-"));
  const projectRoot = path.join(root, "project");
  const home = path.join(root, "home");
  const logged = [];
  const realLog = console.log;
  const patched = ["HOME", "USERPROFILE", "AVENIC_STATE_DIR"];
  const saved = Object.fromEntries(patched.map((name) => [name, process.env[name]]));
  try {
    await mkdir(projectRoot, { recursive: true });
    await mkdir(path.join(home, ".claude"), { recursive: true });
    await mkdir(path.join(home, ".codex"), { recursive: true });
    Object.assign(process.env, { HOME: home, USERPROFILE: home, AVENIC_STATE_DIR: path.join(root, "state") });
    console.log = (...parts) => logged.push(parts.join(" "));
    await keepingHostProject(async () => {
      const method = options.method ?? "api";
      const setup = await runCli({
        argumentsList: ["claude", "init", "--auth", method, "--scope", "project", "--sessions", "project"],
        projectRootOverride: projectRoot,
        prompts: {},
      });
      assert.equal(setup, 0, "the fixture project initializes");
      if (options.fill) await writeFile(path.join(projectRoot, projectFile), options.fill, "utf8");
      // A project Account is a sign-in the agent performed; the fixture writes
      // one file where such a home would hold one, and nothing reads its format.
      const accountHome = path.join(projectRoot, ".agents", "local", "claude");
      await mkdir(accountHome, { recursive: true });
      await writeFile(path.join(accountHome, ".credentials.json"), "{\"fixture\":true}\n", "utf8");
      logged.length = 0; // the run under test starts from an empty sink
      await run({ projectRoot, logged, home });
    });
  } finally {
    console.log = realLog;
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
}

function terminal(projectRoot, argumentsList) {
  const stdin = new FakeTTY();
  const stdout = fakeStdout();
  const promise = runCli({ argumentsList, prompts: { stdin, stdout }, projectRootOverride: projectRoot });
  return { stdin, stdout, promise, frame: () => visible(stdout.text()) };
}

// The answer in force is the *effective* one: the method a user chose lives in
// the per-developer layer, and reading the committed file would report the
// project's own answer while the command changed this one's.
async function currentAnswer(projectRoot) {
  return effectiveAgentConfig(await loadRuntime(projectRoot), "claude");
}

test("esc at the destructive question cancels the switch, and nothing is written", async () => {
  await withConfiguredProject({}, async ({ projectRoot, logged }) => {
    const before = readFileSync(path.join(projectRoot, projectFile), "utf8");
    const run = terminal(projectRoot, ["claude", "auth", "account"]);
    await waitFor(() => run.frame().includes(SWITCH_QUESTION), "the keep/remove question");
    keys(run.stdin, "\x1b[B", "\r"); // down → Remove; enter
    await waitFor(() => run.frame().includes(DESTRUCTIVE_QUESTION), "the destructive question");
    // The question names the file it is about — not "the previous
    // configuration", which the user cannot check.
    assert.match(run.frame(), /Claude Code · \.claude\/settings\.local\.json/);
    keys(run.stdin, "\x1b"); // esc
    assert.equal(await run.promise, 0);
    assert.match(run.frame(), /✖ {2}cancel/);
    // Nothing was written and nothing was released: the answer and the file
    // are where they were, and the file is still provably Avenic's.
    assert.equal((await currentAnswer(projectRoot)).authMethod, "api");
    assert.equal(readFileSync(path.join(projectRoot, projectFile), "utf8"), before, "byte-for-byte");
    assert.equal((await readModelConfiguration(projectRoot, "claude", "project")).owned, true, "a later removal can still prove what is Avenic's");
    assert.deepEqual(logged, [], "a cancelled switch prints no result at all");
  });
});

test("Remove answered and confirmed deletes the file the question named — after the write", async () => {
  await withConfiguredProject({}, async ({ projectRoot, logged }) => {
    const run = terminal(projectRoot, ["claude", "auth", "account"]);
    await waitFor(() => run.frame().includes(SWITCH_QUESTION), "the keep/remove question");
    keys(run.stdin, "\x1b[B", "\r"); // down → Remove; enter
    await waitFor(() => run.frame().includes(DESTRUCTIVE_QUESTION), "the destructive question");
    keys(run.stdin, "y"); // Yes — the cursor starts on No
    assert.equal(await run.promise, 0);
    const answer = await currentAnswer(projectRoot);
    assert.equal(answer.authMethod, "account");
    assert.equal(answer.accountScope, "global", "the scope this command writes when none is given");
    assert.equal(existsSync(path.join(projectRoot, projectFile)), false, "the file Avenic created is given back");
    assert.equal((await readModelConfiguration(projectRoot, "claude", "project")).owned, false, "and the record of it is gone with it");
    const text = logged.join("\n");
    assert.match(text, /Removed \.claude\/settings\.local\.json — Avenic created it and nothing had changed it since\./);
    assert.match(text, /Authentication\s+Account/, "the page reports the answer that is now in force");
  });
});

// No 是不删，而它回答的是一个只在 Remove 之后才存在的问题：答完之后那一问
// 连同它的答案一起从步骤表里消失。落点因此不能在表里按 id 找 —— 找不到的意思
// 是「这一步和它后面的都不再是问题」，而不是「回到第一题，把整场问答重问一遍」，
// 那会让用户在最后一问上踩到一个循环。
test("No at the destructive question ends the switch instead of restarting the questions", async () => {
  await withConfiguredProject({}, async ({ projectRoot, logged }) => {
    const before = readFileSync(path.join(projectRoot, projectFile), "utf8");
    const run = terminal(projectRoot, ["claude", "auth", "account"]);
    await waitFor(() => run.frame().includes(SWITCH_QUESTION), "the keep/remove question");
    keys(run.stdin, "\x1b[B", "\r"); // down → Remove; enter
    await waitFor(() => run.frame().includes(DESTRUCTIVE_QUESTION), "the destructive question");
    keys(run.stdin, "\r"); // the cursor starts on No
    const finished = await Promise.race([
      run.promise,
      new Promise((resolve) => setTimeout(() => resolve("still asking"), 3000)),
    ]);
    assert.equal(finished, 0, `答 No 之后这个命令应当直接收尾，而不是回头再问一遍：\n${run.frame().slice(-400)}`);
    assert.equal((await currentAnswer(projectRoot)).authMethod, "account");
    assert.equal(readFileSync(path.join(projectRoot, projectFile), "utf8"), before, "the file stays exactly as it was");
    assert.doesNotMatch(logged.join("\n"), /Removed \.claude/, "nothing was removed, so nothing is reported as removed");
  });
});

test("a file the user filled in is preserved when Remove is answered, and named as theirs", async () => {
  // The whole point of the ledger: Avenic created this file, and the user then
  // put their own provider and token in it. Remove is an answer about Avenic's
  // file, and this one is no longer Avenic's — so it stays, and the run says so
  // rather than leaving the user to find out by looking.
  await withConfiguredProject({ fill: userFilled }, async ({ projectRoot, logged }) => {
    const run = terminal(projectRoot, ["claude", "auth", "account"]);
    await waitFor(() => run.frame().includes(SWITCH_QUESTION), "the keep/remove question");
    keys(run.stdin, "\x1b[B", "\r"); // down → Remove; enter
    // No destructible file means no destructive question: the answer stands on
    // the one frame the user already answered.
    assert.equal(await run.promise, 0);
    assert.doesNotMatch(run.frame(), /Remove old configuration\?/);
    assert.equal(readFileSync(path.join(projectRoot, projectFile), "utf8"), userFilled, "a value Avenic did not write is not Avenic's to delete");
    assert.match(logged.join("\n"), /Configuration in \.claude\/settings\.local\.json was modified outside Avenic and will be preserved\./);
  });
});

test("a previous Account is asked about without a destructive question, and its home is kept", async () => {
  await withConfiguredProject({ method: "account" }, async ({ projectRoot, logged }) => {
    const signIn = path.join(projectRoot, ".agents", "local", "claude", ".credentials.json");
    const run = terminal(projectRoot, ["claude", "auth", "api", "--scope", "project"]);
    await waitFor(() => run.frame().includes(SWITCH_QUESTION), "the keep/remove question");
    keys(run.stdin, "\x1b[B", "\r"); // down → Remove; enter
    // Remove is the answer, and the command runs to the end without a second
    // question: there is no file of Avenic's to name, and a confirmation for a
    // deletion that is never going to happen teaches users to click through it.
    assert.equal(await run.promise, 0);
    assert.doesNotMatch(run.frame(), /Remove old configuration\?/);
    assert.equal((await currentAnswer(projectRoot)).authMethod, "api");
    assert.equal(existsSync(signIn), true, "登录是 agent 自己的，Avenic 不代删");
    assert.doesNotMatch(logged.join("\n"), /Removed |was modified outside Avenic/, "nothing of the account's was touched, so nothing is reported as touched");
    // The new answer is a file of Avenic's now: the one it prepared for API.
    assert.equal(existsSync(path.join(projectRoot, projectFile)), true);
  });
});

test("the same method at a new scope is a switch too: the answer being moved is asked about", async () => {
  await withConfiguredProject({}, async ({ projectRoot }) => {
    const before = readFileSync(path.join(projectRoot, projectFile), "utf8");
    // No --scope, so the answer becomes Global and the Project file it came from
    // is left standing: exactly the switch the question exists for.
    const run = terminal(projectRoot, ["claude", "auth", "api"]);
    await waitFor(() => run.frame().includes(SWITCH_QUESTION), "the keep/remove question");
    keys(run.stdin, "\r"); // Keep — the offered default
    assert.equal(await run.promise, 0);
    const answer = await currentAnswer(projectRoot);
    assert.equal(answer.authMethod, "api");
    assert.equal(answer.configScope, "global");
    assert.equal(readFileSync(path.join(projectRoot, projectFile), "utf8"), before, "Keep leaves the file the answer moved away from");
  });
});

test("without a terminal the switch keeps the previous configuration and says nothing about it", async () => {
  await withConfiguredProject({}, async ({ projectRoot, logged }) => {
    const before = readFileSync(path.join(projectRoot, projectFile), "utf8");
    // No prompts at all: this is the piped, scripted run, where the offered
    // default is the only answer that may be assumed.
    const code = await runCli({ argumentsList: ["claude", "auth", "account"], projectRootOverride: projectRoot });
    assert.equal(code, 0);
    assert.equal((await currentAnswer(projectRoot)).authMethod, "account");
    assert.equal(readFileSync(path.join(projectRoot, projectFile), "utf8"), before, "the previous configuration stays exactly where it was");
    assert.doesNotMatch(logged.join("\n"), /What should Avenic do\?|Removed \.claude/);
  });
});
