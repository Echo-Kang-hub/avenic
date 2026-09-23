// A release smoke test: pack the CLI the way npm publishes it, install that
// tarball into a temporary global prefix, and run the commands a user runs —
// version, init, a plain launch, sessions, change, Shared and Isolated, and
// self-update.
//
// Nothing here touches the machine's real global prefix, its real home, or the
// network: the temp prefix is the only thing installed, the agents are stubs
// that write real-shaped native history, and self-update runs against a stub
// npm so the update path is exercised without moving anybody's installation.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmCli = process.env.npm_execpath;
const root = await mkdtemp(path.join(os.tmpdir(), "avenic-release-smoke-"));
const prefix = path.join(root, "prefix");
const home = path.join(root, "home");
const projectRoot = path.join(root, "project");
const stateDirectory = path.join(root, "state");
const bin = path.join(root, "bin");
const binDirectory = process.platform === "win32" ? prefix : path.join(prefix, "bin");
const launcher = path.join(binDirectory, process.platform === "win32" ? "avenic.cmd" : "avenic");
const inheritedPath = process.env.PATH ?? process.env.Path ?? "";

const cliMetadata = JSON.parse(await readFile(path.join(packageRoot, "packages", "cli", "package.json"), "utf8"));

function run(command, argumentsList, environment, options = {}) {
  const windows = process.platform === "win32";
  const result = spawnSync(
    windows ? `"${command}" ${argumentsList.join(" ")}` : command,
    windows ? [] : argumentsList,
    {
      cwd: options.cwd ?? projectRoot,
      encoding: "utf8",
      env: environment,
      shell: windows,
      windowsHide: true,
    },
  );
  if (!options.allowFailure) {
    assert.equal(result.status, 0, `${command} ${argumentsList.join(" ")}\n${result.stderr || result.stdout}`);
  }
  return result;
}

function avenic(argumentsList, environment, options = {}) {
  return run(launcher, argumentsList, environment, options);
}

// Every launcher that a test or a user could reach has to be a file, not a
// promise: on Windows a .cmd is what a shell will find, elsewhere a script with
// the executable bit.
async function writeExecutable(directory, name, body) {
  await mkdir(directory, { recursive: true });
  const script = path.join(directory, `${name}.mjs`);
  await writeFile(script, body);
  if (process.platform === "win32") {
    await writeFile(path.join(directory, `${name}.cmd`), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  } else {
    const target = path.join(directory, name);
    await writeFile(target, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    await chmod(target, 0o755);
  }
}

function claudeRecord(sessionId, index) {
  return JSON.stringify({
    type: index % 2 === 0 ? "user" : "assistant",
    uuid: `uuid-${index}`,
    sessionId,
    timestamp: new Date(Date.UTC(2026, 8, 19) + index * 1000).toISOString(),
    cwd: process.cwd(),
    message: {
      role: index % 2 === 0 ? "user" : "assistant",
      model: "claude-sonnet-5",
      content: [{ type: "text", text: `smoke message ${index}` }],
    },
  });
}

function codexRecord(index) {
  return JSON.stringify({
    timestamp: new Date(Date.UTC(2026, 8, 19) + index * 1000).toISOString(),
    type: "response_item",
    payload: {
      id: `payload-${index}`,
      type: "message",
      role: index % 2 === 0 ? "user" : "assistant",
      content: [{ type: index % 2 === 0 ? "input_text" : "output_text", text: `codex smoke ${index}` }],
    },
  });
}

// Stand-ins for the official CLIs. Each writes the native history a real agent
// would leave behind, in the agent's own storage, for the project it was
// started in — which is exactly what capture, import and projection read.
async function writeAgents() {
  await writeExecutable(bin, "claude", `import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
const home = process.env.CLAUDE_CONFIG_DIR ?? path.join(process.env.HOME ?? "", ".claude");
const sessionId = process.env.AVENIC_SMOKE_SESSION;
const directory = path.join(home, "projects", process.cwd().replace(/[^a-zA-Z0-9]/g, "-"));
mkdirSync(directory, { recursive: true });
const records = ${claudeRecord.toString()};
const lines = Array.from({ length: 4 }, (_, index) => records(sessionId, index));
writeFileSync(path.join(directory, \`\${sessionId}.jsonl\`), \`\${lines.join("\\n")}\\n\`);
process.stdout.write("claude-stub: the official TUI would be here\\n");
process.exit(0);
`);
  await writeExecutable(bin, "codex", `import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
const home = process.env.CODEX_HOME ?? path.join(process.env.HOME ?? "", ".codex");
const sessionId = process.env.AVENIC_SMOKE_SESSION;
const directory = path.join(home, "sessions", "2026", "09", "19");
mkdirSync(directory, { recursive: true });
const records = ${codexRecord.toString()};
const lines = [JSON.stringify({ type: "session_meta", payload: { id: sessionId, cwd: process.cwd(), model_provider: "openai" } })];
for (let index = 0; index < 4; index += 1) lines.push(records(index));
writeFileSync(path.join(directory, \`rollout-\${sessionId}.jsonl\`), \`\${lines.join("\\n")}\\n\`);
process.stdout.write("codex-stub: the official TUI would be here\\n");
process.exit(0);
`);
}

async function listTree(directory) {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath ?? entry.path, entry.name));
}

