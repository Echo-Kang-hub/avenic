import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, chmod, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
  setLocalAuth,
} from "../packages/core/src/runtime/config.mjs";
import {
  REQUIRED_RULES,
  SESSIONS_RULE,
  ensureRuntimeGitignore,
  sessionsGitIgnored,
} from "../packages/core/src/runtime/gitignore.mjs";
import { hookActionsPath } from "../packages/core/src/runtime/hook-actions.mjs";
import { applyModelConfiguration, readModelConfiguration } from "../packages/core/src/runtime/model-config.mjs";
import { codexTemplate } from "../packages/core/src/runtime/providers.mjs";
import { agentExecutableAvailable, applyProjectConfiguration, listCanonicalSessions, spawnExecutableSync, stateRoot } from "../packages/core/src/index.mjs";
import { locateProjectRoot } from "../packages/core/src/runtime/project-root.mjs";
import * as claudeSessions from "../packages/core/src/runtime/adapters/claude.mjs";
import * as codexSessions from "../packages/core/src/runtime/adapters/codex.mjs";
import * as opencodeSessions from "../packages/core/src/runtime/adapters/opencode.mjs";
import { observeSharedNativeSessions } from "../packages/core/src/runtime/session-interop.mjs";
import { removeLaunchState } from "./helpers/session-fixture.mjs";
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
    // 启动组的 state 按项目身份命名，落在系统临时目录里 —— 不在这个 root 下面，
    // 所以删掉项目目录够不着它。
    await removeLaunchState(projectRoot);
  }
}

test("initialization is incremental and idempotent", async () => {
  await withTempProject(async (projectRoot) => {
    await initializeAgent(projectRoot, "claude", { authMethod: "account", accountScope: "project" });
    await initializeAgent(projectRoot, "codex", { authMethod: "account" });
    const repeated = await initializeAgent(projectRoot, "claude");
    const state = await loadRuntime(projectRoot);

    assert.equal(repeated.configChanged, false);
    assert.equal(state.runtime.agents.claude.authMethod, "account");
    assert.equal(state.runtime.agents.claude.accountScope, "project");
    assert.equal(state.runtime.agents.codex.accountScope, "global");
    assert.equal(state.runtime.agents.claude.sessionScope, "project");
    assert.equal(existsSync(path.join(projectRoot, ".agents", "local", "claude")), true);
    assert.equal(existsSync(path.join(projectRoot, ".agents", "local", "codex")), false);
  });
});

test("applyProjectConfiguration owns same-mode project configuration", async () => {
  await withTempProject(async (projectRoot) => {
    const result = await applyProjectConfiguration(projectRoot, {
      agents: { codex: { authMethod: "account", accountScope: "global", sessionScope: "project" } },
      historyMode: "isolated",
    });
    assert.equal(result.previous, "shared");
    assert.equal(result.mode, "isolated");
    const repeated = await applyProjectConfiguration(projectRoot, {
      agents: { codex: { authMethod: "api", configScope: "project", sessionScope: "project" } },
      historyMode: "isolated",
    });
    assert.deepEqual(repeated.imported, []);
    const stored = (await loadRuntime(projectRoot)).runtime.agents.codex;
    assert.equal(stored.authMethod, "api");
    assert.equal(stored.configScope, "project");
  });
});

test("a draft that changes the history mode still writes the answers it carries", async () => {
  await withTempProject(async (projectRoot) => {
    // The mode decides how history is imported, never whether the rest of the
    // draft reaches its files. The same draft decides Keep/Remove for the
    // previous configuration, so a dropped write would leave the project with
    // neither the old configuration nor the new one.
    const result = await applyProjectConfiguration(projectRoot, {
      agents: { claude: { authMethod: "api", configScope: "project", sessionScope: "project" } },
      historyMode: "isolated",
    });
    assert.equal(result.mode, "isolated");
    // An API answer *is* the file the agent reads, so the draft leaves it
    // there — and writes nothing into it. Which provider and which model it
    // names is the user's own business: Avenic prepares the file, the user
    // fills it, and the dashboard reads it back out once it is filled.
    const file = path.join(projectRoot, ".claude", "settings.local.json");
    assert.equal(await readFile(file, "utf8"), "{}\n");
    assert.equal((await loadRuntime(projectRoot)).runtime.agents.claude.authMethod, "api");
  });
});

