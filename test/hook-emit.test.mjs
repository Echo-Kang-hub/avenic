import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { hookActionsPath } from "../packages/core/src/runtime/hook-actions.mjs";
import { dispatchHookCommand } from "../packages/cli/src/cli/hooks-cli.mjs";

// `avenic hook emit` is the process an agent's own hook calls, so its contract
// is the one a user cannot debug when it is wrong: it runs on every turn, it
// must not print anything the agent might read as an answer, it must not fail a
// turn because a webhook is down, and a malformed payload must come back as one
// English sentence and exit 1 instead of a stack trace in the agent's log.
//
// The CLI itself is driven in-process with a fake stdin, a captured console and
// an inert action layer, so nothing here ever posts, notifies or spawns. The
// last test drives the real entry point for the two things only a real process
// can prove: the exit code, and that `avenic hook` is wired into the router at
// all. It uses a payload Avenic does not know, so the child writes nothing.

const SECRET = "sk-test-not-a-real-key";
const SESSION = "11111111-2222-3333-4444-555555555555";
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agentBin = path.join(packageRoot, "packages", "cli", "scripts", "skills.mjs");

const CLAUDE_STOP = { session_id: SESSION, cwd: "D:/tmp/not-a-real-project", hook_event_name: "Stop", prompt_id: "p-0001" };

function scratch(prefix) {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function capturing() {
  const lines = [];
  const errors = [];
  return { lines, errors, log: (line) => lines.push(String(line)), error: (line) => errors.push(String(line)) };
}

/** The hook layer, inert: nothing here opens a socket or shows a notification. */
function inertActions({ platform = "linux", respond = async () => ({ ok: true, status: 204 }) } = {}) {
  const calls = { spawn: [], fetch: [] };
  const children = [];
  return {
    calls,
    children,
    io: {
      platform,
      now: () => 1_700_000_000_000,
      spawn(command, args, options) {
        const child = {
          writes: [],
          unref() {},
          kill() {},
          on(event, handler) {
            if (event === "close") setImmediate(() => handler(0, null));
            return child;
          },
          once(event, handler) { return child.on(event, handler); },
          stderr: { on() { return child.stderr; } },
          stdin: { write(chunk) { child.writes.push(String(chunk)); return true; }, end() {} },
        };
        calls.spawn.push({ command, args, options, child });
        children.push(child);
        return child;
      },
      async fetch(url, options) {
        calls.fetch.push({ url, options });
        return respond(url, options);
      },
    },
  };
}

function withProject(actions, run) {
  const root = scratch("avenic-hook-cli-");
  const machine = scratch("avenic-hook-cli-state-");
  if (actions.length > 0) {
    const file = hookActionsPath(root);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ actions }, null, 2));
  }
  const close = () => {
    rmSync(root, { recursive: true, force: true });
    rmSync(machine, { recursive: true, force: true });
  };
  return Promise.resolve(run({ root, machine, environment: { AVENIC_STATE_DIR: machine, PATH: "/usr/bin" } })).finally(close);
}

const stdinOf = (text) => Readable.from([text]);

