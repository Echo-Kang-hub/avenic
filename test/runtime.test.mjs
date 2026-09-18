import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  clearLocalAuth,
  deinitializeAgent,
  effectiveAgentConfig,
  initializeAgent,
  loadRuntime,
  projectAuthEnvironment,
  setLocalAuth,
} from "../packages/core/src/runtime/config.mjs";
import {
  REQUIRED_RULES,
  SESSIONS_RULE,
  ensureRuntimeGitignore,
  sessionsGitIgnored,
} from "../packages/core/src/runtime/gitignore.mjs";
import { agentExecutableAvailable, applyProjectConfiguration, listCanonicalSessions, spawnExecutableSync, stateRoot } from "../packages/core/src/index.mjs";
import { locateProjectRoot } from "../packages/core/src/runtime/project-root.mjs";
import * as claudeSessions from "../packages/core/src/runtime/adapters/claude.mjs";
import * as codexSessions from "../packages/core/src/runtime/adapters/codex.mjs";
import * as opencodeSessions from "../packages/core/src/runtime/adapters/opencode.mjs";
import { observeSharedNativeSessions } from "../packages/core/src/runtime/session-interop.mjs";
import { avenicPackageSpec, updateAvenic } from "../packages/cli/src/cli/self-update.mjs";
import {
  PROJECT_ROOT_TOKEN,
  acquireSessionLease,
  listFiles,
  revertFrom,
  sessionLeasePath,
  snapshotInto,
} from "../packages/core/src/runtime/sessions.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPackageRoot = path.join(packageRoot, "packages", "cli");

function runCli(projectRoot, entry, argumentsList, environment) {
  return spawnSync(process.execPath, [path.join(packageRoot, "packages", "cli", entry === "skills.mjs" ? "scripts" : "bin", entry), ...argumentsList], {
    cwd: projectRoot,
    encoding: "utf8",
    env: environment ?? process.env,
    windowsHide: true,
  });
}

async function fakeAgentBinary(projectRoot, agentId) {
  const binDirectory = path.join(projectRoot, "bin");
  await mkdir(binDirectory, { recursive: true });
  const windows = process.platform === "win32";
  // On Windows the runtime resolves executables through PowerShell for .ps1
  // shims; spawnSync cannot launch .cmd files directly (EINVAL).
  const script = windows
    ? "@\"\nCLAUDE_CONFIG_DIR=$env:CLAUDE_CONFIG_DIR\nCODEX_HOME=$env:CODEX_HOME\nXDG_CONFIG_HOME=$env:XDG_CONFIG_HOME\n\"@ | Set-Content -Path $env:OUT_FILE\n"
    : `#!/bin/sh\n{\n  echo "CLAUDE_CONFIG_DIR=$CLAUDE_CONFIG_DIR"\n  echo "CODEX_HOME=$CODEX_HOME"\n  echo "XDG_CONFIG_HOME=$XDG_CONFIG_HOME"\n} > "$OUT_FILE"\nexit 0\n`;
  const executable = path.join(binDirectory, windows ? `${agentId}.ps1` : agentId);
  await writeFile(executable, script);
  if (!windows) {
    const { chmod } = await import("node:fs/promises");
    await chmod(executable, 0o755);
  }
  return binDirectory;
}

// Like fakeAgentBinary, but the agent writes a session record into its native
// storage during the run, so the launch flow's capture and revert can be
// observed end to end.
async function fakeAgentWritesSession(projectRoot, agentId) {
  const binDirectory = path.join(projectRoot, "bin-writer");
  await mkdir(binDirectory, { recursive: true });
  const windows = process.platform === "win32";
  const script = windows
    ? "$dir = Join-Path $env:CODEX_HOME 'sessions\\fake'\nNew-Item -ItemType Directory -Force -Path $dir | Out-Null\n$cwd = $env:PROJECT_ROOT -replace '\\\\', '/'\n$line = '{\"type\":\"session_meta\",\"payload\":{\"id\":\"sess-new\",\"cwd\":\"' + $cwd + '\"}}'\nSet-Content -Path (Join-Path $dir 'session.jsonl') -Value $line\n"
    : `#!/bin/sh\nmkdir -p "$CODEX_HOME/sessions/fake"\nprintf '{"type":"session_meta","payload":{"id":"sess-new","cwd":"%s"}}\\n' "$PROJECT_ROOT" > "$CODEX_HOME/sessions/fake/session.jsonl"\nexit 0\n`;
  const executable = path.join(binDirectory, windows ? `${agentId}.ps1` : agentId);
  await writeFile(executable, script);
  if (!windows) {
    const { chmod } = await import("node:fs/promises");
    await chmod(executable, 0o755);
  }
  return binDirectory;
}

async function withTempProject(run) {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "agent-runtime-test-"));
  try {
    await run(projectRoot);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
}

test("initialization is incremental and idempotent", async () => {
  await withTempProject(async (projectRoot) => {
    await initializeAgent(projectRoot, "claude", "project");
    await initializeAgent(projectRoot, "codex", "global");
    const repeated = await initializeAgent(projectRoot, "claude");
    const state = await loadRuntime(projectRoot);

    assert.equal(repeated.configChanged, false);
    assert.equal(state.runtime.agents.claude.auth, "project");
    assert.equal(state.runtime.agents.codex.auth, "global");
    assert.equal(state.runtime.agents.claude.sessions, "project");
    assert.equal(existsSync(path.join(projectRoot, ".agents", "local", "claude")), true);
    assert.equal(existsSync(path.join(projectRoot, ".agents", "local", "codex")), false);
  });
});

