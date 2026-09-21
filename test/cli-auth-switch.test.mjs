// `avenic <agent> auth` replaces an answer, and the answer it replaces may have
// left a file behind. These tests drive the command on a fake terminal: the
// keep/remove question is asked before anything is written, the destructive
// question names the file it would delete, `esc` at either question leaves the
// project exactly as it was, and a previous Account — the agent's own sign-in —
// is never asked about as if it were Avenic's to delete. Every fixture here is
// invented: no real credential, home or session record is read or written.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { effectiveAgentConfig, loadRuntime, readApiConfiguration, writeApiConfiguration } from "../packages/core/src/index.mjs";
import { runCli } from "../packages/cli/src/cli/dispatcher.mjs";
import { FakeTTY, fakeStdout, keys, visible } from "./helpers/fake-tty.mjs";
import { keepingHostProject } from "./helpers/host-project.mjs";

const TOKEN = "fixture-token-not-a-real-secret";
const fields = {
  provider: "Fixture Provider",
  baseUrl: "https://provider.fixture.invalid/v1",
  model: "fixture-model",
  credential: TOKEN,
};
const projectFile = path.join(".claude", "settings.local.json");

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
      if (method === "api") {
        if (options.beforeWrite) await options.beforeWrite({ projectRoot, home });
        await writeApiConfiguration(projectRoot, "claude", "project", fields);
      }
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
    await waitFor(() => run.frame().includes("Existing Account/API configuration detected"), "the keep/remove question");
    keys(run.stdin, "\x1b[B", "\r"); // down → Remove; enter
    await waitFor(() => run.frame().includes("Delete the previous API configuration"), "the destructive question");
    // The question names the file it is about, through the same formatter an
    // editor modal uses — not "the previous configuration", which the user
    // cannot check.
    assert.match(run.frame(), /Claude Code · \.claude\/settings\.local\.json/);
    keys(run.stdin, "\x1b"); // esc
    assert.equal(await run.promise, 0);
    assert.match(run.frame(), /✖ {2}cancel/);
    // Nothing was written and nothing was released: the answer, the file and
    // Avenic's record of what it wrote in it are all where they were.
    assert.equal((await currentAnswer(projectRoot)).authMethod, "api");
    assert.equal(readFileSync(path.join(projectRoot, projectFile), "utf8"), before, "byte-for-byte");
    assert.equal((await readApiConfiguration(projectRoot, "claude", "project")).owned, true, "a later removal can still prove what is Avenic's");
    assert.deepEqual(logged, [], "a cancelled switch prints no result at all");
  });
});

test("Remove answered and confirmed deletes the file the question named — after the write", async () => {
  await withConfiguredProject({}, async ({ projectRoot, logged }) => {
    const run = terminal(projectRoot, ["claude", "auth", "account"]);
    await waitFor(() => run.frame().includes("Existing Account/API configuration detected"), "the keep/remove question");
    keys(run.stdin, "\x1b[B", "\r"); // down → Remove; enter
    await waitFor(() => run.frame().includes("Delete the previous API configuration"), "the destructive question");
    keys(run.stdin, "y"); // Yes — the cursor starts on No
    assert.equal(await run.promise, 0);
    const answer = await currentAnswer(projectRoot);
    assert.equal(answer.authMethod, "account");
    assert.equal(answer.accountScope, "global", "the scope this command writes when none is given");
    assert.equal(existsSync(path.join(projectRoot, projectFile)), false, "a file Avenic created and emptied is removed");
    assert.equal((await readApiConfiguration(projectRoot, "claude", "project")).owned, false, "and the record of its keys is gone with it");
    const text = logged.join("\n");
    assert.match(text, /Removed \d+ key\(s\) Avenic wrote in \.claude\/settings\.local\.json/);
    assert.match(text, /Authentication\s+Account/, "the page reports the answer that is now in force");
  });
});

test("a key whose earlier value Avenic never stored is reported as kept, not silently dropped", async () => {
  // The user's own token, written by them before Avenic ever touched this file.
  // The ledger keeps a hash of such a value, never the value itself, so a later
  // removal has nothing to give back — the one release outcome that asks the
  // user to act. Saying nothing leaves them with a silently destroyed token and
  // no way to know it was ever there.
  await withConfiguredProject({
    beforeWrite: async ({ projectRoot }) => {
      await mkdir(path.dirname(path.join(projectRoot, projectFile)), { recursive: true });
      await writeFile(path.join(projectRoot, projectFile), `${JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: TOKEN } }, null, 2)}\n`, "utf8");
    },
  }, async ({ projectRoot, logged }) => {
    const run = terminal(projectRoot, ["claude", "auth", "account"]);
    await waitFor(() => run.frame().includes("Existing Account/API configuration detected"), "the keep/remove question");
    keys(run.stdin, "\x1b[B", "\r"); // down → Remove; enter
    await waitFor(() => run.frame().includes("Delete the previous API configuration"), "the destructive question");
    keys(run.stdin, "y"); // Yes — the cursor starts on No
    assert.equal(await run.promise, 0);
    assert.match(logged.join("\n"), /Kept 1 key\(s\) whose earlier value Avenic never stored/);
  });
});

test("a previous Account is asked about without a destructive question, and its home is kept", async () => {
  await withConfiguredProject({ method: "account" }, async ({ projectRoot, logged }) => {
    const signIn = path.join(projectRoot, ".agents", "local", "claude", ".credentials.json");
    const run = terminal(projectRoot, ["claude", "auth", "api", "--scope", "project"]);
    await waitFor(() => run.frame().includes("Existing Account/API configuration detected"), "the keep/remove question");
    keys(run.stdin, "\x1b[B", "\r"); // down → Remove; enter
    // Remove is the answer, and the command runs to the end without a second
    // question: there is no file of Avenic's to name, and a confirmation for a
    // deletion that is never going to happen teaches users to click through it.
    assert.equal(await run.promise, 0);
    assert.doesNotMatch(run.frame(), /Delete the previous/);
    assert.equal((await currentAnswer(projectRoot)).authMethod, "api");
    assert.equal(existsSync(signIn), true, "登录是 agent 自己的，Avenic 不代删");
    assert.match(logged.join("\n"), /Kept \.agents\/local\/claude\/ — the sign-in inside is Claude Code's own, not Avenic's to delete/);
  });
});

test("the same method at a new scope is a switch too: the answer being moved is asked about", async () => {
  await withConfiguredProject({}, async ({ projectRoot }) => {
    const before = readFileSync(path.join(projectRoot, projectFile), "utf8");
    // No --scope, so the answer becomes Global and the Project file it came from
    // is left standing: exactly the switch the question exists for.
    const run = terminal(projectRoot, ["claude", "auth", "api"]);
    await waitFor(() => run.frame().includes("Existing Account/API configuration detected"), "the keep/remove question");
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
    assert.doesNotMatch(logged.join("\n"), /Existing Account\/API configuration detected|Removed \d+ key/);
  });
});
