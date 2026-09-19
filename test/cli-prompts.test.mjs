import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  boxLines,
  banner,
  cancel,
  confirm,
  displayWidth,
  intro,
  isInteractive,
  multiselect,
  outro,
  select,
  spinner,
  text,
} from "../packages/cli/src/cli/prompts.mjs";
import { dispatchSkills } from "../packages/cli/src/cli/skills-cli.mjs";
import { FakeTTY, fakeStdout, keys, runPrompt } from "./helpers/fake-tty.mjs";

// ---- prompts 单元 ----

test("select resolves the chosen value and settles the frame", async () => {
  const { stdin, stdout, promise } = await runPrompt((s, o) => select({
    stdin: s,
    stdout: o,
    title: "Choose a catalog",
    options: [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }],
  }));
  keys(stdin, "\x1b[B", "\r"); // down → Beta; enter
  assert.equal(await promise, "b");
  const text = stdout.text();
  assert.match(text, /◇  Choose a catalog/);
  assert.match(text, /◇  Beta/); // 结果行
  assert.match(text, /●  Beta/); // 选中行
});

test("select escape resolves null and prints the cancel line", async () => {
  const { stdin, stdout, promise } = await runPrompt((s, o) => select({
    stdin: s,
    stdout: o,
    title: "Choose a catalog",
    options: [{ value: "a", label: "Alpha" }],
  }));
  keys(stdin, "\x1b");
  assert.equal(await promise, null);
  assert.match(stdout.text(), /✖  cancel/);
});

test("multiselect toggles with space, a selects all, n clears, enter confirms", async () => {
  const { stdin, stdout, promise } = await runPrompt((s, o) => multiselect({
    stdin: s,
    stdout: o,
    title: "Select Packs",
    options: [
      { value: "common", label: "Common" },
      { value: "development", label: "Development" },
      { value: "research", label: "Research" },
    ],
    initial: ["common"],
  }));
  const textBefore = () => stdout.text();
  keys(stdin, "\x1b[B"); // → Development
  assert.match(textBefore(), /\(1 checked\)/); // 初始 common 已预选
  keys(stdin, " "); // toggle Development on
  assert.match(textBefore(), /\(2 checked\)/);
  keys(stdin, "\x1b[AA"); // j/k/↑ 任意：直接 a 全选
  keys(stdin, "a");
  keys(stdin, "\r"); // → 全选
  assert.deepEqual(await promise, ["common", "development", "research"]);
  assert.match(stdout.text(), /◇  3 selected/);
});

test("a required multiselect keeps an empty selection open; escaping cancels", async () => {
  const { stdin, stdout, promise } = await runPrompt((s, o) => multiselect({
    stdin: s,
    stdout: o,
    title: "Select Packs",
    options: [{ value: "common", label: "Common" }],
    initial: ["common"],
    minSelected: 1,
  }));
  keys(stdin, "n", "\r");
  assert.match(stdout.text(), /Select at least one item/);
  keys(stdin, " ", "\r");
  assert.deepEqual(await promise, ["common"]);
  const escaped = await runPrompt((s, o) => multiselect({
    stdin: s,
    stdout: o,
    title: "Select Packs",
    options: [{ value: "common", label: "Common" }],
  }));
  keys(escaped.stdin, "\x1b");
  assert.equal(await escaped.promise, null);
  assert.match(escaped.stdout.text(), /✖  cancel/);
});

test("confirm answers Yes initially and y/n/esc drive the choices", async () => {
  const yes = await runPrompt((s, o) => confirm({ stdin: s, stdout: o, title: "Install 1 Pack?" }));
  keys(yes.stdin, "\r");
  assert.equal(await yes.promise, true);
  assert.match(yes.stdout.text(), /◇  Yes/);

  const no = await runPrompt((s, o) => confirm({ stdin: s, stdout: o, title: "Install 1 Pack?" }));
  keys(no.stdin, "n");
  assert.equal(await no.promise, false);
  assert.match(no.stdout.text(), /◇  No/);

  const cancelled = await runPrompt((s, o) => confirm({ stdin: s, stdout: o, title: "Install 1 Pack?" }));
  keys(cancelled.stdin, "\x1b");
  assert.equal(await cancelled.promise, null);
  assert.match(cancelled.stdout.text(), /✖/);
});

