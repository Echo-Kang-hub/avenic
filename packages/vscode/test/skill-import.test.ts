import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  importSkillsFlow,
  type ImportChoice,
  type ImportSummary,
  type ImportUi,
} from "../src/ui/skill-import.ts";
import { sentence, type TextKey } from "../src/i18n/text.ts";
import {
  importCwd,
  importService,
  type DirectDiscovery,
  type DirectInstall,
  type Scope,
  type ScopeFacts,
  type SkillImport,
} from "../src/services/skills.ts";
import { testEnv } from "./helpers.ts";

// 面板上的 Import Skill 与 CLI 的 Add 流程是同一场问答：来源 → 发现 → 多选 Skill →
// Install to → Scope → 摘要 → 确认。这里钉的是那场问答本身——每一步答什么、少答一步
// 会怎样、以及 core 最后收到的到底是哪几个名字、哪几个目标、哪个作用域。
// 流程不 import vscode；宿主的两件事（提示与 write）都是注入的，所以它整场都能被驱动。

// ---- 假宿主 ----

interface Script {
  /** 输入框的回答；undefined = Esc（取消）。 */
  source?: string;
  skills?: string[];
  targets?: string[];
  scope?: Scope;
  confirm?: boolean;
}

interface Recorder {
  asked: number;
  /** 每一步被问到的顺序（问题的标题，来源与确认各记一个名字）：顺序本身就是流程的一部分。 */
  sequence: string[];
  skillItems: ImportChoice<string>[];
  targetItems: ImportChoice<string>[];
  scopeItems: ImportChoice<Scope>[];
  confirmTitle: string | null;
  summary: ImportSummary | null;
  infos: string[];
  warns: string[];
  /** 这个假宿主被要求说的每一个键，按被问的顺序。 */
  said: string[];
  progressTitles: string[];
  reports: string[];
}

// 假宿主说哪种语言，由它的构造参数决定 —— 就像真宿主由 vscode.env.language 决定。
// 句子不是从这里递回来的：流程交出键与值，宿主把它翻成人话（这正是真宿主做的事）。
function fakeUi(script: Script = {}, language = "en"): { ui: ImportUi; log: Recorder } {
  const log: Recorder = {
    asked: 0,
    sequence: [],
    skillItems: [],
    targetItems: [],
    scopeItems: [],
    confirmTitle: null,
    summary: null,
    infos: [],
    warns: [],
    said: [],
    progressTitles: [],
    reports: [],
  };
  /** 不带记录地翻一句：给「这句是谁说的」之外的比较用。 */
  const said = (key: TextKey, values?: Record<string, string | number>) => sentence(language, key, values);
  const say = (key: TextKey, values?: Record<string, string | number>) => { log.said.push(key); return said(key, values); };
  const ui: ImportUi = {
    sentence: (key, values) => say(key, values),
    askSource: async () => { log.asked += 1; log.sequence.push("source"); return script.source; },
    pickMany: async <T>(title: string, items: ImportChoice<T>[]) => {
      log.sequence.push(title);
      if (title === said("skills.import-select")) {
        log.skillItems = items as ImportChoice<string>[];
        return script.skills as T[] | undefined;
      }
      log.targetItems = items as ImportChoice<string>[];
      return script.targets as T[] | undefined;
    },
    pickOne: async <T>(title: string, items: ImportChoice<T>[]) => {
      log.sequence.push(title);
      log.scopeItems = items as ImportChoice<Scope>[];
      return script.scope as T | undefined;
    },
    confirm: async (title, summary) => { log.sequence.push("confirm"); log.confirmTitle = title; log.summary = summary; return script.confirm; },
    info: (message) => log.infos.push(message),
    warn: (message) => log.warns.push(message),
    // 进度只是一层包装：测试里同步穿透，让每一步都在同一条调用链上；标题与进度里那行字
    // 记下来，因为那也是宿主替流程说的话。
    progress: async (title, work) => { log.progressTitles.push(title); return work((message) => log.reports.push(message)); },
  };
  return { ui, log };
}

