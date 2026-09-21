import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { withClaudeProject, removeTree } from "./helpers/session-fixture.mjs";
import { fillApiConfiguration } from "./helpers/api-fixture.mjs";

// A launch reads the credentials a developer's shell exports, and an agent needs
// them — but nothing Avenic writes down does. The unit tests pin the narrowing
// (`durableEnvironment`); this file pins the outcome for whole realistic
// sessions: initialize, launch, capture, switch, bind a model, report,
// self-update, then read every byte Avenic left behind and refuse to pass if any
// of it holds a credential outside the files that are kept out of git.
//
// A scan proves nothing on its own, so the same runs also assert that the scan
// really read the artifacts that have historically been the leak site (the
// launch state in TEMP, the project's `.agents` tree, the machine state dir),
// that the protected files really do carry the key, and — in a case of its own —
// that the scanner finds a marker wherever one is written.
//
// Every value below is a fiction. A test that used a real token would put it in
// the CI log the first time it failed.

const SECRETS = {
  ANTHROPIC_AUTH_TOKEN: "sk-ant-FIXTURE-NOT-REAL-0001",
  ANTHROPIC_API_KEY: "sk-ant-api-FIXTURE-NOT-REAL-0002",
  OPENAI_API_KEY: "sk-openai-FIXTURE-NOT-REAL-0003",
  DEEPSEEK_API_KEY: "sk-deepseek-FIXTURE-NOT-REAL-0004",
  GITHUB_TOKEN: "ghp_FIXTURE0000000000000000000000000000",
  GH_TOKEN: "gho_FIXTURE0000000000000000000000000000",
  ANYPROVIDER_AUTH_HEADER: "Bearer FIXTURE-NOT-REAL-0005",
  ANYPROVIDER_AUTHORIZATION: "Bearer FIXTURE-NOT-REAL-0006",
};

async function walk(directory, found) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return;
    // Anything else is a tree this scan cannot see. Reporting it is the point:
    // swallowing it here would turn an unread directory into a silent pass.
    throw error;
  }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(full, found);
    else if (entry.isFile()) found.push(full);
  }
}

// A detached watchdog may still be holding a file when the scan reaches it.
async function readBytes(file) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await readFile(file);
    } catch (error) {
      if (attempt >= 5 || !["EBUSY", "EPERM", "EACCES"].includes(error.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
    }
  }
}

// Byte-wise on purpose: a credential in a binary file is the same leak as one in
// JSON, and a scan that split on lines would miss a marker without a newline.
async function scanForMarkers(roots) {
  const files = [];
  for (const root of roots) await walk(root, files);
  const leaks = [];
  for (const file of files) {
    const bytes = await readBytes(file);
    for (const [name, value] of Object.entries(SECRETS)) {
      if (bytes.includes(Buffer.from(value, "utf8"))) {
        // The variable's name, never its value: a failure message ends up in a
        // log, and a report that quotes a credential repeats the leak it reports.
        leaks.push({ file, name });
      }
    }
  }
  return { files, leaks };
}

const leakedPaths = (leaks) => leaks.map(({ file, name }) => `${file} (${name})`);

// A scan describes one moment, and a run writes in phases: a file that held a
// credential and was removed by a later phase would pass a single scan taken at
// the end. So every phase is scanned, and the failure names the phase as well
// as the files.
async function assertNoLeaks(roots, phase) {
  const { files, leaks } = await scanForMarkers(roots);
  assert.deepEqual(leakedPaths(leaks), [], `${phase} left an artifact holding a credential the environment carried`);
  return files;
}

// Every command in one of these flows runs with the same environment, and every
// one of them must keep credentials out of what it prints as well as out of what
// it writes: a key echoed to a terminal is a key in a scroll buffer, in a CI log
// and in a screenshot.
function runner(fixture, environment) {
  return (label, argumentsList) => {
    const result = fixture.runCli(argumentsList, environment);
    const printed = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    for (const [name, value] of Object.entries(SECRETS)) {
      assert.equal(printed.includes(value), false, `${label} printed ${name}`);
    }
    return result;
  };
}

// A launch leaves a detached durability watch behind. Let it notice that the
// launch finished before a tree is read, so the scan sees the state a run left
// rather than a file another process is still appending to.
async function settleWatches(auditRoot) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const pending = (await readdir(auditRoot)).filter((name) => name.startsWith("avenic-launch-"));
    if (pending.every((name) => !existsSync(path.join(auditRoot, name, "pids")))) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

