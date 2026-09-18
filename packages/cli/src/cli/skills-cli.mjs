import { existsSync } from "node:fs";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { takeOption } from "./options.mjs";
import {
  box,
  cancel,
  confirm,
  intro,
  isInteractive,
  multiselect,
  outro,
  select,
  spinner,
} from "./prompts.mjs";
import {
  AGENTS,
  addDirectSkills,
  addSkillsToPacks,
  adoptSkills,
  assertSafeId,
  assertSafeSkillName,
  buildCatalog,
  catalogDisplayName,
  catalogLayout,
  cloneHead,
  cloneRevision,
  createInstallContext,
  createTempDirectory,
  deriveSourceId,
  directSkillNames,
  discoverSourceSkills,
  ensureCatalog,
  fail,
  findSource,
  hubSyncSummary,
  installCopies,
  installPacks,
  installedPackIds,
  isCatalogDirectory,
  isInside,
  loadDefaultCatalogSpec,
  loadKnownCatalogs,
  loadPacks,
  loadSources,
  logConflicts,
  parsePackArguments,
  printTree,
  pruneCatalogSkills,
  readJson,
  registerCatalog,
  registerKnownCatalog,
  registerSource,
  remoteHead,
  removeAllInstalledSkills,
  removeExternalSkills,
  removeTempDirectory,
  replaceStagedFiles,
  resolveInstallSource,
  resolvePack,
  resolvePacks,
  saveSources,
  setDefaultCatalogSpec,
  skillCoveredByPacks,
  skillsInstallationStatus,
  stageSource,
  uninstallPacks,
  writeJson,
} from "#core";
import { updateAvenic } from "./self-update.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function parseScopeArguments(argumentsList) {
  const globalFlags = new Set(["-g", "--global"]);
  const global = argumentsList.some((argument) => globalFlags.has(argument));
  return {
    argumentsList: argumentsList.filter((argument) => !globalFlags.has(argument)),
    global,
  };
}

async function commandInstall(explicitPacks = [], options = {}) {
  const io = options.io ?? console;
  // 无参 + 终端：clack 风格交互（多选 Pack → Yes/No 确认 → 摘要框 → Done）。
  // 无参 + 管道/脚本：维持「默认 common」的既有行为（CLI surface 测试即此路径）。
  if (explicitPacks.length === 0 && isInteractive(options.prompts ?? {})) {
    await interactiveInstall(options);
    return;
  }
  const context = createInstallContext(options.global ?? false, options);
  const { resolvedPacks } = await installPacks(context, explicitPacks, {
    io,
    onPlan: (resolved) => {
      printTree(resolved.groups, "Skill Installation Plan", [
        `Packs: ${resolved.packs.map((pack) => pack.name).join(" + ")}`,
        `Scope: ${context.label}`,
        `Root: ${context.root}`,
        `Duplicate selections removed: ${resolved.duplicateSelections}`,
      ], io);
    },
  });
  io.log(`\nInstallation complete: ${resolvedPacks.names.length} unique Skills`);
  io.log(`Config: ${context.configFile}`);
  io.log(`Lock:   ${context.lockFile}`);
}

// 交互式安装：多选 Pack（common 预选）→ 确认 → 安装 → 摘要框 → Done。
// 安装输出走 spinner + 摘要框，installPacks 的 io 进度被吞掉（交互帧是唯一状态输出）。
async function interactiveInstall(options = {}) {
  const io = options.io ?? console;
  const prompts = options.prompts ?? {};
  const { stdout } = prompts;
  const context = createInstallContext(options.global ?? false, options);
  const quietIo = { log() {} };
  intro(stdout, "Install Skills");
  const spin = spinner({ ...prompts, text: "Loading Hub…" });
  let catalogInfo;
  let sourceConfig;
  let catalog;
  let packs;
  try {
    catalogInfo = await resolveInstallSource({
      global: context.global,
      cwd: context.root,
      environment: context.environment,
      io: quietIo,
    }, { refresh: true });
    sourceConfig = await loadSources(catalogInfo.catalogRoot);
    catalog = await buildCatalog(sourceConfig, catalogLayout(catalogInfo.catalogRoot).skills);
    packs = await loadPacks(catalogInfo.catalogRoot);
  } catch (error) {
    spin.fail(error.message);
    throw error;
  }
  if (packs.size === 0) {
    spin.stop("Hub loaded");
    fail("Hub has no Packs: add one inside the Hub clone (avenic hub pack-add <id>)");
  }
  spin.stop("Hub loaded");
  const entries = [...packs.values()].map((pack) => {
    const own = resolvePack(catalog, sourceConfig, pack);
    const effective = resolvePacks(catalog, sourceConfig, packs, [pack.id]);
    const count = pack.id === "common"
      ? `${own.names.length}`
      : `${own.names.length} + common = ${effective.names.length}`;
    return { value: pack.id, label: `${pack.name} — ${count} Skills` };
  });
  const picked = await multiselect({
    ...prompts,
    title: "Select Packs",
    options: entries,
    initial: packs.has("common") ? ["common"] : [],
  });
  if (picked === null) {
    cancel(stdout, "Install cancelled");
    return;
  }
  if (picked.length === 0) {
    cancel(stdout, "Nothing selected");
    return;
  }
  const yes = await confirm({
    ...prompts,
    title: picked.length === 1 ? "Install 1 Pack?" : `Install ${picked.length} Packs?`,
    initial: true,
  });
  if (yes !== true) {
    cancel(stdout, "Install cancelled");
    return;
  }
  const installSpin = spinner({ ...prompts, text: "Installing…" });
  let result;
  try {
    result = await installPacks(context, picked, { io: quietIo });
  } catch (error) {
    installSpin.fail(error.message);
    throw error;
  }
  installSpin.stop("Installed");
  const packLines = picked.map((id, index) => {
    const effective = resolvePacks(catalog, sourceConfig, packs, [id]);
    return `${index === picked.length - 1 ? "└─" : "├─"} ${packs.get(id).name} (${effective.names.length} Skills)`;
  });
  box(stdout, [
    `✓  ${result.resolvedPacks.names.length} unique Skills installed`,
    ...packLines,
    "",
    `scope: ${context.label}`,
    `config: ${context.configFile}`,
  ]);
  outro(stdout, `Done! Installed ${picked.length} Pack${picked.length === 1 ? "" : "s"}`);
}

