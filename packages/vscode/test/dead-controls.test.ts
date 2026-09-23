import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { getAgent, importProjectSessions, listCanonicalSessions, modelConfigTarget } from "@avenic/core";
import { extensionBuildOptions } from "../build-options.mjs";
import { both, en, rowLabel, sentence, zh, type TextKey } from "../src/i18n/text.ts";
import { initialize } from "../src/services/agents.ts";
import { DASHBOARD_OPEN_FAILED } from "../src/views/dashboard-failure.ts";
import { testEnv, withAgentHomes } from "./helpers.ts";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 死控件 = 0（P24）。一个可点的控件要么接线，要么带着理由禁用；两种都不做的那种，
// 用户点下去只得到「什么都没发生」，而这正是这里要它现形的东西。
//
// The verdict rule, and the whole of it:
//
//   A command invocation whose only observable outcome is `undefined` — no
//   message, no dispatch, no terminal, no external URI, no panel, no prompt —
//   is a dead control, and this file fails naming it.
//
//   A control that refuses because the situation is not set up must SAY SO — a
//   warning or an information message naming the reason. That is the
//   "disabled with a reason" branch, and it passes. A progress report is not an
//   outcome (a bar that appears and reports nothing is the same silence in a
//   nicer costume), and neither is an error notification: an error is what a
//   control looks like when it crashed into its own try/catch, which is a
//   different defect from being unwired. Rows can ask for `error` if that is
//   genuinely the designed answer; none does.
//
// What is invoked is the artifact: the same bundle `npm run build` writes,
// built from the same options, activated against the stub `vscode` in
// test/fixtures. So a row is about what ships, not about what src/ says.
//
// Each row states the situation it is invoked in and the one outcome it exists
// to produce, and `says` pins the sentence that outcome has to carry — because
// "some warning appeared" is not the claim; "the control told the user why it
// would not run" is. The sentence the host speaks comes from `src/i18n/text.ts`
// in the editor's own language, and this stub editor is English — so a `says`
// here is the table's English half (or a fact the table does not hold, like a
// command line the control is about to run).
//
// The second invariant is the first test below: a command id in the manifest
// with no row here is a failure, so a new control cannot be added without
// someone saying what it is supposed to do.
//
// What a row does NOT prove is the happy path of anything that needs a real
// machine: nothing at all is on PATH (no agent CLI, no npm, no git), no Hub is
// reachable, no network is touched. Every row therefore lands on the deepest
// branch this sandbox can honestly reach, which for most controls is a refusal
// with a reason rather than the work itself.

const EFFECT_KINDS = ["message", "prompt", "terminal", "webview", "external", "open", "command"] as const;
type EffectKind = (typeof EFFECT_KINDS)[number];

interface Effect {
  kind: EffectKind | "row";
  level?: string;
  text?: string;
  prompt?: string;
  title?: string;
  message?: string;
  action?: string;
  name?: string;
  line?: string;
  viewType?: string;
  target?: string;
  id?: string;
  /** 面板收到的那条消息本身（`kind: "webview"`、`action: "postMessage"` 时）。 */
  payload?: unknown;
  /** 树上的一行（`kind: "row"`）：编辑器渲染活动栏时会看到的字。 */
  viewId?: string;
  label?: string;
  tooltip?: string;
}

interface Answers {
  quickPick?: (string | null)[];
  inputBox?: string[];
  warning?: (string | null)[];
  information?: (string | null)[];
  error?: (string | null)[];
}

interface Control {
  id: string;
  /** What is open when the user clicks it. */
  open: "empty" | "project";
  /** What the "user" answers at each prompt, in order. Nothing queued = the editor's default. */
  answers?: Answers;
  /** The outcome this control exists to produce. */
  effect: EffectKind;
  /** A sentence that outcome has to carry. */
  says?: string;
  /**
   * 编辑器说的是哪种语言。不写就是桩宿主自己的默认（英文）——每一行问的都是「这个控件
   * 做了什么」，而那与语言无关。
   */
  language?: string;
  /**
   * 控件跑完之后由「页面」发给宿主的那条消息。命令层里有一半的话是回答页面的，那些话
   * 只有这条线能问到——点一次命令到不了。
   */
  message?: object;
  /**
   * 那条消息之后再点一次的控件。页面上的一条消息常常不只是收尾：它会把宿主推进某个
   * 状态里（比如一次正在进行的 mutation），而「这之后还能不能再点」只有再点一次才问得出来。
   */
  after?: string;
  /**
   * 消息之后先等到屏幕上有终端为止（最多几秒）再点 `after`。那一条消息自己做多久是它
   * 自己的事；这个等待问的是「它那件看得见的事做完了没有」，不是「过了多少毫秒」。
   */
  awaitTerminal?: true;
  /**
   * 消息之后先等到页面真的被告知某件事为止（最多几秒）：那一次推送是异步的，它什么时候到
   * 只有到了才算数。等的是「到了没有」，不是「过了多少毫秒」。
   */
  awaitPage?: string;
  /**
   * 这一行在哪个项目里点。默认是那个什么都没配的空项目——每一行的处境。有的控件只有在
   * 「项目配好了、里面还有东西」时才走得动，那一行就得自带一个那样的项目。
   */
  fixture?: "configured" | "api";
  /**
   * 这台"机器"的 PATH 上要额外摆什么（文件名 → 内容）。默认什么都没有：「什么都跑
   * 不起来」是每一行的处境。摆一个真的会慢的可执行文件，是为了问「这一次点击有没有
   * 在等它」——等待是看得见的，只要它够慢。
   */
  bin?: Record<string, string>;
  /**
   * 向扩展挂上的树要一次行。桩宿主不渲染活动栏，而那一行是整个扩展的门面——所以
   * 「它现在写着什么」要显式问一次（真编辑器渲染时做的就是这一步）。
   */
  rows?: true;
}