test("applyProjectConfiguration owns same-mode project configuration", async () => {
  await withTempProject(async (projectRoot) => {
    const result = await applyProjectConfiguration(projectRoot, {
      agents: { codex: { auth: "global", sessions: "project" } },
      sessionInterop: "isolated",
    });
    assert.equal(result.previous, "shared");
    assert.equal(result.mode, "isolated");
    const repeated = await applyProjectConfiguration(projectRoot, {
      agents: { codex: { auth: "project", sessions: "project" } },
      sessionInterop: "isolated",
    });
    assert.deepEqual(repeated.imported, []);
    assert.equal((await loadRuntime(projectRoot)).runtime.agents.codex.auth, "project");
  });
});

test("local authentication overrides project defaults", async () => {
  await withTempProject(async (projectRoot) => {
    await initializeAgent(projectRoot, "claude", "global");
    await setLocalAuth(projectRoot, "claude", "project");
    const state = await loadRuntime(projectRoot);
    const effective = effectiveAgentConfig(state, "claude");

    assert.equal(effective.configuredAuth, "global");
    assert.equal(effective.localAuth, "project");
    assert.equal(effective.auth, "project");

    const reset = await clearLocalAuth(projectRoot, "claude");
    assert.equal(reset.localAuth, null);
    assert.equal(reset.auth, "global");
  });
});

test("global initialization does not create a credential directory", async () => {
  await withTempProject(async (projectRoot) => {
    await initializeAgent(projectRoot, "codex", "global");
    assert.equal(existsSync(path.join(projectRoot, ".agents", "local")), false);
    assert.equal(existsSync(path.join(projectRoot, ".agents", "sessions", "codex")), true);
  });
});

test("deinitialization is reversible and purge is explicit", async () => {
  await withTempProject(async (projectRoot) => {
    await initializeAgent(projectRoot, "codex", "project");
    const sessionFile = path.join(projectRoot, ".agents", "sessions", "codex", "session.jsonl");
    const credentialFile = path.join(projectRoot, ".agents", "local", "codex", "auth.json");
    await writeFile(sessionFile, "session\n");
    await writeFile(credentialFile, "credential\n");

    const removed = await deinitializeAgent(projectRoot, "codex");
    assert.equal(removed.changed, true);
    assert.equal(existsSync(sessionFile), true);
    assert.equal(existsSync(credentialFile), true);
    assert.equal(effectiveAgentConfig(await loadRuntime(projectRoot), "codex"), null);

    await initializeAgent(projectRoot, "codex", "project");
    const purged = await deinitializeAgent(projectRoot, "codex", { purge: true });
    assert.equal(purged.purged, true);
    assert.equal(existsSync(path.dirname(sessionFile)), false);
    assert.equal(existsSync(path.dirname(credentialFile)), false);
    const gitignore = await readFile(path.join(projectRoot, ".gitignore"), "utf8");
    assert.doesNotMatch(gitignore, /\.agents\/local\//);
    assert.doesNotMatch(gitignore, /\.agents\/tmp\//);

    const repeated = await deinitializeAgent(projectRoot, "codex", { purge: true });
    assert.equal(repeated.changed, false);
  });
});

test("gitignore rules are added once", async () => {
  await withTempProject(async (projectRoot) => {
    assert.equal(await ensureRuntimeGitignore(projectRoot), true);
    assert.equal(await ensureRuntimeGitignore(projectRoot), false);
    const content = await readFile(path.join(projectRoot, ".gitignore"), "utf8");
    for (const rule of REQUIRED_RULES) {
      assert.equal(content.split(rule).length - 1, 1);
    }
  });
});

test("session Git sync can be disabled without deleting sessions", async () => {
  await withTempProject(async (projectRoot) => {
    spawnSync("git", ["init", "--quiet"], { cwd: projectRoot });
    await initializeAgent(projectRoot, "codex", "global");
    const sessionFile = path.join(projectRoot, ".agents", "sessions", "codex", "session.jsonl");
    await writeFile(sessionFile, "session\n");
    spawnSync("git", ["add", "--force", ".agents/sessions"], { cwd: projectRoot });

    const disabled = runCli(projectRoot, "skills.mjs", ["sessions", "git", "off"]);
    assert.equal(disabled.status, 0, disabled.stderr);
    assert.equal(await sessionsGitIgnored(projectRoot), true);
    assert.equal(existsSync(sessionFile), true);
    const tracked = spawnSync("git", ["ls-files", "--", ".agents/sessions"], {
      cwd: projectRoot,
      encoding: "utf8",
    });
    assert.equal(tracked.stdout.trim(), "");
    assert.match(await readFile(path.join(projectRoot, ".gitignore"), "utf8"), new RegExp(SESSIONS_RULE.replaceAll("/", "\\/")));

    const repeated = runCli(projectRoot, "skills.mjs", ["sessions", "git", "off"]);
    assert.equal(repeated.status, 0, repeated.stderr);
    assert.match(repeated.stdout, /Git ignore Unchanged/);
  });
});

test("project root falls back to runtime markers", async () => {
  await withTempProject(async (projectRoot) => {
    await mkdir(path.join(projectRoot, "src", "nested"), { recursive: true });
    await initializeAgent(projectRoot, "opencode", "global");
    assert.equal(locateProjectRoot(path.join(projectRoot, "src", "nested")), projectRoot);
  });
});

test("project root falls back to project config markers (.avenic.json primary, legacy compat)", async () => {
  await withTempProject(async (projectRoot) => {
    await mkdir(path.join(projectRoot, "src", "nested"), { recursive: true });
    await writeFile(path.join(projectRoot, ".avenic.json"), "{}\n");
    assert.equal(locateProjectRoot(path.join(projectRoot, "src", "nested")), projectRoot);
    await rm(path.join(projectRoot, ".avenic.json"));
    await writeFile(path.join(projectRoot, ".agent-skills.json"), "{}\n");
    assert.equal(locateProjectRoot(path.join(projectRoot, "src", "nested")), projectRoot);
  });
});

test("full and short commands share one runtime configuration", async () => {
  await withTempProject(async (projectRoot) => {
    const full = runCli(projectRoot, "skills.mjs", ["claude", "init", "--auth", "global"]);
    const short = runCli(projectRoot, "skills.mjs", ["codex", "init", "--auth", "project"]);
    const status = runCli(projectRoot, "skills.mjs", ["claude", "status"]);

    assert.equal(full.status, 0, full.stderr);
    assert.equal(short.status, 0, short.stderr);
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /Claude Code/);
    const state = await loadRuntime(projectRoot);
    assert.equal(state.runtime.agents.claude.auth, "global");
    assert.equal(state.runtime.agents.codex.auth, "project");
  });
});

test("repeated init is a no-op when the project structure is intact", async () => {
  await withTempProject(async (projectRoot) => {
    const first = runCli(projectRoot, "skills.mjs", ["claude", "init", "--auth", "project"]);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /Configuration   Updated/);

    const runtimeFile = path.join(projectRoot, ".agents", "runtime.json");
    const gitignoreFile = path.join(projectRoot, ".gitignore");
    const runtimeBefore = await readFile(runtimeFile, "utf8");
    const gitignoreBefore = await readFile(gitignoreFile, "utf8");

    const second = runCli(projectRoot, "skills.mjs", ["claude", "init"]);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /Configuration   Unchanged/);
    assert.match(second.stdout, /Git ignore      Unchanged/);
    assert.match(second.stdout, /Structure       Intact/);
    assert.match(second.stdout, /Already up to date/);
    assert.equal(await readFile(runtimeFile, "utf8"), runtimeBefore);
    assert.equal(await readFile(gitignoreFile, "utf8"), gitignoreBefore);
    assert.match(second.stdout, /Authentication  project/);
    assert.match(second.stdout, /Sessions        Project/);
  });
});

