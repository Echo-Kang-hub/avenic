import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  addDirectSkills,
  adoptPackedSkills as coreAdoptPackedSkills,
  adoptSkills as coreAdoptSkills,
  canonicalTargets,
  createInstallContext,
  detectedSkillNames as coreDetectedSkillNames,
  discoverDirectSkills as coreDiscoverDirectSkills,
  ensureSkillLinks as coreEnsureSkillLinks,
  installPacks as coreInstallPacks,
  installedPackIds as coreInstalledPackIds,
  loadPacks,
  managedSkillNames as coreManagedSkillNames,
  planAdoptSkills,
  readDirectState,
  removeExternalSkills,
  resolveInstallSource,
  skillsInstallationStatus,
  uninstallPacks as coreUninstallPacks,
  type AdoptPackCandidate,
  type InstallContext,
  type InstallStatus,
  type Pack,
  type ProcessEnvLike,
} from "@avenic/core";
import { defaultSpec, packStructure } from "./catalog.ts";

export type Scope = "project" | "global";
type Env = ProcessEnvLike;

export interface SkillsSnapshot {
  status: InstallStatus | null;
  detected: string[];
  layers: InstalledPackLayer[];
}

// A refresh generation is the only in-memory cache for view data. It shares
// the same disk reads between the Skills tree and Overview, then is discarded
// after a mutation refresh so services never become an independent state store.
let snapshots = new WeakMap<object, Map<string, Promise<SkillsSnapshot>>>();

function snapshotKey(scope: Scope, cwd?: string): string {
  return `${scope}:${cwd ?? ""}`;
}

export function invalidateSkillsSnapshot(): void {
  snapshots = new WeakMap();
}

function context(scope: Scope, cwd: string | undefined, environment: Env): InstallContext {
  return createInstallContext(scope === "global", { cwd, environment });
}

export function status(scope: Scope, cwd?: string, environment: Env = process.env): Promise<InstallStatus | null> {
  return skillsInstallationStatus(context(scope, cwd, environment));
}

export function installedPackIds(scope: Scope, cwd?: string, environment: Env = process.env): Promise<string[] | null> {
  return coreInstalledPackIds(context(scope, cwd, environment));
}

export function detected(scope: Scope, cwd?: string, environment: Env = process.env): Promise<string[]> {
  return coreDetectedSkillNames(context(scope, cwd, environment));
}

export function adopt(scope: Scope, names: string[], cwd?: string, environment: Env = process.env) {
  return coreAdoptSkills(context(scope, cwd, environment), names);
}

// Pack 识别计划（只读）：core 对磁盘 Skill 的覆盖度核算；Catalog 错误 → 空计划，调用方回退普通托管。
export function planAdopt(scope: Scope, names: string[], cwd?: string, environment: Env = process.env): Promise<{ candidates: AdoptPackCandidate[]; best: AdoptPackCandidate | null }> {
  return planAdoptSkills(context(scope, cwd, environment), names);
}

// 识别为指定 Pack 接管：补全缺失 Skill + 写入完整 Pack 元数据（保留先前托管记录）。
export function adoptPacked(scope: Scope, names: string[], packId: string, cwd?: string, environment: Env = process.env) {
  return coreAdoptPackedSkills(context(scope, cwd, environment), names, packId);
}

// 已托管但未关联任何 Pack 记录的 Skill 名（旧版包残留 → adopt 进 lock.adopted 的场景）：
// status.names 去掉 source 分组覆盖的部分。驱动「识别为 Pack」行级键位。
export async function adoptedOnlyNames(scope: Scope, cwd?: string, environment: Env = process.env): Promise<string[]> {
  const current = await skillsInstallationStatus(context(scope, cwd, environment));
  if (current === null) return [];
  const covered = new Set(current.groups.flatMap((group) => group.skills.map((skill) => skill.name)));
  return current.names.filter((name) => !covered.has(name));
}

