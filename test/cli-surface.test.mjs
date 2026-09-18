import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  appendCanonicalEvents,
  completeCanonicalContinuation,
  createCanonicalSession,
  initializeAgent,
  setSessionInteropMode,
} from "../packages/core/src/index.mjs";

// End-to-end coverage of the full CLI command surface. Every command position
// (main, agent runtime, skills, catalog, maintenance) is exercised through the
// real entry point; network access is avoided by pointing AVENIC_CATALOG_SPEC
// at local git fixtures and by faking npm for self-update fallbacks.

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agentBin = path.join(packageRoot, "packages", "cli", "scripts", "skills.mjs");

function runAgent(cwd, argumentsList, environment = {}) {
  return spawnSync(process.execPath, [agentBin, ...argumentsList], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, ...environment },
  });
}

function gitQuiet(cwd, argumentsList) {
  const result = spawnSync("git", ["-C", cwd, ...argumentsList], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function withTempDirectory(prefix, run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
    // Some tests git-clone the fixture into the sibling `<dir>-work` (git clone refuses an
    // existing target). mkdtemp never created that one, so remove it here or every run leaks it.
    await rm(`${directory}-work`, { recursive: true, force: true });
  }
}

async function commitAll(root, message) {
  await gitQuiet(root, ["init", "--quiet", "-b", "main"]);
  await gitQuiet(root, ["add", "-A"]);
  await gitQuiet(root, ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", message]);
}

// Catalog fixture: one source with three Skills and two Packs (common, development).
async function createCatalogFixture(root) {
  await mkdir(path.join(root, "packs"), { recursive: true });
  await mkdir(path.join(root, "licenses"), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "fixture-catalog", version: "1.0.0", private: true, agentSkills: { packageSpec: "fixture#main" } }, null, 2)}\n`,
  );
  await writeFile(
    path.join(root, "sources.lock.json"),
    `${JSON.stringify({ schemaVersion: 1, sources: [{ id: "test-source", name: "Test Source", repository: "https://github.com/example/test.git", skillRoot: "skills", revision: "a".repeat(40), skillPaths: { beta: "nested/beta" }, licenseFile: "licenses/test-source-LICENSE" }] }, null, 2)}\n`,
  );
  await writeFile(path.join(root, "licenses", "test-source-LICENSE"), "license\n");
  for (const skillName of ["alpha", "beta", "gamma"]) {
    const directory = path.join(root, "skills", "test-source", skillName);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "SKILL.md"), `---\nname: ${skillName}\n---\n`);
  }
  const common = { schemaVersion: 1, id: "common", name: "Common", description: "Common tools for everyday work.", sources: [{ source: "test-source", skills: ["alpha"] }] };
  const development = { schemaVersion: 1, id: "development", name: "Development", sources: [{ source: "test-source", skills: ["beta", "gamma"] }] };
  await writeFile(path.join(root, "packs", "common.json"), `${JSON.stringify(common, null, 2)}\n`);
  await writeFile(path.join(root, "packs", "development.json"), `${JSON.stringify(development, null, 2)}\n`);
  await commitAll(root, "fixture catalog");
}

// Upstream fixture: a standalone git repo containing two Skills under skills/.
async function createUpstreamFixture(root) {
  for (const skillName of ["delta", "epsilon"]) {
    const directory = path.join(root, "skills", skillName);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "SKILL.md"), `---\nname: ${skillName}\n---\ncontent\n`);
  }
  await commitAll(root, "upstream fixture");
}

function catalogEnvironment(catalogRoot, stateRoot) {
  return { AVENIC_CATALOG_SPEC: catalogRoot, AVENIC_STATE_DIR: stateRoot };
}

// A fake npm on PATH that records its arguments, so self-update fallbacks can be
// verified without touching the real global npm install.
async function withFakeNpm(run) {
  await withTempDirectory("avenic-fake-npm-", async (root) => {
    const binDirectory = path.join(root, "bin");
    const logFile = path.join(root, "npm.log");
    await mkdir(binDirectory);
    if (process.platform === "win32") {
      // .ps1 shims are launched through PowerShell by the runtime resolver.
      await writeFile(path.join(binDirectory, "npm.ps1"), `Add-Content -Path $env:NPM_LOG -Value ($args -join ' ')\n`);
    } else {
      const script = path.join(binDirectory, "npm");
      await writeFile(script, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$NPM_LOG\"\nexit 0\n");
      await chmod(script, 0o755);
    }
    const environment = {
      PATH: `${binDirectory}${path.delimiter}${process.env.PATH}`,
      Path: `${binDirectory}${path.delimiter}${process.env.PATH}`,
      NPM_LOG: logFile,
    };
    await run(environment, logFile);
  });
}

test("bare invocation and help positions exit cleanly without touching the catalog", async () => {
  await withTempDirectory("avenic-help-", async (projectRoot) => {
    for (const argumentsList of [[], ["help"], ["-h"], ["--help"]]) {
      const result = runAgent(projectRoot, argumentsList);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Avenic/);
      assert.doesNotMatch(result.stdout, /Installation Plan/);
    }
    const shorthand = runAgent(projectRoot, ["--help"]);
    assert.match(shorthand.stdout, /shorthand: ave/);
  });
});

test("version output identifies Avenic without contacting the registry", async () => {
  await withTempDirectory("avenic-version-", async (projectRoot) => {
    const result = runAgent(projectRoot, ["--version"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout.trim(), /^Avenic \d+\.\d+\.\d+$/);
    assert.equal(result.stderr, "");
  });
});

test("help leads with the end-user commands and keeps the per-agent ones below", async () => {
  await withTempDirectory("avenic-help-surface-", async (projectRoot) => {
    const help = runAgent(projectRoot, ["--help"]).stdout;
    for (const line of ["avenic init", "avenic change", "avenic sessions", "avenic self-update", "avenic --version"]) {
      assert.ok(help.includes(line), `help must show ${line}`);
    }
    assert.ok(help.indexOf("avenic init") < help.indexOf("avenic <claude|codex|opencode> init"), "the per-agent wrappers belong below the everyday commands");
    assert.match(help, /global auth|global\|project/, "help must say what the auth scope chooses");
    assert.match(help, /shared\|isolated/, "help must name both history modes");
  });
});

test("the README documents the same surface the CLI prints", async () => {
  // The package README is the end-user document: it is what npm renders and
  // what the help text has to agree with. The repository README only points at
  // it, so the two never drift into two different descriptions of one surface.
  const cliReadme = await readFile(path.join(packageRoot, "packages", "cli", "README.md"), "utf8");
  for (const command of ["avenic init", "avenic change", "avenic sessions", "avenic self-update", "avenic claude"]) {
    assert.ok(cliReadme.includes(command), `the README must show ${command}`);
  }
  assert.match(cliReadme, /Select at least one item/, "the TUI contract must be documented where users read it");
  assert.match(cliReadme, /Shared/);
  assert.match(cliReadme, /Isolated/);
  assert.match(cliReadme, /AVENIC_WATCH_INTERVAL_MS/);
  assert.match(cliReadme, /system Git|本机 git 认证/, "Hub credentials must be documented as the user's own git");

  const repoReadme = await readFile(path.join(packageRoot, "README.md"), "utf8");
  assert.match(repoReadme, /packages\/cli\/README\.md/, "the repository README must hand readers to the package README");
  for (const command of ["avenic init", "avenic claude", "avenic sessions", "avenic change"]) {
    assert.ok(repoReadme.includes(command), `the repository README must still show ${command}`);
  }
});

test("unknown commands fail with a clear error", async () => {
  await withTempDirectory("avenic-unknown-", async (projectRoot) => {
    // Point at a local fixture so the Pack-vs-typo catalog check stays offline.
    await withTempDirectory("avenic-catalog-", async (catalogRoot) => {
      await withTempDirectory("avenic-state-", async (stateRoot) => {
        await createCatalogFixture(catalogRoot);
        const environment = catalogEnvironment(catalogRoot, stateRoot);
        const result = runAgent(projectRoot, ["bogus-command"], environment);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /Error: Unknown command or Pack: bogus-command/);
      });
    });
  });
});

test("runtime overview and doctor cover all three agents", async () => {
  await withTempDirectory("avenic-overview-", async (projectRoot) => {
    const status = runAgent(projectRoot, ["status"]);
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /Claude Code/);
    assert.match(status.stdout, /Codex/);
    assert.match(status.stdout, /OpenCode/);
    assert.match(status.stdout, /Not initialized/);

    const doctor = runAgent(projectRoot, ["doctor"]);
    assert.equal(doctor.status, 0, doctor.stderr);
    assert.match(doctor.stdout, /Project root\s+OK/);
    assert.match(doctor.stdout, /Claude Code\s+(OK|NOT FOUND)/);
    assert.match(doctor.stdout, /Codex\s+(OK|NOT FOUND)/);
    assert.match(doctor.stdout, /OpenCode\s+(OK|NOT FOUND)/);
  });
});

test("sessions git toggles on/off/status and rejects invalid modes", async () => {
  await withTempDirectory("avenic-sessions-git-", async (projectRoot) => {
    spawnSync("git", ["init", "--quiet"], { cwd: projectRoot, windowsHide: true });
    const initialized = runAgent(projectRoot, ["codex", "init", "--auth", "global"]);
    assert.equal(initialized.status, 0, initialized.stderr);

    const on = runAgent(projectRoot, ["sessions", "git", "status"]);
    assert.equal(on.status, 0, on.stderr);
    assert.match(on.stdout, /Session Git sync: On/);

    const off = runAgent(projectRoot, ["sessions", "git", "off"]);
    assert.equal(off.status, 0, off.stderr);
    assert.match(off.stdout, /Status\s+Off/);
    const disabled = runAgent(projectRoot, ["sessions", "git", "status"]);
    assert.match(disabled.stdout, /Session Git sync: Off/);

    const reEnabled = runAgent(projectRoot, ["sessions", "git", "on"]);
    assert.equal(reEnabled.status, 0, reEnabled.stderr);
    assert.match(reEnabled.stdout, /Status\s+On/);
    assert.match(runAgent(projectRoot, ["sessions", "git", "status"]).stdout, /Session Git sync: On/);

    const invalidMode = runAgent(projectRoot, ["sessions", "git", "bogus"]);
    assert.equal(invalidMode.status, 1);
    assert.match(invalidMode.stderr, /Usage: avenic sessions git \[on\|off\|status\]/);
    const invalidCommand = runAgent(projectRoot, ["sessions", "bogus"]);
    assert.equal(invalidCommand.status, 1);
    assert.match(invalidCommand.stderr, /Usage: avenic sessions git \[on\|off\|status\]/);
  });
});

test("unified sessions list reads the canonical store without native agent dependencies", async () => {
  await withTempDirectory("avenic-canonical-list-", async (projectRoot) => {
    const result = runAgent(projectRoot, ["sessions", "list"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Canonical sessions/);
    assert.match(result.stdout, /No canonical sessions/);
  });
});

test("unified sessions status explains an empty canonical store", async () => {
  await withTempDirectory("avenic-canonical-status-", async (projectRoot) => {
    const result = runAgent(projectRoot, ["sessions", "status"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Canonical session status/);
    assert.match(result.stdout, /No canonical sessions/);
  });
});

test("Codex resume rejection rehydrates a fresh official thread from complete canonical history", async () => {
  await withTempDirectory("avenic-codex-rehydrate-", async (projectRoot) => {
    const bin = path.join(projectRoot, "bin");
    const codexHome = path.join(projectRoot, "codex-home");
    const log = path.join(projectRoot, "codex-arguments.jsonl");
    await mkdir(path.join(codexHome, "sessions", "2026", "09", "18"), { recursive: true });
    await mkdir(bin, { recursive: true });
    await initializeAgent(projectRoot, "codex", "global", "global");
    await setSessionInteropMode(projectRoot, "shared");
    await createCanonicalSession(projectRoot, { id: "shared" });
    await appendCanonicalEvents(projectRoot, "shared", [
      { id: "a", role: "user", createdAt: "2026-09-18T00:00:00.000Z", content: [{ type: "text", text: "A" }] },
      { id: "b", role: "assistant", createdAt: "2026-09-18T00:00:01.000Z", content: [{ type: "text", text: "B" }] },
    ]);
    await completeCanonicalContinuation(projectRoot, "shared", "codex", { nativeSessionId: "child" });
    const sessions = path.join(codexHome, "sessions", "2026", "09", "18");
    await writeFile(path.join(sessions, "parent.jsonl"), `${JSON.stringify({ type: "session_meta", payload: { id: "parent", cwd: projectRoot } })}\n`);
    await writeFile(path.join(sessions, "child.jsonl"), `${JSON.stringify({ type: "session_meta", payload: { id: "child", parent_thread_id: "parent", multi_agent_version: "v2", cwd: projectRoot } })}\n`);
    const probe = path.join(bin, "codex-probe.mjs");
    await writeFile(probe, `import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"; import path from "node:path"; const args = process.argv.slice(2); appendFileSync(process.env.AVENIC_FAKE_LOG, JSON.stringify(args) + "\\n"); if (args[0] === "resume") process.exit(1); const file = path.join(process.env.CODEX_HOME, "sessions", "2026", "09", "18", "bootstrap.jsonl"); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify({ type: "session_meta", payload: { id: "bootstrap", cwd: process.cwd() } }) + "\\n");`);
    const shim = process.platform === "win32" ? path.join(bin, "codex.cmd") : path.join(bin, "codex");
    await writeFile(shim, process.platform === "win32" ? `@echo off\r\nnode "${probe}" %*\r\n` : `#!/bin/sh\nexec node "${probe}" "$@"\n`);
    if (process.platform !== "win32") await chmod(shim, 0o755);
    const environment = {
      CODEX_HOME: codexHome,
      AVENIC_FAKE_LOG: log,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      Path: `${bin}${path.delimiter}${process.env.PATH}`,
    };
    const result = runAgent(projectRoot, ["sessions", "continue", "shared", "--agent", "codex"], environment);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /could not be resumed; starting a new native thread/);
    const calls = (await readFile(log, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.deepEqual(calls[0].slice(0, 2), ["resume", "parent"]);
    assert.match(calls[1][0], /- user: A/);
    assert.match(calls[1][0], /- assistant: B/);
  });
});