test("local authentication overrides project defaults", async () => {
  await withTempProject(async (projectRoot) => {
    await initializeAgent(projectRoot, "claude", { authMethod: "account", accountScope: "global" });
    await setLocalAuth(projectRoot, "claude", { authMethod: "api", configScope: "project" });
    const state = await loadRuntime(projectRoot);
    const effective = effectiveAgentConfig(state, "claude");

    assert.equal(state.runtime.agents.claude.authMethod, "account");
    assert.equal(effective.authMethod, "api");
    assert.equal(effective.configScope, "project");
    assert.equal(effective.source, "local");

    const reset = await clearLocalAuth(projectRoot, "claude");
    assert.equal(reset.authMethod, "account");
    assert.equal(reset.accountScope, "global");
    assert.equal(reset.source, "project");
  });
});

test("global initialization does not create a credential directory", async () => {
  await withTempProject(async (projectRoot) => {
    await initializeAgent(projectRoot, "codex", { authMethod: "account", accountScope: "global" });
    assert.equal(existsSync(path.join(projectRoot, ".agents", "local")), false);
    assert.equal(existsSync(path.join(projectRoot, ".agents", "sessions", "codex")), true);
  });
});

// purge 说的是「清掉 Avenic 的数据」。`.agents/local/<agent>/` 里住的不是它：那是
// agent 自己的账号家目录，Account · Project 的登录就在里面、是 agent 自己写的 ——
// release 路径正因为同一个理由拒绝删它。所以默认留下登录文件本身（其余清掉），
// 连它一起删要用户第二次明说（purgeCredentials）。
test("deinitialization is reversible, and purge keeps the agent's own sign-in unless asked twice", async () => {
  await withTempProject(async (projectRoot) => {
    await initializeAgent(projectRoot, "codex", { authMethod: "account", accountScope: "project" });
    const sessionFile = path.join(projectRoot, ".agents", "sessions", "codex", "session.jsonl");
    const credentialFile = path.join(projectRoot, ".agents", "local", "codex", "auth.json");
    await writeFile(sessionFile, "session\n");
    await writeFile(credentialFile, "credential\n");
    await writeFile(path.join(projectRoot, ".agents", "local", "codex", "config.toml"), "model = 'x'\n");

    const removed = await deinitializeAgent(projectRoot, "codex");
    assert.equal(removed.changed, true);
    assert.equal(existsSync(sessionFile), true);
    assert.equal(existsSync(credentialFile), true);
    assert.equal(effectiveAgentConfig(await loadRuntime(projectRoot), "codex"), null);

    await initializeAgent(projectRoot, "codex", { authMethod: "account", accountScope: "project" });
    const purged = await deinitializeAgent(projectRoot, "codex", { purge: true });
    assert.equal(purged.purged, true);
    assert.equal(existsSync(path.dirname(sessionFile)), false, "Avenic 的会话数据被清掉");
    assert.equal(existsSync(credentialFile), true, "agent 自己的登录不是 Avenic 写的，--purge 不动它");
    assert.equal(await readFile(credentialFile, "utf8"), "credential\n");
    assert.equal(purged.keptCredential, ".agents/local/codex/auth.json", "报告里点名留下的是哪一个文件");
    assert.deepEqual(await readdir(path.join(projectRoot, ".agents", "local", "codex")), ["auth.json"], "home 里其余内容照清");
    const gitignore = await readFile(path.join(projectRoot, ".gitignore"), "utf8");
    assert.match(gitignore, /\.agents\/local\//, "登录文件还在，保护它的规则就不能撤");
    assert.doesNotMatch(gitignore, /\.agents\/tmp\//);
    assert.doesNotMatch(gitignore, /\.agents\/sessions\//);

    // 第二次明说：连登录一起删，并撤回保护规则。
    const cleared = await deinitializeAgent(projectRoot, "codex", { purge: true, purgeCredentials: true });
    assert.equal(existsSync(path.dirname(credentialFile)), false);
    assert.equal(cleared.keptCredential, null);
    const after = await readFile(path.join(projectRoot, ".gitignore"), "utf8");
    assert.doesNotMatch(after, /\.agents\/local\//);

    const repeated = await deinitializeAgent(projectRoot, "codex", { purge: true });
    assert.equal(repeated.changed, false);
  });
});

// opencode 没有「自己的登录文件」这一格：CREDENTIAL_FILE 里只有 claude 与 codex —— 它的
// 认证和 provider 都是它自己的，Avenic 这边没有文件可指。于是「留下了哪个凭据文件」这个问题
// 在它身上必须答「没有」：拿着 undefined 去拼路径会在状态已经改完、数据已经清完之后抛出来，
// 用户拿到一串堆栈，而报告里该说的 Removed / Purged / Kept 一个字都没有 —— 而且它是半途
// 失败的：deinit 做了一半，剩下那一半没人知道。
test("deinitializing an agent that keeps no credential file reports none instead of throwing", async () => {
  await withTempProject(async (projectRoot) => {
    await initializeAgent(projectRoot, "opencode", { sessionScope: "project" });
    assert.notEqual(effectiveAgentConfig(await loadRuntime(projectRoot), "opencode"), null, "前提：opencode 确实被 init 记下了");
    const removed = await deinitializeAgent(projectRoot, "opencode");
    assert.equal(removed.changed, true);
    assert.equal(removed.keptCredential, null, "没有属于它的凭据文件，就该报「没有」");
    assert.equal(removed.remaining, 0);
    // 同一条路的另一半（带 purge）走的是另一个出口，两个出口对同一件事必须答同一个答案。
    await initializeAgent(projectRoot, "opencode", { sessionScope: "project" });
    const purged = await deinitializeAgent(projectRoot, "opencode", { purge: true });
    assert.equal(purged.keptCredential, null);
    assert.equal(purged.purged, true);
  });
});

// 通知名单与登录文件同规则：里面躺着用户自己贴进去的令牌（OpenClaw 的 hook token、
// webhook 的 bearer），删掉就是一份他拿不回来、要去别处重新发的凭据。--purge 清的是
// Avenic 的数据，这一个文件不在其中——一边删它一边报「Data Preserved」两条都错。
test("purge keeps the notification list and its token unless asked twice", async () => {
  await withTempProject(async (projectRoot) => {
    await initializeAgent(projectRoot, "claude", { authMethod: "account", accountScope: "project" });
    const actionsFile = hookActionsPath(projectRoot);
    await writeFile(actionsFile, JSON.stringify({
      actions: [{ id: "openclaw", kind: "openclaw", target: "http://127.0.0.1:18789/hooks/avenic", token: "SECRET-TOKEN" }],
    }, null, 2));

    const purged = await deinitializeAgent(projectRoot, "claude", { purge: true });
    assert.equal(purged.purged, true);
    assert.equal(existsSync(actionsFile), true, "名单是一份用户的凭据，--purge 不动它");
    assert.equal(JSON.parse(await readFile(actionsFile, "utf8")).actions[0].token, "SECRET-TOKEN");
    assert.equal(purged.keptActions, ".agents/local/hook-actions.json", "报告里说得出留下的还有这一份，还说得清它在哪");

    const cleared = await deinitializeAgent(projectRoot, "claude", { purge: true, purgeCredentials: true });
    assert.equal(existsSync(actionsFile), false, "第二次明说才连它一起删");
  });
});

// 没配过的 agent 那里同一条规则：这就是「Data: Preserved」与「名单还在」必须同时为真
// 的那条路——早退分支没有会话目录可删，purged 是 false，而名单照旧得留下。
test("a purge on an agent this project never configured still keeps the notification list", async () => {
  await withTempProject(async (projectRoot) => {
    const actionsFile = hookActionsPath(projectRoot);
    await mkdir(path.dirname(actionsFile), { recursive: true });
    await writeFile(actionsFile, JSON.stringify({ actions: [{ id: "x", kind: "webhook", target: "https://example.test/hook" }] }, null, 2));

    const result = await deinitializeAgent(projectRoot, "claude", { purge: true });
    assert.equal(result.purged, false, "没有可清的会话数据");
    assert.equal(result.keptActions, ".agents/local/hook-actions.json");
    assert.equal(existsSync(actionsFile), true, "报「Preserved」的时候它就得真的还在");
  });
});

// `--purge` 清的是被 deinit 的那个 agent 的东西，不是整个 `.agents/local`：别的
// agent 的 project 答案（config.toml）、账本 ownership.json（证明过 Avenic 建过哪些
// 文件的那一份）、用户自己的答案 runtime.local.json、以及 OpenCode 的项目 home
// （导入名单与共享历史的投影）都不是这一次 deinit 的数据。早退分支（被 deinit 的
// agent 本来就没配过）尤其没有理由动它们 —— 而走到那条路最常见的情形正是它：
// claude 没配过，而 codex 配着。
test("a purge for an agent this project never configured leaves every other resident of .agents/local alone", async () => {
  await withTempProject(async (projectRoot) => {
    await initializeAgent(projectRoot, "codex", { authMethod: "account", accountScope: "project" });
    await setLocalAuth(projectRoot, "codex", { authMethod: "account", accountScope: "project" });
    const codexHome = path.join(projectRoot, ".agents", "local", "codex");
    await writeFile(path.join(codexHome, "auth.json"), "credential\n");
    const applied = await applyModelConfiguration(projectRoot, "codex", "project", codexTemplate("deepseek", { model: "deepseek-v4-pro" }));
    assert.equal(applied.written, true);
    const opencodeKeep = path.join(projectRoot, ".agents", "local", "opencode", "canonical", "keep.json");
    await mkdir(path.dirname(opencodeKeep), { recursive: true });
    await writeFile(opencodeKeep, "{}\n");

    const result = await deinitializeAgent(projectRoot, "claude", { purge: true });
    assert.equal(result.purged, false, "claude 没有可清的会话数据");

    const facts = await readModelConfiguration(projectRoot, "codex", "project");
    assert.equal(facts.exists, true, "别的 agent 的 project 答案不是这一发 purge 的");
    assert.equal(facts.owned, true, "账本还在，所以 Avenic 还证明得了那份文件是它建的");
    assert.equal(facts.unchanged, true);
    assert.equal(existsSync(path.join(projectRoot, ".agents", "local", "runtime.local.json")), true, "用户自己的答案是用户的");
    assert.equal(existsSync(opencodeKeep), true, "OpenCode 的项目 home 不属于任何一次 agent deinit");
  });
});

// 正常那一条路（被 deinit 的 agent 配过，而且是最后一个）同一条规则：清掉它的
// 东西之后，`.agents/local/` 里别人的东西照旧。OpenCode 的 home 与账本都不是任何
// 一次 agent deinit 的对象。
test("purging the last configured agent still leaves the other residents of .agents/local alone", async () => {
  await withTempProject(async (projectRoot) => {
    await initializeAgent(projectRoot, "codex", { authMethod: "account", accountScope: "project" });
    const codexHome = path.join(projectRoot, ".agents", "local", "codex");
    await writeFile(path.join(codexHome, "auth.json"), "credential\n");
    assert.equal((await applyModelConfiguration(projectRoot, "codex", "project", codexTemplate("deepseek", { model: "deepseek-v4-pro" }))).written, true);
    const opencodeKeep = path.join(projectRoot, ".agents", "local", "opencode", "canonical", "keep.json");
    await mkdir(path.dirname(opencodeKeep), { recursive: true });
    await writeFile(opencodeKeep, "{}\n");

    const result = await deinitializeAgent(projectRoot, "codex", { purge: true });
    assert.equal(result.remaining, 0);
    assert.equal(existsSync(path.join(codexHome, "config.toml")), false, "它自己的东西跟着它走");
    assert.equal(existsSync(path.join(codexHome, "auth.json")), true);
    assert.equal(existsSync(opencodeKeep), true, "OpenCode 的项目 home 不属于任何一次 agent deinit");
    assert.equal(existsSync(path.join(projectRoot, ".agents", "local", "ownership.json")), true, "账本不是一次 deinit 的数据");
    const gitignore = await readFile(path.join(projectRoot, ".gitignore"), "utf8");
    assert.match(gitignore, /\.agents\/local\//, "目录还有东西，保护它的规则就不能撤");
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

// 规则只护着还在的东西：`.agents/tmp/` 与 `*.avenic-tmp` 原来是无条件撤掉的，而它们护着
// 的东西撤规则的时候并不一定跟着走 —— 一次不带 purge 的 deinit 清的是配置，临时目录还在。
// 一条规则走了、东西还在，下一次 `git add -A` 就把临时文件收进去了。口径和别的规则一样：
// 目录还在，规则就留着。
test("the rules that guard temporary files stay while the temporary files do", async () => {
  await withTempProject(async (projectRoot) => {
    await initializeAgent(projectRoot, "codex", { authMethod: "account", accountScope: "global" });
    const scratch = path.join(projectRoot, ".agents", "tmp", "half-written.avenic-tmp");
    await mkdir(path.dirname(scratch), { recursive: true });
    await writeFile(scratch, "in flight\n");
    await deinitializeAgent(projectRoot, "codex");
    assert.equal(existsSync(scratch), true, "前提：不带 purge 的 deinit 不动临时目录");
    const gitignore = await readFile(path.join(projectRoot, ".gitignore"), "utf8");
    for (const rule of [".agents/tmp/", "*.avenic-tmp"]) {
      assert.match(gitignore, new RegExp(`^${rule.replace(/[.*]/g, "\\$&")}$`, "m"), `${rule} 护着的目录还在，规则就不能撤`);
    }
  });
});

test("session Git sync can be disabled without deleting sessions", async () => {
  await withTempProject(async (projectRoot) => {
    spawnSync("git", ["init", "--quiet"], { cwd: projectRoot });
    await initializeAgent(projectRoot, "codex", { authMethod: "account", accountScope: "global" });
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
    await initializeAgent(projectRoot, "opencode", {});
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
    const full = runCli(projectRoot, "skills.mjs", ["claude", "init", "--auth", "account"]);
    const short = runCli(projectRoot, "skills.mjs", ["codex", "init", "--auth", "api", "--scope", "project"]);
    const status = runCli(projectRoot, "skills.mjs", ["claude", "status"]);

    assert.equal(full.status, 0, full.stderr);
    assert.equal(short.status, 0, short.stderr);
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /Claude Code/);
    const state = await loadRuntime(projectRoot);
    assert.equal(state.runtime.agents.claude.authMethod, "account");
    assert.equal(state.runtime.agents.codex.authMethod, "api");
    assert.equal(state.runtime.agents.codex.configScope, "project");
  });
});

test("repeated init is a no-op when the project structure is intact", async () => {
  await withTempProject(async (projectRoot) => {
    const first = runCli(projectRoot, "skills.mjs", ["claude", "init", "--auth", "account", "--scope", "project"]);
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, /Settings\s+Updated/);

    const runtimeFile = path.join(projectRoot, ".agents", "runtime.json");
    const gitignoreFile = path.join(projectRoot, ".gitignore");
    const runtimeBefore = await readFile(runtimeFile, "utf8");
    const gitignoreBefore = await readFile(gitignoreFile, "utf8");

    const second = runCli(projectRoot, "skills.mjs", ["claude", "init"]);
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /Settings\s+Unchanged/);
    assert.match(second.stdout, /Git ignore\s+Unchanged/);
    assert.match(second.stdout, /Structure\s+Intact/);
    assert.match(second.stdout, /Already up to date/);
    assert.equal(await readFile(runtimeFile, "utf8"), runtimeBefore);
    assert.equal(await readFile(gitignoreFile, "utf8"), gitignoreBefore);
    // 报告这一段就是面板卡片本身：同一个词、同一个写法，命令刚写完的东西和
    // `avenic status` 之后再读出来的东西不能是两句话。
    assert.match(second.stdout, /Authentication\s+Account \(Project\)/);
    assert.match(second.stdout, /Sessions\s+Project/);
  });
});

test("init incrementally repairs missing directories without touching existing state", async () => {
  await withTempProject(async (projectRoot) => {
    const first = runCli(projectRoot, "skills.mjs", ["claude", "init", "--auth", "account", "--scope", "project"]);
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
    assert.match(repaired.stdout, /Settings\s+Unchanged/);
    assert.match(repaired.stdout, /Git ignore\s+Unchanged/);
    assert.match(repaired.stdout, /Structure\s+Repaired/);
    assert.doesNotMatch(repaired.stdout, /Already up to date/);
  });
});

test("init reports the created structure and how to use it", async () => {
  await withTempProject(async (projectRoot) => {
    const first = runCli(projectRoot, "skills.mjs", ["claude", "init", "--auth", "account", "--scope", "project"]);
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
    const init = runCli(projectRoot, "skills.mjs", ["claude", "init", "--auth", "account"], environment);
    assert.equal(init.status, 0, init.stderr);
    assert.match(init.stdout, /Changed:/);
    assert.doesNotMatch(`${init.stdout}${init.stderr}`, /catalog|Unable to fetch|git failed/i);
  });
});

test("help works from the main and agent positions", async () => {
  await withTempProject(async (projectRoot) => {
    const main = runCli(projectRoot, "skills.mjs", ["--help"]);
    assert.equal(main.status, 0, main.stderr);
    assert.match(main.stdout, /avenic <claude\|codex> init/);
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
    await initializeAgent(sourceRoot, "claude", { authMethod: "account", accountScope: "global", sessionScope: "project" });
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
      await initializeAgent(projectRoot, "codex", { authMethod: "account", accountScope: "global", sessionScope: "project" });
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
    const stateDir = sessionLeasePath("codex", projectRoot);
    assert.equal(existsSync(path.join(stateDir, "pids")), false, "the last exit leaves no launch in the group");
    assert.equal(existsSync(path.join(stateDir, "snapshot.clean")), true, "and leaves a snapshot the next launch can trust");
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
    assert.equal(existsSync(path.join(stateDir, "pids")), false, "the salvaged group leaves no live launch behind");
    assert.equal(existsSync(path.join(stateDir, "snapshot.clean")), true, "and leaves the salvageable snapshot current");
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
    while ((existsSync(path.join(codexHome, "sessions", "fake")) || existsSync(path.join(leaseState, "pids"))) && Date.now() < deadline) {
      await delay(100);
    }
    const captured = path.join(projectRoot, ".agents", "sessions", "codex", "sessions", "fake", "session.jsonl");
    assert.equal(existsSync(captured), true, "watchdog must capture the interrupted session into the project");
    const canonical = path.join(projectRoot, ".agents", "sessions", "canonical", "codex-sess-new", "session.json");
    assert.equal(existsSync(canonical), true, "watchdog must commit an unmapped interrupted native session into canonical history");
    assert.equal(existsSync(path.join(codexHome, "sessions", "fake")), false, "watchdog must revert native storage");
    assert.equal(existsSync(path.join(leaseState, "pids")), false, "watchdog must leave no launch in the group");
    assert.equal(existsSync(path.join(leaseState, "snapshot.clean")), true, "watchdog must leave the reverted snapshot current");
  });
});

test("shared native capture commits an unmapped Codex rollout idempotently without an inventory cache", async () => {
  await withTempProject(async (projectRoot) => {
    const codexHome = path.join(projectRoot, "codex-observe-home");
    const rollout = path.join(codexHome, "sessions", "2026", "09", "18", "rollout.jsonl");
    await initializeAgent(projectRoot, "codex", { authMethod: "account", accountScope: "global", sessionScope: "project" });
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

test("Codex native snapshot and revert cover the project's sessions and the index", async () => {
  await withTempProject(async (projectRoot) => {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), "agent-runtime-codex-snap-"));
    try {
      const environment = { CODEX_HOME: codexHome };
      const snapshotRoot = path.join(projectRoot, "snapshot");
      const sessionDir = path.join(codexHome, "sessions", "2026", "09", "06");
      const sessionFile = path.join(sessionDir, "rollout-1.jsonl");
      // Codex stores every workspace in one directory. This project owns the
      // rollout the launch hands the agent; the other one belongs to a
      // workspace that may be running right now, so this launch must not hold
      // its content, and must not write over it on the way out.
      const foreignFile = path.join(codexHome, "sessions", "2026", "09", "05", "rollout-other.jsonl");
      const indexFile = path.join(codexHome, "session_index.jsonl");
      const portableDir = path.join(projectRoot, ".agents", "sessions", "codex", "sessions", "2026", "09", "06");
      await mkdir(sessionDir, { recursive: true });
      await mkdir(path.dirname(foreignFile), { recursive: true });
      await mkdir(portableDir, { recursive: true });
      await writeFile(path.join(portableDir, "rollout-1.jsonl"), "project copy\n");
      await writeFile(sessionFile, "global\n");
      await writeFile(foreignFile, "other workspace\n");
      await writeFile(indexFile, `${JSON.stringify({ id: "sess-1" })}\n`);

      await codexSessions.snapshotNative(projectRoot, snapshotRoot, { environment });
      await writeFile(sessionFile, "project\n");
      await writeFile(path.join(sessionDir, "new.jsonl"), "new\n");
      await writeFile(foreignFile, "other workspace, still running\n");
      await writeFile(indexFile, `${JSON.stringify({ id: "sess-1" })}\n${JSON.stringify({ id: "sess-new" })}\n`);
      await codexSessions.revertNative(snapshotRoot, projectRoot, { environment });

      assert.equal(await readFile(sessionFile, "utf8"), "global\n", "the project's own rollout is back to its pre-launch content");
      assert.equal(existsSync(path.join(sessionDir, "new.jsonl")), false, "a rollout the run created is removed");
      assert.equal(
        await readFile(foreignFile, "utf8"),
        "other workspace, still running\n",
        "another workspace's rollout is neither reverted nor removed",
      );
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
    await initializeAgent(projectRoot, "codex", { authMethod: "account", sessionScope: "global" });
    assert.equal((await loadRuntime(projectRoot)).runtime.agents.codex.sessionScope, "global");
    await initializeAgent(projectRoot, "codex", { sessionScope: "project" });
    assert.equal((await loadRuntime(projectRoot)).runtime.agents.codex.sessionScope, "project");
    await assert.rejects(
      initializeAgent(projectRoot, "codex", { sessionScope: "machine" }),
      /Sessions must be global or project/,
    );
  });
});

test("a global account launch hands the agent the user's own config homes", async () => {
  // 1.8.3 的 P0 没有被推翻，只是被收窄了：选 Account 时作用域是「哪一份账号
  // 状态」，global 就是这台机器自己的登录——重定向 Agent 的配置发现去一个没有凭据
  // 的空世界，会变成一次「请重新登录」。只有 project 作用域才把 Agent 自己的配置
  // 家指进项目，而且那是它自己写入的登录，不是 Avenic 发明的凭据格式。
  await withTempProject(async (projectRoot) => {
    const binDirectory = await fakeAgentBinary(projectRoot, "claude");
    const outFile = path.join(projectRoot, "launch.txt");
    const userConfig = path.join(projectRoot, "user-config");
    const environment = {
      ...process.env,
      PATH: `${binDirectory}${path.delimiter}${process.env.PATH}`,
      OUT_FILE: outFile,
      CLAUDE_CONFIG_DIR: path.join(userConfig, "claude"),
      CODEX_HOME: path.join(userConfig, "codex"),
      XDG_CONFIG_HOME: path.join(userConfig, "opencode"),
    };
    const initialized = runCli(projectRoot, "skills.mjs", ["claude", "init", "--auth", "account"], environment);
    assert.equal(initialized.status, 0, initialized.stderr);
    const launched = runCli(projectRoot, "skills.mjs", ["claude", "-p", "hello"], environment);
    assert.equal(launched.status, 0, launched.stderr);
    const output = await readFile(outFile, "utf8");
    for (const name of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CONFIG_HOME"]) {
      const value = environment[name].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      assert.match(output, new RegExp(`^${name}=${value}$`, "m"), `${name} must stay the user's own`);
    }
    assert.doesNotMatch(output, /\.agents[\\/]local/, "a global account redirects no config root");
  });
});

test("a project-scope account points only that agent's own config home into the project", async () => {
  await withTempProject(async (projectRoot) => {
    const binDirectory = await fakeAgentBinary(projectRoot, "claude");
    const outFile = path.join(projectRoot, "launch.txt");
    const userConfig = path.join(projectRoot, "user-config");
    const environment = {
      ...process.env,
      PATH: `${binDirectory}${path.delimiter}${process.env.PATH}`,
      OUT_FILE: outFile,
      CLAUDE_CONFIG_DIR: path.join(userConfig, "claude"),
      CODEX_HOME: path.join(userConfig, "codex"),
      XDG_CONFIG_HOME: path.join(userConfig, "opencode"),
    };
    const initialized = runCli(projectRoot, "skills.mjs", ["claude", "init", "--auth", "account", "--scope", "project"], environment);
    assert.equal(initialized.status, 0, initialized.stderr);
    const launched = runCli(projectRoot, "skills.mjs", ["claude", "-p", "hello"], environment);
    assert.equal(launched.status, 0, launched.stderr);
    const output = await readFile(outFile, "utf8");
    const home = path.join(projectRoot, ".agents", "local", "claude");
    assert.match(output, new RegExp(`^CLAUDE_CONFIG_DIR=${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
    // Every other agent's own configuration discovery is none of this agent's
    // business, and neither is OpenCode's.
    for (const name of ["CODEX_HOME", "XDG_CONFIG_HOME"]) {
      assert.match(output, new RegExp(`^${name}=${environment[name].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
    }
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
    const initialized = runCli(projectRoot, "skills.mjs", ["init", "--agents", "codex", "--auth", "account", "--sessions", "project", "--history", "isolated"], environment);
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