// One entry per command in the manifest. `says` is the reason, in the control's
// own words: it is what makes the row an assertion about the refusal rather than
// a shrug at any warning that happens to appear.
const CONTROLS: Control[] = [
  // Configure Project answers a project's questions. The whole questionnaire is
  // one progressive QuickPick, so the first thing it does — and all it has done
  // by the time an unanswered row cancels it — is put the first question on
  // screen. That question is the outcome.
  { id: "avenic.agents.configureProject", open: "project", effect: "prompt", says: "Select" },
  // Launch refuses twice over in this sandbox, and both refusals are the design:
  // no agent is configured in a fresh project, so core's status model says so
  // before anything is spawned.
  { id: "avenic.agents.launch", open: "project", effect: "message", says: "is not initialized" },
  // Install/Update share one body. With no agent CLI on PATH this is the deepest
  // honest reach: the npm line the user would watch run, in a terminal.
  { id: "avenic.agents.install", open: "project", effect: "terminal", says: "npm install --global" },
  { id: "avenic.agents.update", open: "project", effect: "terminal", says: "npm install --global" },
  // Remove Agent, on a project where the agent was never configured. There is
  // nothing to remove — which is a thing the user has to be told, not a reason
  // to return into silence. `agents.deinitialize` returns `{ changed, purged,
  // remaining }` — the same three facts `avenic <agent> deinit` prints — and the
  // command now says them instead of dropping them on the floor.
  { id: "avenic.agents.deinit", open: "project", effect: "message", says: "nothing to remove" },
  // Import Sessions reports the four counts whatever they are, zero included.
  { id: "avenic.agents.sessionsImport", open: "project", effect: "message", says: "sessions" },
  { id: "avenic.agents.sessionsWriteback", open: "project", effect: "message", says: "Wrote back" },
  // Both entries open the same panel, on their own section.
  { id: "avenic.dashboard.open", open: "project", effect: "webview", says: "avenic.dashboard" },
  { id: "avenic.sessions.open", open: "project", effect: "webview", says: "avenic.dashboard" },
  // The Hub family is state-dir work and does not need a project open.
  { id: "avenic.catalog.add", open: "empty", effect: "prompt", says: "Hub spec" },
  { id: "avenic.catalog.select", open: "empty", effect: "message", says: "No Hub is registered" },
  { id: "avenic.catalog.default", open: "empty", effect: "message", says: "Current default Hub" },
  { id: "avenic.catalog.sync", open: "empty", effect: "message", says: "No default Hub is selected" },
  // Install Pack with no Hub configured: nothing can be installed, so the
  // command has to name that as the reason rather than return into silence.
  // Its no-argument branch — pick a Pack out of the synced cache because the
  // command palette has no tree row to carry one — is deeper than this sandbox
  // reaches: a cache hit needs a git checkout the reader could not fetch, and
  // this file runs with git off PATH on purpose. The row therefore guards the
  // outer guard, and the picker branch is the one thing here left unproven.
  { id: "avenic.catalog.installPack", open: "empty", effect: "message", says: "No default Hub is selected yet" },
  // The Skills family asks for a scope first; with a project open and nothing
  // installed yet, every branch is a zero-candidate or not-configured refusal.
  { id: "avenic.skills.installPacks", open: "project", effect: "message", says: "No default Hub is selected yet" },
  { id: "avenic.skills.uninstallPacks", open: "project", effect: "message", says: "nothing here to act on" },
  // Add from Repository gets past the scope question and asks for the repo: the
  // second question is the outcome, which is what says distinguishes it by.
  { id: "avenic.skills.addDirect", open: "project", effect: "prompt", says: "owner/repo" },
  { id: "avenic.skills.removeDirect", open: "project", effect: "message", says: "nothing here to act on" },
  { id: "avenic.skills.directList", open: "project", effect: "message", says: "No repository skills" },
  { id: "avenic.skills.adopt", open: "project", effect: "message", says: "nothing here to act on" },
  { id: "avenic.skills.adoptPack", open: "project", effect: "message", says: "No managed skill" },
  { id: "avenic.skills.uninstallPack", open: "project", effect: "message", says: "nothing here to act on" },
  { id: "avenic.skills.reinstallPack", open: "project", effect: "message", says: "nothing here to act on" },
  { id: "avenic.skills.repairLinks", open: "project", effect: "message", says: "already up to date" },
];

