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

  // 真实 DOM 里 textContent 是**整棵子树**的文本，容器自己不带文本——读一个按钮的
  // textContent 拿到的是它里面那个 span 说的话。桩要是只回自己的那一段，按文案找按钮
  // 就会一个都找不到，而那不是页面的 bug。
  get textContent(): string {
    return this.text + this.children.map((child) => child.textContent).join("");
  }

  // 写 textContent 会替换掉所有子节点（真实 DOM 的行为），旧的这一段同时记进 texts：
  // 「界面上出现过什么」按写入顺序留存，与此刻的树无关。
  set textContent(value: string) {
    this.text = String(value);
    this.children.length = 0;
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

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  // 渲染路径还会在 DOM 上做三件事：按 className 增删（激活态的切换）、给新节点设
  // id 之后再按 id 找回来、把焦点交给重建后的那个 tab。桩缺一件，页面就会在一个
  // 真实浏览器不会出错的地方抛错——那不是页面的 bug。
  id = "";
  tabIndex = 0;
  onclick: (() => void) | null = null;

  get classList(): { add: (...names: string[]) => void; remove: (...names: string[]) => void; toggle: (name: string, force?: boolean) => void; contains: (name: string) => boolean } {
    return {
      add: (...names: string[]) => this.setClasses([...this.classes(), ...names]),
      remove: (...names: string[]) => this.setClasses(this.classes().filter((name) => !names.includes(name))),
      toggle: (name: string, force?: boolean) => {
        const on = force ?? !this.classes().includes(name);
        this.setClasses(on ? [...this.classes(), name] : this.classes().filter((item) => item !== name));
      },
      contains: (name: string) => this.classes().includes(name),
    };
  }

  focus(): void { /* 真实 DOM 会移动焦点；桩只需要它不抛错 */ }

  querySelector(selector: string): StubNode | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  querySelectorAll(selector: string): StubNode[] {
    const found: StubNode[] = [];
    const walk = (node: StubNode): void => {
      for (const child of node.children) {
        if (matchesSelector(child, selector)) found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }

  private classes(): string[] {
    return this.className.split(/\s+/).filter(Boolean);
  }

  private setClasses(names: string[]): void {
    this.className = [...new Set(names)].join(" ");
  }
}

// 页面用到的选择器只有一种形状：标签、类与属性条件的串联——".nav-item[data-section]"、
// ".tab[aria-controls=x][aria-selected=true]"。没有后代组合子，因此不必实现一个真的
// 选择器引擎；但每一段都必须真的被匹配，否则桩会把不存在的节点「找到」。
const SELECTOR_TOKEN = /([a-zA-Z][\w-]*)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g;

function matchesSelector(node: StubNode, selector: string): boolean {
  SELECTOR_TOKEN.lastIndex = 0;
  let consumed = 0;
  let match: RegExpExecArray | null;
  while ((match = SELECTOR_TOKEN.exec(selector)) !== null) {
    if (match.index !== consumed) return false;
    consumed = match.index + match[0].length;
    const [, tag, className, attribute, attributeValue] = match;
    if (tag !== undefined && node.tagName !== tag.toUpperCase()) return false;
    if (className !== undefined && !node.className.split(/\s+/).includes(className)) return false;
    if (attribute !== undefined) {
      const value = node.getAttribute(attribute);
      if (attributeValue === undefined ? value === null : value !== attributeValue) return false;
    }
  }
  return consumed === selector.length && consumed > 0;
}

export interface Rendered {
  created: StubNode[];
  texts: string[];
  posted: unknown[];
  byId: Map<string, StubNode>;
  // 追加派发一条消息（点击等交互之后 host 的回应走这里）。
  send: (message: unknown) => void;
  /** 分区内容挂载点：断言「点完之后这一页画的是什么」看它。 */
  content: StubNode;
}

export interface RenderOptions {
  /** 数据消息之后依次派发的消息（模拟「点击 → host 回包」的往返）。 */
  messages?: unknown[];
  /**
   * 脚本执行前先往 document 里放东西。页面的外壳是静态 HTML（模板里的侧栏、分区名
   * 都写在那儿），桩不解析模板——需要外壳的用例自己把那一层铺进去。
   */
  seed?: (document: StubDocument) => void;
  filename?: string;
}

export interface StubDocument {
  createElement(tag: string): StubNode;
  createElementNS(namespace: string, tag: string): StubNode;
  getElementById(id: string): StubNode;
  querySelector(selector: string): StubNode | null;
  querySelectorAll(selector: string): StubNode[];
}

// 每条 data 消息都在全新的 vm 上下文里跑一遍脚本（避免两次渲染的记录互相污染）。
export function renderDataMessage(payload: unknown, source: string, options: RenderOptions = {}): Rendered {
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
  const document: StubDocument = {
    createElement: (tag) => make(tag),
    // agent 的标记是内联 SVG（createElementNS）：桩里两者没有区别。
    createElementNS: (_namespace, tag) => make(tag),
    getElementById: (id) => {
      let node = byId.get(id);
      if (node === undefined) {
        node = make("div");
        byId.set(id, node);
      }
      return node;
    },
    querySelector: (selector) => created.find((node) => matchesSelector(node, selector)) ?? null,
    querySelectorAll: (selector) => created.filter((node) => matchesSelector(node, selector)),
  };
  options.seed?.(document);
  const messageListeners: Array<(event: { data: unknown }) => void> = [];
  const context = createContext({
    document,
    window: {
      addEventListener: (type: string, listener: (event: { data: unknown }) => void) => {
        if (type === "message") messageListeners.push(listener);
      },
    },
    acquireVsCodeApi: () => ({ postMessage: (message: unknown) => posted.push(message) }),
    // 「读了半秒还没回来」那一行由视觉套件拍下来（fixture a-reference-…-reading），
    // 这里只要它别把渲染路径拖成异步：定时器响不响，与本次断言无关。
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    console,
  });
  runInContext(source, context, { filename: options.filename ?? "webview main.js" });
  assert.ok(messageListeners.length > 0, "main.js 必须注册 window message 监听");
  const send = (message: unknown): void => {
    for (const listener of messageListeners) listener({ data: message });
  };
  send({ type: "data", payload });
  for (const message of options.messages ?? []) send(message);
  return { created, texts, posted, byId, send, content: document.getElementById("content") };
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
