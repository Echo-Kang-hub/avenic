// A stand-in for the `vscode` module, for loading the packaged bundle outside
// the editor. It exists to answer two questions the editor answers for us at
// install time: does the artifact that ships activate and register exactly the
// commands its manifest declares, and does every one of those commands do
// something a user can see when it is invoked?
//
// It is deliberately dumb. Anything the bundle asks for that is not here is a
// hole in this stub, not a bug in the extension, so the surface is kept to what
// activation and the commands actually touch — the tree views, the webview, the
// command registry, the terminals, the prompts and the workspace state.
//
// For the second question it records rather than pretends: every entry point a
// command can reach a user through appends to `effects`, so a caller can read
// back what the invocation actually did. Prompts are answered from a queue the
// caller fills (`setAnswers`) — a prompt with nothing queued behaves like a user
// who took the editor's default (first row) or pressed Esc (nothing).
const disposable = { dispose() {} };

export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };

export const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 };

export const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2 };

export const ExtensionMode = { Production: 1, Development: 2, Test: 3 };

export const StatusBarAlignment = { Left: 1, Right: 2 };

export const QuickPickItemKind = { Separator: -1, Default: 0 };

export const QuickInputButtons = { Back: { iconPath: "back", id: "back" } };

// ---- what the invocation did -------------------------------------------
//
// One entry per thing the user would have seen: a message, a terminal, an
// external URI, a panel, a prompt, a folder revealed, or another command
// dispatched. Nothing else goes in here — a progress report is not on the list
// on purpose: a bar that appears and reports nothing is exactly the kind of
// "it did something, technically" this recorder exists to refuse.
export const effects = [];

// The answers a "user" gives at each prompt, consumed in order. Empty means the
// editor's default behaviour, which is also what a real user pressing Enter on
// the first row or Esc would produce.
export const answers = { quickPick: [], inputBox: [], warning: [], information: [], error: [] };

export function setAnswers(next = {}) {
  for (const kind of Object.keys(answers)) answers[kind] = [...(next[kind] ?? [])];
}

function record(effect) {
  effects.push(effect);
  return effect;
}

function answer(kind) {
  const queue = answers[kind];
  return queue.length === 0 ? undefined : queue.shift();
}

function text(value) {
  return String(value);
}