interface Plan {
  id: string;
  open: Control["open"];
  answers: Answers;
  language?: string;
  message?: object;
  after?: string;
  awaitTerminal?: true;
  awaitPage?: string;
  rows?: true;
  projectRoot: string;
  stateRoot: string;
}

interface Invocation {
  effects: Effect[];
  outputLines?: string[];
  thrown: string | null;
  /** How long the command itself took. Reported when a row fails, nothing more. */
  ms: number;
}

// One sandbox for the whole file, laid out to make every path the extension can
// reach land inside it: the state directory core reads (AVENIC_STATE_DIR), the
// project it is pointed at, and — through withAgentHomes — the agent homes it
// would otherwise write to in the user's own profile.
let sandboxed: Promise<{ root: string; project: string; state: string; empty: string; home: string }> | null = null;

after(async () => {
  const sandbox = await sandboxed?.catch(() => null);
  if (sandbox) await rm(sandbox.root, { recursive: true, force: true });
});

function sandbox() {
  sandboxed ??= (async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "avenic-controls-"));
    const project = path.join(root, "project");
    const state = path.join(root, "state");
    // An empty directory standing in for PATH. This is not a convenience: it is
    // the situation the rows are written for — a machine with no agent CLI, no
    // npm and no git. Nothing the extension can spawn resolves, which is what
    // lets a row assert "and then it told the user why" without a CLI ever
    // running and without a byte leaving the machine.
    const empty = path.join(root, "bin");
    const home = path.join(root, "home");
    await Promise.all([mkdir(project, { recursive: true }), mkdir(state, { recursive: true }), mkdir(empty, { recursive: true }), mkdir(home, { recursive: true })]);
    return { root, project, state, empty, home };
  })();
  return sandboxed;
}

/**
 * 一个配好了的项目，里面有一条真的共享会话。有的控件只在「有东西可操作」时才走得动，
 * 而那条路的两样前提只能由 core 自己造：项目配置（initialize）与一段从原生对话导入
 * 进来的共享记录（importProjectSessions）。空项目那一行（「未初始化」）靠的正是什么都
 * 没配，所以这个项目有它自己的目录，不动沙箱里那个空的。
 */
let configured: Promise<{ project: string; canonicalId: string }> | null = null;

