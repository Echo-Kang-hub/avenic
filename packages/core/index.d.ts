// Type declarations for @avenic/core.
// Hand-maintained next to src/index.mjs; update both in the same change.

export interface ProcessEnvLike {
  [key: string]: string | undefined;
}

export interface Agent {
  id: string;
  displayName: string;
  executable: string;
}

export interface Io {
  log(message?: string): void;
}

// ---- runtime: agents ----

export const AGENTS: Record<string, Agent>;
export function getAgent(agentId: string): Agent;
export function agentExecutableAvailable(agentId: string, environment?: ProcessEnvLike): boolean;
export function agentNpmPackage(agentId: string): string;
export function parseCliVersion(text: string): string | null;
export function compareCliVersions(left: string, right: string): number;
export type AgentInstallMethod = "standalone" | "npm-global" | "npm-local" | "brew" | "binary" | "source" | "unknown";
export interface AgentUpdateStrategy {
  kind: "standalone" | "npm-global" | "npm-local" | "brew" | "manual";
  command: string | null;
}
export interface AgentInstallation {
  executable: string | null;
  resolvedExecutable: string | null;
  version: string | null;
  installMethod: AgentInstallMethod;
  packageManager: "npm" | "brew" | null;
  updateStrategy: AgentUpdateStrategy;
}
export type AgentExecutableClassification = Omit<AgentInstallation, "version">;
// No child process: a host that only needs "is this CLI installed?" gets an answer immediately.
export function classifyAgentExecutable(agentId: string, options?: { environment?: ProcessEnvLike; cwd?: string }): AgentExecutableClassification;
export function detectAgentInstallation(agentId: string, options?: { environment?: ProcessEnvLike; cwd?: string }): AgentInstallation;
// The same record for a host that must not block its event loop (the extension host).
export function detectAgentInstallationAsync(agentId: string, options?: { environment?: ProcessEnvLike; cwd?: string }): Promise<AgentInstallation>;
export function installedCliVersion(executable: string, options?: { environment?: ProcessEnvLike }): Promise<string | null>;
export function latestPublishedVersion(agentId: string, options?: { packageSpec?: string; environment?: ProcessEnvLike; timeoutMs?: number }): Promise<string | null>;

// ---- runtime: config ----

export interface AgentRuntimeConfig {
  enabled?: boolean;
  auth?: "global" | "project";
  sessions?: "global" | "project";
  [key: string]: unknown;
}

export interface EffectiveAgentConfig {
  enabled?: boolean;
  auth: "global" | "project";
  sessions: "global" | "project";
  configuredAuth: "global" | "project";
  localAuth: "global" | "project" | null;
}

export interface RuntimePaths {
  localRoot: string;
  runtimeFile: string;
  localRuntimeFile: string;
  sessionsRoot: string;
}

export interface RuntimeState {
  paths: RuntimePaths;
  runtime: { schemaVersion?: number; activeCanonicalSessionId?: string; sessionInterop?: "shared" | "isolated"; agents?: Record<string, AgentRuntimeConfig> };
  local: { schemaVersion?: number; agents?: Record<string, { auth?: "global" | "project" }> };
}

export function validateAuthMode(authMode: unknown): "global" | "project";
export function validateSessionsMode(sessionsMode: unknown): "global" | "project";
export function validateSessionInteropMode(mode: unknown): "shared" | "isolated";
export interface ProjectConfig {
  agents: Record<string, { auth: "global" | "project"; sessions: "global" | "project" }>;
  sessionInterop: "shared" | "isolated";
}
export function projectConfig(state: RuntimeState): ProjectConfig;
export function configureProject(projectRoot: string, draft?: Partial<ProjectConfig>): Promise<RuntimeState & { configChanged: boolean; gitignoreChanged: boolean; config: ProjectConfig }>;

// ---- the project-setup questions, shared by every host UI ----
//
// `avenic init`, `avenic change` and the VS Code extension ask the same things
// in the same order and must write the same configuration. The questions live
// in core; a host only decides how to draw a step.
export interface ProjectDraft {
  selected: string[];
  agents: Record<string, { auth: "global" | "project"; sessions: "global" | "project" }>;
  sessionInterop: "shared" | "isolated";
}
export interface ProjectWizardChoice<T = unknown> {
  value: T;
  label: string;
}
/**
 * `D` is the draft a step reads and writes. Core's own steps draft a
 * `ProjectDraft`; a host may declare steps over a smaller draft (the VS Code
 * per-agent Initialize flow does) and walk them with the same driver.
 */
export interface ProjectWizardStep<D = ProjectDraft> {
  id: string;
  kind: "single" | "multi";
  title: string;
  description?: string;
  options: ProjectWizardChoice[];
  /** multi: the currently chosen values. */
  values?: (draft: D) => string[];
  minSelected?: number;
  emptyMessage?: string;
  /** single: the currently chosen value. */
  value?: (draft: D) => unknown;
  write?: (draft: D, value: unknown) => void;
  /** One dim line: what this step's answer was, for an answered step. */
  summary?: (draft: D) => string;
  apply?: boolean;
  appliedTitle?: string;
}
export function agentChoices(): ProjectWizardChoice<string>[];
export function projectDraft(config: ProjectConfig): ProjectDraft;
export function projectWizardSteps(draft: ProjectDraft, editing?: boolean): ProjectWizardStep<ProjectDraft>[];
export function projectDraftSubmission(draft: ProjectDraft): Pick<ProjectConfig, "agents" | "sessionInterop">;
export function applyProjectDraft(
  projectRoot: string,
  draft: ProjectDraft,
  options?: { environmentForAgent?: (agentId: string) => Record<string, string | undefined> },
): Promise<{ previous: "shared" | "isolated"; mode: "shared" | "isolated"; imported: unknown[]; config: ProjectConfig }>;
export function runtimePaths(projectRoot: string): RuntimePaths;
export function loadRuntime(projectRoot: string): Promise<RuntimeState>;
export function getActiveCanonicalSessionId(projectRoot: string): Promise<string | null>;
export function setActiveCanonicalSession(projectRoot: string, canonicalSessionId: string | null): Promise<string | null>;
export function initializeAgent(
  projectRoot: string,
  agentId: string,
  authMode?: "global" | "project",
  sessionsMode?: "global" | "project",
): Promise<RuntimeState & { authMode: string; sessionsMode: string; configChanged: boolean; gitignoreChanged: boolean; structureRepaired: boolean }>;
export function projectAuthEnvironment(agentId: string, projectRoot: string): Record<string, string>;
export function deinitializeAgent(
  projectRoot: string,
  agentId: string,
  options?: { purge?: boolean },
): Promise<{ agent: Agent; changed: boolean; purged: boolean; remaining: number }>;
export function setLocalAuth(projectRoot: string, agentId: string, authMode: "global" | "project"): Promise<EffectiveAgentConfig>;
export function clearLocalAuth(projectRoot: string, agentId: string): Promise<EffectiveAgentConfig>;
export function effectiveAgentConfig(state: RuntimeState, agentId: string): EffectiveAgentConfig | null;
export interface AgentRuntimeMode {
  auth: {
    default: "global" | "project";
    localOverride: "global" | "project" | null;
    effective: "global" | "project";
  };
  sessions: { mode: "global" | "project" };
}
export function getAgentRuntimeMode(projectRoot: string, agentId: string): Promise<AgentRuntimeMode | null>;
export interface EffectiveAgentRuntime {
  executable: string;
  authScope: "global" | "project";
  provider: string | null;
  endpoint: string | null;
  model: string | null;
  config: EffectiveAgentConfig;
  profile: unknown;
  argumentsList: string[];
  environment: ProcessEnvLike;
  note: string | null;
}
export function agentEnvironment(state: RuntimeState, projectRoot: string, agentId: string): ProcessEnvLike;
export function resolveEffectiveAgentRuntime(
  projectRoot: string,
  agentId: string,
  options?: { state?: RuntimeState; environment?: ProcessEnvLike; argumentsList?: string[]; io?: Io },
): Promise<EffectiveAgentRuntime>;

