import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fail } from "../util/fail.mjs";
import { isInside, removeEmptyDirectory } from "../util/fs.mjs";
import { readJson, writeJson } from "../util/json.mjs";
import { ensureCatalog, loadDefaultCatalogSpec, parseCatalogSpec } from "./catalog.mjs";
import { assertSafeId, assertSafeSkillName } from "./ids.mjs";
import {
  canonicalTargets,
  classifyShareEntry,
  ensureSkillLinks,
  formatLinkSummary,
  linkTargetPreference,
  logConflicts,
  removeLinkSafely,
  shareTargets,
} from "./links.mjs";
import { loadPacks, resolvePack, resolvePacks } from "./packs.mjs";
import { buildCatalog, loadSources } from "./sources.mjs";
import { normalizePackIds, parsePackArguments } from "./packs.mjs";
import {
  GLOBAL_TARGETS,
  LEGACY_PROFILE_FILE,
  MANAGED_AGENT_ORDER,
  PROJECT_CONFIG_FILE,
  PROJECT_LOCK_FILE,
  PROJECT_TARGETS,
  catalogLayout,
  globalConfigFile,
  globalLockFile,
  migrateLegacyProjectFiles,
} from "./paths.mjs";

export function isCatalogDirectory(directory) {
  const layout = catalogLayout(directory);
  return existsSync(layout.sourcesFile) && existsSync(layout.skills) && existsSync(layout.packs);
}

// 解析 shareFrom → shareDestination（同表内另一个 target 的绝对目录）。
// 解析失败直接 fail：表写错是开发期错误，不能静默降级成"每个 target 各存一份"。
function withShareDestinations(targets, label) {
  const byId = new Map(targets.map((target) => [target.id, target]));
  return targets.map((target) => {
    if (!target.shareFrom) {
      return target;
    }
    const canonical = byId.get(target.shareFrom);
    if (!canonical?.destination) {
      fail(`${label} skill target "${target.id}" references an unknown share source "${target.shareFrom}"`);
    }
    return { ...target, shareDestination: canonical.destination };
  });
}

export function createInstallContext(global, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const environment = options.environment ?? process.env;
  if (global) {
    return {
      configFile: globalConfigFile(environment),
      environment,
      global: true,
      label: "Global",
      lockFile: globalLockFile(environment),
      root: environment.USERPROFILE || environment.HOME || os.homedir(),
      targets: withShareDestinations(GLOBAL_TARGETS, "Global"),
    };
  }
  // Hosts that only read the install state pass migrate: false. Renaming a
  // legacy file is a repair the user asked for by running a command that
  // changes the project, not a side effect of looking at one.
  if (options.migrate !== false) migrateLegacyProjectFiles(cwd);
  const projectTargets = PROJECT_TARGETS.map((target) => ({
    ...target,
    destination: path.join(cwd, ...target.relativePath),
  }));
  return {
    configFile: path.join(cwd, PROJECT_CONFIG_FILE),
    environment,
    global: false,
    label: "Project",
    legacyProfileFile: path.join(cwd, LEGACY_PROFILE_FILE),
    lockFile: path.join(cwd, PROJECT_LOCK_FILE),
    root: cwd,
    targets: withShareDestinations(projectTargets, "Project"),
  };
}

async function resolveInstallPacks(context, explicitPacks) {
  const requested = parsePackArguments(explicitPacks);
  if (requested.length > 0) {
    return normalizePackIds(requested);
  }
  if (existsSync(context.configFile)) {
    const config = await readJson(context.configFile);
    return normalizePackIds(config.packs ?? (config.pack ? [config.pack] : []));
  }
  if (context.legacyProfileFile && existsSync(context.legacyProfileFile)) {
    return normalizePackIds(
      parsePackArguments([(await readFile(context.legacyProfileFile, "utf8")).trim()]),
    );
  }
  return ["common"];
}

export async function previousManagedState(context) {
  if (!existsSync(context.lockFile)) {
    return new Map();
  }
  const manifest = await readJson(context.lockFile);
  const managed = new Map();
  for (const source of manifest.sources ?? []) {
    for (const skillName of source.skills ?? []) {
      managed.set(skillName, { sourceId: source.id, revision: source.revision });
    }
  }
  return managed;
}