function configuredProject(): Promise<{ project: string; canonicalId: string }> {
  configured ??= (async () => {
    const run = await sandbox();
    const project = path.join(run.root, "configured");
    const sessionId = "5f7c3b1e-0000-4000-8000-000000000000";
    await mkdir(project, { recursive: true });
    // 配置与导入读的是「这台机器」的那几个变量：这一小段里它们必须都是沙箱里的那一份，
    // 否则原生的那段对话会被写到（或读到）开发者自己的 home 里去。
    const savedState = process.env.AVENIC_STATE_DIR;
    process.env.AVENIC_STATE_DIR = run.state;
    try {
      await withAgentHomes(path.join(run.root, "configured-home"), async () => {
        await initialize(project, "claude", { authMethod: "account", accountScope: "project", sessionScope: "project" });
        // 原生那一段对话住在这次配置真正使用的配置根里（Account·Project → 项目自己的
        // home）。导入走 core 的那条路：手写一份「共享记录」只会测到自己的想象。
        const native = path.join(
          project, ".agents", "local", "claude", "projects",
          path.resolve(project).replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`,
        );
        await mkdir(path.dirname(native), { recursive: true });
        await writeFile(native, `${JSON.stringify({ type: "user", uuid: "u1", sessionId, cwd: project, timestamp: "2026-09-18T00:00:00.000Z", message: { role: "user", content: "A first thing the user typed" } })}\n`);
        // 不跳过捕获：原生那一段先进项目的便携存储，再成为共享记录——这是
        // `avenic claude sessions import` 走的整条路，一步都不省。
        await importProjectSessions(project, "claude", { environment: testEnv(run.state) });
      });
    } finally {
      if (savedState === undefined) delete process.env.AVENIC_STATE_DIR;
      else process.env.AVENIC_STATE_DIR = savedState;
    }
    const sessions = await listCanonicalSessions(project);
    assert.equal(sessions.length, 1, `这个项目该正好有一条共享会话，实际 ${sessions.length} 条`);
    return { project, canonicalId: sessions[0].id };
  })();
  return configured;
}

/** 文件里那一把钥匙：虚构的，而且任何一条断言里都不许出现在文件之外的地方。 */
const FILE_KEY = "sk-test-not-a-real-key";
const FILE_BASE_URL = "https://api.deepseek.com/anthropic";

/**
 * 一个「已经选了 API」的项目，文件是用户自己写的：端点、模型、凭据，外加几个不属于
 * Avenic 的键。模型配置中心只有在这个处境里才写得动（Account 的项目上 core 会拒绝
 * 那一次写，那是另一条路）。它有自己的目录，不动沙箱里那个空项目，也不动配好了会话的
 * 那一个。
 */
let api: Promise<{ project: string }> | null = null;

function apiProject(): Promise<{ project: string }> {
  api ??= (async () => {
    const run = await sandbox();
    const project = path.join(run.root, "api");
    await mkdir(project, { recursive: true });
    const savedState = process.env.AVENIC_STATE_DIR;
    process.env.AVENIC_STATE_DIR = run.state;
    try {
      await withAgentHomes(path.join(run.root, "api-home"), async () => {
        await initialize(project, "claude", { authMethod: "api", configScope: "project", sessionScope: "project" });
      });
    } finally {
      if (savedState === undefined) delete process.env.AVENIC_STATE_DIR;
      else process.env.AVENIC_STATE_DIR = savedState;
    }
    // 用户自己写的文件：Avenic 会在这份文件上合并，而合并的规矩就是别的东西一个字都不动。
    const target = modelConfigTarget(project, "claude", "project");
    assert.ok(target !== null, "Claude 的项目作用域配置有它自己的路径");
    await mkdir(path.dirname(target.file), { recursive: true });
    await writeFile(target.file, `${JSON.stringify(API_DOCUMENT, null, 2)}\n`, "utf8");
    return { project };
  })();
  return api;
}

const API_DOCUMENT = {
  env: {
    ANTHROPIC_BASE_URL: FILE_BASE_URL,
    ANTHROPIC_AUTH_TOKEN: FILE_KEY,
    ANTHROPIC_MODEL: "deepseek-v4-pro",
    MY_OWN_VARIABLE: "keep me",
  },
  permissions: { allow: ["Bash(ls:*)"] },
};

// The artifact, not the sources — the same two-pass mechanism build.test.ts
// uses, so both files ask their questions of the same shipped bundle. The second
// pass bundles a loader that aliases the bundle's `vscode` import to the stub,
// activates it with a fake ExtensionContext, and then invokes one command and
// prints what the stub recorded.
let artifact: Promise<{ activation: string }> | null = null;

function builtArtifact() {
  artifact ??= buildArtifact();
  return artifact;
}

async function buildArtifact() {
  const { root } = await sandbox();
  const out = await mkdtemp(path.join(root, "bundle-"));
  const outfile = path.join(out, "extension.js");
  await build(extensionBuildOptions({ directory: pkgDir, outfile }));

  const loader = path.join(out, "invoke.mjs");
  await writeFile(loader, [
    `import { activate } from ${JSON.stringify(outfile)};`,
    `import { readFile } from "node:fs/promises";`,
    `import { registered, Uri, ExtensionMode, env, effects, outputLines, sendToPanels, setAnswers, workspace, treeViews } from "vscode";`,
    `const plan = JSON.parse(await readFile(process.argv[2], "utf8"));`,
    `const state = { get: () => undefined, update: async () => {}, keys: () => [] };`,
    `const context = {`,
    `  subscriptions: [],`,
    `  extensionUri: Uri.file(${JSON.stringify(pkgDir)}),`,
    `  extensionPath: ${JSON.stringify(pkgDir)},`,
    `  extension: { id: "avenic.avenic-agent-manager", packageJSON: { version: "0.0.0" } },`,
    `  globalState: state, workspaceState: { get: () => undefined, update: async () => {}, keys: () => [] },`,
    `  secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },`,
    `  environmentVariableCollection: {},`,
    `  extensionMode: ExtensionMode.Test,`,
    // 真编辑器一定有这个目录，面板建起来时要读它（设置/关于那两页的事实从这里来）。
    // 少了它，建面板这一步会抛在 catch 里、只剩一句「打不开」——那是桩漏了一块，
    // 不是产品的问题，而下面那条按语言说话的行正是靠这一步才够得着的。
    `  globalStorageUri: Uri.file(${JSON.stringify(path.join(root, "globalStorage"))}),`,
    `  asAbsolutePath: (value) => value,`,
    `  logPath: ${JSON.stringify(out)},`,
    `};`,
    `if (plan.open === "project") workspace.workspaceFolders = [{ index: 0, name: "project", uri: Uri.file(plan.projectRoot) }];`,
    // 编辑器用哪种语言，是宿主自己知道的事。命令层在注册时读一次，所以要在激活之前
    // 摆好——摆晚了，读到的是桩宿主的默认，而那正好是这条测试要能分辨的差别。
    `if (plan.language !== undefined) env.language = plan.language;`,
    // 激活自己也会碰宿主（入口树、输出通道）。它那部分不算这一次调用的账，所以先让它
    // 落地再记录起点——否则每个控件都能靠激活期的噪音"产生"一个效果。
    `const settle = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r)); await new Promise((r) => setTimeout(r, 20)); };`,
    `activate(context);`,
    `await settle();`,
    `const before = effects.length;`,
    // 树上要一次行。真编辑器渲染活动栏时做的就是这一步——桩宿主里没有别人会做。
    `if (plan.rows === true) {`,
    `  for (const view of treeViews) {`,
    `    for (const row of view.treeDataProvider.getChildren() ?? []) {`,
    `      effects.push({ kind: "row", viewId: view.viewId, label: String(row.label), tooltip: String(row.tooltip), command: row.command?.command });`,
    `    }`,
    `  }`,
    `}`,
    `setAnswers(plan.answers);`,
    `const startedAt = Date.now();`,
    `let thrown = null;`,
    `try {`,
    `  const handler = registered.get(plan.id);`,
    `  if (handler === undefined) throw new Error("the artifact does not register " + plan.id);`,
    `  await handler();`,
    // 面板开出来之后，页面那半边照原样再走一步：命令层里回答页面的那些句子只有这条线能问到。
    `  if (plan.message !== undefined) await sendToPanels(plan.message);`,
    // 页面那一条消息自己也要跑一会儿（它可能开着终端、握着队列）。等它那件看得见的事
    // 做完，再点下一次：「上一条消息之后还能不能点」问的就是这一刻。
    `  if (plan.awaitTerminal === true) {`,
    `    for (let i = 0; i < 250 && !effects.some((effect) => effect.kind === "terminal" && effect.action === "sendText"); i += 1) {`,
    `      await new Promise((r) => setTimeout(r, 20));`,
    `    }`,
    `  }`,
    `  await settle();`,
    // 页面被告知的那一次是异步推送：等它到。「到了没有」可以问，「还有多久」问不出来。
    `  if (plan.awaitPage !== undefined) {`,
    `    for (let i = 0; i < 250; i += 1) {`,
    `      const told = effects.some((effect) => effect.kind === "webview" && effect.action === "postMessage" && JSON.stringify(effect.payload).includes(plan.awaitPage));`,
    `      if (told) break;`,
    `      await new Promise((r) => setTimeout(r, 20));`,
    `    }`,
    `  }`,
    `  if (plan.after !== undefined) {`,
    `    const next = registered.get(plan.after);`,
    `    if (next === undefined) throw new Error("the artifact does not register " + plan.after);`,
    `    await next();`,
    `  }`,
    `} catch (error) { thrown = error instanceof Error ? error.message : String(error); }`,
    `await settle();`,
    // 报告完就结束。扩展自己的后台活会留下句柄（核心探测 npm 版本用的 15 秒 spawn
    // 超时定时器就是一个），等它们到期等于让每一行都付一次那笔时间的账——而那些活
    // 属于编辑器里的下一次刷新，不属于这一次调用。
    `process.stdout.write(JSON.stringify({ effects: effects.slice(before), outputLines: outputLines.slice(0), thrown, ms: Date.now() - startedAt }), () => process.exit(0));`,
    "",
  ].join("\n"));

  const activation = path.join(out, "activation.mjs");
  await build({
    ...extensionBuildOptions({ directory: pkgDir, outfile: activation }),
    entryPoints: [loader],
    // 别名要生效，vscode 就不能是 external——external 的导入 esbuild 原样保留，
    // 于是产物会带着一个运行时解析不了的 bare import。
    external: [],
    alias: { vscode: path.join(pkgDir, "test", "fixtures", "vscode-stub.mjs") },
    logLevel: "silent",
  });
  return { activation };
}

async function invoke(control: Control): Promise<Invocation> {
  const run = await sandbox();
  const { activation } = await builtArtifact();
  const projectRoot =
    control.fixture === "configured" ? (await configuredProject()).project
    : control.fixture === "api" ? (await apiProject()).project
    : run.project;
  const plan: Plan = { id: control.id, open: control.open, answers: control.answers ?? {}, language: control.language, message: control.message, after: control.after, awaitTerminal: control.awaitTerminal, awaitPage: control.awaitPage, rows: control.rows, projectRoot, stateRoot: run.state };
  const planFile = path.join(run.root, "plan.json");
  await writeFile(planFile, JSON.stringify(plan));
  for (const [name, content] of Object.entries(control.bin ?? {})) {
    await writeFile(path.join(run.empty, name), content, { mode: 0o755 });
  }
  // 子进程拿的是隔离后的环境：状态目录在沙箱里，Agent 的配置根在沙箱里，PATH 指向一个
  // 空目录。于是「起一个进程」这件事在这里永远不成立——这正是每一行的处境，也是这个文件
  // 敢在开发机上跑、并且不碰网的原因。环境在 withAgentHomes 里才成形，是为了让那几个
  // 配置根真的进到子进程里：宿主给的每个环境变量都该是沙箱里的那一个，一个都不例外。
  return withAgentHomes(run.home, async () => {
    const env: Record<string, string> = { ...testEnv(run.state), PATH: run.empty, Path: run.empty } as Record<string, string>;
    const stdout = execFileSync(process.execPath, [activation, planFile], { encoding: "utf8", env, cwd: run.root, timeout: 120_000, stdio: ["ignore", "pipe", "pipe"] });
    return JSON.parse(stdout) as Invocation;
  });
}

/** The one string that identifies an effect, for `says` to be found in. */
function describe(effect: Effect): string {
  switch (effect.kind) {
    case "message": return `${effect.level}: ${effect.text}`;
    case "prompt": return `${effect.prompt}: ${effect.title} ${effect.message ?? ""}`;
    case "terminal": return `${effect.action}: ${effect.line ?? effect.name}`;
    case "webview": return `${effect.viewType} ${effect.action}`;
    case "external":
    case "open": return String(effect.target);
    case "command": return String(effect.id);
    default: return JSON.stringify(effect);
  }
}

// A control with no row here cannot ship: the harness has to be told what the
// new one is supposed to do before it can say the new one works.
test("every command the manifest declares has a row saying what it must do", async () => {
  const manifest = JSON.parse(await readFile(path.join(pkgDir, "package.json"), "utf8"));
  const declared: string[] = manifest.contributes.commands.map((entry: { command: string }) => entry.command);
  const covered = new Set(CONTROLS.map((control) => control.id));
  const missing = declared.filter((id) => !covered.has(id));
  const extra = CONTROLS.map((control) => control.id).filter((id) => !declared.includes(id));
  assert.deepEqual(missing, [], "清单新增了命令，但没人在这里说它该做什么（死控件就是这样混进来的）");
  assert.deepEqual(extra, [], "这里有一行指向清单里不存在的命令");
  assert.equal(CONTROLS.length, new Set(CONTROLS.map((c) => c.id)).size, "每个命令只能有一行");
});

for (const control of CONTROLS) {
  test(`${control.id} — must produce a ${control.effect}`, async () => {
    const { effects, thrown, ms } = await invoke(control);
    const inSituation = control.open === "project" ? "打开了一个项目文件夹" : "什么都没打开";
    const produced = effects.map(describe).join(" | ");
    if (thrown !== null) assert.fail(`${control.id} 把异常抛到了命令体外（${inSituation}，${ms}ms）：${thrown}`);
    const matched = effects.filter((effect) => effect.kind === control.effect);
    assert.ok(
      matched.length > 0,
      // 「死控件」这四个字只留给真的什么都没做的那一种；做出了别的事、只是不是它该做的那件，
      // 是另一种毛病，说成「什么都没发生」就把读者引错了方向。
      effects.length === 0
        ? `${control.id} 是个死控件：${inSituation}时点它，什么都发生不了（${ms}ms 就回来了）——没有消息、没有派发、没有终端、没有外部 URI、没有面板、没有提问。`
        : `${control.id} 没有产生它该产生的结果（${control.effect}）：${inSituation}时点它，记录到的只有：${produced}`,
    );
    if (control.says !== undefined) {
      assert.ok(
        matched.some((effect) => describe(effect).includes(control.says!)),
        `${control.id} 没有说出理由「${control.says}」（禁用分支必须说明原因）。它说出的是：${produced}`,
      );
    }
  });
}

/**
 * 一台 registry 很慢的机器：PATH 上的 npm 要好几秒才回答。
 *
 * 等待不能靠 sleep/ping 这类系统命令：这台"机器"的 PATH 是空的（这正是每一行的处境），
 * 连它们都找不到——脚本会一路走到下一行，于是"慢"的假象当场消失，测的就不是等待了。
 * 只有解释器本身是绝对路径，所以等待由它来做：这条路与 PATH 无关。
 */
function slowNpm(): Record<string, string> {
  const wait = `"${process.execPath}" -e "setTimeout(function(){process.exit(0)},3000)"`;
  return process.platform === "win32"
    ? { "npm.cmd": `@echo off\r\n${wait}\r\necho 1.2.3\r\n` }
    : { npm: `#!/bin/sh\n${wait}\necho 1.2.3\n` };
}

// 「启动」是一次点击，而点击不许等网络（P26）。这个 agent 在这台机器上是 npm 装的那种，
// 于是「有没有新版」那一问会去跑 `npm view`：网慢的时候，用户按下启动、终端要过十几秒才
// 开——而那一问的答案（有没有新版）启动根本不用，它只要本机这两个事实：配没配、CLI 在不在。
// 所以这条把 PATH 上的 npm 换成一个要好几秒才回答的东西：等它，就看得见。
test("the launch gate answers from this machine, and does not wait on the registry", async () => {
  const control: Control = { id: "avenic.agents.launch", open: "project", effect: "message", says: "is not initialized", bin: slowNpm() };
  const { effects, ms } = await invoke(control);
  const said = effects.map(describe).join(" | ");
  assert.ok(said.includes("is not initialized"), `启动那一问本来就该当场回答（这一次用了 ${ms}ms），它说的是：${said}`);
  assert.ok(ms < 2_000, `点一次启动等了 ${ms}ms：它在等 registry（npm），而那一次点击不该有网络（P26）`);
});

// 「继续」是一次点击，不是接下来几个小时的锁：会话在终端里跑着的时候，用户还要能配置、
// 能启动别的 agent、能刷新。队列（连同挡在它后面的每一个入口）与进度条都只该陪到终端
// 起来为止——收官（捕获这一段对话、写映射）跟在终端关闭之后，那是那条会话自己的时间线。
// 这一行问的就是「这之后还能不能再点」：所以消息之后再点一次。队列还被握着时，那一次
// 点击得到的只有「有一个操作正在运行」；放开了，才轮得到它自己要说的话。
test("continuing a session lets the next click through while that session runs", async () => {
  const { canonicalId } = await configuredProject();
  const { effects, thrown, ms } = await invoke({
    id: "avenic.dashboard.open", open: "project", effect: "webview",
    message: { type: "action", action: "continueShared", id: canonicalId },
    after: "avenic.agents.launch",
    awaitTerminal: true,
    fixture: "configured",
  });
  assert.equal(thrown, null, `这一次点击把异常抛到了命令体外（${ms}ms）`);
  // 先证明继续真的起来了：终端里那一行就是这次的启动命令。没起来的话，后面那一问
  // 说什么都说明不了队列的事。
  const at = effects.findIndex((effect) => effect.kind === "terminal" && effect.action === "sendText");
  assert.ok(at >= 0, `这一次继续没有把 CLI 跑起来：${effects.map(describe).join(" | ")}`);
  assert.match(String(effects[at].line), /claude/, `终端里跑的是这个 agent 的 CLI：${String(effects[at].line)}`);
  // 终端起来之后的那一次点击，它的效果全在这里。
  const later = effects.slice(at + 1);
  const said = later.map(describe).join(" | ");
  assert.equal(
    later.some((effect) => describe(effect).includes(en("flow.busy"))),
    false,
    `那一条会话还在终端里跑着，队列却还握着——这之后的每一次点击都只会得到这句话：${said}`,
  );
  assert.ok(
    later.some((effect) => effect.kind === "prompt" || effect.kind === "message" || effect.kind === "terminal"),
    `终端起来之后的这一次点击什么都没发生：${said}`,
  );
});

// 模型配置中心这一页唯一写盘的那一下：「应用」。它写的是 agent 自己的文件，不是 Avenic 的
// 存储——整页的意义都在这一下上。服务层有它自己的测试，而这里问的是别的事：面板把一条
// 消息递回来时，产物真的改了盘上的字节（判据由另一个进程读过文件给出，不是看返回值），
// 以及盘上的那把钥匙有没有从别的出口漏出去。
test("applying from the Model Config page rewrites the agent's own file, and nothing else", async () => {
  const { project } = await apiProject();
  const target = modelConfigTarget(project, "claude", "project");
  assert.ok(target !== null, "Claude 的项目作用域配置有它自己的路径");
  const before = JSON.parse(await readFile(target.file, "utf8"));
  const { effects, outputLines, thrown, ms } = await invoke({
    id: "avenic.dashboard.open",
    open: "project",
    effect: "webview",
    fixture: "api",
    // 写完之后面板会重读一次项目再推给页面；「写了」那句结论就在那一次推送里。
    awaitPage: "\"written\":true",
    message: {
      type: "action",
      action: "centerApply",
      agent: "claude",
      // 表单里没有凭据：这一次换的是模型，不是钥匙——文件里那一把原样留着。
      draft: { provider: "deepseek", baseUrl: FILE_BASE_URL, model: "deepseek-v4-flash", credential: null, roles: {}, blocks: [] },
    },
  });
  assert.equal(thrown, null, `应用这一次点击把异常抛到了命令体外（${ms}ms）`);
  const after = JSON.parse(await readFile(target.file, "utf8"));
  assert.equal(after.env?.ANTHROPIC_MODEL, "deepseek-v4-flash", `表单里的模型没落进文件：${JSON.stringify(after)}`);
  assert.equal(after.env?.ANTHROPIC_AUTH_TOKEN, FILE_KEY, "换模型把文件里那把钥匙动了——表单里没有它，它就该一个字都不动");
  assert.deepEqual(after.permissions, before.permissions, "文件里住着的别的键被动了");
  assert.equal(after.env?.MY_OWN_VARIABLE, "keep me", "用户自己的变量没保住");
  // 两条出口各问一次：页面被告知「写了」（否则用户看着的是一张没发生过的事的表单），
  // 而这一页从头到尾都不许把文件里的钥匙说出去——它只递「有没有」，不递值。
  const posted = effects.filter((effect) => effect.kind === "webview" && effect.action === "postMessage").map((effect) => JSON.stringify(effect.payload)).join("\n");
  assert.ok(posted.includes("\"written\":true"), `页面没被告知这一次真的写了：${posted.slice(0, 600)}`);
  const spoken = `${effects.map(describe).join(" | ")}\n${(outputLines ?? []).join("\n")}`;
  assert.ok(spoken.includes(sentence("en", "center.activity-written", { agent: getAgent("claude").displayName })), `这一次写盘没有留下它该留下的那一行：${spoken.slice(0, 600)}`);
  assert.equal(spoken.includes(FILE_KEY), false, "文件里的钥匙出现在了输出通道或发给页面的字里——它只该待在文件里");
});

// 上面每一行问的都是「这个控件做了什么」，答案都是英文编辑器里的。但一句要显示的话是
// 宿主说的，而只有宿主知道编辑器在用哪种语言——流程与 core 都只递键。这条把同一个控件
// 放进中文编辑器再点一次：屏幕上那句话必须换成词表的中文那一半。少了它，「宿主把自己的
// 语言传下去」这一段只剩类型检查看着，而类型对「说的是哪一半」一个字都说不了。
test("the editor's own language reaches the words the host puts on screen", async () => {
  // 问一句（Skills 那一层）和说一句理由（仪表盘那一层）各来一次：两层各自读一次
  // 编辑器的语言，谁也不是靠别人替它读的。
  const asked = await invoke({ id: "avenic.skills.addDirect", open: "project", effect: "prompt", language: "zh-cn" });
  assert.equal(asked.thrown, null);
  const question = asked.effects.map(describe).join(" | ");
  assert.ok(question.includes(zh("skills.repo-prompt")), `中文编辑器里这个问题得是中文（${zh("skills.repo-prompt")}），实际说的是：${question}`);
  assert.equal(question.includes(en("skills.repo-prompt")), false, `中文编辑器里不该出现英文那一半：${question}`);

  // 面板里那一半的话是回答页面的，点一次命令到不了——所以开面板，再由「页面」把
  // 继续共享会话那条消息递回去。这个项目里没有那条会话，宿主必须把理由说出来。
  const answered = await invoke({
    id: "avenic.dashboard.open",
    open: "project",
    effect: "message",
    language: "zh-cn",
    message: { type: "action", action: "continueShared", id: "5f7c3b1e-0000-4000-8000-000000000000" },
  });
  assert.equal(answered.thrown, null);
  // 面板是真的建起来了：打不开时用户读到的那句结论只说结论，而它一旦出现，这条测试
  // 问的就成了别的东西——所以先把「没有失败」钉住，再去看那句话说的是哪种语言。
  const failed = (answered.outputLines ?? []).filter((line) => line.includes(DASHBOARD_OPEN_FAILED));
  assert.deepEqual(failed, [], `面板这一步就不该失败，通道里写着：${failed.join(" / ")}`);
  const reason = answered.effects.map(describe).join(" | ");
  assert.ok(reason.includes(zh("sessions.no-successor")), `中文编辑器里这句理由得是中文（${zh("sessions.no-successor")}），实际说的是：${reason}`);
  assert.equal(reason.includes(en("sessions.no-successor")), false, `中文编辑器里不该出现英文那一半：${reason}`);
});

// 活动栏那一行是整个扩展的门面：窗口一开它就在。它上面的字也是宿主说的话——中文编辑器
// 里那一行得说中文，和别的界面一样。桩宿主不渲染树，所以这条自己走一遍编辑器会做的那
// 一步：向扩展挂上的树要一次行，看用户会看到什么。
//
// 四行的标签与提示语各自钉在词表的一个键上：写死的字与表里的字在这里是不同的字符串，
// 所以这一条问的不是「有没有中文」，而是「说的是不是这一句」。
test("the activity-bar rows speak the editor's language like everything else", async () => {
  const NO_FOLDER_LABELS: TextKey[] = ["launcher.dashboard", "launcher.configure", "nav.sessions", "launcher.skills"];
  const WITH_PROJECT_LABELS = NO_FOLDER_LABELS.filter((key) => key !== "launcher.configure");
  const NOTES: TextKey[] = ["launcher.dashboard-note", "launcher.sessions-note", "launcher.skills-note"];
  const rows = async (open: Control["open"], language?: string) => {
    const { effects, thrown, ms } = await invoke({ id: "avenic.dashboard.open", open, effect: "webview", rows: true, language });
    assert.equal(thrown, null, `这一次点击把异常抛到了命令体外（${ms}ms）`);
    const drawn = effects.filter((effect) => effect.kind === "row");
    assert.ok(drawn.length > 0, `活动栏那一行没有画出来：${effects.map(describe).join(" | ")}`);
    return drawn;
  };
  const labelsOf = (drawn: Effect[]) => drawn.map((row) => String(row.label));

  // 英文编辑器：标签就是词表里的英文那一半，一个字都不多、不少。
  const english = await rows("project");
  assert.deepEqual(labelsOf(english), WITH_PROJECT_LABELS.map((key) => en(key)), `英文编辑器里活动栏说的是：${labelsOf(english).join(" | ")}`);
  // 中文编辑器：同一个键，换的只是显示的那一半——英文那半仍然是主标签。
  const chinese = await rows("project", "zh-cn");
  assert.deepEqual(labelsOf(chinese), WITH_PROJECT_LABELS.map((key) => rowLabel("zh-cn", key)), `中文编辑器里活动栏说的是：${labelsOf(chinese).join(" | ")}`);
  assert.equal(labelsOf(chinese).some((text) => text.includes(zh("nav.sessions"))), true, `中文那一半得在：${labelsOf(chinese).join(" | ")}`);
  assert.equal(labelsOf(english).some((text) => text.includes(zh("nav.sessions"))), false, `英文编辑器里不该出现中文那一半：${labelsOf(english).join(" | ")}`);
  // 提示语在两种语言下都是两半都在（悬停的那一句不跟着界面语言变），而且它就是词表里那一句。
  for (const drawn of [english, chinese]) {
    assert.deepEqual(drawn.map((row) => String(row.tooltip)), NOTES.map((key) => both(key)), `提示语该是词表里那一句：${drawn.map((row) => String(row.tooltip)).join(" | ")}`);
  }
  // 没打开文件夹时多出来的那一行（Configure Project）说的是同一个词表里的名字。
  const closed = await rows("empty");
  assert.deepEqual(labelsOf(closed), NO_FOLDER_LABELS.map((key) => en(key)), `没有文件夹时活动栏说的是：${labelsOf(closed).join(" | ")}`);
});