test("init incrementally repairs missing directories without touching existing state", async () => {
  await withTempProject(async (projectRoot) => {
    const first = runCli(projectRoot, "skills.mjs", ["claude", "init", "--auth", "project"]);
    assert.equal(first.status, 0, first.stderr);

    const sessionsDir = path.join(projectRoot, ".agents", "sessions", "claude");
    const localDir = path.join(projectRoot, ".agents", "local", "claude");
    await rm(sessionsDir, { recursive: true, force: true });
    await rm(localDir, { recursive: true, force: true });
    assert.equal(existsSync(sessionsDir), false);
    assert.equal(existsSync(localDir), false);

    const runtimeFile = path.join(projectRoot, ".agents", "runtime.json");
    const gitignoreFile = path.join(projectRoot, ".gitignore");
    const runtimeBefore = await readFile(runtimeFile, "utf8");
    const gitignoreBefore = await readFile(gitignoreFile, "utf8");

    const repaired = runCli(projectRoot, "skills.mjs", ["claude", "init"]);
    assert.equal(repaired.status, 0, repaired.stderr);
    assert.equal(existsSync(sessionsDir), true);
    assert.equal(existsSync(localDir), true);
    assert.equal(await readFile(runtimeFile, "utf8"), runtimeBefore);
    assert.equal(await readFile(gitignoreFile, "utf8"), gitignoreBefore);
    assert.match(repaired.stdout, /Configuration   Unchanged/);
    assert.match(repaired.stdout, /Git ignore      Unchanged/);
    assert.match(repaired.stdout, /Structure       Repaired/);
    assert.doesNotMatch(repaired.stdout, /Already up to date/);
  });
});

test("init reports the created structure and how to use it", async () => {
  await withTempProject(async (projectRoot) => {
    const first = runCli(projectRoot, "skills.mjs", ["claude", "init", "--auth", "project"]);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /Changed:/);
    assert.match(first.stdout, /\.agents\/runtime\.json/);
    assert.match(first.stdout, /\.gitignore/);
    assert.match(first.stdout, /\.agents\/sessions\/claude/);
    assert.match(first.stdout, /\.agents\/local\/claude/);
    assert.match(first.stdout, /avenic claude deinit/);
    assert.doesNotMatch(first.stdout, /Already up to date/);
  });
});

test("init is fully decoupled from the catalog and network", async () => {
  await withTempProject(async (projectRoot) => {
    // Point PATH/Path at an empty directory: if init ever invoked git (or any
    // other tool) the call would fail with ENOENT, and a catalog fetch would
    // raise an SSL/authentication error. Init must never touch either.
    const emptyBin = path.join(projectRoot, "empty-bin");
    await mkdir(emptyBin);
    const environment = { ...process.env, PATH: emptyBin, Path: emptyBin };
    const init = runCli(projectRoot, "skills.mjs", ["claude", "init", "--auth", "project"], environment);
    assert.equal(init.status, 0, init.stderr);
    assert.match(init.stdout, /Changed:/);
    assert.doesNotMatch(`${init.stdout}${init.stderr}`, /catalog|Unable to fetch|git failed/i);
  });
});

test("help works from the main and agent positions", async () => {
  await withTempProject(async (projectRoot) => {
    const main = runCli(projectRoot, "skills.mjs", ["--help"]);
    assert.equal(main.status, 0, main.stderr);
    assert.match(main.stdout, /avenic <claude\|codex\|opencode> init/);
    assert.match(main.stdout, /shorthand: ave/);
    assert.match(main.stdout, /self-update/);
    const agent = runCli(projectRoot, "skills.mjs", ["claude", "--help"]);
    assert.equal(agent.status, 0, agent.stderr);
    assert.match(agent.stdout, /Per-agent commands/);
  });
});

