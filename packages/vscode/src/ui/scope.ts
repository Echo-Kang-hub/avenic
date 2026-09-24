import * as vscode from "vscode";
import { rowLabel, sentence } from "../i18n/text.ts";
import type { Scope } from "../services/skills.ts";

// 决议 2：全局作用域 → cwd undefined（绝不把项目根传给全局操作）；
// 项目作用域 → resolveRoot 项目根。返回 null 表示未选项目（已提示），调用方直接 return。
export async function scopeCwd(scope: Scope, resolveRoot: () => Promise<string | null>): Promise<string | undefined | null> {
  if (scope === "global") return undefined;
  const root = await resolveRoot();
  if (root === null) { await vscode.window.showWarningMessage(sentence(vscode.env.language, "ui.no-folder")); return null; }
  return root;
}

// 决议 4：无参 pickScope（brief 原带参/无参混调为类型错误，统一为无参）；
// Esc/关闭 → undefined → null → 静默无操作
export async function pickScope(): Promise<Scope | null> {
  const language = vscode.env.language;
  // 选中的是哪一项由那一项的 scope 决定，不由它显示的字决定：原先这里是拿标签和一句中文
  // 比较，于是译文一改，行为就跟着变了——界面翻译本不该动到任何一条路径。
  const picked = await vscode.window.showQuickPick([
    { scope: "project" as Scope, label: rowLabel(language, "scope.project"), description: sentence(language, "scope.project-note") },
    { scope: "global" as Scope, label: rowLabel(language, "scope.global"), description: sentence(language, "scope.global-note") },
  ]);
  return picked?.scope ?? null;
}

// 一条命令体最前面的那几步（哪个作用域、哪个项目根）合成一次：右键行带来的作用域优先，
// 否则问一次；项目作用域再取一次项目根。期间任何一步没有答案时都已经提示过，返回 null
// 让命令体直接结束。
export async function commandTarget(
  arg: unknown,
  resolveRoot: () => Promise<string | null>,
): Promise<{ scope: Scope; cwd: string | undefined } | null> {
  const scope = (arg as { avenicScope?: Scope } | undefined)?.avenicScope ?? (await pickScope());
  if (scope === null) return null;
  const cwd = await scopeCwd(scope, resolveRoot);
  return cwd === null ? null : { scope, cwd };
}