// ---- 假服务（core 的替身）：记录装的是什么，不写盘 ----

const REVISION = "abcdef1234567890abcdef1234567890abcdef12";

function projectFacts(): ScopeFacts {
  return {
    scope: "project",
    label: "Project",
    root: path.join("C:", "work", "my-app"),
    configFile: path.join("C:", "work", "my-app", ".avenic.json"),
    targets: [
      { id: "claude", label: "Claude Code", path: ".claude/skills", canonical: false },
      { id: "agents", label: "Codex / OpenCode / universal agents", path: ".agents/skills", canonical: true },
    ],
  };
}

function globalFacts(): ScopeFacts {
  return {
    scope: "global",
    label: "Global",
    root: path.join("C:", "Users", "someone"),
    configFile: path.join("C:", "Users", "someone", ".config", "avenic", "config.json"),
    targets: [
      { id: "claude", label: "Claude Code", path: ".claude/skills", canonical: false },
      { id: "agents", label: "Codex / OpenCode / universal agents", path: ".agents/skills", canonical: true },
    ],
  };
}

interface InstallCall { repo: string; names: string[]; scope: Scope; targets: string[] }

function fakeService(options: { names?: string[]; managed?: string[]; alreadyInstalled?: boolean } = {}) {
  const calls: InstallCall[] = [];
  let discovered = 0;
  const service: SkillImport = {
    discover: async (repo): Promise<DirectDiscovery> => {
      discovered += 1;
      return { sourceId: repo, revision: REVISION, names: options.names ?? ["alpha", "beta"] };
    },
    managed: async () => options.managed ?? ["beta"],
    facts: async (scope) => (scope === "project" ? projectFacts() : globalFacts()),
    install: async (repo, names, scope, targets): Promise<DirectInstall> => {
      calls.push({ repo, names, scope, targets });
      return { names, sourceId: repo, revision: REVISION, ...(options.alreadyInstalled === true ? { alreadyInstalled: true } : {}) };
    },
  };
  return { service, calls, discoveries: () => discovered };
}

const REPO = "owner/repo";

// ---- 取消：每一步都只留下「什么都没装」 ----

test("cancelling the source prompt asks core nothing and installs nothing", async () => {
  const { service, calls, discoveries } = fakeService();
  const { ui, log } = fakeUi({});
  const outcome = await importSkillsFlow(service, ui);
  assert.equal(outcome.kind, "cancelled");
  assert.equal(log.asked, 1);
  assert.deepEqual(calls, []);
  assert.equal(discoveries(), 0, "来源都没给，就不该去克隆");
});

test("an empty source prompt is a cancel, not a repository named nothing", async () => {
  const { service, calls, discoveries } = fakeService();
  const outcome = await importSkillsFlow(service, fakeUi({ source: "   " }).ui);
  assert.equal(outcome.kind, "cancelled");
  assert.deepEqual(calls, []);
  assert.equal(discoveries(), 0);
});

test("declining the skill picker stops before targets are even asked", async () => {
  const { service, calls } = fakeService();
  const { ui, log } = fakeUi({ source: REPO, skills: [] });
  const outcome = await importSkillsFlow(service, ui);
  assert.equal(outcome.kind, "cancelled");
  assert.deepEqual(log.targetItems, [], "空选择是取消，不是「就这样吧」");
  assert.deepEqual(calls, []);
});

test("cancelling the confirmation installs nothing", async () => {
  const { service, calls } = fakeService();
  const { ui, log } = fakeUi({ source: REPO, skills: ["alpha"], targets: ["claude", "agents"], scope: "project", confirm: false });
  const outcome = await importSkillsFlow(service, ui);
  assert.equal(outcome.kind, "cancelled");
  assert.deepEqual(calls, [], "确认之前一个字节都不许落盘");
  assert.equal(log.summary === null, false, "摘要已经给出来了——用户正是在看过它之后才说不要的");
  assert.equal(log.infos.some((message) => /installed/i.test(message)), false, "没装就不许报「装好了」");
});