async function commandAddDirect(argumentsList, options = {}) {
  const io = options.io ?? console;
  const context = createInstallContext(options.global ?? false, options);
  if (!options.global && isCatalogDirectory(options.cwd ?? process.cwd())) {
    fail("Run installation from a work project, not from an Avenic Hub");
  }
  const [sourceReference, ...skillNames] = argumentsList;
  if (!sourceReference) {
    fail("Usage: avenic skills add <owner/repo> [skill...] [-g]");
  }
  const unknownOption = argumentsList.find((argument) => argument.startsWith("-"));
  if (unknownOption) {
    fail(`Unknown option: ${unknownOption}`);
  }
  const result = await addDirectSkills(context, sourceReference, skillNames, { io });
  if (result.alreadyInstalled) {
    return;
  }
  io.log(`\nInstalled direct Skills: ${result.names.join(", ")}`);
  io.log(`Source: ${result.sourceId} @ ${result.revision.slice(0, 8)}`);
  io.log(`Config: ${context.configFile}`);
  io.log(`Lock:   ${context.lockFile}`);
}

async function commandUninstall(packArguments, options = {}) {
  const io = options.io ?? console;
  const context = createInstallContext(options.global ?? false, options);
  const current = await installedPackIds(context);
  if (!current) {
    io.log(`No managed ${context.label.toLowerCase()} Skills installation found`);
    return;
  }

  if (packArguments.length === 0) {
    // 无参 + 终端：Yes/No 确认（清空是破坏性操作）；无参 + 管道/脚本维持直接执行。
    if (isInteractive(options.prompts ?? {})) {
      await interactiveRemoveAll(context, options.prompts ?? {}, current);
      return;
    }
    await removeAllManaged(context, io);
    return;
  }

  const result = await uninstallPacks(context, packArguments, {
    io,
    onPlan: (resolved, removedPacks) => {
      printTree(resolved.groups, "Skill Uninstall Plan", [
        `Remove Packs: ${removedPacks.join(" + ")}`,
        `Keep Packs: ${resolved.packs.map((pack) => pack.name).join(" + ")}`,
        `Scope: ${context.label}`,
        `Root: ${context.root}`,
      ], io);
    },
  });
  if (result.current === null) return;
  if (result.skippedCommon) {
    io.log("Skipped: common is always included");
  }
  if (result.absent.length > 0) {
    io.log(`Already absent: ${result.absent.join(", ")}`);
  }
  if (!result.changed) {
    io.log("No Pack changes");
    return;
  }
  io.log(`\nUninstall complete: ${result.removed.join(", ")}`);
}

// 无参卸载的全量清理（管道/脚本路径）：清空由 core 负责，这里只管回显。
async function removeAllManaged(context, io) {
  const { managed } = await removeAllInstalledSkills(context, io);
  io.log(`Uninstalled all managed ${context.label.toLowerCase()} Skills: ${managed}`);
}

// 交互式卸载：Yes/No 确认 → 清空 → 摘要框 + Done。
async function interactiveRemoveAll(context, prompts, current) {
  const { stdout } = prompts;
  const label = context.label.toLowerCase();
  const directNames = await directSkillNames(context);
  intro(stdout, "Uninstall Skills");
  const yes = await confirm({
    ...prompts,
    title: `Remove ALL managed ${label} Skills? (${current.length} Pack${current.length === 1 ? "" : "s"}${
      directNames.length > 0 ? ` + ${directNames.length} direct` : ""
    })`,
    initial: false,
  });
  if (yes !== true) {
    cancel(stdout, "Uninstall cancelled");
    return;
  }
  const spin = spinner({ ...prompts, text: "Removing…" });
  let removed;
  try {
    // 安装期输出吞掉：交互帧是唯一状态输出（进度归 spinner）。
    removed = await removeAllInstalledSkills(context, { log() {} });
  } catch (error) {
    spin.fail(error.message);
    throw error;
  }
  spin.stop("Removed");
  box(stdout, [
    `✓  ${[removed.direct > 0 && `${removed.direct} direct`, `${removed.managed} managed`].filter(Boolean).join(" + ")} Skills removed`,
    "",
    `scope: ${context.label}`,
    `config: ${context.configFile}`,
  ]);
  outro(stdout, "Done! All managed Skills removed");
}

async function commandAdopt(skillArguments, options = {}) {
  const io = options.io ?? console;
  if (skillArguments.length === 0) {
    fail("Usage: adopt <skill...> [-g]");
  }
  const unknownOption = skillArguments.find((argument) => argument.startsWith("-"));
  if (unknownOption) {
    fail(`Unknown option: ${unknownOption}`);
  }
  const context = createInstallContext(options.global ?? false, options);
  const result = await adoptSkills(context, skillArguments, { io });
  io.log(`Adopted Skills: ${result.adopted.join(", ")}`);
  if (result.placed > 0) {
    io.log(`Placed targets: ${result.placed}`);
  }
  io.log(`Config: ${context.configFile}`);
  io.log(`Lock:   ${context.lockFile}`);
}

