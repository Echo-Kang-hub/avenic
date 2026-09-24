import * as vscode from "vscode";

// 一条状态栏上的进度，从它开始到它结束。这条消息是给「等下去」这件事的，不是给
// 「停下来」的：`Window` 那一档没有取消按钮，而这个产品里走到这里来的每一件活都
// 有它自己的终点 —— 网络那两件（探测、模型表）在 core 里最多等 8 秒，写盘是整体的
// 原子替换（临时文件 + 改名），读盘是本地的。一个 Cancel 按钮许诺的是一件这里做
// 不到的事：把写了一半的会话回滚，或者把一个已经交给文件系统的改名叫回来。
//
// 所以这里不接 `CancellationToken`。真要取消，先得有「停下之后留下什么」的答案，
// 而这个答案按操作各不相同 —— 那是每一件活自己的设计，不是这一层能替它们决定的。
export async function withProgress<T>(title: string, fn: (report: (msg: string) => void) => Promise<T>): Promise<T> {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title }, (progress) =>
    fn((message) => progress.report({ message })),
  );
}

// 本地的活是毫秒级，网络那两件（探测、模型表）按 core 的规矩最多等 8 秒 —— 为快活闪一下
// 状态栏只会让人以为出了什么事。所以状态栏有一道 500 毫秒的宽限：过得去的活自己就是它的
// 证明，过不去的才显示出来。宽限期里那一次的异常只有调用方那一份承诺会接住，这一份永远不接。
const SLOW_MS = 500;
export function progressIfSlow<T>(title: string, work: Promise<T>): Promise<T> {
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    void withProgress(title, () => work).then(undefined, () => { /* 结果与异常都在调用方那一份上 */ });
  }, SLOW_MS);
  return work.finally(() => {
    settled = true;
    clearTimeout(timer);
  });
}
