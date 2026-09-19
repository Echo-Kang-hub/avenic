import assert from "node:assert/strict";
import { createContext, runInContext } from "node:vm";

// A minimal DOM for executing a webview script outside the editor. It exists so
// the media tests can run a page's real render path (createElement/textContent/
// append/listeners) instead of string-matching the source, which is blind to
// runtime errors inside those functions.
//
// It is deliberately shallow: anything the render path asks for that is not
// here is a hole to fill, not a bug in the page. Both the model panel and the
// Sessions page render through it, so a page that grows a new DOM surface needs
// it added once.

export class StubNode {
  readonly children: StubNode[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  className = "";
  title = "";
  hidden = false;
  disabled = false;
  // 表单控件属性：渲染路径会读/写这几种（密码框、勾选框、下拉项）。
  type = "";
  placeholder = "";
  checked = false;
  selected = false;
  private explicitValue = "";
  private text = "";

  // <select> 的 value 在真实 DOM 里是「选中项的值」，读和写都双向联动：
  // 读 → 命中 selected 的 option；写 → 把 selected 挪到匹配的 option 上。
  // 不模拟这一层的话，面板读 fields.api.value 会拿到空串（真实浏览器里不会）。
  get value(): string {
    if (this.tagName === "SELECT") {
      const chosen = this.children.find((child) => child.tagName === "OPTION" && child.selected);
      if (chosen !== undefined) return chosen.value;
    }
    return this.explicitValue;
  }

  set value(next: string) {
    this.explicitValue = String(next);
    if (this.tagName === "SELECT") {
      for (const child of this.children) {
        if (child.tagName === "OPTION") child.selected = child.value === this.explicitValue;
      }
    }
  }

  // 不用 TS 的「构造器参数属性」（constructor(readonly x: T)）：根目录的 `npm test`
  // 会用 Node 的 strip-only 类型擦除直接执行本文件，而 strip-only 明确不支持该语法
  // （ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX）。vscode 本地套件走 esbuild，能吞下它，
  // 所以这条约束只有根套件看得见——保留显式字段声明与赋值。
  readonly tagName: string;
  private readonly texts: string[];

  constructor(tagName: string, texts: string[]) {
    this.tagName = tagName;
    this.texts = texts;
  }

  get textContent(): string {
    return this.text;
  }

  set textContent(value: string) {
    this.text = String(value);
    this.texts.push(this.text);
  }

  append(...nodes: StubNode[]): void {
    this.children.push(...nodes);
  }

  replaceChildren(...nodes: StubNode[]): void {
    this.children.splice(0, this.children.length, ...nodes);
  }

  addEventListener(type: string, listener: (...args: unknown[]) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
}

export interface Rendered {
  created: StubNode[];
  texts: string[];
  posted: unknown[];
  byId: Map<string, StubNode>;
  // 追加派发一条消息（点击等交互之后 host 的回应走这里）。
  send: (message: unknown) => void;
}

// 每条 data 消息都在全新的 vm 上下文里跑一遍脚本（避免两次渲染的记录互相污染）。
// extra: 数据消息之后依次派发的消息（模拟「点击 → host 回包」的往返）。
export function renderDataMessage(payload: unknown, source: string, extra: unknown[] = [], filename = "webview main.js"): Rendered {
  const created: StubNode[] = [];
  const texts: string[] = [];
  const posted: unknown[] = [];
  const byId = new Map<string, StubNode>();
  const make = (tag: string): StubNode => {
    // 真实 DOM 的 HTML 元素 tagName 是大写（document.createElement("button").tagName === "BUTTON"）
    const node = new StubNode(tag.toUpperCase(), texts);
    created.push(node);
    return node;
  };
  const document = {
    createElement: (tag: string) => make(tag),
    getElementById: (id: string) => {
      let node = byId.get(id);
      if (node === undefined) {
        node = make("div");
        byId.set(id, node);
      }
      return node;
    },
  };
  const messageListeners: Array<(event: { data: unknown }) => void> = [];
  const context = createContext({
    document,
    window: {
      addEventListener: (type: string, listener: (event: { data: unknown }) => void) => {
        if (type === "message") messageListeners.push(listener);
      },
    },
    acquireVsCodeApi: () => ({ postMessage: (message: unknown) => posted.push(message) }),
    console,
  });
  runInContext(source, context, { filename });
  assert.ok(messageListeners.length > 0, "main.js 必须注册 window message 监听");
  const send = (message: unknown): void => {
    for (const listener of messageListeners) listener({ data: message });
  };
  send({ type: "data", payload });
  for (const message of extra) send(message);
  return { created, texts, posted, byId, send };
}

/** 触发节点上已注册的事件（点击等）。 */
export function fire(node: StubNode, type = "click"): void {
  for (const listener of node.listeners.get(type) ?? []) listener({ type });
}

/** 按可见文本找按钮（面板的按钮都没有 id，靠文案定位）。 */
export function buttons(rendered: Rendered, text: string): StubNode[] {
  return rendered.created.filter((node) => node.tagName === "BUTTON" && node.textContent === text);
}

/** 面板自己贴出的所有文本（断言「界面上出现过什么」用这个，而不是只找某个节点）。 */
export function allText(rendered: Rendered): string {
  return rendered.texts.join("\n");
}

/**
 * 跨 realm 比较：vm 上下文里造的对象原型链属于另一个 realm，
 * 而 node:assert/strict 的 deepEqual 会连原型一起比。比较前先归一到本 realm 的普通对象。
 */
export function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 最近一条某类型的出站消息（已跨 realm 归一）。 */
export function lastPosted(rendered: Rendered, type: string): Record<string, unknown> | undefined {
  const found = rendered.posted.filter((message) => (message as { type?: string })?.type === type).at(-1);
  return found === undefined ? undefined : plain(found as Record<string, unknown>);
}