async function commandUninstallSkill(skillArguments, options = {}) {
  const io = options.io ?? console;
  if (skillArguments.length === 0) {
    fail("Usage: remove <skill...> [-g]");
  }
  const skillNames = [...new Set(skillArguments)];
  const context = createInstallContext(options.global ?? false, options);
  const result = await removeExternalSkills(context, skillNames, { io });
  io.log(
    result.removedDirectories > 0 || result.directRemoved.length > 0
      ? `Removed external Skills: ${skillNames.join(", ")}`
      : `Already absent: ${skillNames.join(", ")}`,
  );
}

async function commandTree(packArguments, options = {}) {
  const io = options.io ?? console;
  const catalogInfo = await resolveInstallSource(options);
  const sourceConfig = await loadSources(catalogInfo.catalogRoot);
  const catalog = await buildCatalog(sourceConfig, catalogLayout(catalogInfo.catalogRoot).skills);
  if (packArguments.length === 0) {
    printTree(catalog.groups, "All Hub Skills", [], io);
    return;
  }
  const packs = await loadPacks(catalogInfo.catalogRoot);
  const resolvedPacks = resolvePacks(
    catalog,
    sourceConfig,
    packs,
    parsePackArguments(packArguments),
  );
  printTree(resolvedPacks.groups, "Pack Preview", [
    `Packs: ${resolvedPacks.packs.map((pack) => pack.name).join(" + ")}`,
    `Duplicate selections removed: ${resolvedPacks.duplicateSelections}`,
  ], io);
}

async function commandPacks(options = {}) {
  const io = options.io ?? console;
  const catalogInfo = await resolveInstallSource(options);
  const sourceConfig = await loadSources(catalogInfo.catalogRoot);
  const catalog = await buildCatalog(sourceConfig, catalogLayout(catalogInfo.catalogRoot).skills);
  const packs = await loadPacks(catalogInfo.catalogRoot);
  io.log("\nAvailable Packs\n");
  for (const pack of packs.values()) {
    const own = resolvePack(catalog, sourceConfig, pack);
    const effective = resolvePacks(catalog, sourceConfig, packs, [pack.id]);
    const count = pack.id === "common" ? `${own.names.length}` : `${own.names.length} + common = ${effective.names.length}`;
    io.log(`- ${pack.id.padEnd(12)} ${count.padStart(18)} Skills  ${pack.name}`);
    if (pack.description) {
      io.log(`  ${pack.description}`);
    }
  }
  io.log();
}

// share 目标的展示位置：canonical 相对 scope 根（项目内即 `.agents/skills`），
// 统一用 `/` 分隔以免 Windows 输出 `.agents\skills`。
function shareLocation(context, target) {
  const relative = path.relative(context.root, target.shareDestination);
  const display = relative.startsWith("..") || path.isAbsolute(relative) ? target.shareDestination : relative;
  return display.split(path.sep).join("/");
}

async function commandStatus(options = {}) {
  const io = options.io ?? console;
  const context = createInstallContext(options.global ?? false, options);
  const status = await skillsInstallationStatus(context);
  if (!status) {
    fail(`${context.label} scope has no lock file; install a Pack first`);
  }
  printTree(status.groups, `Current ${context.label} Skills`, [
    `Packs: ${status.packs.map((pack) => pack.name ?? pack.id ?? pack).join(" + ")}`,
  ], io);
  const conflicts = [];
  for (const targetConfig of status.targets) {
    // canonical 目标保持既有形式（present/total + 可用性标记）。
    if (targetConfig.state === "canonical") {
      io.log(`${targetConfig.complete ? "✓" : "!"} ${targetConfig.label}: ${targetConfig.present}/${targetConfig.total}`);
      continue;
    }
    const counts = targetConfig.counts ?? {};
    if (targetConfig.state === "linked") {
      io.log(`✓ ${targetConfig.label}: shared via ${shareLocation(context, targetConfig)} (${counts.linked} link${counts.linked === 1 ? "" : "s"})`);
    } else if (targetConfig.state === "fallback") {
      // fallback 是合法降级，不是失败：副本可用，只是没共享。
      io.log(`⚠ ${targetConfig.label}: available — copies, not shared (${counts.fallback}) · run: avenic skills install`);
    } else if (targetConfig.state === "missing") {
      io.log(`⚠ ${targetConfig.label}: links missing — run: avenic skills install`);
    } else {
      io.log(`⚠ ${targetConfig.label}: ${counts.conflict} conflicting ${counts.conflict === 1 ? "entry" : "entries"} — left untouched, resolve manually`);
    }
    if ((counts.unmanaged ?? 0) > 0) {
      io.log(`ⓘ ${targetConfig.label}: ${counts.unmanaged} unmanaged Skill${counts.unmanaged === 1 ? "" : "s"} — not shared (run: avenic skills adopt)`);
    }
    conflicts.push(...(targetConfig.conflicts ?? []));
  }
  logConflicts(io, conflicts);
  io.log(status.state === "optimized" ? "Optimized" : status.state === "degraded" ? "Degraded" : "Incomplete");
}

async function commandDoctor(catalogRoot, io = console) {
  const skillsRoot = catalogLayout(catalogRoot).skills;
  const sourceConfig = await loadSources(catalogRoot);
  const catalog = await buildCatalog(sourceConfig, skillsRoot);
  const configuredSources = new Set(sourceConfig.sources.map((source) => source.id));
  const topLevelEntries = await readdir(skillsRoot, { withFileTypes: true });
  for (const entry of topLevelEntries.filter((item) => item.isDirectory())) {
    if (!configuredSources.has(entry.name)) {
      fail(`Unregistered source directory under skills/: ${entry.name}`);
    }
  }
  const packs = await loadPacks(catalogRoot);
  for (const pack of packs.values()) {
    resolvePack(catalog, sourceConfig, pack);
  }
  for (const source of sourceConfig.sources) {
    for (const skillName of Object.keys(source.skillPaths ?? {})) {
      const skill = catalog.byName.get(skillName);
      if (!skill || skill.source.id !== source.id) {
        fail(`Unused Skill path mapping: ${source.id} -> ${skillName}`);
      }
    }
  }
  io.log(
    `OK: ${catalog.byName.size} Skills, ${sourceConfig.sources.length} sources, ${packs.size} Packs`,
  );
}