// ---- runtime: gitignore / project-root / process / sessions / adapters ----

export const REQUIRED_RULES: readonly string[];
export const SESSIONS_RULE: string;
export function ensureRuntimeGitignore(projectRoot: string): Promise<boolean>;
export function removeRuntimeGitignore(projectRoot: string, options?: { sessions?: boolean }): Promise<unknown>;
export function sessionsGitIgnored(projectRoot: string): Promise<boolean>;
export function setSessionsGitIgnored(projectRoot: string, ignored: boolean): Promise<boolean>;

export function locateProjectRoot(startDirectory?: string): string;
export function enclosingProjectRoot(startDirectory?: string, options?: { includeStart?: boolean }): string | null;
export function spawnExecutableSync(
  executable: string,
  argumentsList: string[],
  options?: {
    cwd?: string;
    env?: ProcessEnvLike;
    stdio?: "pipe" | "inherit" | "ignore";
    encoding?: string;
    windowsHide?: boolean;
    capture?: boolean;
    spawn?: (executable: string, argumentsList: string[], options: unknown) => unknown;
  },
): { status: number | null; stdout?: string; stderr?: string; error?: Error };
export function spawnExecutable(
  executable: string,
  argumentsList: string[],
  options?: {
    cwd?: string;
    env?: ProcessEnvLike;
    stdio?: "pipe" | "inherit" | "ignore";
    capture?: boolean;
  },
): Promise<{ status: number | null; stdout: string; stderr: string; error: Error | null }>;
export function resolveOnPath(executable: string, environment: { PATH?: string; Path?: string }): string | null;

export const PROJECT_ROOT_TOKEN: string;
export interface SessionLease {
  member: string;
  stateDir: string;
  release: () => Promise<unknown>;
}
export interface SessionLeaseCallbacks {
  onFirst?: (recovering: boolean) => Promise<void>;
  onLast?: () => Promise<void>;
}
export function acquireSessionLease(agentId: string, projectRoot: string, callbacks?: SessionLeaseCallbacks): Promise<SessionLease>;
export function releaseSessionLease(agentId: string, projectRoot: string, member: string, callbacks?: SessionLeaseCallbacks): Promise<unknown>;
export function sessionLeasePath(agentId: string, projectRoot: string): string;
// Whether a launch of this agent owns the project right now: "running" means a
// live process holds the lease, "interrupted" means one died without finishing
// its exit sequence, "idle" means nothing to recover from.
export function launchGroupState(agentId: string, projectRoot: string): Promise<"idle" | "running" | "interrupted">;
export function processAlive(pid: number): boolean;
// The part of an environment a detached launch helper keeps: the variables that
// locate an agent's native storage and home directory, and nothing credential
// shaped. Whatever writes launch state to disk writes this, not the environment
// it was handed.
export function durableEnvironment(environment?: ProcessEnvLike): ProcessEnvLike;
export function samePath(left: string, right: string): boolean;
export function normalizeProjectIdentity(value: string): string | null;
export function hashContent(content: string): string;
export function readFirstJsonLine(file: string): Promise<unknown | null>;
export function listFiles(sourcePath: string): Promise<string[]>;
export function snapshotFiles(sourceRoot: string, relativeFiles: string[], destination: string, transform?: (content: string) => string): Promise<unknown>;
export function snapshotInto(source: string, destination: string): Promise<unknown>;
export function revertFrom(snapshot: string, source: string): Promise<unknown>;
export function replaceDirectory(destination: string, build: (destination: string) => Promise<unknown>): Promise<unknown>;
export function mergeFiles(sourceRoot: string, relativeFiles: string[], destinationRoot: string, transform?: (content: string) => string, options?: { filter?: (relativePath: string) => boolean }): Promise<unknown>;
export function transformJsonLines(content: string, transform: (value: unknown) => unknown): string;

// ---- runtime: canonical sessions ----

