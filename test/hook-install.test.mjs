import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 记录器写下的那些行：一个进程一行，行里是它 stdin 上收到的载荷。 */
async function spawnLines(log) {
  try {
    return (await readFile(log, "utf8")).split("\n").filter((line) => line !== "");
  } catch {
    return [];
  }
}

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

test("a settings file Avenic edits keeps the shape its editor wrote", async () => {
  // JSON 只能整个重新序列化 —— 它没有块语法可以插进去。但「重新序列化」不该顺手把用户的
  // 文件重排：一个 4 空格、CRLF、末尾没有换行的 settings 被装一次就整篇变了，用户的 diff
  // 里每一行都在动，而卸载回不到原来的字节 —— 而这个文件的头一句话就是它要回去。
  // （Codex 那一半修的是同一件事，见 model-write 的 mergeCodexConfig。）
  const run = await scratch();
  try {
    const file = path.join(run.project, PROJECT_AGENT_HOMES.claude);
    await mkdir(path.dirname(file), { recursive: true });
    const mine = JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] }, hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }] } }, null, 4).replace(/\n/g, "\r\n");
    await writeFile(file, mine);
    const options = { scope: "project", projectRoot: run.project, environment: run.environment, version: "2.1.274" };

    const plan = await hookPlan("claude", options);
    assert.ok(plan.contents.includes("\r\n"), "行尾跟着文件走");
    assert.match(plan.contents, /^ {4}"permissions"/m, "缩进也跟着文件走");
    await installHooks(plan);
    assert.equal((await run.text(file)).endsWith("\n"), false, "末尾没有换行的文件，装完还是没有");

    const removal = await uninstallHooks(await hookPlan("claude", options));
    assert.equal(removal.changed, true);
    assert.equal(await run.text(file), mine, "卸载之后回到原来的字节");
  } finally {
    await run.done();
  }
});

test("a hook group Avenic cannot classify is kept, not dropped", async () => {
  // 一个组的形状不止一种：有 matcher 没有 hooks 的、甚至根本不是对象的元素。Avenic 认得出
  // 的只有「组里的某个处理器是不是自己的命令」——认不出来的东西就没有资格删。上一版把它们
  // 连组一起抹掉了（不是对象的那个还被展开成了 `{"0":"a",…}`），而那一行是用户写下的。
  const run = await scratch();
  try {
    const file = path.join(run.project, PROJECT_AGENT_HOMES.claude);
    await mkdir(path.dirname(file), { recursive: true });
    const mine = {
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: "echo mine" }] },
          { matcher: "a group with no hooks list of its own" },
          "a line somebody typed",
        ],
      },
    };
    await writeFile(file, `${JSON.stringify(mine, null, 2)}\n`);
    const before = await run.text(file);
    const options = { scope: "project", projectRoot: run.project, environment: run.environment, version: "2.1.274" };

    await installHooks(await hookPlan("claude", options));
    const settings = await readJson(file);
    assert.deepEqual(settings.hooks.Stop.slice(0, 3), mine.hooks.Stop, "读不懂的组也是用户写的：装的时候一条都不能少");
    assert.ok(settings.hooks.Stop.at(-1).hooks.some((handler) => ours(handler.command)), "Avenic 自己那一组接在最后");

    const removal = await uninstallHooks(await hookPlan("claude", options));
    assert.equal(removal.changed, true);
    assert.equal(await run.text(file), before, "卸载之后文件回到原来的字节");
  } finally {
    await run.done();
  }
});