async function commandUpdate(argumentsList, catalogRoot, io = console) {
  const checkOnly = argumentsList.includes("--check");
  const remainingArguments = argumentsList.filter((argument) => argument !== "--check");
  const unknownOption = remainingArguments.find((argument) => argument.startsWith("-"));
  if (unknownOption) {
    fail(`Unknown option: ${unknownOption}`);
  }
  if (remainingArguments.length > 1) {
    fail("Usage: update [source] [--check]");
  }
  const [target] = remainingArguments;
  const sourceConfig = await loadSources(catalogRoot);
  const catalog = await buildCatalog(sourceConfig, catalogLayout(catalogRoot).skills);
  const sources = target
    ? sourceConfig.sources.filter((source) => source.id === target)
    : sourceConfig.sources;
  if (sources.length === 0) {
    fail(`Unknown source: ${target}`);
  }
  if (checkOnly) {
    for (const source of sources) {
      const latest = await remoteHead(source);
      const status = latest === source.revision ? "up to date" : "update available";
      io.log(`${source.id}: ${status} ${source.revision.slice(0, 8)} -> ${latest.slice(0, 8)}`);
    }
    return;
  }

  const tempDirectory = await createTempDirectory(catalogRoot);
  const stageDirectory = path.join(tempDirectory, "stage");
  const revisions = new Map();
  try {
    for (const source of sources) {
      io.log(`\nFetching upstream: ${source.name}`);
      const cloneDirectory = path.join(tempDirectory, "clone", source.id);
      const revision = await cloneHead(source, cloneDirectory);
      const group = catalog.groups.find((item) => item.source.id === source.id);
      await stageSource(
        source,
        cloneDirectory,
        stageDirectory,
        group.skills.map((skill) => skill.name),
      );
      revisions.set(source.id, revision);
    }

    const replacements = [];
    for (const source of sources) {
      const group = catalog.groups.find((item) => item.source.id === source.id);
      for (const skill of group.skills) {
        const relativePath = path.join("skills", source.id, skill.name);
        replacements.push({
          relativePath,
          staged: path.join(stageDirectory, source.id, skill.name),
          target: path.join(catalogRoot, relativePath),
        });
      }
      if (source.licenseFile) {
        replacements.push({
          relativePath: source.licenseFile,
          staged: path.join(stageDirectory, source.licenseFile),
          target: path.join(catalogRoot, source.licenseFile),
        });
      }
    }
    await replaceStagedFiles(replacements, tempDirectory);
    for (const source of sources) {
      const previous = source.revision;
      source.revision = revisions.get(source.id);
      io.log(`${source.id}: ${previous.slice(0, 8)} -> ${source.revision.slice(0, 8)}`);
    }
    await saveSources(catalogRoot, sourceConfig);
    io.log("\nUpdate complete. Run doctor, review git diff, test, then commit.\n");
  } finally {
    await removeTempDirectory(tempDirectory);
  }
}

