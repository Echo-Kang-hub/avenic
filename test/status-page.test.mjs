// `avenic status` 的 Agents 一节与它下面的行，说的是仪表盘卡片同一批事实：
// Authentication 连作用域、会话存在哪、历史是哪种模式；一份 API 配置的每个字段
// 一行，80 列的终端一个值都切不掉。这份文件钉的就是「同一批事实、同一套词」。
import assert from "node:assert/strict";
import test from "node:test";
import { renderStatus } from "../packages/cli/src/cli/status-cli.mjs";

function render(status, columns = 80) {
  const lines = [];
  const stdout = { columns, write: () => true };
  renderStatus(status, { log: (line) => lines.push(line) }, { stdout, environment: { NO_COLOR: "1" } });
  return lines.join("\n");
}

function fixture() {
  return {
    project: { name: "atlas", root: "C:\\atlas", agents: ["claude", "codex"], configured: true },
    history: { mode: "shared", sessions: 1, active: null, activeTitle: null, activeEvents: null, updatedAt: null },
    agents: [
      {
        id: "claude", displayName: "Claude Code", command: "claude", available: true, initialized: true, runtime: null,
        auth: {
          method: "api", scope: "project", source: "project", home: null, status: null,
          configuration: {
            relative: ".claude/settings.local.json", file: "C:\\atlas\\.claude\\settings.local.json",
            exists: true, valid: true, configured: true, owned: true, unchanged: false,
            provider: "DeepSeek", baseUrl: "https://api.deepseek.invalid/anthropic", model: "deepseek-chat",
            credentialSet: true,
            settings: { primary: "deepseek-chat", opus: "deepseek-opus", sonnet: "deepseek-sonnet", haiku: "deepseek-haiku", subagent: "deepseek-flash", effort: "max" },
          },
        },
        sessions: "project", history: { sessions: 1, sync: "current" },
      },
      {
        id: "codex", displayName: "Codex", command: "codex", available: true, initialized: true, runtime: null,
        auth: {
          method: "account", scope: "global", source: "local", home: "~/.codex", status: "not-signed-in",
          configuration: null,
          // 账号那一份的 Model 来自 agent 自己的配置文件 —— 正在跑的模型，
          // 不是 Avenic 替它猜的。
          account: { model: "gpt-5-codex" },
        },
        sessions: "global", history: { sessions: 0, sync: "none" },
      },
      {
        id: "opencode", displayName: "OpenCode", command: "opencode", available: true, initialized: false, runtime: "native",
        auth: null, sessions: null, history: { sessions: 0, sync: "none" },
      },
    ],
    skills: {
      project: { installed: 0, packs: [], state: "none", total: 0 },
      global: { installed: 0, packs: [], state: "none" },
      hub: { name: "hub", cache: "current", revision: "abc1234def", pinned: null },
    },
  };
}

const rowOf = (page, name) => page.split("\n").find((line) => line.includes(name));

test("the Agents table answers Authentication, the sessions scope, and the history mode — never a count", () => {
  const page = render(fixture());
  assert.match(page, /Agent\s+CLI\s+Authentication\s+Sessions\s+History\s+Sync/, "the header names the question the column answers");
  assert.match(rowOf(page, "Claude Code"), /API \(Project\)\s+Project\s+Shared\s+current/);
  assert.match(rowOf(page, "Codex"), /Account \(Global\)\s+Global\s+Shared\s+—/);
  assert.match(rowOf(page, "OpenCode"), /Native \(OpenCode UI\)\s+—\s+Shared\s+—/);
  // 旧的 History 一列印的是这条历史里有几段会话：表头问的是一种模式，答案却是一个数。
  assert.doesNotMatch(rowOf(page, "Codex"), /\s0\s/, "a count is not the history mode");
});

test("an isolated project says so in every agent's History cell", () => {
  const status = fixture();
  status.history.mode = "isolated";
  const page = render(status);
  assert.match(rowOf(page, "Claude Code"), /API \(Project\)\s+Project\s+Isolated\s+current/);
});

test("an API configuration's facts are one per line, whole at 80 columns", () => {
  const page = render(fixture(), 80);
  for (const fact of [
    "Config Source .claude/settings.local.json",
    "Provider DeepSeek",
    "Model deepseek-chat",
    "Sub Agent Model deepseek-flash",
    "Default Effort Max",
  ]) {
    assert.ok(page.includes(fact), `the API facts must survive an 80-column terminal: ${fact}\n${page}`);
  }
  for (const line of page.split("\n")) {
    assert.ok(line.length <= 80, `nothing is wider than the terminal: ${JSON.stringify(line)}`);
  }
});

test("an Account's facts are the card's, the Model it runs on included", () => {
  const page = render(fixture());
  assert.match(page, /Codex: Account Status Not signed in — run: avenic codex to sign in/);
  assert.match(page, /Codex: Account Scope Global \(~\/\.codex\)/);
  // 面板卡片上有这一行（账号那份配置里正在跑的模型），状态页不能少说一个事实。
  assert.match(page, /Codex: Model gpt-5-codex/);
});

test("a configuration that is not written yet keeps its remedy, not its blanks", () => {
  const status = fixture();
  status.agents[0].auth.configuration.configured = false;
  const page = render(status);
  assert.match(page, /Claude Code: fill in \.claude\/settings\.local\.json — nothing in it yet/);
  assert.doesNotMatch(page, /Claude Code: Provider/, "there is no provider to name before the file is filled in");
});