// Avenic 受管的 Skill 名字全集：Pack 安装记录 + 接管记录 + 直装记录。
// 启动补齐只认这个集合，绝不枚举目录——`.agents/skills` 里手工放入的技能不归我们管。
export async function managedSkillNames(context) {
  const managed = new Set((await previousManagedState(context)).keys());
  if (!existsSync(context.lockFile)) {
    return managed;
  }
  const lock = await readJson(context.lockFile);
  for (const name of lock.adopted ?? []) {
    managed.add(name);
  }
  for (const source of lock.directSources ?? []) {
    for (const name of source.skills ?? []) {
      managed.add(name);
    }
  }
  return managed;
}

export async function installedPackIds(context) {
  if (existsSync(context.configFile)) {
    const config = await readJson(context.configFile);
    return normalizePackIds(config.packs ?? (config.pack ? [config.pack] : []));
  }
  if (existsSync(context.lockFile)) {
    const lock = await readJson(context.lockFile);
    return normalizePackIds(
      (lock.packs ?? (lock.pack ? [lock.pack] : [])).map((pack) => pack.id ?? pack),
    );
  }
  return null;
}

export async function writeInstallMetadata(context, resolvedPacks, catalogInfo = {}, options = {}) {
  const packageMetadata = catalogInfo.packageMetadata ?? null;
  const packageSpec = catalogInfo.spec ?? packageMetadata?.agentSkills?.packageSpec ?? packageMetadata?.repository?.url;
  const previousConfig = existsSync(context.configFile) ? await readJson(context.configFile) : {};
  const previousLock = existsSync(context.lockFile) ? await readJson(context.lockFile) : {};
  const config = {
    schemaVersion: 3,
    catalog: packageSpec,
    packs: resolvedPacks.packs.map((pack) => pack.id),
    ...(previousConfig.direct ? { direct: previousConfig.direct } : {}),
  };
  const lock = {
    schemaVersion: 3,
    packs: resolvedPacks.packs.map((pack) => ({
      id: pack.id,
      name: pack.name,
      description: pack.description ?? "",
    })),
    catalog: {
      spec: packageSpec,
      repository: catalogInfo.repository ?? null,
      revision: catalogInfo.revision ?? null,
    },
    ...(previousLock.directSources ? { directSources: previousLock.directSources } : {}),
    ...(previousLock.adopted ? { adopted: previousLock.adopted } : {}),
    // 用户勾过的落链目标（「Install to」）。记下来，卸载/更新才不会把技能重新
    // 链到一个他明确没勾的目标上。
    ...(Array.isArray(options.targets) ? { targets: options.targets } : {}),
    agents: [...MANAGED_AGENT_ORDER],
    sources: resolvedPacks.groups.map((group) => ({
      id: group.source.id,
      name: group.source.name,
      repository: group.source.repository,
      revision: group.source.revision,
      skills: group.skills.map((skill) => skill.name),
    })),
  };
  await mkdir(path.dirname(context.configFile), { recursive: true });
  await writeJson(context.configFile, config);
  await writeJson(context.lockFile, lock);
  if (context.legacyProfileFile && existsSync(context.legacyProfileFile)) {
    await rm(context.legacyProfileFile);
  }
}

// 四阶段安装里，动作可能发生在预检（旧副本迁移、失效链接修复）或补链（首次建链）任一趟：
// 预检迁移过的条目在补链趟已是正确链接（只记 unchanged），只看补链趟会把"本次迁移了 N 个"
// 印成 0。故动作计数（linked/repaired/migrated/fallback）两趟相加；冲突/跳过/未变是终态观测，
// 取补链趟，与随后 logConflicts 打印的冲突列表一致。
function mergeLinkCounts(preflight, final) {
  const merged = {
    linked: 0, migrated: 0, repaired: 0, fallback: 0, conflict: 0, unchanged: 0, skipped: 0,
    ...final,
  };
  for (const key of ["linked", "repaired", "migrated", "fallback"]) {
    merged[key] += preflight?.[key] ?? 0;
  }
  return merged;
}

