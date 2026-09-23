import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { dispatchHookCommand } from "../packages/cli/src/cli/hooks-cli.mjs";

// `avenic hook install|uninstall|status` — 安装那一半的入口，也是这件事在 VS Code 关着
// 的时候唯一的入口（P50/P74）。这些测试把它当成用户会用的那个东西：一个项目、一台机器
// 上装着的 agent、一次真实的回答。
//
// 每条路径都活在自己的临时目录里：假 HOME、假 agent 的家、假的 PATH。机器上真实的
// `~/.claude`、`~/.codex` 与真实的 agent CLI 一次都不碰 —— 那个装了哪个版本，是用户
// 机器的事实，不是这里的输入。

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agentBin = path.join(packageRoot, "packages", "cli", "scripts", "skills.mjs");

function capturing() {
  const lines = [];
  const errors = [];
  return { lines, errors, log: (line) => lines.push(String(line)), error: (line) => errors.push(String(line)) };
}

/** A machine whose agents answer `--version` with what the test decides. */
async function machine({ versions = {} } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-hook-cli-"));
  const bin = path.join(root, "bin");
  const project = path.join(root, "project");
  const home = path.join(root, "home");
  await Promise.all([mkdir(bin, { recursive: true }), mkdir(project, { recursive: true }), mkdir(home, { recursive: true })]);
  for (const [agentId, version] of Object.entries(versions)) {
    if (version === null) continue;
    const probe = path.join(bin, `${agentId}-version.mjs`);
    await writeFile(probe, `if (process.argv.includes("--version")) process.stdout.write(${JSON.stringify(`${version}\n`)});\n`);
    const shim = process.platform === "win32" ? path.join(bin, `${agentId}.cmd`) : path.join(bin, agentId);
    // shim 里写的是这个 node 的绝对路径：PATH 上只有这个目录，于是这台机器上真实装着的
    // agent 一个都看不见 —— 测的是版本判断，不是「开发机上恰好装了什么」。
    await writeFile(shim, process.platform === "win32" ? `@echo off\r\n"${process.execPath}" "${probe}" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${probe}" "$@"\n`);
    if (process.platform !== "win32") await chmod(shim, 0o755);
  }
  const environment = {
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    CODEX_HOME: path.join(home, ".codex"),
    PATH: bin,
    Path: bin,
    AVENIC_STATE_DIR: path.join(root, "state"),
  };
  return {
    root,
    project,
    home,
    environment,
    context: (io) => ({ io, environment, cwd: project }),
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

test("install writes the project's hooks, and uninstall takes exactly them away", async () => {
  const run = await machine({ versions: { claude: "2.1.274" } });
  try {
    const cli = capturing();
    const installed = await dispatchHookCommand(["install", "--agent", "claude", "--scope", "project"], run.context(cli));
    assert.equal(installed, 0, cli.errors.join("\n"));
    const file = path.join(run.project, ".claude", "settings.local.json");
    const settings = JSON.parse(await readFile(file, "utf8"));
    assert.ok(settings.hooks.Stop.some((group) => group.hooks.some((handler) => handler.command === "avenic hook emit --agent claude")));
    assert.match(cli.lines.join("\n"), /^Installed: Claude Code hooks for this project — /m);

    const second = capturing();
    const again = await dispatchHookCommand(["install", "--agent", "claude", "--scope", "project"], run.context(second));
    assert.equal(again, 0);
    assert.match(second.lines.join("\n"), /^Already installed: /m, "第二次安装要说的是「已经装着了」，不是「装好了」");

    const removed = capturing();
    assert.equal(await dispatchHookCommand(["uninstall", "--agent", "claude", "--scope", "project"], run.context(removed)), 0);
    assert.match(removed.lines.join("\n"), /^Removed: /m);
    // 「摘掉我们的条目之后文件空了」推不出「文件是 Avenic 建的」：用户可能就是从一个
    // `{}` 开始的。留一个空配置无害，删掉用户的数据要重得多 —— 所以那一行还在，
    // 里面一个条目都不剩。
    assert.equal(await run.exists(file), true, "读不出创建者就把文件留下，只摘走自己那几条");
    assert.equal((await readFile(file, "utf8")).trim(), "{}");

    const nothing = capturing();
    assert.equal(await dispatchHookCommand(["uninstall", "--agent", "claude", "--scope", "project"], run.context(nothing)), 0);
    assert.match(nothing.lines.join("\n"), /^Nothing to remove: /m);
  } finally {
    await run.done();
  }
});

test("--dry-run shows what would change and writes nothing", async () => {
  const run = await machine({ versions: { claude: "2.1.274" } });
  try {
    const cli = capturing();
    const status = await dispatchHookCommand(["install", "--agent", "claude", "--scope", "project", "--dry-run"], run.context(cli));
    assert.equal(status, 0, cli.errors.join("\n"));
    const text = cli.lines.join("\n");
    assert.match(text, /^\+ .*"Stop"/m, "预览里要能看见要加进去的那一行");
    assert.match(text, /avenic hook emit --agent claude/);
    assert.match(text, /Nothing was written/);
    assert.equal(await run.exists(path.join(run.project, ".claude", "settings.local.json")), false);
  } finally {
    await run.done();
  }
});

test("an agent that cannot carry the hooks is refused, in its own words", async () => {
  const run = await machine({ versions: { claude: "2.0.0" } });
  try {
    const cli = capturing();
    const status = await dispatchHookCommand(["install", "--agent", "claude"], run.context(cli));
    assert.equal(status, 1);
    assert.match(cli.errors.join("\n"), /Unsupported by Claude Code 2\.0\.0/);
    assert.equal(await run.exists(path.join(run.project, ".claude", "settings.local.json")), false);
  } finally {
    await run.done();
  }
});

test("a path that already holds somebody else's plugin is refused, and nothing is written", async () => {
  // OpenCode 的那一份是整个文件归 Avenic 的，所以那个路径上先有一份别人的插件时，装就是
  // 把用户的插件删掉。装不上要说得出为什么，而「None to install」那种沉默不是答案。
  const run = await machine({ versions: { claude: "2.1.274", codex: "0.154.0", opencode: "1.18.30" } });
  try {
    const file = path.join(run.project, ".opencode", "plugins", "avenic-hooks.js");
    await mkdir(path.dirname(file), { recursive: true });
    const theirs = "// their own plugin\nexport const Theirs = async () => ({});\n";
    await writeFile(file, theirs);

    const install = capturing();
    assert.equal(await dispatchHookCommand(["install", "--agent", "opencode", "--scope", "project"], run.context(install)), 1);
    assert.match(install.errors.join("\n"), /is not Avenic's/, "装不上要说为什么");
    assert.equal(await readFile(file, "utf8"), theirs, "别人的插件一个字节都没动");

    const status = capturing();
    assert.equal(await dispatchHookCommand(["status", "--agent", "opencode", "--scope", "project"], run.context(status)), 0);
    const text = status.lines.join("\n");
    assert.match(text, /^OpenCode  unsupported  /m);
    assert.match(text, /is not Avenic's/, "行上的那句话也要在");
  } finally {
    await run.done();
  }
});

test("a machine with no agent on PATH says so instead of installing anyway", async () => {
  const run = await machine();
  try {
    const cli = capturing();
    assert.equal(await dispatchHookCommand(["install", "--agent", "codex"], run.context(cli)), 1);
    assert.match(cli.errors.join("\n"), /Unsupported by Codex: the installed version could not be read/);

    const status = capturing();
    assert.equal(await dispatchHookCommand(["status"], run.context(status)), 0);
    for (const line of ["Claude Code", "Codex", "OpenCode"]) assert.match(status.lines.join("\n"), new RegExp(`${line}  unsupported`));
  } finally {
    await run.done();
  }
});

test("a test that fires nothing still says whether the hooks are installed", async () => {
  // `hook test` 证明的只有最后一跳。一个照着文档装完、测出「动作没问题」、然后在真实
  // 回合里什么也没收到的人，缺的正是第一跳的答案：agent 到底会不会调用 Avenic。
  const run = await machine({ versions: { claude: "2.1.274" } });
  try {
    const before = capturing();
    assert.equal(await dispatchHookCommand(["test", "--agent", "claude"], run.context(before)), 0, before.errors.join("\n"));
    assert.match(before.lines.join("\n"), /^Hooks: not installed for this project — run: avenic hook install --agent claude --scope project$/m);

    assert.equal(await dispatchHookCommand(["install", "--agent", "claude", "--scope", "project"], run.context(capturing())), 0);
    const after = capturing();
    assert.equal(await dispatchHookCommand(["test", "--agent", "claude"], run.context(after)), 0, after.errors.join("\n"));
    const text = after.lines.join("\n");
    assert.match(text, /^Hooks: installed — /m);
    assert.ok(text.includes(path.join(run.project, ".claude", "settings.local.json")), text);
  } finally {
    await run.done();
  }
});

test("an agent that cannot carry hooks still gets its chain tested, and Codex's caveat rides with the installed answer", async () => {
  const run = await machine({ versions: { claude: "2.0.0", codex: "0.154.0" } });
  try {
    // 这条命令测的是动作那一条链，与哪个 agent 无关：装不上钩子的 agent 也要让用户把
    // 自己的通知验成。第一跳（这个版本不支持）就印在旁边 —— 说了事实，但不用它去拦这一发。
    // 场景里放一个真的动作，它会留下一个文件。
    const marker = path.join(run.root, "the-action-ran");
    await mkdir(path.dirname(path.join(run.root, "state", "hook-actions.json")), { recursive: true });
    await writeFile(path.join(run.root, "state", "hook-actions.json"), JSON.stringify({
      actions: [{ id: "leaves-a-trace", kind: "command", command: process.execPath, args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x")`] }],
    }, null, 2));

    const unsupported = capturing();
    assert.equal(await dispatchHookCommand(["test", "--agent", "claude"], run.context(unsupported)), 0, unsupported.errors.join("\n"));
    const unsupportedText = unsupported.lines.join("\n");
    assert.match(unsupportedText, /^Hooks: Unsupported by Claude Code 2\.0\.0$/m, "第一跳是什么，这一行就说什么");
    assert.equal(await run.exists(marker), true, "测试测的是动作那一条链：装不上钩子也验得成自己的通知");

    assert.equal(await dispatchHookCommand(["install", "--agent", "codex", "--scope", "project"], run.context(capturing())), 0);
    const codex = capturing();
    assert.equal(await dispatchHookCommand(["test", "--agent", "codex"], run.context(codex)), 0, codex.errors.join("\n"));
    const text = codex.lines.join("\n");
    assert.match(text, /^Hooks: installed — /m);
    assert.match(text, /^Codex: .*untrusted/im, "装了不等于会响：这句话要跟着答案一起出现");
    assert.equal(await run.exists(marker), true, "支持这个 agent，测试该真的走一遍");
  } finally {
    await run.done();
  }
});

test("a test still runs when the first hop's answer cannot be read", async () => {
  // 读不动 agent 的文件（目录顶了名字、权限不对）说的只是「装没装不知道」，不是
  // 「测试失败」。这一发测的是动作那一条链，拦下来用户就再没有办法验证自己的通知——
  // 而这正是他想知道的。读数的那一半用 core 的 hookStatus（status 那一页走的是同一条）。
  const run = await machine({ versions: { claude: "2.1.274" } });
  try {
    await mkdir(path.join(run.project, ".claude", "settings.local.json"), { recursive: true });
    const io = capturing();
    assert.equal(await dispatchHookCommand(["test", "--agent", "claude"], run.context(io)), 0, io.errors.join("\n"));
    const text = io.lines.join("\n");
    assert.match(text, /synthetic turn\.completed/, "第一跳答不上来也不拦这一发");
    assert.match(text, /^Hooks: .*cannot be read/m, "读不出来是一个事实，照直说");
    assert.ok(!text.includes("not installed"), "读不出来不等于没装");
  } finally {
    await run.done();
  }
});

test("a repeat install still says the thing that makes an install silent", async () => {
  // 「已经装着了」不是「一切正常」：Codex 写下去的钩子在审阅之前不响。第二次安装的人多半
  // 正是来问「为什么没通知」的那一个 —— 这句话在这一条路上更不能省。
  const run = await machine({ versions: { codex: "0.154.0" } });
  try {
    const first = capturing();
    assert.equal(await dispatchHookCommand(["install", "--agent", "codex", "--scope", "project"], run.context(first)), 0, first.errors.join("\n"));
    assert.match(first.lines.join("\n"), /^Installed: /m);
    assert.match(first.lines.join("\n"), /untrusted/im);

    const second = capturing();
    assert.equal(await dispatchHookCommand(["install", "--agent", "codex", "--scope", "project"], run.context(second)), 0, second.errors.join("\n"));
    const text = second.lines.join("\n");
    assert.match(text, /^Already installed: /m);
    assert.match(text, /untrusted/im, "第二次也要说得出「装了也还是不会响」");
  } finally {
    await run.done();
  }
});

test("status answers for one agent, for all three, and in JSON", async () => {
  const run = await machine({ versions: { claude: "2.1.274", codex: "0.154.0", opencode: "1.18.30" } });
  try {
    const cli = capturing();
    assert.equal(await dispatchHookCommand(["install", "--agent", "codex", "--scope", "project"], run.context(cli)), 0, cli.errors.join("\n"));
    const file = path.join(run.project, ".agents", "local", "codex", "config.toml");
    assert.match(await readFile(file, "utf8"), /avenic hook emit --agent codex/);

    const json = capturing();
    assert.equal(await dispatchHookCommand(["status", "--scope", "project", "--json"], run.context(json)), 0);
    const answer = JSON.parse(json.lines.join("\n"));
    assert.equal(answer.scope, "project");
    assert.deepEqual(answer.agents.map((row) => row.agent), ["claude", "codex", "opencode"]);
    assert.deepEqual(answer.agents.map((row) => row.installed), [false, true, false]);
    assert.equal(answer.agents[1].file, file);
    assert.equal(answer.agents[0].supported, true);
    // 装了不等于会响：Codex 的那句话必须跟着答案一起出现。
    assert.match(answer.agents[1].caveat, /untrusted|review/i);

    const one = capturing();
    assert.equal(await dispatchHookCommand(["status", "--agent", "claude", "--scope", "project"], run.context(one)), 0);
    assert.equal(one.lines.length, 1, one.lines.join("\n"));
    assert.match(one.lines[0], /^Claude Code  not installed  /);
  } finally {
    await run.done();
  }
});

test("a usage mistake is a sentence and an exit code, never a stack", async () => {
  const run = await machine({ versions: { claude: "2.1.274" } });
  try {
    for (const [argumentsList, expected] of [
      [["install"], /Missing --agent/],
      [["install", "--agent", "gemini"], /Unknown agent: gemini/],
      [["install", "--agent", "claude", "--scope", "everywhere"], /Unknown scope: everywhere/],
      [["install", "--agent", "claude", "--fancy"], /Unknown option for avenic hook install: --fancy/],
      [["status", "--agent"], /Missing value for --agent/],
    ]) {
      const cli = capturing();
      assert.equal(await dispatchHookCommand(argumentsList, run.context(cli)), 1, argumentsList.join(" "));
      assert.match(cli.errors.join("\n"), expected);
      assert.match(cli.errors.join("\n"), /Usage: avenic hook/);
    }
  } finally {
    await run.done();
  }
});

test("a payload that never finishes arriving has an end too", async () => {
  // stdin 是 agent 给的管道。字节上限挡得住大载荷，挡不住永远不结束的载荷 —— 一个挂着的
  // 管道不是大载荷，是没有尽头：这一轮会挂在这里，而钩子进程本来不该有任何一种等待没有尽头。
  const run = await machine({ versions: { claude: "2.1.274" } });
  try {
    let destroyed = false;
    const hanging = {
      async *[Symbol.asyncIterator]() { await new Promise(() => {}); },
      destroy() { destroyed = true; },
    };
    const io = capturing();
    const outcome = await Promise.race([
      dispatchHookCommand(["emit", "--agent", "claude"], { ...run.context(io), stdin: hanging, readTimeoutMs: 30 }),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 2000)),
    ]);
    assert.equal(outcome, 1, `读入没有尽头：${io.errors.join("\n")}`);
    assert.match(io.errors.join("\n"), /within 30 ms/);
    assert.equal(destroyed, true, "到点了要把管道收掉，一个还在写的 agent 不该继续往这里写");
  } finally {
    await run.done();
  }
});

test("one unreadable file does not take the other two answers down with it", async () => {
  const run = await machine({ versions: { claude: "2.1.274", codex: "0.154.0", opencode: "1.18.30" } });
  try {
    // 同名目录：读得出来才有答案，而这个读不出来的是**一个** agent 的答案。
    await mkdir(path.join(run.project, ".claude", "settings.local.json"), { recursive: true });
    const status = capturing();
    assert.equal(await dispatchHookCommand(["status", "--scope", "project"], run.context(status)), 0, status.errors.join("\n"));
    const text = status.lines.join("\n");
    for (const name of ["Claude Code", "Codex", "OpenCode"]) assert.match(text, new RegExp(`^${name}  `, "m"));
    assert.match(text, /^Claude Code  could not be read — /m);
  } finally {
    await run.done();
  }
});

test("the real entry point routes to all five verbs and says so in English", async () => {
  const run = await machine({ versions: { claude: "2.1.274" } });
  try {
    const help = spawnSync(process.execPath, [agentBin, "hook", "--help"], { cwd: run.project, encoding: "utf8", env: run.environment, windowsHide: true });
    assert.equal(help.status, 0, help.stderr);
    for (const verb of ["emit", "test", "install", "uninstall", "status"]) assert.match(help.stdout, new RegExp(`Usage: avenic hook ${verb}`));
    assert.doesNotMatch(help.stdout, /[一-鿿]/, "CLI 说的话全是英文");

    const unknown = spawnSync(process.execPath, [agentBin, "hook", "install", "--agent", "gemini"], { cwd: run.project, encoding: "utf8", env: run.environment, windowsHide: true });
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /Unknown agent: gemini/);
  } finally {
    await run.done();
  }
});