test("Claude sessions import and restore across project paths", async () => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "agent-runtime-source-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "agent-runtime-target-"));
  const claudeHome = await mkdtemp(path.join(os.tmpdir(), "agent-runtime-claude-"));
  try {
    await initializeAgent(sourceRoot, "claude", "global");
    const sourceNative = path.join(claudeHome, "projects", claudeSessions.claudeProjectKey(sourceRoot));
    await mkdir(sourceNative, { recursive: true });
    await writeFile(
      path.join(sourceNative, "session.jsonl"),
      `${JSON.stringify({ type: "user", cwd: sourceRoot, sessionId: "session" })}\n`,
    );
    const imported = await claudeSessions.capture(sourceRoot, { environment: { CLAUDE_CONFIG_DIR: claudeHome } });
    assert.equal(imported.count, 1);

    await mkdir(path.join(targetRoot, ".agents", "sessions"), { recursive: true });
    await cp(
      path.join(sourceRoot, ".agents", "sessions", "claude"),
      path.join(targetRoot, ".agents", "sessions", "claude"),
      { recursive: true },
    );
    const restored = await claudeSessions.restore(targetRoot, { environment: { CLAUDE_CONFIG_DIR: claudeHome } });
    assert.equal(restored.added, 1);
    const restoredFile = path.join(claudeHome, "projects", claudeSessions.claudeProjectKey(targetRoot), "session.jsonl");
    assert.equal(JSON.parse((await readFile(restoredFile, "utf8")).trim()).cwd, targetRoot);
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
    await rm(claudeHome, { recursive: true, force: true });
  }
});

test("Codex sessions only import the current project", async () => {
  await withTempProject(async (projectRoot) => {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), "agent-runtime-codex-"));
    try {
      await initializeAgent(projectRoot, "codex", "global");
      const sessionRoot = path.join(codexHome, "sessions", "2026", "09", "05");
      await mkdir(sessionRoot, { recursive: true });
      await writeFile(
        path.join(sessionRoot, "matching.jsonl"),
        `${JSON.stringify({ type: "session_meta", payload: { id: "matching", cwd: projectRoot } })}\n`,
      );
      await writeFile(
        path.join(sessionRoot, "other.jsonl"),
        `${JSON.stringify({ type: "session_meta", payload: { id: "other", cwd: path.dirname(projectRoot) } })}\n`,
      );
      await writeFile(
        path.join(codexHome, "session_index.jsonl"),
        `${JSON.stringify({ id: "matching", thread_name: "Matching" })}\n${JSON.stringify({ id: "other", thread_name: "Other" })}\n`,
      );
      const result = await codexSessions.capture(projectRoot, { environment: { CODEX_HOME: codexHome } });
      assert.equal(result.count, 1);
      assert.equal((await codexSessions.status(projectRoot)).count, 1);
      const portableIndex = await readFile(path.join(projectRoot, ".agents", "sessions", "codex", "session_index.jsonl"), "utf8");
      assert.match(portableIndex, /matching/);
      assert.doesNotMatch(portableIndex, /other/);
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });
});

test("Codex sessions restore into a new project path", async () => {
  const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "agent-runtime-source-"));
  const targetRoot = await mkdtemp(path.join(os.tmpdir(), "agent-runtime-target-"));
  const sourceHome = await mkdtemp(path.join(os.tmpdir(), "agent-runtime-codex-source-"));
  const targetHome = await mkdtemp(path.join(os.tmpdir(), "agent-runtime-codex-target-"));
  try {
    const sourceSession = path.join(sourceHome, "sessions", "2026", "09", "05");
    await mkdir(sourceSession, { recursive: true });
    await writeFile(
      path.join(sourceSession, "session.jsonl"),
      `${JSON.stringify({ type: "session_meta", payload: { id: "portable", cwd: sourceRoot } })}\n`,
    );
    await codexSessions.capture(sourceRoot, { environment: { CODEX_HOME: sourceHome } });
    await mkdir(path.join(targetRoot, ".agents", "sessions"), { recursive: true });
    await cp(
      path.join(sourceRoot, ".agents", "sessions", "codex"),
      path.join(targetRoot, ".agents", "sessions", "codex"),
      { recursive: true },
    );
    const restored = await codexSessions.restore(targetRoot, { environment: { CODEX_HOME: targetHome } });
    assert.equal(restored.added, 1);
    const file = path.join(targetHome, "sessions", "2026", "09", "05", "session.jsonl");
    assert.equal(JSON.parse((await readFile(file, "utf8")).trim()).payload.cwd, targetRoot);
  } finally {
    await rm(sourceRoot, { recursive: true, force: true });
    await rm(targetRoot, { recursive: true, force: true });
    await rm(sourceHome, { recursive: true, force: true });
    await rm(targetHome, { recursive: true, force: true });
  }
});

