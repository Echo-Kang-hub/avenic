import { existsSync } from "node:fs";
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fail } from "../util/fail.mjs";
import { isInside, removeEmptyDirectory } from "../util/fs.mjs";
import { readJson, writeJson } from "../util/json.mjs";
import { cloneHead, deriveSourceId, git, normalizeRepositoryInput } from "./git.mjs";
import { assertSafeSkillName } from "./ids.mjs";
import { previousManagedState, removeSkillDirectories } from "./install.mjs";
import {
  canonicalTargets,
  ensureSkillLinks,
  formatLinkSummary,
  linkTargetPreference,
  logConflicts,
  shareTargets,
} from "./links.mjs";
import { stateRoot } from "./paths.mjs";
import { detectSkillRoot, discoverSourceSkills } from "./sources.mjs";

function directRoot(context) {
  return context.global
    ? path.join(stateRoot(context.environment), "direct")
    : path.join(context.root, ".agents", "direct");
}

function directLicensesRoot(context) {
  return context.global
    ? path.join(stateRoot(context.environment), "licenses")
    : path.join(context.root, ".agents", "licenses");
}

export async function readDirectState(context) {
  if (!existsSync(context.lockFile)) {
    return { directSources: [] };
  }
  const lock = await readJson(context.lockFile);
  return { directSources: lock.directSources ?? [] };
}

async function writeDirectState(context, state) {
  await mkdir(path.dirname(context.lockFile), { recursive: true });
  const previousLock = existsSync(context.lockFile) ? await readJson(context.lockFile) : {};
  const lock = {
    ...previousLock,
    schemaVersion: 3,
    directSources: state.directSources,
    // 与 Pack 安装共用同一个「落链目标」记忆（见 links.mjs）。
    ...(Array.isArray(state.targets) ? { targets: state.targets } : {}),
  };
  await writeJson(context.lockFile, lock);
  const previousConfig = existsSync(context.configFile) ? await readJson(context.configFile) : {};
  const config = {
    ...previousConfig,
    schemaVersion: 3,
    direct: state.directSources.map((source) => ({
      source: source.repository,
      skills: source.skills,
    })),
  };
  await writeJson(context.configFile, config);
}

async function ensureDirectClone(repository, directory) {
  if (existsSync(path.join(directory, ".git"))) {
    await git(["-C", directory, "fetch", "--depth", "1", "origin"]);
    await git(["-C", directory, "checkout", "--quiet", "--detach", "FETCH_HEAD"]);
  } else {
    await cloneHead({ repository }, directory);
  }
  return git(["-C", directory, "rev-parse", "HEAD"]);
}

/**
 * Clone a direct source and list the Skills it publishes, installing nothing.
 * The Add flow needs the names before it can ask which ones to take; the clone
 * lands in the same state directory `addDirectSkills` uses, so the install that
 * follows reuses it (a fetch on an existing checkout) rather than cloning twice.
 */
export async function discoverDirectSkills(context, sourceReference) {
  if (sourceReference.includes("#")) {
    fail(
      `Refs are not supported for direct sources: ${sourceReference}. Add the source to the catalog to pin a revision.`,
    );
  }
  const repository = normalizeRepositoryInput(sourceReference);
  const sourceId = deriveSourceId(repository);
  const directory = path.join(directRoot(context), sourceId);
  const revision = await ensureDirectClone(repository, directory);
  const state = await readDirectState(context);
  const existing = state.directSources.find((source) => source.id === sourceId);
  const source = {
    id: sourceId,
    name: sourceReference.replace(/\.git$/i, ""),
    repository,
    revision,
    skillRoot: existing?.skillRoot ?? await detectSkillRoot(directory),
  };
  const discovered = await discoverSourceSkills(source, directory);
  return { sourceId, revision, skillRoot: source.skillRoot, names: [...discovered.names].sort() };
}

async function findLicenseFile(cloneDirectory) {
  const entries = await readdir(cloneDirectory, { withFileTypes: true });
  return (
    entries.find((entry) => entry.isFile() && /^licen[cs]e(?:\.|$)/i.test(entry.name))?.name ?? null
  );
}

