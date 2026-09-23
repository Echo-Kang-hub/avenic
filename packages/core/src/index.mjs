// Public API of @avenic/core.

export {
  AGENTS,
  agentExecutableAvailable,
  agentNpmPackage,
  classifyAgentExecutable,
  compareCliVersions,
  detectAgentInstallation,
  getAgent,
  isAgentId,
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
  projectConfig,
  runtimePaths,
  agentHomeRoot,
  setLocalAuth,
  viewOf,
  validateAuthMethod,
  validateHistoryMode,
  validateScope,
} from "./runtime/config.mjs";
export {
  REQUIRED_RULES,
  SESSIONS_RULE,
  ensureRuntimeGitignore,
  removeRuntimeGitignore,
  sessionsGitIgnored,
  setSessionsGitIgnored,
} from "./runtime/gitignore.mjs";
export { enclosingProjectRoot, locateProjectRoot } from "./runtime/project-root.mjs";
export {
  agentCursors,
  cachedHead,
  canonicalCursors,
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
export { durableEnvironment } from "./runtime/environment.mjs";
export { formatSessionDiagnostics } from "./runtime/diagnostics.mjs";
export { machineEnvironment, agentRuntimeEnvironment, effectiveAgentEnvironment, launchMethodQuestion, launchMethodReadiness, resolveEffectiveAgentRuntime } from "./runtime/agent-runtime.mjs";
export {
  ensureModelConfiguration,
  legacyModelConfiguration,
  modelConfigAgents,
  modelConfigCandidate,
  modelConfigPresence,
  modelConfigRelative,
  modelConfigTarget,
  readAccountConfiguration,
  readModelConfiguration,
  removeModelConfiguration,
} from "./runtime/model-config.mjs";
export { LABELS, agentQuestion, authenticationValue, historyLabel, methodLabel, scopeLabel, scopedHomeValue, signInLabel } from "./labels.mjs";
export { quoteShellLine, spawnExecutable, spawnExecutableSync } from "./runtime/process.mjs";
export {
  captureCanonicalSession,
  reconcileCanonicalSession,
  setHistoryMode,
  applyProjectConfiguration,
  beginLaunch,
  completeCanonicalContinuation,
  continueCanonicalSession,
  ensureNativeProjection,
  finishLaunch,
  importProjectSessions,
  joinLaunchGroup,
  leftoverTargets,
  methodSwitches,
  observeSharedNativeSessions,
  recoverSharedNativeSessions,
  releasePreviousMethod,
  continuationLaunchArguments,
  prepareCanonicalContinuation,
  projectCanonicalSession,
} from "./runtime/session-interop.mjs";
export {
  agentChoices,
  applyProjectDraft,
  projectDraft,
  projectDraftSubmission,
  projectWizardSteps,
} from "./runtime/project-wizard.mjs";
export { buildHandoff } from "./runtime/handoff.mjs";
export {
  PROJECT_ROOT_TOKEN,
  acquireSessionLease,
  hashContent,
  launchFinished,
  launchGroupState,
  launchMarkerPath,
  listFiles,
  markLaunchClosing,
  markLaunchFinished,
  processAlive,
  readFirstJsonLine,
  releaseSessionLease,
  revertFrom,
  samePath,
  sessionLeasePath,
  snapshotInto,
  STATE_STAMP_SCHEMA_VERSION,
  readStateStamp,
  refreshStateStamp,
} from "./runtime/sessions.mjs";
export { stateStampFile } from "./runtime/project-paths.mjs";
export { getSessionAdapter } from "./runtime/adapters/index.mjs";
export {
  appendCanonicalEvents,
  canonicalSessionRevision,
  countCanonicalEvents,
  createCanonicalSession,
  findCanonicalSessionForNative,
  listCanonicalSessionRecords,
  listCanonicalSessions,
  readCanonicalSession,
  readCanonicalSessionRecord,
  syncNativeMapping,
} from "./runtime/canonical-sessions.mjs";
export {
  PROJECTION_KIND,
  PROJECTION_SCHEMA_VERSION,
  agentLabel,
  buildProjection,
  eventAgent,
  projectableEvents,
  projectionItems,
  renderBriefing,
} from "./runtime/projection.mjs";
export { readTranscript, transcriptModel, transcriptSummary, transcriptTurns, turnPreview } from "./runtime/transcript.mjs";
export { agentCard, agentCardRows, collectStatus } from "./status.mjs";

export { fail } from "./util/fail.mjs";
export { isInside, removeEmptyDirectory } from "./util/fs.mjs";
export { readJson, writeJson } from "./util/json.mjs";
export { shortTimestamp } from "./util/stamp.mjs";
export { assertSafeId, assertSafeSkillName, assertSafeSkillPath, assertSafeSkillRoot } from "./skills/ids.mjs";
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
  cachedCatalog,
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
export { addDirectSkills, discoverDirectSkills, readDirectState, removeDirectSkills, removeExternalSkills } from "./skills/direct.mjs";
export { printTree } from "./skills/ui.mjs";
export {
  buildCatalog,
  detectSkillRoot,
  discoverSourceSkills,
  findSource,
  loadSources,
  registerSource,
  saveSources,
  stageSource,
} from "./skills/sources.mjs";
export {
  addSkillsToPacks,
  loadPacks,
  normalizePackIds,
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
  linkTargetPreference,
  logConflicts,
  removeLinkSafely,
  sameTree,
  shareTargets,
} from "./skills/links.mjs";
export { directSkillNames, removeAllInstalledSkills } from "./skills/uninstall.mjs";
