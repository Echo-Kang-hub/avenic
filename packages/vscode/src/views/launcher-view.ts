import * as vscode from "vscode";
import { both, en, rowLabel, type TextKey } from "../i18n/text.ts";

// 活动栏容器现在只回答一个问题：怎么把面板打开，以及还没配好的项目从哪儿开始。
// 它不再是一棵重复面板内容的树——同一条信息在同一个窗口里有两个说法，迟早会互相
// 矛盾，而面板才是那个说得全（并且与参考图一致）的地方。
//
// 它上面的字也出自词表：这几行先于一切出现在窗口里，而只有宿主知道编辑器用的是哪种
// 语言。标签走 rowLabel（中文编辑器里「Open Dashboard · 打开面板」），提示语走 both
// （悬停里两半都在，与这一行下面那句原本的做法一致）。

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
    // 语言在画这一行的时候读：编辑器换了语言，活动栏跟着换，不需要谁记得去刷新它。
    const language = vscode.env.language;
    const open = vscode.workspace.workspaceFolders !== undefined && vscode.workspace.workspaceFolders.length > 0;
    const items: vscode.TreeItem[] = [item(language, "launcher.dashboard", "avenic.dashboard.open", "window", "launcher.dashboard-note")];
    // 这一行只在没有文件夹时画得出来，所以它的 tooltip 不能再许一个点不到的东西：
    // 说的是先打开一个文件夹。悬停里两半都在，点击后的提示只说用户那一种语言。
    if (!open) {
      items.push(item(language, "launcher.configure", "avenic.agents.configureProject", "settings-gear", "agents.configure-nofolder"));
    }
    items.push(item(language, "nav.sessions", "avenic.sessions.open", "history", "launcher.sessions-note"));
    items.push(item(language, "launcher.skills", "avenic.skills.installPacks", "package", "launcher.skills-note"));
    return items;
  }
}

// 一行的三个字各有各的读者：标签是用户在树里读的（跟着语言），提示语悬停时两半都在，
// 而 command.title 是命令自己的名字——宿主把命令名写成英文（清单里那一份也是），
// 所以它取词表的英文那一半，与用户点的那一行是同一个词。
function item(language: string, labelKey: TextKey, command: string, icon: string, tooltipKey: TextKey): vscode.TreeItem {
  const node = new vscode.TreeItem(rowLabel(language, labelKey), vscode.TreeItemCollapsibleState.None);
  node.iconPath = new vscode.ThemeIcon(icon);
  node.tooltip = both(tooltipKey);
  node.command = { command, title: en(labelKey) };
  return node;
}