export interface CanonicalEvent {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  createdAt: string;
  content: Array<{ type: string; [key: string]: unknown }>;
  [key: string]: unknown;
}
export interface NativeSessionMapping {
  agentId: string;
  nativeSessionId: string;
  nativeRevision?: string | null;
  canonicalRevision?: string | null;
  projectionHash?: string | null;
  lastCanonicalEventId?: string | null;
  lastSyncedAt?: string;
  diagnostics?: unknown[];
}
export interface ContinuationResult {
  nativeSessionId: string;
  nativeRevision?: string | null;
  projectionHash?: string | null;
  diagnostics?: unknown[];
}
export function createCanonicalSession(projectRoot: string, input?: Record<string, unknown>): Promise<{ id: string; created: boolean }>;
export function listCanonicalSessions(projectRoot: string): Promise<Array<{ id: string; title?: string; updatedAt?: string }>>;
// The session records themselves, newest first, without reading any event log:
// same directories as listCanonicalSessions, but carrying the counts a status
// view needs (eventCount and lastEventId are absent on records written before
// they were stored; countCanonicalEvents fills that in for one session).
export interface CanonicalSessionRecord {
  id: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  eventCount?: number;
  lastEventId?: string | null;
  [key: string]: unknown;
}
export function listCanonicalSessionRecords(projectRoot: string): Promise<CanonicalSessionRecord[]>;
export function countCanonicalEvents(projectRoot: string, id: string): Promise<number>;
export function observeSharedNativeSessions(projectRoot: string, agentId: string, options?: Record<string, unknown>): Promise<{ changed: boolean; imported: number; diagnostics: unknown[] }>;
export function formatSessionDiagnostics(diagnostics?: unknown[]): { warnings: string[]; notes: string[] };
export interface LaunchGroup {
  member: string;
  release: () => Promise<unknown>;
}
export function joinLaunchGroup(projectRoot: string, agentId: string, options?: { environment?: ProcessEnvLike }): Promise<LaunchGroup | null>;
export function finishLaunch(
  projectRoot: string,
  agentId: string,
  options?: {
    environment?: ProcessEnvLike;
    /** The launch's membership, or null when the agent's storage is not isolated for the run. */
    member?: string | null;
    setActive?: boolean;
    /** Runs after the exit capture and before the last member restores native storage. */
    beforeRevert?: (context: { environment: ProcessEnvLike; projectRoot: string }) => Promise<void>;
  },
): Promise<{ changed: boolean; imported: number; diagnostics: unknown[] }>;
export function recoverSharedNativeSessions(projectRoot: string, agentIds: string[], options?: Record<string, unknown>): Promise<Array<{ agentId: string; changed: boolean; diagnostic?: string }>>;
export function importProjectSessions(projectRoot: string, agentId: string, options?: Record<string, unknown>): Promise<{ count: number; changed: boolean; discovered: number; imported: number; unchanged: number; failed: number; diagnostics: string[] }>;
export function setSessionInteropMode(projectRoot: string, mode: "shared" | "isolated", options?: { agents?: ProjectConfig["agents"]; environmentForAgent?: (agentId: string) => ProcessEnvLike }): Promise<{ previous: "shared" | "isolated"; mode: "shared" | "isolated"; imported: unknown[]; config: ProjectConfig }>;
export function applyProjectConfiguration(projectRoot: string, draft: Pick<ProjectConfig, "agents" | "sessionInterop">, options?: { environmentForAgent?: (agentId: string) => ProcessEnvLike }): Promise<{ previous: "shared" | "isolated"; mode: "shared" | "isolated"; imported: unknown[]; config: ProjectConfig }>;
export function readCanonicalSession(projectRoot: string, id: string): Promise<{ session: Record<string, unknown>; events: CanonicalEvent[]; mappings: { projections: Record<string, NativeSessionMapping> } }>;
// One canonical conversation, read as a timeline. Both hosts render this and
// neither computes a second answer: a turn belongs to the agent that produced
// it, and "You" is only ever the person at the keyboard.
export const TRANSCRIPT_SCHEMA_VERSION: number;
export interface TranscriptTool {
  kind: "call" | "result";
  name: string;
  detail?: string | null;
}
export interface TranscriptTurn {
  id: string;
  kind: "user" | "agent" | "tool";
  agent: string | null;
  speaker: string;
  role: string;
  at: string | null;
  text: string;
  tools: TranscriptTool[];
  model: string | null;
  provider: string | null;
}
export interface TranscriptProjection {
  agentId: string;
  label: string;
  nativeSessionId: string;
  state: "current" | "stale" | "none";
  lastSyncedAt: string | null;
  provenance: string | null;
}
export interface TranscriptSummary {
  schemaVersion: number;
  id: string | null;
  title: string;
  revision: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  events: number;
  turns: number;
  userTurns: number;
  agents: string[];
  startedAt: string | null;
  endedAt: string | null;
  lastEventId: string | null;
  projections: TranscriptProjection[];
}
export function transcriptTurns(events: CanonicalEvent[], options?: { limit?: number }): TranscriptTurn[];
export function transcriptSummary(session: Record<string, unknown>, events: CanonicalEvent[], record?: Record<string, unknown>): TranscriptSummary;
export function readTranscript(projectRoot: string, id: string, options?: { record?: unknown; limit?: number }): Promise<{ summary: TranscriptSummary; turns: TranscriptTurn[]; session: Record<string, unknown>; events: CanonicalEvent[] }>;
/** The one data shape behind `avenic sessions show <id> --json` and the VS Code Sessions page. */
export interface TranscriptModel {
  schemaVersion: number;
  session: Omit<TranscriptSummary, "schemaVersion">;
  turns: TranscriptTurn[];
}
export function transcriptModel(reading: { summary: TranscriptSummary; turns: TranscriptTurn[] }): TranscriptModel;
export function turnPreview(turn: TranscriptTurn, limit?: number): string;
/** Agent display name ("Claude", "Codex", "OpenCode"). */
export function agentLabel(agentId: string): string;
export function appendCanonicalEvents(projectRoot: string, id: string, events: CanonicalEvent[]): Promise<{ added: number; duplicate: number }>;
export function canonicalSessionRevision(events: CanonicalEvent[]): string;
export function syncNativeMapping(projectRoot: string, id: string, mapping: NativeSessionMapping): Promise<NativeSessionMapping>;
export function prepareCanonicalContinuation(projectRoot: string, canonicalId: string, targetAgent: string): Promise<unknown>;
export function completeCanonicalContinuation(projectRoot: string, canonicalId: string, targetAgent: string, result: ContinuationResult): Promise<NativeSessionMapping>;
export function reconcileCanonicalSession(projectRoot: string, canonicalId: string, options?: {
  environment?: ProcessEnvLike;
  environmentForAgent?: (agentId: string) => ProcessEnvLike;
}): Promise<Array<{ agentId: string; stale?: boolean; nativeSessionId?: string; added?: number; duplicate?: number }>>;
export function continueCanonicalSession(options: {
  projectRoot: string;
  canonicalId: string;
  targetAgent: string;
  capture(stage: "before" | "after", context?: unknown): Promise<{ nativeSessionId?: string; nativeRevision?: string; events?: CanonicalEvent[] } | null>;
  launch(continuation: unknown): Promise<ContinuationResult>;
}): Promise<unknown>;