export async function installCopies(context, resolvedPacks, io = console, options = {}) {
  const selectedSkills = resolvedPacks.groups.flatMap((group) => group.skills);
  const selectedNames = new Set(selectedSkills.map((skill) => skill.name));
  const previousState = await previousManagedState(context);
  // removeStale === false：接管类操作（adoptPackedSkills）不得按上一记录清理——那会误删
  // 其他来源（旧 Pack/直装）已托管的 Skill；仅覆盖式安装路径才允许陈旧清理。
  const staleNames = options.removeStale === false
    ? []
    : [...previousState.keys()].filter((name) => !selectedNames.has(name));
  // 预检覆盖"本次选中 + 上次受管"：陈旧技能也要先迁移，才能在 canonical 被删前用内容判定副本归属。
  const preflightNames = new Set([...previousState.keys(), ...selectedNames]);
  // createLink 透传（测试用于模拟 link-hostile 文件系统）；未提供时按 ensureSkillLinks 的默认建链。
  const createLink = options.createLink;
  // targets：这次安装要落链的 share target id（undefined = 全部）。真身始终写在
  // canonical target 上——那是唯一的存储，别的目标都是它的链接。
  const targets = options.targets ?? null;

  // 1) 预检 + 迁移：必须在 canonical 被改动之前。上次安装留下的 fallback 副本此刻与
  //    旧 canonical 内容一致 → 安全的迁移（删副本 + 建链）；先改 canonical 会把它误判成冲突。
  //    restoreCopy: false —— 这一趟建链失败时不得落拷贝：此刻真身还是旧版本，落了就把旧内容
  //    钉成 fallback 副本，补链趟会把它误判成"用户手改的冲突"，降级副本永远停在旧版本。
  const preflightResult = await ensureSkillLinks(context, preflightNames, {
    io,
    silent: true,
    restoreCopy: false,
    createLink,
    targets,
  });

  // 2) canonical 安装：只有非 shareFrom 的 target 落真身。
  for (const targetConfig of canonicalTargets(context)) {
    const destination = targetConfig.destination;
    await mkdir(destination, { recursive: true });
    const result = { added: 0, updated: 0, unchanged: 0, removed: 0 };
    for (const skill of selectedSkills) {
      const target = path.join(destination, skill.name);
      if (!isInside(destination, target)) {
        fail(`Install path escaped its target: ${target}`);
      }
      const previous = previousState.get(skill.name);
      if (
        existsSync(path.join(target, "SKILL.md")) &&
        previous?.sourceId === skill.source.id &&
        previous?.revision === skill.source.revision
      ) {
        result.unchanged += 1;
        continue;
      }
      const existed = existsSync(target);
      await rm(target, { recursive: true, force: true });
      await cp(skill.directory, target, { recursive: true });
      result[existed ? "updated" : "added"] += 1;
    }
    for (const staleName of staleNames) {
      assertSafeSkillName(staleName);
      const target = path.join(destination, staleName);
      if (!isInside(destination, target)) {
        fail(`Cleanup path escaped its target: ${target}`);
      }
      await rm(target, { recursive: true, force: true });
      result.removed += 1;
    }
    io.log(`✓ ${targetConfig.label}`);
    io.log(`  Path: ${destination}`);
    io.log(
      `  Added ${result.added} · Updated ${result.updated} · Unchanged ${result.unchanged} · Removed ${result.removed}`,
    );
  }

  // 3) 补链：为第 1 步时尚不存在的 canonical 建链（首次安装走这条）；建链失败在此降级拷贝，
  //    内容取自刚更新过的 canonical。
  const linkResult = await ensureSkillLinks(context, selectedNames, { io, silent: true, createLink, targets });

  // 4) shareFrom 陈旧清理：只解链，真身已在第 2 步删除。
  for (const targetConfig of shareTargets(context)) {
    if (targets && !targets.includes(targetConfig.id)) {
      continue;
    }
    await mkdir(targetConfig.destination, { recursive: true });
    let removed = 0;
    for (const staleName of staleNames) {
      assertSafeSkillName(staleName);
      const linkPath = path.join(targetConfig.destination, staleName);
      if (!isInside(targetConfig.destination, linkPath)) {
        fail(`Cleanup path escaped its target: ${linkPath}`);
      }
      if (await removeLinkSafely(linkPath)) {
        removed += 1;
      }
    }
    const targetCounts = mergeLinkCounts(
      preflightResult.targets[targetConfig.id],
      linkResult.targets[targetConfig.id],
    );
    io.log(`✓ ${targetConfig.label} (shared from ${targetConfig.shareFrom})`);
    io.log(`  Path: ${targetConfig.destination}`);
    io.log(`  ${formatLinkSummary(targetCounts)}${removed > 0 ? ` · Unlinked ${removed}` : ""}`);
  }
  logConflicts(io, linkResult.conflicts);
  return linkResult;
}