test("agent auth CLI switches scope, resets, and rejects invalid modes", async () => {
  await withTempDirectory("avenic-auth-", async (projectRoot) => {
    const initialized = runAgent(projectRoot, ["claude", "init", "--auth", "global"]);
    assert.equal(initialized.status, 0, initialized.stderr);

    const current = runAgent(projectRoot, ["claude", "auth"]);
    assert.equal(current.status, 0, current.stderr);
    assert.match(current.stdout, /Effective auth\s+global/);

    const project = runAgent(projectRoot, ["claude", "auth", "project"]);
    assert.equal(project.status, 0, project.stderr);
    assert.match(project.stdout, /Effective\s+project/);

    const reset = runAgent(projectRoot, ["claude", "auth", "reset"]);
    assert.equal(reset.status, 0, reset.stderr);
    assert.match(reset.stdout, /Effective\s+global/);

    const invalid = runAgent(projectRoot, ["claude", "auth", "bogus"]);
    assert.equal(invalid.status, 1);
    assert.match(invalid.stderr, /Authentication must be global or project: bogus/);
  });
});

test("agent launch and auth before init fail with hints", async () => {
  await withTempDirectory("avenic-before-init-", async (projectRoot) => {
    const launch = runAgent(projectRoot, ["claude"]);
    assert.equal(launch.status, 1);
    assert.match(launch.stderr, /is not initialized\. Run: avenic claude init/);

    const auth = runAgent(projectRoot, ["claude", "auth", "project"]);
    assert.equal(auth.status, 1);
    assert.match(auth.stderr, /is not initialized/);
  });
});

