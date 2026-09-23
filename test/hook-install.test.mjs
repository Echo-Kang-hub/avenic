import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { configurationDiff } from "../packages/core/src/runtime/model-write.mjs";
import { hookPlan, hookStatus, installHooks, uninstallHooks } from "../packages/core/src/runtime/hook-install.mjs";

// 安装的一半：把 Avenic 的钩子写进 agent 自己的配置，并且只写这一件事。
//
// 这些文件不是 Avenic 的。用户的 `.claude/settings.local.json` 里有他的权限、他自己的
// 钩子、他自己的环境变量；`~/.codex/config.toml` 里有他的注释和整张表。所以这里的每一条
// 断言都朝向同一件事：Avenic 加进去的那一块是**可识别的**（只看命令就知道是不是我们的），
// 别的一切原样留着；卸载之后文件回到原来的样子，一个字节都不多。
//
// 另一件事同样重要，而且更容易写漏：装着不响的钩子。Codex 写下去的钩子在用户审阅之前是
// untrusted，装完不等于会响 —— 这一条必须由 plan 自己说出来，而不是让用户以为通知坏了。
//
// 所有路径都由测试自己的 environment 决定：机器上的 `~/.claude`、`~/.codex` 一次都不碰。

const PROJECT_AGENT_HOMES = { claude: ".claude/settings.local.json", codex: ".agents/local/codex/config.toml" };

async function scratch() {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-hook-install-"));
  const project = path.join(root, "project");
  const home = path.join(root, "home");
  await Promise.all([mkdir(project, { recursive: true }), mkdir(home, { recursive: true })]);
  return {
    root,
    project,
    home,
    environment: { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"), CODEX_HOME: path.join(home, ".codex") },
    async text(file) {
      return readFile(file, "utf8");
    },
    async exists(file) {
      try {
        await readFile(file);
        return true;
      } catch {
        return false;
      }
    },
    done: () => rm(root, { recursive: true, force: true }),
  };
}

const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));
const ours = (command) => typeof command === "string" && command.includes("avenic hook emit");

test("a fresh Claude project gets the file the agent reads, and nothing else", async () => {
  const run = await scratch();
  try {
    const plan = await hookPlan("claude", { scope: "project", projectRoot: run.project, environment: run.environment, version: "2.1.274" });
    assert.equal(plan.file, path.join(run.project, PROJECT_AGENT_HOMES.claude));
    assert.equal(plan.supported, true);
    assert.equal(plan.installed, false);
    const result = await installHooks(plan);
    assert.equal(result.changed, true);
    const settings = await readJson(plan.file);
    // 一个事件都没漏：六个事件里 Claude 全都可靠。
    for (const event of ["SessionStart", "UserPromptSubmit", "Stop", "StopFailure", "SessionEnd", "Notification"]) {
      assert.ok(Array.isArray(settings.hooks[event]) && settings.hooks[event].length > 0, `${event} 没装上`);
    }
    assert.ok(settings.hooks.Notification[0].matcher.includes("permission_prompt"), "Notification 只认那四种类型");
    assert.equal(await run.exists(path.join(run.home, ".claude", "settings.json")), false);
    // 装的时候没写秘密：这一块只有一条命令行。
    assert.doesNotMatch(await run.text(plan.file), /TOKEN|API_KEY|https?:\/\//i);
  } finally {
    await run.done();
  }
});

test("the user's own settings survive an install and come back on uninstall", async () => {
  const run = await scratch();
  try {
    const file = path.join(run.project, PROJECT_AGENT_HOMES.claude);
    await mkdir(path.dirname(file), { recursive: true });
    const mine = { permissions: { allow: ["Bash(ls:*)"] }, hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }] }, env: { MY_FLAG: "1" } };
    await writeFile(file, `${JSON.stringify(mine, null, 2)}\n`);
    const before = await run.text(file);

    const plan = await hookPlan("claude", { scope: "project", projectRoot: run.project, environment: run.environment, version: "2.1.274" });
    await installHooks(plan);
    const settings = await readJson(file);
    assert.deepEqual(settings.permissions, mine.permissions, "用户的权限被改了");
    assert.deepEqual(settings.env, mine.env, "用户的环境变量被改了");
    assert.deepEqual(settings.hooks.Stop.filter((group) => group.hooks.some((handler) => !ours(handler.command))), mine.hooks.Stop, "用户自己的 Stop 钩子被顶掉了");
    assert.ok(settings.hooks.Stop.some((group) => group.hooks.some((handler) => ours(handler.command))), "Avenic 的 Stop 钩子没装上");

    const removal = await uninstallHooks(await hookPlan("claude", { scope: "project", projectRoot: run.project, environment: run.environment, version: "2.1.274" }));
    assert.equal(removal.changed, true);
    assert.equal(await run.text(file), before, "卸载之后文件该回到原来的字节");
  } finally {
    await run.done();
  }
});