test("spinner paints a frame and settles on stop/fail", () => {
  const stdout = fakeStdout();
  const spin = spinner({ stdout, text: "Installing…" });
  assert.match(stdout.text(), /⠋ Installing…/);
  spin.stop("Installed");
  assert.match(stdout.text(), /✓  Installed\n$/);
  const failed = fakeStdout();
  const spin2 = spinner({ stdout: failed });
  spin2.fail("boom");
  assert.match(failed.text(), /✖  boom\n$/);
});

test("intro, outro, cancel, and boxLines render deterministic frames", () => {
  const stdout = fakeStdout();
  intro(stdout, "Install Skills");
  outro(stdout, "Done! Installed 1 Pack");
  cancel(stdout);
  assert.equal(stdout.text(), "◆  Install Skills\n✓  Done! Installed 1 Pack\n✖  Cancelled\n");
  assert.deepEqual(boxLines(["one", "two-three"]), [
    "╭─────────────╮",
    "│  one        │",
    "│  two-three  │",
    "╰─────────────╯",
  ]);
  // CJK 宽度：中文占 2 列，各帧行的显示宽度一致（字符数不同）
  const cjk = boxLines(["✓  OK", "  ├─ 中文 Skills"]);
  const widths = cjk.map((line) => displayWidth(line));
  assert.equal(widths[0], widths[1]);
  assert.equal(widths[0], widths[2]);
});

test("banner is compact, branded, and contains no terminal control sequence", () => {
  const stdout = fakeStdout();
  banner(stdout);
  assert.match(stdout.text(), /AVENIC/);
  assert.doesNotMatch(stdout.text(), /\x1b/);
});

test("isInteractive requires both ends to be TTY", () => {
  const input = new FakeTTY();
  const output = fakeStdout();
  assert.equal(isInteractive({ stdin: input, stdout: output }), true);
  const plain = { ...output, isTTY: false };
  assert.equal(isInteractive({ stdin: input, stdout: plain }), false);
});

test("arrows and j/k move the cursor, and the list wraps at both ends", async () => {
  const { stdin, stdout, promise } = await runPrompt((s, o) => select({
    stdin: s,
    stdout: o,
    title: "Choose",
    options: [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }, { value: "c", label: "Gamma" }],
  }));
  keys(stdin, "\x1b[A"); // ↑ 从第一行回绕到最后一行
  keys(stdin, "\x1b[B", "\x1b[B"); // ↓ ↓ 再回绕到第一行
  keys(stdin, "j", "k"); // j/k 与 ↑↓ 等价，净移动为零
  keys(stdin, "\r"); // 停在 Beta
  assert.equal(await promise, "b");
  assert.match(stdout.text(), /◇  Beta/);
});

test("ctrl+c cancels a prompt exactly the way escape does", async () => {
  const selected = await runPrompt((s, o) => select({
    stdin: s,
    stdout: o,
    title: "Choose",
    options: [{ value: "a", label: "Alpha" }],
  }));
  keys(selected.stdin, "\x03");
  assert.equal(await selected.promise, null);
  assert.match(selected.stdout.text(), /✖  cancel/);

  const multi = await runPrompt((s, o) => multiselect({
    stdin: s,
    stdout: o,
    title: "Select Packs",
    options: [{ value: "common", label: "Common" }],
    initial: ["common"],
  }));
  keys(multi.stdin, " ", "\x03"); // 先改动选择，再中止：中止的是这一帧，不是已写下的配置
  assert.equal(await multi.promise, null);
});

test("a searchable list filters as you type, erases, and selects from what it shows", async () => {
  const { stdin, stdout, promise } = await runPrompt((s, o) => multiselect({
    stdin: s,
    stdout: o,
    title: "Select Skills",
    searchable: true,
    options: [
      { value: "alpha", label: "Alpha" },
      { value: "beta", label: "Beta" },
      { value: "gamma", label: "Gamma" },
    ],
  }));
  keys(stdin, "g", "a"); // 输入即过滤
  assert.match(stdout.text(), /⌕ ga {2}\(1\/3\)/);
  keys(stdin, " ", "\r"); // 空格选中当前唯一结果，回车确认
  assert.deepEqual(await promise, ["gamma"]);
});