test("init validates options and auth/sessions modes", async () => {
  await withTempDirectory("avenic-init-validate-", async (projectRoot) => {
    const invalidAuth = runAgent(projectRoot, ["claude", "init", "--auth", "bogus"]);
    assert.equal(invalidAuth.status, 1);
    assert.match(invalidAuth.stderr, /Authentication must be global or project: bogus/);

    const invalidSessions = runAgent(projectRoot, ["codex", "init", "--sessions", "bogus"]);
    assert.equal(invalidSessions.status, 1);
    assert.match(invalidSessions.stderr, /Sessions must be global or project: bogus/);

    const unknownOption = runAgent(projectRoot, ["claude", "init", "--bogus"]);
    assert.equal(unknownOption.status, 1);
    assert.match(unknownOption.stderr, /Unknown option: --bogus/);

    const strayArgument = runAgent(projectRoot, ["claude", "init", "extra"]);
    assert.equal(strayArgument.status, 1);
    assert.match(strayArgument.stderr, /Unknown option: extra/);

    const deinit = runAgent(projectRoot, ["claude", "deinit", "--bogus"]);
    assert.equal(deinit.status, 1);
    assert.match(deinit.stderr, /Unknown option: --bogus/);
  });
});

test("top-level init and change keep shared history separate from agent scopes", async () => {
  await withTempDirectory("avenic-project-setup-", async (projectRoot) => {
    const initialized = runAgent(projectRoot, ["init", "--agents", "claude,codex", "--auth", "global", "--sessions", "project", "--history", "isolated"]);
    assert.equal(initialized.status, 0, initialized.stderr);
    assert.match(initialized.stdout, /History: isolated/);

    const changed = runAgent(projectRoot, ["change", "--history", "shared"]);
    assert.equal(changed.status, 0, changed.stderr);
    assert.match(changed.stdout, /History: shared/);
    const runtime = JSON.parse(await readFile(path.join(projectRoot, ".agents", "runtime.json"), "utf8"));
    assert.equal(runtime.sessionInterop, "shared");
    assert.deepEqual(runtime.agents.claude, { enabled: true, auth: "global", sessions: "project" });
    assert.deepEqual(runtime.agents.codex, { enabled: true, auth: "global", sessions: "project" });
  });
});

