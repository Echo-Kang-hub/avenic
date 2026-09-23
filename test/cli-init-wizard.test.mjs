import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadRuntime, projectConfig } from "../packages/core/src/index.mjs";
import { runCli } from "../packages/cli/src/cli/dispatcher.mjs";
import { FakeTTY, fakeStdout, keys, visible } from "./helpers/fake-tty.mjs";
import { keepingHostProject } from "./helpers/host-project.mjs";

// `avenic init` and `avenic change` on a terminal are the wizard a user meets
// first: pick the agents, then each agent's auth and session storage, then the
// history mode, then Apply. The prompted values must be exactly what gets
// written, so the wizard is driven here key by key, in a project whose agent
// storage is an empty temp home (never the machine running the tests).
//
// The frame contract these tests hold the wizard to is the one a user reads:
// answered steps collapse to ◇ + a dim summary on one continuous rail, only the
// active step is expanded under a ◆, Shift+Tab re-opens the previous step with
// the answer it already has, and nothing at all is written until Apply.

async function waitFor(condition, description, timeout = 8000) {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeout) {
      throw new Error(`timeout waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** The frame the user is looking at: everything after the last repaint. */
function frame(stdout) {
  const parts = stdout.text().split("\x1b[u\x1b[J");
  return visible(parts[parts.length - 1]);
}

async function withWizardProject(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-init-wizard-"));
  const projectRoot = path.join(root, "project");
  const home = path.join(root, "home");
  const logged = [];
  const realLog = console.log;
  const patched = ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "AVENIC_STATE_DIR"];
  const saved = Object.fromEntries(patched.map((name) => [name, process.env[name]]));
  try {
    await mkdir(projectRoot, { recursive: true });
    await mkdir(path.join(home, ".claude"), { recursive: true });
    await mkdir(path.join(home, ".codex"), { recursive: true });
    Object.assign(process.env, {
      HOME: home,
      USERPROFILE: home,
      CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
      CODEX_HOME: path.join(home, ".codex"),
      AVENIC_STATE_DIR: path.join(root, "state"),
    });
    console.log = (...parts) => logged.push(parts.join(" "));
    await keepingHostProject(() => run({
      projectRoot,
      logged,
      /** The wizard as a terminal presents it: a TTY on both ends. */
      wizard(command) {
        const stdin = new FakeTTY();
        const stdout = fakeStdout();
        return { stdin, stdout, promise: runCli({ argumentsList: [command], prompts: { stdin, stdout }, projectRootOverride: projectRoot }) };
      },
      async config() {
        return projectConfig(await loadRuntime(projectRoot));
      },
    }));
  } finally {
    console.log = realLog;
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
}

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const BACK = "\x1b[Z";
const ENTER = "\r";

test("avenic init writes exactly what the wizard asked for", async () => {
  await withWizardProject(async ({ projectRoot, logged, wizard, config }) => {
    const { stdin, stdout, promise } = wizard("init");
    await waitFor(() => /◆ {2}Select agents/.test(frame(stdout)), "the agent picker");
    keys(stdin, " ", DOWN, " ", ENTER); // Claude Code, then Codex
    // Each agent answers its method, then that method's own scope, then session
    // storage; the two scopes belong to different questions and are asked
    // separately. Enter takes the offered answer every time: Account (its own
    // sign-in), Global account state, project sessions, shared history.
    for (const title of [
      "Claude Code authentication", "Claude Code account scope", "Claude Code sessions",
      "Codex authentication", "Codex account scope", "Codex sessions",
      "History",
    ]) {
      await waitFor(() => new RegExp(`◆ {2}${title}`).test(frame(stdout)), title);
      keys(stdin, ENTER);
    }
    await waitFor(() => /◆ {2}Apply configuration\?/.test(frame(stdout)), "the confirmation");
    keys(stdin, ENTER); // Yes is the offered answer
    assert.equal(await promise, 0);

    const written = await config();
    assert.deepEqual(Object.keys(written.agents).sort(), ["claude", "codex"]);
    assert.deepEqual(written.agents.claude, { authMethod: "account", accountScope: "global", sessionScope: "project" });
    assert.deepEqual(written.agents.codex, { authMethod: "account", accountScope: "global", sessionScope: "project" });
    assert.equal(written.historyMode, "shared");
    // Account mode configures no model and no credential: the entry says who
    // signs in and nothing about a provider.
    assert.ok(!("configScope" in written.agents.claude), "the method that was not chosen leaves no field behind");
    // The wizard is its own result page: the rail carries every answer once,
    // and the settled frame ends with the outcome instead of a second summary.
    const settled = frame(stdout);
    assert.match(settled, /◇ {2}Configuration applied/);
    assert.match(settled, /◇ {2}Select agents\n│ {2}Claude Code, Codex/);
    assert.match(settled, /◇ {2}History\n│ {2}Shared/);
    assert.match(settled, /└ {2}Avenic project initialized/);
    assert.ok(existsSync(path.join(projectRoot, ".agents", "runtime.json")), "the project config is on disk");
  });
});

test("answered steps collapse to one rail line and only the active step is expanded", async () => {
  await withWizardProject(async ({ wizard }) => {
    const { stdin, stdout, promise } = wizard("init");
    await waitFor(() => /◆ {2}Select agents/.test(frame(stdout)), "the agent picker");
    keys(stdin, " ", DOWN, " ", ENTER);

    await waitFor(() => /◆ {2}Claude Code authentication/.test(frame(stdout)), "the second step");
    const current = frame(stdout);
    // The answered step is a ◇ heading with its own compact summary — the agent
    // labels, not "2 selected", and not the long option text the frame used to
    // print a second time.
    assert.match(current, /◇ {2}Select agents\n│ {2}Claude Code, Codex/);
    // Only one step is open, and its options are on screen; the others' are not.
    assert.equal(current.match(/◆/g).length, 1, `exactly one active step:\n${current}`);
    assert.equal(current.match(/◇/g).length, 1, `only the answered step is on the rail:\n${current}`);
    assert.ok(!current.includes("History"), "a step that has not been asked yet is not on the rail");
    assert.ok(!current.includes("OpenCode"), "the previous step's option rows are gone");
    assert.ok(!current.includes("Shared — "), "an option's long description is not repeated as a summary");
    keys(stdin, "\x1b"); // leave without writing
    assert.equal(await promise, 0);
  });
});

// 折叠块只有一行摘要时，那个标签正好占满它自己那一列：值和标签粘在一起，
// 读起来就成了 "AuthenticationAPI (Project)"。值列从「这一块最长的标签 + 一个空格」
// 起算，所以无论块里有几行，值和标签之间都分得开，几行的值也都从同一列开始。
test("a collapsed block keeps its labels and values apart", async () => {
  await withWizardProject(async ({ wizard }) => {
    const { stdin, stdout, promise } = wizard("init");
    await waitFor(() => /◆ {2}Select agents/.test(frame(stdout)), "the agent picker");
    keys(stdin, " ", ENTER);
    await waitFor(() => /◆ {2}Claude Code authentication/.test(frame(stdout)), "authentication");
    keys(stdin, DOWN, ENTER); // API
    await waitFor(() => /◆ {2}Claude Code configuration scope/.test(frame(stdout)), "the configuration scope");
    // 这一刻 claude 那一块里只有认证这一行：最长标签就是它自己。
    assert.match(frame(stdout), /◇ {2}Claude Code\n│ {2}Authentication API\n/, `标签和值必须分得开：\n${frame(stdout)}`);
    keys(stdin, "\x1b"); // leave without writing
    assert.equal(await promise, 0);
  });
});

test("Shift+Tab re-opens the previous step with its previous answer, and does nothing on the first step", async () => {
  await withWizardProject(async ({ wizard }) => {
    const { stdin, stdout, promise } = wizard("init");
    await waitFor(() => /◆ {2}Select agents/.test(frame(stdout)), "the agent picker");
    keys(stdin, BACK); // first step: no previous step
    assert.match(frame(stdout), /◆ {2}Select agents/);
    assert.ok(!/◇ {2}Select agents/.test(frame(stdout)), `nothing was answered, so nothing is collapsed:\n${frame(stdout)}`);

    keys(stdin, " ", ENTER); // Claude Code
    await waitFor(() => /◆ {2}Claude Code authentication/.test(frame(stdout)), "authentication");
    keys(stdin, DOWN, ENTER); // API — the method, not a scope
    await waitFor(() => /◆ {2}Claude Code configuration scope/.test(frame(stdout)), "the configuration the method asks for");

    keys(stdin, BACK);
    await waitFor(() => /◆ {2}Claude Code authentication/.test(frame(stdout)), "the previous step re-opened");
    assert.match(frame(stdout), /▸ ◉ {2}API/, `the answer it already has is selected:\n${frame(stdout)}`);
    assert.match(frame(stdout), /↑↓ move · enter confirm · shift\+tab back · esc cancel/, "the frame says how to go back");

    keys(stdin, BACK);
    await waitFor(() => /◆ {2}Select agents/.test(frame(stdout)), "the first step again");
    assert.match(frame(stdout), /▸ ◉ {2}Claude Code/, "and it still holds its answer");
    keys(stdin, "\x1b");
    assert.equal(await promise, 0);
  });
});

test("modifying an answer and moving forward submits the new one", async () => {
  await withWizardProject(async ({ wizard, config }) => {
    const { stdin, stdout, promise } = wizard("init");
    await waitFor(() => /◆ {2}Select agents/.test(frame(stdout)), "the agent picker");
    keys(stdin, " ", DOWN, " ", ENTER); // Claude Code + Codex
    keys(stdin, ENTER); // Claude Code authentication: Account
    keys(stdin, ENTER); // Claude Code account scope: Global
    keys(stdin, ENTER); // Claude Code sessions: Project
    await waitFor(() => /◆ {2}Codex authentication/.test(frame(stdout)), "Codex authentication");
    keys(stdin, ENTER); // Account
    await waitFor(() => /◆ {2}Codex account scope/.test(frame(stdout)), "Codex account scope");
    keys(stdin, ENTER); // Global
    await waitFor(() => /◆ {2}Codex sessions/.test(frame(stdout)), "Codex sessions");

    // Back into Codex's scope and change the answer.
    keys(stdin, BACK);
    await waitFor(() => /◆ {2}Codex account scope/.test(frame(stdout)), "Codex account scope again");
    assert.match(frame(stdout), /▸ ◉ {2}Global/, `the answer it already has is selected:\n${frame(stdout)}`);
    keys(stdin, DOWN, ENTER); // Project — a project-only account
    await waitFor(() => /◆ {2}Codex sessions/.test(frame(stdout)), "forward again");
    keys(stdin, ENTER); // Codex sessions: Project
    keys(stdin, ENTER); // History: Shared
    await waitFor(() => /◆ {2}Apply configuration\?/.test(frame(stdout)), "the confirmation");
    keys(stdin, ENTER);
    assert.equal(await promise, 0);

    const written = await config();
    assert.deepEqual(written.agents.codex, { authMethod: "account", accountScope: "project", sessionScope: "project" }, "the changed answer is the one written");
    assert.deepEqual(written.agents.claude, { authMethod: "account", accountScope: "global", sessionScope: "project" }, `and the untouched answers are intact: ${JSON.stringify(written.agents)}`);
  });
});

test("a deselected agent's answers stay in memory but are not submitted, and come back with it", async () => {
  await withWizardProject(async ({ wizard, config }) => {
    const { stdin, stdout, promise } = wizard("init");
    await waitFor(() => /◆ {2}Select agents/.test(frame(stdout)), "the agent picker");
    keys(stdin, " ", DOWN, " ", ENTER); // Claude Code + Codex
    keys(stdin, ENTER); // Claude Code authentication: Account
    keys(stdin, ENTER); // Claude Code account scope: Global
    keys(stdin, ENTER); // Claude Code sessions: Project
    await waitFor(() => /◆ {2}Codex authentication/.test(frame(stdout)), "Codex authentication");
    keys(stdin, ENTER); // Account
    await waitFor(() => /◆ {2}Codex account scope/.test(frame(stdout)), "Codex account scope");
    keys(stdin, DOWN, ENTER); // Project — this answer has to survive the detour
    await waitFor(() => /◆ {2}Codex sessions/.test(frame(stdout)), "Codex sessions");

    // Back to the agent list and drop Codex.
    keys(stdin, BACK, BACK, BACK, BACK, BACK, BACK); // sessions → scope → auth → Claude sessions → scope → auth → agents
    await waitFor(() => /◆ {2}Select agents/.test(frame(stdout)), "the agent picker again");
    assert.match(frame(stdout), /▸ ◉ {2}Codex/, "the cursor is on Codex, where it was left");
    keys(stdin, " "); // uncheck Codex
    keys(stdin, ENTER);
    await waitFor(() => /◆ {2}Claude Code authentication/.test(frame(stdout)), "the steps that remain");
    keys(stdin, ENTER, ENTER, ENTER); // Claude Code's three answers
    await waitFor(() => /◆ {2}History/.test(frame(stdout)), "history, with no Codex step in between");
    assert.ok(!frame(stdout).includes("Codex authentication"), "a disabled agent is no longer asked about");

    // Back in, enable Codex again: its earlier answer is still there.
    keys(stdin, BACK, BACK, BACK, BACK); // history → sessions → scope → auth → agents
    await waitFor(() => /◆ {2}Select agents/.test(frame(stdout)), "the agent picker once more");
    keys(stdin, " "); // check Codex again
    keys(stdin, ENTER);
    keys(stdin, ENTER, ENTER, ENTER); // Claude Code's three answers
    await waitFor(() => /◆ {2}Codex authentication/.test(frame(stdout)), "Codex authentication");
    keys(stdin, ENTER); // Account
    await waitFor(() => /◆ {2}Codex account scope/.test(frame(stdout)), "Codex account scope");
    assert.match(frame(stdout), /▸ ◉ {2}Project/, "the answer it had before is still selected");
    keys(stdin, ENTER, ENTER, ENTER, ENTER); // Codex scope, sessions, history, Apply
    await waitFor(() => /Apply configuration\?/.test(frame(stdout)), "the confirmation");
    keys(stdin, ENTER);
    assert.equal(await promise, 0);

    const written = await config();
    assert.deepEqual(Object.keys(written.agents).sort(), ["claude", "codex"]);
    assert.deepEqual(written.agents.codex, { authMethod: "account", accountScope: "project", sessionScope: "project" });
  });
});

test("enter with nothing selected is a prompt, not an answer", async () => {
  await withWizardProject(async ({ projectRoot, wizard }) => {
    const { stdin, stdout, promise } = wizard("init");
    await waitFor(() => /◆ {2}Select agents/.test(frame(stdout)), "the agent picker");
    keys(stdin, ENTER);
    await waitFor(() => /Select at least one agent/.test(frame(stdout)), "the validation message");
    assert.match(frame(stdout), /◆ {2}Select agents/, "the wizard stayed on the question");
    keys(stdin, " ", ENTER);
    await waitFor(() => /◆ {2}Claude Code authentication/.test(frame(stdout)), "the next step, once one is selected");
    keys(stdin, "\x1b");
    assert.equal(await promise, 0);
    assert.equal(existsSync(path.join(projectRoot, ".agents", "runtime.json")), false);
  });
});

test("a wizard that is cancelled leaves no half-written configuration", async () => {
  await withWizardProject(async ({ projectRoot, wizard }) => {
    const configPath = path.join(projectRoot, ".agents", "runtime.json");
    // Esc while choosing agents.
    const escaped = wizard("init");
    await waitFor(() => /◆ {2}Select agents/.test(frame(escaped.stdout)), "the agent picker");
    keys(escaped.stdin, " ", "\x1b");
    assert.equal(await escaped.promise, 0);
    assert.ok(!existsSync(configPath), "cancelling mid-wizard writes nothing");

    // Ctrl+C at the confirmation, after every question was answered.
    const interrupted = wizard("init");
    await waitFor(() => /◆ {2}Select agents/.test(frame(interrupted.stdout)), "the agent picker");
    keys(interrupted.stdin, " ", ENTER);
    for (const title of ["Claude Code authentication", "Claude Code account scope", "Claude Code sessions", "History"]) {
      await waitFor(() => new RegExp(`◆ {2}${title}`).test(frame(interrupted.stdout)), title);
      keys(interrupted.stdin, ENTER);
    }
    await waitFor(() => /◆ {2}Apply configuration\?/.test(frame(interrupted.stdout)), "the confirmation");
    keys(interrupted.stdin, "\x03");
    assert.equal(await interrupted.promise, 0);
    assert.ok(!existsSync(configPath), "cancelling at the end writes nothing either");

    // Esc at the confirmation, the other way out of the last step.
    const escapedAtEnd = wizard("init");
    await waitFor(() => /◆ {2}Select agents/.test(frame(escapedAtEnd.stdout)), "the agent picker");
    keys(escapedAtEnd.stdin, " ", ENTER);
    for (const title of ["Claude Code authentication", "Claude Code account scope", "Claude Code sessions", "History"]) {
      await waitFor(() => new RegExp(`◆ {2}${title}`).test(frame(escapedAtEnd.stdout)), title);
      keys(escapedAtEnd.stdin, ENTER);
    }
    await waitFor(() => /◆ {2}Apply configuration\?/.test(frame(escapedAtEnd.stdout)), "the confirmation");
    keys(escapedAtEnd.stdin, DOWN, ENTER); // No is the second answer: declining applies nothing
    assert.equal(await escapedAtEnd.promise, 0);
    assert.ok(!existsSync(configPath), "answering No writes nothing");
  });
});

test("avenic change adds an agent and switches history mode from the wizard", async () => {
  await withWizardProject(async ({ projectRoot, wizard, config }) => {
    const initialized = await runCli({
      argumentsList: ["init", "--agents", "claude,codex", "--auth", "account", "--sessions", "project", "--history", "shared"],
      projectRootOverride: projectRoot,
    });
    assert.equal(initialized, 0);

    const { stdin, stdout, promise } = wizard("change");
    await waitFor(() => /◆ {2}Select enabled agents/.test(frame(stdout)), "the enabled-agent picker");
    // The enabled agents are already selected: two steps down is OpenCode.
    keys(stdin, DOWN, DOWN, " ", ENTER);
    // OpenCode is asked about session storage and nothing else — its
    // authentication and provider configuration are its own.
    for (const title of [
      "Claude Code authentication", "Claude Code account scope", "Claude Code sessions",
      "Codex authentication", "Codex account scope", "Codex sessions",
      "OpenCode sessions",
    ]) {
      await waitFor(() => new RegExp(`◆ {2}${title}`).test(frame(stdout)), title);
      keys(stdin, ENTER); // the answers the project already has
    }
    await waitFor(() => /◆ {2}History/.test(frame(stdout)), "the history mode");
    keys(stdin, DOWN, ENTER); // Shared → Isolated
    await waitFor(() => /◆ {2}Apply configuration\?/.test(frame(stdout)), "the confirmation");
    keys(stdin, ENTER); // Yes
    assert.equal(await promise, 0);

    const written = await config();
    assert.deepEqual(Object.keys(written.agents).sort(), ["claude", "codex", "opencode"]);
    assert.deepEqual(written.agents.opencode, { sessionScope: "project" }, "OpenCode records a session choice and no method");
    assert.equal(written.historyMode, "isolated");
    const settled = frame(stdout);
    assert.match(settled, /◇ {2}Configuration updated/);
    assert.match(settled, /◇ {2}History\n│ {2}Isolated/, "the settled rail carries the new mode once");
  });
});

test("editing a project that already has an API configuration offers it back, and keeping it changes nothing", async () => {
  await withWizardProject(async ({ projectRoot, wizard }) => {
    // The configuration is already there before the wizard opens: the file
    // Avenic prepared, and then the values the user put in it.
    const { readModelConfiguration } = await import("../packages/core/src/index.mjs");
    const { fillApiConfiguration } = await import("./helpers/api-fixture.mjs");
    await runCli({
      argumentsList: ["claude", "init", "--auth", "api", "--scope", "project", "--sessions", "project"],
      projectRootOverride: projectRoot,
    });
    await fillApiConfiguration(projectRoot, "claude", "project", {
      provider: "Fixture Provider",
      baseUrl: "https://provider.fixture.invalid/v1",
      model: "fixture-model",
      credential: "fixture-credential-not-a-real-secret",
    });
    const file = path.join(projectRoot, ".claude", "settings.local.json");
    const { readFile } = await import("node:fs/promises");
    const before = await readFile(file, "utf8");

    const { stdin, stdout, promise } = wizard("change");
    await waitFor(() => /◆ {2}Select enabled agents/.test(frame(stdout)), "the agent picker");
    keys(stdin, ENTER); // Keep the agents that are enabled
    // Every question opens on the answer the project already gave — the method
    // and the file it reads included — and Enter takes each of them as it is.
    // The provider question is asked, and it opens on Set up by hand: the file
    // names a host no preset knows, and Avenic says so instead of guessing. No
    // endpoint, model or credential is asked for — those are the user's, and
    // answering "by hand" leaves every one of them exactly where it is.
    for (const title of [
      "Claude Code authentication", "Claude Code configuration scope",
      "Claude Code provider", "Claude Code sessions", "History",
    ]) {
      await waitFor(() => new RegExp(`◆ {2}${title}`).test(frame(stdout)), title);
      keys(stdin, ENTER);
    }
    await waitFor(() => /◆ {2}Apply configuration\?/.test(frame(stdout)), "the confirmation");
    keys(stdin, ENTER); // Yes
    assert.equal(await promise, 0);

    // Pressing Enter through an edit is not an answer that takes the
    // configuration away: every value, the secret included, is still there, and
    // the wizard never asked for one of them.
    assert.equal(await readFile(file, "utf8"), before);
    const read = await readModelConfiguration(projectRoot, "claude", "project");
    assert.equal(read.owned, true);
    assert.equal(read.provider, "provider.fixture.invalid", "the provider is the endpoint's host, read from the file");
    assert.equal(read.model, "fixture-model");
    assert.equal(read.credentialSet, true);
  });
});

// 「留还是删」那一问里，No 是唯一一个答完就让问题本身消失的答案：switchMode 不再是
// remove，那一问就不存在了。走出它的落点不能在步骤表里按 id 找 —— 找不到的意思正是
// 「这是最后一问，接下来就是 Apply」，而不是「回到第一题，把整场问答重问一遍」。
test("No at the destructive question goes on to Apply instead of restarting the questions", async () => {
  await withWizardProject(async ({ projectRoot, wizard, config }) => {
    // 先把项目配成 API：Avenic 建了那个文件，没有人动过它，于是它真的可删 ——
    // 这会问出第二个问题，而这一轮要证明的正是从第二个问题里走出来的那一步。
    const initialized = await runCli({
      argumentsList: ["claude", "init", "--auth", "api", "--scope", "project", "--sessions", "project"],
      projectRootOverride: projectRoot,
    });
    assert.equal(initialized, 0);
    const file = path.join(projectRoot, ".claude", "settings.local.json");
    assert.equal(existsSync(file), true);

    const { stdin, stdout, promise } = wizard("change");
    await waitFor(() => /◆ {2}Select enabled agents/.test(frame(stdout)), "the agent picker");
    keys(stdin, ENTER); // keep the agent that is enabled
    await waitFor(() => /◆ {2}Claude Code authentication/.test(frame(stdout)), "authentication");
    keys(stdin, UP, ENTER); // Account — the switch away from API（光标开在 API 上）
    for (const title of ["Claude Code account scope", "Claude Code sessions", "History"]) {
      await waitFor(() => new RegExp(`◆ {2}${title}`).test(frame(stdout)), title);
      keys(stdin, ENTER);
    }
    await waitFor(() => /◆ {2}What should Avenic do\?/.test(frame(stdout)), "the keep/remove question");
    keys(stdin, DOWN, ENTER); // Remove
    await waitFor(() => /◆ {2}Remove old configuration\?/.test(frame(stdout)), "the destructive question");
    keys(stdin, ENTER); // No — the question opens on it
    const next = await Promise.race([
      waitFor(() => /◆ {2}Apply configuration\?/.test(frame(stdout)), "the confirmation").then(() => "apply"),
      new Promise((resolve) => setTimeout(() => resolve("still asking"), 2000)),
    ]);
    assert.equal(next, "apply", `答 No 之后紧接着的就是 Apply：\n${frame(stdout)}`);
    keys(stdin, ENTER); // Yes
    assert.equal(await promise, 0);

    assert.equal((await config()).agents.claude.authMethod, "account");
    assert.equal(existsSync(file), true, "No 什么都不删");
  });
});

// Center 的答案落在 agent 自己的文件里，而那个文件同时装着用户的权限、hooks 和
// 变量，所以写完之后用户要能看见「写了哪个文件、动了哪几行」，且那几行是遮过的：
// 凭据进文件，不进屏幕。
//
// 这里把 console.log 也接到向导的那一条流上，于是断言的就是用户真正读到的那一屏：
// 落定帧从帧首擦到屏底，写盘期间打印的东西会连同「正在问的那一帧」一起被擦掉 ——
// 报告若早一步打印，这里就看不见它了。
test("the Center's write is reported on the settled frame, with the credential masked", async () => {
  await withWizardProject(async ({ projectRoot, logged, wizard }) => {
    const typed = "sk-wizard-not-a-real-key";
    const file = path.join(projectRoot, ".claude", "settings.local.json");
    const { stdin, stdout, promise } = wizard("init");
    console.log = (...parts) => {
      const line = parts.join(" ");
      logged.push(line);
      stdout.write(`${line}\n`);
    };
    const typedKeys = (text) => keys(stdin, ...text.split(""));

    await waitFor(() => /◆ {2}Select agents/.test(frame(stdout)), "the agent picker");
    keys(stdin, " ", ENTER); // Claude Code
    await waitFor(() => /◆ {2}Claude Code authentication/.test(frame(stdout)), "authentication");
    keys(stdin, DOWN, ENTER); // API
    await waitFor(() => /◆ {2}Claude Code configuration scope/.test(frame(stdout)), "the configuration scope");
    keys(stdin, DOWN, ENTER); // Project — the file belongs to this project
    await waitFor(() => /◆ {2}Claude Code provider/.test(frame(stdout)), "the provider question");
    keys(stdin, DOWN, ENTER); // DeepSeek — the first provider after "Set up by hand"
    await waitFor(() => /◆ {2}Claude Code model/.test(frame(stdout)), "the model question");
    typedKeys("deepseek-v4-pro");
    keys(stdin, ENTER);
    await waitFor(() => /◆ {2}Claude Code credential/.test(frame(stdout)), "the credential question");
    typedKeys(typed);
    keys(stdin, ENTER);
    for (const title of ["Claude Code sessions", "History"]) {
      await waitFor(() => new RegExp(`◆ {2}${title}`).test(frame(stdout)), title);
      keys(stdin, ENTER);
    }
    await waitFor(() => /◆ {2}Apply configuration\?/.test(frame(stdout)), "the confirmation");
    keys(stdin, ENTER); // Yes
    assert.equal(await promise, 0);

    const written = JSON.parse(await readFile(file, "utf8"));
    assert.equal(written.env.ANTHROPIC_AUTH_TOKEN, typed, "打进去的 key 就在 agent 自己的文件里");
    assert.equal(written.env.ANTHROPIC_BASE_URL, "https://api.deepseek.com/anthropic");
    const settled = frame(stdout);
    assert.match(settled, /└ {2}Avenic project initialized/, "落定帧是用户正在看的那一屏");
    assert.match(settled, /Claude Code: wrote \.claude\/settings\.local\.json/, "写了哪个文件说得出名字");
    assert.match(settled, /\+ +"ANTHROPIC_BASE_URL": "https:\/\/api\.deepseek\.com\/anthropic"/, "动了哪几行也在那一屏上");
    assert.match(settled, /\+ +"ANTHROPIC_AUTH_TOKEN": "••••"/, "凭据那一行是遮过的");
    assert.equal(settled.includes(typed), false, "屏幕上没有那个 key");

    // 第二次：回来改 History，每一问都按 Enter 过去。答案和文件里的一模一样，
    // 于是什么都不写 —— 而「什么都没写」也要说出来，因为用户刚刚答完了问题。
    const follow = wizard("change");
    console.log = (...parts) => {
      const line = parts.join(" ");
      logged.push(line);
      follow.stdout.write(`${line}\n`);
    };
    await waitFor(() => /◆ {2}Select enabled agents/.test(frame(follow.stdout)), "the agent picker");
    keys(follow.stdin, ENTER);
    for (const title of ["Claude Code authentication", "Claude Code configuration scope", "Claude Code provider", "Claude Code model", "Claude Code credential", "Claude Code sessions", "History"]) {
      await waitFor(() => new RegExp(`◆ {2}${title}`).test(frame(follow.stdout)), title);
      keys(follow.stdin, ENTER);
    }
    await waitFor(() => /◆ {2}Apply configuration\?/.test(frame(follow.stdout)), "the confirmation");
    keys(follow.stdin, ENTER); // Yes
    assert.equal(await follow.promise, 0);
    assert.match(frame(follow.stdout), /Claude Code: \.claude\/settings\.local\.json already matches — nothing written\./);
  });
});