export async function addDirectSkills(context, sourceReference, skillNames, options = {}) {
  const io = options.io ?? console;
  // createLink 透传（测试用于模拟 link-hostile 文件系统）；未提供时按 ensureSkillLinks 的默认建链。
  const createLink = options.createLink ?? undefined;
  if (sourceReference.includes("#")) {
    fail(
      `Refs are not supported for direct sources: ${sourceReference}. Add the source to the catalog to pin a revision.`,
    );
  }
  const repository = normalizeRepositoryInput(sourceReference);
  const sourceId = deriveSourceId(repository);
  const state = await readDirectState(context);
  const existing = state.directSources.find((source) => source.id === sourceId);
  const directory = path.join(directRoot(context), sourceId);
  const revision = await ensureDirectClone(repository, directory);

  const source = {
    id: sourceId,
    name: sourceReference.replace(/\.git$/i, ""),
    repository,
    revision,
    skillRoot: existing?.skillRoot,
  };
  if (!source.skillRoot) {
    source.skillRoot = await detectSkillRoot(directory);
  }
  const discovered = await discoverSourceSkills(source, directory);
  const requestedNames = [...new Set(skillNames.length > 0 ? skillNames : discovered.names)];
  requestedNames.forEach(assertSafeSkillName);
  for (const name of requestedNames) {
    if (!discovered.names.includes(name)) {
      fail(`Skill not found upstream: ${name}`);
    }
  }

  const managed = await previousManagedState(context);
  const managedNames = requestedNames.filter((name) => managed.has(name));
  if (managedNames.length > 0) {
    fail(
      `Managed by configured Packs: ${managedNames.join(", ")}. Uninstall the Pack or remove the Skill from the Catalog`,
    );
  }
  for (const other of state.directSources.filter((item) => item.id !== sourceId)) {
    const conflicts = requestedNames.filter((name) => other.skills.includes(name));
    if (conflicts.length > 0) {
      fail(`Skill ${conflicts.join(", ")} already belongs to source ${other.id}`);
    }
  }

  if (
    existing &&
    existing.revision === revision &&
    requestedNames.every((name) => existing.skills.includes(name))
  ) {
    io.log(
      `Already installed: ${sourceId} (${requestedNames.length} Skill${requestedNames.length === 1 ? "" : "s"})`,
    );
    return { names: requestedNames, sourceId, revision, alreadyInstalled: true };
  }

  // 落链目标：显式给的优先，否则沿用这个 scope 上次记录的偏好（见 links.mjs）。
  const targets = options.targets ?? await linkTargetPreference(context);

  // 与 Pack 安装同序：先预检（上次的 fallback 副本要拿旧 canonical 比较），再写真身，最后补链。
  // restoreCopy: false —— 预检趟建链失败不得落拷贝：此刻 canonical 还是旧版本，落了就会把
  // 旧内容钉成 fallback 副本，补链趟会把它误判成用户手改的冲突。
  await ensureSkillLinks(context, requestedNames, { io, silent: true, restoreCopy: false, createLink, targets });

  for (const targetConfig of canonicalTargets(context)) {
    const destination = targetConfig.destination;
    await mkdir(destination, { recursive: true });
    for (const name of requestedNames) {
      const target = path.join(destination, name);
      if (!isInside(destination, target)) {
        fail(`Install path escaped its target: ${target}`);
      }
      await rm(target, { recursive: true, force: true });
      const upstreamPath = source.skillPaths?.[name] ?? name;
      await cp(path.join(directory, source.skillRoot, upstreamPath), target, { recursive: true });
    }
    io.log(`✓ ${targetConfig.label}`);
    io.log(`  Path: ${destination}`);
    io.log(`  Added ${requestedNames.length} direct Skill${requestedNames.length === 1 ? "" : "s"}`);
  }

  const linkResult = await ensureSkillLinks(context, requestedNames, { io, silent: true, createLink, targets });
  for (const targetConfig of shareTargets(context)) {
    if (targets && !targets.includes(targetConfig.id)) {
      continue;
    }
    io.log(`✓ ${targetConfig.label} (shared from ${targetConfig.shareFrom})`);
    io.log(`  Path: ${targetConfig.destination}`);
    io.log(`  ${formatLinkSummary(linkResult.targets[targetConfig.id] ?? linkResult.counts)}`);
  }
  logConflicts(io, linkResult.conflicts);

  const licenseName = await findLicenseFile(directory);
  if (licenseName) {
    const licenseDirectory = path.join(directLicensesRoot(context), sourceId);
    await mkdir(licenseDirectory, { recursive: true });
    await cp(path.join(directory, licenseName), path.join(licenseDirectory, "LICENSE"));
  }

  const combined = {
    ...source,
    skillRoot: source.skillRoot.replace(/\\/g, "/"),
    skills: [...new Set([...(existing?.skills ?? []), ...requestedNames])],
  };
  if (source.skillPaths) {
    combined.skillPaths = source.skillPaths;
  }
  const directSources = [...state.directSources.filter((item) => item.id !== sourceId), combined];
  await writeDirectState(context, { directSources, targets });
  return { names: requestedNames, sourceId, revision };
}

export async function removeDirectSkills(context, skillNames) {
  if (skillNames.length === 0) {
    return [];
  }
  const state = await readDirectState(context);
  const removedNames = new Set();
  const keptSources = [];
  const removedSources = [];
  for (const source of state.directSources) {
    const removed = source.skills.filter((name) => skillNames.includes(name));
    removed.forEach((name) => removedNames.add(name));
    const remaining = source.skills.filter((name) => !skillNames.includes(name));
    if (remaining.length > 0) {
      keptSources.push({ ...source, skills: remaining });
    } else if (removed.length > 0) {
      removedSources.push(source);
    }
  }
  if (removedNames.size === 0) {
    return [];
  }
  await writeDirectState(context, { directSources: keptSources });
  for (const source of removedSources) {
    await rm(path.join(directRoot(context), source.id), { recursive: true, force: true });
    await rm(path.join(directLicensesRoot(context), source.id), { recursive: true, force: true });
  }
  await removeEmptyDirectory(directRoot(context));
  await removeEmptyDirectory(directLicensesRoot(context));
  return [...removedNames];
}

// Remove externally installed Skills: managed Skills are rejected (they
// belong to Packs), then the direct records and the target directories go.
export async function removeExternalSkills(context, skillNames, options = {}) {
  const io = options.io ?? console;
  const uniqueNames = [...new Set(skillNames)];
  uniqueNames.forEach(assertSafeSkillName);
  const managed = await previousManagedState(context);
  const managedNames = uniqueNames.filter((skillName) => managed.has(skillName));
  if (managedNames.length > 0) {
    fail(
      `Managed by configured Packs: ${managedNames.join(", ")}. Uninstall the Pack or remove the Skill from the Catalog`,
    );
  }
  const directRemoved = await removeDirectSkills(context, uniqueNames);
  const removedDirectories = await removeSkillDirectories(context, uniqueNames, io);
  return { directRemoved, removedDirectories };
}