test("change updates only the selected agent scope unless agents are explicitly replaced", async () => {
  await withTempDirectory("avenic-change-scope-", async (projectRoot) => {
    assert.equal(runAgent(projectRoot, ["init", "--agents", "claude,codex", "--auth", "global", "--sessions", "project", "--history", "shared"]).status, 0);
    const changed = runAgent(projectRoot, ["change", "--agents", "codex", "--auth", "project"]);
    assert.equal(changed.status, 0, changed.stderr);
    const runtime = JSON.parse(await readFile(path.join(projectRoot, ".agents", "runtime.json"), "utf8"));
    assert.deepEqual(Object.keys(runtime.agents).sort(), ["claude", "codex"]);
    assert.equal(runtime.agents.claude.auth, "global");
    assert.equal(runtime.agents.codex.auth, "project");
  });
});

test("agent sessions import and status work through the CLI", async () => {
  await withTempDirectory("avenic-sessions-cli-", async (projectRoot) => {
    const initialized = runAgent(projectRoot, ["claude", "init", "--auth", "global"]);
    assert.equal(initialized.status, 0, initialized.stderr);

    await withTempDirectory("avenic-claude-home-", async (claudeHome) => {
      const environment = { CLAUDE_CONFIG_DIR: claudeHome };
      const imported = runAgent(projectRoot, ["claude", "sessions", "import"], environment);
      assert.equal(imported.status, 0, imported.stderr);
      assert.match(imported.stdout, /Sessions\s+0/);

      const status = runAgent(projectRoot, ["claude", "sessions", "status"], environment);
      assert.equal(status.status, 0, status.stderr);
      assert.match(status.stdout, /Sessions 0/);

      const invalid = runAgent(projectRoot, ["claude", "sessions", "bogus"], environment);
      assert.equal(invalid.status, 1);
      assert.match(invalid.stderr, /Usage: avenic claude sessions \[import\|writeback\|status\]/);

      // "restore" was renamed to "writeback" and is no longer accepted.
      const legacyRestore = runAgent(projectRoot, ["claude", "sessions", "restore"], environment);
      assert.equal(legacyRestore.status, 1);
      assert.match(legacyRestore.stderr, /Usage: avenic claude sessions \[import\|writeback\|status\]/);
    });
  });
});

test("skills help and unknown Pack errors stay offline", async () => {
  await withTempDirectory("avenic-skills-help-", async (projectRoot) => {
    const help = runAgent(projectRoot, ["skills", "help"]);
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Per-agent commands/);

    const missingSource = runAgent(projectRoot, ["skills", "add"]);
    assert.equal(missingSource.status, 1);
    assert.match(missingSource.stderr, /Usage: avenic skills add <owner\/repo>/);

    const extra = runAgent(projectRoot, ["skills", "self-update", "extra"]);
    assert.equal(extra.status, 1);
    assert.match(extra.stderr, /Usage: self-update/);

    await withTempDirectory("avenic-catalog-", async (catalogRoot) => {
      await withTempDirectory("avenic-state-", async (stateRoot) => {
        await createCatalogFixture(catalogRoot);
        const environment = catalogEnvironment(catalogRoot, stateRoot);
        const unknownPack = runAgent(projectRoot, ["skills", "bogus-pack"], environment);
        assert.equal(unknownPack.status, 1);
        assert.match(unknownPack.stderr, /Unknown command or Pack: bogus-pack/);
      });
    });
  });
});

test("bare skills installs the default common Pack", async () => {
  await withTempDirectory("avenic-skills-bare-", async (projectRoot) => {
    await withTempDirectory("avenic-catalog-", async (catalogRoot) => {
      await withTempDirectory("avenic-state-", async (stateRoot) => {
        await createCatalogFixture(catalogRoot);
        const environment = catalogEnvironment(catalogRoot, stateRoot);
        const installed = runAgent(projectRoot, ["skills"], environment);
        assert.equal(installed.status, 0, installed.stderr);
        assert.match(installed.stdout, /Installation complete: 1 unique Skills/);
        assert.equal(existsSync(path.join(projectRoot, ".agents", "skills", "alpha", "SKILL.md")), true);
        assert.equal(existsSync(path.join(projectRoot, ".avenic.lock.json")), true);
      });
    });
  });
});

test("skills packs and tree read the catalog", async () => {
  await withTempDirectory("avenic-skills-tree-", async (projectRoot) => {
    await withTempDirectory("avenic-catalog-", async (catalogRoot) => {
      await withTempDirectory("avenic-state-", async (stateRoot) => {
        await createCatalogFixture(catalogRoot);
        const environment = catalogEnvironment(catalogRoot, stateRoot);

        const packs = runAgent(projectRoot, ["skills", "packs"], environment);
        assert.equal(packs.status, 0, packs.stderr);
        assert.match(packs.stdout, /Available Packs/);
        assert.match(packs.stdout, /common/);
        assert.match(packs.stdout, /development/);

        const tree = runAgent(projectRoot, ["skills", "tree"], environment);
        assert.equal(tree.status, 0, tree.stderr);
        assert.match(tree.stdout, /alpha/);
        assert.match(tree.stdout, /beta/);
        assert.match(tree.stdout, /gamma/);

        const preview = runAgent(projectRoot, ["skills", "tree", "development"], environment);
        assert.equal(preview.status, 0, preview.stderr);
        assert.match(preview.stdout, /Pack Preview/);
        assert.match(preview.stdout, /Packs: Common \+ Development/);
      });
    });
  });
});

