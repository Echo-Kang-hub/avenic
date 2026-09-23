export interface DisposableLike {
  dispose(): void;
}

export interface TerminalLike {
  readonly name: string;
}

export interface ShellExecutionLike<T extends TerminalLike> {
  readonly terminal: T;
  // 命令行走在这次执行里（`execution.commandLine.value`），不在事件自己身上。
  readonly execution: { readonly commandLine: { readonly value: string } };
}

export interface RunWindowLike<T extends TerminalLike> {
  onDidCloseTerminal(listener: (terminal: T) => void): DisposableLike;
  onDidEndTerminalShellExecution?(listener: (execution: ShellExecutionLike<T>) => void): DisposableLike;
}

/**
 * 一次运行什么时候算结束：那条命令在终端里跑完的时刻。
 *
 * 关闭终端的事件说得晚太多了：用户在 CLI 里退出、终端留在提示符上，租约就还活着，
 * 于是仪表盘和 `avenic status` 继续报 running，原生存储也不回写。VS Code 的 shell
 * 执行结束事件说的正是「命令跑完了」；它不认识命令的写法，所以命令行走一次归一化
 * 再比。旧宿主没有这个事件，关闭事件仍在，作为兜底。
 *
 * 收尾只交一次：两次释放租约不是重试，是把同一次运行算两遍。
 */
export function watchRun<T extends TerminalLike>(
  window: RunWindowLike<T>,
  terminal: T,
  command: string,
  finish: () => void,
): DisposableLike {
  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    for (const listener of listeners) listener.dispose();
    finish();
  };
  const wanted = command.trim();
  const listeners: DisposableLike[] = [
    window.onDidCloseTerminal((closed) => {
      if (closed === terminal) once();
    }),
  ];
  // 宿主可能比这个 API 旧。没有它就没有更早的信号，关闭事件照旧。
  const ends = window.onDidEndTerminalShellExecution?.((event) => {
    if (event.terminal !== terminal) return;
    // 事件的形状是 { terminal, execution, exitCode }：命令行走在 execution 里。
    if (event.execution.commandLine.value.trim() !== wanted) return;
    once();
  });
  if (ends) listeners.push(ends);
  return { dispose: () => { done = true; for (const listener of listeners) listener.dispose(); } };
}
