import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  DASHBOARD_OPEN_FAILED,
  RELOAD_WINDOW,
  STARTUP_FAILED,
  VIEW_LOGS,
  reportDashboardFailure,
  reportFailure,
  type FailureUi,
} from "../src/views/dashboard-failure.ts";
import { LEGACY_COMMAND_ALIASES } from "../src/views/legacy.ts";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 每一条打开仪表盘的路径最终都落到这一句上。它是用户唯一读到的说明，所以措辞与两个
// 动作都是产品决定，不是实现细节：VS Code 自己的 "No view is registered with id: …"
// 只描述内部状态，用户拿它没有任何可做的。
test("the dashboard fallback sentence and its two actions are the released wording", () => {
  assert.equal(DASHBOARD_OPEN_FAILED, "Avenic Dashboard could not be opened.");
  assert.equal(RELOAD_WINDOW, "Reload Window");
  assert.equal(VIEW_LOGS, "View Logs");
});

interface Captured {
  shown: Array<{ message: string; actions: string[] }>;
  logged: string[];
  reloads: number;
  logs: number;
}

function surface(captured: Captured, choice: string | undefined, withChannel = true): FailureUi {
  return {
    record: (line) => captured.logged.push(line),
    show: withChannel ? () => { captured.logs += 1; } : undefined,
    notify: async (message, ...actions) => { captured.shown.push({ message, actions }); return choice; },
    reload: () => { captured.reloads += 1; },
  };
}

function blank(): Captured {
  return { shown: [], logged: [], reloads: 0, logs: 0 };
}

// 内部那句话（用户看不懂、也没法处理）属于日志；用户读到的那一行是 Avenic 自己的
// 句子加两个动作。[Reload Window] 是原地升级后仍在跑旧代码那种错配真正能修好的
// 一步，[View Logs] 是唯一能交出原因的一步。
test("a dashboard that cannot be opened says so in Avenic's words and offers the two actions", async () => {
  const raw = "No view is registered with id: avenic.launcher";
  const captured = blank();
  await reportDashboardFailure(new Error(raw), surface(captured, RELOAD_WINDOW));

  assert.deepEqual(captured.shown, [{ message: DASHBOARD_OPEN_FAILED, actions: [RELOAD_WINDOW, VIEW_LOGS] }]);
  assert.equal(captured.shown[0]!.message.includes(raw), false, "内部那句话不得出现在用户读的那一行里");
  assert.match(captured.logged.join("\n"), /No view is registered with id: avenic\.launcher/, "真正的原因写进 Avenic 通道");
  assert.equal(captured.reloads, 1, "选中 Reload Window 就真的重新加载窗口");
  assert.equal(captured.logs, 0);
});

test("View Logs opens the channel; dismissing the notification does nothing else", async () => {
  const logs = blank();
  await reportFailure(STARTUP_FAILED, new Error("boom"), surface(logs, VIEW_LOGS));
  assert.deepEqual({ reloads: logs.reloads, logs: logs.logs, recorded: logs.logged.length }, { reloads: 0, logs: 1, recorded: 1 });

  const dismissed = blank();
  await reportFailure(STARTUP_FAILED, new Error("boom"), surface(dismissed, undefined));
  assert.deepEqual({ reloads: dismissed.reloads, logs: dismissed.logs, recorded: dismissed.logged.length }, { reloads: 0, logs: 0, recorded: 1 });
});

// 宿主启动失败那条路径上通道本身可能就是失败原因（它就是在建通道时抛的），所以可省：
// 没有通道就不摆一个打不开日志的按钮，但仍然留下一行原因。
test("a surface without a channel offers only the reload action", async () => {
  const captured = blank();
  await reportFailure(STARTUP_FAILED, new Error("boom"), {
    record: (line) => captured.logged.push(line),
    notify: async (message, ...actions) => { captured.shown.push({ message, actions }); return undefined; },
    reload: () => { captured.reloads += 1; },
  });
  assert.deepEqual(captured.shown, [{ message: STARTUP_FAILED, actions: [RELOAD_WINDOW] }]);
  assert.equal(captured.reloads, 0);
});

// 报错的路自己再抛一次，等于把用户丢回什么都没有的那一屏：宿主把通知画出来都可能失败。
test("a notification that cannot be shown does not become a second failure", async () => {
  await reportFailure(STARTUP_FAILED, new Error("boom"), {
    notify: async () => { throw new Error("no window to draw in"); },
    reload: () => { throw new Error("must not run"); },
  });
});

// 0.5.5 之前的发行版贡献过、现在没有实现的入口。别名只收「意图还在、只是改了名字」
// 的那些：目标必须是当前清单里真有的命令，而且真的有人注册它——一张指向不存在命令的
// 表只是把一条死路换成另一条。avenic.model.*（profile 库，0.5.4 起就已删除）不在表里：
// 把一个按「删除 profile」的键绑悄悄改成打开配置问答，比一条直白的 command not found
// 更坏——它做了别的事，还用着旧名字。
test("every legacy alias points at a command that exists today", async () => {
  const manifest = JSON.parse(await readFile(path.join(pkgDir, "package.json"), "utf8"));
  const declared = new Set<string>(manifest.contributes.commands.map((entry: { command: string }) => entry.command));
  const entries = Object.entries(LEGACY_COMMAND_ALIASES);
  assert.ok(entries.length >= 3, `0.5.5 之前那三条入口（init / switchAuth / switchSessions）都该有别名，实际 ${entries.length} 条`);
  for (const [legacy, target] of entries) {
    assert.equal(declared.has(legacy), false, `${legacy} 是被删掉的旧入口，不该重新写回清单`);
    assert.ok(declared.has(target), `${legacy} 指向了清单里没有的命令 ${target}`);
  }
  const source = await readFile(path.join(pkgDir, "src", "extension.ts"), "utf8");
  assert.match(source, /Object\.entries\(LEGACY_COMMAND_ALIASES\)/, "激活时真的把这张表注册上去");
});

// 兼容的代价必须是零：旧名字走的是激活时那一次固定次数的注册，不是一个「打开时先找找
// 旧状态」的动作。所以这张表只能是一份常量——它不能读盘（没有探、没有扫）、不能起进程、
// 不能碰 core。这一段从源码查，因为「表里没有 import」正是那个 O(1) 本身。
test("the legacy alias table is a constant: no reads, no scans, no spawns behind it", async () => {
  const source = await readFile(path.join(pkgDir, "src", "views", "legacy.ts"), "utf8");
  assert.match(source, /Object\.freeze\(\{/, "表本身必须是冻结的常量");
  const imports = [...source.matchAll(/^\s*import\b.*$/gm)].map((match) => match[0].trim());
  assert.deepEqual(imports, [], `legacy.ts 只能是一张表，实际导入了 ${imports.join(" · ")}`);
  assert.doesNotMatch(source, /\b(?:require|readFile|readdir|stat|existsSync|execFile|spawn)\b/);
});