// 卸载/按名删除时的 shareFrom 处理：先解链（含悬空链接），真实目录按今天的语义删除，
// 指向别处的链接一律保留并报告（spec §5.2）。必须在 canonical 轮之前调用。
async function removeShareEntries(context, names, io) {
  let removed = 0;
  const conflicts = [];
  for (const targetConfig of shareTargets(context)) {
    for (const name of names) {
      assertSafeSkillName(name);
      const linkPath = path.join(targetConfig.destination, name);
      if (!isInside(targetConfig.destination, linkPath)) {
        fail(`Uninstall path escaped its target: ${linkPath}`);
      }
      if (!existsSync(targetConfig.destination)) {
        break;
      }
      const verdict = await classifyShareEntry(path.join(targetConfig.shareDestination, name), linkPath);
      if (verdict.state === "absent") {
        continue;
      }
      if (verdict.state === "conflict") {
        conflicts.push({ name, targetId: targetConfig.id, reason: verdict.reason });
        continue;
      }
      if (verdict.state === "linked" || verdict.state === "repair") {
        if (await removeLinkSafely(linkPath)) {
          removed += 1;
        } else {
          // 没删掉就不能算删除，否则计数撒谎；交给人处理。
          conflicts.push({ name, targetId: targetConfig.id, reason: "unremovable" });
        }
        continue;
      }
      await rm(linkPath, { recursive: true, force: true }); // real-directory：按名显式删除，语义不变
      removed += 1;
    }
  }
  if (conflicts.length > 0) {
    logConflicts(io, conflicts);
  }
  return removed;
}

// 卸一个 canonical target 下的一个 Skill：路径必须落在 target 里面，存在才删，删掉算 1。
async function removeCanonicalSkill(targetConfig, skillName) {
  const target = path.join(targetConfig.destination, skillName);
  if (!isInside(targetConfig.destination, target)) {
    fail(`Uninstall path escaped its target: ${target}`);
  }
  if (!existsSync(target)) return 0;
  await rm(target, { recursive: true, force: true });
  return 1;
}

export async function removeAllManagedSkills(context, managed, io = console) {
  const names = [...managed.keys()];
  let total = await removeShareEntries(context, names, io);
  for (const targetConfig of canonicalTargets(context)) {
    let removed = 0;
    for (const skillName of names) {
      assertSafeSkillName(skillName);
      removed += await removeCanonicalSkill(targetConfig, skillName);
    }
    total += removed;
    io.log(`${targetConfig.label}: Removed ${removed}`);
  }
  for (const targetConfig of context.targets) {
    await removeEmptyDirectory(targetConfig.destination);
  }
  return total;
}

export async function removeSkillDirectories(context, skillNames, io = console) {
  let total = await removeShareEntries(context, skillNames, io);
  for (const targetConfig of canonicalTargets(context)) {
    let removed = 0;
    for (const skillName of skillNames) {
      removed += await removeCanonicalSkill(targetConfig, skillName);
    }
    total += removed;
    io.log(`${targetConfig.label}: ${removed > 0 ? `Removed ${removed}` : "Unchanged"}`);
  }
  return total;
}

export async function removeInstallationFiles(context) {
  await rm(context.configFile, { force: true });
  await rm(context.lockFile, { force: true });
  if (context.legacyProfileFile) {
    await rm(context.legacyProfileFile, { force: true });
  }
}

