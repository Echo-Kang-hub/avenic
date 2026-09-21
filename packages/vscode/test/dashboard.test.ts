import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { configureProject, importProjectSessions, setActiveCanonicalSession, writeApiConfiguration } from "@avenic/core";
import { buildDashboardData } from "../src/dashboard/state.ts";
import { isWebviewMessage } from "../src/dashboard/protocol.ts";
import { initialize, invalidateAgentStatusCache, projectStatus } from "../src/services/agents.ts";
import { defaultSpec, packsFor, select, sync } from "../src/services/catalog.ts";
import { installPacks } from "../src/services/skills.ts";
import { makeCatalogFixture, testEnv } from "./helpers.ts";

// 仪表盘的数据层：面板上每一格都必须能追到 core 的一条真实答案。这里断言的是
// 「追得到」——真实项目、真实认证答案、真实会话记录、真实 Skill 安装状态——而不是
// 某段文案长什么样；文案的排版在 media/ 里，由 visual fixture 负责。

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function fieldOf(card: { fields: Array<{ label: string; value: string; kind: string; options?: string[] }> }, label: string) {
  return card.fields.find((field) => field.label === label);
}

// 一条真实形状的 Claude 会话文件，写进项目的便携存储，再由 core 的导入路径读进来。
// 会话标题的整条优先级（原生 summary → 首条用户发言 → 短 id）都是 core 在导入时判定
// 的，所以这里造的是**输入**，不是结论。
function claudeLine(sessionId: string, index: number, role: "user" | "assistant", text: string) {
  return JSON.stringify({
    type: role,
    uuid: `fixture-${index}`,
    sessionId,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    cwd: "fixture",
    message: { role, model: "claude-sonnet-5", content: [{ type: "text", text }] },
  });
}

async function seedClaudePortable(project: string, entries: Array<[string, string[]]>): Promise<void> {
  const directory = path.join(project, ".agents", "sessions", "claude");
  await mkdir(directory, { recursive: true });
  for (const [sessionId, lines] of entries) {
    await writeFile(path.join(directory, `${sessionId}.jsonl`), `${lines.join("\n")}\n`);
  }
}

