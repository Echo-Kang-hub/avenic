import * as vscode from "vscode";
import { claudeSettingsFile } from "@avenic/core";
import * as model from "../services/model.ts";
import { ModelPanel } from "../dashboard/model-panel.ts";
import { MutationQueue, runMutation } from "../ui/mutation-queue.ts";
import type { ProfileDraft } from "../model/protocol.ts";
import { showError } from "./errors.ts";
import { withProgress } from "./progress.ts";

export interface ModelCommandDeps {
  queue: MutationQueue;
  // 同步根：面板数据要它（面板每次刷新都同步取一次当前项目根）。
  root: () => string | null;
  // 异步根：命令里"没有就引导用户选一个"，取消则返回 null。
  resolveRoot: () => Promise<string | null>;
  refresh: () => void;
}

// 与 agents-commands.ts 同一套注册模板：try/catch 覆盖整个命令体，交互在队列外、
// 只有 mutation 进 queue.run，成功失败都 refresh。
export function registerModelCommands(context: vscode.ExtensionContext, deps: ModelCommandDeps): void {
  const register = (id: string, fn: (...args: unknown[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(`avenic.model.${id}`, async (...args: unknown[]) => {
      try {
        await fn(...args);
      } catch (err) { await showError(err); }
    }));

  // 面板数据每次都重新组装：面板开着的时候库/绑定可能被 CLI 改掉。
  register("open", () => {
    const panel = ModelPanel.show(context.extensionUri, {
      projectRoot: deps.root,
      resolveRoot: deps.resolveRoot,
    });
    panel.refresh();
  });

  // 面板之外的快捷入口：命令面板直接切换当前项目的绑定，不用先开面板。
  register("switch", async () => {
    const projectRoot = await deps.resolveRoot();
    if (projectRoot === null) {
      await vscode.window.showWarningMessage("未选择项目文件夹");
      return;
    }
    const profiles = await model.profiles();
    if (profiles.length === 0) {
      await vscode.window.showInformationMessage("本机配置库为空，请先执行「Avenic: 模型配置」新建配置");
      return;
    }
    const picked = await vscode.window.showQuickPick(
      profiles.map((profile) => ({ label: profile.name, description: profile.endpoint.baseUrl, id: profile.id })),
    );
    if (!picked) return;
    // model.bind 内部已 ensureModelGitignore（spec §12 第 3 条：密钥落盘前先保证被 ignore）；
    // 配置不存在时 core 抛 Unknown profile，交给 register 的 showError 呈现。
    await runMutation(deps.queue, () => model.bind(projectRoot, picked.id), deps.refresh);
  });

  register("saveProfile", async (message) => {
    const { profile } = message as { profile: ProfileDraft };
    await runMutation(deps.queue, () => withProgress("保存模型配置", () => model.saveProfile(profile)), deps.refresh);
  });

  // 编辑区的实时预览：纯计算（不写盘、不碰 MutationQueue），返回值由面板回包渲染。
  register("preview", (message) => {
    const { profile } = message as { profile: ProfileDraft };
    return model.preview(profile);
  });

  // §9.2 的 [复制]：常驻卡片操作，不弹确认（可撤销：删掉副本即可）。
  register("duplicateProfile", async (message) => {
    const { id } = message as { id: string };
    await runMutation(deps.queue, () => model.duplicateProfile(id), deps.refresh);
  });

  register("deleteProfile", async (message) => {
    const { id } = message as { id: string };
    const confirmed = await vscode.window.showWarningMessage(
      `删除配置 ${id}？绑定了它的项目会在下次启动时回退到 Agent 默认配置。`,
      { modal: true },
      "删除",
    );
    if (confirmed !== "删除") return;
    await runMutation(deps.queue, () => model.deleteProfile(id), deps.refresh);
  });

  register("bindProject", async (message) => {
    const { id } = message as { id: string };
    const projectRoot = await deps.resolveRoot();
    if (projectRoot === null) {
      await vscode.window.showWarningMessage("未选择项目文件夹");
      return;
    }
    await runMutation(deps.queue, () => model.bind(projectRoot, id), deps.refresh);
  });

  register("clearProject", async () => {
    const projectRoot = await deps.resolveRoot();
    if (projectRoot === null) return void vscode.window.showWarningMessage("未选择项目文件夹");
    await runMutation(deps.queue, () => model.clear(projectRoot), deps.refresh);
  });

  // 测试连接走真实网络请求，可能慢：withProgress 给取消入口，返回值回传给面板。
  register("testConnection", async (message) => {
    const { id } = message as { id: string };
    return withProgress("测试连接", () => model.probe(id));
  });

  // 库文件与本机无关（挂在 stateRoot 下），不需要项目根。
  register("openLibraryFile", async () => {
    const data = await model.panelData(null);
    await vscode.window.showTextDocument(vscode.Uri.file(data.libraryPath), { preview: false });
  });

  register("openSettingsFile", async () => {
    const projectRoot = await deps.resolveRoot();
    if (projectRoot === null) return void vscode.window.showWarningMessage("未选择项目文件夹");
    await vscode.window.showTextDocument(vscode.Uri.file(claudeSettingsFile(projectRoot)), { preview: false });
  });
}