test("skills status reports the installed tree and fails without a lock", async () => {
  await withTempDirectory("avenic-skills-status-", async (projectRoot) => {
    await withTempDirectory("avenic-catalog-", async (catalogRoot) => {
      await withTempDirectory("avenic-state-", async (stateRoot) => {
        await createCatalogFixture(catalogRoot);
        const environment = catalogEnvironment(catalogRoot, stateRoot);

        const missing = runAgent(projectRoot, ["skills", "status"], environment);
        assert.equal(missing.status, 1);
        assert.match(missing.stderr, /no lock file/);
        const missingGlobal = runAgent(projectRoot, ["skills", "-g", "status"], environment);
        assert.equal(missingGlobal.status, 1);
        assert.match(missingGlobal.stderr, /no lock file/);

        const installed = runAgent(projectRoot, ["skills", "common"], environment);
        assert.equal(installed.status, 0, installed.stderr);
        const status = runAgent(projectRoot, ["skills", "status"], environment);
        assert.equal(status.status, 0, status.stderr);
        assert.match(status.stdout, /Packs: Common/);
        assert.match(status.stdout, /alpha/);
      });
    });
  });
});

test("skills doctor and update fall back to runtime meanings outside a catalog", async () => {
  await withTempDirectory("avenic-skills-fallback-", async (projectRoot) => {
    const doctor = runAgent(projectRoot, ["skills", "doctor"]);
    assert.equal(doctor.status, 0, doctor.stderr);
    assert.match(doctor.stdout, /Project root\s+OK/);

    const extra = runAgent(projectRoot, ["skills", "update", "extra"]);
    assert.equal(extra.status, 1);
    assert.match(extra.stderr, /Usage: avenic self-update/);

    await withFakeNpm(async (environment, logFile) => {
      const update = runAgent(projectRoot, ["skills", "update"], environment);
      assert.equal(update.status, 1);
      assert.match(update.stderr, /registry|version/i);
    });
  });
});

test("catalog add, default, and sync round-trip through the CLI", async () => {
  await withTempDirectory("avenic-catalog-cli-", async (projectRoot) => {
    await withTempDirectory("avenic-catalog-", async (catalogRoot) => {
      await withTempDirectory("avenic-state-", async (stateRoot) => {
        await createCatalogFixture(catalogRoot);
        const environment = { AVENIC_STATE_DIR: stateRoot };

        const used = runAgent(projectRoot, ["hub", "add", catalogRoot], environment);
        assert.equal(used.status, 0, used.stderr);
        assert.match(used.stdout, /Default Hub: /);
        assert.match(used.stdout, /Packs · 2/);
        assert.match(used.stdout, /├── common \(Common\) — Common tools for everyday work\./);
        assert.match(used.stdout, /└── development \(Development\)\n/);
        assert.doesNotMatch(used.stdout, /Development — /);
        assert.doesNotMatch(used.stdout, /alpha|beta|gamma/);
        assert.match(used.stdout, /Install: avenic skills install \[pack\.\.\.\]/);
        assert.match(used.stdout, /Run: avenic hub sync/);

        // "use" was renamed to "add" and is no longer accepted.
        const legacy = runAgent(projectRoot, ["hub", "use", catalogRoot], environment);
        assert.equal(legacy.status, 1);
        assert.match(legacy.stderr, /Usage: avenic hub <sync\|add\|select\|list\|default\|doctor\|update\|skill-add\|remove\|pack-add\|pack-remove\|source-add>/);

        const shown = runAgent(projectRoot, ["hub", "default"], environment);
        assert.equal(shown.status, 0, shown.stderr);
        assert.equal(shown.stdout.trim(), `Default Hub: ${catalogRoot}`);

        const synced = runAgent(projectRoot, ["hub", "sync"], environment);
        assert.equal(synced.status, 0, synced.stderr);
        assert.match(synced.stdout, /Hub sync/);
        assert.match(synced.stdout, /Revision\s+[0-9a-f]{40}/);

        const missingSpec = runAgent(projectRoot, ["hub", "add"], environment);
        assert.equal(missingSpec.status, 1);
        assert.match(missingSpec.stderr, /Usage: avenic hub add <spec>/);

        const globalSync = runAgent(projectRoot, ["hub", "-g", "sync"], environment);
        assert.equal(globalSync.status, 1);
        assert.match(globalSync.stderr, /Usage: avenic hub sync/);
      });
    });
  });
});

test("deprecated `catalog` verb still works with a deprecation warning", async () => {
  await withTempDirectory("avenic-hub-alias-", async (projectRoot) => {
    await withTempDirectory("avenic-state-", async (stateRoot) => {
      const legacy = runAgent(projectRoot, ["catalog", "default"], { AVENIC_STATE_DIR: stateRoot });
      assert.equal(legacy.status, 0, legacy.stderr);
      assert.match(legacy.stderr, /`avenic catalog` is deprecated/);
      assert.match(legacy.stdout, /Default Hub: /);
    });
  });
});

test("catalog add keeps the spec saved when the preview fetch fails", async () => {
  await withTempDirectory("avenic-catalog-cli-", async (projectRoot) => {
    await withTempDirectory("avenic-state-", async (stateRoot) => {
      const environment = { AVENIC_STATE_DIR: stateRoot };
      const missing = path.join(projectRoot, "no-such-catalog");

      const used = runAgent(projectRoot, ["hub", "add", missing], environment);
      assert.equal(used.status, 0, used.stderr);
      assert.match(used.stdout, /Default Hub: /);
      assert.match(used.stdout, /Spec saved\. Hub preview unavailable:/);
      assert.match(used.stdout, /Run: avenic hub sync/);

      const shown = runAgent(projectRoot, ["hub", "default"], environment);
      assert.equal(shown.status, 0, shown.stderr);
      assert.equal(shown.stdout.trim(), `Default Hub: ${missing}`);
    });
  });
});