test("the scan reads what it walks, and finds a marker wherever it is written", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-marker-scan-"));
  try {
    await mkdir(path.join(root, "nested"), { recursive: true });
    const planted = path.join(root, "nested", "planted.json");
    await writeFile(planted, `${JSON.stringify({ ANTHROPIC_AUTH_TOKEN: SECRETS.ANTHROPIC_AUTH_TOKEN })}\n`);
    // No newline around the marker, and NUL bytes beside it: the scan is a
    // substring search over bytes, so both shapes are found.
    const binary = path.join(root, "container.bin");
    await writeFile(binary, Buffer.concat([Buffer.from([0, 1, 0]), Buffer.from(SECRETS.GH_TOKEN), Buffer.from([0])]));

    const absent = await scanForMarkers([path.join(root, "missing")]);
    assert.deepEqual(absent.files, [], "an absent root contributes nothing and does not throw");

    const scanned = await scanForMarkers([root]);
    assert.deepEqual(scanned.files.sort(), [binary, planted].sort());
    assert.deepEqual(scanned.leaks, [
      { file: binary, name: "GH_TOKEN" },
      { file: planted, name: "ANTHROPIC_AUTH_TOKEN" },
    ].sort((left, right) => left.file.localeCompare(right.file)));
  } finally {
    await removeTree(root);
  }
});