// The JSON a launch writes about itself: launch state lives in the OS temp
// directory rather than in the project, so it is what a leak would be found in.
async function launchStateFiles() {
  const tempRoot = os.tmpdir();
  const files = [];
  for (const name of await readdir(tempRoot).catch(() => [])) {
    if (!name.startsWith("avenic-launch-")) continue;
    const directory = path.join(tempRoot, name);
    for (const entry of await readdir(directory).catch(() => [])) {
      if (entry.endsWith(".json")) files.push(path.join(directory, entry));
    }
  }
  return files;
}

async function main() {
  await mkdir(home, { recursive: true });
  await mkdir(projectRoot, { recursive: true });
  await writeAgents();
  const environment = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    CODEX_HOME: path.join(home, ".codex"),
    AVENIC_STATE_DIR: stateDirectory,
    PATH: `${bin}${path.delimiter}${binDirectory}${path.delimiter}${inheritedPath}`,
    Path: `${bin}${path.delimiter}${binDirectory}${path.delimiter}${inheritedPath}`,
  };

  // What npm publishes, installed the way a user installs it.
  const packed = spawnSync(
    process.execPath,
    [npmCli, "pack", path.join(packageRoot, "packages", "cli"), "--pack-destination", root, "--json"],
    { encoding: "utf8", cwd: root, windowsHide: true },
  );
  assert.equal(packed.status, 0, packed.stderr || packed.stdout);
  const archive = path.join(root, JSON.parse(packed.stdout)[0].filename);
  const installed = spawnSync(
    process.execPath,
    [npmCli, "install", "--global", archive, "--prefix", prefix],
    { encoding: "utf8", env: environment, windowsHide: true },
  );
  assert.equal(installed.status, 0, installed.stderr || installed.stdout);

  // `avenic --version` reports the package's own metadata, not a constant.
  const version = avenic(["--version"], environment).stdout.trim();
  assert.equal(version, `Avenic ${cliMetadata.version}`, "version must come from package.json");

  // Set up the project the way the wizard would, non-interactively.
  const initialized = avenic(["init", "--agents", "claude,codex", "--auth", "account", "--scope", "global", "--sessions", "project", "--history", "shared"], environment);
  const runtimeFile = path.join(projectRoot, ".agents", "runtime.json");
  const runtime = JSON.parse(await readFile(runtimeFile, "utf8"));
  assert.equal(runtime.historyMode, "shared");
  assert.deepEqual(Object.keys(runtime.agents).sort(), ["claude", "codex"]);
  // The method and the scope of *that* method: Account answers with accountScope,
  // and only the named method's scope is written.
  assert.equal(runtime.agents.claude.authMethod, "account");
  assert.equal(runtime.agents.claude.accountScope, "global");
  assert.equal(runtime.agents.claude.configScope, undefined);
  assert.equal(runtime.agents.claude.sessionScope, "project");

  const status = avenic(["status"], environment).stdout;
  // `avenic status` is one page of blocks: the section is its own line and the
  // values hang under it on the rails.
  assert.match(status, /^◇\s+History$/m);
  // The value is the Dashboard's own word, capitalised: the status page and the
  // card name the same two modes the same way.
  assert.match(status, /^│\s+Mode\s+Shared$/m);
  assert.match(status, /^◇\s+Agents$/m);
  assert.match(status, /Claude/);
  assert.match(status, /Codex/);

  // A plain launch in Shared mode: the agent runs, and what it wrote is in the
  // project's shared history by the time the command returns.
  const claudeSession = "11111111-2222-3333-4444-000000000001";
  const claudeEvents = path.join(projectRoot, ".agents", "sessions", "canonical", `claude-${claudeSession}`, "events.jsonl");
  // A launch hands its environment to a detached watchdog through a file in the
  // temp directory, and that file outlives the command. The variable that pays
  // for the agent travels with the launch and must not travel into it.
  const launchSecret = `sk-ant-smoke-${process.pid}-0000000000000000`;
  const launched = avenic(["claude"], {
    ...environment,
    AVENIC_SMOKE_SESSION: claudeSession,
    ANTHROPIC_AUTH_TOKEN: launchSecret,
  });
  assert.match(launched.stdout, /claude-stub/, "the official agent's stdio must reach the user");
  const launchState = await launchStateFiles();
  assert.ok(launchState.length > 0, "the launch leaves state behind for the credential scan to be meaningful");
  const leaked = [];
  for (const file of launchState) {
    if ((await readFile(file, "utf8").catch(() => "")).includes(launchSecret)) leaked.push(file);
  }
  assert.deepEqual(leaked, [], `launch state must not carry the launch's credentials: ${leaked.join(", ")}`);
  const events = (await readFile(claudeEvents, "utf8")).split("\n").filter(Boolean);
  assert.ok(events.length >= 4, `shared history must hold the run's events, got ${events.length}`);

  const listed = avenic(["sessions", "list"], environment).stdout;
  assert.match(listed, new RegExp(`claude-${claudeSession}`));
  // The status page names the agent's own session under the canonical one and
  // says whether its cursor has caught up with the shared history.
  const sessionStatus = avenic(["sessions", "status"], environment).stdout;
  assert.match(sessionStatus, new RegExp(`^│\\s+Claude\\s+${claudeSession}\\s+current`, "m"), sessionStatus);

  // Isolated: each agent keeps its own history, and the shared workspace is
  // left alone until the user asks for it.
  avenic(["change", "--auth", "account", "--scope", "project", "--sessions", "project", "--history", "isolated"], environment);
  const isolated = JSON.parse(await readFile(runtimeFile, "utf8"));
  assert.equal(isolated.historyMode, "isolated");
  assert.equal(isolated.agents.claude.authMethod, "account");
  assert.equal(isolated.agents.claude.accountScope, "project");
  assert.equal(isolated.agents.claude.sessionScope, "project");

  const codexSession = "22222222-3333-4444-5555-000000000002";
  const codexLaunch = avenic(["codex"], { ...environment, AVENIC_SMOKE_SESSION: codexSession });
  assert.match(codexLaunch.stdout, /codex-stub/);
  const portable = await listTree(path.join(projectRoot, ".agents", "sessions", "codex"));
  assert.equal(portable.length, 1, `an isolated run must keep its own history, found ${portable.length} file(s)`);
  assert.match(portable[0], new RegExp(`rollout-${codexSession}\\.jsonl$`));
  assert.equal(
    existsSync(path.join(projectRoot, ".agents", "sessions", "canonical", `codex-${codexSession}`)),
    false,
    "an isolated run must not write the shared workspace",
  );
  // Importing the isolated histories is the user asking for it, so this is
  // where the shared workspace gets the codex run.
  assert.match(avenic(["sessions", "sync"], environment).stdout, /Synced \d+ native session\(s\)\./);
  assert.equal(existsSync(path.join(projectRoot, ".agents", "sessions", "canonical", `codex-${codexSession}`, "session.json")), true);

  // Switching to Shared later keeps the histories side by side — nothing is
  // concatenated into one transcript.
  avenic(["change", "--history", "shared"], environment);
  const shared = (await listTree(path.join(projectRoot, ".agents", "sessions", "canonical"))).filter((file) => file.endsWith("session.json"));
  assert.equal(shared.length, 2, `each agent's history must stay its own session, found ${shared.length}`);
  const switched = avenic(["sessions", "list"], environment).stdout;
  assert.match(switched, new RegExp(`claude-${claudeSession}`));
  assert.match(switched, new RegExp(`codex-${codexSession}`));

  await verifyHub(environment);
  await verifySelfUpdate(environment);
  console.log("Release smoke passed: tarball install, init, launch, sessions, change, Shared/Isolated, Hub, self-update");
}

