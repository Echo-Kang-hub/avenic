import { unmanagedSkillNames, type InstallStatus, type KnownCatalogEntry, type Pack } from "@avenic/core";
import type { AgentStatus } from "../services/agents.ts";

// 行状态驱动菜单键位（icons 键，无文字按钮）：
//   bootstrap=未初始化+CLI 缺失（安装/初始化）；inactive=未初始化（初始化）；
//   missing=已初始化+CLI 缺失（安装/移除）；update=可升级（启动/升级/移除）；
//   active=正常（启动/移除）
export type AgentRowState = "bootstrap" | "inactive" | "missing" | "update" | "active";
export interface AgentViewItem { id: string; label: string; description: string; tooltip: string; iconHint: string; active: boolean; state: AgentRowState; }

export function agentsToViewModels(statuses: AgentStatus[]): AgentViewItem[] {
  return statuses.map(({ agent, executableAvailable, effective, cli }) => {
    const initialized = effective !== null;
    const state: AgentRowState = !initialized
      ? executableAvailable ? "inactive" : "bootstrap"
      : executableAvailable ? (cli.updateAvailable ? "update" : "active") : "missing";
    const version = cli.installed ? `v${cli.installed}` : null;
    const description = !initialized
      ? executableAvailable ? "未初始化" : "未初始化 · CLI 未安装"
      : !executableAvailable
        ? "已初始化 · CLI 未安装"
        : cli.updateAvailable
          ? `已初始化 · v${cli.installed} → v${cli.latest}`
          : version
            ? `已初始化 · ${version}`
            : "已初始化";
    const tooltip = [
      `${agent.executable} · CLI ${executableAvailable ? "可用" : "不可用"}`,
      cli.updateAvailable ? `v${cli.installed} → v${cli.latest}` : version ?? "",
      effective ? `auth: ${effective.auth}, sessions: ${effective.sessions}` : "未初始化",
    ].filter(Boolean).join(" · ");
    return {
      id: agent.id,
      label: agent.displayName,
      description,
      tooltip,
      iconHint: effective ? "pass-filled" : "circle-outline",
      active: effective !== null,
      state,
    };
  });
}

export interface CatalogViewItem { kind: "current" | "entry"; label: string; description: string; }
export function catalogToViewModels(defaultSpec: string | null, known: KnownCatalogEntry[]): CatalogViewItem[] {
  const current = known.find((k) => k.spec === defaultSpec);
  const first = [] as CatalogViewItem[];
  if (defaultSpec) first.push({ kind: "current", label: defaultSpec, description: current?.name ?? "" });
  return first.concat(known.filter((k) => k.spec !== defaultSpec).map((k) => ({ kind: "entry", label: k.spec, description: k.name })));
}

// Catalog 树子级行：pack（可展开）/ source（分组，可再展开）/ skill / hint（未缓存提示）
export interface CatalogChildItem { kind: "pack" | "source" | "skill" | "hint"; label: string; description: string; iconHint: string; id?: string; }

export function catalogPacksToViewModels(packs: Pack[]): CatalogChildItem[] {
  return [...packs].sort((a, b) => a.id.localeCompare(b.id)).map((pack) => ({
    kind: "pack",
    label: pack.name,
    description: pack.description ?? pack.id,
    iconHint: "package",
    id: pack.id,
  }));
}

// Pack 的源码分组行（层次来自 packStructure 的 resolvePack 结果）：保持 pack.sources 顺序，
// 每来源一行（label 用来源 name，缺省回退 id），描述为该来源下的 Skill 数。
export interface CatalogSourceGroupModel { label: string; description: string; sourceId: string; skills: string[]; }
export function catalogSourceGroupsToViewModels(structure: { groups: Array<{ source: { id: string; name?: string }; skills: Array<{ name: string }> }> }): CatalogSourceGroupModel[] {
  return structure.groups.map((group) => ({
    label: group.source.name ?? group.source.id,
    description: `${group.skills.length} 个 Skill`,
    sourceId: group.source.id,
    skills: group.skills.map((skill) => skill.name),
  }));
}

// Pack → Skill 行（离线/无层次时的扁平回退）：保持 pack.sources 顺序，同名 Skill 只出现一次
export function catalogPackSkillsToViewModels(pack: Pack): CatalogChildItem[] {
  const seen = new Set<string>();
  return pack.sources.flatMap((source) =>
    source.skills
      .filter((name) => (seen.has(name) ? false : (seen.add(name), true)))
      .map((name) => ({ kind: "skill", label: name, description: source.source, iconHint: "file", id: name })),
  );
}

export interface SkillsViewItem {
  kind: "group" | "pack" | "source" | "skill" | "direct" | "adopted" | "detected";
  label: string;
  description: string;
  iconHint: string;
  // pack 行的包 id（行级「卸载/重装 Pack」键位经此定位包）；仅 pack 行携带
  id?: string;
  // 子行（递归）：pack 行 → source 行 → Skill 行；detected/adopted 行无子级（叶子带命令键位）
  children?: SkillsViewItem[];
}
// 树形分组：item 为主行，children 为可展开的子行
export interface SkillsViewGroup { item: SkillsViewItem; children?: SkillsViewItem[]; }
// 空态提示按作用域区分：项目组保留项目味提示；全局组不得含项目根引用（零工作区窗口也成立）
export const PROJECT_EMPTY_HINT = "打开一个新项目根后安装 Pack";
export const GLOBAL_EMPTY_HINT = "全局域 Pack 请从命令面板安装";

