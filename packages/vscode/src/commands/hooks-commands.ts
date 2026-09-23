import * as vscode from "vscode";
import { getAgent } from "@avenic/core";
import { DashboardPanel } from "../dashboard/panel.ts";
import type { DashboardAction, HookScope } from "../dashboard/protocol.ts";
import { sentence } from "../i18n/text.ts";
import { hookActionList, hookPlanDiff, installAgentHooks, saveHookActions, uninstallAgentHooks } from "../services/hooks.ts";
import { addHookAction, editHookAction, removeHookAction, type HookActionResult, type HookActionStore, type HookWizardUi } from "../ui/hooks-wizard.ts";
import { runMutation, type MutationQueue } from "../ui/mutation-queue.ts";
import type { ActivityLog } from "../ui/activity.ts";
import { showError } from "./errors.ts";
import { withProgress } from "./progress.ts";

// 钩子与通知那一页的落点。与中心同一套做法：页面只报「哪一档、哪个 agent、哪一条」，
// 文件与判断都在宿主（services/hooks 与 ui/hooks-wizard），写完由面板把这一档重读一遍。
//
// 三件事只在宿主里做，因为它们是「不许发生」的那一类，而不是「画得好看」的那一类：
//   1. 令牌只走密码框（wizardUi 的 askSecret），而且永远不写进活动日志。
//   2. 命令类通知的确认在向导里（ui/hooks-wizard），这里不给它第二条进路。
//   3. 装、卸、写名单都是写盘，全部排在同一条 mutation 队列上——不并行，且写完立刻刷新。

/** 这一页的动作：协议里 action 以 hook 开头的那些（revealFile 是设置页的那一行）。 */
type HookAction = Extract<DashboardAction, { action: `hook${string}` }>;

export interface HooksUi {
  /** 面板开在哪个项目上（两个作用域的名单都写在这个项目的目录或这台机器的目录里）。 */
  root: () => string | null;
  queue: MutationQueue;
  refresh: () => void;
  activity: ActivityLog;
}

// 装与卸要先问一次 agent 自己的版本（那个探测器会去跑一次 CLI），预览也要，
// 所以三件都按中心那条 500 毫秒的宽限来：快的活自己就是它的证明，慢的才露出来。
const SLOW_MS = 500;
function progressIfSlow<T>(title: string, work: Promise<T>): Promise<T> {
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

export function scopeLabel(language: string, scope: HookScope): string {
  return sentence(language, scope === "project" ? "hooks.scope-project" : "hooks.scope-global");
}

export async function handleHookAction(action: HookAction, ui: HooksUi): Promise<void> {
  try {
    const root = ui.root();
    if (root === null) {
      await vscode.window.showWarningMessage(sentence(vscode.env.language, "ui.no-folder"));
      return;
    }
    const language = vscode.env.language;
    const panel = DashboardPanel.current;
    const options = { environment: process.env, language };
    // 向导读写的永远是整份名单：加、改、删都是「这一档现在是这些」。
    const store = (scope: HookScope): HookActionStore => ({
      list: () => hookActionList(root, scope, options),
      // 问与写分开：问答不该占着写盘的队列，只有那一次写入排上去。
      save: (actions) => runMutation(ui.queue, () => saveHookActions(root, scope, actions, options), ui.refresh),
    });
    switch (action.action) {
      case "hooksOpen":
        panel?.hooksOn(action.scope);
        return;
      case "hookPlan": {
        // 「View Generated Config」只读盘：它算出的就是这次安装会改动哪几行，全部已打码。
        const plan = await progressIfSlow(sentence(language, "hooks.progress-plan", { agent: getAgent(action.agent).displayName }), hookPlanDiff(root, action.agent, action.scope, options));
        panel?.hooksOn(action.scope, { kind: "diff", agent: plan.agent, file: plan.file, lines: plan.lines });
        return;
      }
      case "hookInstall": {
        const name = getAgent(action.agent).displayName;
        const outcome = await runMutation(ui.queue, () => progressIfSlow(sentence(language, "hooks.progress-install", { agent: name }), installAgentHooks(root, action.agent, action.scope, options)), ui.refresh);
        panel?.hooksOn(action.scope, { kind: "installed", agent: action.agent, file: outcome.file, changed: outcome.changed, note: outcome.skipped ?? null });
        if (outcome.changed) ui.activity.record(sentence(language, "hooks.activity-installed", { agent: name, scope: scopeLabel(language, action.scope) }));
        return;
      }
      case "hookUninstall": {
        const name = getAgent(action.agent).displayName;
        const outcome = await runMutation(ui.queue, () => progressIfSlow(sentence(language, "hooks.progress-uninstall", { agent: name }), uninstallAgentHooks(root, action.agent, action.scope, options)), ui.refresh);
        panel?.hooksOn(action.scope, { kind: "uninstalled", agent: action.agent, file: outcome.file, changed: outcome.changed });
        if (outcome.changed) ui.activity.record(sentence(language, "hooks.activity-uninstalled", { agent: name, scope: scopeLabel(language, action.scope) }));
        return;
      }
      case "hookActionAdd": {
        const result = await addHookAction(store(action.scope), wizardUi(), action.kind, language);
        if (result !== null) after(ui, language, "hooks.activity-added", action.scope, panel, result);
        return;
      }
      case "hookActionEdit": {
        const result = await editHookAction(store(action.scope), wizardUi(), action.id, language);
        if (result !== null) after(ui, language, "hooks.activity-edited", action.scope, panel, result);
        return;
      }
      case "hookActionRemove": {
        const result = await removeHookAction(store(action.scope), wizardUi(), action.id, language);
        if (result !== null) after(ui, language, "hooks.activity-removed", action.scope, panel, result);
        return;
      }
    }
  } catch (error) {
    // 地址不是 http(s)、超时不是数字、认不出的那一条、文件读不动：service 与 core 的原话
    // 就是用户该读到的那句话（它说的正是「改什么」），这里是它唯一被说出来的地方。
    await showError(error);
  }
}

/** 一次向导结束时说的话：名单现在是这样（面板重读这一档），日志里只记动的是哪一条 ——
 *  条目的 id 是向导自己起的，目标与凭据都不进日志。 */
function after(ui: HooksUi, language: string, key: "hooks.activity-added" | "hooks.activity-edited" | "hooks.activity-removed", scope: HookScope, panel: DashboardPanel | undefined, result: HookActionResult): void {
  panel?.hooksOn(scope, { kind: "actions", file: result.file, changed: result.changed });
  if (result.changed) ui.activity.record(sentence(language, key, { id: result.id }));
}

/**
 * 向导问的那几句话落在编辑器自己的输入框与下拉上。凭据那一问走 password 输入框：它不
 * 回显，也不进别的输入框的历史；其余几问都是普通的。取消（Esc）在这里变成 null。
 */
function wizardUi(): HookWizardUi {
  return {
    ask: async (title, value, placeholder) => await vscode.window.showInputBox({ title, prompt: title, value, placeHolder: placeholder, ignoreFocusOut: true }) ?? null,
    askSecret: async (title, placeholder) => await vscode.window.showInputBox({ title, prompt: title, placeHolder: placeholder, password: true, ignoreFocusOut: true }) ?? null,
    pick: async (title, items) => (await vscode.window.showQuickPick(items, { title, ignoreFocusOut: true }))?.value ?? null,
    info: (message) => void vscode.window.showInformationMessage(message),
  };
}