// Adopt on-disk skills that no install record tracks: validate the names,
// place a real copy into every canonical destination that lacks the skill (an
// existing directory is the source of truth — never overwritten), then link
// the share targets to canonical via the same §3.2/§5.1 verdicts as install
// (identical copy → migrated to a link; divergent copy or foreign link →
// conflict, reported and left untouched). Records them in the lock's
// `adopted` list so the managed status recognizes them. No catalog/network
// involved; the skill stays byte-identical.
export async function adoptSkills(context, skillNames, options = {}) {
  const io = options.io ?? console;
  // createLink 透传（测试用于模拟 link-hostile 文件系统）；未提供时按 ensureSkillLinks 的默认建链。
  const createLink = options.createLink;
  const names = [...new Set(skillNames)];
  names.forEach(assertSafeSkillName);
  if (names.length === 0) return { adopted: [], placed: 0, linked: 0 };
  // 每个名字必须已在至少一个 target 中存在（否则为鬼路径：绝不凭空创建目录）
  const host = new Map(); // name → source skill directory
  for (const target of context.targets) {
    for (const name of names) {
      const skillDirectory = path.join(target.destination, name);
      if (!host.has(name) && existsSync(path.join(skillDirectory, "SKILL.md"))) {
        host.set(name, skillDirectory);
      }
    }
  }
  const missing = names.filter((name) => !host.has(name));
  if (missing.length > 0) {
    fail(`No on-disk skill found for: ${missing.join(", ")}`);
  }
  let placed = 0;
  // 真身只落 canonical：shareFrom target 由链接补齐（见下），不在这里拷贝。
  for (const target of canonicalTargets(context)) {
    const destination = target.destination;
    for (const name of names) {
      const targetPath = path.join(destination, name);
      if (!isInside(destination, targetPath)) {
        fail(`Adopt path escaped its target: ${targetPath}`);
      }
      if (existsSync(targetPath)) continue; // 该 target 已有内容：视为就绪，不覆盖
      await mkdir(destination, { recursive: true });
      await cp(host.get(name), targetPath, { recursive: true });
      placed += 1;
    }
  }
  // shareFrom target 走 §3.2/§5.1：一致的真实副本迁移为链接，分歧副本/外来链接判 conflict 且不动。
  // silent 只关闭 ensureSkillLinks 自身的输出；冲突必须在这里（按 direct 的同一模式）汇报，不得被吞。
  const linkResult = await ensureSkillLinks(context, names, { io, silent: true, createLink });
  const linked = linkResult.counts.linked;
  placed += linked; // 链接也算补齐一个 target（与 copy 补齐同义）
  for (const targetConfig of shareTargets(context)) {
    io.log(`✓ ${targetConfig.label} (shared from ${targetConfig.shareFrom})`);
    io.log(`  Path: ${targetConfig.destination}`);
    io.log(`  ${formatLinkSummary(linkResult.targets[targetConfig.id] ?? linkResult.counts)}`);
  }
  logConflicts(io, linkResult.conflicts);
  // 记录进 lock.adopted（schemaVersion 不变；未知字段对旧读者无害，安装/卸载会透传）
  const lockPath = context.lockFile;
  const lock = existsSync(lockPath) ? await readJson(lockPath) : {};
  const adopted = [...new Set([...(lock.adopted ?? []), ...names])];
  await writeJson(lockPath, { ...lock, adopted });
  return { adopted: names, placed, linked };
}

// Read-only plan for pack-aware adoption: for every Pack in the default
// catalog, how well does its skill set cover the on-disk names? coverage =
// matched / onDiskCount. The best candidate is returned for the caller to
// gate (≥ 0.8) and interact with; the mutation always happens afterwards via
// adoptPackedSkills (full) or adoptSkills (plain). Catalog errors degrade to
// an empty plan — plain adoption remains available.
export async function planAdoptSkills(context, skillNames) {
  const names = [...new Set(skillNames)];
  names.forEach(assertSafeSkillName);
  if (names.length === 0) return { candidates: [], best: null };
  try {
    const info = await resolveInstallSource({
      global: context.global,
      cwd: context.root,
      environment: context.environment,
      io: { log: () => {} },
    });
    const sourceConfig = await loadSources(info.catalogRoot);
    const catalog = await buildCatalog(sourceConfig, catalogLayout(info.catalogRoot).skills);
    const packs = await loadPacks(info.catalogRoot);
    const candidates = [...packs.values()].map((pack) => {
      const packNames = pack.sources.flatMap((source) => source.skills);
      const matched = names.filter((name) => packNames.includes(name));
      return {
        packId: pack.id,
        packName: pack.name,
        coverage: names.length === 0 ? 0 : matched.length / names.length,
        matched,
        missing: [...new Set(packNames)].filter((name) => !names.includes(name)).length,
      };
    }).filter((candidate) => candidate.coverage > 0);
    candidates.sort((a, b) => b.coverage - a.coverage || a.packId.localeCompare(b.packId));
    return { candidates, best: candidates[0] ?? null };
  } catch {
    return { candidates: [], best: null };
  }
}