export interface SessionAdapterResult {
  count: number;
  changed?: boolean;
  added?: number;
  updated?: number;
  conflicts?: number;
}
export interface SessionAdapter {
  capture(projectRoot: string, options?: { environment?: ProcessEnvLike }): Promise<SessionAdapterResult>;
  restore(projectRoot: string, options?: { environment?: ProcessEnvLike }): Promise<SessionAdapterResult>;
  status(projectRoot: string, options?: { environment?: ProcessEnvLike }): Promise<{ count: number }>;
  snapshotNative?: (projectRoot: string, snapshotRoot: string, options?: { environment?: ProcessEnvLike }) => Promise<void>;
  revertNative?: (snapshotRoot: string, projectRoot: string, options?: { environment?: ProcessEnvLike }) => Promise<void>;
}
export function getSessionAdapter(agentId: string): SessionAdapter;

// ---- util ----

export function fail(message: string): never;
export function isInside(directory: string, target: string): boolean;
export function removeEmptyDirectory(directory: string): Promise<unknown>;
export function readJson(file: string): Promise<any>;
export function writeJson(file: string, value: unknown): Promise<unknown>;
// The one way Avenic renders a moment — "2026-09-19 14:03" in the reader's own
// time zone, or null when the value cannot be read as a date. Shared so no host
// invents a second format for the same timestamp.
export function shortTimestamp(value?: Date | string | number): string | null;

// ---- skills: ids ----

export function assertSafeId(value: string, label?: string): string;
export function assertSafeSkillName(value: string): string;
export function assertSafeSkillPath(value: string): string;
export function assertSafeSkillRoot(value: string): string;
export function assertSafeRelativePath(value: string): string;

// ---- skills: paths ----

export const PROJECT_CONFIG_FILE: string;
export const PROJECT_LOCK_FILE: string;
export const LEGACY_PROFILE_FILE: string;
export interface InstallTarget {
  id: string;
  agents: string[];
  label: string;
  destination: string;
  relativePath?: string[];
  shareFrom?: string;
  shareDestination?: string;
}
export const MANAGED_AGENT_ORDER: string[];
export const PROJECT_TARGETS: Array<{ id: string; agents: string[]; label: string; relativePath: string[]; shareFrom?: string }>;
export const GLOBAL_TARGETS: InstallTarget[];
export function stateRoot(environment?: ProcessEnvLike): string;
export function catalogCacheRoot(environment?: ProcessEnvLike): string;
export function catalogLayout(catalogRoot: string): { skills: string; packs: string; sourcesFile: string; licenses: string };
export function defaultCatalogFile(environment?: ProcessEnvLike): string;
export function knownCatalogsFile(environment?: ProcessEnvLike): string;
export function globalConfigFile(environment?: ProcessEnvLike): string;
export function globalLockFile(environment?: ProcessEnvLike): string;

// ---- skills: git / catalog / sources / packs ----

export function git(argumentsList: string[], options?: { cwd?: string; capture?: boolean; env?: ProcessEnvLike }): Promise<string>;
export function run(command: string, argumentsList: string[], options?: { cwd?: string; capture?: boolean; env?: ProcessEnvLike }): Promise<string>;
export function gitExecutable(environment?: ProcessEnvLike): string;
export function classifyGitFailure(stderr: string): { kind: GitFailureKind; hint: string };
export type GitFailureKind = "authentication" | "repo-missing" | "ref-missing" | "git-missing" | "network" | "cache-filesystem" | "unknown";
export function gitFailure(kind: GitFailureKind, options?: { detail?: string; hint?: string }): Error & { kind: GitFailureKind };
export function normalizeRepositoryInput(reference: string): string;
export function deriveSourceId(repository: string): string;
export function repositoryIdentity(repository: string): string;
export function remoteHead(source: Source): Promise<string>;
export function cloneHead(source: { repository: string }, directory: string): Promise<string>;
export function cloneRevision(source: Source, directory: string): Promise<string>;
export function currentRepositoryState(catalogRoot: string): Promise<{ repository: string | null; revision: string | null; dirty: boolean | null }>;

export interface KnownCatalogEntry {
  name: string;
  spec: string;
}
export function parseCatalogSpec(spec: string): { repository: string; ref: string };
export function catalogDisplayName(spec: string): string;
export function loadDefaultCatalogSpec(environment?: ProcessEnvLike): Promise<string>;
export function setDefaultCatalogSpec(environment: ProcessEnvLike | undefined, spec: string): Promise<unknown>;
export function loadKnownCatalogs(environment?: ProcessEnvLike): Promise<KnownCatalogEntry[]>;
export function registerKnownCatalog(environment: ProcessEnvLike | undefined, spec: string): Promise<unknown>;
export interface CatalogInfo {
  catalogRoot: string;
  repository: string;
  ref: string;
  revision: string;
  shortSha: string;
  // 从缓存读出来的 Catalog 没有「刚刚同步」这个时间，所以是 null。
  syncedAt: string | null;
  spec: string;
}
export function catalogCacheDirectory(spec: string, environment?: ProcessEnvLike): string;
export function shortRevision(revision: string): string;
export function hubSyncSummary(info: { revision: string }, date?: Date): string;
export function ensureCatalog(spec: string, options?: { environment?: ProcessEnvLike; io?: Io }): Promise<CatalogInfo>;
// 只读缓存地取 Catalog：缓存答不上来返回 null，绝不 clone/fetch。浏览路径（内容树）
// 走这个，联网路径（hub add / hub sync / 安装）走 ensureCatalog。
export function cachedCatalog(spec: string, environment?: ProcessEnvLike): Promise<CatalogInfo | null>;
export function registerCatalog(spec: string, options?: { environment?: ProcessEnvLike; io?: Io }): Promise<{
  spec: string;
  catalogInfo?: CatalogInfo;
  packs: Pack[];
  previewFailed: boolean;
  error?: Error;
}>;