async function commandAdd(argumentsList, catalogRoot, io = console) {
  const { skills: skillsRoot, packs: packsRoot, sourcesFile } = catalogLayout(catalogRoot);
  const packsValue = takeOption(argumentsList, "--pack");
  const packIds = packsValue
    ? packsValue.split(",").map((value) => value.trim()).filter(Boolean)
    : ["common"];
  const [sourceReference, ...requestedSkillNames] = argumentsList;
  const discoverAll = requestedSkillNames.length === 0;
  if (!sourceReference) {
    fail("Usage: skill-add <source-id|owner/repo> [skill...] [--pack <pack,pack>]");
  }
  const unknownOption = argumentsList.find((argument) => argument.startsWith("-"));
  if (unknownOption) {
    fail(`Unknown option: ${unknownOption}`);
  }
  requestedSkillNames.forEach(assertSafeSkillName);
  const packs = await loadPacks(catalogRoot);
  for (const packId of packIds) {
    if (!packs.has(packId)) {
      fail(`Unknown Pack: ${packId}`);
    }
  }

  // A fresh catalog starts with zero registered sources; loadSources rejects
  // that, so the first source registers against an empty config instead.
  const lockData = await readJson(sourcesFile);
  const sourceConfig =
    Array.isArray(lockData.sources) && lockData.sources.length > 0
      ? await loadSources(catalogRoot)
      : { schemaVersion: lockData.schemaVersion ?? 1, sources: [] };
  const sourcesFileBefore = await readFile(sourcesFile, "utf8");
  const packFilesBefore = new Map(
    await Promise.all(
      packIds.map(async (packId) => [packId, await readFile(path.join(packsRoot, `${packId}.json`), "utf8")]),
    ),
  );
  let source = findSource(sourceConfig, sourceReference);
  let registeredSource = false;
  if (!source) {
    // owner/repo, URLs, and SSH refs always contain "/"; local paths may use
    // the platform separator instead (Windows: "\").
    if (!sourceReference.includes("/") && !sourceReference.includes("\\")) {
      fail(`Unknown source: ${sourceReference}`);
    }
    source = await registerSource(catalogRoot, sourceConfig, {
      id: deriveSourceId(sourceReference),
      name: sourceReference.replace(/\.git$/i, ""),
      repository: sourceReference,
    }, io);
    registeredSource = true;
  }
  const sourceId = source.id;
  let skillNames = requestedSkillNames;
  let mappingsChanged = false;
  let tempDirectory;
  let cloneDirectory;
  const stagedSkillPaths = new Map();
  const catalogBeforeInstall = await buildCatalog(sourceConfig, skillsRoot);
  const sourceGroup = catalogBeforeInstall.groups.find((group) => group.source.id === sourceId);
  const knownSkillNames = sourceGroup?.skills.map((skill) => skill.name) ?? [];
  const duplicateSkillNames = discoverAll ? knownSkillNames : requestedSkillNames;
  if (
    duplicateSkillNames.length > 0 &&
    duplicateSkillNames.every(
      (skillName) =>
        catalogBeforeInstall.byName.get(skillName)?.source.id === sourceId &&
        skillCoveredByPacks(packs, packIds, sourceId, skillName),
    )
  ) {
    io.log(
      `Already installed: ${sourceId} (${duplicateSkillNames.length} Skill${duplicateSkillNames.length === 1 ? "" : "s"})`,
    );
    io.log(`Packs: ${packIds.join(", ")}`);
    return;
  }
  try {
    if (discoverAll) {
      tempDirectory = await createTempDirectory(catalogRoot);
      cloneDirectory = path.join(tempDirectory, "clone", source.id);
      io.log(`Fetching locked source: ${source.name} @ ${source.revision.slice(0, 8)}`);
      await cloneRevision(source, cloneDirectory);
      const discovered = await discoverSourceSkills(source, cloneDirectory);
      skillNames = discovered.names;
      mappingsChanged = discovered.mappingsChanged;
      io.log(`Discovered ${skillNames.length} Skill${skillNames.length === 1 ? "" : "s"}`);
    }

    const catalog = await buildCatalog(sourceConfig, skillsRoot);
    const newSkillNames = [];
    for (const skillName of skillNames) {
      const existing = catalog.byName.get(skillName);
      if (existing && existing.source.id !== sourceId) {
        fail(`Skill ${skillName} already belongs to source ${existing.source.id}`);
      }
      if (!existing) {
        newSkillNames.push(skillName);
      }
    }

    if (newSkillNames.length > 0 && !discoverAll) {
      tempDirectory ??= await createTempDirectory(catalogRoot);
      cloneDirectory ??= path.join(tempDirectory, "clone", source.id);
      if (!existsSync(cloneDirectory)) {
        io.log(`Fetching locked source: ${source.name} @ ${source.revision.slice(0, 8)}`);
        await cloneRevision(source, cloneDirectory);
      }
      const discovered = await discoverSourceSkills(source, cloneDirectory);
      mappingsChanged ||= discovered.mappingsChanged;
      for (const skillName of newSkillNames) {
        if (!discovered.names.includes(skillName)) {
          fail(`Skill not found upstream: ${skillName}`);
        }
      }
    }

    if (newSkillNames.length > 0) {
      tempDirectory ??= await createTempDirectory(catalogRoot);
      cloneDirectory ??= path.join(tempDirectory, "clone", source.id);
      const stageDirectory = path.join(tempDirectory, "stage");
      if (!existsSync(cloneDirectory)) {
        io.log(`Fetching locked source: ${source.name} @ ${source.revision.slice(0, 8)}`);
        await cloneRevision(source, cloneDirectory);
      }
      await stageSource(source, cloneDirectory, stageDirectory, newSkillNames);
      const replacements = newSkillNames.map((skillName) => ({
        relativePath: path.join("skills", source.id, skillName),
        staged: path.join(stageDirectory, source.id, skillName),
        target: path.join(skillsRoot, source.id, skillName),
      }));
      for (const replacement of replacements) {
        stagedSkillPaths.set(replacement.target, existsSync(replacement.target));
      }
      await replaceStagedFiles(replacements, tempDirectory);
    }

    const packChanges = await addSkillsToPacks(catalogRoot, packIds, sourceId, skillNames);
    if (mappingsChanged) {
      await saveSources(catalogRoot, sourceConfig);
    }

    if (packChanges.added.length > 0) {
      io.log(
        discoverAll && skillNames.length > 1
          ? `Added all Skills: ${sourceId} (${skillNames.length})`
          : `Added: ${sourceId} -> ${skillNames.join(", ")}`,
      );
    } else {
      io.log("No Pack changes");
    }
    if (packChanges.inherited.length > 0) {
      io.log(`Inherited from common: ${packChanges.inherited.join(", ")}`);
    }
  } catch (error) {
    try {
      await writeFile(sourcesFile, sourcesFileBefore, "utf8");
      for (const [packId, contents] of packFilesBefore) {
        await writeFile(path.join(packsRoot, `${packId}.json`), contents, "utf8");
      }
      for (const [skillPath, existed] of stagedSkillPaths) {
        if (!existed) {
          await rm(skillPath, { recursive: true, force: true });
        }
      }
      if (registeredSource) {
        if (source.licenseFile) {
          await rm(path.join(catalogRoot, source.licenseFile), { force: true });
        }
        await rm(path.join(skillsRoot, source.id), { recursive: true, force: true });
      }
    } catch (rollbackError) {
      fail(`Add failed and rollback failed: ${rollbackError.message}`);
    }
    throw error;
  } finally {
    if (tempDirectory) {
      await removeTempDirectory(tempDirectory);
    }
  }
  io.log(`Packs: ${packIds.join(", ")}`);
}