// Pack-aware adoption: verify the caller's chosen Pack covers the on-disk
// names, then install every Pack skill into each target (existing dirs are
// the source of truth — never overwritten; missing skills are filled from
// the catalog cache) and write the full config/lock metadata (packs +
// sources + catalog revision). Stale cleanup is disabled: adoption must not
// remove skills recorded by other sources.
export async function adoptPackedSkills(context, skillNames, packId, options = {}) {
  const io = options.io ?? console;
  const names = [...new Set(skillNames)];
  names.forEach(assertSafeSkillName);
  if (names.length === 0) return { packId, names: [] };
  const previousConfig = existsSync(context.configFile) ? await readJson(context.configFile) : {};
  const previousLock = existsSync(context.lockFile) ? await readJson(context.lockFile) : {};
  const info = await resolveInstallSource({
    global: context.global,
    cwd: context.root,
    environment: context.environment,
    io,
  });
  const sourceConfig = await loadSources(info.catalogRoot);
  const catalog = await buildCatalog(sourceConfig, catalogLayout(info.catalogRoot).skills);
  const packs = await loadPacks(info.catalogRoot);
  const pack = packs.get(packId);
  if (!pack) {
    fail(`Unknown Pack: ${packId}`);
  }
  // 注意：不用 resolvePacks——它会经 normalizePackIds 无条件注入 common，导致
  // 非 common 任务被误并入；接管语义要求精确针对所选 Pack（与 on-disk 旧装一致）。
  const resolvedPacks = { ...resolvePack(catalog, sourceConfig, pack), packs: [pack] };
  const unknown = names.filter((name) => !resolvedPacks.names.includes(name));
  if (unknown.length > 0) {
    fail(`Pack ${packId} does not include on-disk skill: ${unknown.join(", ")}`);
  }
  await installCopies(context, resolvedPacks, io, { removeStale: false });
  await writeInstallMetadata(context, resolvedPacks, info);
  // 合并先前的托管记录（config.packs / lock.sources）：先装的 Pack 记录不被覆盖——
  // 同 source id 的 skills 并集（alpha 在 common、beta/gamma 在 development 时并存）。
  await mergePreviousInstallRecords(context, previousConfig, previousLock);
  return { packId, names: resolvedPacks.names, matched: names };
}

async function mergePreviousInstallRecords(context, previousConfig, previousLock) {
  const config = existsSync(context.configFile) ? await readJson(context.configFile) : {};
  const lock = existsSync(context.lockFile) ? await readJson(context.lockFile) : {};
  const packs = [...new Set([...(previousConfig.packs ?? []), ...(config.packs ?? [])])];
  const sourceById = new Map();
  for (const source of [...(previousLock.sources ?? []), ...(lock.sources ?? [])]) {
    const existing = sourceById.get(source.id);
    sourceById.set(
      source.id,
      existing
        ? { ...source, skills: [...new Set([...(existing.skills ?? []), ...(source.skills ?? [])])] }
        : { ...source, skills: [...new Set(source.skills ?? [])] },
    );
  }
  const lockPackById = new Map();
  for (const pack of [...(previousLock.packs ?? []), ...(lock.packs ?? [])]) {
    lockPackById.set(pack.id, pack);
  }
  await writeJson(context.configFile, { ...config, packs });
  await writeJson(context.lockFile, { ...lock, packs: [...lockPackById.values()], sources: [...sourceById.values()] });
}

// Read-only scan of the target directories this context writes to: the
// skills present on disk (directory containing SKILL.md), deduplicated and
// sorted, regardless of metadata. Detects content the install records do
// not track (legacy/external installs, manual copies). Never writes.
export async function detectedSkillNames(context) {
  const names = new Set();
  for (const target of context.targets) {
    let entries;
    try {
      entries = await readdir(target.destination, { withFileTypes: true });
    } catch {
      continue; // 目标目录不存在＝无内容
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (existsSync(path.join(target.destination, entry.name, "SKILL.md"))) {
        names.add(entry.name);
      }
    }
  }
  return [...names].sort();
}

// spec §6/§8：share 位置上"有 SKILL.md 但不在受管集合"的条目数。只读一次目录，
// 不接管、不链接、不删除——只用于提示 `avenic skills adopt`。
async function countUnmanagedEntries(directory, managedNames) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return 0; // 目录不存在＝没有未受管条目
  }
  let unmanaged = 0;
  for (const entry of entries) {
    if (managedNames.has(entry.name)) {
      continue;
    }
    if (existsSync(path.join(directory, entry.name, "SKILL.md"))) {
      unmanaged += 1;
    }
  }
  return unmanaged;
}

// Skills found on disk that no install record claims: installed by another
// tool, copied by hand, or left by an older Avenic. The managed set decides
// this — Packs, adopted names and direct installs — never the display set,
// which deliberately omits direct installs; subtracting that one would report
// a skill Avenic itself installed directly as unmanaged.
export function unmanagedSkillNames(status, detected) {
  const managed = new Set(status?.managedNames ?? []);
  return (detected ?? []).filter((name) => !managed.has(name));
}