test("installing twice writes once", async () => {
  const run = await scratch();
  try {
    const options = { scope: "project", projectRoot: run.project, environment: run.environment, version: "2.1.274" };
    await installHooks(await hookPlan("claude", options));
    const after = await run.text((await hookPlan("claude", options)).file);
    const again = await installHooks(await hookPlan("claude", options));
    assert.equal(again.changed, false, "第二次安装什么也没改，就该说没改");
    assert.equal(await run.text((await hookPlan("claude", options)).file), after);
    assert.equal((await hookStatus("claude", options)).installed, true);
  } finally {
    await run.done();
  }
});

test("uninstalling what was never installed changes nothing", async () => {
  const run = await scratch();
  try {
    const result = await uninstallHooks(await hookPlan("claude", { scope: "project", projectRoot: run.project, environment: run.environment, version: "2.1.274" }));
    assert.equal(result.changed, false);
    assert.equal(await run.exists(result.file), false, "没装过就不该留下一份空配置");
  } finally {
    await run.done();
  }
});

test("global scope lives in the agent's own home, project scope in the project", async () => {
  const run = await scratch();
  try {
    const global = await hookPlan("claude", { scope: "global", projectRoot: run.project, environment: run.environment, version: "2.1.274" });
    assert.equal(global.file, path.join(run.home, ".claude", "settings.json"));
    await installHooks(global);
    assert.equal(await run.exists(path.join(run.project, PROJECT_AGENT_HOMES.claude)), false, "装全局不该往项目里写");

    const project = await hookPlan("claude", { scope: "project", projectRoot: run.project, environment: run.environment, version: "2.1.274" });
    await installHooks(project);
    assert.deepEqual((await readJson(global.file)).hooks.Stop.length, 1, "项目安装不该动全局的文件");
    assert.equal((await hookStatus("claude", { scope: "global", projectRoot: run.project, environment: run.environment, version: "2.1.274" })).installed, true);
  } finally {
    await run.done();
  }
});

test("a version that cannot carry the hooks is refused with the reason", async () => {
  const run = await scratch();
  try {
    const plan = await hookPlan("claude", { scope: "project", projectRoot: run.project, environment: run.environment, version: "2.0.0" });
    assert.equal(plan.supported, false);
    assert.equal(plan.note, "Unsupported by Claude Code 2.0.0");
    assert.equal(await installHooks(plan).then((result) => result.changed), false);
    assert.equal(await run.exists(plan.file), false, "不支持就不该留下半个文件");
  } finally {
    await run.done();
  }
});

test("an unreadable configuration is never repaired", async () => {
  const run = await scratch();
  try {
    const file = path.join(run.project, PROJECT_AGENT_HOMES.claude);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "{ this is not json\n");
    // 计划阶段就拒绝：连「将要写什么」都说不出来的文件，不能走到写那一步。
    await assert.rejects(
      () => hookPlan("claude", { scope: "project", projectRoot: run.project, environment: run.environment, version: "2.1.274" }),
      /not valid JSON/,
    );
    assert.equal(await run.text(file), "{ this is not json\n", "读不懂的文件必须原样留着");
  } finally {
    await run.done();
  }
});

test("Codex gets a marked block in its own config.toml, and keeps every other line", async () => {
  const run = await scratch();
  try {
    const file = path.join(run.home, ".codex", "config.toml");
    await mkdir(path.dirname(file), { recursive: true });
    const mine = ['# my own codex config', 'model = "gpt-5-codex"', "", "[mcp_servers.mine]", 'command = "my-server"', ""].join("\n");
    await writeFile(file, mine);

    const plan = await hookPlan("codex", { scope: "global", projectRoot: run.project, environment: run.environment, version: "0.154.0" });
    assert.equal(plan.file, file);
    const result = await installHooks(plan);
    assert.equal(result.changed, true);
    const written = await run.text(file);
    assert.ok(written.startsWith(mine), "用户原有的行必须原样在前面");
    assert.match(written, /avenic hook emit --agent codex/);
    // Codex 的钩子在审阅之前是 untrusted：说的话必须在这里，不能等用户去猜。
    assert.match(plan.caveat, /untrusted|review/i);

    await uninstallHooks(plan);
    assert.equal(await run.text(file), mine, "卸载之后 Codex 的配置该回到原来的字节");
  } finally {
    await run.done();
  }
});

