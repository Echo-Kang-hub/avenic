// Public API of @avenic/core.

export {
  AGENTS,
  agentExecutableAvailable,
  agentNpmPackage,
  classifyAgentExecutable,
  compareCliVersions,
  detectAgentInstallation,
  getAgent,
  parseCliVersion,
} from "./runtime/agents.mjs";
export {
  detectAgentInstallationAsync,
  installedCliVersion,
  latestPublishedVersion,
} from "./runtime/versions.mjs";
export {
  clearLocalAuth,
  configureProject,
  deinitializeAgent,
  effectiveAgentConfig,
  getAgentRuntimeMode,
  initializeAgent,
  loadRuntime,
  getActiveCanonicalSessionId,
  setActiveCanonicalSession,
  projectAuthEnvironment,
  projectConfig,
  runtimePaths,
  setLocalAuth,
  validateAuthMode,
  validateSessionInteropMode,
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
export {
  agentCursors,
  cachedHead,
  cursorFilePath,
  knownDirectories,
  loadCursors,
  rememberDirectories,
  rememberHead,
  sameStamp,
  saveCursors,
  stampOf,
} from "./runtime/cursors.mjs";
export { WATCH_INTERVAL_MS, flushNativeSessions, startNativeWatch } from "./runtime/native-watch.mjs";
export { formatSessionDiagnostics } from "./runtime/diagnostics.mjs";
export { agentEnvironment, resolveEffectiveAgentRuntime } from "./runtime/agent-runtime.mjs";
export { spawnExecutable, spawnExecutableSync } from "./runtime/process.mjs";
export {
  captureCanonicalSession,
  reconcileCanonicalSession,
  setSessionInteropMode,
  applyProjectConfiguration,
  completeCanonicalContinuation,
  continueCanonicalSession,
  ensureNativeProjection,
  finishLaunch,
  importProjectSessions,
  joinLaunchGroup,
  observeSharedNativeSessions,
  recoverSharedNativeSessions,
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
  catalogLayout,
  defaultCatalogFile,
  globalConfigFile,
  globalLockFile,
  knownCatalogsFile,
  stateRoot,
} from "./skills/paths.mjs";
export {
  cloneHead,
  classifyGitFailure,
  cloneRevision,
  currentRepositoryState,
  deriveSourceId,
  git,
  gitFailure,
  normalizeRepositoryInput,
  remoteHead,
  repositoryIdentity,
  run,
} from "./skills/git.mjs";
export {
  catalogCacheDirectory,
  catalogDisplayName,
  ensureCatalog,
  hubSyncSummary,
  loadDefaultCatalogSpec,
  loadKnownCatalogs,
  parseCatalogSpec,
  registerCatalog,
  registerKnownCatalog,
  setDefaultCatalogSpec,
  shortRevision,
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
  unmanagedSkillNames,
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
  linkSummaryChanged,
  logConflicts,
  normalizeLinkTarget,
  readLinkTarget,
  removeLinkSafely,
  sameTree,
  shareTargets,
} from "./skills/links.mjs";
export { directSkillNames, removeAllInstalledSkills } from "./skills/uninstall.mjs";
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
