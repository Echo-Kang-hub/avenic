// A stand-in for the `vscode` module, for loading the packaged bundle outside
// the editor. It exists to answer one question the editor answers for us at
// install time: does the artifact that ships activate, and does it register
// exactly the commands its manifest declares?
//
// It is deliberately dumb. Anything the bundle asks for that is not here is a
// hole in this stub, not a bug in the extension, so the surface is kept to what
// activation actually touches — the tree views, the webview, the command
// registry and the workspace state.
const disposable = { dispose() {} };

export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };

export const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 };

export const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2 };

export const ExtensionMode = { Production: 1, Development: 2, Test: 3 };

export const StatusBarAlignment = { Left: 1, Right: 2 };

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
    const handler = registered.get(id);
    if (!handler) throw new Error(`command not found: ${id}`);
    return handler(...args);
  },
  async getCommands() { return [...registered.keys()]; },
};

export const window = {
  activeTextEditor: undefined,
  visibleTextEditors: [],
  createTreeView(viewId, options) { return { viewId, ...options, dispose() {} }; },
  registerWebviewViewProvider(viewType, provider) { return { viewType, provider, dispose() {} }; },
  createWebviewPanel(viewType, title) {
    return {
      viewType,
      title,
      webview: { html: "", options: {}, asWebviewUri: (uri) => uri, onDidReceiveMessage: () => disposable, postMessage: async () => true, cspSource: "" },
      onDidDispose: () => disposable,
      onDidChangeViewState: () => disposable,
      dispose() {},
    };
  },
  createStatusBarItem() { return { text: "", tooltip: "", command: undefined, show() {}, hide() {}, dispose() {} }; },
  createOutputChannel(name) { return { name, appendLine() {}, append() {}, show() {}, dispose() {} }; },
  async showQuickPick(items) { return typeof items === "function" ? undefined : (await items)[0]; },
  async showInputBox() { return undefined; },
  async showWarningMessage() { return undefined; },
  async showErrorMessage() { return undefined; },
  async showInformationMessage() { return undefined; },
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

export const env = { language: "en", appName: "Visual Studio Code", openExternal: async () => true, clipboard: { writeText: async () => {} } };

export const ProgressLocationSourceControl = ProgressLocation.SourceControl;