test("Codex restore keeps portable sessions over divergent local copies", async () => {
  await withTempProject(async (projectRoot) => {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), "agent-runtime-codex-conflict-"));
    try {
      const relative = path.join("2026", "09", "05", "session.jsonl");
      const nativeFile = path.join(codexHome, "sessions", relative);
      const portableFile = path.join(projectRoot, ".agents", "sessions", "codex", "sessions", relative);
      await mkdir(path.dirname(nativeFile), { recursive: true });
      await mkdir(path.dirname(portableFile), { recursive: true });
      await writeFile(
        nativeFile,
        `${JSON.stringify({ type: "session_meta", payload: { id: "same", cwd: projectRoot } })}\nlocal\n`,
      );
      await writeFile(
        portableFile,
        `${JSON.stringify({ type: "session_meta", payload: { id: "same", cwd: PROJECT_ROOT_TOKEN } })}\nportable\n`,
      );

      const result = await codexSessions.restore(projectRoot, { environment: { CODEX_HOME: codexHome } });
      assert.equal(result.conflicts, 1);
      // The project (portable) copy wins and the native copy is overwritten.
      const nativeContent = await readFile(nativeFile, "utf8");
      assert.match(nativeContent, /portable/);
      assert.doesNotMatch(nativeContent, /local/);
      assert.equal(JSON.parse(nativeContent.split("\n", 1)[0]).payload.cwd, projectRoot);
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });
});

test("snapshot and revert restore native storage exactly", async () => {
  await withTempProject(async (projectRoot) => {
    const target = path.join(projectRoot, "native");
    const snapshotRoot = path.join(projectRoot, "snapshot");
    const file = path.join(target, "sub", "session.jsonl");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "before\n");

    await snapshotInto(target, snapshotRoot);
    await writeFile(file, "after\n");
    await writeFile(path.join(target, "sub", "new.jsonl"), "new\n");
    await revertFrom(snapshotRoot, target);
    assert.equal(await readFile(file, "utf8"), "before\n");
    assert.equal(existsSync(path.join(target, "sub", "new.jsonl")), false);

    // A path that did not exist at snapshot time stays absent after revert.
    const absent = path.join(projectRoot, "absent");
    const empty = path.join(projectRoot, "empty-snapshot");
    await snapshotInto(absent, empty);
    assert.equal(existsSync(empty), false);
    await mkdir(absent, { recursive: true });
    await revertFrom(empty, absent);
    assert.equal(existsSync(absent), false);
  });
});

test("session leases allow concurrent launches and revert on the last exit", async () => {
  await withTempProject(async (projectRoot) => {
    const events = [];
    const callbacks = {
      onFirst: (recovering) => events.push(`first:${recovering}`),
      onLast: () => events.push("last"),
    };
    const leaveFirst = (await acquireSessionLease("codex", projectRoot, callbacks)).release;
    assert.deepEqual(events, ["first:false"]);
    // A second launch of the same project+agent joins the group without a
    // new snapshot.
    const leaveSecond = (await acquireSessionLease("codex", projectRoot, callbacks)).release;
    assert.deepEqual(events, ["first:false"]);
    // Other agents have their own group.
    const leaveClaude = (await acquireSessionLease("claude", projectRoot, {
      onFirst: () => events.push("claude-first"),
      onLast: () => events.push("claude-last"),
    })).release;
    assert.deepEqual(events, ["first:false", "claude-first"]);
    await leaveClaude();
    assert.deepEqual(events, ["first:false", "claude-first", "claude-last"]);
    await leaveFirst();
    assert.deepEqual(events, ["first:false", "claude-first", "claude-last"], "not the last codex launch");
    await leaveSecond();
    assert.deepEqual(events, ["first:false", "claude-first", "claude-last", "last"]);
    assert.equal(existsSync(sessionLeasePath("codex", projectRoot)), false, "group state is removed with the last exit");
  });
});

test("session leases salvage the sessions of a crashed launch group", async () => {
  await withTempProject(async (projectRoot) => {
    // Simulate a launch group that died without exiting: the shared state
    // holds a completed snapshot and only a dead pid record.
    const stateDir = sessionLeasePath("codex", projectRoot);
    await mkdir(path.join(stateDir, "snapshot"), { recursive: true });
    await writeFile(path.join(stateDir, "snapshot", "marker"), "saved\n");
    await writeFile(path.join(stateDir, "snapshot.ok"), "");
    await mkdir(path.join(stateDir, "pids"), { recursive: true });
    await writeFile(path.join(stateDir, "pids", "2147483647"), "");
    const events = [];
    const leave = (await acquireSessionLease("codex", projectRoot, {
      onFirst: (recovering) => events.push(`first:${recovering}`),
      onLast: () => events.push("last"),
    })).release;
    assert.deepEqual(events, ["first:true"], "the next launch must see the crashed group");
    await leave();
    assert.deepEqual(events, ["first:true", "last"]);
    assert.equal(existsSync(stateDir), false);
  });
});

