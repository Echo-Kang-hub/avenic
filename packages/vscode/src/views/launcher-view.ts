import * as vscode from "vscode";

// 活动栏容器现在只回答一个问题：怎么把面板打开，以及还没配好的项目从哪儿开始。
// 它不再是一棵重复面板内容的树——同一条信息在同一个窗口里有两个说法，迟早会互相
// 矛盾，而面板才是那个说得全（并且与参考图一致）的地方。

export class LauncherView implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  refresh(): void {
    this.changed.fire();
  }

  dispose(): void {
    this.changed.dispose();
  }

  getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
    return item;
  }

  getChildren(element?: vscode.TreeItem): vscode.TreeItem[] {
    if (element !== undefined) return [];
    const open = vscode.workspace.workspaceFolders !== undefined && vscode.workspace.workspaceFolders.length > 0;
    const items: vscode.TreeItem[] = [item("Open Dashboard", "avenic.dashboard.open", "window", "Avenic: the whole project state in one panel.")];
    if (!open) {
      items.push(item("Configure Project", "avenic.agents.configureProject", "settings-gear", "Choose the agents this project uses and how they authenticate."));
    }
    items.push(item("Sessions", "avenic.sessions.open", "history", "Every conversation this project's agents have had."));
    items.push(item("Install Skills", "avenic.skills.installPacks", "package", "Add Packs from the configured Hub."));
    return items;
  }
}

function item(label: string, command: string, icon: string, tooltip: string): vscode.TreeItem {
  const node = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
  node.iconPath = new vscode.ThemeIcon(icon);
  node.tooltip = tooltip;
  node.command = { command, title: label };
  return node;
}