test("an event that is not a list of groups is refused instead of replaced", async () => {
  // 整条事件不是一张组表（手写成一个对象是最常见的那一种）：那一格里没有 Avenic 的东西，
  // 而装进去会把它整个顶掉、卸下来会把它整个删掉 —— 两条路都是把用户的文件改掉，而它读
  // 不懂那一格。所以装这一头说清楚然后什么都不写；卸那一头根本不碰它。
  const run = await scratch();
  try {
    const file = path.join(run.project, PROJECT_AGENT_HOMES.claude);
    await mkdir(path.dirname(file), { recursive: true });
    const mine = { hooks: { Stop: { matcher: ".*", hooks: [{ type: "command", command: "echo mine" }] } } };
    await writeFile(file, `${JSON.stringify(mine, null, 2)}\n`);
    const before = await run.text(file);
    const options = { scope: "project", projectRoot: run.project, environment: run.environment, version: "2.1.274" };

    const plan = await hookPlan("claude", options);
    assert.equal(plan.supported, false, "那一格不是一张组表：装这件事在这里做不了，就不能说得像能做");
    assert.match(plan.note, /hooks\.Stop/);
    assert.equal(await run.text(file), before, "计划是只读的，一个字节都没动");

    const removal = await uninstallHooks(plan);
    assert.equal(removal.changed, false, "那一格里没有我们的东西，就没有可卸的");
    assert.equal(await run.text(file), before, "读不懂的那一格也要原样留着");
  } finally {
    await run.done();
  }
});