test("a Codex that cannot have hooks says so instead of writing them", async () => {
  const run = await scratch();
  try {
    const plan = await hookPlan("codex", { scope: "global", projectRoot: run.project, environment: run.environment, version: "0.150.1" });
    assert.equal(plan.supported, false);
    assert.equal(plan.note, "Unsupported by Codex 0.150.1");
    await installHooks(plan);
    assert.equal(await run.exists(plan.file), false);
  } finally {
    await run.done();
  }
});

test("OpenCode's plugin file is Avenic's own, and only Avenic's own is ever removed", async () => {
  const run = await scratch();
  try {
    const plan = await hookPlan("opencode", { scope: "project", projectRoot: run.project, environment: run.environment, version: "1.18.30" });
    assert.equal(plan.file, path.join(run.project, ".opencode", "plugins", "avenic-hooks.js"));
    await installHooks(plan);
    const written = await run.text(plan.file);
    assert.match(written, /avenic/, "插件文件里要有 Avenic 的归属标记");
    assert.match(written, /avenic hook emit --agent opencode/);

    // 别人的文件永远不动：把它换成同名但没有标记的那一份，卸载必须拒绝。
    const foreign = path.join(run.project, ".opencode", "plugins", "avenic-hooks.js");
    await writeFile(foreign, "// someone else's plugin\n");
    const refused = await uninstallHooks(plan);
    assert.equal(refused.changed, false);
    assert.equal(await run.text(foreign), "// someone else's plugin\n", "没有归属标记的文件不是 Avenic 的");

    await writeFile(foreign, written);
    const removed = await uninstallHooks(plan);
    assert.equal(removed.changed, true);
    assert.equal(await run.exists(foreign), false);
  } finally {
    await run.done();
  }
});

test("the Codex block is the two-table shape the binary's schema reads", async () => {
  const run = await scratch();
  try {
    // 形状不是 Avenic 定的：Codex 的 serde 反射里，事件下挂的是 MatcherGroup
    // （恰好 matcher 和 hooks 两个字段），处理器是内部打标签的枚举，command 处理器
    // 要 `type = "command"`。把 `command` 直接写在事件表下面，读到的就是一个不认识的
    // 字段 —— 装上了而永远不会响，和没装一模一样。
    const plan = await hookPlan("codex", { scope: "global", projectRoot: run.project, environment: run.environment, version: "0.154.0" });
    const lines = plan.contents.split("\n");
    const events = [];
    for (let index = 0; index < lines.length; index += 1) {
      const outer = /^\[\[hooks\.([A-Za-z]+)\]\]$/.exec(lines[index]);
      if (outer === null) continue;
      events.push(outer[1]);
      const handler = `[[hooks.${outer[1]}.hooks]]`;
      assert.equal(lines[index + 1]?.trim(), handler, `${outer[1]} 的处理器表没有嵌在事件表下面`);
      assert.equal(lines[index + 2]?.trim(), 'type = "command"');
      assert.equal(lines[index + 3]?.trim(), 'command = "avenic hook emit --agent codex"');
    }
    assert.deepEqual(
      [...events].sort(),
      ["PermissionRequest", "SessionEnd", "SessionStart", "Stop", "UserPromptSubmit"],
      "Codex 的事件名要用它自己那十二个名字里的 PascalCase",
    );
    const loose = lines.filter((line) => /^\s*command\s*=/.test(line));
    assert.equal(loose.length, events.length, "每条命令都该在自己的处理器表下面，不该有散在组里的");
  } finally {
    await run.done();
  }
});

