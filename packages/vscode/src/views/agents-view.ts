import * as vscode from "vscode";
import { agentStatus, listAgents } from "../services/agents.ts";
import { agentsToViewModels, type AgentRowState } from "./view-models.ts";

// 行状态 → contextValue（菜单 when 子句按此区分键位）：active/inactive 保持历史命名，
// 新增 bootstrap（未初始化+缺 CLI）/ missing（已初始化+缺 CLI）/ update（可升级）
const CONTEXT_BY_STATE: Record<AgentRowState, string> = {
  active: "agent",
  update: "agent-update",
  inactive: "agent-inactive",
  bootstrap: "agent-bootstrap",
  missing: "agent-missing",
};

export class AgentsViewProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly emitter = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  constructor(private readonly projectRoot: () => string | null) {}

  refresh(): void { this.emitter.fire(undefined); }

  getTreeItem(item: vscode.TreeItem): vscode.TreeItem { return item; }

  async getChildren(): Promise<vscode.TreeItem[]> {
    const root = this.projectRoot();
    if (root === null) return [new vscode.TreeItem("打开项目文件夹", vscode.TreeItemCollapsibleState.None)];
    const statuses = await Promise.all(listAgents().map((a) => agentStatus(root, a.id)));
    if (statuses.every((status) => status.effective === null)) {
      const setup = new vscode.TreeItem("Avenic is not initialized for this project", vscode.TreeItemCollapsibleState.None);
      setup.description = "Initialize Avenic";
      setup.command = { command: "avenic.agents.configureProject", title: "Initialize Avenic" };
      setup.iconPath = new vscode.ThemeIcon("rocket");
      return [setup];
    }
    return agentsToViewModels(statuses).map((m) => {
      const item = new vscode.TreeItem(m.label, vscode.TreeItemCollapsibleState.None);
      item.id = m.id; // T7 上下文菜单命令经 treeItem.id 取 agent
      item.description = m.description;
      item.tooltip = m.tooltip;
      item.contextValue = CONTEXT_BY_STATE[m.state];
      item.iconPath = new vscode.ThemeIcon(m.iconHint);
      return item;
    });
  }
}
