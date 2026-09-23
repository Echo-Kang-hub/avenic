import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { extensionBuildOptions } from "../build-options.mjs";
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
  kind: EffectKind;
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
  projectRoot: string;
  stateRoot: string;
}

interface Invocation {
  effects: Effect[];
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
    `import { registered, Uri, ExtensionMode, effects, setAnswers, workspace } from "vscode";`,
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
    `  asAbsolutePath: (value) => value,`,
    `  logPath: ${JSON.stringify(out)},`,
    `};`,
    `if (plan.open === "project") workspace.workspaceFolders = [{ index: 0, name: "project", uri: Uri.file(plan.projectRoot) }];`,
    // 激活自己也会碰宿主（入口树、输出通道）。它那部分不算这一次调用的账，所以先让它
    // 落地再记录起点——否则每个控件都能靠激活期的噪音"产生"一个效果。
    `const settle = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r)); await new Promise((r) => setTimeout(r, 20)); };`,
    `activate(context);`,
    `await settle();`,
    `const before = effects.length;`,
    `setAnswers(plan.answers);`,
    `const startedAt = Date.now();`,
    `let thrown = null;`,
    `try {`,
    `  const handler = registered.get(plan.id);`,
    `  if (handler === undefined) throw new Error("the artifact does not register " + plan.id);`,
    `  await handler();`,
    `} catch (error) { thrown = error instanceof Error ? error.message : String(error); }`,
    `await settle();`,
    // 报告完就结束。扩展自己的后台活会留下句柄（核心探测 npm 版本用的 15 秒 spawn
    // 超时定时器就是一个），等它们到期等于让每一行都付一次那笔时间的账——而那些活
    // 属于编辑器里的下一次刷新，不属于这一次调用。
    `process.stdout.write(JSON.stringify({ effects: effects.slice(before), thrown, ms: Date.now() - startedAt }), () => process.exit(0));`,
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
  const plan: Plan = { id: control.id, open: control.open, answers: control.answers ?? {}, projectRoot: run.project, stateRoot: run.state };
  const planFile = path.join(run.root, "plan.json");
  await writeFile(planFile, JSON.stringify(plan));
  // 子进程拿的是隔离后的环境：状态目录在沙箱里，Agent 的配置根在沙箱里（withAgentHomes），
  // PATH 指向一个空目录。于是「起一个进程」这件事在这里永远不成立——这正是每一行的处境，
  // 也是这个文件敢在开发机上跑、并且不碰网的原因。
  const env: Record<string, string> = { ...testEnv(run.state), PATH: run.empty, Path: run.empty } as Record<string, string>;
  return withAgentHomes(run.home, async () => {
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