test("installing hooks into a file that holds a credential does not republish it", async () => {
  // 同一个文件里可能同时住着用户的密钥和 Avenic 的钩子：项目配置就是 Claude 读凭证
  // 的地方。整文件写入是「写临时文件再改名」，改名换掉的是 inode —— 临时文件的权限
  // 就是改完之后文件的权限。谁也没说过要换权限，那就不能换。
  const run = await scratch();
  try {
    const file = path.join(run.project, PROJECT_AGENT_HOMES.claude);
    const credential = "sk-fixture-not-a-real-key-000000000000";
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: credential } }, null, 2)}\n`, { mode: 0o600 });
    if (process.platform === "win32") return; // Windows: mode 是 ACL 的事，stat 看不到

    await installHooks(await hookPlan("claude", { scope: "project", projectRoot: run.project, environment: run.environment, version: "2.1.274" }));

    assert.equal((await stat(file)).mode & 0o777, 0o600, "装着密钥的文件必须还是只有它的主人能读");
    assert.equal((await readJson(file)).env.ANTHROPIC_AUTH_TOKEN, credential, "安装只加钩子，不动环境变量");
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

test("a file that was already there is still there after the hooks are removed", async () => {
  // 「剩下的一件不是用户的」推不出「文件是 Avenic 建的」。用户可能本来就放了一个
  // `{}` 在这里：收走它不是在清理自己的东西，是在删用户的数据。
  const run = await scratch();
  try {
    const file = path.join(run.project, PROJECT_AGENT_HOMES.claude);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "{}\n");
    const options = { scope: "project", projectRoot: run.project, environment: run.environment, version: "2.1.274" };
    await installHooks(await hookPlan("claude", options));
    const result = await uninstallHooks(await hookPlan("claude", options));
    assert.equal(result.changed, true);
    assert.equal(await run.exists(file), true, "文件本来就在，卸载不该把它一起收走");
    assert.equal(await run.text(file), "{}\n", "空配置回到原来的字节");
  } finally {
    await run.done();
  }
});

test("Codex's own project home keeps its file too", async () => {
  const run = await scratch();
  try {
    const options = { scope: "project", projectRoot: run.project, environment: run.environment, version: "0.154.0" };
    const plan = await hookPlan("codex", options);
    await installHooks(plan);
    assert.equal(await run.exists(plan.file), true);
    const result = await uninstallHooks(await hookPlan("codex", options));
    assert.equal(result.changed, true);
    assert.equal(await run.exists(plan.file), true, "同一件事在 Codex 上也是同一件事：读不出创建者的文件不删");
    assert.equal((await run.text(plan.file)).trim(), "");
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

test("the project Codex caveat says who even reads that file", async () => {
  // 项目里那份 config.toml 是 project 自己的 Codex home，而只有 Avenic 起的 Codex 会被
  // 指到那里（agentRuntimeEnvironment 把它写进 CODEX_HOME）。用户自己开的 codex 读的是
  // 自己的家：装上了、审阅过了、还是不响 —— 这件事得在装之前就说。
  const run = await scratch();
  try {
    const options = { projectRoot: run.project, environment: run.environment, version: "0.154.0" };
    const project = await hookPlan("codex", { ...options, scope: "project" });
    assert.match(project.caveat, /avenic codex/i, "项目里的那份要由 Avenic 起的 Codex 才读到");
    const global = await hookPlan("codex", { ...options, scope: "global" });
    assert.doesNotMatch(global.caveat, /avenic codex/i, "全局那份每个 Codex 都读得到，不需要这句话");
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

test("an install cannot replace a plugin at that path that Avenic did not write", async () => {
  // 这一种的文件整个归 Avenic —— 没有可以并进去的地方，所以「那个位置上是别人的插件」
  // 是这一种机制特有的状态，而它对装和卸说的是同一件事：动不了。装的那一下尤其要问，
  // 因为写下去不是合并，是把用户的插件删掉。装不上还必须说得出口：一颗按下去什么都不
  // 发生的按钮，比装不上更难懂。
  const run = await scratch();
  try {
    const options = { scope: "project", projectRoot: run.project, environment: run.environment, version: "1.18.30" };
    const file = path.join(run.project, ".opencode", "plugins", "avenic-hooks.js");
    const mine = "// my own plugin\nexport const Mine = async () => ({});\n";
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, mine);

    const plan = await hookPlan("opencode", options);
    assert.equal(plan.supported, false, "别人的插件占着那个路径：这里装不了");
    assert.match(plan.note, /is not Avenic's/, "为什么装不了是一句话，不是一次沉默");
    assert.equal(plan.contents, mine, "预览里画的必须是盘上现在这一份");
    const installed = await installHooks(plan);
    assert.equal(installed.changed, false);
    assert.equal(await run.text(file), mine, "别人的插件一个字节都没动");

    const status = await hookStatus("opencode", options);
    assert.equal(status.supported, false, "行上也要说得出装不了");
    assert.equal(status.installed, false);

    // 带归属标记的文件还是 Avenic 的：别人占了那个路径，不等于自己写的那一份也不能重写。
    await writeFile(file, "// avenic:hooks\n// an older plugin body\n");
    const own = await hookPlan("opencode", options);
    assert.equal(own.supported, true);
    assert.equal((await installHooks(own)).changed, true);
    assert.match(await run.text(file), /avenic hook emit --agent opencode/, "自己那份照旧被写成当前的样子");

    // 计划是一张快照，而它最常是在那个路径还空着的时候问的（装之前先看一眼）。问过之后、
    // 动手之前，用户可以把他的插件放进那个路径（编辑器、另一个 Avenic、他自己），所以
    // 真正写下去的那一下要再读一次：读到的不是空的了，就不动手。
    await rm(file);
    const whileEmpty = await hookPlan("opencode", options);
    assert.equal(whileEmpty.supported, true, "空着的路径上是装得了的");
    await writeFile(file, mine);
    const raced = await installHooks(whileEmpty);
    assert.equal(raced.changed, false);
    assert.equal(await run.text(file), mine, "计划之后落下来的那一份也不动");
  } finally {
    await run.done();
  }
});

test("a mention of the marker is not the marker", async () => {
  // 归属标记是那一行注释，不是这七个字母：别人的插件在别处提到 `avenic:hooks`（一句
  // 注释、一个字面量），整文件出现即归属就等于「只要提到过就是我们的，可以删」。
  const run = await scratch();
  try {
    const file = path.join(run.project, ".opencode", "plugins", "avenic-hooks.js");
    await mkdir(path.dirname(file), { recursive: true });
    const mine = `// my own plugin, which mentions avenic:hooks in passing\nexport const Mine = async () => ({});\n`;
    await writeFile(file, mine);
    const options = { scope: "project", projectRoot: run.project, environment: run.environment, version: "1.18.30" };

    assert.equal((await hookStatus("opencode", options)).installed, false, "提到过不等于 Avenic 写过");
    const result = await uninstallHooks(await hookPlan("opencode", options));
    assert.equal(result.changed, false);
    assert.equal(await run.text(file), mine, "别人的插件一个字节都不动");
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

