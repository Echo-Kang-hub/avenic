import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = await mkdtemp(path.join(os.tmpdir(), "avenic-global-install-"));
const prefix = path.join(root, "prefix");
const home = path.join(root, "home");
const stateDirectory = path.join(root, "state");
const projectRoot = path.join(root, "project");
const npmCli = process.env.npm_execpath;

function git(cwd, argumentsList) {
  const result = spawnSync("git", ["-C", cwd, ...argumentsList], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function runLauncher(launcher, argumentsList, cwd, environment) {
  const windows = process.platform === "win32";
  const result = spawnSync(
    windows ? `"${launcher}" ${argumentsList.join(" ")}` : launcher,
    windows ? [] : argumentsList,
    { cwd, encoding: "utf8", env: environment, shell: windows, windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function pack(directory, environment) {
  const result = spawnSync(
    process.execPath,
    [npmCli, "pack", directory, "--pack-destination", root, "--json"],
    { encoding: "utf8", env: environment, windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return path.join(root, JSON.parse(result.stdout)[0].filename);
}

async function codexResumeFallbackFixture(environment) {
  const fixtureRoot = await mkdtemp(path.join(root, "codex-fallback-"));
  const bin = path.join(fixtureRoot, "bin");
  const codexHome = path.join(fixtureRoot, "home");
  const sessions = path.join(codexHome, "sessions", "2026", "09", "18");
  const log = path.join(fixtureRoot, "arguments.jsonl");
  await mkdir(sessions, { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(sessions, "parent.jsonl"), `${JSON.stringify({ type: "session_meta", payload: { id: "parent", cwd: projectRoot } })}\n`);
  await writeFile(path.join(sessions, "child.jsonl"), `${JSON.stringify({ type: "session_meta", payload: { id: "child", parent_thread_id: "parent", multi_agent_version: "v2", cwd: projectRoot } })}\n${JSON.stringify({ type: "response_item", timestamp: "2026-09-18T00:00:00.000Z", payload: { id: "a", type: "message", role: "user", content: [{ type: "input_text", text: "A" }] } })}\n${JSON.stringify({ type: "response_item", timestamp: "2026-09-18T00:00:01.000Z", payload: { id: "b", type: "message", role: "assistant", content: [{ type: "output_text", text: "B" }] } })}\n`);
  const probe = path.join(bin, "codex-probe.mjs");
  await writeFile(probe, `import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"; import path from "node:path"; const args = process.argv.slice(2); appendFileSync(process.env.AVENIC_FAKE_LOG, JSON.stringify(args) + "\\n"); if (args[0] === "resume") process.exit(1); const file = path.join(process.env.CODEX_HOME, "sessions", "2026", "09", "18", "bootstrap.jsonl"); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify({ type: "session_meta", payload: { id: "bootstrap", cwd: process.cwd() } }) + "\\n");`);
  const executable = process.platform === "win32" ? path.join(bin, "codex.cmd") : path.join(bin, "codex");
  await writeFile(executable, process.platform === "win32" ? `@echo off\r\nnode "${probe}" %*\r\n` : `#!/bin/sh\nexec node "${probe}" "$@"\n`);
  if (process.platform !== "win32") await chmod(executable, 0o755);
  const inheritedPath = environment.PATH ?? environment.Path ?? process.env.PATH ?? process.env.Path ?? "";
  return {
    log,
    environment: {
      ...environment,
      CODEX_HOME: codexHome,
      AVENIC_FAKE_LOG: log,
      PATH: `${bin}${path.delimiter}${inheritedPath}`,
      Path: `${bin}${path.delimiter}${inheritedPath}`,
    },
  };
}

async function verifyInstall(archive, environment) {
  const installed = spawnSync(
    process.execPath,
    [npmCli, "install", "--global", archive, "--prefix", prefix],
    { encoding: "utf8", env: environment, windowsHide: true },
  );
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);
  const binDirectory = process.platform === "win32" ? prefix : path.join(prefix, "bin");
  const launcher = path.join(binDirectory, process.platform === "win32" ? "avenic.cmd" : "avenic");
  assert.equal(existsSync(launcher), true, `Missing global launcher: ${launcher}`);
  const shorthand = path.join(binDirectory, process.platform === "win32" ? "ave.cmd" : "ave");
  assert.equal(existsSync(shorthand), true, `Missing shorthand launcher: ${shorthand}`);
  await mkdir(projectRoot, { recursive: true });
  const shorthandHelp = runLauncher(shorthand, ["--help"], projectRoot, environment);
  assert.match(shorthandHelp.stdout, /shorthand: ave/);
  const launched = runLauncher(launcher, ["codex", "init", "--auth", "account", "--scope", "global"], projectRoot, environment);
  assert.match(launched.stdout, /Changed:/);
  assert.equal(existsSync(path.join(projectRoot, ".agents", "runtime.json")), true);
  const fallback = await codexResumeFallbackFixture(environment);
  const imported = runLauncher(launcher, ["codex", "sessions", "import"], projectRoot, fallback.environment);
  assert.match(imported.stdout, /imported/);
  const continued = runLauncher(launcher, ["sessions", "continue", "codex-child", "--agent", "codex"], projectRoot, fallback.environment);
  assert.match(continued.stdout, /session could not be opened; rebuilding it from shared canonical history/);
  const calls = (await readFile(fallback.log, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
  // A Codex that refuses `resume` is not the end of the conversation: the
  // installed CLI rebuilds the thread through Codex's own app-server, and only
  // when that cannot be spoken to either does it hand over the transcript —
  // the order is the product's, so it is asserted here in that order.
  assert.deepEqual(calls[0].slice(0, 2), ["resume", "parent"]);
  assert.deepEqual(calls[1].slice(0, 2), ["app-server", "--listen"], "a session Codex will not open is rebuilt through its own interface");
  assert.match(calls[2][0], /# Avenic continuation \[codex\]/);
  assert.match(calls[2][0], /- user: A/);
  assert.match(calls[2][0], /- assistant: B/);
  assert.equal(continued.status, 0);
  const deinitialized = runLauncher(launcher, ["codex", "deinit", "--purge"], projectRoot, environment);
  // The vocabulary refactor renamed the row: what deinit takes back is the
  // agent's own settings, and the summary says so in the Dashboard's words.
  assert.match(deinitialized.stdout, /Settings  Removed/);
  assert.match(deinitialized.stdout, /Data      Purged/);
  assert.equal(existsSync(path.join(projectRoot, ".agents", "runtime.json")), false);
}

async function uninstall(packageName, environment) {
  const result = spawnSync(
    process.execPath,
    [npmCli, "uninstall", "--global", packageName, "--prefix", prefix],
    { encoding: "utf8", env: environment, windowsHide: true },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const binDirectory = process.platform === "win32" ? prefix : path.join(prefix, "bin");
  const launcher = path.join(binDirectory, process.platform === "win32" ? "avenic.cmd" : "avenic");
  assert.equal(existsSync(launcher), false, `Global launcher still exists after uninstall: ${launcher}`);
}

async function createCatalogFixture() {
  const catalogRoot = path.join(root, "catalog");
  const skillDirectory = path.join(catalogRoot, "skills", "test-source", "alpha");
  await mkdir(skillDirectory, { recursive: true });
  await mkdir(path.join(catalogRoot, "packs"), { recursive: true });
  await writeFile(path.join(skillDirectory, "SKILL.md"), "---\nname: alpha\n---\n");
  await writeFile(
    path.join(catalogRoot, "sources.lock.json"),
    `${JSON.stringify({ schemaVersion: 1, sources: [{ id: "test-source", name: "Test Source", repository: "https://github.com/example/test.git", skillRoot: "skills", revision: "a".repeat(40) }] }, null, 2)}\n`,
  );
  await writeFile(
    path.join(catalogRoot, "packs", "common.json"),
    `${JSON.stringify({ schemaVersion: 1, id: "common", name: "Common", sources: [{ source: "test-source", skills: ["alpha"] }] }, null, 2)}\n`,
  );
  await writeFile(
    path.join(catalogRoot, "package.json"),
    `${JSON.stringify({ name: "fixture-catalog", version: "1.0.0", private: true, agentSkills: { packageSpec: "fixture#main" } }, null, 2)}\n`,
  );
  git(catalogRoot, ["init", "--quiet", "-b", "main"]);
  git(catalogRoot, ["add", "-A"]);
  git(catalogRoot, ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "--quiet", "-m", "fixture"]);
  return { catalogRoot, revision: git(catalogRoot, ["rev-parse", "HEAD"]) };
}

async function verifySkills(environment) {
  const { catalogRoot, revision } = await createCatalogFixture();
  const skillsEnvironment = {
    ...environment,
    AVENIC_CATALOG_SPEC: catalogRoot,
    AVENIC_STATE_DIR: stateDirectory,
  };
  const binDirectory = process.platform === "win32" ? prefix : path.join(prefix, "bin");
  const agentLauncher = path.join(binDirectory, process.platform === "win32" ? "avenic.cmd" : "avenic");
  const installed = runLauncher(agentLauncher, ["skills", "common"], projectRoot, skillsEnvironment);
  assert.match(installed.stdout, /Installation complete/);
  assert.equal(existsSync(path.join(projectRoot, ".claude", "skills", "alpha", "SKILL.md")), true);
  assert.equal(existsSync(path.join(projectRoot, ".agents", "skills", "alpha", "SKILL.md")), true);
  const lock = JSON.parse(await readFile(path.join(projectRoot, ".avenic.lock.json"), "utf8"));
  assert.equal(lock.catalog.revision, revision);

  // Global scope: the same catalog installs into user-level directories.
  const globalInstalled = runLauncher(agentLauncher, ["skills", "-g", "common"], projectRoot, skillsEnvironment);
  assert.match(globalInstalled.stdout, /Installation complete/);
  assert.equal(existsSync(path.join(home, ".claude", "skills", "alpha", "SKILL.md")), true);
  assert.equal(existsSync(path.join(home, ".agents", "skills", "alpha", "SKILL.md")), true);
  const globalLock = JSON.parse(await readFile(path.join(stateDirectory, "lock.json"), "utf8"));
  assert.equal(globalLock.catalog.revision, revision);

  // The lock's pinned catalog revision must be consumed on explicit installs:
  // advancing the catalog must not change a pinned reinstall.
  const installedSkillFile = path.join(projectRoot, ".agents", "skills", "alpha", "SKILL.md");
  const installedBefore = await readFile(installedSkillFile, "utf8");
  const skillFile = path.join(catalogRoot, "skills", "test-source", "alpha", "SKILL.md");
  await writeFile(skillFile, `${await readFile(skillFile, "utf8")}updated\n`);
  // A real catalog update also bumps the pinned source revision in sources.lock.json.
  const sourcesLock = JSON.parse(await readFile(path.join(catalogRoot, "sources.lock.json"), "utf8"));
  sourcesLock.sources[0].revision = "b".repeat(40);
  await writeFile(path.join(catalogRoot, "sources.lock.json"), `${JSON.stringify(sourcesLock, null, 2)}\n`);
  git(catalogRoot, ["add", "-A"]);
  git(catalogRoot, ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "--quiet", "-m", "advance"]);
  const advancedRevision = git(catalogRoot, ["rev-parse", "HEAD"]);

  const pinned = runLauncher(agentLauncher, ["skills", "common"], projectRoot, skillsEnvironment);
  assert.match(pinned.stdout, /Installation complete/);
  const pinnedLock = JSON.parse(await readFile(path.join(projectRoot, ".avenic.lock.json"), "utf8"));
  assert.equal(pinnedLock.catalog.revision, revision, "explicit install must stay on the locked catalog revision");
  assert.equal(
    await readFile(installedSkillFile, "utf8"),
    installedBefore,
    "pinned reinstall must not change installed content",
  );

  // A bare `avenic skills` syncs the configured Packs from the latest catalog.
  const refreshed = runLauncher(agentLauncher, ["skills"], projectRoot, skillsEnvironment);
  assert.match(refreshed.stdout, /Installation complete/);
  const refreshedLock = JSON.parse(await readFile(path.join(projectRoot, ".avenic.lock.json"), "utf8"));
  assert.equal(refreshedLock.catalog.revision, advancedRevision, "bare install must refresh to the latest catalog revision");
  assert.equal(
    (await readFile(installedSkillFile, "utf8")).replaceAll("\r\n", "\n"),
    "---\nname: alpha\n---\nupdated\n",
    "refreshed install must update installed content",
  );
}

try {
  assert.ok(npmCli, "npm_execpath is required; run with npm run test:install");
  // 只换 HOME 挡不住别的：这几个变量各自指向一个真实的家，继承了它们，下面那条
  // `init --scope global` 与 `codex deinit --purge` 就会写到开发机自己的目录里去。
  const environment = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    CODEX_HOME: path.join(home, ".codex"),
    AVENIC_STATE_DIR: path.join(home, ".avenic"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
  };

  // Mode 1: registry equivalent — the published packages/cli tarball.
  const cliArchive = pack(path.join(packageRoot, "packages", "cli"), environment);
  await verifyInstall(cliArchive, environment);
  await uninstall("avenic", environment);

  // Mode 2: GitHub equivalent — the avenic-repo root tarball with synced vendor core.
  const rootArchive = pack(packageRoot, environment);
  await verifyInstall(rootArchive, environment);
  await verifySkills(environment);
  await uninstall("avenic-repo", environment);

  console.log("Dual-mode global install, agent runtime, and skills tests passed");
} finally {
  await rm(root, { recursive: true, force: true });
}