test("watchdog restores native storage when the launch process dies", async () => {
  await withTempProject(async (projectRoot) => {
    const codexHome = path.join(projectRoot, "codex-home");
    const watchdogScript = path.join(packageRoot, "packages", "cli", "scripts", "watchdog.mjs");
    // A fake launcher process: joins the launch group, starts the watchdog,
    // writes a native session like a real run, then dies without releasing
    // the lease (like a closed terminal).
    const launcher = `
import path from "node:path";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { acquireSessionLease, sessionLeasePath } from "${new URL("../packages/core/src/runtime/sessions.mjs", import.meta.url).href}";
import * as codex from "${new URL("../packages/core/src/runtime/adapters/codex.mjs", import.meta.url).href}";

const projectRoot = process.argv[2];
const codexHome = process.argv[3];
const environment = { CODEX_HOME: codexHome };
const snapshotRoot = path.join(sessionLeasePath("codex", projectRoot), "snapshot");
const lease = await acquireSessionLease("codex", projectRoot, {
  onFirst: async () => { await codex.snapshotNative(projectRoot, snapshotRoot, { environment }); },
  onLast: async () => { await codex.revertNative(snapshotRoot, projectRoot, { environment }); },
});

await writeFile(path.join(lease.stateDir, "watchdog.json"), JSON.stringify({
  member: lease.member,
  parentPid: process.pid,
  agentId: "codex",
  projectRoot,
  environment,
}), "utf8");
const watchdog = spawn(process.execPath, [process.argv[4], lease.stateDir], {
  detached: true,
  stdio: "ignore",
  windowsHide: true,
});
watchdog.unref();
await mkdir(path.join(codexHome, "sessions", "fake"), { recursive: true });
await writeFile(
  path.join(codexHome, "sessions", "fake", "session.jsonl"),
  \`\${JSON.stringify({ type: "session_meta", payload: { id: "sess-new", cwd: projectRoot } })}\\n\`,
);
process.exit(0);
`;
    const launcherFile = path.join(projectRoot, "launcher.mjs");
    await writeFile(launcherFile, launcher);
    const run = spawnSync(process.execPath, [launcherFile, projectRoot, codexHome, watchdogScript], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);

    // The watchdog notices the dead launcher, captures the session into the
    // project, restores native storage, and removes the group state.
    const leaseState = sessionLeasePath("codex", projectRoot);
    const deadline = Date.now() + 20000;
    while ((existsSync(path.join(codexHome, "sessions", "fake")) || existsSync(leaseState)) && Date.now() < deadline) {
      await delay(100);
    }
    const captured = path.join(projectRoot, ".agents", "sessions", "codex", "sessions", "fake", "session.jsonl");
    assert.equal(existsSync(captured), true, "watchdog must capture the interrupted session into the project");
    const canonical = path.join(projectRoot, ".agents", "sessions", "canonical", "codex-sess-new", "session.json");
    assert.equal(existsSync(canonical), true, "watchdog must commit an unmapped interrupted native session into canonical history");
    assert.equal(existsSync(path.join(codexHome, "sessions", "fake")), false, "watchdog must revert native storage");
    assert.equal(existsSync(leaseState), false, "watchdog must remove the launch group state");
  });
});

test("shared native capture commits an unmapped Codex rollout idempotently without an inventory cache", async () => {
  await withTempProject(async (projectRoot) => {
    const codexHome = path.join(projectRoot, "codex-observe-home");
    const rollout = path.join(codexHome, "sessions", "2026", "09", "18", "rollout.jsonl");
    await initializeAgent(projectRoot, "codex", "global");
    await mkdir(path.dirname(rollout), { recursive: true });
    await writeFile(rollout, `${JSON.stringify({ type: "session_meta", payload: { id: "new-rollout", cwd: projectRoot } })}\n${JSON.stringify({ timestamp: "2026-09-18T00:00:00.000Z", type: "response_item", payload: { id: "message-a", type: "message", role: "user", content: [{ type: "input_text", text: "A" }] } })}\n`);
    const environment = { CODEX_HOME: codexHome };
    const first = await observeSharedNativeSessions(projectRoot, "codex", { environment });
    const second = await observeSharedNativeSessions(projectRoot, "codex", { environment });
    assert.equal(first.imported, 1);
    assert.equal(second.imported, 0);
    assert.deepEqual((await listCanonicalSessions(projectRoot)).map((session) => session.id), ["codex-new-rollout"]);
    assert.equal(existsSync(path.join(projectRoot, ".agents", "sessions", "native-inventory.json")), false);
  });
});

test("Claude native snapshot and revert restore the pre-launch state", async () => {
  await withTempProject(async (projectRoot) => {
    const claudeHome = await mkdtemp(path.join(os.tmpdir(), "agent-runtime-claude-snap-"));
    try {
      const environment = { CLAUDE_CONFIG_DIR: claudeHome };
      const native = path.join(claudeHome, "projects", claudeSessions.claudeProjectKey(projectRoot));
      const snapshotRoot = path.join(projectRoot, "snapshot");
      const sessionFile = path.join(native, "session.jsonl");
      await mkdir(native, { recursive: true });
      await writeFile(sessionFile, "global\n");

      await claudeSessions.snapshotNative(projectRoot, snapshotRoot, { environment });
      await writeFile(sessionFile, "project\n");
      await writeFile(path.join(native, "new.jsonl"), "new\n");
      await claudeSessions.revertNative(snapshotRoot, projectRoot, { environment });

      assert.equal(await readFile(sessionFile, "utf8"), "global\n");
      assert.equal(existsSync(path.join(native, "new.jsonl")), false);

      // When the native directory did not exist at snapshot time it stays
      // absent after revert.
      await claudeSessions.revertNative(path.join(projectRoot, "empty-snapshot"), projectRoot, { environment });
      assert.equal(existsSync(native), false);
    } finally {
      await rm(claudeHome, { recursive: true, force: true });
    }
  });
});

test("Codex native snapshot and revert cover sessions and the index", async () => {
  await withTempProject(async (projectRoot) => {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), "agent-runtime-codex-snap-"));
    try {
      const environment = { CODEX_HOME: codexHome };
      const snapshotRoot = path.join(projectRoot, "snapshot");
      const sessionDir = path.join(codexHome, "sessions", "2026", "09", "06");
      const sessionFile = path.join(sessionDir, "rollout-1.jsonl");
      const indexFile = path.join(codexHome, "session_index.jsonl");
      await mkdir(sessionDir, { recursive: true });
      await writeFile(sessionFile, "global\n");
      await writeFile(indexFile, `${JSON.stringify({ id: "sess-1" })}\n`);

      await codexSessions.snapshotNative(projectRoot, snapshotRoot, { environment });
      await writeFile(sessionFile, "project\n");
      await writeFile(path.join(sessionDir, "new.jsonl"), "new\n");
      await writeFile(indexFile, `${JSON.stringify({ id: "sess-1" })}\n${JSON.stringify({ id: "sess-new" })}\n`);
      await codexSessions.revertNative(snapshotRoot, projectRoot, { environment });

      assert.equal(await readFile(sessionFile, "utf8"), "global\n");
      assert.equal(existsSync(path.join(sessionDir, "new.jsonl")), false);
      assert.equal(await readFile(indexFile, "utf8"), `${JSON.stringify({ id: "sess-1" })}\n`);

      // Absent storage at snapshot time stays absent after revert.
      await codexSessions.revertNative(path.join(projectRoot, "empty-snapshot"), projectRoot, { environment });
      assert.equal(existsSync(sessionDir), false);
      assert.equal(existsSync(indexFile), false);
    } finally {
      await rm(codexHome, { recursive: true, force: true });
    }
  });
});