test("catalog skill-add registers the first source in a fresh catalog", async () => {
  await withTempDirectory("avenic-fresh-catalog-", async (catalogRoot) => {
    await withTempDirectory("avenic-upstream-", async (upstreamRoot) => {
      await mkdir(path.join(catalogRoot, "packs"));
      await mkdir(path.join(catalogRoot, "skills"));
      await writeFile(
        path.join(catalogRoot, "sources.lock.json"),
        `${JSON.stringify({ schemaVersion: 1, sources: [] }, null, 2)}\n`,
      );
      await commitAll(catalogRoot, "fresh catalog");
      await createUpstreamFixture(upstreamRoot);

      const packAdded = runAgent(catalogRoot, ["hub", "pack-add", "common"]);
      assert.equal(packAdded.status, 0, packAdded.stderr);

      const added = runAgent(catalogRoot, ["hub", "skill-add", upstreamRoot, "--pack", "common"]);
      assert.equal(added.status, 0, added.stderr);
      assert.match(added.stdout, /Added all Skills: [a-z0-9._-]+ \(2\)/);
      assert.match(added.stdout, /Packs: common/);

      const lock = JSON.parse(await readFile(path.join(catalogRoot, "sources.lock.json"), "utf8"));
      assert.equal(lock.schemaVersion, 1);
      assert.equal(lock.sources.length, 1);

      const doctor = runAgent(catalogRoot, ["hub", "doctor"]);
      assert.equal(doctor.status, 0, doctor.stderr);
      assert.match(doctor.stdout, /OK: 2 Skills, 1 sources, 1 Packs/);
    });
  });
});

test("catalog list and select switch between registered catalogs", async () => {
  await withTempDirectory("avenic-catalog-select-", async (projectRoot) => {
    await withTempDirectory("avenic-catalog-a-", async (catalogA) => {
      await withTempDirectory("avenic-catalog-b-", async (catalogB) => {
        await withTempDirectory("avenic-state-", async (stateRoot) => {
          await createCatalogFixture(catalogA);
          await createCatalogFixture(catalogB);
          const environment = { AVENIC_STATE_DIR: stateRoot };
          const nameA = path.basename(catalogA);
          const nameB = path.basename(catalogB);

          const usedA = runAgent(projectRoot, ["hub", "add", catalogA], environment);
          assert.equal(usedA.status, 0, usedA.stderr);
          const usedB = runAgent(projectRoot, ["hub", "add", catalogB], environment);
          assert.equal(usedB.status, 0, usedB.stderr);

          // Most recently used first; the current one is marked.
          const listed = runAgent(projectRoot, ["hub", "list"], environment);
          assert.equal(listed.status, 0, listed.stderr);
          assert.match(listed.stdout, /Registered Hubs/);
          assert.match(listed.stdout, new RegExp(`> ${nameB}`));
          assert.match(listed.stdout, new RegExp(`^ {2}${nameA}`, "m"));
          assert.match(listed.stdout, /> = current\. Switch: avenic hub select/);

          // Without a TTY, `select` falls back to the plain list.
          const picked = runAgent(projectRoot, ["hub", "select"], environment);
          assert.equal(picked.status, 0, picked.stderr);
          assert.match(picked.stdout, /Registered Hubs/);

          // Select by display name switches the current Hub.
          const selected = runAgent(projectRoot, ["hub", "select", nameA], environment);
          assert.equal(selected.status, 0, selected.stderr);
          assert.match(selected.stdout, /Current Hub: /);
          const shown = runAgent(projectRoot, ["hub", "default"], environment);
          assert.equal(shown.stdout.trim(), `Default Hub: ${catalogA}`);

          const unknown = runAgent(projectRoot, ["hub", "select", "no-such"], environment);
          assert.equal(unknown.status, 1);
          assert.match(unknown.stderr, /Unknown Hub: no-such/);

          // A fresh state seeds the registry with the configured catalog.
          const freshList = runAgent(projectRoot, ["hub", "list"], {
            AVENIC_STATE_DIR: path.join(stateRoot, "fresh"),
          });
          assert.equal(freshList.status, 0, freshList.stderr);
          assert.match(freshList.stdout, /Echo-Kang-hub\/SkillsHub/);
        });
      });
    });
  });
});

test("skills adopt takes on-disk Skills into management without a catalog", async () => {
  await withTempDirectory("avenic-skills-adopt-", async (projectRoot) => {
    await withTempDirectory("avenic-state-", async (stateRoot) => {
      const environment = { AVENIC_STATE_DIR: stateRoot };
      await mkdir(path.join(projectRoot, ".agents", "skills", "handmade"), { recursive: true });
      await writeFile(path.join(projectRoot, ".agents", "skills", "handmade", "SKILL.md"), "---\nname: handmade\n---\n");

      const adopted = runAgent(projectRoot, ["skills", "adopt", "handmade"], environment);
      assert.equal(adopted.status, 0, adopted.stderr);
      assert.match(adopted.stdout, /Adopted Skills: handmade/);
      assert.match(adopted.stdout, /Placed targets: 1/); // 宿主目录 .agents 已存在，仅补齐 .claude 目标
      // 缺失的目标被补齐；lock 记录 adopted
      assert.equal(existsSync(path.join(projectRoot, ".claude", "skills", "handmade", "SKILL.md")), true);
      const lock = JSON.parse(await readFile(path.join(projectRoot, ".avenic.lock.json"), "utf8"));
      assert.equal(lock.adopted.includes("handmade"), true);

      // 幂等：与 install 不同，adopt 重复执行不报错（记录去重）
      const repeated = runAgent(projectRoot, ["skills", "adopt", "handmade"], environment);
      assert.equal(repeated.status, 0, repeated.stderr);
      assert.match(repeated.stdout, /Adopted Skills: handmade/);
      assert.doesNotMatch(repeated.stdout, /Placed targets:/);

      // 无参数 → 用法；未知 Skill（磁盘不存在）→ 明确失败
      const usage = runAgent(projectRoot, ["skills", "adopt"], environment);
      assert.equal(usage.status, 1);
      assert.match(usage.stderr, /Usage: adopt <skill\.\.\.> \[-g\]/);
      const missing = runAgent(projectRoot, ["skills", "adopt", "nosuchskill"], environment);
      assert.equal(missing.status, 1);
      assert.match(missing.stderr, /No on-disk skill found for: nosuchskill/);
    });
  });
});