// Installed Packs 的层次化结构（Pack → source → Skill）：对每个已托管 Pack id（config.packs）
// 走 packStructure(cachedOnly) 从 「本地缓存 Catalog」还原 pack.sources 层次——零网络。
// 未缓存/无效 Pack 跳过（视图回退为合并的来源行）；任何错误降级为空数组。
export interface InstalledPackLayer {
  packId: string;
  packName: string;
  groups: Array<{ sourceId: string; sourceName: string; skills: string[] }>;
}
export async function installedPackLayers(scope: Scope, cwd?: string, environment: Env = process.env): Promise<InstalledPackLayer[]> {
  try {
    const spec = await defaultSpec(environment);
    if (spec === null) return [];
    const ids = await coreInstalledPackIds(context(scope, cwd, environment));
    if (ids === null) return [];
    const layers: InstalledPackLayer[] = [];
    for (const packId of [...ids].sort()) {
      const structure = await packStructure(spec, packId, environment, { cachedOnly: true });
      if (structure === null) continue;
      layers.push({
        packId: structure.id,
        packName: structure.name,
        groups: structure.groups.map((group) => ({
          sourceId: group.source.id,
          sourceName: group.source.name ?? group.source.id,
          skills: group.skills.map((skill) => skill.name),
        })),
      });
    }
    return layers;
  } catch {
    return [];
  }
}