// ---- 走完：每一步的问题与 core 收到的东西 ----

test("the full flow asks each question the CLI asks and calls core with exactly that answer", async () => {
  const { service, calls } = fakeService();
  const { ui, log } = fakeUi({ source: REPO, skills: ["alpha", "beta"], targets: ["claude", "agents"], scope: "project", confirm: true });
  const outcome = await importSkillsFlow(service, ui);

  assert.match(log.infos[0] ?? "", /Found 2 skills/, "发现之后先报数量，再问要哪几个");
  // 顺序与 CLI 的 Add 一字不差（skills-cli.mjs 的 304-313）：来源 → 发现 → 多选 → Install to
  // → Scope → 确认。只钉「问过每一条」不够——把 Scope 挪到 Install to 前面，每一条也都问过。
  assert.deepEqual(log.sequence, ["source", "Select Skills", "Install to", "Scope", "confirm"], "每一步的顺序就是 CLI 的顺序");
  assert.deepEqual(log.skillItems.map((item) => item.label), ["alpha", "beta"], "多选列出的就是 core 发现的名字");
  assert.equal(log.skillItems.find((item) => item.value === "beta")?.description, "already managed in this scope", "已受管的那个名字要带上提示");
  assert.equal(log.skillItems.find((item) => item.value === "alpha")?.description, undefined);

  assert.deepEqual(log.targetItems.map((item) => item.value), ["claude", "agents"], "目标清单来自 core 的安装上下文，不是插件自己编的");
  assert.match(log.targetItems[1].description ?? "", /\.agents\/skills/);
  assert.match(log.targetItems[1].description ?? "", /always installed/);
  assert.deepEqual(log.scopeItems.map((item) => item.label), ["Project", "Global"], "两个作用域都用 core 自己的名字");
  assert.equal(log.scopeItems[0].picked, true, "按钮长在这个项目的面板里，默认就是项目");

  assert.equal(log.confirmTitle, "Install 2 Skills?");
  assert.deepEqual(log.summary, {
    source: `${REPO} @ ${REVISION.slice(0, 8)}`,
    skills: "2 · alpha, beta",
    targets: "Claude Code, Codex / OpenCode / universal agents",
    scope: "Project",
    config: projectFacts().configFile,
  });

  assert.deepEqual(calls, [{ repo: REPO, names: ["alpha", "beta"], scope: "project", targets: ["claude", "agents"] }]);
  assert.equal(outcome.kind, "installed");
  assert.match(log.infos[1] ?? "", /2 Skills installed · Project · /);
  assert.match(log.infos[1] ?? "", /\.avenic\.json/, "摘要里说得出这次写进了哪个配置文件");
});

test("a canonical target is written even when its row is not ticked, and the summary still names it", async () => {
  const { service, calls } = fakeService();
  // core 无条件把技能真身拷进 canonical 目标；勾选框表达不了这件事，摘要与摘要行必须说实话。
  const { ui, log } = fakeUi({ source: REPO, skills: ["alpha"], targets: ["claude"], scope: "project", confirm: true });
  await importSkillsFlow(service, ui);
  assert.deepEqual(calls[0].targets, ["claude", "agents"]);
  assert.equal(log.summary?.targets, "Claude Code, Codex / OpenCode / universal agents");
});

test("choosing Global keeps the same repository and names but asks core for the global scope", async () => {
  const { service, calls } = fakeService();
  const { ui, log } = fakeUi({ source: REPO, skills: ["alpha", "beta"], targets: ["claude", "agents"], scope: "global", confirm: true });
  const outcome = await importSkillsFlow(service, ui);
  assert.deepEqual(calls, [{ repo: REPO, names: ["alpha", "beta"], scope: "global", targets: ["claude", "agents"] }]);
  assert.equal(log.summary?.scope, "Global");
  assert.equal(log.summary?.config, globalFacts().configFile);
  assert.equal(outcome.kind === "installed" ? outcome.scope : null, "global");
  assert.match(log.infos.at(-1) ?? "", /Global/);
});

