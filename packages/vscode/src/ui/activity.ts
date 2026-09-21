import type { ActivityRow, BadgeTone } from "../dashboard/protocol.ts";

// 面板上「最近发生了什么」的来源。它是宿主唯一自己拥有的状态——项目状态、会话、
// Skill 都问 core，只有「你刚刚点了什么、它成没成」是编辑器才知道的事。因此这里
// 只保存一圈最近的操作，不复制任何 core 的数字。
//
// 同一条记录也写进 Avenic 输出通道：面板显示最近三条，通道保留全部，点「View All
// Activity」看到的就是这份逐条记录（就地解释，不必去翻别处）。

/** What the log writes to. VS Code's OutputChannel satisfies this as it stands. */
export interface ActivitySink {
  appendLine(line: string): void;
  /** Bring the channel into view — the "View All Activity" button's other half. */
  show?(preserveFocus?: boolean): void;
  dispose?(): void;
}

export interface ActivityOptions {
  limit?: number;
  sink?: ActivitySink | null;
  now?: () => Date;
}

const DEFAULT_LIMIT = 50;

// "20:47:12" —— 与面板上其它时间一样，只显示时刻；日期属于会话那一侧。
function clockTime(at: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

export class ActivityLog {
  private readonly entries: ActivityRow[] = [];
  private readonly limit: number;
  private readonly sink: ActivitySink | null;
  private readonly now: () => Date;
  private disposed = false;

  constructor(options: ActivityOptions = {}) {
    this.limit = options.limit ?? DEFAULT_LIMIT;
    this.sink = options.sink ?? null;
    this.now = options.now ?? (() => new Date());
  }

  record(text: string, tone: BadgeTone = "green"): void {
    const time = clockTime(this.now());
    this.entries.unshift({ time, text, tone });
    if (this.entries.length > this.limit) this.entries.length = this.limit;
    this.sink?.appendLine(`${time} ${text}`);
  }

  /** 面板要的那几条，新的在前。返回副本：调用方拿不到这份记录本身。 */
  rows(): ActivityRow[] {
    return this.entries.map((entry) => ({ ...entry }));
  }

  show(): void {
    this.sink?.show?.(true);
  }

  /** 插件停用时关掉输出通道。它与订阅列表里的其它项一样，只关一次。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.sink?.dispose?.();
  }
}