// Installed Packs 层次（installedPackLayers 的输出，结构性声明避免 services 依赖环）：
// 每个 Pack 一行，其下是 pack.sources 定义的来源分组（来源名 → Skill 列表）。
export interface InstalledPackLayerView {
  packId: string;
  packName: string;
  groups: Array<{ sourceId: string; sourceName: string; skills: string[] }>;
}

// Pack 层子行：Pack 行 → 来源行 → Skill 行。仅显示磁盘上真实存在的 Skill（与 status.names
// 求交——缓存 Catalog 可能领先/滞后于安装，不得展示未安装的内容）；不在任何 Pack 层内的
// 托管名缀为 adopted 行（「识别为 Pack 接管」候选）。layers 为空（未缓存/无 Pack 记录）
// 返回 null，调用方回退为锁文件合并的来源行。
function packLayerRows(layers: InstalledPackLayerView[], installed: Set<string>): SkillsViewItem[] | null {
  if (layers.length === 0) return null;
  const covered = new Set<string>();
  const packRows = layers.map((layer) => {
    const groups: SkillsViewItem[] = [];
    for (const group of layer.groups) {
      const present = group.skills.filter((name) => installed.has(name));
      if (present.length === 0) continue;
      present.forEach((name) => covered.add(name));
      groups.push({
        kind: "source",
        label: group.sourceName,
        description: `${present.length} 个 Skill`,
        iconHint: "repo",
        children: present.map((name) => ({ kind: "skill", label: name, description: group.sourceId, iconHint: "file" })),
      });
    }
    const total = groups.reduce((sum, group) => sum + (group.children?.length ?? 0), 0);
    return {
      kind: "pack" as const,
      label: layer.packName,
      description: `${total} 个 Skill`,
      iconHint: "package" as const,
      id: layer.packId,
      children: groups,
    };
  });
  const adoptedRows = [...installed].filter((name) => !covered.has(name)).map((name) => ({
    kind: "adopted" as const, label: name, description: "已托管 · 无 Pack 记录", iconHint: "file" as const,
  }));
  return [...packRows, ...adoptedRows];
}

export function skillsToViewModels(status: InstallStatus | null, detected: string[] = [], emptyHint: string = PROJECT_EMPTY_HINT, layers: InstalledPackLayerView[] = []): SkillsViewGroup[] {
  // 磁盘检测（core detectedSkillNames）减去受管集合 = 未托管内容（旧版/外部工具安装、
  // 手工拷贝）。减法在 core（unmanagedSkillNames）：受管集合比展示用 names 多出直装名，
  // 自己减会把 Avenic 直装的技能报成「未托管」。
  const untracked = unmanagedSkillNames(status, detected);
  const managed = status === null ? [] : status.names;
  const groups: SkillsViewGroup[] = [];
  if (untracked.length > 0) {
    groups.push({
      item: {
        kind: "detected",
        label: `检测到 ${untracked.length} 个 Skill（未托管）`,
        description: "磁盘存在但无 Avenic 管理记录；重新安装 Packs 或直装 Skill 会接管",
        iconHint: "info",
      },
      children: untracked.map((name) => ({ kind: "detected", label: name, description: "未托管", iconHint: "file" })),
    });
  }
  if (status === null) {
    // 矛盾修复：已有「未托管检测」行时不再叠加「尚未安装」空态——两者并存互相矛盾
    //（未托管检测本身就是「尚未安装管理」的证据，空态只应出现在真正一无所有时）。
    if (untracked.length === 0) {
      groups.push({ item: { kind: "group", label: "尚未安装 Skills", description: emptyHint, iconHint: "info" } });
    }
    return groups;
  }
  const installed = new Set(managed);
  // Installed Packs 子级：Pack → source → Skill（层次来自本地缓存 Catalog 的 pack.sources）；
  // 无层次（未缓存）时回退为锁文件合并的来源行。两种形态都把"仅托管无 Pack 记录"的名缀为
  // adopted 行——正是「识别为 Pack 接管」的候选（行级键位 avenic.skills.adoptPack）。
  const children: SkillsViewItem[] = packLayerRows(layers, installed) ?? (() => {
    const covered = new Set<string>();
    const rows = status.groups.map((group): SkillsViewItem => {
      group.skills.forEach((skill) => covered.add(skill.name));
      return {
        kind: "source",
        label: group.source.name ?? group.source.id,
        description: `${group.skills.length} 个 Skill`,
        iconHint: "repo",
        children: group.skills.map((skill) => ({
          kind: "skill" as const,
          label: skill.name,
          description: group.source.id,
          iconHint: "file" as const,
        })),
      };
    });
    return rows.concat(
      status.names
        .filter((name) => !covered.has(name))
        .map((name): SkillsViewItem => ({ kind: "adopted", label: name, description: "已托管 · 无 Pack 记录", iconHint: "file" })),
    );
  })();
  // 安装目标完成度并入 Installed Packs 描述（原「完整性」分组是对用户无意义的内部术语，已移除）
  const complete = status.targets.filter((t) => t.complete).length;
  groups.push(
    {
      item: { kind: "group", label: "Installed Packs", description: `${status.names.length} 个 Skill / ${status.packs.length} 个 Pack · 安装目标 ${complete}/${status.targets.length}`, iconHint: "package" },
      children,
    },
    { item: { kind: "group", label: "Hub Packs", description: `${status.packs.length} 个 Pack / ${status.groups.length} 个分组`, iconHint: "repo" } },
  );
  return groups;
}
