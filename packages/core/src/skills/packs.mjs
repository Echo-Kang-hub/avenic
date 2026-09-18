import { existsSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fail } from "../util/fail.mjs";
import { isInside } from "../util/fs.mjs";
import { readJson, writeJson } from "../util/json.mjs";
import { assertSafeId, assertSafeSkillName } from "./ids.mjs";
import { saveSources } from "./sources.mjs";
import { catalogLayout } from "./paths.mjs";

export async function loadPacks(catalogRoot) {
  const packsRoot = catalogLayout(catalogRoot).packs;
  const files = (await readdir(packsRoot)).filter((file) => file.endsWith(".json")).sort();
  const packs = new Map();
  for (const file of files) {
    const pack = await readJson(path.join(packsRoot, file));
    assertSafeId(pack.id, "Pack id");
    if (file !== `${pack.id}.json`) {
      fail(`Pack filename must match its id: ${file} != ${pack.id}.json`);
    }
    if (!pack.name || !Array.isArray(pack.sources)) {
      fail(`Invalid Pack: ${pack.id}`);
    }
    if (packs.has(pack.id)) {
      fail(`Duplicate Pack: ${pack.id}`);
    }
    packs.set(pack.id, pack);
  }
  return packs;
}

export function resolvePack(catalog, sourceConfig, pack) {
  const sourceById = new Map(sourceConfig.sources.map((source) => [source.id, source]));
  const selectedNames = new Set();
  const groups = [];
  for (const selection of pack.sources) {
    const source = sourceById.get(selection.source);
    if (!source) {
      fail(`Pack ${pack.id} references unknown source: ${selection.source}`);
    }
    if (!Array.isArray(selection.skills) || selection.skills.length === 0) {
      fail(`Pack ${pack.id} has an empty source selection: ${selection.source}`);
    }
    const skills = [];
    for (const name of selection.skills) {
      assertSafeSkillName(name);
      if (selectedNames.has(name)) {
        fail(`Pack ${pack.id} contains duplicate Skill: ${name}`);
      }
      const skill = catalog.byName.get(name);
      if (!skill) {
        fail(`Pack ${pack.id} references missing Skill: ${name}`);
      }
      if (skill.source.id !== source.id) {
        fail(`Pack ${pack.id} records the wrong source for ${name}: ${source.id}`);
      }
      selectedNames.add(name);
      skills.push(skill);
    }
    groups.push({ source, skills });
  }
  return { groups, names: [...selectedNames], pack };
}