test("the OpenCode plugin flattens the event to the fields the matrix reads", async () => {
  const run = await scratch();
  try {
    // 矩阵读的是载荷顶层的 `type` / `sessionID` / `directory`（`hooks.test.mjs` 就是
    // 按这个形状调 `normalizeHook` 的）。而原生事件把 sessionID 放在 `properties`
    // 里面、目录根本不在事件里（它是插件自己的入参）—— 不摊平，一个 OpenCode 事件
    // 归一化出来就是没有会话、没有目录的一条记录。摊平是插件文件的职责，因为它是
    // Avenic 自己的文件。
    const plan = await hookPlan("opencode", { scope: "project", projectRoot: run.project, environment: run.environment, version: "1.18.30" });
    const text = plan.contents;
    assert.match(text, /export const AvenicHooks = async \(\{ directory \}\) => \(\{$/m, "插件要拿得到自己的 directory 入参");
    assert.match(text, /report\(\{ directory, \.\.\.event\.properties, type: event\.type \}\)/, "载荷要摊平成矩阵读的那个形状");
  } finally {
    await run.done();
  }
});

test("a configuration that exists but cannot be read is refused, not overwritten", async () => {
  const run = await scratch();
  try {
    // 读不出来 ≠ 不存在。把读不到的路径当成空文件，装下去就是把用户自己的设置
    // （权限、他自己写的钩子、环境变量）换成 Avenic 的一块 —— 而重命名成功只需要
    // 目标可写、不需要目标可读，所以这一步不是写入层能替用户挡住的。这里用同名
    // 目录制造「有这个路径、但读不成文本」：任何非「文件不在」的失败答案都一样。
    const file = path.join(run.project, PROJECT_AGENT_HOMES.claude);
    await mkdir(file, { recursive: true });
    await assert.rejects(
      () => hookPlan("claude", { scope: "project", projectRoot: run.project, environment: run.environment, version: "2.1.274" }),
      /cannot be read/,
    );
    assert.equal((await stat(file)).isDirectory(), true, "读不到的路径必须原样留着");
  } finally {
    await run.done();
  }
});

test("an entry the user moved behind a quoted path is still Avenic's own", async () => {
  const run = await scratch();
  try {
    // Windows 上 `avenic` 不在 agent 的 PATH 上时，把完整路径引起来是常规写法。
    // 认不出它：status 说没装、install 装出第二份（每件事响两次）、uninstall 说
    // 「已移除」却把它留在文件里。
    const file = path.join(run.project, PROJECT_AGENT_HOMES.claude);
    await mkdir(path.dirname(file), { recursive: true });
    const quoted = '"C:\\npm\\avenic.cmd" hook emit --agent claude';
    await writeFile(file, `${JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] }, hooks: { Stop: [{ hooks: [{ type: "command", command: quoted }] }] } }, null, 2)}\n`);
    const options = { scope: "project", projectRoot: run.project, environment: run.environment, version: "2.1.274" };

    assert.equal((await hookPlan("claude", options)).installed, true, "带引号的入口也是 Avenic 的");
    await installHooks(await hookPlan("claude", options));
    const settings = await readJson(file);
    assert.equal(settings.hooks.Stop.flatMap((group) => group.hooks).filter((handler) => ours(handler.command)).length, 1, "不能装出第二份");
    const again = await installHooks(await hookPlan("claude", options));
    assert.equal(again.changed, false, "第二次安装什么也没改");

    await uninstallHooks(await hookPlan("claude", options));
    const left = await readJson(file);
    assert.deepEqual(left.permissions, { allow: ["Bash(ls:*)"] }, "用户自己的设置要留着");
    assert.equal(JSON.stringify(left).includes("avenic"), false, "卸载之后一个入口都不剩");
  } finally {
    await run.done();
  }
});

test("the preview a user approves never carries a secret", async () => {
  const run = await scratch();
  try {
    const file = path.join(run.project, PROJECT_AGENT_HOMES.claude);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "sk-not-a-real-token-000" } }, null, 2)}\n`);
    const plan = await hookPlan("claude", { scope: "project", projectRoot: run.project, environment: run.environment, version: "2.1.274" });
    const diff = configurationDiff(plan.before, plan.contents);
    assert.ok(diff.some((line) => line.kind === "add"), "预览里得有要加进去的那些行");
    for (const line of diff) assert.doesNotMatch(line.text, /sk-not-a-real-token-000/, "预览不能把秘密抄一遍");
  } finally {
    await run.done();
  }
});

test("every scope and agent names the file it will write", async () => {
  const run = await scratch();
  try {
    const seen = new Map();
    for (const agentId of ["claude", "codex", "opencode"]) {
      for (const scope of ["project", "global"]) {
        const plan = await hookPlan(agentId, { scope, projectRoot: run.project, environment: run.environment, version: null });
        assert.ok(path.isAbsolute(plan.file), `${agentId}/${scope} 没说出文件`);
        assert.equal(seen.has(plan.file), false, `${agentId}/${scope} 和别人抢同一个文件：${plan.file}`);
        seen.set(plan.file, true);
        assert.ok(plan.contents.length > 0, `${agentId}/${scope} 没生成内容`);
        // 版本读不出来时不许硬说支持：说不支持，并带上理由。
        assert.equal(plan.supported, false);
        assert.match(plan.note, /could not be read/);
      }
    }
    assert.equal(seen.size, 6);
  } finally {
    await run.done();
  }
});
