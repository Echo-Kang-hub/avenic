import { existsSync } from "node:fs";
import path from "node:path";
import { buildCatalog, cachedCatalog, defaultCatalogFile, ensureCatalog, hubSyncSummary, loadDefaultCatalogSpec, loadKnownCatalogs, loadPacks, loadSources, registerCatalog, resolvePack, setDefaultCatalogSpec } from "@avenic/core";
import type { CatalogInfo, KnownCatalogEntry, Pack, ProcessEnvLike, Source } from "@avenic/core";

export async function defaultSpec(environment = process.env): Promise<string | null> {
  const explicitEnvSpec = environment.AVENIC_CATALOG_SPEC || environment.AGENTHOME_CATALOG_SPEC;
  if (!explicitEnvSpec && !existsSync(defaultCatalogFile(environment))) {
    return null; // 未配置默认 → null（视图显示「未选择」）
  }
  try { return await loadDefaultCatalogSpec(environment); }
  catch { return null; }
}

export function listKnown(environment = process.env): Promise<KnownCatalogEntry[]> {
  return loadKnownCatalogs(environment);
}

export function add(spec: string, environment = process.env) {
  return registerCatalog(spec, { environment }); // previewFailed 或 catalogInfo + packs
}

export function select(spec: string, environment = process.env): Promise<unknown> {
  return setDefaultCatalogSpec(environment, spec);
}

export function sync(spec: string, environment = process.env): Promise<CatalogInfo> {
  return ensureCatalog(spec, { environment });
}

// 同步结果统一由 core 措辞：「Synced · <short sha> · <时间>」，与 CLI 逐字一致。
export function syncSummary(info: CatalogInfo): string {
  return hubSyncSummary(info);
}

// 读取「本地缓存 Catalog」的修订（Overview「修订」行）：零网络。规则在 core 里
// （cachedCatalog），面板和 CLI 用同一份判断——「什么算缓存里有」不该有第二种说法。
// 缓存缺失（未同步过）返回 null，调用方降级为「—」占位符。
export async function cachedRevision(_cwd: string, environment: ProcessEnvLike = process.env): Promise<string | null> {
  try {
    const spec = await loadDefaultCatalogSpec(environment);
    return (await cachedCatalog(spec, environment))?.revision ?? null;
  } catch {
    return null;
  }
}

// Catalog 树只读预览的缓存根优先路径：缓存里有能读的内容树就直接用它；
// 否则经 ensureCatalog（git fetch）取最新——语义等同「展开即同步一次」。任何错误返回 null。
// cachedOnly：Installed Packs 层次展示必须零网络（视图每次加载都走），未缓存 → null，
// 调用方回退为扁平来源行，绝不在加载时触发 fetch。
async function catalogRootFor(spec: string, environment: ProcessEnvLike, options: { cachedOnly?: boolean } = {}): Promise<string | null> {
  const cached = await cachedCatalog(spec, environment);
  if (cached) return cached.catalogRoot;
  if (options.cachedOnly === true) return null;
  try {
    const info = await ensureCatalog(spec, { environment });
    return info.catalogRoot;
  } catch {
    return null;
  }
}

export async function packsFor(spec: string, environment = process.env, options: { cachedOnly?: boolean } = {}): Promise<Map<string, Pack> | null> {
  const root = await catalogRootFor(spec, environment, options);
  if (root === null) return null;
  try { return await loadPacks(root); }
  catch { return null; }
}

// Pack 的源码层次（Cache-first，无网络）：loadSources + buildCatalog + resolvePack，
// 输出按 pack.sources 顺序的 group（source 元数据 + 该来源下的 Skill 名）。任一环节
// 失败（离线无缓存、Pack 引用损坏）返回 null，视图回退为扁平 Skill 列表。
// cachedOnly：Installed Packs 层次展示（packRow 行）用——未缓存直接 null，绝不 fetch。
export interface PackStructure {
  id: string;
  name: string;
  groups: Array<{ source: Source; skills: Array<{ name: string; directory: string }> }>;
  names: string[];
}
export async function packStructure(spec: string, packId: string, environment = process.env, options: { cachedOnly?: boolean } = {}): Promise<PackStructure | null> {
  const root = await catalogRootFor(spec, environment, options);
  if (root === null) return null;
  try {
    const sourceConfig = await loadSources(root);
    const catalog = await buildCatalog(sourceConfig, path.join(root, "skills"));
    const packs = await loadPacks(root);
    const pack = packs.get(packId);
    if (pack === undefined) return null;
    const resolved = resolvePack(catalog, sourceConfig, pack);
    return {
      id: pack.id,
      name: pack.name,
      groups: resolved.groups.map((group) => ({
        source: group.source,
        skills: group.skills.map((skill) => ({ name: skill.name, directory: skill.directory })),
      })),
      names: resolved.names,
    };
  } catch {
    return null;
  }
}
