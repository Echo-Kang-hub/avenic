import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fail } from "../util/fail.mjs";
import { isInside } from "../util/fs.mjs";
import { readJson, writeJson } from "../util/json.mjs";
import {
  assertSafeId,
  assertSafeSkillName,
  assertSafeSkillPath,
  assertSafeSkillRoot,
} from "./ids.mjs";
import { cloneHead, normalizeRepositoryInput, repositoryIdentity } from "./git.mjs";
import { createTempDirectory, removeTempDirectory } from "./vendor.mjs";
import { catalogLayout } from "./paths.mjs";

export function parseFrontmatterName(content, file) {
  const frontmatter = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  const match = frontmatter?.[1].match(/^name:\s*(.+?)\s*$/m);
  if (!match) {
    fail(`SKILL.md is missing name: ${file}`);
  }
  return match[1].replace(/^["']|["']$/g, "").trim();
}

export async function readSkill(skillDirectory, requireMatchingFolder = true) {
  const file = path.join(skillDirectory, "SKILL.md");
  if (!existsSync(file)) {
    fail(`Missing SKILL.md: ${skillDirectory}`);
  }
  const name = parseFrontmatterName(await readFile(file, "utf8"), file);
  const folder = path.basename(skillDirectory);
  if (requireMatchingFolder && name !== folder) {
    fail(`Skill folder must match its upstream name: ${folder} != ${name}`);
  }
  return { name, directory: skillDirectory };
}

export async function loadSources(catalogRoot) {
  const data = await readJson(catalogLayout(catalogRoot).sourcesFile);
  if (!Array.isArray(data.sources) || data.sources.length === 0) {
    fail("sources.lock.json has no upstream sources");
  }
  const ids = new Set();
  for (const source of data.sources) {
    assertSafeId(source.id, "Source id");
    if (ids.has(source.id)) {
      fail(`Duplicate source id: ${source.id}`);
    }
    ids.add(source.id);
    if (!source.name || !source.repository || !source.skillRoot || !source.revision) {
      fail(`Incomplete source configuration: ${source.id}`);
    }
    assertSafeSkillRoot(source.skillRoot);
    if (source.skillPaths) {
      for (const [skillName, upstreamPath] of Object.entries(source.skillPaths)) {
        assertSafeSkillName(skillName);
        assertSafeSkillPath(upstreamPath, `upstream path for ${skillName}`);
      }
    }
  }
  return data;
}

export async function saveSources(catalogRoot, data) {
  await writeJson(catalogLayout(catalogRoot).sourcesFile, data);
}

export async function buildCatalog(config, skillsRoot) {
  const byName = new Map();
  const groups = [];
  for (const source of config.sources) {
    const sourceDirectory = path.join(skillsRoot, source.id);
    if (!isInside(skillsRoot, sourceDirectory) || !existsSync(sourceDirectory)) {
      fail(`Source directory does not exist: skills/${source.id}`);
    }
    const entries = await readdir(sourceDirectory, { withFileTypes: true });
    const skills = [];
    for (const entry of entries.filter((item) => item.isDirectory())) {
      const skill = await readSkill(path.join(sourceDirectory, entry.name));
      if (byName.has(skill.name)) {
        fail(`Skill name occurs in multiple sources: ${skill.name}`);
      }
      const record = { ...skill, source };
      byName.set(skill.name, record);
      skills.push(record);
    }
    skills.sort((left, right) => left.name.localeCompare(right.name));
    groups.push({ source, skills });
  }
  return { byName, groups };
}

export function findSource(sourceConfig, sourceReference) {
  return sourceConfig.sources.find(
    (source) =>
      source.id === sourceReference ||
      repositoryIdentity(source.repository) === repositoryIdentity(sourceReference),
  );
}

export async function stageSource(source, cloneDirectory, stageDirectory, skillNames) {
  for (const skillName of skillNames) {
    assertSafeSkillName(skillName);
    const upstreamPath = source.skillPaths?.[skillName] ?? skillName;
    assertSafeSkillPath(upstreamPath, `upstream path for ${skillName}`);
    const upstream = path.join(cloneDirectory, source.skillRoot, upstreamPath);
    const metadata = await readSkill(upstream, false);
    if (metadata.name !== skillName) {
      fail(`Upstream Skill name mismatch: ${skillName}`);
    }
    await cp(upstream, path.join(stageDirectory, source.id, skillName), {
      recursive: true,
      filter: (sourcePath) => ![".git", "node_modules"].includes(path.basename(sourcePath)),
    });
  }
  if (source.licenseSource && source.licenseFile) {
    const upstreamLicense = path.join(cloneDirectory, source.licenseSource);
    if (!existsSync(upstreamLicense)) {
      fail(`Upstream license does not exist: ${source.id}/${source.licenseSource}`);
    }
    await mkdir(path.dirname(path.join(stageDirectory, source.licenseFile)), { recursive: true });
    await cp(upstreamLicense, path.join(stageDirectory, source.licenseFile));
  }
}

export async function discoverSourceSkills(source, cloneDirectory, options = {}) {
  const sourceRoot = path.join(cloneDirectory, source.skillRoot);
  const skillDirectories = [];
  const pending = [{ directory: sourceRoot, relativePath: "" }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (existsSync(path.join(current.directory, "SKILL.md"))) {
      skillDirectories.push(current);
      continue;
    }
    const entries = await readdir(current.directory, { withFileTypes: true });
    for (const entry of entries.filter((item) => item.isDirectory())) {
      if (entry.name === ".git" || entry.name === "node_modules") {
        continue;
      }
      pending.push({
        directory: path.join(current.directory, entry.name),
        relativePath: current.relativePath
          ? path.join(current.relativePath, entry.name)
          : entry.name,
      });
    }
  }

  const names = [];
  let mappingsChanged = false;
  for (const entry of skillDirectories) {
    const skill = await readSkill(entry.directory, false);
    assertSafeSkillName(skill.name);
    if (names.includes(skill.name)) {
      fail(`Duplicate upstream Skill name: ${skill.name}`);
    }
    names.push(skill.name);
    const upstreamPath = entry.relativePath.replace(/\\/g, "/") || ".";
    if (skill.name !== upstreamPath && source.skillPaths?.[skill.name] !== upstreamPath) {
      source.skillPaths ??= {};
      source.skillPaths[skill.name] = upstreamPath;
      mappingsChanged = true;
    }
  }
  names.sort((left, right) => left.localeCompare(right));
  if (names.length === 0 && !options.allowEmpty) {
    fail(`No Skills found under ${source.skillRoot}`);
  }
  return { mappingsChanged, names };
}

export async function detectSkillRoot(cloneDirectory) {
  if (existsSync(path.join(cloneDirectory, "SKILL.md"))) {
    return ".";
  }
  const candidates = ["skills", ".agents/skills", ".claude/skills", "."];
  for (const candidate of candidates) {
    const directory = path.join(cloneDirectory, candidate);
    if (!existsSync(directory)) {
      continue;
    }
    const discovery = await discoverSourceSkills(
      { id: "discovery", skillRoot: candidate },
      cloneDirectory,
      { allowEmpty: true },
    );
    if (discovery.names.length > 0) {
      return candidate;
    }
  }
  fail("No Skill root found; use --skill-root <path>");
}

export async function registerSource(catalogRoot, sourceConfig, options, io = console) {
  const repository = normalizeRepositoryInput(options.repository);
  let skillRoot = options.skillRoot;
  assertSafeId(options.id, "Source id");
  if (skillRoot) {
    skillRoot = assertSafeSkillRoot(skillRoot);
  }
  if (sourceConfig.sources.some((source) => source.id === options.id)) {
    fail(`Source already exists: ${options.id}`);
  }

  const tempDirectory = await createTempDirectory(catalogRoot);
  try {
    const cloneDirectory = path.join(tempDirectory, "clone", options.id);
    io.log(`Registering upstream: ${repository}`);
    const revision = await cloneHead({ repository }, cloneDirectory);
    skillRoot ??= await detectSkillRoot(cloneDirectory);
    if (!existsSync(path.join(cloneDirectory, skillRoot))) {
      fail(`Upstream Skill root does not exist: ${skillRoot}`);
    }
    const rootFiles = await readdir(cloneDirectory, { withFileTypes: true });
    const autoLicense = rootFiles.find(
      (entry) => entry.isFile() && /^licen[cs]e(?:\.|$)/i.test(entry.name),
    );
    const chosenLicense = options.licenseSource ?? autoLicense?.name;
    const source = {
      id: options.id,
      name: options.name ?? options.id,
      repository,
      skillRoot: skillRoot.replace(/\\/g, "/"),
      revision,
    };
    if (chosenLicense) {
      const upstreamLicense = path.join(cloneDirectory, chosenLicense);
      if (!existsSync(upstreamLicense)) {
        fail(`License file does not exist: ${chosenLicense}`);
      }
      source.licenseSource = chosenLicense.replace(/\\/g, "/");
      source.licenseFile = `licenses/${options.id}-${path.basename(chosenLicense)}`;
      await mkdir(path.dirname(path.join(catalogRoot, source.licenseFile)), { recursive: true });
      await cp(upstreamLicense, path.join(catalogRoot, source.licenseFile));
    }
    sourceConfig.sources.push(source);
    await mkdir(path.join(catalogLayout(catalogRoot).skills, options.id), { recursive: true });
    await saveSources(catalogRoot, sourceConfig);
    io.log(`Registered ${options.id} @ ${revision.slice(0, 8)}`);
    io.log(`Skill root: ${skillRoot}`);
    return source;
  } finally {
    await removeTempDirectory(tempDirectory);
  }
}