test("the dashboard names the real project, the CLI in use, and the extension drawing it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-ext-"));
  try {
    const project = path.join(root, "my-app");
    await mkdir(project, { recursive: true });
    const data = await buildDashboardData(project, testEnv(path.join(root, "state")), { cliVersion: "9.9.9", extensionVersion: "0.6.0" });
    // 底部那一行的主版本是 CLI 的产品版本；扩展自己的版本在悬停里，不抢这一行。
    assert.equal(data.version, "9.9.9");
    assert.deepEqual(data.versionDetails, { cli: "9.9.9", extension: "0.6.0" });
    const unknown = await buildDashboardData(project, testEnv(path.join(root, "state")), {});
    assert.equal(unknown.version, "", "没探到 CLI 就是空串——页面只写 Avenic，不编版本号");
    assert.deepEqual(unknown.versionDetails, { cli: "", extension: "" });
    assert.equal(data.project.root, project);
    assert.equal(data.project.name, "my-app", "项目名取自真实根目录名，不是占位符");
    assert.equal(data.project.configured, false, "全新目录没有 .avenic.json");
    assert.ok(data.empty, "未初始化时要给出理由，而不是一屏空壳");
    assert.deepEqual(data.agents.map((a) => a.id), ["claude", "codex", "opencode"]);
    for (const agent of data.agents) {
      assert.equal(agent.ready, false, "全新项目里没有 agent 被配置过");
      assert.equal(agent.fields.some((f) => f.kind === "badge"), true, "每个 agent 都要说出它的认证答案（这里是「未选择」）");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a project account reports its home and its sign-in state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-ext-account-"));
  try {
    const project = path.join(root, "project");
    const env = testEnv(path.join(root, "state"));
    await mkdir(project, { recursive: true });
    await initialize(project, "claude", { authMethod: "account", accountScope: "project", sessionScope: "project" });
    invalidateAgentStatusCache();
    const card = (await buildDashboardData(project, env, { cliVersion: "0" })).agents.find((a) => a.id === "claude")!;
    assert.equal(fieldOf(card, "Authentication")?.value, "Account (Project)");
    assert.equal(fieldOf(card, "Account Status")?.value, "Not signed in", "登录状态来自 agent 自己的 home，不是猜的");
    assert.equal(fieldOf(card, "Account Home")?.value, ".agents/local/claude", "这一格说的是那份状态在哪个目录，作用域已经写在认证徽章里了");
    // core 在 Account 模式下不去读 agent 自己的模型设置，所以这一格不存在——
    // 与其编一个模型名，不如不说。
    assert.equal(fieldOf(card, "Model"), undefined, "Account 模式的模型由 agent 自己的设置决定，Avenic 不许编");
    assert.equal(fieldOf(card, "Sub Agent Model"), undefined);
    assert.equal(fieldOf(card, "Default Effort"), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an API configuration shows its file, provider and model — never a credential", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-ext-api-"));
  try {
    const project = path.join(root, "project");
    const env = testEnv(path.join(root, "state"));
    await mkdir(project, { recursive: true });
    await initialize(project, "claude", { authMethod: "api", configScope: "project", sessionScope: "project" });
    invalidateAgentStatusCache();
    const before = (await buildDashboardData(project, env, { cliVersion: "0" })).agents.find((a) => a.id === "claude")!;
    assert.equal(fieldOf(before, "Authentication")?.value, "API (Project)");
    assert.equal(fieldOf(before, "Config Source")?.value, ".claude/settings.local.json", "要说出承载配置的那个文件");
    assert.equal(fieldOf(before, "Provider"), undefined, "还没写过 provider 就不能显示一个");

    await writeApiConfiguration(project, "claude", "project", {
      provider: "DeepSeek",
      baseUrl: "https://provider.fixture.invalid/v1",
      model: "deepseek-chat",
      credential: "fixture-value-not-a-real-credential",
    });
    invalidateAgentStatusCache();
    const card = (await buildDashboardData(project, env, { cliVersion: "0" })).agents.find((a) => a.id === "claude")!;
    assert.equal(fieldOf(card, "Provider")?.value, "DeepSeek");
    const model = fieldOf(card, "Model");
    assert.equal(model?.kind, "select");
    assert.equal(model?.value, "deepseek-chat", "select 显示的是配置文件里真正生效的模型");
    assert.deepEqual(model?.options, ["deepseek-chat"], "可选项来自 agent 自己的文件，不是硬编码表");
    const everything = JSON.stringify(card);
    assert.equal(everything.includes("fixture-value-not-a-real-credential"), false, "凭据从不进入面板载荷");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 卡片上的图标名字是宿主给的（state.ts），字形是样式表给的。两边各写各的名单时，
// 错的那一个不会报错：它只是渲染成一块空白，而 visual fixture 用自己的名字正好把
// 那一格填上了 —— 于是两边的测试都看不见它。这条测试把两份名单对起来。
test("every icon the host puts on a card has a glyph in the stylesheet", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-ext-glyph-"));
  try {
    const project = path.join(root, "project");
    const env = testEnv(path.join(root, "state"));
    await mkdir(project, { recursive: true });
    // 一个项目里同时走到三条分支：API（Config Source / Provider / Model）、
    // Account（状态与 home）、原生（OpenCode 自己那一格）。
    await initialize(project, "claude", { authMethod: "api", configScope: "project", sessionScope: "project" });
    await writeApiConfiguration(project, "claude", "project", {
      provider: "DeepSeek",
      baseUrl: "https://provider.fixture.invalid/v1",
      model: "deepseek-chat",
      credential: "fixture-value-not-a-real-credential",
    });
    await initialize(project, "codex", { authMethod: "account", accountScope: "project", sessionScope: "project" });
    invalidateAgentStatusCache();
    const data = await buildDashboardData(project, env, { cliVersion: "0" });

    const icons = new Set<string>();
    for (const card of data.agents) {
      for (const field of card.fields) icons.add(field.icon);
      if (card.configLink !== null) icons.add(card.configLink.icon);
    }
    assert.ok(icons.size >= 6, `解析本身没跑偏：读到 ${icons.size} 个图标名`);

    const css = await readFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "media", "dashboard", "style.css"), "utf8");
    for (const name of icons) {
      assert.ok(css.includes(`.icon[data-icon="${name}"]::before`), `卡片上的 ${name} 没有字形，真机上是一块空白`);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode is reported as native and is not given Avenic-owned fields", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-ext-native-"));
  try {
    const project = path.join(root, "project");
    const env = testEnv(path.join(root, "state"));
    await mkdir(project, { recursive: true });
    await initialize(project, "opencode", { sessionScope: "project" });
    invalidateAgentStatusCache();
    const card = (await buildDashboardData(project, env, { cliVersion: "0" })).agents.find((a) => a.id === "opencode")!;
    assert.equal(fieldOf(card, "Authentication")?.value, "Native (OpenCode UI)");
    assert.equal(card.detail !== null && card.detail.length > 0, true, "自管认证要有解释段");
    for (const absent of ["Provider", "Model", "Config Source"]) {
      assert.equal(fieldOf(card, absent), undefined, `OpenCode 的 ${absent} 由它自己管，面板不代答`);
    }
    assert.equal(card.sessions.label, "Project", "会话作用域是 Avenic 记的唯一一件事");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session titles come from the agent's own store, then the first thing the user said — never a uuid", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-ext-shared-"));
  try {
    const project = path.join(root, "project");
    const env = testEnv(path.join(root, "state"));
    await mkdir(project, { recursive: true });
    await initialize(project, "claude", { authMethod: "account", accountScope: "project", sessionScope: "project" });
    const uuid = "3f9a1c2b-4d5e-4f60-8a1b-2c3d4e5f6a7b";
    await seedClaudePortable(project, [
      // 1) Claude 自己的 summary 记录是它唯一写下来的会话名：优先于用户说了什么。
      ["session-summarized", [
        JSON.stringify({ type: "summary", summary: "Fix authentication environment handling", sessionId: "session-summarized" }),
        claudeLine("session-summarized", 0, "user", "something the user typed before the summary"),
      ]],
      // 2) 没有 summary：标题是这个人说的第一句话。
      ["session-spoken", [
        claudeLine("session-spoken", 0, "user", "Review test results and fix failing cases"),
        claudeLine("session-spoken", 1, "assistant", "Two cases fail on Windows."),
      ]],
      // 3) 一句话都没有：短 id 兜底，而且绝不是完整 uuid。
      [uuid, [claudeLine(uuid, 0, "assistant", "…")]],
    ]);
    await importProjectSessions(project, "claude", { environment: env, skipCapture: true });
    invalidateAgentStatusCache();
    const data = await buildDashboardData(project, env, { cliVersion: "0" });
    const titles = data.shared.rows.map((row) => row.title);
    assert.equal(data.shared.rows.length, 3);
    assert.equal(data.shared.total, 3);
    assert.ok(titles.includes("Fix authentication environment handling"), `原生 summary 优先：${titles.join(" | ")}`);
    assert.ok(titles.includes("Review test results and fix failing cases"), `首条用户发言成为标题：${titles.join(" | ")}`);
    for (const row of data.shared.rows) {
      assert.equal(UUID.test(row.title), false, `标题不得是 uuid：${row.title}`);
      assert.equal(typeof row.relative, "string");
    }
    assert.deepEqual(
      data.shared.rows.find((row) => row.title === "Review test results and fix failing cases")?.agents,
      ["claude"],
      "参与方来自真实的原生映射，不是猜的",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the project card counts each agent's own sessions and lists the ones the project holds", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-ext-native-rows-"));
  try {
    const project = path.join(root, "project");
    const env = testEnv(path.join(root, "state"));
    await mkdir(project, { recursive: true });
    await initialize(project, "claude", { authMethod: "account", accountScope: "project", sessionScope: "project" });
    await seedClaudePortable(project, [
      ["session-one", [claudeLine("session-one", 0, "user", "Update VS Code extension UI design")]],
    ]);
    await importProjectSessions(project, "claude", { environment: env, skipCapture: true });
    invalidateAgentStatusCache();
    const data = await buildDashboardData(project, env, { cliVersion: "0" });
    assert.equal(data.native.claude.total, 1, "这一格是 core 数出来的项目会话数");
    assert.equal(data.native.claude.rows.length, 1);
    assert.equal(data.native.claude.rows[0].title, "Update VS Code extension UI design");
    assert.equal(data.native.claude.rows[0].id, "claude-session-one", "Continue 用的是共享会话 id");
    assert.equal(data.native.claude.rows[0].active, true, "刚导入的会话就是 core 报的 active");
    // Codex 没有被配置过：它的会话数就是 core 报的 0，不是编的。
    assert.equal(data.native.codex.total, 0);
    assert.deepEqual(data.native.codex.rows, []);
    assert.equal(typeof data.native.opencode.total, "number");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the shared card follows the project's history mode instead of promising sessions it lacks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-ext-history-"));
  try {
    const project = path.join(root, "project");
    const env = testEnv(path.join(root, "state"));
    await mkdir(project, { recursive: true });
    await initialize(project, "claude", { authMethod: "account", accountScope: "project", sessionScope: "project" });
    assert.equal((await buildDashboardData(project, env, { cliVersion: "0" })).history.mode, "shared", "默认就是共享历史");
    await configureProject(project, { historyMode: "isolated" });
    invalidateAgentStatusCache();
    const data = await buildDashboardData(project, env, { cliVersion: "0" });
    assert.equal(data.history.mode, "isolated");
    assert.equal(data.history.sharedCount, 0);
    assert.deepEqual(data.shared.rows, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installed skills are read from the real lock file, with their own descriptions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-ext-skills-"));
  try {
    const catalogDir = path.join(root, "catalog");
    const project = path.join(root, "project");
    const env = testEnv(path.join(root, "state"));
    await mkdir(project, { recursive: true });
    await makeCatalogFixture(catalogDir);
    await select(catalogDir, env);
    await installPacks("project", ["common"], project, env);
    const data = await buildDashboardData(project, env, { cliVersion: "0" });
    assert.equal(data.skills.installedTotal, 1, "已安装数来自真实安装状态");
    assert.equal(data.skills.installed[0].name, "alpha");
    assert.equal(data.skills.installed[0].enabled, true);
    assert.ok(data.skills.installed[0].agents.length > 0, "Skill 属于哪些 agent 由安装目标回答");
    assert.equal(data.skills.packsTotal >= 1, true, "可用 Pack 来自本地 Catalog 缓存");
    assert.ok((data.hub.spec?.length ?? 0) > 0, "Hub 规格来自 core 的发现结果");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("opening one session reads its turns, and nothing else does", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "avenic-ext-"));
  const project = path.join(dir, "project");
  const env = testEnv(path.join(dir, "state"));
  try {
    await mkdir(project, { recursive: true });
    await initialize(project, "claude", { authMethod: "account", accountScope: "project", sessionScope: "project" });
    await seedClaudePortable(project, [["session-opened", [
      claudeLine("session-opened", 1, "user", "where does the time go?"),
      claudeLine("session-opened", 2, "assistant", "the ledger is re-read once per account"),
    ]]]);
    await importProjectSessions(project, "claude", { environment: env, skipCapture: true });
    invalidateAgentStatusCache();

    const closed = await buildDashboardData(project, env, { cliVersion: "0" });
    assert.equal(closed.transcript, null, "没打开任何会话就不读对话内容");
    const id = closed.shared.rows[0].id;
    await setActiveCanonicalSession(project, id);
    invalidateAgentStatusCache();

    const opened = await buildDashboardData(project, env, { cliVersion: "0", transcriptId: id });
    assert.equal(opened.transcript?.id, id);
    assert.equal(opened.transcript?.title, closed.shared.rows[0].title, "标题与列表里的那一行是同一个");
    // 打开一条对话时得知道它是不是当前活跃的那条：面板据此决定要不要给「设为活跃」
    // 这个按钮——已经活跃的会话上再放一个「设为活跃」是在问用户一件已经成立的事。
    assert.equal(closed.shared.rows[0].active, true, "设为活跃之后列表里那一行确实是活跃的");
    assert.equal(opened.transcript?.active, closed.shared.rows[0].active, "打开的这条与列表里那一行的活跃状态是同一个");
    const turns = opened.transcript?.turns ?? [];
    assert.equal(turns.length, 2);
    assert.equal(turns[0].role, "user");
    assert.match(turns[0].text, /where does the time go\?/);
    assert.match(turns[1].text, /re-read once per account/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildDashboardData renders the not-opened state for a null root", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "avenic-ext-"));
  try {
    const data = await buildDashboardData(null, testEnv(dir), { cliVersion: "0" });
    assert.equal(data.project.root, null);
    assert.equal(data.project.configured, false);
    assert.equal(data.agents.length, 3);
    assert.equal(data.shared.rows.length, 0);
    assert.equal(data.native.claude.rows.length, 0);
    assert.equal(data.skills.installed.length, 0);
    assert.equal(data.hub.state, "missing", "没有项目就没有 registry 可言，这一格也要是同一个三态里的一个");
    assert.equal(data.detail, false);
    assert.ok(data.empty, "没打开项目也要说清楚原因");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("untracked on-disk skills are counted, and are not called enabled", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "avenic-ext-"));
  try {
    await mkdir(path.join(dir, ".agents", "skills", "alpha"), { recursive: true });
    await writeFile(path.join(dir, ".agents", "skills", "alpha", "SKILL.md"), "---\nname: alpha\ndescription: an untracked skill\n---\n");
    const data = await buildDashboardData(dir, testEnv(dir), { cliVersion: "0" });
    assert.equal(data.skills.installedTotal, 1, "磁盘上有、Avenic 没管的 Skill 也要算进已安装");
    assert.equal(data.skills.installed[0].name, "alpha");
    assert.equal(data.skills.installed[0].enabled, false, "没有 Avenic 记录就不算它启用着");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("protocol guard accepts the dashboard's messages and drops everything else", () => {
  assert.ok(isWebviewMessage({ type: "ready" }));
  assert.ok(isWebviewMessage({ type: "refresh" }));
  for (const section of ["overview", "configure", "agents", "sessions", "skills", "quick"]) {
    assert.ok(isWebviewMessage({ type: "navigate", section }));
  }
  for (const agent of ["claude", "codex", "opencode"]) {
    assert.ok(isWebviewMessage({ type: "action", action: "launch", agent }));
    assert.ok(isWebviewMessage({ type: "action", action: "change", agent }));
    assert.ok(isWebviewMessage({ type: "action", action: "openConfig", agent }));
    assert.ok(isWebviewMessage({ type: "action", action: "continueNative", agent, id: "abc" }));
  }
  for (const action of ["importSkill", "manageSkills", "syncHub", "viewLogs", "switchHistory", "initialize", "reconfigure", "openProject", "revealProject", "openFolder", "openInTerminal", "openDocs", "openSettings"]) {
    assert.ok(isWebviewMessage({ type: "action", action }));
  }
  for (const action of ["continueShared", "viewSession", "setActive"]) {
    assert.ok(isWebviewMessage({ type: "action", action, id: "abc" }));
  }
  assert.ok(isWebviewMessage({ type: "action", action: "installPack", pack: "release-kit" }));
  assert.ok(!isWebviewMessage({ type: "action", action: "launch" }), "缺 agent 的启动不转发");
  assert.ok(!isWebviewMessage({ type: "action", action: "launch", agent: "gemini" }), "未知 agent 不转发");
  assert.ok(!isWebviewMessage({ type: "action", action: "continueShared" }), "缺会话 id 不转发");
  assert.ok(!isWebviewMessage({ type: "action", action: "continueShared", id: "../etc/passwd" }), "越界 id 不转发");
  assert.ok(!isWebviewMessage({ type: "action", action: "installPack" }), "缺 Pack 的安装不转发");
  assert.ok(!isWebviewMessage({ type: "action", action: "installPack", pack: "../../packs/evil" }), "越界 Pack 不转发");
  assert.ok(!isWebviewMessage({ type: "navigate", section: "shell" }));
  assert.ok(!isWebviewMessage({ type: "command", command: "shell.open" }));
  assert.ok(!isWebviewMessage({ type: "report", message: "all good" }));
  assert.ok(!isWebviewMessage(null));
});

test("skills installed into a shared target report every agent that receives them", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-ext-targets-"));
  try {
    const catalogDir = path.join(root, "catalog");
    const project = path.join(root, "project");
    const env = testEnv(path.join(root, "state"));
    await mkdir(project, { recursive: true });
    await makeCatalogFixture(catalogDir);
    await select(catalogDir, env);
    await installPacks("project", ["common"], project, env);
    const data = await buildDashboardData(project, env, { cliVersion: "0" });
    assert.deepEqual([...data.skills.installed[0].agents].sort(), ["claude", "codex", "opencode"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a broken shared link is visible on the skill row that lost it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-ext-broken-"));
  try {
    const catalogDir = path.join(root, "catalog");
    const project = path.join(root, "project");
    const env = testEnv(path.join(root, "state"));
    await mkdir(project, { recursive: true });
    await makeCatalogFixture(catalogDir);
    await select(catalogDir, env);
    await installPacks("project", ["common"], project, env);
    // Claude 是 share 目标：把它那一条链接换成指向项目外的目录（不是 Avenic 写的）
    const shared = path.join(project, ".claude", "skills", "alpha");
    const elsewhere = path.join(root, "elsewhere", "alpha");
    await rm(shared, { recursive: true, force: true });
    await mkdir(elsewhere, { recursive: true });
    await writeFile(path.join(elsewhere, "SKILL.md"), "---\nname: alpha\n---\n");
    if (process.platform === "win32") await symlink(path.resolve(elsewhere), shared, "junction");
    else await symlink(path.relative(path.dirname(shared), elsewhere), shared, "dir");
    const data = await buildDashboardData(project, env, { cliVersion: "0" });
    assert.equal(data.skills.installed[0].enabled, false, "链接不再是共享的那一条时，行要说出来");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the sessions page is handed a longer list than the overview's five", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-ext-deep-"));
  try {
    const project = path.join(root, "project");
    const env = testEnv(path.join(root, "state"));
    await mkdir(project, { recursive: true });
    await initialize(project, "claude", { authMethod: "account", accountScope: "project", sessionScope: "project" });
    await seedClaudePortable(project, Array.from({ length: 8 }, (_, index) => [
      `session-${index}`,
      [claudeLine(`session-${index}`, index, "user", `Question number ${index}`)],
    ]));
    await importProjectSessions(project, "claude", { environment: env, skipCapture: true });
    invalidateAgentStatusCache();

    // 概览是「最近发生了什么」：5 条 + 一个总数，指向下一站。
    const overview = await buildDashboardData(project, env, { cliVersion: "0" });
    assert.equal(overview.shared.rows.length, 5);
    assert.equal(overview.shared.total, 8, "总数是全部，不是列出来的那 5 条");
    assert.equal(overview.detail, false);

    // 那一站必须真的能列出来：「View All」不是一个通向同一份 5 条的链接。
    const deep = await buildDashboardData(project, env, { cliVersion: "0", detail: true });
    assert.equal(deep.shared.rows.length, 8, "Sessions 页列出全部");
    assert.equal(deep.native.claude.rows.length, 8);
    assert.equal(deep.detail, true);
    // 而且是同一份清单的开头，不是另一批：概览那 5 条就是这一列的前 5 条。
    assert.deepEqual(deep.shared.rows.slice(0, 5).map((row) => row.id), overview.shared.rows.map((row) => row.id));
    assert.deepEqual(deep.native.claude.rows.map((row) => row.id), deep.shared.rows.map((row) => row.id), "每一条都归 Claude：这一页里两个视图说同一件事");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Last updated is a real moment in Avenic's one timestamp format", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-ext-updated-"));
  try {
    const project = path.join(root, "project");
    const env = testEnv(path.join(root, "state"));
    await mkdir(project, { recursive: true });
    await initialize(project, "claude", { authMethod: "account", accountScope: "project", sessionScope: "project" });
    await seedClaudePortable(project, [["session-when", [claudeLine("session-when", 0, "user", "When was this project last touched?")]]]);
    await importProjectSessions(project, "claude", { environment: env, skipCapture: true });
    invalidateAgentStatusCache();

    const data = await buildDashboardData(project, env, { cliVersion: "0" });
    // 面板不是时间戳的另一个作者：core 的 shortTimestamp 是 Avenic 唯一的写法
    // （status-cli 印的是同一个值），面板照它写，标题栏才不会因为一段 ISO 串换行。
    assert.match(data.project.lastUpdated ?? "", /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, `实际是「${data.project.lastUpdated}」`);

    // 配好了、还一条会话都没有的项目：这一格仍然有答案——配置自己写下的那一刻。
    const fresh = path.join(root, "fresh");
    await mkdir(fresh, { recursive: true });
    await initialize(fresh, "claude", { authMethod: "account", accountScope: "project", sessionScope: "project" });
    invalidateAgentStatusCache();
    const freshData = await buildDashboardData(fresh, env, { cliVersion: "0" });
    assert.equal(freshData.shared.rows.length, 0);
    assert.match(freshData.project.lastUpdated ?? "", /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, "没有会话时说配置的时间，而不是什么都不说");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the registry reports what core says about it, including the middle state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-ext-hub-"));
  try {
    const catalogDir = path.join(root, "catalog");
    const project = path.join(root, "project");
    const env = testEnv(path.join(root, "state"));
    await mkdir(project, { recursive: true });
    await initialize(project, "claude", { authMethod: "account", accountScope: "project", sessionScope: "project" });

    // 从没同步过：core 说 missing，面板也这么说（不是「有一个缓存」）。
    const never = await buildDashboardData(project, env, { cliVersion: "0" });
    assert.equal(never.hub.state, "missing");

    await makeCatalogFixture(catalogDir);
    await select(catalogDir, env);
    const spec = await defaultSpec(env);
    assert.ok(spec !== null);
    await sync(spec, env);
    invalidateAgentStatusCache();
    const synced = await buildDashboardData(project, env, { cliVersion: "0" });
    // 面板不把三态压成布尔：它照抄 core 的答案，「落后于远端」与「落后」于是不一样。
    const status = await projectStatus(project, env);
    assert.equal(synced.hub.state, status.skills.hub.cache);
    assert.ok(["current", "stale", "missing"].includes(synced.hub.state));
    assert.equal(synced.hub.state, "current", "刚同步过的 checkout 是当前的那一份");

    // 中间那一态：项目把 Pack 装在某一个修订上，Catalog 的 checkout 之后往前走了。
    // 「缓存落后于项目钉住的那一版」既不等于「没有缓存」，也不等于「同步过了」——
    // 压成一个布尔，面板就会把这一种说成另外两种之一。
    await installPacks("project", ["common"], project, env);
    await mkdir(path.join(catalogDir, "skills", "demo", "gamma"), { recursive: true });
    await writeFile(path.join(catalogDir, "skills", "demo", "gamma", "SKILL.md"), "---\nname: gamma\n---\n");
    const git = (...argv: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e", ...argv], { cwd: catalogDir });
    git("add", "-A");
    git("commit", "-qm", "two");
    await sync(spec, env);
    invalidateAgentStatusCache();
    const moved = await buildDashboardData(project, env, { cliVersion: "0" });
    assert.equal(moved.hub.state, "stale", "checkout 走了、项目钉住的还是上一版：这一种必须与另外两种分得开");
    assert.equal(moved.hub.state, (await projectStatus(project, env)).skills.hub.cache, "仍然是 core 的那一个答案");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a pack row carries the id its Install button has to send, and the state core has for it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-ext-packid-"));
  try {
    const catalogDir = path.join(root, "catalog");
    const project = path.join(root, "project");
    const env = testEnv(path.join(root, "state"));
    await mkdir(project, { recursive: true });
    await makeCatalogFixture(catalogDir);
    await select(catalogDir, env);
    const spec = await defaultSpec(env);
    assert.ok(spec !== null, "刚选过的目录就是当前规格");
    await sync(spec, env); // Pack 列表读的是本地 checkout：先把它拉下来
    const known = (await packsFor(spec, env, { cachedOnly: true })) ?? new Map();

    const before = await buildDashboardData(project, env, { cliVersion: "0" });
    assert.ok(before.skills.packs.length > 0, "Catalog 的缓存里有 Pack");
    // 行上的 id 是 core 的 Pack 身份（不是渲染层按名字现拼的另一套），所以那一行
    // 的「Install」发出去的就是 core 认得的那个 pack。
    assert.deepEqual([...before.skills.packs.map((pack) => pack.id)].sort(), [...known.keys()].sort());
    for (const pack of before.skills.packs) {
      assert.equal(pack.name, known.get(pack.id)!.name);
      assert.equal(pack.installed, false, "还没装过：那一行不该说它装好了");
    }

    await installPacks("project", ["extra"], project, env);
    const after = await buildDashboardData(project, env, { cliVersion: "0" });
    const extra = after.skills.packs.find((pack) => pack.id === "extra");
    const common = after.skills.packs.find((pack) => pack.id === "common");
    assert.equal(extra?.installed, true, "装过之后那一行说的是真实锁文件里的状态");
    assert.equal(common?.installed, true, "common 是常驻的那一个，一起被装上");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 用户在 Avenic 之外把配置删掉之后：Provider/Model 两格必须消失（账本里的旧值是
// 过去时，不是现在生效的值），Config Source 那一格要说出配置已不在文件里。
test("an API card stops showing provider and model once the file no longer holds them", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-ext-stale-api-"));
  try {
    const project = path.join(root, "project");
    const env = testEnv(path.join(root, "state"));
    await mkdir(project, { recursive: true });
    await initialize(project, "claude", { authMethod: "api", configScope: "project", sessionScope: "project" });
    await writeApiConfiguration(project, "claude", "project", {
      provider: "DeepSeek",
      baseUrl: "https://provider.fixture.invalid/v1",
      model: "deepseek-chat",
      credential: "fixture-value-not-a-real-credential",
    });
    invalidateAgentStatusCache();
    const fresh = (await buildDashboardData(project, env, { cliVersion: "0" })).agents.find((a) => a.id === "claude")!;
    assert.equal(fieldOf(fresh, "Provider")?.value, "DeepSeek");

    await writeFile(path.join(project, ".claude", "settings.local.json"), "{}\n");
    invalidateAgentStatusCache();
    const stale = (await buildDashboardData(project, env, { cliVersion: "0" })).agents.find((a) => a.id === "claude")!;
    assert.equal(fieldOf(stale, "Provider"), undefined, "账本里的旧 provider 不是现在生效的配置");
    assert.equal(fieldOf(stale, "Model"), undefined);
    assert.equal(
      fieldOf(stale, "Config Source")?.value,
      ".claude/settings.local.json (no longer holds Avenic's configuration)",
      "那一格要说出来文件里已经没有这份配置",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
