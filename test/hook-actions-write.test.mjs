import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { hookActionsPath, readHookActions, readHookActionsAt, writeHookActions } from "../packages/core/src/runtime/hook-actions.mjs";

// 动作文件的写那一半：没有它，Hooks 页面上的每一个开关都只能是装饰（P69），而
// `avenic hook emit` 能派发的四类动作（桌面通知 / OpenClaw / Webhook / 自定义命令）
// 也就没有人能配。
//
// 这个文件是 Avenic 自己的（不是 agent 的配置），所以写它不需要归属标记；但它有两条
// 自己的规矩：写下去的东西必须是四类动作之一，而读不懂的文件绝不覆盖 —— 一个手改坏的
// JSON 被「修好」成空列表，就是用户配置过的通知悄悄消失。

function sandbox() {
  return mkdtemp(path.join(os.tmpdir(), "avenic-hook-actions-"));
}

async function machine(root) {
  const project = path.join(root, "project");
  const state = path.join(root, "machine");
  await Promise.all([mkdir(project, { recursive: true }), mkdir(state, { recursive: true })]);
  return { project, environment: { AVENIC_STATE_DIR: state }, state };
}

const desktop = { id: "mine", kind: "desktop" };
const webhook = { id: "team", kind: "webhook", url: "https://example.invalid/hook", timeoutMs: 1500 };

test("a written action is the action that is read back", async () => {
  const root = await sandbox();
  try {
    const { project, environment } = await machine(root);
    const written = await writeHookActions(project, "project", [desktop, webhook], { environment });
    assert.equal(written.changed, true);
    assert.equal(written.file, hookActionsPath(project));
    assert.deepEqual(readHookActionsAt(project, "project", environment), [desktop, webhook]);
    assert.deepEqual(readHookActions(project, environment), readHookActionsAt(project, "project", environment));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the two scopes are two files, and the project answers for its own id", async () => {
  const root = await sandbox();
  try {
    const { project, environment, state } = await machine(root);
    await writeHookActions(project, "global", [{ id: "mine", kind: "desktop" }, { id: "machine", kind: "desktop" }], { environment });
    await writeHookActions(project, "project", [{ id: "mine", kind: "webhook", url: "https://example.invalid/project" }], { environment });
    // 机器上那一份跟着 Avenic 的机器状态走，项目那一份跟着项目走。
    assert.equal(await readFile(path.join(state, "hook-actions.json"), "utf8").then((text) => JSON.parse(text).actions.length), 2);

    const merged = readHookActions(project, environment);
    assert.deepEqual(merged.map((action) => action.id), ["machine", "mine"]);
    assert.equal(merged.find((action) => action.id === "mine").kind, "webhook", "项目里的同名动作说了算");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("writing nothing is the way to remove the last action", async () => {
  const root = await sandbox();
  try {
    const { project, environment } = await machine(root);
    await writeHookActions(project, "project", [desktop], { environment });
    const cleared = await writeHookActions(project, "project", [], { environment });
    assert.equal(cleared.changed, true);
    assert.deepEqual(readHookActionsAt(project, "project", environment), []);
    const again = await writeHookActions(project, "project", [], { environment });
    assert.equal(again.changed, false, "已经是空的再说一次就是没改");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an action Avenic cannot dispatch is refused before anything is written", async () => {
  const root = await sandbox();
  try {
    const { project, environment } = await machine(root);
    const file = hookActionsPath(project);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify({ actions: [desktop] }, null, 2)}\n`);
    const before = await readFile(file, "utf8");

    for (const bad of [
      [{ ...desktop, kind: "telepathy" }],
      [{ kind: "desktop" }],
      [{ id: "  ", kind: "desktop" }],
      [desktop, null],
    ]) {
      await assert.rejects(() => writeHookActions(project, "project", bad, { environment }), /action/i, JSON.stringify(bad));
      assert.equal(await readFile(file, "utf8"), before, "拒绝的时候文件必须一个字节都没动");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a file Avenic cannot read is never overwritten", async () => {
  const root = await sandbox();
  try {
    const { project, environment } = await machine(root);
    const file = hookActionsPath(project);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "{ half a file\n");
    await assert.rejects(() => writeHookActions(project, "project", [desktop], { environment }), /not valid JSON/);
    assert.equal(await readFile(file, "utf8"), "{ half a file\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a file that is there but cannot be read is not written over either", async () => {
  // 「还没写过」和「读不动」在这一段里是同一次 throw，而它们的下一步正好相反：前面那个
  // 是空的，后面那个的内容是用户的。把读不动当成空的，这条路的下一步（把整份名单写掉）
  // 就是把用户配过的通知删掉 —— 上面那条规矩管的是读不懂的 JSON，读不动的文件也一样。
  const root = await sandbox();
  try {
    const { project, environment } = await machine(root);
    const file = hookActionsPath(project);
    await mkdir(file, { recursive: true }); // 那个位置上有一份读不出来的东西
    await assert.rejects(() => writeHookActions(project, "project", [desktop], { environment }), /cannot be read/);
    assert.equal((await stat(file)).isDirectory(), true, "它一个字节都没动");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a project list that can hold a token goes into a repository that ignores it", async () => {
  // 这一页不需要先把 agent 配成 API 就能写下第一份动作，而那份文件可能带着 hook token：
  // 它住在 `.agents/local/` 下，而那条规则只有被 Avenic 配置过的项目才有。没有它，
  // 这个项目里一句 `git add .` 提交进去的就是一个令牌 —— 这不是「多写一条规则」，
  // 是那份文件本来就该在的地方。
  const root = await sandbox();
  try {
    const first = await machine(root);
    spawnSync("git", ["init", "-q"], { cwd: first.project });
    await writeHookActions(first.project, "project", [{ id: "claw", kind: "openclaw", token: "hook-token-not-a-real-one" }], { environment: first.environment });

    const ignored = spawnSync("git", ["check-ignore", "-q", path.join(".agents", "local", "hook-actions.json")], { cwd: first.project });
    assert.equal(ignored.status, 0, "要 git 认这条规则，不是 .gitignore 里有几行字");

    // 全机的那一份不在任何仓库里（它跟着机器状态走）：写下它不该动任何项目的忽略规则。
    const second = await machine(path.join(root, "other"));
    await writeHookActions(second.project, "global", [desktop], { environment: second.environment });
    assert.equal(existsSync(path.join(second.project, ".gitignore")), false, "写下全机那份动作不动项目的忽略规则");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the file that can hold a hook token is not readable by anyone else", { skip: process.platform === "win32" }, async () => {
  const root = await sandbox();
  try {
    const { project, environment } = await machine(root);
    const file = hookActionsPath(project);
    await writeHookActions(project, "project", [{ id: "claw", kind: "openclaw", token: "hook-token-not-a-real-one" }], { environment });
    const { mode } = await import("node:fs/promises").then((fs) => fs.stat(file));
    assert.equal(mode & 0o777, 0o600, "一条动作里可能有 hook token：这个文件只有它的主人能读");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