export interface Source {
  id: string;
  name: string;
  repository: string;
  revision: string;
  skillRoot?: string;
  licenseFile?: string;
  skillPaths?: Record<string, string>;
}
export interface SourcesConfig {
  schemaVersion?: number;
  sources: Source[];
}
export function loadSources(catalogRoot: string): Promise<SourcesConfig>;
export function saveSources(catalogRoot: string, sourceConfig: SourcesConfig): Promise<unknown>;
export function registerSource(catalogRoot: string, sourceConfig: SourcesConfig, input: Partial<Source>, io?: Io): Promise<Source>;
export function findSource(sourceConfig: SourcesConfig, reference: string): Source | null;
export function detectSkillRoot(cloneDirectory: string): Promise<string>;
export function discoverSourceSkills(source: Source, cloneDirectory: string, options?: unknown): Promise<{ names: string[]; mappingsChanged: boolean }>;
export function readSkill(skillDirectory: string, requireMatchingFolder?: boolean): Promise<{ name: string; directory: string }>;
export function parseFrontmatterName(content: string, file: string): string;
export function stageSource(source: Source, cloneDirectory: string, stageDirectory: string, skillNames: string[]): Promise<unknown>;
export interface CatalogSkill {
  name: string;
  directory: string;
  source: Source;
}
export interface Catalog {
  groups: SkillGroup[];
  byName: Map<string, CatalogSkill>;
}
export function buildCatalog(sourceConfig: SourcesConfig, skillsRoot: string): Promise<Catalog>;
export function printTree(groups: SkillGroup[], title: string, header: string[], io?: Io): void;

export interface PackSelection {
  source: string;
  skills: string[];
}
export interface Pack {
  schemaVersion?: number;
  id: string;
  name: string;
  description?: string;
  sources: PackSelection[];
}
export interface SkillGroup {
  source: Source;
  skills: CatalogSkill[];
}
export interface ResolvedPacks {
  groups: SkillGroup[];
  names: string[];
  packs: Pack[];
  duplicateSelections: number;
}
export function loadPacks(catalogRoot: string): Promise<Map<string, Pack>>;
export function parsePackArguments(argumentsList: string[]): string[];
export function normalizePackIds(packIds: string[]): string[];
export function resolvePack(catalog: Catalog, sourceConfig: SourcesConfig, pack: Pack): { groups: SkillGroup[]; names: string[]; pack: Pack };
export function resolvePacks(catalog: Catalog, sourceConfig: SourcesConfig, packs: Map<string, Pack>, requestedPackIds: string[]): ResolvedPacks;
export function packContainsSkill(pack: Pack, sourceId: string, skillName: string): boolean;
export function skillCoveredByPacks(packs: Map<string, Pack>, packIds: string[], sourceId: string, skillName: string): boolean;
export function catalogReferences(packs: Map<string, Pack>): Set<string>;
export function addSkillsToPacks(catalogRoot: string, packIds: string[], sourceId: string, skillNames: string[]): Promise<{ added: Array<{ packId: string; skillName: string }>; inherited: string[] }>;
export function pruneCatalogSkills(catalogRoot: string, sourceConfig: SourcesConfig, packs: Map<string, Pack>, candidates: Array<{ sourceId: string; skillName: string }>): Promise<{ removed: Array<{ sourceId: string; skillName: string }>; removedSources: string[] }>;

// ---- skills: vendor / install / direct ----

export function createTempDirectory(catalogRoot: string): Promise<string>;
export function removeTempDirectory(directory: string, io?: Io): Promise<unknown>;
export function replaceStagedFiles(
  replacements: Array<{ relativePath: string; staged: string; target: string }>,
  tempDirectory: string,
  options?: { rename?: (from: string, to: string) => Promise<unknown> },
): Promise<unknown>;

export interface InstallContext {
  configFile: string;
  environment: ProcessEnvLike;
  global: boolean;
  label: string;
  legacyProfileFile?: string;
  lockFile: string;
  root: string;
  targets: InstallTarget[];
}
export function isCatalogDirectory(directory: string): boolean;
export function createInstallContext(global: boolean, options?: { cwd?: string; environment?: ProcessEnvLike; migrate?: boolean }): InstallContext;
export function canonicalTargets(context: InstallContext): InstallTarget[];
export function shareTargets(context: InstallContext): InstallTarget[];
// 这个 scope 上次选定的落链目标（锁文件记的）；null = 还没选过，全部适用。
export function linkTargetPreference(context: InstallContext): Promise<string[] | null>;
export function normalizeLinkTarget(linkPath: string, rawTarget: string): string;
export function readLinkTarget(linkPath: string): Promise<string | null>;
export function createSkillLink(canonicalPath: string, linkPath: string): Promise<void>;
export function removeLinkSafely(linkPath: string): Promise<boolean>;
export type ShareEntryState = "absent" | "linked" | "repair" | "real-directory" | "conflict";
export interface ShareEntryVerdict {
  state: ShareEntryState;
  reason?: string;
  target?: string;
}
export function classifyShareEntry(canonicalPath: string, linkPath: string): Promise<ShareEntryVerdict>;
export function sameTree(left: string, right: string): Promise<boolean>;
export interface LinkCounts {
  linked: number;
  repaired: number;
  migrated: number;
  fallback: number;
  conflict: number;
  unchanged: number;
  skipped: number;
}
export interface LinkConflict {
  name: string;
  targetId: string;
  reason?: string;
}
export function ensureSkillLinks(
  context: InstallContext,
  names: Iterable<string>,
  // restoreCopy: false 用于 canonical 更新前的预检趟——建链失败时不落拷贝（默认 true）。
  // targets：只处理这些 share target id（省略 = 全部）。
  options?: {
    io?: Io;
    silent?: boolean;
    restoreCopy?: boolean;
    targets?: string[];
    createLink?: (canonicalPath: string, linkPath: string) => Promise<void>;
  },
): Promise<{ counts: LinkCounts; conflicts: LinkConflict[]; targets: Record<string, LinkCounts> }>;
export function formatLinkSummary(counts: LinkCounts): string;
export function linkSummaryChanged(counts: LinkCounts): boolean;
export function logConflicts(io: Io, conflicts: LinkConflict[]): void;
export function resolveInstallPacks(context: InstallContext, explicitPacks: string[]): Promise<string[]>;
export function previousManagedState(context: InstallContext): Promise<Map<string, { sourceId: string; revision: string }>>;
export function managedSkillNames(context: InstallContext): Promise<Set<string>>;
export function installedPackIds(context: InstallContext): Promise<string[] | null>;
export function installCopies(context: InstallContext, resolvedPacks: ResolvedPacks, io?: Io, options?: { targets?: string[] | null }): Promise<unknown>;
export function writeInstallMetadata(context: InstallContext, resolvedPacks: ResolvedPacks, catalogInfo?: Partial<CatalogInfo> & { packageMetadata?: unknown }, options?: { targets?: string[] | null }): Promise<unknown>;
export function removeAllManagedSkills(context: InstallContext, managed: Map<string, unknown>, io?: Io): Promise<number>;
export function removeSkillDirectories(context: InstallContext, skillNames: string[], io?: Io): Promise<number>;
export function removeInstallationFiles(context: InstallContext): Promise<unknown>;
export function directSkillNames(context: InstallContext): Promise<string[]>;
export function removeAllInstalledSkills(context: InstallContext, io?: Io): Promise<{ direct: number; managed: number }>;
export function resolveInstallSource(options: { global?: boolean; cwd?: string; environment?: ProcessEnvLike; io?: Io }, opts?: { refresh?: boolean }): Promise<CatalogInfo & { packageMetadata: unknown }>;
export function installPacks(context: InstallContext, explicitPacks?: string[], options?: { io?: Io; onPlan?: (resolvedPacks: ResolvedPacks) => void; targets?: string[]; refresh?: boolean }): Promise<{ catalogInfo: CatalogInfo; packIds: string[]; resolvedPacks: ResolvedPacks; targets: string[] | null }>;
export function uninstallPacks(context: InstallContext, packArguments?: string[], options?: { io?: Io; onPlan?: (resolvedPacks: ResolvedPacks, removed: string[]) => void }): Promise<{ changed: boolean; removed: string[]; absent: string[]; skippedCommon: boolean; current: string[] | null; resolvedPacks?: ResolvedPacks }>;
export interface InstallTargetStatus extends InstallTarget {
  present: number;
  total: number;
  complete: boolean;
  state: "canonical" | "linked" | "fallback" | "missing" | "conflict";
  counts: {
    present?: number;
    total?: number;
    linked?: number;
    fallback?: number;
    missing?: number;
    conflict?: number;
    unmanaged?: number;
  };
  conflicts?: LinkConflict[];
}
export interface InstallStatus {
  groups: SkillGroup[];
  packs: Array<{ id?: string; name?: string } | string>;
  names: string[];
  // 受管集合（Pack + adopted + 直装）；names 是展示集合，不含直装名。
  managedNames: string[];
  targets: InstallTargetStatus[];
  state: "optimized" | "degraded" | "incomplete";
  operational: boolean;
  optimized: boolean;
  degraded: boolean;
  incomplete: boolean;
}
export function skillsInstallationStatus(context: InstallContext): Promise<InstallStatus | null>;
export function detectedSkillNames(context: InstallContext): Promise<string[]>;
export function unmanagedSkillNames(status: Pick<InstallStatus, "managedNames"> | null, detected: string[]): string[];
export function adoptSkills(
  context: InstallContext,
  skillNames: string[],
  options?: { io?: Io; createLink?: (canonicalPath: string, linkPath: string) => Promise<void> },
): Promise<{ adopted: string[]; placed: number; linked: number }>;