// A Hub is a git repository with a skills tree, its Packs and a source lock.
// Syncing it is the one path that talks to git with the user's own credentials
// — Avenic creates no tokens of its own — so the artifact is exercised against
// a real repository, and against one that is not there.
async function verifyHub(environment) {
  const hub = path.join(root, "hub");
  await mkdir(path.join(hub, "skills", "demo"), { recursive: true });
  await mkdir(path.join(hub, "packs"), { recursive: true });
  await writeFile(path.join(hub, "skills", "demo", "SKILL.md"), "---\nname: demo\n---\nv1\n");
  await writeFile(path.join(hub, "packs", "common.json"), `${JSON.stringify({ schemaVersion: 1, id: "common", name: "Common", sources: [{ source: "demo", skills: ["demo"] }] })}\n`);
  await writeFile(path.join(hub, "sources.lock.json"), `${JSON.stringify({ schemaVersion: 1, sources: [] })}\n`);
  for (const argumentsList of [["init", "--quiet", "-b", "main"], ["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "--quiet", "-m", "one"]]) {
    const result = spawnSync("git", ["-C", hub, ...argumentsList], { encoding: "utf8", windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  }

  const added = avenic(["hub", "add", hub], environment);
  assert.match(added.stdout, /Default Hub:/);
  assert.match(added.stdout, /Packs · 1/);
  const synced = avenic(["hub", "sync"], environment);
  assert.match(synced.stdout, /Syncing /);
  assert.match(synced.stdout, /Synced · [0-9a-f]{7} · \d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
  assert.match(avenic(["hub", "list"], environment).stdout, /Registered Hubs/);

  // `avenic status` is the one place a user looks to see all of it at once, so
  // the artifact is checked while the Hub is really cached: the block has to
  // name the revision it just fetched, and the same model has to come back as
  // JSON for hosts that draw it themselves.
  const status = avenic(["status"], environment).stdout;
  assert.match(status, /Skills/);
  assert.match(status, /Hub\s+\S+ · current · [0-9a-f]{7}/, `status must report the cached Hub revision:\n${status}`);
  const model = JSON.parse(avenic(["status", "--json"], environment).stdout);
  assert.equal(model.schemaVersion, 1);
  assert.equal(model.skills.hub.cache, "current");
  assert.match(model.skills.hub.revision, /^[0-9a-f]{40}$/);
  assert.deepEqual(model.agents.map((agent) => agent.id), ["claude", "codex", "opencode"]);

  // A Hub that is not there must name the missing repository. "Check your
  // authentication" is the advice that sends users down the wrong path.
  avenic(["hub", "add", path.join(root, "no-such-hub")], environment);
  const missing = avenic(["hub", "sync"], environment, { allowFailure: true });
  assert.notEqual(missing.status, 0, "syncing a Hub that is not there must fail");
  assert.match(`${missing.stdout}${missing.stderr}`, /Hub repository was not found/);
}

// self-update is verified against a stub npm and a stub `avenic` on PATH, so
// the three outcomes are all reachable without reinstalling anything real:
// already current, updated, and updated-but-PATH-still-points-at-the-old-one.
async function verifySelfUpdate(environment) {
  const spec = cliMetadata.avenic.packageSpec;
  const scripts = path.join(root, "self-update");

  const stubNpm = async (directory, { latest, installedVersion = null }) => {
    await writeExecutable(directory, "npm", `import { appendFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(path.join(scripts, "npm.log"))}, \`\${args.join(" ")}\\n\`);
if (args[0] === "view") { process.stdout.write(${JSON.stringify(`${JSON.stringify(latest)}\n`)}); process.exit(0); }
if (args[0] === "install") {
  ${installedVersion === null ? "" : `writeFileSync(${JSON.stringify(path.join(scripts, "active-version"))}, ${JSON.stringify(installedVersion)});`}
  process.exit(0);
}
process.exit(0);
`);
  };

  const stubAvenic = async (directory, version) => {
    await writeExecutable(directory, "avenic", `import { readFileSync } from "node:fs";
const file = ${JSON.stringify(path.join(scripts, "active-version"))};
const value = ${version === null ? `readFileSync(file, "utf8").trim()` : JSON.stringify(version)};
process.stdout.write(\`Avenic \${value}\\n\`);
process.exit(0);
`);
  };

  const withPath = (...directories) => ({
    ...environment,
    PATH: [...directories, bin, binDirectory, inheritedPath].join(path.delimiter),
    Path: [...directories, bin, binDirectory, inheritedPath].join(path.delimiter),
  });

  // 1. Registry says the version the PATH already resolves to: report, do not install.
  await mkdir(scripts, { recursive: true });
  const currentNpm = path.join(scripts, "npm-current");
  await stubNpm(currentNpm, { latest: cliMetadata.version });
  await writeFile(path.join(scripts, "npm.log"), "");
  const upToDate = avenic(["self-update"], withPath(currentNpm));
  assert.match(upToDate.stdout, new RegExp(`Current: ${cliMetadata.version}`));
  assert.match(upToDate.stdout, new RegExp(`Latest: {2}${cliMetadata.version}`));
  assert.match(upToDate.stdout, new RegExp(`Source: {2}${spec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(upToDate.stdout, /already up to date/);
  const calls = (await readFile(path.join(scripts, "npm.log"), "utf8")).trim().split("\n");
  assert.deepEqual(calls, [`view ${spec} version --json`], "an up-to-date Avenic must not reinstall itself");

  // 2. A newer version exists: install, then confirm PATH runs the new one.
  const updateNpm = path.join(scripts, "npm-update");
  const stub = path.join(scripts, "avenic-stub");
  await writeFile(path.join(scripts, "active-version"), `${cliMetadata.version}\n`);
  await stubNpm(updateNpm, { latest: "9.9.9", installedVersion: "9.9.9\n" });
  await stubAvenic(stub, null);
  const updated = avenic(["self-update"], withPath(stub, updateNpm));
  assert.match(updated.stdout, new RegExp(`Current: ${cliMetadata.version}`));
  assert.match(updated.stdout, /Latest: {2}9\.9\.9/);
  assert.match(updated.stdout, /Updated Avenic: [\d.]+ → 9\.9\.9/);

  // 3. npm claims success but PATH still runs the old version: fail loudly
  //    rather than telling the user they are updated.
  const stale = path.join(scripts, "avenic-stale");
  await stubAvenic(stale, cliMetadata.version);
  const failed = avenic(["self-update"], withPath(stale, updateNpm), { allowFailure: true });
  assert.notEqual(failed.status, 0, "a self-update that did not take effect must not exit 0");
  assert.match(`${failed.stdout}${failed.stderr}`, /update verification failed/);
}

try {
  assert.ok(npmCli, "npm_execpath is required; run with npm run test:release");
  await main();
} finally {
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
}
