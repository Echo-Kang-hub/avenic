import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadRuntime, projectConfig } from "../packages/core/src/index.mjs";
import { runCli } from "../packages/cli/src/cli/dispatcher.mjs";
import { FakeTTY, fakeStdout, keys, visible } from "./helpers/fake-tty.mjs";
import { keepingHostProject } from "./helpers/host-project.mjs";

// `avenic init` is about one directory: the one the command was run in.
//
// A repository is not a project. One repository can hold several Avenic
// projects — a monorepo package, a docs folder, a nested checkout — and the
// subdirectory a user is standing in when they type `init` is the one they
// mean. Promoting that answer to the repository root (or to an enclosing
// Avenic project) configures a directory the user never named, and the
// wizard's answers land somewhere they never look. `--root <path>` is the
// only override, and an enclosing project is a question, not an assumption.

async function waitFor(condition, description, timeout = 8000) {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeout) {
      throw new Error(`timeout waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function withRoots(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-init-root-"));
  const home = path.join(root, "home");
  const logged = [];
  const realLog = console.log;
  const patched = ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "AVENIC_STATE_DIR"];
  const saved = Object.fromEntries(patched.map((name) => [name, process.env[name]]));
  try {
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
    /** The CLI as a terminal runs it: `cwd` is where the user is standing. */
    const cli = (argumentsList, options = {}) => runCli({
      argumentsList,
      cwd: options.cwd ?? root,
      prompts: options.prompts,
      projectRootOverride: options.projectRootOverride,
    });
    /** The wizard as a terminal presents it, rooted where the user is. */
    const wizard = (command, cwd) => {
      const stdin = new FakeTTY();
      const stdout = fakeStdout();
      return { stdin, stdout, promise: cli([command], { cwd, prompts: { stdin, stdout } }) };
    };
    await keepingHostProject(() => run({
      root,
      logged,
      run: cli,
      wizard,
      async config(directory) {
        return projectConfig(await loadRuntime(directory));
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

const configured = (directory) => existsSync(path.join(directory, ".agents", "runtime.json"));

test("avenic init configures the directory it was run in, not the repository root", async () => {
  await withRoots(async ({ root, run }) => {
    const repository = path.join(root, "repo");
    const packageDirectory = path.join(repository, "packages", "app");
    await mkdir(path.join(repository, ".git"), { recursive: true });
    await mkdir(packageDirectory, { recursive: true });

    assert.equal(await run(["init", "--agents", "claude"], { cwd: packageDirectory }), 0);
    assert.ok(configured(packageDirectory), "the answers land in the directory the command ran in");
    assert.equal(configured(repository), false, "the repository root is not the project");
  });
});

test("avenic init --root configures exactly the named directory", async () => {
  await withRoots(async ({ root, run }) => {
    const repository = path.join(root, "repo");
    const packageDirectory = path.join(repository, "packages", "app");
    const elsewhere = path.join(root, "elsewhere");
    await mkdir(path.join(repository, ".git"), { recursive: true });
    await mkdir(packageDirectory, { recursive: true });
    await mkdir(elsewhere, { recursive: true });

    assert.equal(await run(["init", "--root", elsewhere, "--agents", "claude"], { cwd: packageDirectory }), 0);
    assert.ok(configured(elsewhere), "the named directory is the project");
    assert.equal(configured(packageDirectory), false, "the working directory is not");
    assert.equal(configured(repository), false, "and neither is the repository root");
  });
});

test("avenic init inside another Avenic project asks before making a separate one", async () => {
  await withRoots(async ({ root, run, wizard, config }) => {
    const parent = path.join(root, "parent");
    const child = path.join(parent, "child");
    await mkdir(child, { recursive: true });
    assert.equal(await run(["init", "--agents", "claude"], { cwd: parent }), 0);
    const parentConfig = await config(parent);

    // No: the directory stays as it was, and the enclosing project is untouched.
    const declined = wizard("init", child);
    await waitFor(() => /separate project\?/.test(visible(declined.stdout.text())), "the nested-project question");
    assert.ok(visible(declined.stdout.text()).includes(parent), "the question names the project it is inside");
    assert.ok(visible(declined.stdout.text()).includes("inside another Avenic project"), "and says why it is asking");
    keys(declined.stdin, "n");
    assert.equal(await declined.promise, 0);
    assert.equal(configured(child), false, "declining writes nothing");
    assert.deepEqual(await config(parent), parentConfig, "and leaves the enclosing project alone");

    // Yes: this directory becomes its own project, the parent keeps its own.
    const accepted = wizard("init", child);
    await waitFor(() => /inside another Avenic project/.test(visible(accepted.stdout.text())), "the nested-project question");
    keys(accepted.stdin, "y");
    await waitFor(() => /Select agents/.test(visible(accepted.stdout.text())), "the wizard after the question");
    keys(accepted.stdin, " ", "\r"); // Claude Code
    for (const title of ["Claude Code authentication", "Claude Code session storage", "Session history"]) {
      await waitFor(() => new RegExp(`◆ {2}${title}`).test(visible(accepted.stdout.text())), title);
      keys(accepted.stdin, "\r");
    }
    await waitFor(() => /Apply configuration\?/.test(visible(accepted.stdout.text())), "the confirmation");
    keys(accepted.stdin, "\r"); // Yes is the offered answer
    assert.equal(await accepted.promise, 0);
    assert.ok(configured(child), "accepting makes this directory a project");
    assert.deepEqual(await config(parent), parentConfig, "and the enclosing project keeps its own configuration");
  });
});

test("a non-interactive init inside another Avenic project refuses instead of guessing", async () => {
  await withRoots(async ({ root, run }) => {
    const parent = path.join(root, "parent");
    const child = path.join(parent, "child");
    await mkdir(child, { recursive: true });
    assert.equal(await run(["init", "--agents", "claude"], { cwd: parent }), 0);

    await assert.rejects(
      run(["init", "--agents", "claude"], { cwd: child }),
      /inside another Avenic project/i,
      "with no terminal to ask, the command says what it would have asked",
    );
    assert.equal(configured(child), false);
    assert.equal(configured(parent), true);
  });
});

test("avenic change still edits the project the directory belongs to", async () => {
  await withRoots(async ({ root, run, config }) => {
    const repository = path.join(root, "repo");
    const packageDirectory = path.join(repository, "packages", "app");
    await mkdir(path.join(repository, ".git"), { recursive: true });
    await mkdir(packageDirectory, { recursive: true });
    assert.equal(await run(["init", "--agents", "claude"], { cwd: repository }), 0);

    assert.equal(await run(["change", "--agents", "claude", "--auth", "project"], { cwd: packageDirectory }), 0);
    const written = await config(repository);
    assert.equal(written.agents.claude.auth, "project", "the enclosing project is the one that changed");
    assert.equal(configured(packageDirectory), false, "no second project appears in the package");
  });
});
