import assert from "node:assert/strict";
import test from "node:test";
import { watchRun } from "../src/commands/run-lifecycle.ts";

// 启动租约是扩展宿主拿的，而收尾以前只挂在「关掉终端」上：用户在 CLI 里敲 /exit，
// 终端还开着，租约就一直活着——CLI 早就退出了，仪表盘和 `avenic status` 还在说
// running，原生存储也不回写。一次运行结束的时刻是**那条命令跑完了**，不是那个
// 标签页被关掉了。VS Code 的 shell 执行结束事件说的正是前一件事，关闭事件退居为
// 兜底（旧版本宿主没有前者）。这些用例钉住这个顺序，且不 import vscode——窗口是
// 一个鸭子类型的替身。

type Listener<T> = (value: T) => void;

function fakeWindow() {
  const closeListeners = new Set<Listener<Terminal>>();
  const endListeners = new Set<Listener<{ terminal: Terminal; execution: { commandLine: { value: string } } }>>();
  const disposed: string[] = [];
  return {
    disposed,
    window: {
      onDidCloseTerminal(listener: Listener<Terminal>) {
        closeListeners.add(listener);
        return { dispose: () => { closeListeners.delete(listener); disposed.push("close"); } };
      },
      onDidEndTerminalShellExecution(listener: Listener<{ terminal: Terminal; execution: { commandLine: { value: string } } }>) {
        endListeners.add(listener);
        return { dispose: () => { endListeners.delete(listener); disposed.push("end"); } };
      },
    },
    close(terminal: Terminal) { for (const listener of [...closeListeners]) listener(terminal); },
    end(terminal: Terminal, commandLine: string) { for (const listener of [...endListeners]) listener({ terminal, execution: { commandLine: { value: commandLine } } }); },
    counts: { close: () => closeListeners.size, end: () => endListeners.size },
  };
}

class Terminal {
  readonly name: string;
  constructor(name: string) { this.name = name; }
}

const COMMAND = "claude --continue";

test("the run ends when the launched command's shell execution ends, not when the tab is closed", () => {
  const host = fakeWindow();
  const terminal = new Terminal("Claude");
  let finished = 0;
  watchRun(host.window, terminal, COMMAND, () => { finished += 1; });

  host.end(terminal, COMMAND);

  assert.equal(finished, 1, "the CLI exiting is the end of the run");
  assert.deepEqual(host.disposed.sort(), ["close", "end"], "both listeners are released — nothing survives the run");
});

test("the same run is never finished twice", () => {
  const host = fakeWindow();
  const terminal = new Terminal("Claude");
  let finished = 0;
  watchRun(host.window, terminal, COMMAND, () => { finished += 1; });

  host.end(terminal, COMMAND);
  host.end(terminal, COMMAND);
  host.close(terminal);

  assert.equal(finished, 1, "a lease is released once; a second release is a bug, not a retry");
});

test("closing the terminal still ends the run when no shell event ever arrives", () => {
  const host = fakeWindow();
  const terminal = new Terminal("Claude");
  let finished = 0;
  watchRun(host.window, terminal, COMMAND, () => { finished += 1; });

  host.close(terminal);

  assert.equal(finished, 1, "the fallback is what a host without shell events has always done");
});

test("another terminal's command ending is not this run ending", () => {
  const host = fakeWindow();
  const terminal = new Terminal("Claude");
  const other = new Terminal("PowerShell");
  let finished = 0;
  watchRun(host.window, terminal, COMMAND, () => { finished += 1; });

  host.end(other, COMMAND);
  host.end(terminal, "npm install");
  host.close(other);

  assert.equal(finished, 0, "only the launched terminal and only the launched command");
});

test("a host that reports no shell executions still finishes on close", () => {
  const terminal = new Terminal("Claude");
  let finished = 0;
  const listeners: Listener<Terminal>[] = [];
  watchRun({ onDidCloseTerminal: (listener: Listener<Terminal>) => { listeners.push(listener); return { dispose: () => {} }; } }, terminal, COMMAND, () => { finished += 1; });

  assert.deepEqual(listeners.length, 1);
  listeners[0]!(terminal);
  assert.equal(finished, 1);
});

test("the command is recognised through the whitespace a shell reports around it", () => {
  const host = fakeWindow();
  const terminal = new Terminal("Claude");
  let finished = 0;
  watchRun(host.window, terminal, COMMAND, () => { finished += 1; });

  host.end(terminal, `  ${COMMAND}  `);

  assert.equal(finished, 1, "a shell may pad the line it reports; the command is the same command");
});
