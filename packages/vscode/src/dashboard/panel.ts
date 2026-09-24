import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as vscode from "vscode";
import { isWebviewMessage, needsSectionData, payloadDetailFor, type ActivityRow, type AgentId, type CenterDraft, type CenterResult, type DashboardAction, type DashboardSection, type HookScope, type HooksResult, type RunState, type StatusMessage } from "./protocol.ts";
import { cachedAvenicCliVersion } from "../services/agent-versions.ts";
import type { AboutOptions } from "../services/about.ts";
import { textScript } from "../i18n/text.ts";
import { buildDashboardData } from "./state.ts";

// 仪表盘面板：编辑器区里的一个 webview，内部侧栏切换分区。整块界面就是参考图，
// 因此它需要一个整幅的宽度——活动栏那边只留一个轻量入口。
//
// 这一层只做四件事：把模板注入成 HTML（图标与脚本都经 asWebviewUri，CSP 里没有
// 远程来源）、把 core 的数据推给 webview、把用户动作交给命令层、记住当前分区。
// 它自己不做任何判断，也不持有任何状态。

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
  // 页面有没有说过「我在听着」。说之前 postMessage 是丢的，那时只记住落点、不发。
  private loaded = false;
  private payloadDetail = false;
  private sessionId: string | null = null;
  // 模型配置中心看的是哪一个 agent，以及上一次向它问了什么（测试／预览／写入／模型
  // 表的结果）。结果由宿主记着，页面刷新后再画一遍；它属于某一份表单，所以换 agent
  // 时跟着换掉。
  private centerAgent: AgentId | null = null;
  private centerResult: CenterResult | null = null;
  // 钩子与通知那一页看的是哪一档作用域，以及上一次向它问了什么（预览／装／卸／写名单）。
  // 没打开过这一页时是 null —— 「没打开过」与「这一页是空的」是两件事。
  private hooksScope: HookScope | null = null;
  private hooksResult: HooksResult | null = null;
  private sending: Promise<void> = Promise.resolve();

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly extensionUri: vscode.Uri,
    private readonly deps: DashboardPanelDeps,
    private readonly extensionVersion: string,
    private readonly activity: () => ActivityRow[],
    /** 设置与关于那一页要说的、只有宿主才知道的那几个事实。 */
    private readonly about: Omit<AboutOptions, "coreVersion" | "language" | "cliVersion">,
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
      {
        // 清单就是这份安装的身份：名字、显示名、版本、id 全部从它读，不多一份常量。
        extension: {
          id: String(context.extension.id ?? ""),
          name: String(context.extension.packageJSON.name ?? ""),
          displayName: String(context.extension.packageJSON.displayName ?? ""),
          version: String(context.extension.packageJSON.version ?? ""),
        },
        editorVersion: vscode.version,
        storagePath: context.globalStorageUri.fsPath,
      },
    );
    if (section !== undefined) DashboardPanel.current.land(section);
    void DashboardPanel.current.render().catch(() => { /* 面板已销毁 */ });
    return DashboardPanel.current;
  }

  /** 项目状态变了：面板开着就重读一遍（没开什么都不做）。 */
  refresh(): void {
    if (this.disposed) return;
    void this.sendData();
  }

  /**
   * 一次启动的开始或结束：只有状态那一行变了，所以只送那一行。
   *
   * Both callers here are the outside world noticing — a launch in another
   * terminal, an agent that exited — and none of them changed a single row of
   * history. Re-sending the whole payload would re-read the project and make the
   * page jump under whoever was reading it; the runs ride on their own message.
   */
  status(runs: Record<AgentId, RunState>): void {
    if (this.disposed) return;
    const message: StatusMessage = { type: "status", runs };
    this.post(message);
  }

  /** 打开一条会话：读它的对话内容随下一次推送一起过去，初帧永远不读事件日志。
   *  会话只能读在 Sessions 页上，所以「打开」同时就是「翻到 Sessions」——否则用户
   *  点了一条标题，读到的对话却在一块看不见的地方被推过来。 */
  open(sessionId: string | null): void {
    this.sessionId = sessionId;
    this.land("sessions");
    void this.sendData();
  }

  /** 切到某个分区。 */
  navigate(section: DashboardSection): void {
    this.land(section);
    // 钩子与设置这两页的数据只在它们自己的屏幕上组装，而这一次翻页是宿主起的（页面不会
    // 为此回一句话），所以这里必须自己问一次——否则落到一张空页上。
    if (section === "hooks" || section === "settings") void this.sendData();
  }

  /**
   * 模型配置中心落到某个 agent 上，并把它的状态重新读一遍（换过供应商、写过文件
   * 之后，那一页要说的正是文件现在的样子）。`result` 是刚问出来的答案：没有就沿用
   * 上一次的，除非换的是另一个 agent —— 那份答案属于另一张表单。
   */
  centerOn(agentId: AgentId, result?: CenterResult): void {
    if (agentId !== this.centerAgent) this.centerResult = null;
    this.centerAgent = agentId;
    if (result !== undefined) this.centerResult = result;
    this.land("center");
    void this.sendData();
  }

  /**
   * 「Reset to preset」的答案：填的是那一页上的表单，不是盘上的文件，所以它单独
   * 走一条消息 —— 不必为一次选择重读项目。
   */
  centerDraft(draft: CenterDraft): void {
    this.post({ type: "draft", draft });
  }

  /**
   * 钩子与通知落到某一档作用域上，并把这一档重新读一遍（装过、卸过、改过名单之后，
   * 这一页要说的正是文件现在的样子）。`result` 是刚问出来的答案：没有就沿用上一次的，
   * 除非换的是另一档 —— 那份答案属于另一份名单。
   */
  hooksOn(scope: HookScope, result?: HooksResult): void {
    if (scope !== this.hooksScope) this.hooksResult = null;
    this.hooksScope = scope;
    if (result !== undefined) this.hooksResult = result;
    this.land("hooks");
    void this.sendData();
  }

  /** 落到某一页：页面说过 ready 就现在告诉它，没说过就先记住——那句话到得太早是丢的，
   *  等它开口（首帧、重载后的又一句 ready）再补上。载荷从不带落点：它到得晚一步，带着的
   *  落点会把已经自己翻到别处的读者拽回去。 */
  private land(section: DashboardSection): void {
    this.section = section;
    if (this.loaded) this.post({ type: "navigate", section });
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
      // 页面开口了：把它现在该停的那一页告诉它（首帧，或重载之后的又一句 ready）。
      if (message.type === "ready") {
        this.loaded = true;
        this.post({ type: "navigate", section: this.section });
      }
      void this.sendData();
      return;
    }
    if (message.type === "navigate") {
      const entering = message.section !== this.section;
      this.section = message.section;
      // 要不要重读这一页是协议的一条判断（深页的清单不一样，中心/钩子/设置的数据
      // 只在它们自己那一页上组装，见 needsSectionData），面板只负责执行它。面板先用手上
      // 这份画出来，新的一份到了再接上——一次读盘不该挡住一次点击。
      if (needsSectionData(this.section, this.payloadDetail, entering)) void this.sendData();
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
      // 词表随页面一起到：webview 是 classic script，import 不了模块，而它也不该
      // 自己再写一遍中文。英文是主标签，中文按编辑器的语言决定露不露面。
      .replaceAll("{{text}}", textScript(vscode.env.language))
      // 品牌图标随扩展一起打包，经 asWebviewUri 读同一个副本：运行时没有开发机路径。
      .replaceAll("{{iconUri}}", uri(media("avenic.png")));
  }

  // 早到的那次数据可能还在读盘，晚到的 ready 又点了一次——两次并发只会让后到的
  // 覆盖先到的，所以排队而不是并行。
  private sendData(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.sending = this.sending.then(async () => {
      if (this.disposed) return;
      const section = this.section;
      const detail = payloadDetailFor(section);
      try {
        const data = await buildDashboardData(this.deps.root(), process.env, {
          // 底部那一行读的是缓存下来的答案：探测在飞的时候这一帧照画，等它落地后
          // 宿主再让面板补一次（见 extension.ts），首帧不为一次 spawn 等待。
          cliVersion: cachedAvenicCliVersion(),
          extensionVersion: this.extensionVersion,
          activity: this.activity(),
          transcriptId: this.sessionId,
          detail,
          // 中心的读写只发生在它自己那一页上：别的分区连 agent 的配置文件都不碰。
          centerAgent: section === "center" ? this.centerAgent : null,
          centerResult: section === "center" ? this.centerResult : null,
          // 钩子页同理，而且只读它正看着的那一档名单：没落到这一页时这是 null。
          hooksScope: section === "hooks" ? this.hooksScope ?? "project" : null,
          hooksResult: section === "hooks" ? this.hooksResult : null,
          // 设置页说的是这套安装本身：它不需要项目，所以没有项目时也给得出来。
          about: section === "settings" ? { ...this.about, cliVersion: cachedAvenicCliVersion() } : null,
          language: vscode.env.language,
        });
        this.payloadDetail = detail;
        // 载荷只说数据，不替页面决定停在哪儿：翻页是那条 navigate 消息的事（见 land）。
        this.post({ type: "data", payload: data });
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