export interface AdoptPackCandidate {
  packId: string;
  packName: string;
  coverage: number;
  matched: string[];
  missing: number;
}
export function planAdoptSkills(
  context: InstallContext,
  skillNames: string[],
): Promise<{ candidates: AdoptPackCandidate[]; best: AdoptPackCandidate | null }>;
export function adoptPackedSkills(
  context: InstallContext,
  skillNames: string[],
  packId: string,
): Promise<{ packId: string; names: string[]; matched: string[] }>;

export interface DirectSourceState {
  directSources: Array<Source & { skills: string[] }>;
  // 与 Pack 安装共用同一个「落链目标」记忆（见 linkTargetPreference）。
  targets?: string[];
}
export function directRoot(context: InstallContext): string;
export function directLicensesRoot(context: InstallContext): string;
export function readDirectState(context: InstallContext): Promise<DirectSourceState>;
export function writeDirectState(context: InstallContext, state: DirectSourceState): Promise<unknown>;
export function addDirectSkills(context: InstallContext, sourceReference: string, skillNames: string[], options?: { io?: Io; targets?: string[]; createLink?: (canonicalPath: string, linkPath: string) => Promise<void> }): Promise<{ names: string[]; sourceId: string; revision: string; alreadyInstalled?: boolean }>;
// 克隆并列出直装源发布的 Skill，不安装任何东西（Add 流程的发现步骤）。
export function discoverDirectSkills(context: InstallContext, sourceReference: string): Promise<{ sourceId: string; revision: string; skillRoot: string | undefined; names: string[] }>;
export function removeDirectSkills(context: InstallContext, skillNames: string[]): Promise<string[]>;
export function removeExternalSkills(context: InstallContext, skillNames: string[], options?: { io?: Io }): Promise<{ directRemoved: string[]; removedDirectories: number }>;