test("a long skill list is summarized instead of turning the confirmation into a listing", async () => {
  const names = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const { service } = fakeService({ names, managed: [] });
  const { ui, log } = fakeUi({ source: REPO, skills: names, targets: ["agents"], scope: "project", confirm: false });
  await importSkillsFlow(service, ui);
  assert.equal(log.summary?.skills, "8 · a, b, c, d, e, f, +2 more");
});

// ---- 决议本身：全局操作绝不带项目根 ----
// core 的全局上下文不看 cwd，所以这条决议没有可观察的副作用——正因为如此，能钉住它的
// 只有它自己。把它改回「永远传 root」，这一条会红，而没有任何别的测试会红。
test("a global operation never carries the project root, a project one always does", () => {
  const root = path.join("C:", "work", "my-app");
  assert.equal(importCwd("global", root), undefined, "全局操作不许带项目根");
  assert.equal(importCwd("project", root), root, "项目操作要的正是项目根");
});

// ---- 核心短路与空仓库：说真话，且不写盘 ----

test("a repository with no skills warns instead of installing an empty set", async () => {
  const { service, calls } = fakeService({ names: [] });
  const { ui, log } = fakeUi({ source: REPO, skills: ["alpha"] });
  const outcome = await importSkillsFlow(service, ui);
  assert.equal(outcome.kind, "cancelled");
  assert.equal(log.warns.length, 1, `应当有一条警告，实际是 ${JSON.stringify(log.warns)}`);
  assert.match(log.warns[0], /No Skills found in that repository/);
  assert.deepEqual(log.skillItems, [], "一个 Skill 都没有，就不该弹一个空的多选");
  assert.deepEqual(calls, []);
});

test("core short-circuiting with alreadyInstalled is reported as such, not as a new install", async () => {
  const { service, calls } = fakeService({ alreadyInstalled: true });
  const { ui, log } = fakeUi({ source: REPO, skills: ["alpha", "beta"], targets: ["agents"], scope: "project", confirm: true });
  const outcome = await importSkillsFlow(service, ui);
  assert.equal(calls.length, 1, "短路发生在 core 内部，调用本身是发生过的");
  assert.equal(outcome.kind, "alreadyInstalled");
  assert.match(log.infos.at(-1) ?? "", /Already installed/);
  assert.equal(/Skills installed/.test(log.infos.at(-1) ?? ""), false, "不许把「早就装好了」说成「这次装好了」");
});

// ---- 说哪种语言：流程不说人话，它把键交给宿主 ----

// 这一层没有语言（它不 import vscode，不知道编辑器现在是哪种语言），所以它说的每一句
// 都必须是问宿主讨来的。反过来，core 的事实不是宿主说的话——作用域、目标、路径、来源
// 原样带过去，翻译它们就等于替 core 改口。
const CJK = /[㐀-鿿]/;