test("skills install and remove are explicit verb pairs", async () => {
  await withTempDirectory("avenic-skills-verbs-", async (projectRoot) => {
    await withTempDirectory("avenic-catalog-", async (catalogRoot) => {
      await withTempDirectory("avenic-state-", async (stateRoot) => {
        await createCatalogFixture(catalogRoot);
        const environment = catalogEnvironment(catalogRoot, stateRoot);

        const installed = runAgent(projectRoot, ["skills", "install", "common"], environment);
        assert.equal(installed.status, 0, installed.stderr);
        assert.match(installed.stdout, /Installation complete/);

        await withTempDirectory("avenic-upstream-", async (upstreamRoot) => {
          await createUpstreamFixture(upstreamRoot);
          const added = runAgent(projectRoot, ["skills", "add", upstreamRoot], environment);
          assert.equal(added.status, 0, added.stderr);
          assert.match(added.stdout, /Installed direct Skills: delta, epsilon/);

          const removed = runAgent(projectRoot, ["skills", "remove", "delta", "epsilon"], environment);
          assert.equal(removed.status, 0, removed.stderr);
          assert.match(removed.stdout, /Removed external Skills: delta, epsilon/);

          const repeated = runAgent(projectRoot, ["skills", "remove", "delta"], environment);
          assert.equal(repeated.status, 0, repeated.stderr);
          assert.match(repeated.stdout, /Already absent: delta/);
        });
      });
    });
  });
});

test("catalog maintenance requires the catalog clone and doctor validates it", async () => {
  await withTempDirectory("avenic-catalog-maintenance-", async (projectRoot) => {
    const outsideDoctor = runAgent(projectRoot, ["hub", "doctor"]);
    assert.equal(outsideDoctor.status, 1);
    assert.match(outsideDoctor.stderr, /must run inside the Hub Git clone/);

    const outsideAdd = runAgent(projectRoot, ["hub", "skill-add", "some", "skill"]);
    assert.equal(outsideAdd.status, 1);
    assert.match(outsideAdd.stderr, /must run inside the Hub Git clone/);

    // "add" is the Hub import verb, not a maintenance command.
    const importUsage = runAgent(projectRoot, ["hub", "add", "some", "skill"]);
    assert.equal(importUsage.status, 1);
    assert.match(importUsage.stderr, /Usage: avenic hub add <spec>/);

    await withTempDirectory("avenic-catalog-", async (catalogRoot) => {
      await createCatalogFixture(catalogRoot);
      const cloneRoot = `${catalogRoot}-work`;
      await gitQuiet(catalogRoot, ["clone", "--quiet", catalogRoot, cloneRoot]);

      const doctor = runAgent(cloneRoot, ["hub", "doctor"]);
      assert.equal(doctor.status, 0, doctor.stderr);
      assert.match(doctor.stdout, /OK: 3 Skills, 1 sources, 2 Packs/);

      const unknown = runAgent(cloneRoot, ["hub", "bogus"]);
      assert.equal(unknown.status, 1);
      assert.match(unknown.stderr, /Usage: avenic hub <sync\|add\|select\|list\|default\|doctor\|update\|skill-add\|remove\|pack-add\|pack-remove\|source-add>/);
    });
  });
});

test("catalog pack-add and source-add manage the catalog", async () => {
  await withTempDirectory("avenic-catalog-manage-", async (catalogRoot) => {
    await withTempDirectory("avenic-upstream-", async (upstreamRoot) => {
      await createCatalogFixture(catalogRoot);
      await createUpstreamFixture(upstreamRoot);
      const cloneRoot = `${catalogRoot}-work`;
      await gitQuiet(catalogRoot, ["clone", "--quiet", catalogRoot, cloneRoot]);

      const packAdded = runAgent(cloneRoot, ["hub", "pack-add", "design", "--name", "Design"]);
      assert.equal(packAdded.status, 0, packAdded.stderr);
      assert.match(packAdded.stdout, /Created Pack: design/);
      const packFile = JSON.parse(await readFile(path.join(cloneRoot, "packs", "design.json"), "utf8"));
      assert.equal(packFile.name, "Design");

      const packRepeated = runAgent(cloneRoot, ["hub", "pack-add", "design"]);
      assert.equal(packRepeated.status, 1);
      assert.match(packRepeated.stderr, /Pack already exists: design/);

      const sourceAdded = runAgent(cloneRoot, ["hub", "source-add", "second", upstreamRoot, "--name", "Second"]);
      assert.equal(sourceAdded.status, 0, sourceAdded.stderr);
      assert.match(sourceAdded.stdout, /Registered second @ [0-9a-f]{8}/);
      assert.match(sourceAdded.stdout, /Next: avenic hub skill-add second/);
      const sources = JSON.parse(await readFile(path.join(cloneRoot, "sources.lock.json"), "utf8"));
      assert.equal(sources.sources.some((source) => source.id === "second"), true);

      const sourceRepeated = runAgent(cloneRoot, ["hub", "source-add", "second", upstreamRoot]);
      assert.equal(sourceRepeated.status, 1);
      assert.match(sourceRepeated.stderr, /Source already exists: second/);
    });
  });
});

