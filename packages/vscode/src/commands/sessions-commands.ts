import * as vscode from "vscode";
import { SessionsPanel } from "../dashboard/sessions-panel.ts";
import { showError } from "./errors.ts";

export interface SessionsCommandDeps {
  // 同步根：面板每次取数时都读一次当前项目根（与 Overview 的注入方式一致）。
  // 未打开项目时面板照常打开并说明原因——它不需要先弹一个目录选择框。
  root: () => string | null;
}

// 会话页是只读的（读共享历史，不写任何东西），因此不进 MutationQueue：
// 启动、导入等 mutation 由 extension 的 refresh 触发面板重读。
export function registerSessionsCommands(context: vscode.ExtensionContext, deps: SessionsCommandDeps): void {
  const register = (id: string, fn: (...args: unknown[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(`avenic.sessions.${id}`, async (...args: unknown[]) => {
      try {
        await fn(...args);
      } catch (err) { await showError(err); }
    }));

  register("open", () => {
    const panel = SessionsPanel.show(context.extensionUri, deps.root);
    panel.refresh();
  });
}
