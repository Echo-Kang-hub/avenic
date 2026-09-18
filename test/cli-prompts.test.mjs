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

test("interactive install: multiselect + confirm → summary box + Done", async () => {
  await withTempDirectory("avenic-interactive-", async (projectRoot) => {
    await withTempDirectory("avenic-catalog-", async (catalogRoot) => {
      await createCatalogFixture(catalogRoot);
      const stdin = new FakeTTY();
      const stdout = fakeStdout();
      const environment = { AVENIC_CATALOG_SPEC: catalogRoot, AVENIC_STATE_DIR: path.join(projectRoot, ".avenic-state") };
      const run = dispatchSkills(["install"], { cwd: projectRoot, environment, prompts: { stdin, stdout }, io: { log() {} } });
      await waitFor("◇  Select Packs", stdout);
      keys(stdin, "\x1b[B", " ", "\r"); // → Development，space 选中，Enter 确认（common 预选）
      await waitFor("Install 2 Packs?", stdout);
      keys(stdin, "\r"); // Yes
      await waitFor("Done!", stdout, 12000);
      assert.equal(await run, undefined);
      const text = stdout.text();
      assert.match(text, /◆  Install Skills/);
      assert.match(text, /✓  Installed/);
      assert.match(text, /╭────────/);
      assert.match(text, /├─ Common/);
      assert.match(text, /└─ Development/);
      assert.match(text, /✓  Done! Installed 2 Packs/);
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
      keys(reinstallIn, "\r", "\r"); // common 预选 + Yes
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