test("the questions and the results are said in the host's language, which only the host knows", async () => {
  const { service, calls } = fakeService({ managed: ["beta"] });
  const { ui, log } = fakeUi({ source: REPO, skills: ["alpha", "beta"], targets: ["claude", "agents"], scope: "project", confirm: true }, "zh-cn");
  const outcome = await importSkillsFlow(service, ui);
  assert.equal(outcome.kind, "installed");
  assert.deepEqual(calls.length, 1);
  const zh = (key: TextKey, values?: Record<string, string | number>) => sentence("zh-cn", key, values);

  // 问出去的每一句话（标题、提示、进度、结果）都来自词表，而且是按顺序讨的。
  assert.deepEqual(log.sequence, ["source", zh("skills.import-select"), zh("skills.import-targets"), zh("skills.import-scope"), "confirm"], "三个标题都要宿主用它的语言说");
  assert.equal(log.confirmTitle, zh("skills.import-install", { skills: zh("skills.count", { count: 2 }) }));
  assert.equal(log.infos[0], zh("skills.import-found", { skills: zh("skills.count-lower", { count: 2 }) }));
  assert.equal(log.infos[1], zh("skills.import-done", { skills: zh("skills.count", { count: 2 }), scope: "Project", config: projectFacts().configFile }));
  assert.deepEqual(log.progressTitles, [zh("skills.import-read"), zh("skills.import-installing", { skills: zh("skills.count", { count: 2 }) })], "进度条上那两行也是宿主说的话");
  assert.deepEqual(log.reports, [zh("skills.import-cloning", { repo: REPO }), zh("skills.import-working")]);
  assert.equal(log.skillItems.find((item) => item.value === "beta")?.description, zh("skills.import-managed"));
  assert.match(log.targetItems.find((item) => item.value === "claude")?.description ?? "", new RegExp(zh("skills.import-link")));
  assert.match(log.targetItems.find((item) => item.value === "agents")?.description ?? "", new RegExp(zh("skills.import-canonical")));
  assert.ok(CJK.test(log.confirmTitle ?? ""), `确认页的标题要说中文，实际是 ${log.confirmTitle}`);
  assert.ok(log.said.length >= 8, `这一场问答说的句子不少，实际只讨了 ${log.said.length} 句`);

  // core 的名字不是宿主说的话：两个作用域、目标、来源、配置文件原样是 core 的。
  assert.deepEqual(log.scopeItems.map((item) => item.label), ["Project", "Global"], "作用域的名字是 core 的术语，不翻译");
  assert.equal(log.summary?.scope, "Project");
  assert.equal(log.summary?.targets, "Claude Code, Codex / OpenCode / universal agents");
  assert.equal(log.summary?.source, `${REPO} @ ${REVISION.slice(0, 8)}`);
  assert.equal(log.summary?.config, projectFacts().configFile);
});

test("a repository with no skills says so in the host's language too", async () => {
  const { service, calls } = fakeService({ names: [] });
  const { ui, log } = fakeUi({ source: REPO }, "zh-cn");
  assert.equal((await importSkillsFlow(service, ui)).kind, "cancelled");
  assert.deepEqual(log.warns, [sentence("zh-cn", "skills.import-none")]);
  assert.deepEqual(calls, []);
});

// ---- 真 core、真仓库、真锁文件：假的替身证明不了「装的是什么」 ----
// 仓库是本地 git 夹具（clone 不出网），起作用域永远是项目 —— 全局作用域的目标直指
// 用户主目录，测试里绝不写。

async function makeSkillRepo(repo: string, skills: string[]): Promise<void> {
  for (const skill of skills) {
    await mkdir(path.join(repo, "skills", skill), { recursive: true });
    await writeFile(path.join(repo, "skills", skill, "SKILL.md"), `---\nname: ${skill}\n---\n`);
  }
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e", "add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-qm", "one"], { cwd: repo });
}