test("OpenCode uses native export and imports each portable version once", async () => {
  await withTempProject(async (projectRoot) => {
    const calls = [];
    const spawn = (_command, argumentsList) => {
      calls.push(argumentsList);
      if (argumentsList[0] === "session") {
        return { status: 0, stdout: JSON.stringify([{ id: "session", directory: projectRoot }]), stderr: "" };
      }
      if (argumentsList[0] === "export") {
        return { status: 0, stdout: JSON.stringify({ info: { id: "session" }, messages: [] }), stderr: "" };
      }
      return { status: 0, stdout: "Imported session: session\n", stderr: "" };
    };
    await opencodeSessions.capture(projectRoot, { spawn });
    const first = await opencodeSessions.restore(projectRoot, { spawn });
    const second = await opencodeSessions.restore(projectRoot, { spawn });
    assert.equal(first.added, 1);
    assert.equal(second.unchanged, 1);
    assert.equal(calls.filter((argumentsList) => argumentsList[0] === "import").length, 1);
  });
});

test("sessions location is selectable per agent", async () => {
  await withTempProject(async (projectRoot) => {
    await initializeAgent(projectRoot, "codex", "global", "global");
    assert.equal((await loadRuntime(projectRoot)).runtime.agents.codex.sessions, "global");
    await initializeAgent(projectRoot, "codex", undefined, "project");
    assert.equal((await loadRuntime(projectRoot)).runtime.agents.codex.sessions, "project");
    await assert.rejects(
      initializeAgent(projectRoot, "codex", undefined, "machine"),
      /Sessions must be global or project/,
    );
  });
});

test("project auth maps each agent to a project-local config home", async () => {
  await withTempProject(async (projectRoot) => {
    const local = path.join(projectRoot, ".agents", "local");
    assert.deepEqual(projectAuthEnvironment("claude", projectRoot), { CLAUDE_CONFIG_DIR: path.join(local, "claude") });
    assert.deepEqual(projectAuthEnvironment("codex", projectRoot), { CODEX_HOME: path.join(local, "codex") });
    assert.deepEqual(projectAuthEnvironment("opencode", projectRoot), { XDG_CONFIG_HOME: path.join(local, "opencode") });
  });
});