// ---- model: paths & schema ----
export const PROJECT_MODEL_FILE: string;
export const CLAUDE_SETTINGS_FILE: string;
export const LIBRARY_SCHEMA_VERSION: number;
export const PROJECT_SCHEMA_VERSION: number;
export const MODEL_ROLES: readonly ModelRole[];
// 这两个清单就是各自的合法取值集合（runtime 是数组，元素与下面的字面量类型一一对应）。
export const API_TYPES: readonly ApiType[];
export const AUTH_FIELDS: readonly string[];
// Codex reasoningEffort 的合法取值（面板下拉框的唯一来源；不在表内 core 会静默落到 medium）。
export const CODEX_EFFORTS: readonly string[];
export const TOGGLE_KEYS: readonly (keyof ProfileToggles)[];
// 有 `ANTHROPIC_DEFAULT_<SUFFIX>_MODEL` 别名的角色 → 别名后缀。面板据此决定哪几行提供
// 「显示名」输入框（display 只会被投影成这几个角色的 `_MODEL_NAME`），以及每行实际写哪个键。
export const ROLE_KEYS: Readonly<Record<string, string>>;
export type ApiType = "anthropic" | "openai-chat" | "openai-responses";
export type ModelRole = "main" | "opus" | "sonnet" | "haiku" | "fable" | "subagent";
export interface ModelRow { id: string; display?: string; longContext?: boolean }
export interface EndpointConfig { baseUrl: string; api: ApiType; authField: string; apiKey: string }
// normalizeProfile 的入参形态：只有 baseUrl 是必填，其余由 normalizeEndpoint 补默认值
// （api → "anthropic"、authField → "ANTHROPIC_AUTH_TOKEN"、apiKey → ""）。这里写成 Partial
// 才和运行时一致 —— 旧的 `Partial<ModelProfile>` 是浅的，会逼调用方编一份假的完整 endpoint。
export interface EndpointInput { baseUrl: string; api?: ApiType; authField?: string; apiKey?: string }
export interface ProfileOverrides { codex?: EndpointConfig & { providerId?: string }; opencode?: EndpointConfig & { providerId?: string } }
export interface ProfileToggles { teams?: boolean; toolSearch?: boolean; maxEffort?: boolean; noNonessentialTraffic?: boolean; noAutoUpdate?: boolean; hideAttribution?: boolean }
export interface ModelProfile {
  id: string;
  name: string;
  endpoint: EndpointConfig;
  overrides: ProfileOverrides;
  models: Partial<Record<ModelRole, ModelRow>>;
  toggles: ProfileToggles;
  env: Record<string, string>;
  claude: { settings: Record<string, unknown> };
  codex: { providerId: string; envKey: string; reasoningEffort: "minimal" | "low" | "medium" | "high" };
  opencode: { providerId: string; npmAdapter: string };
  createdAt: string;
  updatedAt: string;
}
export function modelsFile(environment?: ProcessEnvLike): string;
export function modelsTempRoot(environment?: ProcessEnvLike): string;
export function projectModelFile(projectRoot: string): string;
export function projectTempRoot(projectRoot: string): string;
export function claudeSettingsFile(projectRoot: string): string;
export function emptyLibrary(): { schemaVersion: number; revision: number; profiles: Record<string, ModelProfile> };
export type ModelProfileInput = Partial<Omit<ModelProfile, "id" | "endpoint" | "overrides" | "toggles" | "codex" | "opencode">> & {
  id: string;
  endpoint: EndpointInput;
  // 覆盖只有 codex/opencode 两个，且 baseUrl 之外的字段都能省略（缺省继承主端点）。
  overrides?: Partial<Record<"codex" | "opencode", EndpointInput & { providerId?: string }>>;
  // 只有 TOGGLE_KEYS 里的开关会被读（`input.toggles?.[key] === true`），其余键被丢弃。
  toggles?: ProfileToggles;
  // codex / opencode 的字段全部可省：runtime 用 `??` 兜底（providerId → `avenic_<id>` 等）。
  codex?: Partial<ModelProfile["codex"]>;
  opencode?: Partial<ModelProfile["opencode"]>;
};
export function normalizeProfile(input: ModelProfileInput, options?: { now?: string; existing?: ModelProfile | null }): ModelProfile;
export function validateBaseUrl(value: string): string;
export function validateProviderId(value: string): string;
export function validateEnvKey(value: string): string;
export function validateModelId(value: string): string;
export function maskSecret(value: unknown): string;
export function canonicalJson(value: unknown): string;
export function libraryFingerprint(profile: ModelProfile): string;

// ---- model: transaction & library ----
export interface ModelLibrary { schemaVersion: number; revision: number; profiles: Record<string, ModelProfile>; exists: boolean; file: string }
export interface TransactOptions<T> {
  read: () => Promise<{ revision: number; value: T }>;
  build: (current: { revision: number; value: T }) => T | null;
  stage: (next: T, directory: string) => Promise<Array<{ relativePath: string; staged?: string; target: string; remove?: boolean }>>;
  tempRoot: string;
  attempts?: number;
  rename?: (from: string, to: string) => Promise<unknown>;
  commit?: (replacements: Array<{ relativePath: string; staged?: string; target: string; remove?: boolean }>, directory: string) => Promise<void>;
}
export function transact<T>(options: TransactOptions<T>): Promise<{ changed: boolean; value: T; revision: number }>;
export function readLibrary(environment?: ProcessEnvLike): Promise<ModelLibrary>;
export function listProfiles(environment?: ProcessEnvLike): Promise<ModelProfile[]>;
export function getProfile(environment: ProcessEnvLike | undefined, id: string): Promise<ModelProfile | null>;
export function upsertProfile(environment: ProcessEnvLike | undefined, input: Partial<ModelProfile> & { id: string }, io?: Io): Promise<{ changed: boolean; revision: number; value: unknown }>;
export function removeProfile(environment: ProcessEnvLike | undefined, id: string, io?: Io): Promise<{ changed: boolean; revision: number; value: unknown }>;

export interface LedgerEntry { path: string[]; before: { exists: boolean; value?: unknown }; written: unknown }
export interface RollbackConflict { path: string[]; current: unknown }
// [开关 id, 实际写入的路径, 写入值]——面板据此显示「实际写入的键名」（设计 §9.3），
// 不在插件里维护第二份表（§9.7）。
export const TOGGLE_ENTRIES: ReadonlyArray<readonly [keyof ProfileToggles, string[], unknown]>;
export function buildClaudeEntries(profile: ModelProfile): Array<{ path: string[]; value: unknown }>;
export function readPath(object: unknown, path: string[]): { exists: boolean; value?: unknown };
export function writePath(object: Record<string, unknown>, path: string[], value: unknown): void;
export function deletePath(object: Record<string, unknown>, path: string[]): void;
export function mergeClaudeSettings(existing: Record<string, unknown> | null, entries: Array<{ path: string[]; value: unknown }>): { content: Record<string, unknown>; ledger: LedgerEntry[]; created: boolean };
export function rollbackClaudeSettings(existing: Record<string, unknown> | null, ledger: LedgerEntry[]): { content: Record<string, unknown>; conflicts: RollbackConflict[] };

// ---- model: project binding ----

export interface ProjectBinding {
  schemaVersion: number;
  revision: number;
  activeProfileId: string | null;
  overrides: Record<string, unknown>;
  projection: {
    claude?: { file: string; fingerprint: string; created: boolean; entries: LedgerEntry[] };
  };
}
export interface ProjectModelStatus {
  projectRoot: string;
  binding: ProjectBinding;
  profile: ModelProfile | null;
  dangling: boolean;
  projection: { file: string; keys: number; fingerprint: string | null; fingerprintMatches: boolean } | null;
  message: string | null;
}
export function danglingMessage(profileId: string): string;
export function readBinding(projectRoot: string): Promise<{ value: ProjectBinding; exists: boolean; file: string }>;
export function bindProject(projectRoot: string, environment: ProcessEnvLike | undefined, profileId: string, io?: Io): Promise<{ changed: boolean; binding: ProjectBinding; projection: { file: string; fingerprint: string; keys: number } }>;
export function clearProjectBinding(projectRoot: string, environment: ProcessEnvLike | undefined, io?: Io): Promise<{ changed: boolean; conflicts: RollbackConflict[]; binding: ProjectBinding }>;
export function projectModelStatus(projectRoot: string, environment: ProcessEnvLike | undefined): Promise<ProjectModelStatus>;
export function resolveProjectProfile(projectRoot: string, environment: ProcessEnvLike | undefined, io?: Io): Promise<{ profile: ModelProfile | null; binding: ProjectBinding; cleaned: boolean; conflicts: RollbackConflict[]; message: string | null }>;