// Structured `skills status` data (spec §8): the manifest's packs, per-target
// presence and the share-target verdict counts. Returns null when nothing is
// installed. Read-only and cheap: a real copy at a share target is `fallback`
// (usable but not shared) and content is never compared here (sameTree is
// install-path only), so a divergent copy is still `fallback`; `conflict` is
// the §3.2 ownership verdict (foreign/aliased/unreadable links). The canonical
// pass runs first: share targets come first in the table, and a share entry
// must never report complete while canonical is incomplete.
export async function skillsInstallationStatus(context) {
  if (!existsSync(context.lockFile)) {
    return null;
  }
  const manifest = await readJson(context.lockFile);
  const groups = (manifest.sources ?? []).map((source) => ({
    source,
    skills: (source.skills ?? []).map((name) => ({ name })),
  }));
  const manifestPacks = manifest.packs ?? (manifest.pack ? [manifest.pack] : []);
  const names = [...new Set([...groups.flatMap((group) => group.skills.map((skill) => skill.name)), ...(manifest.adopted ?? [])])];
  // 未受管计数按 §6 受管集合（Pack + adopted + 直装）算，而不是复用只给展示用的 names
  // （它保持旧组合 Pack + adopted，直装名不在其中）。否则直装技能会被误报成"未受管"，
  // 提示用户去 adopt 自己已经受管的技能。
  const managedNames = await managedSkillNames(context);

  // 第一趟：canonical 目标的完整度必须先全部算完（share 目标排在表前面）。
  const canonicalState = new Map();
  let canonicalComplete = true;
  for (const targetConfig of canonicalTargets(context)) {
    const present = names.filter((name) => existsSync(path.join(targetConfig.destination, name, "SKILL.md"))).length;
    const complete = present === names.length;
    canonicalComplete = canonicalComplete && complete;
    canonicalState.set(targetConfig.id, { present, complete });
  }

  // 第二趟：按表顺序输出；share 目标用最终的 canonicalComplete 判定 complete。
  const targets = [];
  let fallbackTotal = 0;
  let brokenTotal = 0;
  for (const targetConfig of context.targets) {
    const canonical = canonicalState.get(targetConfig.id);
    if (canonical) {
      targets.push({
        ...targetConfig,
        present: canonical.present,
        total: names.length,
        complete: canonical.complete,
        state: "canonical",
        counts: { present: canonical.present, total: names.length },
      });
      continue;
    }
    const counts = { linked: 0, fallback: 0, missing: 0, conflict: 0, unmanaged: 0 };
    const conflicts = [];
    for (const name of names) {
      const verdict = await classifyShareEntry(
        path.join(targetConfig.shareDestination, name),
        path.join(targetConfig.destination, name),
      );
      // repair（悬空链接/canonical 不是目录）不可用，绝不算 linked——与旧 present 语义一致。
      if (verdict.state === "linked") {
        counts.linked += 1;
      } else if (verdict.state === "conflict") {
        counts.conflict += 1;
        conflicts.push({ name, targetId: targetConfig.id, reason: verdict.reason });
      } else if (verdict.state === "real-directory") {
        counts.fallback += 1; // 可用但未共享；内容是否一致留给下一次安装判定
      } else {
        counts.missing += 1;
      }
    }
    counts.unmanaged = await countUnmanagedEntries(targetConfig.destination, managedNames);
    const complete = canonicalComplete && counts.missing === 0 && counts.conflict === 0;
    const state = counts.conflict > 0
      ? "conflict"
      : counts.missing > 0
        ? "missing"
        : counts.fallback > 0
          ? "fallback"
          : "linked";
    fallbackTotal += counts.fallback;
    brokenTotal += counts.missing + counts.conflict;
    targets.push({
      ...targetConfig,
      present: counts.linked + counts.fallback,
      total: names.length,
      complete,
      state,
      counts,
      conflicts,
    });
  }
  const operational = canonicalComplete && brokenTotal === 0;
  const optimized = operational && fallbackTotal === 0;
  const degraded = operational && fallbackTotal > 0;
  const incomplete = !operational;
  return {
    groups,
    packs: manifestPacks,
    names,
    // 受管集合（Pack + adopted + 直装）与展示用 names 分开返回：主机要用它判断
    // 「磁盘上有什么不属于 Avenic」，而 names 故意不含直装名。
    managedNames: [...managedNames],
    targets,
    // 汇总：optimized = 全部链接；degraded = 可用但存在降级副本；incomplete = 有缺失或冲突。
    state: optimized ? "optimized" : degraded ? "degraded" : "incomplete",
    operational,
    optimized,
    degraded,
    incomplete,
  };
}

async function pinnedCatalogSpec(spec, context) {
  if (!existsSync(context.lockFile)) {
    return spec;
  }
  const lock = await readJson(context.lockFile);
  const { repository, revision } = lock.catalog ?? {};
  if (!repository || !revision) {
    return spec;
  }
  if (parseCatalogSpec(spec).repository !== repository) {
    return spec;
  }
  return `${repository}#${revision}`;
}

