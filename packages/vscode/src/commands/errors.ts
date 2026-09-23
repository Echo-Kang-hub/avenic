import * as vscode from "vscode";
import { LocalizedError, sentence } from "../i18n/text.ts";

// 服务层抛 LocalizedError（键 + 洞，没有语言），这里把它说成编辑器当前的语言。
export async function showError(err: unknown): Promise<void> {
  const message = err instanceof LocalizedError
    ? sentence(vscode.env.language, err.key, err.values)
    : err instanceof Error ? err.message : String(err);
  await vscode.window.showErrorMessage(message);
}