test("catalog skill-add registers a source and vendors its Skills", async () => {
  await withTempDirectory("avenic-catalog-add-", async (catalogRoot) => {
    await withTempDirectory("avenic-upstream-", async (upstreamRoot) => {
      await createCatalogFixture(catalogRoot);
      await createUpstreamFixture(upstreamRoot);
      const cloneRoot = `${catalogRoot}-work`;
      await gitQuiet(catalogRoot, ["clone", "--quiet", catalogRoot, cloneRoot]);
      const packAdded = runAgent(cloneRoot, ["hub", "pack-add", "design"]);
      assert.equal(packAdded.status, 0, packAdded.stderr);

      const added = runAgent(cloneRoot, ["hub", "skill-add", upstreamRoot, "delta", "--pack", "design"]);
      assert.equal(added.status, 0, added.stderr);
      assert.match(added.stdout, /Added: [a-z0-9._-]+ -> delta/);
      assert.match(added.stdout, /Packs: design/);

      const packFile = JSON.parse(await readFile(path.join(cloneRoot, "packs", "design.json"), "utf8"));
      const sourceId = packFile.sources[0].source;
      assert.equal(packFile.sources[0].skills.includes("delta"), true);
      assert.equal(existsSync(path.join(cloneRoot, "skills", sourceId, "delta", "SKILL.md")), true);
      const sources = JSON.parse(await readFile(path.join(cloneRoot, "sources.lock.json"), "utf8"));
      assert.equal(sources.sources.some((source) => source.id === sourceId), true);

      const repeated = runAgent(cloneRoot, ["hub", "skill-add", upstreamRoot, "delta", "--pack", "design"]);
      assert.equal(repeated.status, 0, repeated.stderr);
      assert.match(repeated.stdout, /Already installed/);

      const missing = runAgent(cloneRoot, ["hub", "skill-add", upstreamRoot, "nosuchskill", "--pack", "design"]);
      assert.equal(missing.status, 1);
      assert.match(missing.stderr, /Skill not found upstream: nosuchskill/);
      const unchanged = JSON.parse(await readFile(path.join(cloneRoot, "packs", "design.json"), "utf8"));
      assert.equal(unchanged.sources[0].skills.includes("nosuchskill"), false);
    });
  });
});

test("catalog update follows upstream revisions", async () => {
  await withTempDirectory("avenic-catalog-update-", async (root) => {
    const upstreamRoot = path.join(root, "upstream");
    const catalogRoot = path.join(root, "catalog");
    await mkdir(path.join(upstreamRoot, "skills", "s"), { recursive: true });
    await writeFile(path.join(upstreamRoot, "skills", "s", "SKILL.md"), "---\nname: s\n---\nv1\n");
    await commitAll(upstreamRoot, "upstream v1");
    const firstRevision = gitQuiet(upstreamRoot, ["rev-parse", "HEAD"]);

    await mkdir(path.join(catalogRoot, "packs"), { recursive: true });
    await mkdir(path.join(catalogRoot, "skills", "up", "s"), { recursive: true });
    await writeFile(path.join(catalogRoot, "skills", "up", "s", "SKILL.md"), "---\nname: s\n---\nv1\n");
    await writeFile(path.join(catalogRoot, "packs", "common.json"), `${JSON.stringify({ schemaVersion: 1, id: "common", name: "Common", sources: [{ source: "up", skills: ["s"] }] }, null, 2)}\n`);
    await writeFile(path.join(catalogRoot, "sources.lock.json"), `${JSON.stringify({ schemaVersion: 1, sources: [{ id: "up", name: "Up", repository: upstreamRoot, skillRoot: "skills", revision: firstRevision }] }, null, 2)}\n`);
    await writeFile(path.join(catalogRoot, "package.json"), `${JSON.stringify({ name: "update-fixture", version: "1.0.0" })}\n`);
    await commitAll(catalogRoot, "catalog fixture");
    const cloneRoot = path.join(root, "work");
    await gitQuiet(catalogRoot, ["clone", "--quiet", catalogRoot, cloneRoot]);

    await writeFile(path.join(upstreamRoot, "skills", "s", "SKILL.md"), "---\nname: s\n---\nv2\n");
    await gitQuiet(upstreamRoot, ["add", "-A"]);
    await gitQuiet(upstreamRoot, ["-c", "user.name=f", "-c", "user.email=f@e", "commit", "--quiet", "-m", "upstream v2"]);
    const secondRevision = gitQuiet(upstreamRoot, ["rev-parse", "HEAD"]);

    const check = runAgent(cloneRoot, ["hub", "update", "--check"]);
    assert.equal(check.status, 0, check.stderr);
    assert.match(check.stdout, /up: update available/);

    const unknown = runAgent(cloneRoot, ["hub", "update", "bogus", "--check"]);
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /Unknown source: bogus/);

    const updated = runAgent(cloneRoot, ["hub", "update"]);
    assert.equal(updated.status, 0, updated.stderr);
    assert.match(updated.stdout, /Fetching upstream: Up/);
    assert.match(updated.stdout, /Update complete/);
    assert.match(await readFile(path.join(cloneRoot, "skills", "up", "s", "SKILL.md"), "utf8"), /v2/);
    const sources = JSON.parse(await readFile(path.join(cloneRoot, "sources.lock.json"), "utf8"));
    assert.equal(sources.sources[0].revision, secondRevision);

    const upToDate = runAgent(cloneRoot, ["hub", "update", "--check"]);
    assert.equal(upToDate.status, 0, upToDate.stderr);
    assert.match(upToDate.stdout, /up: up to date/);
  });
});