test("the flow against real core records exactly the chosen names, targets and scope", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-import-"));
  try {
    const project = path.join(root, "project");
    const repo = path.join(root, "repo");
    const env = testEnv(path.join(root, "state"));
    await mkdir(project, { recursive: true });
    await makeSkillRepo(repo, ["alpha", "beta"]);
    const service = importService(project, env);

    const first = fakeUi({ source: repo, skills: ["beta"], targets: ["claude"], scope: "project", confirm: true });
    const outcome = await importSkillsFlow(service, first.ui);
    assert.equal(outcome.kind, "installed");

    const lock = JSON.parse(await readFile(path.join(project, ".avenic.lock.json"), "utf8"));
    assert.deepEqual(lock.directSources.flatMap((source: { skills: string[] }) => source.skills), ["beta"], "锁文件记的正是选中的那一个");
    assert.deepEqual(lock.targets, ["claude", "agents"], "落链目标记的是这次真的写到的目标");
    assert.equal(existsSync(path.join(project, ".agents", "skills", "beta", "SKILL.md")), true, "真身在 canonical 目标里");
    assert.equal(existsSync(path.join(project, ".claude", "skills", "beta")), true, "共享目标也拿到了");
    assert.equal(existsSync(path.join(project, ".agents", "skills", "alpha")), false, "没选的那个不许被装上");
    const config = JSON.parse(await readFile(path.join(project, ".avenic.json"), "utf8"));
    assert.deepEqual(config.direct.map((entry: { skills: string[] }) => entry.skills), [["beta"]]);
    assert.equal(path.resolve(config.direct[0].source), path.resolve(repo), "配置里记的是这个来源本身");

    // 第二次同一份问答：core 短路，流程照实说「已经装好了」，而不是再报一次安装成功。
    const second = fakeUi({ source: repo, skills: ["beta"], targets: ["claude"], scope: "project", confirm: true });
    const again = await importSkillsFlow(service, second.ui);
    assert.equal(again.kind, "alreadyInstalled");
    assert.match(second.log.infos.at(-1) ?? "", /Already installed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a repository that cannot be read fails loudly and leaves the project untouched", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-import-fail-"));
  try {
    const project = path.join(root, "project");
    const env = testEnv(path.join(root, "state"));
    await mkdir(project, { recursive: true });
    const { ui } = fakeUi({ source: path.join(root, "not-a-repo") });
    await assert.rejects(() => importSkillsFlow(importService(project, env), ui), /not-a-repo|repository|does not exist/i);
    assert.equal(existsSync(path.join(project, ".avenic.lock.json")), false, "克隆都失败了，不许留下任何安装记录");
    assert.equal(existsSync(path.join(project, ".avenic.json")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scope facts are core's own: both labels, both roots, both config files, core's targets in core's order", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-import-facts-"));
  try {
    const project = path.join(root, "project");
    const env = testEnv(path.join(root, "state"));
    await mkdir(project, { recursive: true });
    const service = importService(project, env);
    const here = await service.facts("project");
    assert.deepEqual({ scope: here.scope, label: here.label, root: here.root, configFile: here.configFile }, {
      scope: "project",
      label: "Project",
      root: project,
      configFile: path.join(project, ".avenic.json"),
    });
    assert.deepEqual(here.targets.map((target) => target.id), ["claude", "agents"], "core 的表顺序原样带过来");
    assert.deepEqual(here.targets.map((target) => target.path), [".claude/skills", ".agents/skills"]);
    assert.deepEqual(here.targets.map((target) => target.canonical), [false, true], "真身目标就是 canonical 目标（Claude 读的是它的链接）");
    const away = await service.facts("global");
    assert.equal(away.label, "Global");
    assert.equal(away.configFile, path.join(env.AVENIC_STATE_DIR as string, "config.json"));
    assert.deepEqual(away.targets.map((target) => target.id), ["claude", "agents"]);
    assert.equal(existsSync(path.join(project, ".avenic.json")), false, "看一眼作用域不等于写盘");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 「看一眼」不写盘，连改名都不行：流程走到 Install to 之前会先取两个作用域的事实，那一步
// 读的必须是只读上下文——否则用户还没看到确认页，core 的旧文件改名就已经发生了（CLI 的
// chooseScope 用 migrate: false 挡的就是这件事）。旧文件存在才看得见差别，所以这一条
// 自己造一个。
test("showing a scope's facts does not rename a legacy project file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-import-legacy-"));
  try {
    const project = path.join(root, "project");
    const env = testEnv(path.join(root, "state"));
    await mkdir(project, { recursive: true });
    await writeFile(path.join(project, ".agent-skills.json"), JSON.stringify({ packs: ["common"] }));
    await importService(project, env).facts("project");
    assert.equal(existsSync(path.join(project, ".agent-skills.json")), true, "看一眼不等于把旧文件改掉");
    assert.equal(existsSync(path.join(project, ".avenic.json")), false, "也没有改名之后的新文件");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