test("a fixed row cannot be turned off, and typing never steals its selection", async () => {
  const { stdin, stdout, promise } = await runPrompt((s, o) => multiselect({
    stdin: s,
    stdout: o,
    title: "Install to",
    options: [
      { value: "agents", label: "Codex / OpenCode / universal agents" },
      { value: "claude", label: "Claude Code" },
    ],
    initial: ["agents", "claude"],
    fixed: ["agents"],
    minSelected: 1,
  }));
  keys(stdin, " "); // 光标在必选项上：空格什么也不做
  assert.match(stdout.text(), /\(2 checked\)/);
  keys(stdin, "\x1b[B", " "); // 移到可选项上关掉它
  assert.match(stdout.text(), /\(1 checked\)/);
  keys(stdin, "\r");
  assert.deepEqual(await promise, ["agents"]);
});

test("a text prompt takes typed input and will not settle on nothing", async () => {
  const { stdin, stdout, promise } = await runPrompt((s, o) => text({
    stdin: s,
    stdout: o,
    title: "Repository (owner/repo or URL)",
  }));
  keys(stdin, "\r"); // 空输入：回车留在原地，不当成取消
  keys(stdin, "o", "w", "n", "e", "r", "/", "r", "e", "p", "o");
  keys(stdin, "\x7f"); // backspace 删掉最后一个字符
  keys(stdin, "\r");
  assert.equal(await promise, "owner/rep");
  assert.match(stdout.text(), /│  owner\/repo/); // 输入过程中逐字回显
  assert.match(stdout.text(), /◇  owner\/rep/); // 落定帧

  const cancelled = await runPrompt((s, o) => text({ stdin: s, stdout: o, title: "Repository" }));
  keys(cancelled.stdin, "x", "\x1b");
  assert.equal(await cancelled.promise, null);
});

// ---- 端到端：假 TTY 驱动 dispatchSkills 的交互流程 ----

async function withTempDirectory(prefix, run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    await run(directory);
  } finally {
    await import("node:fs/promises").then(({ rm }) => rm(directory, { recursive: true, force: true }));
  }
}

