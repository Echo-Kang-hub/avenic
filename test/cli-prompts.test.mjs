// The TUI layer's own tests: every prompt's keyboard, every frame's shape, and
// the rules the whole product inherits from it — one cancel story (Esc, never a
// list row), Enter that cannot confirm an empty selection, colours that vanish
// on request, and frames that fit the terminal they are drawn in.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

// Frames are asserted as text, so colour is off for the whole file. The colour
// path has its own tests below, which turn it back on explicitly.
process.env.NO_COLOR = "1";

const {
  banner,
  cancel,
  colorEnabled,
  columns,
  confirm,
  displayWidth,
  error,
  field,
  intro,
  isInteractive,
  multiSelect,
  note,
  outro,
  paletteFor,
  progress,
  searchableSelect,
  section,
  singleSelect,
  success,
  table,
  text,
  truncate,
  warning,
} = await import("../packages/cli/src/cli/prompts.mjs");
const { dispatchSkills } = await import("../packages/cli/src/cli/skills-cli.mjs");
const { FakeTTY, fakeStdout, keys, runPrompt } = await import("./helpers/fake-tty.mjs");

// ---- prompts 单元 ----

test("singleSelect resolves the chosen value and settles the frame", async () => {
  const { stdin, stdout, promise } = await runPrompt((s, o) => singleSelect({
    stdin: s,
    stdout: o,
    title: "Choose a catalog",
    options: [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }],
  }));
  keys(stdin, "\x1b[B", "\r"); // down → Beta; enter
  assert.equal(await promise, "b");
  const frame = stdout.text();
  assert.match(frame, /◆  Choose a catalog/); // 帧头
  assert.match(frame, /│  ▸ ◉  Beta/); // 光标行 = 选中行（品牌 ▸ + 绿色 ◉）
  assert.match(frame, /│    ○  Alpha/); // 未选中
  assert.match(frame, /◇  Choose a catalog/); // 落定帧
  assert.match(frame, /└  Beta/); // 摘要行
});

test("escape resolves null and prints the cancel line", async () => {
  const { stdin, stdout, promise } = await runPrompt((s, o) => singleSelect({
    stdin: s,
    stdout: o,
    title: "Choose a catalog",
    options: [{ value: "a", label: "Alpha" }],
  }));
  keys(stdin, "\x1b");
  assert.equal(await promise, null);
  assert.match(stdout.text(), /✖  cancel/);
});

test("cancelling is Escape, not a row in the list", async () => {
  // 列表里只列可以选的东西：取消不是其中之一。
  const { stdin, stdout, promise } = await runPrompt((s, o) => singleSelect({
    stdin: s,
    stdout: o,
    title: "Choose a catalog",
    options: [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }],
  }));
  keys(stdin, "\x1b[A", "\x1b[A"); // 从第一行往上仍是第一行：没有“取消”行可以落在上面
  keys(stdin, "\r");
  assert.equal(await promise, "a");
  assert.doesNotMatch(stdout.text(), /○\s+cancel/);
});

