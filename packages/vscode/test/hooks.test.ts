import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { HOOK_ACTION_KINDS, HOOK_POLICY, hookActionsPath, type AgentInstallation, type HookAction } from "@avenic/core";
import { AGENT_IDS } from "../src/dashboard/protocol.ts";
import {
  OPENCLAW_DEFAULTS,
  actionFacts,
  agentHooks,
  draftAction,
  hookActionList,
  hookPlanDiff,
  hookPlanFor,
  hooksFacts,
  installAgentHooks,
  nextActionId,
  saveHookActions,
  uninstallAgentHooks,
  type HookOptions,
} from "../src/services/hooks.ts";
import { testEnv } from "./helpers.ts";

// 钩子与通知（宿主侧）：装的是 agent 自己的机制，响的是 Avenic 自己的名单。这里断言
// 真行为——真项目、真文件、真的装与卸——而版本那一栏由注入的探测器给（测试不去跑任何
// CLI，也不碰真机上的任何一个 home）。
//
// 虚构的令牌：任何一条断言里都不许出现真凭据，而这几条断言本身就在证明这件事。

const TOKEN = "hook-test-not-a-real-token";
const SECRET_ARG = "sk-arg-not-a-real-key";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 一个装好的 CLI：版本是表格读到过的那些，所以三行都是「支持」的。 */
async function installed(agentId: string): Promise<AgentInstallation> {
  const version = agentId === "claude" ? "2.1.274" : agentId === "codex" ? "0.154.0" : "1.18.30";
  return { executable: `/${agentId}`, resolvedExecutable: `/${agentId}`, version, installMethod: "npm-global", packageManager: "npm", updateStrategy: { kind: "npm-global", command: null } };
}

function options(environment: Record<string, string | undefined>, extra: Partial<HookOptions> = {}): HookOptions {
  return { environment, detect: installed, ...extra };
}

async function project(root: string): Promise<Record<string, string | undefined>> {
  const dir = path.join(root, "project");
  await mkdir(dir, { recursive: true });
  return testEnv(path.join(root, "state"));
}

const hookLine = (agent: string): string => `avenic hook emit --agent ${agent}`;