// OpenCode 的事件流里，助手每写一个增量都发一次事件（`message.part.updated`），
// `message.updated` 也是助手每更新一次就发一次 —— 一次真实的会话里那是几百条。原来的
// 插件为**每一条**起一个 `avenic hook emit`：core 的 normalizeHook 当然会把它们丢掉，
// 但丢在进程之后，几百个进程的代价已经付掉了（每一轮都要付一次）。过滤要发生在插件这一
// 层，名单从事件矩阵里来 —— 手抄的那一份会和 core 的规则分岔。
//
// 这一条只有把装好的那个文件真的跑起来才算数：断言文本里写着守门的那一行证明不了没有
// 进程跑过；把进程数出来才是。假 PATH 上放一个记录器，agent 的钩子进程长什么样，这里
// 就数到什么。
test("the installed plugin starts no process for the events the matrix does not map", async () => {
  const run = await scratch();
  const bin = path.join(run.root, "bin");
  const log = path.join(run.root, "spawns.log");
  const saved = { PATH: process.env.PATH, Path: process.env.Path, recorderLog: process.env.AVENIC_RECORDER_LOG };
  try {
    await mkdir(bin, { recursive: true });
    const recorder = path.join(bin, "recorder.mjs");
    await writeFile(recorder, [
      'import { appendFileSync } from "node:fs";',
      'let data = "";',
      "for await (const chunk of process.stdin) data += chunk;",
      'appendFileSync(process.env.AVENIC_RECORDER_LOG, data + "\\n");',
      "",
    ].join("\n"));
    const shim = process.platform === "win32" ? path.join(bin, "avenic.cmd") : path.join(bin, "avenic");
    await writeFile(shim, process.platform === "win32"
      ? `@echo off\r\n"${process.execPath}" "${recorder}" %*\r\n`
      : `#!/bin/sh\nexec "${process.execPath}" "${recorder}" "$@"\n`);
    if (process.platform !== "win32") await chmod(shim, 0o755);
    // 插件起的进程走 shell，PATH 是它唯一会看的地方：这一条测试里的 `avenic` 就是记录器。
    process.env.PATH = bin;
    process.env.Path = bin;
    process.env.AVENIC_RECORDER_LOG = log;

    const plan = await hookPlan("opencode", { scope: "project", projectRoot: run.project, environment: run.environment, version: "1.18.30" });
    await installHooks(plan);
    // 装出来的那个文件，按它自己的字节加载：`data:` 只绕开「临时目录里没有 package.json，
    // `.js` 会被当成 CommonJS」这一件事。
    const plugin = await import(`data:text/javascript;base64,${Buffer.from(await readFile(plan.file, "utf8")).toString("base64")}`);
    const hooks = await plugin.AvenicHooks({ directory: run.project });
    const fire = (event) => hooks.event({ event });
    await fire({ type: "message.part.updated", properties: { sessionID: "s", part: { text: "delta" } } });
    await fire({ type: "message.updated", properties: { sessionID: "s", info: { role: "assistant" } } });
    await fire({ type: "message.updated", properties: { sessionID: "s", info: { role: "user" } } });
    await fire({ type: "session.idle", properties: { sessionID: "s" } });

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && (await spawnLines(log)).length < 2) await sleep(25);
    // 再等一拍才数：多出来的那个进程如果会来，这时候也该到了。端口（Windows 每一轮开一个
    // 进程的代价就在这里）不是靠文本断言守住的。
    await sleep(300);
    const recorded = await spawnLines(log);
    assert.equal(recorded.length, 2, `四条事件里只该有两条值得起一个进程，实际起了 ${recorded.length} 个：\n${recorded.join("\n")}`);
    const payloads = recorded.map((line) => JSON.parse(line));
    assert.deepEqual(payloads.map((payload) => payload.type).sort(), ["message.updated", "session.idle"], "起的两个进程分别是用户的提问和一次空转结束");
    const user = payloads.find((payload) => payload.type === "message.updated");
    assert.equal(user.info.role, "user", "转发的 message.updated 是用户那一条，不是助手的");
    assert.equal(user.directory, run.project, "摊平之后目录还在：矩阵按这个字段读 cwd");
    for (const payload of payloads) assert.equal(payload.sessionID, "s");
  } finally {
    // 记录器是被 detach 的：先让最后这一拍落完，再去删它正在写的目录。
    await sleep(400);
    if (saved.PATH === undefined) delete process.env.PATH; else process.env.PATH = saved.PATH;
    if (saved.Path === undefined) delete process.env.Path; else process.env.Path = saved.Path;
    if (saved.recorderLog === undefined) delete process.env.AVENIC_RECORDER_LOG; else process.env.AVENIC_RECORDER_LOG = saved.recorderLog;
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

test("a quote in somebody else's command does not make it Avenic's", async () => {
  // 引号是认路径用的，不是归属标记：一句 `echo "avenic hook emit"` 里也有这几个词。
  // 认错了的代价是把用户的钩子从用户的文件里删掉 —— 这是最不能出的那一类错。
  const run = await scratch();
  try {
    const file = path.join(run.project, PROJECT_AGENT_HOMES.claude);
    await mkdir(path.dirname(file), { recursive: true });
    const mine = { hooks: { Stop: [{ hooks: [{ type: "command", command: 'echo "avenic hook emit"' }] }] } };
    await writeFile(file, `${JSON.stringify(mine, null, 2)}\n`);
    const before = await run.text(file);
    const options = { scope: "project", projectRoot: run.project, environment: run.environment, version: "2.1.274" };

    assert.equal((await hookPlan("claude", options)).installed, false, "别人的命令里出现这几个词，不等于 Avenic 装过");
    const result = await uninstallHooks(await hookPlan("claude", options));
    assert.equal(result.changed, false);
    assert.equal(await run.text(file), before, "一个 echo 不该让 Avenic 去动别人的文件");
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

test("a file Avenic cannot read is one agent's answer, and a plan still refuses", async () => {
  // 状态是只读的：读不出一个 agent 的文件是**那个 agent 的答案**（装没装：不知道），不是
  // 另外两行的死因 —— CLI 的三行与 VS Code 的那一页从同一次 hookStatus 拿答案，一个
  // EACCES/EISDIR 不该把三个答案一起带走。写入计划不走这条路：读不出现状的**计划**不算
  // 计划，在那儿读不动仍然当场抛错。
  const run = await scratch();
  try {
    const file = path.join(run.project, PROJECT_AGENT_HOMES.claude);
    await mkdir(file, { recursive: true }); // 同名目录：存在，但读不出来
    const options = { scope: "project", projectRoot: run.project, environment: run.environment, version: "2.1.274" };

    await assert.rejects(() => hookPlan("claude", options), /cannot be read/, "写与预览读不动就该失败");

    const status = await hookStatus("claude", options);
    assert.equal(status.installed, null, "读不出来就说不知道，不许说成没装");
    assert.equal(status.file, file);
    assert.match(status.error, /cannot be read/);
    assert.ok(status.error.includes(file), `那句话要说清是哪个文件：${status.error}`);
    assert.equal(status.supported, true, "文件读不动不影响版本判断");

    const sibling = await hookStatus("codex", options);
    assert.equal(sibling.installed, false, "另一个 agent 的答案不受牵连");
    assert.equal(sibling.error, undefined);
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
