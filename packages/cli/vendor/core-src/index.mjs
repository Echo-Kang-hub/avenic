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
  applyModelConfiguration,
  ensureModelConfiguration,
  legacyModelConfiguration,
  modelConfigAgents,
  modelConfigCandidate,
  modelConfigPresence,
  modelConfigRelative,
  modelConfigTarget,
  previewModelConfiguration,
  readAccountConfiguration,
  readModelConfiguration,
  removeModelConfiguration,
} from "./runtime/model-config.mjs";
// 写入前给用户看的那一屏：逐行说清改了什么，而且**每一行都先打码** —— 预览是用户批准
// 改动时读的东西，它不能自己变成文件权限本来要防住的泄漏点。两个宿主（CLI 与扩展）都
// 渲染它，谁都不再各留一份遮罩。
export { configurationDiff, maskSecrets } from "./runtime/model-write.mjs";
// The Center's two halves: the verified preset table (what a provider is, in the
// agent's own format) and the merge that puts one in place without taking the
// file away from its owner. Both UIs render these; neither decides them.
export { CLAUDE_BLOCKS, CLAUDE_ENV, MODEL_ROLES, PROVIDERS, claudeTemplate, codexTemplate, providerForBaseUrl, providerPreset, providersForAgent } from "./runtime/providers.mjs";
// The Center's two network calls and the cache between them. Both are made only
// when a user asks for one, the credential travels in a header, and a result —
// or a cache file — is a fact about the provider that can never hold a key.
export { fetchModelCatalog, modelCatalogCachePath, readModelCatalogCache, testProviderConnection, writeModelCatalogCache } from "./runtime/model-catalog.mjs";
// What the three agents can tell Avenic, in Avenic's own six words: the matrix,
// the thresholds a dispatcher obeys, and the one translation from a native
// payload to an event both hosts read.
export { HOOK_CAPABILITIES, HOOK_EVENTS, HOOK_POLICY, hookCapability, hookFingerprint, hookSupport, normalizeHook } from "./runtime/hooks.mjs";
// The install half: which file of which native mechanism carries Avenic's entry,
// whether it is there now, and the exact bytes an install would write — a screen
// shows the plan and then calls install/uninstall, because "installed" may only
// mean one thing.
export { hookPlan, hookStatus, installHooks, uninstallHooks } from "./runtime/hook-install.mjs";
// The actions file and its one writer: what a notification is, which scope owns
// it, and the dispatch that reads both scopes when an event arrives.
export { HOOK_ACTION_KINDS, emitHook, hookActionsPath, readHookActions, readHookActionsAt, writeHookActions } from "./runtime/hook-actions.mjs";
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
export { mappingState, readTranscript, transcriptModel, transcriptSummary, transcriptTurns, turnPreview } from "./runtime/transcript.mjs";
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
