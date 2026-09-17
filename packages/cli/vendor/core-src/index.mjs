// Public API of @avenic/core.

export { AGENTS, agentExecutableAvailable, detectAgentInstallation, getAgent } from "./runtime/agents.mjs";
export {
  clearLocalAuth,
  deinitializeAgent,
  effectiveAgentConfig,
  getAgentRuntimeMode,
  initializeAgent,
  loadRuntime,
  getActiveCanonicalSessionId,
  setActiveCanonicalSession,
  projectAuthEnvironment,
  runtimePaths,
  setLocalAuth,
  validateAuthMode,
  validateSessionsMode,
} from "./runtime/config.mjs";
export {
  REQUIRED_RULES,
  SESSIONS_RULE,
  ensureRuntimeGitignore,
  removeRuntimeGitignore,
  sessionsGitIgnored,
  setSessionsGitIgnored,
} from "./runtime/gitignore.mjs";
export { locateProjectRoot } from "./runtime/project-root.mjs";
export { resolveEffectiveAgentRuntime } from "./runtime/agent-runtime.mjs";
export { spawnExecutableSync } from "./runtime/process.mjs";
export {
  captureCanonicalSession,
  reconcileCanonicalSession,
  completeCanonicalContinuation,
  continueCanonicalSession,
  importProjectSessions,
  continuationLaunchArguments,
  prepareCanonicalContinuation,
  projectCanonicalSession,
} from "./runtime/session-interop.mjs";
export { buildHandoff, HANDOFF_SCHEMA_VERSION } from "./runtime/handoff.mjs";
export {
  PROJECT_ROOT_TOKEN,
  acquireSessionLease,
  hashContent,
  listFiles,
  mergeFiles,
  normalizeProjectIdentity,
  processAlive,
  readFirstJsonLine,
  releaseSessionLease,
  replaceDirectory,
  revertFrom,
  samePath,
  sessionLeasePath,
  snapshotFiles,
  snapshotInto,
  transformJsonLines,
} from "./runtime/sessions.mjs";
export { getSessionAdapter } from "./runtime/adapters/index.mjs";
export {
  CANONICAL_SESSION_SCHEMA_VERSION,
  appendCanonicalEvents,
  canonicalSessionRevision,
  createCanonicalSession,
  listCanonicalSessions,
  readCanonicalSession,
  syncNativeMapping,
} from "./runtime/canonical-sessions.mjs";

export { fail } from "./util/fail.mjs";
export { isInside, removeEmptyDirectory } from "./util/fs.mjs";
export { readJson, writeJson } from "./util/json.mjs";
export {
  assertSafeId,
  assertSafeSkillName,
  assertSafeSkillPath,
  assertSafeSkillRoot,
  assertSafeRelativePath,
} from "./skills/ids.mjs";
export {
  GLOBAL_TARGETS,
  LEGACY_PROFILE_FILE,
  MANAGED_AGENT_ORDER,
  PROJECT_CONFIG_FILE,
  PROJECT_LOCK_FILE,
  PROJECT_TARGETS,
  catalogCacheRoot,
  defaultCatalogFile,
  globalConfigFile,
  globalLockFile,
  knownCatalogsFile,
  stateRoot,
} from "./skills/paths.mjs";
export {
  cloneHead,
  cloneRevision,
  currentRepositoryState,
  deriveSourceId,
  git,
  normalizeRepositoryInput,
  remoteHead,
  repositoryIdentity,
  run,
} from "./skills/git.mjs";
export {
  catalogDisplayName,
  ensureCatalog,
  loadDefaultCatalogSpec,
  loadKnownCatalogs,
  parseCatalogSpec,
  registerCatalog,
  registerKnownCatalog,
  setDefaultCatalogSpec,
} from "./skills/catalog.mjs";
export {
  addDirectSkills,
  directLicensesRoot,
  directRoot,
  readDirectState,
  removeDirectSkills,
  removeExternalSkills,
  writeDirectState,
} from "./skills/direct.mjs";
export { printTree } from "./skills/ui.mjs";
export {
  buildCatalog,
  detectSkillRoot,
  discoverSourceSkills,
  findSource,
  loadSources,
  parseFrontmatterName,
  readSkill,
  registerSource,
  saveSources,
  stageSource,
} from "./skills/sources.mjs";
export {
  addSkillsToPacks,
  catalogReferences,
  loadPacks,
  normalizePackIds,
  packContainsSkill,
  parsePackArguments,
  pruneCatalogSkills,
  resolvePack,
  resolvePacks,
  skillCoveredByPacks,
} from "./skills/packs.mjs";
export {
  createTempDirectory,
  removeTempDirectory,
  replaceStagedFiles,
} from "./skills/vendor.mjs";
export {
  adoptPackedSkills,
  adoptSkills,
  createInstallContext,
  detectedSkillNames,
  planAdoptSkills,
  installCopies,
  installPacks,
  installedPackIds,
  isCatalogDirectory,
  managedSkillNames,
  previousManagedState,
  removeAllManagedSkills,
  removeInstallationFiles,
  removeSkillDirectories,
  resolveInstallPacks,
  resolveInstallSource,
  skillsInstallationStatus,
  uninstallPacks,
  writeInstallMetadata,
} from "./skills/install.mjs";
export {
  canonicalTargets,
  classifyShareEntry,
  createSkillLink,
  ensureSkillLinks,
  formatLinkSummary,
  logConflicts,
  normalizeLinkTarget,
  readLinkTarget,
  removeLinkSafely,
  sameTree,
  shareTargets,
} from "./skills/links.mjs";
export {
  API_TYPES,
  AUTH_FIELDS,
  CODEX_EFFORTS,
  MODEL_ROLES,
  TOGGLE_KEYS,
  canonicalJson,
  emptyLibrary,
  libraryFingerprint,
  maskSecret,
  normalizeProfile,
  validateBaseUrl,
  validateEnvKey,
  validateModelId,
  validateProviderId,
} from "./model/schema.mjs";
export {
  CLAUDE_SETTINGS_FILE,
  LIBRARY_SCHEMA_VERSION,
  PROJECT_MODEL_FILE,
  PROJECT_SCHEMA_VERSION,
  claudeSettingsFile,
  modelsFile,
  modelsTempRoot,
  projectModelFile,
  projectTempRoot,
} from "./model/paths.mjs";
export { transact } from "./model/transaction.mjs";
export { getProfile, listProfiles, readLibrary, removeProfile, upsertProfile } from "./model/library.mjs";
export {
  ROLE_KEYS,
  TOGGLE_ENTRIES,
  buildClaudeEntries,
  deletePath,
  mergeClaudeSettings,
  readPath,
  rollbackClaudeSettings,
  writePath,
} from "./model/project-claude.mjs";
export {
  bindProject,
  clearProjectBinding,
  danglingMessage,
  projectModelStatus,
  readBinding,
  resolveProjectProfile,
} from "./model/binding.mjs";
export { MODEL_RULES, ensureModelGitignore } from "./model/gitignore.mjs";
export {
  agentCompatibility,
  buildLaunchInjection,
  claudeEnvironment,
  codexInjection,
  opencodeInjection,
} from "./model/inject.mjs";
export { parseConfigJson, parseConfigText, recognizeEnvMap } from "./model/parse.mjs";
export { PRESETS, applyPreset } from "./model/presets.mjs";
export { probeUrl, testConnection } from "./model/probe.mjs";