test("a payload that is not JSON is one English sentence and exit 1, never a stack trace", async () => {
  await withProject([], async ({ root, environment }) => {
    const cli = capturing();
    const actions = inertActions();
    const status = await dispatchHookCommand(["emit", "--agent", "claude"], {
      io: cli,
      stdin: stdinOf("{ this is not json"),
      environment,
      cwd: root,
      emitIo: actions.io,
    });
    assert.equal(status, 1);
    assert.equal(cli.lines.length, 0, "出错的时候不该往 stdout 写东西");
    assert.equal(cli.errors.length, 1);
    assert.match(cli.errors[0], /payload/i);
    assert.doesNotMatch(cli.errors[0], /\n|\bat \w+ \(/, "一个 stack trace 交给 agent 的钩子日志，没人读得出发生了什么");
    assert.deepEqual(actions.calls.spawn, []);
    assert.deepEqual(actions.calls.fetch, []);
  });
});

test("empty input, a JSON value that is not an object, and an oversized payload are all the same kind of refusal", async () => {
  await withProject([], async ({ root, environment }) => {
    const inputs = ["", "   \n", "null", "[1,2,3]", `{"filler":"${"x".repeat(300_000)}"}`]; // 最后一条超出一个钩子载荷的读入上限
    for (const input of inputs) {
      const cli = capturing();
      const status = await dispatchHookCommand(["emit", "--agent", "claude"], { io: cli, stdin: stdinOf(input), environment, cwd: root, emitIo: inertActions().io });
      assert.equal(status, 1, `${JSON.stringify(input.slice(0, 24))} 应当被拒`);
      assert.equal(cli.errors.length, 1, JSON.stringify(cli.errors));
      assert.doesNotMatch(cli.errors[0], /\bat \w+ \(/);
    }
  });
});

test("a hook that is called without a payload at a terminal says so instead of waiting for one", async () => {
  await withProject([], async ({ root, environment }) => {
    const cli = capturing();
    const status = await dispatchHookCommand(["emit", "--agent", "claude"], { io: cli, stdin: { isTTY: true }, environment, cwd: root, emitIo: inertActions().io });
    assert.equal(status, 1);
    assert.match(cli.errors[0], /stdin/);
  });
});

test("every usage mistake is a sentence and exit 1: no agent, an agent nobody wrote a row for, an unknown flag", async () => {
  await withProject([], async ({ root, environment }) => {
    for (const args of [["emit"], ["emit", "--agent", "nobody"], ["emit", "--agent", "claude", "--wat"], ["emit", "--agent"], ["nonsense"]]) {
      const cli = capturing();
      const status = await dispatchHookCommand(args, { io: cli, stdin: stdinOf("{}"), environment, cwd: root, emitIo: inertActions().io });
      assert.equal(status, 1, args.join(" "));
      assert.equal(cli.errors.length, 1, args.join(" "));
      assert.ok(cli.errors[0].trim().length > 0);
    }
  });
});

test("an accepted emit prints nothing at all: the agent reads this process's stdout", async () => {
  await withProject([], async ({ root, environment }) => {
    const cli = capturing();
    const status = await dispatchHookCommand(["emit", "--agent", "claude"], { io: cli, stdin: stdinOf(JSON.stringify(CLAUDE_STOP)), environment, cwd: root, emitIo: inertActions().io });
    assert.equal(status, 0);
    assert.deepEqual(cli.lines, []);
    assert.deepEqual(cli.errors, []);
  });
});

test("--verbose is one English line per action, and --json is one machine object", async () => {
  await withProject([{ id: "toast", kind: "desktop" }], async ({ root, environment }) => {
    const verbose = capturing();
    const spoken = inertActions();
    assert.equal(await dispatchHookCommand(["emit", "--agent", "claude", "--verbose"], { io: verbose, stdin: stdinOf(JSON.stringify(CLAUDE_STOP)), environment, cwd: root, emitIo: spoken.io }), 0);
    assert.equal(spoken.calls.spawn.length, 1);
    assert.equal(verbose.lines.length, 1);
    assert.match(verbose.lines[0], /toast/);
    assert.match(verbose.lines[0], /sent/);
    assert.equal(verbose.lines[0].includes(SECRET), false);

    const machine = capturing();
    const nextTurn = { ...CLAUDE_STOP, prompt_id: "p-0002" };
    assert.equal(await dispatchHookCommand(["emit", "--agent", "claude", "--json"], { io: machine, stdin: stdinOf(JSON.stringify(nextTurn)), environment, cwd: root, emitIo: inertActions().io }), 0);
    const parsed = JSON.parse(machine.lines.join("\n"));
    assert.equal(parsed.accepted, true);
    assert.equal(parsed.event.event, "turn.completed");
    assert.equal(parsed.results[0].state, "sent");
  });
});

test("a webhook that is down is a printed failure and still exits 0: the turn is not the webhook's hostage", async () => {
  await withProject([{ id: "hook", kind: "webhook", url: "https://hooks.example.invalid/avenic" }], async ({ root, environment }) => {
    const cli = capturing();
    const actions = inertActions({ respond: async () => ({ ok: false, status: 500 }) });
    const status = await dispatchHookCommand(["emit", "--agent", "claude", "--verbose"], { io: cli, stdin: stdinOf(JSON.stringify(CLAUDE_STOP)), environment, cwd: root, emitIo: actions.io });
    assert.equal(status, 0, "发不出去不是这个进程的退出码该管的事");
    assert.equal(cli.errors.length, 0, "对外的一行是给用户看的，不是错误");
    assert.match(cli.lines[0], /failed/);
    assert.match(cli.lines[0], /500/);
  });
});

test("a webhook with a token prints the machine object and nothing else, and no credential is in it", async () => {
  await withProject([{ id: "hook", kind: "webhook", url: "https://hooks.example.invalid/avenic", token: SECRET }], async ({ root, environment }) => {
    const cli = capturing();
    assert.equal(await dispatchHookCommand(["emit", "--agent", "claude", "--json", "--verbose"], { io: cli, stdin: stdinOf(JSON.stringify(CLAUDE_STOP)), environment, cwd: root, emitIo: inertActions().io }), 0);
    assert.equal(cli.lines.join("\n").includes(SECRET), false);
    // --json 是一份机器对象：给它再加几行英文，就把它变成一个解析不了的输出。
    assert.equal(cli.lines.length, 1);
    assert.equal(JSON.parse(cli.lines[0]).results[0].detail, "HTTP 204");
  });
});

test("the test event is a real turn.completed, says that it is a test, and never lets dedupe eat it", async () => {
  await withProject([{ id: "toast", kind: "desktop" }], async ({ root, environment }) => {
    const cli = capturing();
    const actions = inertActions();
    assert.equal(await dispatchHookCommand(["test", "--agent", "claude"], { io: cli, stdin: stdinOf(""), environment, cwd: root, emitIo: actions.io }), 0);
    assert.equal(actions.calls.spawn.length, 1, "有通知动作时，测试要真的发一条");
    assert.match(cli.lines.join("\n"), /test/i, "输出里要说清这是测试");
    assert.equal(actions.calls.spawn[0].command, "notify-send");
    assert.match(actions.calls.spawn[0].args.join(" "), /Claude Code/);

    // 连着跑两次不是「被去重吃掉」：测试事件每次都该看得见。
    assert.equal(await dispatchHookCommand(["test", "--agent", "claude"], { io: cli, stdin: stdinOf(""), environment, cwd: root, emitIo: actions.io }), 0);
    assert.equal(actions.calls.spawn.length, 2);
  });
});

test("a test with nothing configured says which file to write, instead of looking broken", async () => {
  await withProject([], async ({ root, environment }) => {
    const cli = capturing();
    assert.equal(await dispatchHookCommand(["test", "--agent", "claude"], { io: cli, stdin: stdinOf(""), environment, cwd: root, emitIo: inertActions().io }), 0);
    assert.match(cli.lines.join("\n"), /hook-actions\.json/, "空手而归的时候要说出该写哪个文件");
  });
});

test("the real process: a malformed payload exits 1 with an English line, and an unknown event exits 0 in silence", async () => {
  await withProject([], async ({ root, machine }) => {
    const environment = { ...process.env, AVENIC_STATE_DIR: machine };
    const malformed = spawnSync(process.execPath, [agentBin, "hook", "emit", "--agent", "claude"], { cwd: root, encoding: "utf8", input: "not json at all", env: environment, windowsHide: true });
    assert.equal(malformed.status, 1, malformed.stderr);
    assert.match(malformed.stderr, /payload/i);
    assert.doesNotMatch(malformed.stderr, /\bat .*\.mjs:\d+/, "钩子的日志里不该出现堆栈");
    assert.equal(malformed.stdout, "");

    const unknown = spawnSync(process.execPath, [agentBin, "hook", "emit", "--agent", "claude"], { cwd: root, encoding: "utf8", input: JSON.stringify({ ...CLAUDE_STOP, hook_event_name: "PreCompact" }), env: environment, windowsHide: true });
    assert.equal(unknown.status, 0, unknown.stderr);
    assert.equal(unknown.stdout, "", "钩子进程的 stdout 是给 agent 的，成功时必须是空的");

    const usage = spawnSync(process.execPath, [agentBin, "hook"], { cwd: root, encoding: "utf8", input: "", env: environment, windowsHide: true });
    assert.equal(usage.status, 1);
    assert.match(usage.stderr, /avenic hook/);
  });
});

test("the command that runs on every turn loads no session machinery", () => {
  // 速度是这件事的功能之一：这个进程在每一个 agent 的每一轮上被叫起来一次，所以它
  // 能拉进来的东西是它契约的一部分。会话、transcript、canonical、skills 一条都不许有。
  const source = readFileSync(new URL("../packages/cli/src/cli/hooks-cli.mjs", import.meta.url), "utf8");
  const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(specifiers.length > 0, "一条 import 都没读到，这个扫描证明不了什么");
  for (const specifier of specifiers) {
    assert.doesNotMatch(specifier, /sessions|canonical|transcript|projection|cursors|handoff|adapters|skills/i, `${specifier} 不该出现在每一轮都要加载的这条路上`);
  }
});

test("a project that is not one yet still answers: the emit is about the directory the agent is in", async () => {
  // 钩子可能装在全局设置里，于是它会在一个还不是 Avenic 项目的目录里被调用。那一刻
  // 能读的是全局动作，落点就是 agent 所在的目录 —— 和每一条别的命令同一个答案。
  await withProject([], async ({ root, machine }) => {
    const cli = capturing();
    const status = await dispatchHookCommand(["emit", "--agent", "claude"], { io: cli, stdin: stdinOf(JSON.stringify(CLAUDE_STOP)), environment: { AVENIC_STATE_DIR: machine }, cwd: root, emitIo: inertActions().io });
    assert.equal(status, 0);
    assert.equal(existsSync(path.join(root, ".agents", "local", "hook-state.json")), true);
  });
});