export function parsePackArguments(argumentsList) {
  return argumentsList
    .flatMap((value) => value.split(","))
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

export function normalizePackIds(packIds) {
  const unique = [...new Set(packIds)];
  if (!unique.includes("common")) {
    unique.unshift("common");
  }
  return unique;
}

export function resolvePacks(catalog, sourceConfig, packs, requestedPackIds) {
  const packIds = normalizePackIds(requestedPackIds);
  const selectedPacks = packIds.map((packId) => {
    const pack = packs.get(packId);
    if (!pack) {
      fail(`Unknown Pack: ${packId}`);
    }
    return pack;
  });
  const sourceOrder = new Map(sourceConfig.sources.map((source, index) => [source.id, index]));
  const groupsBySource = new Map();
  const selectedNames = new Set();
  let requestedSkills = 0;

  for (const pack of selectedPacks) {
    const resolved = resolvePack(catalog, sourceConfig, pack);
    requestedSkills += resolved.names.length;
    for (const group of resolved.groups) {
      let combined = groupsBySource.get(group.source.id);
      if (!combined) {
        combined = { source: group.source, skills: [] };
        groupsBySource.set(group.source.id, combined);
      }
      for (const skill of group.skills) {
        if (!selectedNames.has(skill.name)) {
          selectedNames.add(skill.name);
          combined.skills.push(skill);
        }
      }
    }
  }

  const groups = [...groupsBySource.values()]
    .filter((group) => group.skills.length > 0)
    .sort((left, right) => sourceOrder.get(left.source.id) - sourceOrder.get(right.source.id));
  return {
    groups,
    names: [...selectedNames],
    packs: selectedPacks,
    duplicateSelections: requestedSkills - selectedNames.size,
  };
}

export function packContainsSkill(pack, sourceId, skillName) {
  return pack.sources.some(
    (selection) => selection.source === sourceId && selection.skills.includes(skillName),
  );
}

export function skillCoveredByPacks(packs, packIds, sourceId, skillName) {
  if (packIds.some((packId) => packContainsSkill(packs.get(packId), sourceId, skillName))) {
    return true;
  }
  const common = packs.get("common");
  return Boolean(common && packContainsSkill(common, sourceId, skillName));
}

export function catalogReferences(packs) {
  const references = new Set();
  for (const pack of packs.values()) {
    for (const selection of pack.sources) {
      for (const skillName of selection.skills) {
        references.add(`${selection.source}\0${skillName}`);
      }
    }
  }
  return references;
}

export async function addSkillsToPacks(catalogRoot, packIds, sourceId, skillNames) {
  const packsRoot = catalogLayout(catalogRoot).packs;
  const loadedPacks = new Map();
  for (const packId of packIds) {
    assertSafeId(packId, "Pack id");
    const packFile = path.join(packsRoot, `${packId}.json`);
    if (!isInside(packsRoot, packFile) || !existsSync(packFile)) {
      fail(`Unknown Pack: ${packId}`);
    }
    loadedPacks.set(packId, { file: packFile, pack: await readJson(packFile) });
  }

  const commonEntry = loadedPacks.get("common") ?? {
    file: path.join(packsRoot, "common.json"),
    pack: await readJson(path.join(packsRoot, "common.json")),
  };
  const commonSkills = new Set(
    commonEntry.pack.sources.flatMap((selection) => selection.skills),
  );
  if (loadedPacks.has("common")) {
    skillNames.forEach((skillName) => commonSkills.add(skillName));
  }

  const added = [];
  const inherited = new Set();
  for (const packId of packIds) {
    const { file: packFile, pack } = loadedPacks.get(packId);
    const applicableSkills =
      packId === "common"
        ? skillNames
        : skillNames.filter((skillName) => {
            if (commonSkills.has(skillName)) {
              inherited.add(skillName);
              return false;
            }
            return true;
          });
    if (applicableSkills.length === 0) {
      continue;
    }
    let selection = pack.sources.find((item) => item.source === sourceId);
    if (!selection) {
      selection = { source: sourceId, skills: [] };
      pack.sources.push(selection);
    }
    let changed = false;
    for (const skillName of applicableSkills) {
      if (!selection.skills.includes(skillName)) {
        selection.skills.push(skillName);
        added.push({ packId, skillName });
        changed = true;
      }
    }
    if (changed) {
      await writeJson(packFile, pack);
    }
  }
  return { added, inherited: [...inherited] };
}

export async function pruneCatalogSkills(catalogRoot, sourceConfig, packs, candidates) {
  const skillsRoot = catalogLayout(catalogRoot).skills;
  const references = catalogReferences(packs);
  const removed = [];
  const affectedSources = new Set();
  for (const candidate of candidates) {
    const key = `${candidate.sourceId}\0${candidate.skillName}`;
    if (references.has(key)) {
      continue;
    }
    const directory = path.join(skillsRoot, candidate.sourceId, candidate.skillName);
    if (existsSync(directory)) {
      await rm(directory, { recursive: true, force: true });
      removed.push(candidate);
      affectedSources.add(candidate.sourceId);
    }
    const source = sourceConfig.sources.find((item) => item.id === candidate.sourceId);
    if (source?.skillPaths?.[candidate.skillName]) {
      delete source.skillPaths[candidate.skillName];
      if (Object.keys(source.skillPaths).length === 0) {
        delete source.skillPaths;
      }
      affectedSources.add(candidate.sourceId);
    }
  }

  const removedSources = [];
  for (const sourceId of affectedSources) {
    const source = sourceConfig.sources.find((item) => item.id === sourceId);
    if (!source) continue;
    const directory = path.join(skillsRoot, sourceId);
    const entries = existsSync(directory)
      ? await readdir(directory, { withFileTypes: true })
      : [];
    if (entries.some((entry) => entry.isDirectory())) {
      continue;
    }
    if (source.licenseFile) {
      await rm(path.join(catalogRoot, source.licenseFile), { force: true });
    }
    await rm(directory, { recursive: true, force: true });
    sourceConfig.sources = sourceConfig.sources.filter((item) => item.id !== sourceId);
    removedSources.push(sourceId);
  }
  if (removed.length > 0 || affectedSources.size > 0) {
    await saveSources(catalogRoot, sourceConfig);
  }
  return { removed, removedSources };
}