test("multiSelect toggles with space, ctrl+a selects all, n clears, enter confirms", async () => {
  const { stdin, stdout, promise } = await runPrompt((s, o) => multiSelect({
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
  assert.match(textBefore(), /\(1 selected\)/);
  keys(stdin, " "); // toggle Development on
  assert.match(textBefore(), /\(2 selected\)/);
  keys(stdin, "\x1b[AA"); // j/k/↑ 任意：直接 ctrl+a 全选
  keys(stdin, "\x01");
  keys(stdin, "\r");
  assert.deepEqual(await promise, ["common", "development", "research"]);
  assert.match(stdout.text(), /└  3 selected/);
  assert.doesNotMatch(stdout.text(), /○\s+cancel/);
});

test("a required multiselect keeps an empty selection open; escaping cancels", async () => {
  const { stdin, stdout, promise } = await runPrompt((s, o) => multiSelect({
    stdin: s,
    stdout: o,
    title: "Select Packs",
    options: [{ value: "common", label: "Common" }],
    initial: ["common"],
    minSelected: 1,
  }));
  keys(stdin, "n", "\r"); // 清空后回车：不继续，也不取消
  assert.match(stdout.text(), /Select at least one item/);
  keys(stdin, " ", "\r");
  assert.deepEqual(await promise, ["common"]);
  const escaped = await runPrompt((s, o) => multiSelect({
    stdin: s,
    stdout: o,
    title: "Select Packs",
    options: [{ value: "common", label: "Common" }],
  }));
  keys(escaped.stdin, "\x1b");
  assert.equal(await escaped.promise, null);
  assert.match(escaped.stdout.text(), /✖  cancel/);
});

test("a fresh multiselect refuses to confirm nothing when a selection is required", async () => {
  // init/change 的 agent 选择器就是这样：一个都不选时回车既不继续也不取消。
  const { stdin, stdout, promise } = await runPrompt((s, o) => multiSelect({
    stdin: s,
    stdout: o,
    title: "Select agents",
    options: [{ value: "claude", label: "Claude Code" }, { value: "codex", label: "Codex" }],
    minSelected: 1,
    emptyMessage: "Select at least one agent",
  }));
  keys(stdin, "\r", "\r");
  assert.match(stdout.text(), /Select at least one agent/);
  assert.doesNotMatch(stdout.text(), /◇  Select agents/); // 没有落定：还停在那一帧
  keys(stdin, " ", "\r");
  assert.deepEqual(await promise, ["claude"]);
});

test("confirm answers Yes initially and y/n/esc drive the choices", async () => {
  const yes = await runPrompt((s, o) => confirm({ stdin: s, stdout: o, title: "Install 1 Pack?" }));
  keys(yes.stdin, "\r");
  assert.equal(await yes.promise, true);
  assert.match(yes.stdout.text(), /└  Yes/);

  const no = await runPrompt((s, o) => confirm({ stdin: s, stdout: o, title: "Install 1 Pack?" }));
  keys(no.stdin, "n");
  assert.equal(await no.promise, false);
  assert.match(no.stdout.text(), /└  No/);

  const cancelled = await runPrompt((s, o) => confirm({ stdin: s, stdout: o, title: "Install 1 Pack?" }));
  keys(cancelled.stdin, "\x1b");
  assert.equal(await cancelled.promise, null);
  assert.match(cancelled.stdout.text(), /✖  cancel/);
});

test("progress paints a frame and settles on stop/fail", () => {
  const stdout = fakeStdout();
  const spin = progress({ stdout, text: "Installing…" });
  assert.match(stdout.text(), /⠋ Installing…/);
  spin.stop("Installed");
  assert.match(stdout.text(), /✓  Installed\n$/);
  const failed = fakeStdout();
  const spin2 = progress({ stdout: failed });
  spin2.fail("boom");
  assert.match(failed.text(), /✖  boom\n$/);
});

test("the printed line vocabulary is one line per meaning", () => {
  const stdout = fakeStdout();
  intro(stdout, "Install Skills", { description: "from the SkillsHub" });
  section(stdout, "Agents");
  field(stdout, "Mode", "shared");
  success(stdout, "Done! Installed 1 Pack");
  warning(stdout, "12 records could not be read");
  error(stdout, "boom");
  cancel(stdout);
  outro(stdout, "All good");
  assert.equal(stdout.text(), [
    "◆  Install Skills",
    "│  from the SkillsHub",
    "◇  Agents",
    "│  Mode      shared",
    "✓  Done! Installed 1 Pack",
    "!  12 records could not be read",
    "✖  boom",
    "✖  Cancelled",
    "✓  All good",
    "",
  ].join("\n"));
});

// Every test above injects a stream, which is exactly why this one does not:
// product code calls these emitters with the real terminal's stdout and nothing
// else, so an emitter whose stream has no default works in every test and
// throws `Cannot read properties of undefined` the first time a user runs it.
test("the printed emitters work with no stream at all", () => {
  const written = [];
  const real = process.stdout.write;
  process.stdout.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };
  try {
    banner(undefined, { subtitle: "shared history" });
    intro(undefined, "Install Skills");
    section(undefined, "Agents");
    field(undefined, "Mode", "shared");
    note(undefined, "a note");
    success(undefined, "Done");
    warning(undefined, "careful");
    error(undefined, "boom");
    outro(undefined, "All good");
    cancel(undefined);
    table(undefined, ["Agent"], [["Claude Code"]]);
  } finally {
    process.stdout.write = real;
  }
  const text = written.join("");
  assert.match(text, /█▀▀█/, "the banner draws the wordmark");
  assert.match(text, /◆ {2}Install Skills/);
  assert.match(text, /◇ {2}Agents/);
  assert.match(text, /│ {2}Mode {6}shared/);
  assert.match(text, /│ {2}· {2}a note/);
  assert.match(text, /✓ {2}Done/);
  assert.match(text, /✖ {2}boom/);
  assert.match(text, /Claude Code/);
});

test("table aligns columns and stays inside the terminal", () => {
  const stdout = fakeStdout({ columns: 48 });
  table(stdout, ["Agent", "CLI", "History"], [
    ["Claude Code", "found", "4"],
    ["Codex", "not found", "2"],
  ]);
  const rows = stdout.text().trimEnd().split("\n");
  assert.equal(rows.length, 3);
  for (const row of rows) assert.ok(displayWidth(row) <= 48, row);
  const columnsAt = (row) => ["Claude Code", "Codex", "Agent"].map((cell) => row.indexOf(cell)).find((at) => at >= 0);
  assert.equal(columnsAt(rows[0]), columnsAt(rows[1]), "表头与数据行同一起点");
  assert.equal(rows[1].indexOf("found"), rows[0].indexOf("CLI"), "第二列对齐");
  assert.equal(rows[1].indexOf("4"), rows[0].indexOf("History"), "第三列对齐");
});

test("the banner is a readable three-line wordmark, not a control sequence", () => {
  const stdout = fakeStdout();
  banner(stdout, { subtitle: "shared history" });
  const text = stdout.text();
  assert.doesNotMatch(text, /\x1b/);
  const rows = text.trimEnd().split("\n");
  assert.equal(rows.length, 4);
  const [one, two, three] = rows;
  // 三行一样宽，都是块字符画的 —— 可读的字，不是抽象符号。
  assert.equal(displayWidth(one), displayWidth(two));
  assert.equal(displayWidth(one), displayWidth(three));
  assert.ok(displayWidth(one) <= columns(), "字标要放得进一屏");
  for (const row of [one, two, three]) assert.match(row, /[█▀▄]/);
  assert.match(rows[3], /shared history/);
  // 窄终端下副标题让位，字标自己不受影响
  const narrow = fakeStdout({ columns: 30 });
  banner(narrow, { subtitle: "shared history · skills · sessions · models · the hub" });
  assert.equal(narrow.text().trimEnd().split("\n").length, 3);
});

test("truncate cuts by display width and marks what it cut", () => {
  assert.equal(truncate("abcdef", 10), "abcdef");
  assert.equal(truncate("abcdef", 4), "abc…");
  assert.equal(displayWidth(truncate("中文中文中文", 6)), 5);
  assert.equal(truncate("abc", 0), "");
});

test("isInteractive requires both ends to be TTY", () => {
  const input = new FakeTTY();
  const output = fakeStdout();
  assert.equal(isInteractive({ stdin: input, stdout: output }), true);
  const plain = { ...output, isTTY: false };
  assert.equal(isInteractive({ stdin: input, stdout: plain }), false);
});

test("colour is on for a terminal and off when asked, on every stream", () => {
  const tty = fakeStdout();
  assert.equal(colorEnabled(tty, {}), true);
  assert.equal(colorEnabled(tty, { NO_COLOR: "1" }), false);
  assert.equal(colorEnabled(tty, { NO_COLOR: "" }), true); // NO_COLOR 规范：空值不算
  assert.equal(colorEnabled(tty, { FORCE_COLOR: "0" }), false);
  assert.equal(colorEnabled(tty, { TERM: "dumb" }), false);
  assert.equal(colorEnabled(fakeStdout({ isTTY: false }), {}), false);
  assert.equal(colorEnabled(fakeStdout({ isTTY: false }), { FORCE_COLOR: "1" }), true);
});

test("a coloured frame carries the brand, and a plain one carries none of it", () => {
  const coloured = paletteFor(true);
  assert.equal(coloured.brand("◆"), "\x1b[36m◆\x1b[0m");
  assert.equal(coloured.ok("✓"), "\x1b[32m✓\x1b[0m");
  assert.equal(coloured.warn("!"), "\x1b[33m!\x1b[0m");
  assert.equal(coloured.bad("✖"), "\x1b[31m✖\x1b[0m");
  assert.equal(coloured.dim("help"), "\x1b[2mhelp\x1b[0m");
  const plain = paletteFor(false);
  assert.equal(plain.brand("◆"), "◆");
  assert.equal(plain.dim("help"), "help");
});

test("a coloured frame colours the marks and nothing else", async () => {
  const stdout = fakeStdout();
  const { stdin, promise } = await runPrompt((s) => singleSelect({
    stdin: s,
    stdout,
    color: true,
    title: "Choose",
    options: [{ value: "a", label: "Alpha" }],
  }));
  keys(stdin, "\r");
  await promise;
  const text = stdout.text();
  assert.match(text, /\x1b\[1;36m◆  Choose\x1b\[0m/); // 标题：品牌色 + 粗体
  assert.match(text, /\x1b\[36m▸\x1b\[0m/); // 光标
  assert.match(text, /\x1b\[1;32mAlpha\x1b\[0m/); // 选中项：绿色 + 粗体
  assert.match(text, /\x1b\[2m↑↓ move/); // 帮助：灰
});

test("every frame line fits the terminal it is drawn in", async () => {
  const stdout = fakeStdout({ columns: 40 });
  const { stdin, promise } = await runPrompt((s) => multiSelect({
    stdin: s,
    stdout,
    title: "Install to",
    options: [
      { value: "agents", label: "Codex / OpenCode / universal agents", hint: ".agents/skills · always installed" },
      { value: "claude", label: "Claude Code with a very long label that will not fit", hint: "~/.claude/skills · shared link" },
    ],
    initial: ["agents"],
  }));
  keys(stdin, "\r");
  await promise;
  // 帧之间用 \x1b[u\x1b[J 重画，所以只看每一次重画的最后一行 —— 那就是当前帧。
  const frame = stdout.text().split("\x1b[u\x1b[J").at(-1);
  for (const line of frame.split("\n")) {
    assert.ok(displayWidth(line) <= 40, `line is ${displayWidth(line)} wide: ${line}`);
  }
  assert.match(frame, /…/, "长标签被截断而不是换行");
});

test("arrows and j/k move the cursor, and the list wraps at both ends", async () => {
  const { stdin, stdout, promise } = await runPrompt((s, o) => singleSelect({
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
  assert.match(stdout.text(), /└  Beta/);
});

test("ctrl+c cancels a prompt exactly the way escape does", async () => {
  const selected = await runPrompt((s, o) => singleSelect({
    stdin: s,
    stdout: o,
    title: "Choose",
    options: [{ value: "a", label: "Alpha" }],
  }));
  keys(selected.stdin, "\x03");
  assert.equal(await selected.promise, null);
  assert.match(selected.stdout.text(), /✖  cancel/);

  const multi = await runPrompt((s, o) => multiSelect({
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
  const { stdin, stdout, promise } = await runPrompt((s, o) => multiSelect({
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

test("searchableSelect filters and selects from what it shows", async () => {
  const { stdin, stdout, promise } = await runPrompt((s, o) => searchableSelect({
    stdin: s,
    stdout: o,
    title: "Pick one",
    options: [
      { value: "alpha", label: "Alpha" },
      { value: "beta", label: "Beta" },
    ],
  }));
  keys(stdin, "b");
  assert.match(stdout.text(), /\(1\/2\)/);
  keys(stdin, "\r");
  assert.equal(await promise, "beta");
  assert.match(stdout.text(), /└  Beta/);
});

test("a fixed row cannot be turned off, and typing never steals its selection", async () => {
  const { stdin, stdout, promise } = await runPrompt((s, o) => multiSelect({
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
  assert.match(stdout.text(), /\(2 selected\)/);
  keys(stdin, "\x1b[B", " "); // 移到可选项上关掉它
  assert.match(stdout.text(), /\(1 selected\)/);
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
  assert.match(stdout.text(), /▸ owner\/repo/); // 输入过程中逐字回显
  assert.match(stdout.text(), /└  owner\/rep/); // 落定帧
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
      await waitFor("◆  Select Packs", stdout);
      keys(stdin, "\x1b[B", " ", "\r"); // → Development，space 选中，Enter 确认（common 预选）
      await waitFor("◆  Install to", stdout);
      assert.match(stdout.text(), /Found 3 Skills in 2 Packs/); // 发现步骤先报了数量
      assert.match(stdout.text(), /\.agents\/skills · always installed/);
      keys(stdin, "\r"); // 默认：真身 + 共享链接都勾上
      await waitFor("◆  Scope", stdout);
      keys(stdin, "\r"); // Project（默认）
      await waitFor("Install 2 Packs?", stdout);
      // 落定的摘要与 status 的分节同形：◇ 标题 + │ 行，不再是一个专属的框。
      assert.match(stdout.text(), /◇  Ready to install/);
      assert.match(stdout.text(), /│  Skills {4}3 · alpha, beta, gamma/);
      assert.match(stdout.text(), /│  Scope {5}Project/);
      keys(stdin, "\r"); // Yes
      await waitFor("Done!", stdout, 12000);
      assert.equal(await run, undefined);
      const text = stdout.text();
      assert.match(text, /◆  Add Skills/);
      assert.match(text, /✓  Installed/);
      assert.match(text, /◇  3 Skills installed/);
      assert.match(text, /│  ·  Common \(1 Skill\)/);
      assert.match(text, /│  ·  Development \(3 Skills\)/); // 含随包一起装的 common
      assert.match(text, /✓  Done! Installed 2 Packs/);
      assert.match(text, /◇  Select Packs \(2 selected\)/);
      assert.doesNotMatch(text, /╭|╰/, "结果不再是那个只在 Skills 里存在的框");
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
      await waitFor("◆  Select Packs", reinstallOut);
      keys(reinstallIn, "\r"); // common 预选
      await waitFor("◆  Install to", reinstallOut);
      keys(reinstallIn, "\r");
      await waitFor("◆  Scope", reinstallOut);
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

test("the Skills menu offers every action, and Escape leaves without doing anything", async () => {
  await withTempDirectory("avenic-menu-", async (projectRoot) => {
    await withTempDirectory("avenic-catalog-", async (catalogRoot) => {
      await createCatalogFixture(catalogRoot);
      const environment = { AVENIC_CATALOG_SPEC: catalogRoot, AVENIC_STATE_DIR: path.join(projectRoot, ".avenic-state") };
      const stdin = new FakeTTY();
      const stdout = fakeStdout();
      const run = dispatchSkills([], { cwd: projectRoot, environment, prompts: { stdin, stdout }, io: { log() {} } });
      await waitFor("◆  Skills", stdout);
      const menu = stdout.text();
      for (const label of [
        "Add skills",
        "Installed skills",
        "Update skills",
        "Remove skills",
        "Sync SkillsHub",
        "Import from repository",
      ]) {
        assert.match(menu, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      }
      assert.match(menu, /█▀▀█/); // 菜单开在 AVENIC 的字标下面
      assert.match(menu, /│  Add, update, or remove Skills in the project scope/);
      // 这一帧只列可以做的事：离开是 Esc，不是列表里的一行。
      assert.doesNotMatch(menu, /○\s+(Back|cancel|Cancel)\b/);
      assert.match(menu, /└  .*esc cancel/);
      keys(stdin, "\x1b"); // Esc 离开
      await run;
      // 一次中止只有一行 ✖：帧的取消行说了后果，菜单不再补一条 ✓
      const text = stdout.text();
      assert.match(text, /◇  Skills/);
      assert.match(text, /✖  Nothing changed/);
      assert.equal(text.match(/✖/g).length, 1, "取消只印一行");
      // 离开之后什么都没落盘
      assert.ok(!existsSync(path.join(projectRoot, ".avenic.lock.json")), "no lock");
      assert.ok(!existsSync(path.join(projectRoot, ".agents", "skills")), "no skills");
    });
  });
});

test("an Add flow that selects nothing does not install, and cancels in one line", async () => {
  await withTempDirectory("avenic-empty-", async (projectRoot) => {
    await withTempDirectory("avenic-catalog-", async (catalogRoot) => {
      await createCatalogFixture(catalogRoot);
      const environment = { AVENIC_CATALOG_SPEC: catalogRoot, AVENIC_STATE_DIR: path.join(projectRoot, ".avenic-state") };
      const stdin = new FakeTTY();
      const stdout = fakeStdout();
      const run = dispatchSkills(["install"], { cwd: projectRoot, environment, prompts: { stdin, stdout }, io: { log() {} } });
      await waitFor("◆  Select Packs", stdout);
      keys(stdin, " ", "\r"); // 取消勾选（可搜索列表里 n 是过滤词）后回车：既不继续，也不取消
      assert.match(stdout.text(), /Select at least one Pack/);
      assert.doesNotMatch(stdout.text(), /◆  Install to/); // 还停在 Packs 这一帧
      keys(stdin, " ", "\r"); // 选回来，继续往下走
      await waitFor("◆  Install to", stdout);
      keys(stdin, "\x1b"); // 在下一步取消整条流程
      await run;
      const text = stdout.text();
      assert.match(text, /✖  Nothing installed/);
      assert.equal(text.match(/✖/g).length, 1, "整条流程只留一行 ✖");
      assert.match(text, /◇  Install to/);
      assert.ok(!existsSync(path.join(projectRoot, ".avenic.lock.json")), "取消不落盘");
      assert.ok(!existsSync(path.join(projectRoot, ".agents", "skills")), "取消不落盘");
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
      await waitFor("◆  Select Skills", stdout);
      assert.match(stdout.text(), /Found 3 skills/);
      keys(stdin, "b"); // 过滤到 beta
      keys(stdin, " ", "\r"); // 选中 beta
      await waitFor("◆  Install to", stdout);
      keys(stdin, "\r");
      await waitFor("◆  Scope", stdout);
      keys(stdin, "\r");
      await waitFor("Install 1 Skill?", stdout);
      assert.match(stdout.text(), /│  Skills {4}1 · beta/); // 摘要说的是这一次要装的东西
      keys(stdin, "\r"); // Yes
      await waitFor("Done!", stdout, 12000);
      await run;
      assert.match(stdout.text(), /◇  1 Skill installed/);
      assert.match(stdout.text(), /│  ·  beta/);
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
