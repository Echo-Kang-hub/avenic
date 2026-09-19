import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as vscode from "vscode";
import { isSessionsViewMessage, type SessionsSenderMessage, type SessionsViewMessage } from "../sessions/protocol.ts";
import { DEFAULT_TURN_LIMIT, buildSessionsData } from "../sessions/state.ts";

// 会话页：共享对话的阅读器（编辑器标签页，与 ModelPanel 同一个薄壳模板——
// 模板注入、消息白名单、数据单向）。业务逻辑全部在 core 与 services 层，
// 这里只记住「读哪一条、读多少轮」并把读到的模型发给 webview。
//
// 选择与轮数上限存在宿主侧：刷新（启动/导入后 extension 会调 refreshCurrent）
// 不该把用户正在读的会话和已展开的轮数重置回默认。
export class SessionsPanel {
  static current: SessionsPanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;
  private selectedId: string | null = null;
  private limit = DEFAULT_TURN_LIMIT;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly projectRoot: () => string | null,
  ) {
    panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
    panel.webview.onDidReceiveMessage((message: unknown) => {
      if (!isSessionsViewMessage(message)) return;
      this.handle(message);
    }, undefined, this.disposables);
  }

  static show(extensionUri: vscode.Uri, projectRoot: () => string | null): SessionsPanel {
    if (SessionsPanel.current) {
      SessionsPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return SessionsPanel.current;
    }
    const panel = vscode.window.createWebviewPanel("avenic.sessions", "Avenic Sessions", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
    });
    SessionsPanel.current = new SessionsPanel(panel, extensionUri, projectRoot);
    void SessionsPanel.current.render().catch(() => { /* 面板已销毁 */ });
    return SessionsPanel.current;
  }

  /** 会话存储可能被一次启动或导入改写：面板开着就重新读一遍（没开则什么都不做）。 */
  static refreshCurrent(): void {
    SessionsPanel.current?.refresh();
  }

  refresh(): void {
    void this.sendData();
  }

  // 标签页关闭：清空单例（否则下次打开会对已销毁的面板 reveal 而抛错），
  // 逐个释放监听；幂等（onDidDispose 与显式调用可能都到达）。
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (SessionsPanel.current === this) SessionsPanel.current = undefined;
    for (const item of this.disposables.splice(0)) item.dispose();
  }

  private handle(message: SessionsViewMessage): void {
    if (message.type === "select") this.selectedId = message.id;
    if (message.type === "limit") this.limit = message.limit;
    void this.sendData();
  }

  private async render(): Promise<void> {
    try {
      await this.setHtml();
    } catch {
      try {
        this.panel.webview.html = FALLBACK_HTML;
      } catch { /* 面板已销毁 */ }
    }
    void this.sendData();
  }

  private async setHtml(): Promise<void> {
    const { webview } = this.panel;
    const htmlPath = vscode.Uri.joinPath(this.extensionUri, "media", "sessions", "view.html");
    const template = await readFile(htmlPath.fsPath, "utf8");
    const nonce = randomUUID();
    const mainJs = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "sessions", "main.js")).toString();
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "sessions", "style.css")).toString();
    webview.html = template
      .replaceAll("{{nonce}}", nonce)
      .replaceAll("{{cspSource}}", webview.cspSource)
      .replaceAll("{{mainJs}}", mainJs)
      .replaceAll("{{style}}", style);
  }

  private async sendData(): Promise<void> {
    if (this.disposed) return; // 面板已销毁：不做任何读取
    try {
      const data = await buildSessionsData(this.projectRoot(), { id: this.selectedId, limit: this.limit });
      this.post({ type: "data", payload: data });
    } catch (error) {
      this.post({ type: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  private post(message: SessionsSenderMessage): void {
    if (this.disposed) return;
    void this.panel.webview.postMessage(message).then(undefined, () => { /* 面板销毁后 postMessage 拒绝：静默 */ });
  }
}

// 模板缺失/面板销毁时的降级：无脚本、无远程内容（照 dashboard/overview.ts 的静态提示）。
const FALLBACK_HTML = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8" /><meta http-equiv="Content-Security-Policy" content="default-src 'none'" /></head><body><p>会话页初始化失败：视图资源缺失。</p></body></html>`;