function gitQuiet(cwd, argumentsList) {
  const result = spawnSync("git", ["-C", cwd, ...argumentsList], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function commitAll(root, message) {
  await gitQuiet(root, ["init", "--quiet", "-b", "main"]);
  await gitQuiet(root, ["add", "-A"]);
  await gitQuiet(root, ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", message]);
}

// 双 Pack 目录 fixture（common + development，一个 source）。
async function createCatalogFixture(root) {
  await mkdir(path.join(root, "packs"), { recursive: true });
  await mkdir(path.join(root, "skills", "test-source"), { recursive: true });
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "fixture-catalog", version: "1.0.0", private: true, agentSkills: { packageSpec: "fixture#main" } }, null, 2)}\n`,
  );
  await writeFile(
    path.join(root, "sources.lock.json"),
    `${JSON.stringify({ schemaVersion: 1, sources: [{ id: "test-source", name: "Test Source", repository: "https://github.com/example/test.git", skillRoot: "skills", revision: "a".repeat(40) }] }, null, 2)}\n`,
  );
  const common = { schemaVersion: 1, id: "common", name: "Common", description: "Common tools.", sources: [{ source: "test-source", skills: ["alpha"] }] };
  const development = { schemaVersion: 1, id: "development", name: "Development", description: "Dev tools.", sources: [{ source: "test-source", skills: ["beta", "gamma"] }] };
  await writeFile(path.join(root, "packs", "common.json"), `${JSON.stringify(common, null, 2)}\n`);
  await writeFile(path.join(root, "packs", "development.json"), `${JSON.stringify(development, null, 2)}\n`);
  for (const skillName of ["alpha", "beta", "gamma"]) {
    const directory = path.join(root, "skills", "test-source", skillName);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "SKILL.md"), `---\nname: ${skillName}\n---\n`);
  }
  await commitAll(root, "fixture catalog");
}

async function waitFor(text, stdout, timeout = 8000) {
  const started = Date.now();
  while (!stdout.text().includes(text)) {
    if (Date.now() - started > timeout) {
      throw new Error(`timeout waiting for "${text}"\n---\n${stdout.text()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("interactive install: source → packs → Install to → scope → confirm → summary", async () => {
  await withTempDirectory("avenic-interactive-", async (projectRoot) => {
    await withTempDirectory("avenic-catalog-", async (catalogRoot) => {
      await createCatalogFixture(catalogRoot);
      const stdin = new FakeTTY();
      const stdout = fakeStdout();
      const environment = { AVENIC_CATALOG_SPEC: catalogRoot, AVENIC_STATE_DIR: path.join(projectRoot, ".avenic-state") };
      const run = dispatchSkills(["install"], { cwd: projectRoot, environment, prompts: { stdin, stdout }, io: { log() {} } });
      await waitFor("◇  Select Packs", stdout);
      keys(stdin, "\x1b[B", " ", "\r"); // → Development，space 选中，Enter 确认（common 预选）
      await waitFor("◇  Install to", stdout);
      assert.match(stdout.text(), /Found 3 Skills in 2 Packs/); // 发现步骤先报了数量
      assert.match(stdout.text(), /\.agents\/skills · always installed/);
      keys(stdin, "\r"); // 默认：真身 + 共享链接都勾上
      await waitFor("◇  Scope", stdout);
      keys(stdin, "\r"); // Project（默认）
      await waitFor("Install 2 Packs?", stdout);
      assert.match(stdout.text(), /├─ Skills: 3 — alpha, beta, gamma/);
      assert.match(stdout.text(), /└─ Scope: Project/);
      keys(stdin, "\r"); // Yes
      await waitFor("Done!", stdout, 12000);
      assert.equal(await run, undefined);
      const text = stdout.text();
      assert.match(text, /◆  Add Skills/);
      assert.match(text, /✓  Installed/);
      assert.match(text, /╭────────/);
      assert.match(text, /├─ Common/);
      assert.match(text, /└─ Development/);
      assert.match(text, /✓  Done! Installed 2 Packs/);
      assert.match(text, /◇  Select Packs \(2 checked\)/);
      // 交互安装的是项目作用域：Skills 落盘于项目 .agents（universal 目标），锁文件在项目根
      assert.ok(existsSync(path.join(projectRoot, ".agents", "skills", "alpha")), "alpha on disk");
      assert.ok(existsSync(path.join(projectRoot, ".agents", "skills", "beta")), "beta on disk");
      assert.ok(existsSync(path.join(projectRoot, ".avenic.lock.json")), "lock file on disk");

      // 卸载 Yes → 清空
      const yesIn = new FakeTTY();
      const yesOut = fakeStdout();
      const runYes = dispatchSkills(["uninstall"], { cwd: projectRoot, environment, prompts: { stdin: yesIn, stdout: yesOut }, io: { log() {} } });
      await waitFor("Remove ALL", yesOut);
      keys(yesIn, "y");
      await waitFor("Done!", yesOut);
      await runYes;
      assert.match(yesOut.text(), /✓  Done! All managed Skills removed/);
      assert.ok(!existsSync(path.join(projectRoot, ".avenic.lock.json")), "lock removed");

      // 卸载 No → 不动（需要先重装，验证 No 分支）
      const reinstallIn = new FakeTTY();
      const reinstallOut = fakeStdout();
      const runAgain = dispatchSkills(["install"], { cwd: projectRoot, environment, prompts: { stdin: reinstallIn, stdout: reinstallOut }, io: { log() {} } });
      await waitFor("◇  Select Packs", reinstallOut);
      keys(reinstallIn, "\r"); // common 预选
      await waitFor("◇  Install to", reinstallOut);
      keys(reinstallIn, "\r");
      await waitFor("◇  Scope", reinstallOut);
      keys(reinstallIn, "\r");
      await waitFor("Install 1 Pack?", reinstallOut);
      keys(reinstallIn, "\r"); // Yes
      await waitFor("Done!", reinstallOut, 12000);
      await runAgain;
      const noIn = new FakeTTY();
      const noOut = fakeStdout();
      const runNo = dispatchSkills(["uninstall"], { cwd: projectRoot, environment, prompts: { stdin: noIn, stdout: noOut }, io: { log() {} } });
      await waitFor("Remove ALL", noOut);
      keys(noIn, "\r"); // No（initial false）
      await runNo;
      assert.match(noOut.text(), /✖  Uninstall cancelled/);
      assert.ok(existsSync(path.join(projectRoot, ".avenic.lock.json")), "No keeps the lock");
    });
  });
});

test("the Skills menu offers every action and Back changes nothing", async () => {
  await withTempDirectory("avenic-menu-", async (projectRoot) => {
    await withTempDirectory("avenic-catalog-", async (catalogRoot) => {
      await createCatalogFixture(catalogRoot);
      const environment = { AVENIC_CATALOG_SPEC: catalogRoot, AVENIC_STATE_DIR: path.join(projectRoot, ".avenic-state") };
      const stdin = new FakeTTY();
      const stdout = fakeStdout();
      const run = dispatchSkills([], { cwd: projectRoot, environment, prompts: { stdin, stdout }, io: { log() {} } });
      await waitFor("◇  Skills", stdout);
      const menu = stdout.text();
      for (const label of [
        "Add skills",
        "Installed skills",
        "Update skills",
        "Remove skills",
        "Sync SkillsHub",
        "Import from repository",
        "Back",
      ]) {
        assert.match(menu, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      }
      assert.match(menu, /AVENIC/); // 菜单是 AVENIC 的，不是另一个命令的区别名
      keys(stdin, "\x1b"); // Esc = Back
      await run;
      assert.match(stdout.text(), /✖  back/);
      assert.match(stdout.text(), /✓  Nothing changed/);
      // Back 之后什么都没落盘
      assert.ok(!existsSync(path.join(projectRoot, ".avenic.lock.json")), "no lock");
      assert.ok(!existsSync(path.join(projectRoot, ".agents", "skills")), "no skills");
    });
  });
});

test("Add from a repository discovers, lists, and installs the picked Skills", async () => {
  await withTempDirectory("avenic-import-", async (projectRoot) => {
    await withTempDirectory("avenic-repo-", async (repoRoot) => {
      // 一个发布三个 Skill 的仓库（虚构内容，无真实凭据）。
      for (const name of ["alpha", "beta", "gamma"]) {
        await mkdir(path.join(repoRoot, "skills", name), { recursive: true });
        await writeFile(path.join(repoRoot, "skills", name, "SKILL.md"), `---\nname: ${name}\n---\n`);
      }
      await commitAll(repoRoot, "fixture repo");
      const stdin = new FakeTTY();
      const stdout = fakeStdout();
      const environment = { AVENIC_STATE_DIR: path.join(projectRoot, ".avenic-state") };
      const run = dispatchSkills(["add", repoRoot], { cwd: projectRoot, environment, prompts: { stdin, stdout }, io: { log() {} } });
      await waitFor("◇  Select Skills", stdout);
      assert.match(stdout.text(), /Found 3 skills/);
      keys(stdin, "b"); // 过滤到 beta
      keys(stdin, " ", "\r"); // 选中 beta
      await waitFor("◇  Install to", stdout);
      keys(stdin, "\r");
      await waitFor("◇  Scope", stdout);
      keys(stdin, "\r");
      await waitFor("Install 1 Skill?", stdout);
      assert.match(stdout.text(), /├─ Skills: 1 — beta/); // 摘要说的是这一次要装的东西
      keys(stdin, "\r"); // Yes
      await waitFor("Done!", stdout, 12000);
      await run;
      assert.match(stdout.text(), /✓  Done! Installed 1 Skill/);
      assert.ok(existsSync(path.join(projectRoot, ".agents", "skills", "beta")), "beta on disk");
      assert.ok(!existsSync(path.join(projectRoot, ".agents", "skills", "alpha")), "alpha not taken");
    });
  });
});

test("the same command on a pipe takes the script path instead of the menu", async () => {
  // 「终端上给菜单、管道里给脚本语义」是同一条命令的两条路径，靠 isInteractive
  // 分流。管道下不能出现交互帧：没有 TTY 时打出的帧只会变成日志里的乱码。
  await withTempDirectory("avenic-nontty-", async (projectRoot) => {
    await withTempDirectory("avenic-catalog-", async (catalogRoot) => {
      await createCatalogFixture(catalogRoot);
      const { PassThrough } = await import("node:stream");
      const stdin = new PassThrough(); // 不是 TTY
      const stdout = fakeStdout();
      const logs = [];
      const environment = { AVENIC_CATALOG_SPEC: catalogRoot, AVENIC_STATE_DIR: path.join(projectRoot, ".avenic-state") };
      await dispatchSkills([], { cwd: projectRoot, environment, prompts: { stdin, stdout }, io: { log: (line) => logs.push(String(line ?? "")) } });
      const text = stdout.text();
      assert.doesNotMatch(text, /Add skills/, "管道里不该出现 Skills 菜单");
      assert.doesNotMatch(text, /\x1b\[/, "管道里不该出现终端控制序列");
      // 无参的脚本语义 = 装 common Pack（与 `avenic skills install common` 相同）
      assert.ok(existsSync(path.join(projectRoot, ".agents", "skills", "alpha")), "common 装上了");
      assert.ok(!existsSync(path.join(projectRoot, ".agents", "skills", "beta")), "development 没被装");
    });
  });
});