export class TreeItem {
  constructor(label, collapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

export class ThemeIcon {
  constructor(id, color) {
    this.id = id;
    this.color = color;
  }
}

export class MarkdownString {
  constructor(value = "") {
    this.value = value;
  }
}

export class Uri {
  constructor(value) {
    this.value = value;
    this.fsPath = value;
    this.scheme = "file";
  }
  static file(value) { return new Uri(value); }
  static parse(value) { return new Uri(value); }
  static joinPath(base, ...parts) { return new Uri([base.fsPath, ...parts].join("/")); }
  toString() { return this.value; }
}

export class EventEmitter {
  constructor() { this.listeners = new Set(); }
  get event() { return (listener) => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; }; }
  fire(value) { for (const listener of this.listeners) listener(value); }
  dispose() { this.listeners.clear(); }
}

export class Disposable {
  static from(...items) { return { dispose: () => { for (const item of items) item?.dispose?.(); } }; }
  dispose() {}
}

// The command registry is the point of this stub: activation fills it, the
// test reads it.
export const registered = new Map();

export const commands = {
  registerCommand(id, handler) {
    registered.set(id, handler);
    return { dispose: () => registered.delete(id) };
  },
  async executeCommand(id, ...args) {
    // Dispatched before it is looked up: "this control hands off to that
    // command" is an outcome whether or not the target lives in this registry
    // (workbench.command, markdown.showPreview and revealFileInOS never do).
    record({ kind: "command", id, args });
    const handler = registered.get(id);
    if (!handler) throw new Error(`command not found: ${id}`);
    return handler(...args);
  },
  async getCommands() { return [...registered.keys()]; },
};

// A terminal the extension opened. Speaking a command line into a terminal is a
// user-visible act even when nothing here can run it: what the recorder keeps is
// the line itself, which is what the user would have watched.
function createTerminalLike(options) {
  const name = typeof options === "string" ? options : options?.name;
  const terminal = {
    name,
    exitStatus: undefined,
    show() { record({ kind: "terminal", name, action: "show" }); },
    sendText(line) { record({ kind: "terminal", name, action: "sendText", line }); },
    dispose() {},
  };
  record({ kind: "terminal", name, action: "create" });
  return terminal;
}

// The progressive wizard's picker. It is driven by the extension, not by the
// test, so this stands in for the user: on show() it answers from the queue, or
// presses Esc when there is nothing queued. Either way the fact that a picker
// reached the screen is recorded, which is the point.
class StubQuickPick {
  constructor() {
    this.items = [];
    this.selectedItems = [];
    this.activeItems = [];
    this.value = "";
    this.title = "";
    this.placeholder = "";
    this.buttons = [];
    this.ignoreFocusOut = false;
    this.canPickMany = false;
    this.canSelectMany = false;
    this.listeners = { accept: new Set(), hide: new Set(), button: new Set(), selection: new Set() };
    this.shown = false;
  }
  onDidAccept(cb) { return this.on("accept", cb); }
  onDidHide(cb) { return this.on("hide", cb); }
  onDidTriggerButton(cb) { return this.on("button", cb); }
  onDidChangeSelection(cb) { return this.on("selection", cb); }
  on(event, cb) {
    this.listeners[event].add(cb);
    return { dispose: () => this.listeners[event].delete(cb) };
  }
  fire(event) { for (const cb of [...this.listeners[event]]) cb(); }
  show() {
    record({ kind: "prompt", prompt: "wizard", title: this.title });
    this.shown = true;
    queueMicrotask(() => this.deliver());
  }
  hide() {
    this.shown = false;
    this.fire("hide");
  }
  dispose() { this.hide(); }
  deliver() {
    if (!this.shown) return;
    const wanted = answer("quickPick");
    if (wanted === undefined || wanted === null) { this.hide(); return; }
    const match = this.items.find((item) => item.label === wanted);
    if (match === undefined) this.value = wanted;
    else { this.selectedItems = [match]; this.activeItems = [match]; }
    this.fire("accept");
  }
}

function picker() {
  return new StubQuickPick();
}

// The notifications. `level` is what separates "said something on purpose"
// (warning/information) from "something threw" (error) — the recorder keeps the
// distinction because a harness that accepts either cannot tell a control that
// refuses with a reason from one that crashed into a try/catch.
function notifications(level) {
  return async (body, ...rest) => {
    const actions = rest.filter((entry) => typeof entry === "string");
    record({ kind: "message", level, text: display(body), actions });
    return answer(level);
  };
}

function display(value) {
  return typeof value === "string" ? value : text(value);
}

export const window = {
  activeTextEditor: undefined,
  visibleTextEditors: [],
  createTreeView(viewId, options) { return { viewId, ...options, dispose() {} }; },
  registerWebviewViewProvider(viewType, provider) { return { viewType, provider, dispose() {} }; },
  createWebviewPanel(viewType, title, column, options) {
    const panel = {
      viewType,
      title,
      options,
      reveal() { record({ kind: "webview", viewType, action: "reveal" }); },
      webview: {
        html: "",
        options: {},
        cspSource: "",
        asWebviewUri: (uri) => uri,
        onDidReceiveMessage: (listener) => { panel.receive = listener; return disposable; },
        postMessage: async (payload) => { record({ kind: "webview", viewType, action: "postMessage", payload }); return true; },
      },
      onDidDispose: () => disposable,
      onDidChangeViewState: () => disposable,
      dispose() {},
    };
    record({ kind: "webview", viewType, action: "create" });
    return panel;
  },
  createStatusBarItem() { return { text: "", tooltip: "", command: undefined, show() {}, hide() {}, dispose() {} }; },
  createOutputChannel(name) { return { name, appendLine() {}, append() {}, show() {}, dispose() {} }; },
  createTerminal: createTerminalLike,
  onDidCloseTerminal(listener) { return { listener, dispose() {} }; },
  createQuickPick: picker,
  async showQuickPick(items, options = {}) {
    const list = typeof items === "function" ? [] : await items;
    const multiple = options.canPickMany === true || options.canSelectMany === true;
    record({ kind: "prompt", prompt: "quickPick", multiple, title: display(options.title ?? ""), count: list.length });
    const chosen = answer("quickPick");
    if (multiple) return chosen === undefined ? (list.length > 0 ? [list[0]] : []) : chosen;
    return chosen === undefined ? list[0] : chosen;
  },
  async showInputBox(options = {}) {
    record({ kind: "prompt", prompt: "inputBox", title: display(options.title ?? ""), message: display(options.prompt ?? "") });
    return answer("inputBox");
  },
  async showTextDocument(uri) { record({ kind: "open", target: text(uri) }); return { document: { uri } }; },
  showWarningMessage: notifications("warning"),
  showErrorMessage: notifications("error"),
  showInformationMessage: notifications("information"),
  withProgress(_options, task) { return task({ report() {} }); },
  setStatusBarMessage() { return disposable; },
};

export const workspace = {
  workspaceFolders: undefined,
  getConfiguration() { return { get: () => undefined, update: async () => {}, has: () => false, inspect: () => undefined }; },
  onDidChangeConfiguration() { return disposable; },
  onDidChangeWorkspaceFolders() { return disposable; },
  onDidSaveTextDocument() { return disposable; },
  createFileSystemWatcher() { return { onDidChange: () => disposable, onDidCreate: () => disposable, onDidDelete: () => disposable, dispose() {} }; },
  fs: { readFile: async () => new Uint8Array(), writeFile: async () => {}, stat: async () => ({ type: 1 }) },
  asRelativePath: (value) => String(value),
};

export const env = {
  language: "en",
  appName: "Visual Studio Code",
  async openExternal(uri) { record({ kind: "external", target: text(uri) }); return true; },
  clipboard: { writeText: async () => {} },
};

export const ProgressLocationSourceControl = ProgressLocation.SourceControl;