// Resolve the catalog for an install context. The project lock pins the
// catalog commit for cross-device reproducibility; a refresh (bare
// `avenic skills`) intentionally bypasses the pin to pick up the latest.
export async function resolveInstallSource(options, { refresh = false } = {}) {
  const spec = await loadDefaultCatalogSpec(options.environment);
  const context = createInstallContext(options.global ?? false, options);
  const pinnedSpec = refresh ? spec : await pinnedCatalogSpec(spec, context);
  const catalogInfo = await ensureCatalog(pinnedSpec, {
    environment: options.environment,
    io: options.io ?? console,
  });
  const packageMetadata = existsSync(path.join(catalogInfo.catalogRoot, "package.json"))
    ? await readJson(path.join(catalogInfo.catalogRoot, "package.json"))
    : null;
  return { ...catalogInfo, packageMetadata };
}

// Install Packs into a scope: resolve the catalog, resolve the Packs,
// hand the plan to the presentation hook, copy the Skills, and write the
// config/lock metadata. Bare invocations (no explicit Packs) refresh the
// configured Packs against the latest catalog.
export async function installPacks(context, explicitPacks = [], options = {}) {
  const io = options.io ?? console;
  if (!context.global && isCatalogDirectory(context.root)) {
    fail("Run installation from a work project, not from the Avenic Hub");
  }
  const catalogInfo = await resolveInstallSource({
    global: context.global,
    cwd: context.root,
    environment: context.environment,
    io,
  }, {
    // 无参安装＝从最新 Hub 刷新；显式点名 Pack 时沿用锁定的修订（可复现）。更新
    // 命令显式点名 Pack 却要最新修订，所以多一个 refresh 开关。
    refresh: options.refresh ?? explicitPacks.length === 0,
  });
  const sourceConfig = await loadSources(catalogInfo.catalogRoot);
  const catalog = await buildCatalog(sourceConfig, catalogLayout(catalogInfo.catalogRoot).skills);
  const packs = await loadPacks(catalogInfo.catalogRoot);
  const packIds = await resolveInstallPacks(context, explicitPacks);
  const resolvedPacks = resolvePacks(catalog, sourceConfig, packs, packIds);
  // 本次落链目标：显式给的优先，否则沿用这个 scope 上次记录的偏好。
  const targets = options.targets ?? await linkTargetPreference(context);
  await options.onPlan?.(resolvedPacks);
  await installCopies(context, resolvedPacks, io, { targets });
  await writeInstallMetadata(context, resolvedPacks, catalogInfo, { targets });
  return { catalogInfo, packIds, resolvedPacks, targets };
}

// Uninstall Packs from a scope: validate the request, reinstall the
// remaining Packs (common is always included and can never be removed),
// and rewrite the metadata. The no-argument full cleanup stays in the CLI.
export async function uninstallPacks(context, packArguments = [], options = {}) {
  const io = options.io ?? console;
  const requested = parsePackArguments(packArguments);
  requested.forEach((packId) => assertSafeId(packId, "Pack id"));
  const current = await installedPackIds(context);
  if (!current) {
    io.log(`No managed ${context.label.toLowerCase()} skills installation found`);
    return { changed: false, removed: [], absent: requested, skippedCommon: false, current: null };
  }
  const removable = new Set(requested.filter((packId) => packId !== "common"));
  const removed = current.filter((packId) => removable.has(packId));
  const absent = requested.filter((packId) => packId !== "common" && !current.includes(packId));
  const skippedCommon = requested.includes("common");
  if (removed.length === 0) {
    return { changed: false, removed: [], absent, skippedCommon, current };
  }
  const catalogInfo = await resolveInstallSource({
    global: context.global,
    cwd: context.root,
    environment: context.environment,
    io,
  });
  const sourceConfig = await loadSources(catalogInfo.catalogRoot);
  const catalog = await buildCatalog(sourceConfig, catalogLayout(catalogInfo.catalogRoot).skills);
  const packs = await loadPacks(catalogInfo.catalogRoot);
  const remaining = current.filter((packId) => !removable.has(packId));
  const resolvedPacks = resolvePacks(catalog, sourceConfig, packs, remaining);
  // 卸载重装剩余 Pack 时沿用已记录的落链目标：卸载不是重新选择的机会。
  const targets = await linkTargetPreference(context);
  await options.onPlan?.(resolvedPacks, removed);
  await installCopies(context, resolvedPacks, io, { targets });
  await writeInstallMetadata(context, resolvedPacks, catalogInfo, { targets });
  return { changed: true, removed, absent, skippedCommon, current, resolvedPacks };
}