test("the three rows are read off the machine, and the version is the one detector's", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-hooks-rows-"));
  try {
    const env = await project(root);
    const dir = path.join(root, "project");
    const facts = await hooksFacts(dir, "project", options(env));

    assert.deepEqual(facts.agents.map((row) => row.agent), [...AGENT_IDS]);
    assert.deepEqual(facts.agents.map((row) => row.displayName), ["Claude Code", "Codex", "OpenCode"]);
    assert.deepEqual(facts.agents.map((row) => row.installed), [false, false, false], "还什么都没装");
    assert.ok(facts.agents.every((row) => row.supported), "三个 CLI 都装着表格读到过的版本");
    assert.ok(facts.agents.every((row) => row.supportNote === null));
    assert.ok(facts.agents.every((row) => row.file.startsWith(dir) || row.file.includes(".claude")), "每个机制都说得出它的文件");
    // 门槛与去重窗口来自 core：20 这个数不许在扩展里再写一遍。
    assert.equal(facts.completedMinSeconds, HOOK_POLICY.completedMinSeconds);
    assert.equal(facts.dedupeSeconds, HOOK_POLICY.dedupeSeconds);
    assert.deepEqual(facts.kinds, [...HOOK_ACTION_KINDS]);
    assert.equal(facts.actionsFile, hookActionsPath(dir));
    const source = await readFile(path.join(pkgDir, "src", "services", "hooks.ts"), "utf8");
    assert.equal(source.includes("completedMinSeconds: 20"), false, "P26：门槛只从 core 读，不在这里写死");

    // 读不到版本的 CLI 就是要说不支持 —— 而且这一句按编辑器的语言说。
    const unknown = { ...env };
    const blind = await agentHooks(dir, "opencode", "project", { environment: unknown, detect: async () => ({ executable: null, resolvedExecutable: null, version: null, installMethod: "npm-global", packageManager: "npm", updateStrategy: { kind: "npm-global", command: null } }) });
    assert.equal(blind.supported, false);
    assert.equal(blind.supportNote, "Unsupported by OpenCode: the installed version could not be read");
    const zh = await agentHooks(dir, "opencode", "project", { environment: unknown, language: "zh-cn", detect: async () => ({ executable: null, resolvedExecutable: null, version: null, installMethod: "npm-global", packageManager: "npm", updateStrategy: { kind: "npm-global", command: null } }) });
    assert.match(zh.supportNote ?? "", /不支持/, "中文编辑器里这一句要是中文");

    // 比机制出现还早的版本：说出来的是「哪家的哪个版本」。
    const old = await agentHooks(dir, "claude", "project", { environment: env, detect: async () => ({ executable: "/claude", resolvedExecutable: "/claude", version: "2.0.1", installMethod: "npm-global", packageManager: "npm", updateStrategy: { kind: "npm-global", command: null } }) });
    assert.equal(old.supportNote, "Unsupported by Claude Code 2.0.1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the file the page names is the file that scope is actually read from", async () => {
  // 名单有两个家：项目的那份在项目的 Avenic 状态里，全机的那份跟着机器状态走。页面上
  // 「你的名单在这个文件」那一行如果永远指着项目文件，切到「全机」的人就在读一个空的
  // 文件，而真正在响的那几条在另一个地方。
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-hooks-file-"));
  try {
    const env = await project(root);
    const dir = path.join(root, "project");
    const globalFacts = await hooksFacts(dir, "global", options(env));
    const projectFacts = await hooksFacts(dir, "project", options(env));
    assert.notEqual(globalFacts.actionsFile, projectFacts.actionsFile, "两个作用域是两个文件");
    assert.equal(projectFacts.actionsFile, hookActionsPath(dir));
    // 写一份全机的：写进去的那个文件，就是这一页该点名的文件 —— 同一个答案，两个来源。
    const saved = await saveHookActions(dir, "global", [{ id: "desktop", kind: "desktop" }], options(env));
    assert.equal(saved.changed, true);
    assert.equal(globalFacts.actionsFile, saved.file);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a file nobody can read costs its own row and nothing else", async () => {
  // 这一页三行来自三次读盘。同名目录（读起来是 EISDIR）是「文件在、读不动」那一类中最
  // 常见的一种。一个读不动的文件只说明**这一个** agent 装没装不知道 —— 另外两行照答，
  // 页面照画，只不过那一行说得出为什么。这一段必须和 CLI 的 status 同源：两边读的是
  // core 同一个 hookStatus。
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-hooks-unreadable-"));
  try {
    const env = await project(root);
    const dir = path.join(root, "project");
    await mkdir(path.join(dir, ".claude", "settings.local.json"), { recursive: true });
    const facts = await hooksFacts(dir, "project", options(env));
    assert.deepEqual(facts.agents.map((row) => row.agent), [...AGENT_IDS], "三个答案一个都不能少");
    const claude = facts.agents.find((row) => row.agent === "claude");
    assert.equal(claude?.installed, null, "读不出来就说不知道，不许说成没装");
    assert.match(claude?.error ?? "", /cannot be read/);
    assert.match(claude?.error ?? "", /settings\.local\.json/);
    const codex = facts.agents.find((row) => row.agent === "codex");
    assert.equal(codex?.installed, false, "另一个 agent 的答案不受牵连");
    assert.equal(codex?.error, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installing writes the agent's own file, keeps what the user had, and uninstalling gives it back", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-hooks-install-"));
  try {
    const env = await project(root);
    const dir = path.join(root, "project");
    // 用户自己的 Claude 设置：装钩子只许往里加一条属于 Avenic 的，别的原样留下。
    const settings = path.join(dir, ".claude", "settings.local.json");
    await mkdir(path.dirname(settings), { recursive: true });
    const before = `${JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] }, MY_OWN: "keep me" }, null, 2)}\n`;
    await writeFile(settings, before);

    const installed = await installAgentHooks(dir, "claude", "project", options(env));
    assert.deepEqual(installed, { changed: true, file: settings });
    const after = await readFile(settings, "utf8");
    assert.ok(after.includes(hookLine("claude")), "装上去的就是 agent 自己认得的那条命令");
    assert.ok(after.includes("keep me"), "用户的键一个都不许丢");

    const facts = await hooksFacts(dir, "project", options(env));
    assert.deepEqual(facts.agents.map((row) => row.installed), [true, false, false]);
    // 再装一次：文件没变，就不写第二次。
    assert.deepEqual(await installAgentHooks(dir, "claude", "project", options(env)), { changed: false, file: settings });

    const removed = await uninstallAgentHooks(dir, "claude", "project", options(env));
    assert.deepEqual(removed, { changed: true, file: settings });
    assert.equal(await readFile(settings, "utf8").catch(() => ""), before, "卸完回到用户那份字节");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a file that is not Avenic's is never touched, and a version that cannot carry the hooks never writes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-hooks-foreign-"));
  try {
    const env = await project(root);
    const dir = path.join(root, "project");
    // OpenCode 的插件文件是 Avenic 整个拥有的那一份：别人的同名文件它一个字都不动。
    const plugin = path.join(dir, ".opencode", "plugins", "avenic-hooks.js");
    await mkdir(path.dirname(plugin), { recursive: true });
    await writeFile(plugin, "// somebody else's plugin\nexport const x = 1;\n");
    const status = (await hooksFacts(dir, "project", options(env))).agents.find((row) => row.agent === "opencode");
    assert.equal(status?.installed, false, "没带标记的文件不算装过 Avenic 的钩子");
    assert.deepEqual(await uninstallAgentHooks(dir, "opencode", "project", options(env)), { changed: false, file: plugin });
    assert.equal(await readFile(plugin, "utf8"), "// somebody else's plugin\nexport const x = 1;\n");
    const refused = await installAgentHooks(dir, "opencode", "project", { ...options(env), detect: async () => ({ executable: null, resolvedExecutable: null, version: "1.0.0", installMethod: "npm-global", packageManager: "npm", updateStrategy: { kind: "npm-global", command: null } }) });
    assert.equal(refused.changed, false);
    assert.equal(await readFile(plugin, "utf8"), "// somebody else's plugin\nexport const x = 1;\n", "不支持就是不写，不是改写别人的文件");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the plan carries the bytes an install would write, and Codex says what it cannot promise", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-hooks-plan-"));
  try {
    const env = await project(root);
    const dir = path.join(root, "project");
    const plan = await hookPlanFor(dir, "claude", "project", options(env));
    assert.equal(plan.file, path.join(dir, ".claude", "settings.local.json"));
    assert.equal(plan.before, await readFile(plan.file, "utf8").catch(() => ""), "before 就是此刻盘上的字节");
    assert.ok(plan.contents.includes(hookLine("claude")), "contents 是要写下去的那一份");
    assert.equal(plan.supported, true);
    assert.equal(plan.caveat, "");

    // Codex 新写的钩子要用户自己审阅过才会响：这一句必须跟着这一行回页面。
    const codex = await hookPlanFor(dir, "codex", "project", options(env));
    assert.match(codex.caveat, /untrusted/, "Codex 的条件由 core 说出来");
    assert.equal((await agentHooks(dir, "codex", "project", options(env))).caveat, codex.caveat);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// P64：预览是用户批准这次写入时读的东西，它不能自己变成那份文件本来要靠权限防住的泄漏点。
// 盘上真有一行凭据（用户自己写进去的），而安装要写的字节与它相邻 —— 预览里那一行必须在，
// 值必须是四个点。
test("the preview of an install carries the lines, and never the credential in them", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-hooks-mask-"));
  try {
    const env = await project(root);
    const dir = path.join(root, "project");
    const file = path.join(dir, ".claude", "settings.local.json");
    // 用户自己在那份文件里放了一个令牌（形状与名字都是真的凭据会有的样子）。
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify({ permissions: { allow: ["Read"] }, AUTH_TOKEN: "sk-live-not-a-real-credential-000000" }, null, 2)}\n`);

    const plan = await hookPlanDiff(dir, "claude", "project", options(env));
    assert.equal(plan.file, file, "预览说的就是这个 agent 自己的文件");
    const shown = plan.lines.map((line) => line.text).join("\n");
    assert.equal(shown.includes("sk-live"), false, "盘上那个凭据不许出现在预览里");
    assert.equal(shown.includes("not-a-real"), false);
    assert.ok(shown.includes("••••"), "打码之后那一行还在，用户看得出改了哪儿");
    assert.ok(plan.lines.some((line) => line.text.includes("avenic hook emit")), "要写下去的钩子那一行当然在");
    assert.ok(plan.lines.every((line) => line.kind !== "same"), "没变的行不画：预览说的是这次改动");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the notification list is one list, and the token never leaves the file", async () => {

  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-hooks-actions-"));
  try {
    const env = await project(root);
    const dir = path.join(root, "project");
    const actions: HookAction[] = [
      { id: "desktop", kind: "desktop" },
      { id: "webhook", kind: "webhook", url: "https://example.test/hook", token: TOKEN, timeoutMs: 2000 },
      { id: "openclaw", kind: "openclaw", gateway: OPENCLAW_DEFAULTS.gateway, path: OPENCLAW_DEFAULTS.path, tokenEnv: "OPENCLAW_HOOK_TOKEN" },
      { id: "command", kind: "command", command: `/usr/bin/notify --token ${SECRET_ARG}` },
    ];
    assert.deepEqual(await saveHookActions(dir, "project", actions, options(env)), { changed: true, file: hookActionsPath(dir) });
    // 向导读的是整份（它要拿真值去预填），页面读的是事实。
    assert.equal(hookActionList(dir, "project", options(env)).length, 4);

    const facts = await hooksFacts(dir, "project", options(env));
    assert.deepEqual(facts.actions.map((row) => row.id), ["command", "desktop", "openclaw", "webhook"]);
    const json = JSON.stringify(facts);
    assert.equal(json.includes(TOKEN), false, "P64：令牌不在这份状态里");
    assert.equal(json.includes(SECRET_ARG), false, "参数里可能是用户自己的凭据，一个都不报");
    const webhook = facts.actions.find((row) => row.id === "webhook");
    assert.deepEqual(webhook && { target: webhook.target, tokenSet: webhook.tokenSet, tokenEnv: webhook.tokenEnv }, { target: "https://example.test/hook", tokenSet: true, tokenEnv: null });
    const openclaw = facts.actions.find((row) => row.id === "openclaw");
    assert.equal(openclaw?.target, `${OPENCLAW_DEFAULTS.gateway}${OPENCLAW_DEFAULTS.path}`, "行上写的是网关与路径");
    assert.equal(openclaw?.tokenSet, false, "变量名不是令牌本身");
    assert.equal(openclaw?.tokenEnv, "OPENCLAW_HOOK_TOKEN");
    const command = facts.actions.find((row) => row.id === "command");
    assert.equal(command?.target, "/usr/bin/notify …", "只报程序名");
    assert.equal(actionFacts({ id: "bare", kind: "command" }).target, "");

    // 写的是整份：删掉一个就是少一个，剩下的原样。
    assert.deepEqual(await saveHookActions(dir, "project", actions.filter((action) => action.id !== "desktop"), options(env)), { changed: true, file: hookActionsPath(dir) });
    assert.deepEqual((await hooksFacts(dir, "project", options(env))).actions.map((row) => row.id), ["command", "openclaw", "webhook"]);
    // 同一个 id 两条：这是一份坏名单，不许写下去。
    await assert.rejects(() => saveHookActions(dir, "project", [{ id: "x", kind: "desktop" }, { id: "x", kind: "desktop" }], options(env)), /share an id/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the four kinds' editors fill from the vendor's own defaults, and refuse what cannot be dispatched", () => {
  assert.deepEqual(draftAction("desktop", {}, []), { id: "desktop", kind: "desktop" });
  // OpenClaw 的默认值就是本机网关与它自己的那一条路径 —— 令牌另有一个字段，不进地址。
  assert.deepEqual(draftAction("openclaw", {}, []), { id: "openclaw", kind: "openclaw", gateway: OPENCLAW_DEFAULTS.gateway, path: OPENCLAW_DEFAULTS.path });
  assert.deepEqual(draftAction("openclaw", { gateway: "http://box:1/", path: "/x", tokenEnv: "T" }, []), { id: "openclaw", kind: "openclaw", gateway: "http://box:1/", path: "/x", tokenEnv: "T" });
  // 一条动作自己的上限对每一种走网络的种类都算数：core 分发 openclaw 时读的就是这个字段
  // （post 走同一条路），所以向导编辑一条手写过上限的 openclaw 动作时不许把它抹掉。
  assert.deepEqual(
    draftAction("openclaw", { gateway: "http://box:1/", path: "/x", timeoutMs: 900 }, []),
    { id: "openclaw", kind: "openclaw", gateway: "http://box:1/", path: "/x", timeoutMs: 900 },
  );
  assert.throws(() => draftAction("openclaw", { path: "x" }, []), /has to start with/);
  assert.throws(() => draftAction("openclaw", { gateway: "box:18789" }, []), /http\(s\) gateway/);
  assert.throws(() => draftAction("openclaw", { token: TOKEN, tokenEnv: "T" }, []), /not both/);

  assert.deepEqual(
    draftAction("webhook", { url: "https://example.test/hook", token: TOKEN, timeoutMs: 900 }, []),
    { id: "webhook", kind: "webhook", url: "https://example.test/hook", token: TOKEN, timeoutMs: 900 },
  );
  assert.throws(() => draftAction("webhook", {}, []), /needs a URL/);
  assert.throws(() => draftAction("webhook", { url: "file:///etc/passwd" }, []), /not an http\(s\) address/);
  // 越界的超时是夹回边界，不是照收：core 自己也会夹，这里夹得更早、说得更早。
  assert.equal(draftAction("webhook", { url: "https://example.test/", timeoutMs: 10 ** 9 }, []).timeoutMs, 30_000);

  // 命令类只有一道门：读过那句警告、确认过之后 draftAction 才认，否则它说的是「去 Advanced」。
  assert.throws(() => draftAction("command", { command: "/usr/bin/notify" }, []), /Advanced/);
  assert.deepEqual(draftAction("command", { command: "/usr/bin/notify" }, [], { advanced: true }), { id: "command", kind: "command", command: "/usr/bin/notify" });
  assert.throws(() => draftAction("command", {}, [], { advanced: true }), /needs a program/);

  // id 是人看得懂的那种，第二条换个后缀。
  assert.equal(nextActionId("webhook", []), "webhook");
  assert.equal(nextActionId("webhook", [{ id: "webhook", kind: "webhook" }, { id: "webhook-2", kind: "webhook" }]), "webhook-3");
  assert.equal(draftAction("webhook", { url: "https://example.test/" }, [{ id: "webhook", kind: "webhook" }]).id, "webhook-2");
  assert.throws(() => draftAction("nope" as never, {}, []), /does not know the notification kind/);
});

// 页面上的每一颗按钮最终都要落在一段真的会做事的代码上。协议里长出一条 action、命令层
// 却没人接，是死控件的另一种长相：页面发了消息，宿主什么都不做，用户看到的是「点了没反应」
// ——比一颗灰着的按钮更难查，因为哪一层都没有错。
//
// 命令层 import vscode，所以这条从源码上钉住它（与 center.test.ts 钉 P34、
// dashboard-media 钉「协议里每个 case 都有人发」同一手法）。
test("every action this page can send reaches a host arm that answers it", async () => {
  const protocol = await readFile(path.join(pkgDir, "src", "dashboard", "protocol.ts"), "utf8");
  const declared = [...protocol.matchAll(/\{ action: "(hook[A-Za-z]*)"[;:]/g)].map((match) => match[1]).sort();
  assert.deepEqual(declared, ["hookActionAdd", "hookActionEdit", "hookActionRemove", "hookInstall", "hookPlan", "hookUninstall", "hooksOpen"], "协议里钩子这一页就是这七条");

  const dispatch = await readFile(path.join(pkgDir, "src", "commands", "dashboard-commands.ts"), "utf8");
  const host = await readFile(path.join(pkgDir, "src", "commands", "hooks-commands.ts"), "utf8");
  for (const id of declared) {
    assert.match(dispatch, new RegExp(`case "${id}":`), `命令层没有接 ${id}`);
    assert.match(host, new RegExp(`case "${id}":`), `hooks-commands 里没有 ${id} 的那一段`);
  }

  // 设置页那一行递回的是 key：路径由宿主解析，解析不出来就什么都不开。
  assert.match(dispatch, /case "revealFile":[\s\S]{0,400}aboutFileFor\(root, action\.key/, "revealFile 要落在宿主解析出来的那条路径上");
});
