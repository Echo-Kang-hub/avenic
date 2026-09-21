import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as vscode from "vscode";
import { isWebviewMessage, type ActivityRow, type DashboardAction, type DashboardSection } from "./protocol.ts";
import { buildDashboardData } from "./state.ts";

// 仪表盘面板：编辑器区里的一个 webview，内部侧栏切换分区。整块界面就是参考图，
// 因此它需要一个整幅的宽度——活动栏那边只留一个轻量入口。
//
// 这一层只做四件事：把模板注入成 HTML（图标与脚本都经 asWebviewUri，CSP 里没有
// 远程来源）、把 core 的数据推给 webview、把用户动作交给命令层、记住当前分区。
// 它自己不做任何判断，也不持有任何状态。

/** 会列出「一整份清单」的分区：它们的载荷要更长，概览只要最近几条。 */
function deep(section: DashboardSection): boolean {
  return section === "sessions" || section === "skills";
}

export interface DashboardPanelDeps {
  root: () => string | null;
  /** 面板上每一次点击的落点：由命令层解释，面板不认识业务。 */
  dispatch: (action: DashboardAction) => void;
}

export class DashboardPanel {
  static current: DashboardPanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;
  private section: DashboardSection = "overview";
  // A landing place the webview has not been told about yet. Only an explicit
  // request (a command opening the panel on a section, a session being opened)
  // sets it, and the next payload spends it — a payload never carries the panel's
  // remembered section back, because that is exactly what used to drag a session
  // click back to Overview.
  private landing: DashboardSection | null = null;
  private payloadDetail = false;
  private sessionId: string | null = null;
  private sending: Promise<void> = Promise.resolve();

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly deps: DashboardPanelDeps,
    private readonly version: string,
    private readonly activity: () => ActivityRow[],
  ) {
    panel.onDidDispose(() => this.dispose(), undefined, this.disposables);
    panel.webview.onDidReceiveMessage((message: unknown) => this.receive(message), undefined, this.disposables);
  }

  static show(context: vscode.ExtensionContext, deps: DashboardPanelDeps, activity: () => ActivityRow[], section?: DashboardSection): DashboardPanel {
    const existing = DashboardPanel.current;
    if (existing !== undefined) {
      existing.panel.reveal(vscode.ViewColumn.Active);
      if (section !== undefined) existing.navigate(section);
      return existing;
    }
    const panel = vscode.window.createWebviewPanel("avenic.dashboard", "Avenic", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
    });
    // 面板本身也是扩展的贡献：扩展停用（升级、禁用）时它该跟着走，而不是活过这一轮
    // 激活。与 extension.ts 里其它贡献一样挂在同一个 subscriptions 上。
    context.subscriptions.push(panel);
    DashboardPanel.current = new DashboardPanel(
      panel,
      context.extensionUri,
      deps,
      String(context.extension.packageJSON.version ?? ""),
      activity,
    );
    if (section !== undefined) {
      DashboardPanel.current.section = section;
      DashboardPanel.current.landing = section;
    }
    void DashboardPanel.current.render().catch(() => { /* 面板已销毁 */ });
    return DashboardPanel.current;
  }

  /** 项目状态变了：面板开着就重读一遍（没开什么都不做）。 */
  refresh(): void {
    if (this.disposed) return;
    void this.sendData();
  }

  /** 打开一条会话：读它的对话内容随下一次推送一起过去，初帧永远不读事件日志。
   *  会话只能读在 Sessions 页上，所以「打开」同时就是「翻到 Sessions」——否则用户
   *  点了一条标题，读到的对话却在一块看不见的地方被推过来。 */
  open(sessionId: string | null): void {
    this.sessionId = sessionId;
    this.section = "sessions";
    this.landing = "sessions";
    void this.sendData();
  }

  /** 切到某个分区（面板内的导航是本地行为，这只是让宿主也能指定落点）。 */
  navigate(section: DashboardSection): void {
    this.section = section;
    this.landing = section;
    this.post({ type: "navigate", section });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (DashboardPanel.current === this) DashboardPanel.current = undefined;
    for (const item of this.disposables.splice(0)) item.dispose();
  }

  private receive(message: unknown): void {
    if (!isWebviewMessage(message)) return;
    if (message.type === "ready" || message.type === "refresh") {
      void this.sendData();
      return;
    }
    if (message.type === "navigate") {
      this.section = message.section;
      // 一页有多深是宿主给的（概览是最近 5 条，清单页是 50 条），所以翻页要重取这一页
      // 的那一份；已经是对的那一份就不重复读盘。面板先用手上这份画出来，深的这份到了
      // 再接上——一次读盘不该挡住一次点击。
      if (deep(this.section) !== this.payloadDetail) void this.sendData();
      return;
    }
    this.deps.dispatch(message);
  }

  private async render(): Promise<void> {
    try {
      await this.setHtml();
    } catch {
      // 模板缺失等致命错误：降级为无脚本静态提示（同样没有远程内容）
      try {
        this.panel.webview.html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8" /><meta http-equiv="Content-Security-Policy" content="default-src 'none'" /></head><body><p>Avenic could not load its dashboard resources.</p></body></html>`;
      } catch { /* 面板已销毁 */ }
    }
    void this.sendData();
  }

  private async setHtml(): Promise<void> {
    const { webview } = this.panel;
    const media = (...parts: string[]) => vscode.Uri.joinPath(this.extensionUri, "media", ...parts);
    const template = await readFile(media("dashboard", "view.html").fsPath, "utf8");
    const uri = (target: vscode.Uri) => webview.asWebviewUri(target).toString();
    webview.html = template
      .replaceAll("{{nonce}}", randomUUID())
      .replaceAll("{{cspSource}}", webview.cspSource)
      .replaceAll("{{mainJs}}", uri(media("dashboard", "main.js")))
      .replaceAll("{{style}}", uri(media("dashboard", "style.css")))
      // 品牌图标随扩展一起打包，经 asWebviewUri 读同一个副本：运行时没有开发机路径。
      .replaceAll("{{iconUri}}", uri(media("avenic.png")));
  }

  // 早到的那次数据可能还在读盘，晚到的 ready 又点了一次——两次并发只会让后到的
  // 覆盖先到的，所以排队而不是并行。
  private sendData(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.sending = this.sending.then(async () => {
      if (this.disposed) return;
      const section = this.landing ?? this.section;
      const detail = deep(section);
      const landing = this.landing;
      this.landing = null;
      try {
        const data = await buildDashboardData(this.deps.root(), process.env, {
          version: this.version,
          activity: this.activity(),
          transcriptId: this.sessionId,
          detail,
        });
        this.payloadDetail = detail;
        // 落点只在它还对的时候随包发出：其余时候这一份数据不替 webview 决定它停在
        // 哪一页（它自己知道，而且它是那个会翻页的人）。
        this.post({ type: "data", payload: data, section: landing ?? undefined });
      } catch (error) {
        this.post({ type: "error", message: error instanceof Error ? error.message : String(error) });
      }
    });
    return this.sending;
  }

  private post(message: Record<string, unknown>): void {
    if (this.disposed) return;
    void this.panel.webview.postMessage(message).then(undefined, () => { /* 面板销毁后 postMessage 拒绝：静默 */ });
  }
}
