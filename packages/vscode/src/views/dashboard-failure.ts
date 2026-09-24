// 仪表盘打不开时用户读到的那一句话，以及它必须给的两个动作。
//
// VS Code 自己的 "No view is registered with id: …" 只描述内部状态：它不说哪一步
// 失败了，也不给任何可做的事，用户对着它只能卸载重装。Avenic 自己的每一条打开路径
// 因此都说这一句，并给出两个真的动作：
//   [Reload Window] 原地升级后仍在跑旧代码那种错配，真正能修好的就是重新加载窗口；
//   [View Logs]     真正的原因（内部那句话、以及它来自哪一步）写在 Avenic 输出通道里。
//
// 这个模块不 import vscode：句子与动作的接线由调用方注入，测试才可能脱离宿主验证
// 用户到底读到了什么。（宿主侧的接线见 extension.ts 的 failureUi。）
//
// 它也不写死那几个英文词：和扩展里别的每一句一样，它们从资源层的词表里来（P23 就说了
// 这一条），由调用方按自己的语言取好传进来。写死在这里的英文句，中文宿主里读到的就是
// 一句英文 —— 而这一句恰恰是用户最需要读懂的那种。

import { sentence } from "../i18n/text.ts";

export interface FailureText {
  dashboardOpenFailed: string;
  startupFailed: string;
  reload: string;
  viewLogs: string;
}

/** 宿主语言对应的那一组句子与动作。 */
export function failureText(language: string): FailureText {
  return {
    dashboardOpenFailed: sentence(language, "failure.dashboard-open"),
    startupFailed: sentence(language, "failure.startup"),
    reload: sentence(language, "failure.reload-window"),
    viewLogs: sentence(language, "failure.view-logs"),
  };
}

export interface FailureUi {
  /** 原因写进 Avenic 通道（[View Logs] 打开的就是它）。通道自己可能就是失败的那一步，故可省。 */
  record?: (line: string) => void;
  /** 把通道带到前台。缺省时不给 [View Logs]：不摆一个打不开日志的按钮。 */
  show?: () => void;
  notify: (message: string, ...actions: string[]) => Thenable<string | undefined>;
  reload: () => void;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function reportFailure(message: string, error: unknown, ui: FailureUi, text: FailureText): Promise<void> {
  ui.record?.(`${message} ${reasonOf(error)}`);
  const actions = [text.reload, ...(ui.show ? [text.viewLogs] : [])];
  let choice: string | undefined;
  try {
    // 通知画不出来（没有窗口、宿主正在关闭）也是一样的下场：它不能变成第二个异常，
    // 那等于把用户丢回什么都没有的那一屏。
    choice = await ui.notify(message, ...actions);
  } catch {
    choice = undefined;
  }
  if (choice === text.reload) ui.reload();
  else if (choice === text.viewLogs) ui.show?.();
}

export function reportDashboardFailure(error: unknown, ui: FailureUi, text: FailureText): Promise<void> {
  return reportFailure(text.dashboardOpenFailed, error, ui, text);
}