// ---- model: gitignore ----
export const MODEL_RULES: readonly string[];
export function ensureModelGitignore(projectRoot: string): Promise<boolean>;

// ---- model: launch injection ----
export interface AgentCompatibility { claude: { ok: boolean; reason?: string }; codex: { ok: boolean; reason?: string }; opencode: { ok: boolean; reason?: string } }
export function agentCompatibility(profile: ModelProfile): AgentCompatibility;
export function codexInjection(profile: ModelProfile, options: { argumentsList?: string[]; environment?: Record<string, string> }): { argumentsList: string[]; environment: Record<string, string>; skipped: string[] };
export function opencodeInjection(profile: ModelProfile, environment?: Record<string, string>): { environment: Record<string, string>; providerId: string; mode: "builtin-override" | "custom-provider" };
export function claudeEnvironment(profile: ModelProfile): Record<string, string>;
export function buildLaunchInjection(input: { agentId: string; profile: ModelProfile | null; argumentsList?: string[]; environment?: Record<string, string> }): { argumentsList: string[]; environment: Record<string, string>; note: string | null };

// ---- model: paste recognition ----
export interface RecognizedField { field: string; value: string; source?: string }
export interface ParseResult {
  form?: "claude-settings" | "flat" | "cc-switch" | "unknown";
  recognized: RecognizedField[];
  passthrough: Record<string, unknown>;
  candidates: Record<string, string[]>;
  // 识别过程中的非致命说明（如"这个值看起来是掩码，已忽略"）。不是错误：结果仍然可用。
  warnings: string[];
}
export function parseConfigJson(text: string): ParseResult;
export function parseConfigText(text: string): { recognized: RecognizedField[]; candidates: Record<string, string[]>; warnings: string[] };
export function recognizeEnvMap(env: Record<string, string>): { recognized: RecognizedField[]; candidates: Record<string, string[]>; warnings: string[] };

// ---- model: presets & probe ----
export interface Preset { id: string; label: string; baseUrl: string; api: ApiType }
export const PRESETS: readonly Preset[];
export function applyPreset(id: string): Preset | null;
export interface ProbeResult {
  ok: boolean;
  category: "2xx" | "auth" | "not-found" | "rate-limited" | "server-error" | "network" | "timeout";
  status: number | null;
  durationMs: number;
  model: string | null;
  usage: unknown;
  message: string;
  url: string | null;
}
export function testConnection(
  profile: ModelProfile,
  options?: { timeoutMs?: number; fetch?: typeof fetch; endpoint?: EndpointConfig; model?: string },
): Promise<ProbeResult>;
// 解析测试连接真正请求的地址（`/v1` 去重逻辑只有这一份）。面板的「将请求：<地址>」实时
// 预览用它，而不是在 media/main.js 里再写一遍 —— 设计 §9.7 禁止插件侧第二份业务逻辑。
// 无效 Base URL 会抛（与 probe 同一条校验路径），调用方负责转成界面提示。
export function probeUrl(baseUrl: string, api: ApiType): string;

// ---- status: one project, one description ----
// Every host renders this same object: the terminal as text, `status --json`
// unchanged, the extension as a tree. Read-only and local — no network, no git
// fetch, no launch reconciliation, no agent CLI started — so it is safe to call
// from a render pass or a file watch.
export const STATUS_SCHEMA_VERSION: number;

/** The six words that describe one agent's shared history, in the order they stop being true. */
export type AgentSyncState = "none" | "running" | "dirty" | "stale" | "missing" | "current";

export interface StatusAgent {
  id: string;
  displayName: string;
  command: string;
  executable: string | null;
  available: boolean;
  installMethod: AgentInstallMethod;
  /** Whether this project's config lists the agent at all. */
  initialized: boolean;
  auth: string | null;
  sessions: string | null;
  history: {
    /** The agent's native session directory for this project. */
    directory: string;
    sessions: number;
    launchGroup: "idle" | "running" | "interrupted";
    projection: { nativeSessionId: string; lastSyncedAt: string | null; lastCanonicalEventId: string | null } | null;
    sync: AgentSyncState;
  };
}

export interface StatusSkillsScope {
  scope: "project" | "global";
  /** "none" and "unreadable" are different answers, and only one is actionable. */
  state: string;
  installed: number | null;
  packs: Array<{ id: string; name: string }>;
  targets: Array<{
    id: string;
    label: string;
    /** The agents that read this directory, so a renderer can split by agent or column by target. */
    agents: string[];
    state: string;
    complete: boolean;
    present: number;
    total: number;
  }>;
}

export interface StatusModel {
  schemaVersion: number;
  project: { root: string; name: string; configured: boolean; agents: string[]; historyMode: "shared" | "isolated" };
  history: {
    mode: "shared" | "isolated";
    sessions: number;
    active: string | null;
    activeTitle: string | null;
    activeEvents: number | null;
    activeLastEventId: string | null;
    activeUpdatedAt: string | null;
    updatedAt: string | null;
    projections: Record<string, { nativeSessionId: string; lastSyncedAt: string | null; lastCanonicalEventId: string | null }>;
  };
  agents: StatusAgent[];
  skills: {
    project: StatusSkillsScope;
    global: StatusSkillsScope;
    hub: {
      configured: boolean;
      spec: string;
      name: string;
      repository: string;
      ref: string | null;
      directory: string;
      revision: string | null;
      pinned: string | null;
      /** "missing" is no checkout on this machine; "stale" is one that is not the revision the lock file pinned. */
      cache: "missing" | "stale" | "current";
    };
  };
}
export function collectStatus(projectRoot: string, options?: { environment?: ProcessEnvLike }): Promise<StatusModel>;