// An npm that only records what it was asked to do. A self-update reaches the
// package manager through argv and never through the environment, and the
// recorded arguments are what prove it: a spec built out of a shell token would
// show up here before it ever reached a network.
async function writeFakeNpm(binDirectory, logFile) {
  await mkdir(binDirectory, { recursive: true });
  if (process.platform === "win32") {
    await writeFile(path.join(binDirectory, "npm.cmd"), `@echo off\r\necho %* >> "${logFile}"\r\nexit /b 0\r\n`);
    return;
  }
  const script = path.join(binDirectory, "npm");
  await writeFile(script, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${logFile}"\nexit 0\n`);
  await chmod(script, 0o755);
}

test("a session run with credentials in the environment leaves them in none of its artifacts", async () => {
  // The launch state and any package manager's staging both land in the OS temp
  // directory, so the run is given a temp directory of its own. Without that,
  // "no credential in TEMP" would be a claim about a directory full of other
  // people's files.
  const auditRoot = await mkdtemp(path.join(os.tmpdir(), "avenic-secrets-temp-"));
  try {
    await withClaudeProject(async (fixture) => {
      const { projectRoot, home, root, sessionIds, canonicalDirectory } = fixture;
      const npmLog = path.join(auditRoot, "npm.log");
      await writeFakeNpm(path.join(auditRoot, "bin"), npmLog);
      const environment = {
        ...SECRETS,
        TEMP: auditRoot,
        TMP: auditRoot,
        TMPDIR: auditRoot,
        PATH: `${path.join(auditRoot, "bin")}${path.delimiter}${fixture.environment.PATH}`,
        Path: `${path.join(auditRoot, "bin")}${path.delimiter}${fixture.environment.Path}`,
      };
      const run = runner(fixture, environment);
      // Everything the run may write: the project, the fake HOME, the fixture
      // root around it, and the private TEMP.
      const roots = [projectRoot, home, root, auditRoot];
      const relative = (file) => path.relative(projectRoot, file).split(path.sep).join("/");

      // One project, three agents, one shared history. OpenCode answers for its
      // own authentication and provider, so the method flag belongs to the two
      // agents that have one — asking OpenCode for it is refused, loudly.
      for (const agentId of ["claude", "codex", "opencode"]) {
        const answers = agentId === "opencode" ? [agentId, "init"] : [agentId, "init", "--auth", "account"];
        const initialized = run(`${agentId} init`, answers);
        assert.equal(initialized.status, 0, initialized.stderr);
      }
      const shared = run("change", ["change", "--history", "shared"]);
      assert.equal(shared.status, 0, shared.stderr);
      await assertNoLeaks(roots, "initializing three agents");

      // A launch: the run captures its own agent's sessions, keeps a durability
      // watch in TEMP while it runs, and puts native storage back on exit.
      const launched = run("claude launch", ["claude"]);
      assert.equal(launched.status, 0, launched.stderr);
      // The project's copy of the session is asserted here, where the capture
      // produced it. It is not asserted at the end: a later capture mirrors
      // native storage, and a project-scoped launch leaves that storage as it
      // found it, so this file can be gone again — a session-recovery question,
      // not a credentials one. What has to hold at every moment is the scan.
      const portableSession = `.agents/sessions/claude/${sessionIds[0]}.jsonl`;
      assert.equal(existsSync(path.join(projectRoot, ...portableSession.split("/"))), true, `the launch must have captured ${portableSession}`);
      assert.ok((await assertNoLeaks(roots, "a claude launch")).some((file) => relative(file) === portableSession), `the scan must have read ${portableSession}`);

      const canonicalId = `claude-${sessionIds[0]}`;
      const sessions = run("sessions sync", ["sessions", "sync"]);
      assert.equal(sessions.status, 0, sessions.stderr);

      // A switch: the shared conversation is projected into Claude's own
      // session, which is the write that carries canonical turns back to a
      // native store.
      const switched = run("sessions continue", ["sessions", "continue", canonicalId, "--agent", "claude"]);
      assert.equal(switched.status, 0, switched.stderr);
      await assertNoLeaks(roots, "a shared session switch");

      // Project-scoped authentication puts an agent's configuration inside the
      // project, which is the one place a native store and the project tree are
      // the same tree — so it is where a credential copied out of the
      // environment would be most likely to survive.
      const scoped = run("claude auth project", ["claude", "auth", "account", "--scope", "project"]);
      assert.equal(scoped.status, 0, scoped.stderr);
      const scopedLaunch = run("claude launch (project auth)", ["claude"]);
      assert.equal(scopedLaunch.status, 0, scopedLaunch.stderr);
      await assertNoLeaks(roots, "a project-scoped claude launch");

      const codexLaunch = run("codex launch", ["codex", "resume"]);
      assert.equal(codexLaunch.status, 0, codexLaunch.stderr);
      const opencodeLaunch = run("opencode launch", ["opencode"]);
      assert.equal(opencodeLaunch.status, 0, opencodeLaunch.stderr);
      await assertNoLeaks(roots, "codex and opencode launches");

      // Report the project, both ways a host reads it.
      const status = run("status", ["status"]);
      assert.equal(status.status, 0, status.stderr);
      const json = run("status --json", ["status", "--json"]);
      assert.equal(json.status, 0, json.stderr);
      assert.equal(JSON.parse(json.stdout).schemaVersion, 1);

      // Self-update stays offline: the fake npm answers, and the arguments it
      // recorded are the whole of what the package manager was told.
      const update = run("self-update", ["self-update"]);
      assert.equal(update.status, 1, "an offline registry query has to fail loudly");
      assert.match(`${update.stdout}${update.stderr}`, /Unable to query npm registry/);
      assert.match(await readFile(npmLog, "utf8"), /^view /m, "the fake npm must have been reached");

      await settleWatches(auditRoot);
      const files = await assertNoLeaks(roots, "the whole run");

      // The scan is only as good as what it read. Each of these is a file the
      // flow was supposed to produce, and the launch state below — in the OS
      // temp directory — is the artifact a launch used to write a whole
      // environment into.
      const artifacts = [
        ".agents/runtime.json",
        ".agents/local/runtime.local.json",
        `.agents/sessions/canonical/${canonicalId}/session.json`,
        `.agents/sessions/canonical/${canonicalId}/events.jsonl`,
        `.agents/sessions/canonical/${canonicalId}/state.json`,
        `.agents/sessions/canonical/${canonicalId}/mappings.json`,
      ];
      for (const artifact of artifacts) {
        const file = path.join(projectRoot, ...artifact.split("/"));
        assert.equal(existsSync(file), true, `the flow must have written ${artifact}`);
        assert.ok(files.some((scanned) => relative(scanned) === artifact), `the scan must have read ${artifact}`);
      }
      assert.ok(files.length > artifacts.length, `the scan found only ${files.length} files, which cannot be the whole run`);

      const leases = (await readdir(auditRoot)).filter((name) => name.startsWith("avenic-launch-"));
      assert.ok(leases.length > 0, "a launch keeps its state in the OS temp directory");
      const launchState = path.join(auditRoot, leases[0], "watchdog.json");
      assert.equal(existsSync(launchState), true, "the launch state file is what a detached helper reads back");
      const state = JSON.parse(await readFile(launchState, "utf8"));
      assert.equal(typeof state.environment?.PATH, "string", "a detached capture still finds the agent's CLI");
      for (const name of Object.keys(SECRETS)) {
        assert.equal(Object.hasOwn(state.environment, name), false, `${name} must not be carried into the launch state by name`);
      }
    });
  } finally {
    await removeTree(auditRoot);
  }
});

test("an API configuration's credential reaches only the files the project keeps out of git", async () => {
  const auditRoot = await mkdtemp(path.join(os.tmpdir(), "avenic-secrets-temp-"));
  try {
    await withClaudeProject(async (fixture) => {
      const { projectRoot, home, root } = fixture;
      const environment = { ...SECRETS, TEMP: auditRoot, TMP: auditRoot, TMPDIR: auditRoot };
      const run = runner(fixture, environment);

      for (const agentId of ["claude", "codex"]) {
        const initialized = run(`${agentId} init (api, project)`, [agentId, "init", "--auth", "api", "--scope", "project"]);
        assert.equal(initialized.status, 0, initialized.stderr);
      }

      // The user fills the files Avenic prepared — their own key, their own
      // hand or their own tool. Claude's own project configuration carries the
      // credential; Codex's carries the *name* of the environment variable that
      // holds its key, which is what a Codex configuration takes and is why the
      // name is not a secret. Neither file is Avenic's to write, so the only
      // thing Avenic can do with the credential is fail to copy it anywhere.
      const key = SECRETS.ANTHROPIC_AUTH_TOKEN;
      const fields = { provider: "Fixture", baseUrl: "https://fixture.invalid/v1", model: "fixture-main" };
      await fillApiConfiguration(projectRoot, "claude", "project", { ...fields, credential: key });
      await fillApiConfiguration(projectRoot, "codex", "project", { ...fields, credential: "FIXTURE_CODEX_KEY" });

      // A launch reads the configuration rather than carrying one: the key is
      // already in the agent's process environment, which is where it belongs.
      const launched = run("claude launch", ["claude"]);
      assert.equal(launched.status, 0, launched.stderr);
      const codexLaunched = run("codex launch", ["codex"]);
      assert.equal(codexLaunched.status, 0, codexLaunched.stderr);

      // Reporting is read-only, and a report says whether a credential is set —
      // never what it is.
      const status = run("status", ["status"]);
      assert.equal(status.status, 0, status.stderr);
      assert.match(status.stdout, /Agent\s+CLI\s+Auth\s+Sessions\s+History\s+Sync/);
      // The page names the file the launch reads; the machine-readable form
      // says whether a credential is in it — as a boolean, never a value.
      assert.match(status.stdout, /Claude Code: \.claude\/settings\.local\.json, Provider fixture\.invalid, Model/);
      const json = run("status --json", ["status", "--json"]);
      assert.equal(json.status, 0, json.stderr);
      const reported = JSON.parse(json.stdout).agents.find((agent) => agent.id === "claude").auth.configuration;
      assert.equal(reported.credentialSet, true);
      assert.equal(JSON.stringify(reported).includes(key), false, "a report must never carry the secret itself");

      await settleWatches(auditRoot);
      const { leaks } = await scanForMarkers([projectRoot, home, root, auditRoot]);
      // One file may hold it: the one the user filled in. Everything else — the
      // project's own `.agents` tree, the launch state in TEMP, the machine
      // state dir, the agent's home — is a leak, and the ledger is the one to
      // watch, because a record of what Avenic wrote is the natural place for a
      // copy of it to end up by accident.
      assert.deepEqual(
        leakedPaths(leaks.filter(({ file }) => file !== path.join(projectRoot, ".claude", "settings.local.json"))),
        [],
        "a credential the user wrote into their own configuration reached a file outside it",
      );
      // ...and the file the user filled in must really hold it, or the
      // assertion above would pass on a run that never had a credential at all.
      assert.ok(leaks.some(({ file }) => file === path.join(projectRoot, ".claude", "settings.local.json")),
        "the agent's own project configuration is where the credential lives");
      assert.equal(leaks.some(({ file }) => file.startsWith(path.join(projectRoot, ".agents") + path.sep)), false,
        "nothing under .agents holds a value Avenic never wrote and cannot write");
      const ledger = path.join(projectRoot, ".agents", "local", "ownership.json");
      assert.equal(existsSync(ledger), true, "the ledger exists — the leak check above is about a real file");
      assert.equal((await readFile(ledger, "utf8")).includes(key), false, "the ledger records a path and a hash, never a value");

      const ignore = await readFile(path.join(projectRoot, ".gitignore"), "utf8");
      for (const rule of [".claude/settings.local.json", ".agents/tmp/", ".agents/local/"]) {
        assert.match(ignore, new RegExp(`^${rule.replace(/\./g, "\\.")}$`, "m"), `${rule} is Avenic's own state and must never be committed`);
      }
      if (process.platform !== "win32") {
        // chmod is meaningless on Windows, where the user profile's ACL is what
        // protects a file; POSIX has to carry the restriction itself. Avenic
        // creates a configuration file owner-only and writing into it does not
        // widen it, so the file the user filled in keeps the mode it was made
        // with — which is the whole reason it is created that way.
        for (const file of [path.join(projectRoot, ".claude", "settings.local.json"), path.join(projectRoot, ".agents", "local", "codex", "config.toml")]) {
          assert.equal((await stat(file)).mode & 0o777, 0o600, `${file} is created owner-only and must not be world readable`);
        }
      }
    });
  } finally {
    await removeTree(auditRoot);
  }
});
