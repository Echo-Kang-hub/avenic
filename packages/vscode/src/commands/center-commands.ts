import * as vscode from "vscode";
import { getAgent } from "@avenic/core";
import { DashboardPanel } from "../dashboard/panel.ts";
import type { AgentId, DashboardAction } from "../dashboard/protocol.ts";
import { sentence } from "../i18n/text.ts";
import { applyCenter, docsLink, fillFromPreset, previewCenter, refreshCenterModels, testCenter } from "../services/center.ts";
import { runMutation, type MutationQueue } from "../ui/mutation-queue.ts";
import type { ActivityLog } from "../ui/activity.ts";
import { showError } from "./errors.ts";
import { withProgress } from "./progress.ts";

// 模型配置中心的落点。这一页问的每一句话都带着整张表单回来（页面握着用户敲进去的字，
// 宿主只负责合并），所以这里的每一条都只做三件事：把表单交给 services/center，把答案
// 送回面板，必要时写一行活动日志。写文件的那两条与其它命令走同一个 mutation 队列 ——
// 写盘不许并行，写完的面板也不许读旧数据。

/** 中心那几条动作：协议里 action 以 center 开头的那些。 */
type CenterAction = Extract<DashboardAction, { action: `center${string}` }>;

export interface CenterUi {
  /** 面板开在哪个项目上（没有项目就没有 agent 的文件可读）。 */
  root: () => string | null;
  queue: MutationQueue;
  refresh: () => void;
  activity: ActivityLog;
  /** 打开这个 agent 自己的配置：宿主已有的那一条，不在这里重写一遍。 */
  open: (agentId: AgentId) => Promise<void>;
}

// 本地的合并、预览与写盘在这台机器上是毫秒级，而网络那两件（探测、模型表）按 core 的
// 规矩最多等 8 秒 —— 为快活闪一下状态栏只会让人以为出了什么事。所以进度条有一道 500
// 毫秒的宽限：过得去的活自己就是它的证明，过不去的才显示出来。两个都必须做：宽限期里
// 那一次的异常只有调用方那一份承诺会接住，这一份永远不接。
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

export async function handleCenterAction(action: CenterAction, ui: CenterUi): Promise<void> {
  try {
    const root = ui.root();
    if (root === null) {
      await vscode.window.showWarningMessage(sentence(vscode.env.language, "ui.no-folder"));
      return;
    }
    // 编辑器自己的语言决定这些句子说哪一半：服务层不认得语言，所以它抛键（LocalizedError），
    // 只回值不回声的那一条（探测、模型表）在这里就被说成人话。
    const language = vscode.env.language;
    const options = { language };
    const panel = DashboardPanel.current;
    const name = getAgent(action.agent).displayName;
    switch (action.action) {
      case "centerOpen":
        // 打开（或切到）某个 agent 的中心：状态由面板重读一遍这个 agent 的文件。
        panel?.centerOn(action.agent);
        return;
      case "centerFill":
        // 预设填的是一张表单，不是盘上的文件：它不排队、不读盘，也写不了任何东西。
        // 未知的 id 会在这里抛出，用户读到的就是那一句「没有这个供应商」。
        panel?.centerDraft(fillFromPreset(action.agent, action.provider));
        return;
      case "centerOpenFile":
        await ui.open(action.agent);
        return;
      case "centerOpenDocs": {
        // 供应商自己那一页的地址在 core 的表里：页面只报 id，不替链接作主（webview 手里
        // 的链接就是 webview 可能被骗着持有的链接）。查不到就什么都不开。
        const docs = docsLink(action.provider);
        if (docs !== null) await vscode.env.openExternal(vscode.Uri.parse(docs));
        return;
      }
      case "centerPreview":
        // 预览只读盘：它算出的就是「按这张表单写下去会改动哪几行」。
        panel?.centerOn(action.agent, await progressIfSlow(sentence(language, "center.progress-preview", { agent: name }), previewCenter(root, action.agent, action.draft, options)));
        return;
      case "centerTest": {
        // 「没什么可测的」是 core 的回答，不是异常：它照样是一句话，照原样送回页面。
        const result = await progressIfSlow(sentence(language, "center.progress-test", { agent: name }), testCenter(action.agent, action.draft, options));
        panel?.centerOn(action.agent, result);
        if (result.kind === "connection" && result.state === "connected") ui.activity.record(sentence(language, "center.activity-connected", { agent: name }));
        return;
      }
      case "centerRefreshModels": {
        // 刷新会把模型表落到项目的缓存里 —— 一次写盘，所以它也在这条队列上。
        const result = await runMutation(ui.queue, () => progressIfSlow(sentence(language, "center.progress-models", { agent: name }), refreshCenterModels(root, action.agent, action.draft, options)), ui.refresh);
        panel?.centerOn(action.agent, result);
        if (result.kind === "catalog" && result.state === "fetched") ui.activity.record(sentence(language, "center.activity-models", { agent: name, count: result.models.length }));
        return;
      }
      case "centerApply": {
        // 写的是 agent 自己的文件，用的是 core 的合并：没变就不写（written 说的就是
        // 这件事），所以日志也只记真的写过的那一次。
        const result = await runMutation(ui.queue, () => progressIfSlow(sentence(language, "center.progress-apply", { agent: name }), applyCenter(root, action.agent, action.draft, options)), ui.refresh);
        panel?.centerOn(action.agent, result);
        if (result.kind === "diff" && result.written) ui.activity.record(sentence(language, "center.activity-written", { agent: name }));
        return;
      }
    }
  } catch (error) {
    // 未知的供应商、这个 agent 不在 API 上、读不懂的文件：core 与 service 的原话就是
    // 用户该读到的话（它们说的正是「去做什么」），这里是它唯一被说出来的地方。
    await showError(error);
  }
}