async function commandRemove(argumentsList, catalogRoot, io = console) {
  const packsRoot = catalogLayout(catalogRoot).packs;
  const packsValue = takeOption(argumentsList, "--pack");
  const [sourceReference, ...requestedSkillNames] = argumentsList;
  if (!sourceReference || requestedSkillNames.length === 0) {
    fail("Usage: remove <source-id|owner/repo> <skill...> [--pack <pack,pack>]");
  }
  const unknownOption = argumentsList.find((argument) => argument.startsWith("-"));
  if (unknownOption) {
    fail(`Unknown option: ${unknownOption}`);
  }
  const skillNames = [...new Set(requestedSkillNames)];
  skillNames.forEach(assertSafeSkillName);
  const sourceConfig = await loadSources(catalogRoot);
  const source = findSource(sourceConfig, sourceReference);
  if (!source) {
    io.log(`Already absent: ${sourceReference} -> ${skillNames.join(", ")}`);
    return;
  }
  const packs = await loadPacks(catalogRoot);
  const packIds = packsValue
    ? packsValue.split(",").map((value) => value.trim()).filter(Boolean)
    : [...packs.keys()];
  for (const packId of packIds) {
    assertSafeId(packId, "Pack id");
    if (!packs.has(packId)) {
      fail(`Unknown Pack: ${packId}`);
    }
  }

  const removedMemberships = [];
  for (const packId of packIds) {
    const pack = packs.get(packId);
    let changed = false;
    for (const selection of pack.sources.filter((item) => item.source === source.id)) {
      const present = skillNames.filter((skillName) => selection.skills.includes(skillName));
      const before = selection.skills.length;
      selection.skills = selection.skills.filter((skillName) => !skillNames.includes(skillName));
      for (const skillName of present) {
        removedMemberships.push({ packId, skillName });
      }
      changed ||= selection.skills.length !== before;
    }
    pack.sources = pack.sources.filter((selection) => selection.skills.length > 0);
    if (changed) {
      await writeJson(path.join(packsRoot, `${packId}.json`), pack);
    }
  }

  const candidates = skillNames.map((skillName) => ({ sourceId: source.id, skillName }));
  const pruned = await pruneCatalogSkills(catalogRoot, sourceConfig, packs, candidates);
  if (removedMemberships.length === 0 && pruned.removed.length === 0) {
    io.log(`Already absent: ${source.id} -> ${skillNames.join(", ")}`);
    return;
  }
  io.log(`Removed from Packs: ${removedMemberships.length}`);
  io.log(`Removed vendored Skills: ${pruned.removed.map((item) => item.skillName).join(", ") || "None"}`);
  if (pruned.removedSources.length > 0) {
    io.log(`Removed empty sources: ${pruned.removedSources.join(", ")}`);
  }
}

async function commandPackRemove(argumentsList, catalogRoot, io = console) {
  const packsRoot = catalogLayout(catalogRoot).packs;
  if (argumentsList.length === 0) {
    fail("Usage: pack-remove <pack...>");
  }
  const packIds = [...new Set(parsePackArguments(argumentsList))];
  packIds.forEach((packId) => assertSafeId(packId, "Pack id"));
  if (packIds.includes("common")) {
    fail("The common Pack cannot be removed");
  }
  const sourceConfig = await loadSources(catalogRoot);
  const packs = await loadPacks(catalogRoot);
  const existing = packIds.filter((packId) => packs.has(packId));
  const absent = packIds.filter((packId) => !packs.has(packId));
  if (absent.length > 0) {
    io.log(`Already absent: ${absent.join(", ")}`);
  }
  if (existing.length === 0) {
    io.log("No Pack changes");
    return;
  }

  const candidates = [];
  for (const packId of existing) {
    const pack = packs.get(packId);
    for (const selection of pack.sources) {
      for (const skillName of selection.skills) {
        candidates.push({ sourceId: selection.source, skillName });
      }
    }
    packs.delete(packId);
  }
  for (const packId of existing) {
    await rm(path.join(packsRoot, `${packId}.json`));
  }
  const pruned = await pruneCatalogSkills(catalogRoot, sourceConfig, packs, candidates);
  io.log(`Removed Packs: ${existing.join(", ")}`);
  io.log(`Removed orphan Skills: ${pruned.removed.length}`);
  if (pruned.removedSources.length > 0) {
    io.log(`Removed empty sources: ${pruned.removedSources.join(", ")}`);
  }
}

async function commandSourceAdd(argumentsList, catalogRoot, io = console) {
  const name = takeOption(argumentsList, "--name");
  const skillRoot = takeOption(argumentsList, "--skill-root");
  const licenseSource = takeOption(argumentsList, "--license");
  const [id, repository] = argumentsList;
  if (!id || !repository || argumentsList.length !== 2) {
    fail("Usage: source-add <id> <repository> [--name <name>] [--skill-root <path>] [--license <path>]");
  }
  const sourceConfig = await loadSources(catalogRoot);
  await registerSource(catalogRoot, sourceConfig, {
    id,
    licenseSource,
    name,
    repository,
    skillRoot,
  }, io);
  io.log(`Next: avenic hub skill-add ${id} <skill-name> --pack <pack>`);
}

async function commandPackAdd(argumentsList, catalogRoot, io = console) {
  const packsRoot = catalogLayout(catalogRoot).packs;
  const name = takeOption(argumentsList, "--name");
  const description = takeOption(argumentsList, "--description");
  const [id] = argumentsList;
  if (!id || argumentsList.length !== 1) {
    fail("Usage: pack-add <id> [--name <name>] [--description <text>]");
  }
  assertSafeId(id, "Pack id");
  const packFile = path.join(packsRoot, `${id}.json`);
  if (!isInside(packsRoot, packFile) || existsSync(packFile)) {
    fail(`Pack already exists: ${id}`);
  }
  const displayName =
    name ??
    id
      .split(/[-_.]+/)
      .filter(Boolean)
      .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
      .join(" ");
  await writeJson(packFile, {
    schemaVersion: 1,
    id,
    name: displayName,
    description: description ?? `Custom ${displayName} workflows.`,
    sources: [],
  });
  io.log(`Created Pack: ${id}`);
  io.log(`File: ${packFile}`);
  io.log(`Next: avenic hub skill-add <source> <skill-name> --pack ${id}`);
}