test("project auth launches the agent with a project-scoped config home", async () => {
  await withTempProject(async (projectRoot) => {
    const binDirectory = await fakeAgentBinary(projectRoot, "claude");
    const outFile = path.join(projectRoot, "launch.txt");
    const environment = {
      ...process.env,
      PATH: `${binDirectory}${path.delimiter}${process.env.PATH}`,
      OUT_FILE: outFile,
    };
    const initialized = runCli(projectRoot, "skills.mjs", ["claude", "init", "--auth", "project"], environment);
    assert.equal(initialized.status, 0, initialized.stderr);
    const launched = runCli(projectRoot, "skills.mjs", ["claude", "-p", "hello"], environment);
    assert.equal(launched.status, 0, launched.stderr);
    const output = await readFile(outFile, "utf8");
    const expected = path.join(projectRoot, ".agents", "local", "claude");
    assert.match(output, new RegExp(`CLAUDE_CONFIG_DIR=${expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  });
});

test("global sessions leave native storage untouched on launch", async () => {
  await withTempProject(async (projectRoot) => {
    const binDirectory = await fakeAgentBinary(projectRoot, "codex");
    const codexHome = path.join(projectRoot, "codex-home");
    const sessionDirectory = path.join(codexHome, "sessions", "2026", "09", "06");
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(
      path.join(sessionDirectory, "rollout-1.jsonl"),
      `${JSON.stringify({ type: "session_meta", payload: { id: "sess-1", cwd: projectRoot } })}\n`,
    );
    const environment = {
      ...process.env,
      PATH: `${binDirectory}${path.delimiter}${process.env.PATH}`,
      CODEX_HOME: codexHome,
      OUT_FILE: path.join(projectRoot, "launch.txt"),
    };
    const initialized = runCli(projectRoot, "skills.mjs", ["codex", "init", "--sessions", "global"], environment);
    assert.equal(initialized.status, 0, initialized.stderr);
    const launched = runCli(projectRoot, "skills.mjs", ["codex", "exec"], environment);
    assert.equal(launched.status, 0, launched.stderr);
    const portable = path.join(projectRoot, ".agents", "sessions", "codex");
    assert.equal((await listFiles(portable)).length, 0, "global sessions must not create portable copies");
    assert.equal(existsSync(path.join(projectRoot, ".agents", "sessions", "native-inventory.json")), false, "global sessions must not create shared native inventory");

    // Switching back to project sessions restores the portable sync on launch.
    runCli(projectRoot, "skills.mjs", ["codex", "init", "--sessions", "project"], environment);
    runCli(projectRoot, "skills.mjs", ["codex", "exec"], environment);
    assert.ok((await listFiles(portable)).length > 0, "project sessions must capture native sessions");
  });
});

test("project sessions revert native storage after launch", async () => {
  await withTempProject(async (projectRoot) => {
    const binDirectory = await fakeAgentWritesSession(projectRoot, "codex");
    const codexHome = path.join(projectRoot, "codex-home");
    const sessionDirectory = path.join(codexHome, "sessions", "2026", "09", "06");
    const rolloutFile = path.join(sessionDirectory, "rollout-1.jsonl");
    const indexFile = path.join(codexHome, "session_index.jsonl");
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(rolloutFile, `${JSON.stringify({ type: "session_meta", payload: { id: "sess-1", cwd: projectRoot } })}\n`);
    await writeFile(indexFile, `${JSON.stringify({ id: "sess-1" })}\n`);
    const environment = {
      ...process.env,
      PATH: `${binDirectory}${path.delimiter}${process.env.PATH}`,
      CODEX_HOME: codexHome,
      PROJECT_ROOT: projectRoot,
    };
    const initialized = runCli(projectRoot, "skills.mjs", ["codex", "init"], environment);
    assert.equal(initialized.status, 0, initialized.stderr);
    const launched = runCli(projectRoot, "skills.mjs", ["codex", "exec"], environment);
    assert.equal(launched.status, 0, launched.stderr);

    // The session written during the run was captured into the project...
    const captured = path.join(projectRoot, ".agents", "sessions", "codex", "sessions", "fake", "session.jsonl");
    assert.equal(existsSync(captured), true, "launch must capture the session into the project");

    // ...and the native storage returned to its pre-launch state.
    assert.equal(
      existsSync(path.join(codexHome, "sessions", "fake")),
      false,
      "native sessions written during the run must be reverted",
    );
    assert.equal(
      await readFile(rolloutFile, "utf8"),
      `${JSON.stringify({ type: "session_meta", payload: { id: "sess-1", cwd: projectRoot } })}\n`,
    );
    assert.equal(await readFile(indexFile, "utf8"), `${JSON.stringify({ id: "sess-1" })}\n`);
  });
});

test("isolated history mode captures native project sessions without auto-sharing them", async () => {
  await withTempProject(async (projectRoot) => {
    const binDirectory = await fakeAgentWritesSession(projectRoot, "codex");
    const environment = {
      ...process.env,
      PATH: `${binDirectory}${path.delimiter}${process.env.PATH}`,
      CODEX_HOME: path.join(projectRoot, "codex-home"),
      PROJECT_ROOT: projectRoot,
    };
    const initialized = runCli(projectRoot, "skills.mjs", ["init", "--agents", "codex", "--auth", "global", "--sessions", "project", "--history", "isolated"], environment);
    assert.equal(initialized.status, 0, initialized.stderr);
    const launched = runCli(projectRoot, "skills.mjs", ["codex", "exec"], environment);
    assert.equal(launched.status, 0, launched.stderr);
    assert.equal((await listCanonicalSessions(projectRoot)).length, 0);
  });
});

test("self update reinstalls the published npm package globally", async () => {
  const calls = [];
  const packageSpec = await avenicPackageSpec(cliPackageRoot);
  const result = await updateAvenic(cliPackageRoot, {
    currentVersion: "1.4.4",
    latestVersion: "1.4.5",
    probeVersion: () => "1.4.5",
    spawn(executable, argumentsList) {
      calls.push({ executable, argumentsList });
      return { status: 0, stdout: "" };
    },
  });

  assert.equal(result.packageSpec, "avenic@latest");
  assert.equal(packageSpec, result.packageSpec);
  assert.deepEqual(calls, [
    {
      executable: "npm",
      argumentsList: ["install", "--global", "avenic@latest"],
    },
  ]);
});

test("agentExecutableAvailable probes the official CLI on PATH", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-cli-"));
  try {
    // spawnSync cannot launch .cmd files directly on Windows (EINVAL); the
    // runtime resolves .ps1 shims through PowerShell, matching fakeAgentBinary.
    const fake = path.join(dir, process.platform === "win32" ? "claude.ps1" : "claude");
    const content = process.platform === "win32" ? "exit 0\n" : "#!/bin/sh\nexit 0\n";
    await writeFile(fake, content);
    if (process.platform !== "win32") await chmod(fake, 0o755);
    assert.equal(agentExecutableAvailable("claude", { ...process.env, PATH: dir }), true);
    assert.equal(agentExecutableAvailable("claude", { ...process.env, PATH: "" }), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// npm 全局安装生成的 agent CLI 是 .cmd shim（如 opencode.cmd）：CreateProcess 无法
// 直接运行，须经 shell 透传。0.1.7 修正后应能被探测到并输出版本。
test("agentExecutableAvailable runs npm-style .cmd shims on Windows", { skip: process.platform !== "win32" }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-cmd-"));
  try {
    const shim = path.join(dir, "opencode.cmd");
    await writeFile(shim, "@echo off\r\necho 0.15.13\r\nexit /b 0\r\n");
    assert.equal(agentExecutableAvailable("opencode", { ...process.env, PATH: dir }), true);
    assert.equal(agentExecutableAvailable("opencode", { ...process.env, PATH: "" }), false);
    const result = spawnExecutableSync("opencode", ["--version"], {
      env: { ...process.env, PATH: dir },
      windowsHide: true,
      stdio: "pipe",
      encoding: "utf8",
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /0\.15\.13/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stateRoot prefers AVENIC_STATE_DIR and falls back to AGENTHOME_STATE_DIR", () => {
  assert.equal(stateRoot({ AVENIC_STATE_DIR: "/x" }), "/x");
  assert.equal(stateRoot({ AGENTHOME_STATE_DIR: "/legacy" }), "/legacy");
});