// A skill row wants one thing core's status model does not carry: the sentence
// the skill writes about itself. It is read from the skill's own directory —
// the path core resolved, never one the plugin guessed — and whatever is not
// there is reported as absent rather than invented.
export async function describeSkill(directory: string): Promise<string | null> {
  try {
    const head = (await readFile(path.join(directory, "SKILL.md"), "utf8")).slice(0, 4_096);
    const frontmatter = head.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const line = (frontmatter ? frontmatter[1] : head).match(/^description:\s*(.+)$/m);
    return line === null ? null : line[1].trim().replace(/^["']|["']$/g, "");
  } catch {
    return null;
  }
}

export function readSkillsSnapshot(scope: Scope, cwd?: string, environment: Env = process.env): Promise<SkillsSnapshot> {
  const envKey = environment as object;
  let byScope = snapshots.get(envKey);
  if (byScope === undefined) {
    byScope = new Map();
    snapshots.set(envKey, byScope);
  }
  const key = snapshotKey(scope, cwd);
  let snapshot = byScope.get(key);
  if (snapshot === undefined) {
    snapshot = Promise.all([
      status(scope, cwd, environment),
      detected(scope, cwd, environment),
      installedPackLayers(scope, cwd, environment),
    ]).then(([current, names, layers]) => ({ status: current, detected: names, layers }));
    byScope.set(key, snapshot);
  }
  return snapshot;
}

export async function availablePacks(scope: Scope, cwd?: string, environment: Env = process.env): Promise<Map<string, Pack>> {
  const info = await resolveInstallSource({ global: scope === "global", cwd, environment });
  return loadPacks(info.catalogRoot);
}

export function installPacks(scope: Scope, packIds: string[], cwd?: string, environment: Env = process.env) {
  return coreInstallPacks(context(scope, cwd, environment), packIds);
}

export function uninstallPacks(scope: Scope, packIds: string[], cwd?: string, environment: Env = process.env) {
  return coreUninstallPacks(context(scope, cwd, environment), packIds);
}

export function directSkills(scope: Scope, cwd?: string, environment: Env = process.env) {
  return readDirectState(context(scope, cwd, environment));
}

export function addDirect(scope: Scope, repo: string, skillNames: string[], cwd?: string, environment: Env = process.env) {
  return addDirectSkills(context(scope, cwd, environment), repo, skillNames);
}

export function removeDirect(scope: Scope, names: string[], cwd?: string, environment: Env = process.env): Promise<string[]> {
  return removeExternalSkills(context(scope, cwd, environment), names).then((r) => r.directRemoved);
}

// ---- Add 流程的四个问句 ----
// 面板上的 Import Skill 与 CLI 的 Add 走的是同一个顺序：来源 → 发现 → 多选 →
// Install to → Scope → 确认。这里把它要问 core 的四件事各包一层，全部照抄 core 的答案
// （作用域名字、目标清单、发现结果），插件不自己算一份。

/** 一个落链目标，用用户看得懂的路径说它把 Skill 放到哪。 */
export interface ImportTarget {
  id: string;
  label: string;
  /** 相对作用域根、用 `/` 分隔（两个作用域下的相对路径相同，所以提示不必先问 Scope）。 */
  path: string;
  /** 真身目标：core 无条件把 Skill 写进去，其余目标链接到它。 */
  canonical: boolean;
}

export interface ScopeFacts {
  scope: Scope;
  label: string;
  root: string;
  configFile: string;
  targets: ImportTarget[];
}

export interface DirectDiscovery {
  sourceId: string;
  revision: string;
  names: string[];
}

export interface DirectInstall {
  names: string[];
  sourceId: string;
  revision: string;
  alreadyInstalled?: boolean;
}

/** 发现与安装作用域内的一个直装源；每一次调用都带着 scope，因为 Scope 是在流程中间才问的。 */
export interface SkillImport {
  discover(repo: string, scope: Scope): Promise<DirectDiscovery>;
  /** 这个作用域已经受管的 Skill 名（Pack、接管、直装都在内）。 */
  managed(scope: Scope): Promise<string[]>;
  facts(scope: Scope): Promise<ScopeFacts>;
  install(repo: string, names: string[], scope: Scope, targets: string[]): Promise<DirectInstall>;
}

function displayPath(root: string, destination: string): string {
  const relative = path.relative(root, destination);
  const display = relative === "" || relative.startsWith("..") || path.isAbsolute(relative) ? destination : relative;
  return display.split(path.sep).join("/");
}

async function scopeFacts(scope: Scope, cwd?: string, environment: Env = process.env): Promise<ScopeFacts> {
  const installContext = context(scope, cwd, environment);
  // 哪几个是真身目标由 core 说了算（canonicalTargets），插件不自己再判一次。
  const canonical = new Set(canonicalTargets(installContext).map((target) => target.id));
  return {
    scope,
    label: installContext.label,
    root: installContext.root,
    configFile: installContext.configFile,
    targets: installContext.targets.map((target) => ({
      id: target.id,
      label: target.label,
      path: displayPath(installContext.root, target.destination),
      canonical: canonical.has(target.id),
    })),
  };
}

export function importService(root: string, environment: Env = process.env): SkillImport {
  // 全局操作绝不带项目根（与 scopeCwd 同一条决议）：core 的全局上下文本来就不看 cwd。
  const cwd = (scope: Scope) => (scope === "global" ? undefined : root);
  return {
    discover: (repo, scope) => coreDiscoverDirectSkills(context(scope, cwd(scope), environment), repo),
    managed: async (scope) => [...await coreManagedSkillNames(context(scope, cwd(scope), environment))],
    facts: (scope) => scopeFacts(scope, cwd(scope), environment),
    install: (repo, names, scope, targets) => addDirectSkills(context(scope, cwd(scope), environment), repo, names, { targets }),
  };
}

// 启动/手动补齐共享链接：只处理 lock 记录的受管技能，插件侧不做任何 fs 判断。
export async function repairLinks(scope: Scope, cwd?: string, environment: Env = process.env) {
  const installContext = context(scope, cwd, environment);
  const managed = await coreManagedSkillNames(installContext);
  if (managed.size === 0) {
    return { counts: { linked: 0, repaired: 0, migrated: 0, fallback: 0, conflict: 0, unchanged: 0, skipped: 0 }, conflicts: [], targets: {} };
  }
  return coreEnsureSkillLinks(installContext, managed, { silent: true });
}