async function runMaintenanceCommand(command, argumentsList, catalogRoot, io) {
  switch (command) {
    case "doctor":
      await commandDoctor(catalogRoot, io);
      break;
    case "update":
      await commandUpdate(argumentsList, catalogRoot, io);
      break;
    case "skill-add":
      await commandAdd([...argumentsList], catalogRoot, io);
      break;
    case "remove":
      await commandRemove([...argumentsList], catalogRoot, io);
      break;
    case "pack-add":
      await commandPackAdd([...argumentsList], catalogRoot, io);
      break;
    case "pack-remove":
      await commandPackRemove([...argumentsList], catalogRoot, io);
      break;
    case "source-add":
      await commandSourceAdd([...argumentsList], catalogRoot, io);
      break;
    default:
      fail(`Unknown command: ${command}`);
  }
}

async function commandHubSync(options = {}) {
  const io = options.io ?? console;
  const spec = await loadDefaultCatalogSpec(options.environment);
  io.log(`Syncing ${spec}…`);
  const catalogInfo = await ensureCatalog(spec, {
    environment: options.environment,
    io,
  });
  io.log(hubSyncSummary(catalogInfo));
  io.log(`Hub     ${catalogInfo.spec}`);
  io.log(`Cache   ${catalogInfo.catalogRoot}`);
  io.log(`Branch  ${catalogInfo.ref}`);
}

async function commandHubAdd(argumentsList, options = {}) {
  const io = options.io ?? console;
  const [spec] = argumentsList;
  if (!spec || argumentsList.length !== 1) {
    fail("Usage: avenic hub add <spec>");
  }
  const result = await registerCatalog(spec, { environment: options.environment, io });
  io.log(`Default Hub: ${spec}`);
  if (result.previewFailed) {
    io.log("\nSpec saved. Hub preview unavailable:");
    io.log(`  ${String(result.error.message).split("\n")[0]}`);
  } else {
    io.log(`\nPacks · ${result.packs.length}`);
    result.packs.forEach((pack, packIndex) => {
      const lastPack = packIndex === result.packs.length - 1;
      const label = pack.name && pack.name !== pack.id ? `${pack.id} (${pack.name})` : pack.id;
      const purpose = pack.description ? ` — ${pack.description}` : "";
      io.log(`${lastPack ? "└──" : "├──"} ${label}${purpose}`);
    });
    io.log("\nInstall: avenic skills install [pack...]");
  }
  io.log("Run: avenic hub sync");
}

// Seed the registry with the current spec on first use, so upgrading users
// see their Hub in `hub list`/`hub select` immediately.
async function ensureKnownCatalogs(options = {}) {
  let known = await loadKnownCatalogs(options.environment);
  if (known.length === 0) {
    const current = await loadDefaultCatalogSpec(options.environment);
    await registerKnownCatalog(options.environment, current);
    known = await loadKnownCatalogs(options.environment);
  }
  return known;
}

async function commandHubList(options = {}) {
  const io = options.io ?? console;
  const current = await loadDefaultCatalogSpec(options.environment);
  const known = await ensureKnownCatalogs(options);
  io.log("\nRegistered Hubs\n");
  for (const entry of known) {
    const marker = entry.spec === current ? ">" : " ";
    io.log(`${marker} ${entry.name}${entry.spec !== entry.name ? `   ${entry.spec}` : ""}`);
  }
  io.log("\n> = current. Switch: avenic hub select");
}

// clack 风格单选（prompts.select 内部实现帧重绘，含键盘处理与取消打印）。
// 非 TTY 时 commandHubSelect 在进入本函数前已回退为纯文本清单。
function promptHubChoice(entries, currentIndex) {
  return select({
    title: "Choose a Hub",
    options: entries.map((entry) => ({ value: entry.spec, label: entry.name })),
    initial: currentIndex >= 0 ? currentIndex : 0,
  });
}

async function commandHubSelect(argumentsList, options = {}) {
  const io = options.io ?? console;
  const [target] = argumentsList;
  if (argumentsList.length > 1) {
    fail("Usage: avenic hub select [name|spec]");
  }
  const current = await loadDefaultCatalogSpec(options.environment);
  const known = await ensureKnownCatalogs(options);
  if (target) {
    const entry = known.find((candidate) => candidate.spec === target)
      ?? known.find((candidate) => candidate.name === target);
    if (!entry) {
      fail(`Unknown Hub: ${target}\nAdd one first: avenic hub add <spec>`);
    }
    await setDefaultCatalogSpec(options.environment, entry.spec);
    io.log(`Current Hub: ${entry.spec}`);
    return;
  }
  if (!isInteractive()) {
    // No terminal (pipes, scripts): print the plain list instead.
    await commandHubList(options);
    return;
  }
  const currentIndex = known.findIndex((entry) => entry.spec === current);
  // The picker paints its own title as the first frame line.
  const chosen = await promptHubChoice(known, currentIndex);
  if (chosen === null) {
    io.log("No change.");
    return;
  }
  await setDefaultCatalogSpec(options.environment, chosen);
  io.log(`Current Hub: ${chosen}`);
}

async function commandHubDefault(options = {}) {
  const io = options.io ?? console;
  io.log(`Default Hub: ${await loadDefaultCatalogSpec(options.environment)}`);
}

