import * as vscode from "vscode";
import { readSkillsSnapshot } from "../services/skills.ts";
import { GLOBAL_EMPTY_HINT, PROJECT_EMPTY_HINT, skillsToViewModels, type SkillsViewGroup, type SkillsViewItem } from "./view-models.ts";
import { measurePerformance } from "../ui/performance.ts";

export class SkillsViewProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly emitter = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  // 分组节点 → 子节点；每次根级 getChildren 重建，map 同时清空，无跨 refresh 缓存
  private readonly scopeChildren = new Map<vscode.TreeItem, vscode.TreeItem[]>();
  constructor(private readonly projectRoot: () => string | null) {}

  refresh(): void { this.emitter.fire(undefined); }

  getTreeItem(item: vscode.TreeItem): vscode.TreeItem { return item; }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (element !== undefined) return this.scopeChildren.get(element) ?? [];
    this.scopeChildren.clear();
    const root = this.projectRoot();
    // 全局作用域组与项目根无关（零工作区窗口仍有全局 Skills）；项目组无根时不读项目状态（避免落到 process.cwd 域），直接显示提示行
    // 未托管检测（detected）同样只读磁盘：项目组无根时跳过扫描，全局组恒扫描；
    // Pack 层次（installedPackLayers）恒走本地缓存零网络，未缓存时视图内回退合并来源行。
    const [project, global] = await measurePerformance("skills-view.root", () => Promise.all([
      root === null ? null : readSkillsSnapshot("project", root),
      readSkillsSnapshot("global"),
    ]));
    const projectNode = new vscode.TreeItem("项目作用域", vscode.TreeItemCollapsibleState.Expanded);
    const globalNode = new vscode.TreeItem("全局作用域", vscode.TreeItemCollapsibleState.Expanded);
    this.scopeChildren.set(projectNode, this.fromViewModels(skillsToViewModels(project?.status ?? null, project?.detected ?? [], PROJECT_EMPTY_HINT, project?.layers ?? []), "project"));
    this.scopeChildren.set(globalNode, this.fromViewModels(skillsToViewModels(global.status, global.detected, GLOBAL_EMPTY_HINT, global.layers), "global"));
    return [projectNode, globalNode];
  }

  private fromViewModels(groups: SkillsViewGroup[], scope: "project" | "global"): vscode.TreeItem[] {
    return groups.map((group) => this.buildItem({ ...group.item, children: group.children }, scope));
  }

  // 递归树构建：Pack → source → Skill；检测/托管行是叶子（携带命令键位与 scope）
  private buildItem(model: SkillsViewItem, scope: "project" | "global"): vscode.TreeItem {
    const item = new vscode.TreeItem(
      model.label,
      model.children !== undefined ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
    );
    item.description = model.description;
    item.contextValue = model.kind; // T9 命令菜单 when 绑定按 group/pack/source/skill/adopted/detected 分类
    item.iconPath = new vscode.ThemeIcon(model.iconHint);
    this.attachScope(item, scope); // 检测/托管/Pack 行携带所属作用域：菜单键直传 scope，免再问
    if (model.kind === "pack") {
      (item as vscode.TreeItem & { avenicPackId?: string }).avenicPackId = model.id;
    }
    if (model.children !== undefined) {
      this.scopeChildren.set(item, model.children.map((child) => this.buildItem(child, scope)));
    }
    return item;
  }

  // TreeItem.scope 是 VS Code 保留 API 属性（TreeItemScope），选 avanicScope 自定义名承载
  private attachScope(item: vscode.TreeItem, scope: "project" | "global"): void {
    if (item.contextValue === "detected" || item.contextValue === "adopted" || item.contextValue === "pack") {
      (item as vscode.TreeItem & { avenicScope?: string }).avenicScope = scope;
    }
  }
}