export async function dispatchHub(argumentsList, options = {}) {
  const io = options.io ?? console;
  const scope = parseScopeArguments(argumentsList);
  // The entry point (dispatchSkills) strips scope flags before delegating here,
  // so the global flag must survive the delegation to keep validation intact.
  const global = scope.global || options.global;
  const [command, ...remainingArguments] = scope.argumentsList;
  if (command === "sync") {
    if (global || remainingArguments.length > 0) {
      fail("Usage: avenic hub sync");
    }
    await commandHubSync(options);
    return;
  }
  if (command === "add") {
    if (global) {
      fail("avenic hub add does not accept a global scope");
    }
    await commandHubAdd(remainingArguments, options);
    return;
  }
  if (command === "default") {
    if (global || remainingArguments.length > 0) {
      fail("Usage: avenic hub default");
    }
    await commandHubDefault(options);
    return;
  }
  if (command === "select") {
    if (global) {
      fail("avenic hub select does not accept a global scope");
    }
    await commandHubSelect(remainingArguments, options);
    return;
  }
  if (command === "list") {
    if (global || remainingArguments.length > 0) {
      fail("Usage: avenic hub list");
    }
    await commandHubList(options);
    return;
  }
  const maintenanceCommands = new Set([
    "doctor",
    "update",
    "skill-add",
    "remove",
    "pack-add",
    "pack-remove",
    "source-add",
  ]);
  if (!command || !maintenanceCommands.has(command)) {
    fail("Usage: avenic hub <sync|add|select|list|default|doctor|update|skill-add|remove|pack-add|pack-remove|source-add>");
  }
  if (global) {
    fail(`${command} does not accept a global scope`);
  }
  const cwd = options.cwd ?? process.cwd();
  if (!isCatalogDirectory(cwd)) {
    fail(`${command} must run inside the Hub Git clone`);
  }
  return runMaintenanceCommand(command, remainingArguments, cwd, io);
}

export async function dispatchSkills(argumentsList, options = {}) {
  const io = options.io ?? console;
  const scope = parseScopeArguments(argumentsList);
  const [firstArgument, ...remainingArguments] = scope.argumentsList;
  const command = firstArgument ?? "install";
  const commandOptions = { ...options, global: scope.global || options.global };
  if (command === "add") {
    await commandAddDirect(remainingArguments, commandOptions);
    return;
  }
  // "remove" pairs with "add": it removes externally installed Skills, and
  // precedes the catalog maintenance set below for the same reason "add" does.
  if (command === "remove") {
    await commandUninstallSkill(remainingArguments, commandOptions);
    return;
  }
  // adopt 与 add/remove 并列：只碰磁盘 + lock，无需 Catalog（离线可用 —— unpacked skill 直接纳入管理）
  if (command === "adopt") {
    await commandAdopt(remainingArguments, commandOptions);
    return;
  }
  if (command === "install") {
    await commandInstall(remainingArguments, commandOptions);
    return;
  }
  if (command === "skills") {
    await dispatchSkills(remainingArguments, { ...options, global: scope.global || options.global });
    return;
  }
  if (command === "catalog") {
    // 旧嵌套写法 `avenic skills catalog …`：同样弃用，转发到 hub
    console.warn("warning: `avenic skills catalog` is deprecated; use `avenic hub`");
    await dispatchHub(remainingArguments, {
      io,
      cwd: options.cwd ?? process.cwd(),
      environment: options.environment ?? process.env,
      global: scope.global || options.global,
    });
    return;
  }
  const maintenanceCommands = new Set([
    "doctor",
    "update",
    "skill-add",
    "remove",
    "pack-add",
    "pack-remove",
    "source-add",
  ]);
  if (maintenanceCommands.has(command)) {
    if (scope.global) {
      fail(`${command} does not accept a global scope`);
    }
    const cwd = options.cwd ?? process.cwd();
    if (!isCatalogDirectory(cwd)) {
      // Outside a catalog clone, doctor and update fall back to their runtime
      // meanings (environment check and CLI self-update); the other maintenance
      // commands only make sense inside the catalog Git clone.
      if (command === "doctor" || command === "update") {
        const { runCli } = await import("./dispatcher.mjs");
        return runCli({ argumentsList: [command, ...remainingArguments] });
      }
      fail(`${command} must run inside the Avenic Git clone`);
    }
    return runMaintenanceCommand(command, remainingArguments, cwd, io);
  }

  if (command === "help" || command === "--help" || command === "-h") {
    const { printHelp } = await import("./dispatcher.mjs");
    printHelp(io);
    return;
  }
  if (command === "self-update") {
    if (scope.global || remainingArguments.length > 0) {
      fail("Usage: self-update");
    }
    await updateAvenic(packageRoot);
    return;
  }
  if (command === "uninstall" && remainingArguments.length === 0) {
    await commandUninstall([], commandOptions);
    return;
  }

  // Known subcommands resolve the catalog themselves; handle them before any
  // network work so typos in the command position never trigger a fetch.
  switch (command) {
    case "packs":
      await commandPacks(commandOptions);
      return;
    case "tree":
      await commandTree(remainingArguments, commandOptions);
      return;
    case "uninstall":
      await commandUninstall(remainingArguments, commandOptions);
      return;
    case "status":
      await commandStatus(commandOptions);
      return;
  }

  // Agent runtime commands (claude/codex/opencode lifecycle, sessions) are
  // handled by the runtime dispatcher; delegate before the Pack fallback so
  // typos in the agent position never trigger a network fetch. The bare
  // `avenic status` overview stays reachable through the main entry.
  if (Object.hasOwn(AGENTS, command) || command === "sessions") {
    const { runCli } = await import("./dispatcher.mjs");
    return runCli({ argumentsList: scope.argumentsList });
  }

  // Anything else is a Pack id (ids are user-defined, so the catalog is the
  // only source of truth for telling Packs from typos).
  const catalogInfo = await resolveInstallSource(commandOptions);
  const packs = await loadPacks(catalogInfo.catalogRoot);
  if (packs.has(command)) {
    await commandInstall([command, ...remainingArguments], commandOptions);
    return;
  }
  fail(`Unknown command or Pack: ${command}`);
}
