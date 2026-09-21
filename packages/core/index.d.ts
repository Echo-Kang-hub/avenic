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

export type AuthMethod = "account" | "api";
export type Scope = "global" | "project";

/**
 * One agent's stored answers. Authentication and model configuration are
 * different questions, so an entry carries the method and *only that method's*
 * scope: `accountScope` says whose sign-in this is, `configScope` says which of
 * the agent's own configuration files carries the provider. The other method's
 * key is absent rather than empty — a half-written entry cannot claim both.
 * OpenCode manages its own authentication and provider, so it stores its
 * session scope and nothing else.
 */
export interface AgentRuntimeConfig {
  enabled?: boolean;
  authMethod?: AuthMethod;
  accountScope?: Scope;
  configScope?: Scope;
  sessionScope?: Scope;
  [key: string]: unknown;
}

/** What one entry answers, with the method's own scope and nothing of the other's. */
export interface AgentConfigView {
  sessionScope: Scope;
  authMethod?: AuthMethod;
  accountScope?: Scope;
  configScope?: Scope;
}

export interface EffectiveAgentConfig extends AgentConfigView {
  /** "local" when a per-project override is what a launch reads, "project" when the stored entry is. */
  source: "local" | "project" | null;
  local: AgentRuntimeConfig | null;
  configured: AgentRuntimeConfig;
}

export interface RuntimePaths {
  localRoot: string;
  runtimeFile: string;
  localRuntimeFile: string;
  sessionsRoot: string;
}

export type HistoryMode = "shared" | "isolated";

/** The runtime file's shape, canonical schema v3. No derived fields are stored beside it. */
export interface RuntimeFile {
  schemaVersion?: number;
  activeCanonicalSessionId?: string;
  historyMode?: HistoryMode;
  agents?: Record<string, AgentRuntimeConfig>;
}

export interface RuntimeState {
  paths: RuntimePaths;
  runtime: RuntimeFile;
  local: { schemaVersion?: number; agents?: Record<string, AgentRuntimeConfig> };
}

export function validateAuthMethod(method: unknown): AuthMethod;
export function validateScope(scope: unknown, what?: string): Scope;
export function validateHistoryMode(mode: unknown): HistoryMode;
export interface ProjectConfig {
  agents: Record<string, AgentConfigView>;
  historyMode: HistoryMode;
}
export function projectConfig(state: RuntimeState): ProjectConfig;
export function configureProject(projectRoot: string, draft?: { agents?: Record<string, AgentRuntimeConfig>; historyMode?: HistoryMode }): Promise<RuntimeState & { configChanged: boolean; gitignoreChanged: boolean; config: ProjectConfig }>;

// ---- the project-setup questions, shared by every host UI ----
//
// `avenic init`, `avenic change` and the VS Code extension ask the same things
// in the same order and must write the same configuration. The questions live
// in core; a host only decides how to draw a step.
export interface ProjectDraft {
  selected: string[];
  agents: Record<string, AgentConfigView>;
  /**
   * What the project said before this run. A step that merely arrives at an
   * answer and one that *replaces* it look identical in `agents`, so the
   * difference — the only thing worth asking about — is kept here, and
   * `applyProjectDraft` releases the previous method from this copy, never
   * from a re-read of a file a concurrent edit may have moved.
   */
  stored: Record<string, AgentConfigView>;
  /** The API fields each agent answered, held apart from the stored scope. */
  api: Record<string, ApiFields>;
  historyMode: HistoryMode;
  /** The answer to the keep/remove question; absent until it is asked. */
  switchMode?: "keep" | "remove";
}
export interface ProjectWizardChoice<T = unknown> {
  value: T;
  label: string;
  description?: string;
}
/**
 * `D` is the draft a step reads and writes. Core's own steps draft a
 * `ProjectDraft`; a host may declare steps over a smaller draft (the VS Code
 * per-agent Initialize flow does) and walk them with the same driver.
 */
export interface ProjectWizardStep<D = ProjectDraft> {
  id: string;
  kind: "single" | "multi" | "text";
  title: string;
  description?: string;
  /** single/multi: the choices. A text step asks for free text instead. */
  options?: ProjectWizardChoice[];
  /**
   * Consecutive steps sharing a group are one question to the user: a host
   * folds them into a single answered line, titled by the group's first step.
   */
  group?: string;
  /** multi: the currently chosen values. */
  values?: (draft: D) => string[];
  minSelected?: number;
  emptyMessage?: string;
  /** single/text: the currently chosen value. */
  value?: (draft: D) => unknown;
  /** text: a step whose answer must not be echoed back (a credential). */
  mask?: boolean;
  /**
   * text: an empty answer is still an answer. True for the credential step:
   * the field is never filled in for the reader, so leaving it empty means
   * "keep the credential that is already written".
   */
  optional?: boolean;
  placeholder?: string;
  write?: (draft: D, value: unknown) => void;
  /** One dim line: what this step's answer was, for an answered step. */
  summary?: (draft: D) => string;
  apply?: boolean;
  appliedTitle?: string;
  /** A host's own line under the step (key hints, a reminder). */
  footer?: string;
}
export function agentChoices(): ProjectWizardChoice<string>[];
export function projectDraft(config: ProjectConfig, options?: { api?: Record<string, ApiFields> }): ProjectDraft;
export function projectWizardSteps(draft: ProjectDraft, editing?: boolean): ProjectWizardStep<ProjectDraft>[];
export function projectDraftSubmission(draft: ProjectDraft): { agents: Record<string, AgentRuntimeConfig>; api: Record<string, ApiFields>; historyMode: HistoryMode };
export function applyProjectDraft(
  projectRoot: string,
  draft: ProjectDraft,
  options?: {
    environment?: ProcessEnvLike;
    environmentForAgent?: (agentId: string) => Record<string, string | undefined>;
    /** The machine home a Global configuration is read from and written to. */
    homeDir?: string;
  },
): Promise<{ previous: HistoryMode; mode: HistoryMode; imported: unknown[]; config: ProjectConfig; released: ReleasedMethod[] }>;

// ---- the keep/remove question: which answers replace which, and what "remove" may touch ----
/**
 * The agents whose new answer is a *different method* than the stored one —
 * the only situation the wizard's keep/remove question is about. Either
 * direction counts, and an agent that did not previously answer at all is not
 * a switch: there is nothing to keep or remove.
 */
export function methodSwitches(draft: ProjectDraft): Array<{ agentId: string; before: AuthMethod; after: AuthMethod }>;
/**
 * What a removal would name: the switches where "Remove" has something of
 * Avenic's own to delete — a previous Account is an agent's own sign-in and is
 * never deleted, so a host asks the destructive question only when this is
 * non-empty — and the file each one lives in, named once for every host.
 */
export function removalTargets(draft: ProjectDraft): Array<{ agentId: string; name: string; relative: string }>;
/** What releasing one agent's previous method did, for a host to report. */
export interface ReleasedMethod {
  agentId: string;
  /**
   * The method that was released — null when the caller had no previous answer
   * to release, so no method was there to name.
   */
  method: AuthMethod | null;
  /** The native file the release touched, or null (an Account keeps its home). */
  relative: string | null;
  /** The home a Project Account leaves in place, forward-slashed, or null. */
  home: string | null;
  removed: number;
  conflicts: number;
  /**
   * Keys Avenic overwrote whose earlier value the ledger never held (only a
   * hash of it), so it cannot be given back. The one release outcome a host
   * must report: silence would leave the user with a silently destroyed value.
   */
  kept: number;
  deleted: boolean;
}
export function releasePreviousMethod(
  projectRoot: string,
  agentId: string,
  previous: AgentConfigView | undefined,
  options?: { environment?: ProcessEnvLike; homeDir?: string },
): Promise<ReleasedMethod>;
export function runtimePaths(projectRoot: string): RuntimePaths;
export function loadRuntime(projectRoot: string): Promise<RuntimeState>;
export function getActiveCanonicalSessionId(projectRoot: string): Promise<string | null>;
export function setActiveCanonicalSession(projectRoot: string, canonicalSessionId: string | null): Promise<string | null>;
export function initializeAgent(
  projectRoot: string,
  agentId: string,
  /** Named answers, never positional: a bare string would spread into single characters. */
  entry?: AgentRuntimeConfig,
): Promise<RuntimeState & { configChanged: boolean; gitignoreChanged: boolean; structureRepaired: boolean }>;
export function deinitializeAgent(
  projectRoot: string,
  agentId: string,
  options?: {
    /** Remove Avenic's data for this agent: portable sessions and its own files. */
    purge?: boolean;
    /**
     * Also remove the agent's own sign-in (`purge` required). Avenic never
     * writes that file, so deleting it is a separate, explicit answer rather
     * than part of "purge": default purges keep it and report it in
     * `keptCredential`.
     */
    purgeCredentials?: boolean;
  },
): Promise<{
  agent: Agent;
  changed: boolean;
  purged: boolean;
  remaining: number;
  /** The sign-in a purge kept, project-relative; null when nothing was kept. */
  keptCredential: string | null;
}>;
export function setLocalAuth(projectRoot: string, agentId: string, choice: { authMethod: AuthMethod; accountScope?: Scope; configScope?: Scope }): Promise<EffectiveAgentConfig>;
export function clearLocalAuth(projectRoot: string, agentId: string): Promise<EffectiveAgentConfig>;
export function effectiveAgentConfig(state: RuntimeState, agentId: string): EffectiveAgentConfig | null;
export interface AgentRuntimeMode {
  auth: { method: AuthMethod | null; scope: Scope | null; source: "local" | "project" | null };
  sessions: { scope: Scope };
}
export function getAgentRuntimeMode(projectRoot: string, agentId: string): Promise<AgentRuntimeMode | null>;
/** What one launch will actually do, after the local override and the method's own scope. */
export interface EffectiveAgentRuntime {
  executable: string;
  authMethod: AuthMethod;
  /** The scope the chosen method owns. */
  scope: Scope;
  config: EffectiveAgentConfig;
  argumentsList: string[];
  /** By identity when the launch adds nothing, so "changed nothing" is checkable. */
  environment: ProcessEnvLike;
  note: string | null;
}
/** The base every launch starts from: this process's own environment. */
export function machineEnvironment(): ProcessEnvLike;
/**
 * The environment an agent's own process runs in — and therefore the root its
 * native session storage lives under. A Project-scope account is isolated by
 * pointing the agent's configuration-home variable at `.agents/local/<agent>`,
 * so everything that reads or restores native storage around a launch must be
 * handed this value rather than the caller's environment.
 */
export function agentRuntimeEnvironment(
  projectRoot: string,
  agentId: string,
  config: { authMethod?: AuthMethod; accountScope?: Scope } | null | undefined,
  environment?: ProcessEnvLike,
): ProcessEnvLike;
/**
 * The composition above, resolved from the project's own configuration: the
 * environment one project's runs of one agent read and write their own storage
 * under. Every session path that touches native storage uses this, so the home
 * a conversation was written to and the home it is read from agree.
 */
export function effectiveAgentEnvironment(
  projectRoot: string,
  agentId: string,
  environment?: ProcessEnvLike,
): Promise<ProcessEnvLike>;
export function resolveEffectiveAgentRuntime(
  projectRoot: string,
  agentId: string,
  options?: {
    state?: RuntimeState;
    environment?: ProcessEnvLike;
    argumentsList?: string[];
    /** The method a host resolved interactively, for an entry that names none. */
    launchMethod?: AuthMethod;
    launchMethodFor?: (agentId: string) => AuthMethod | null;
    io?: Io;
  },
): Promise<EffectiveAgentRuntime>;

// ---- runtime: API configuration ----
// API mode writes the provider, endpoint, model and credential into the
// agent's *own* configuration file, in the agent's own shape: Claude's
// `env` block, Codex's `model_provider` table. There is no Avenic model
// catalog and no Avenic credential format — only the fields Avenic wrote,
// recorded in a ledger so a later removal can prove what is its own.
export interface ApiFields {
  /** A label the user chose for this endpoint; never validated against a list. */
  provider?: string;
  baseUrl?: string;
  model?: string;
  /** A secret for Claude, an environment-variable *name* for Codex. */
  credential?: string;
}

/** The one credential variable an agent's API configuration speaks. */
export interface ApiCredential {
  key: string;
  /** Whether the value is a secret a host must not echo back. */
  secret: boolean;
  label: string;
  hint: string;
}
export function apiCredential(agentId: string): ApiCredential;
/** The agents whose API configuration Avenic can write. */
export function apiAgents(): string[];
/** The provider id a Codex provider table is keyed by: derived from the label, never asked. */
export function providerIdFor(provider: string): string;
export function codexWireApi(baseUrl: string): "responses" | "chat";
export interface ApiTarget {
  file: string;
  /** The path as a host prints it, with `~` for the home scope. */
  relative: string;
  format: string;
  native: boolean;
}
export function apiTarget(projectRoot: string | null, agentId: string, scope: Scope, options?: { homeDir?: string; projectRoot?: string }): ApiTarget | null;
/** The same path as a host prints it, without needing a project root. */
export function apiRelative(agentId: string, scope: Scope): string;
/** The key paths one agent's API configuration owns, in its file's shape. */
export function apiEntries(agentId: string, fields?: ApiFields): Array<{ path: string[]; value: unknown }>;
/**
 * The model/effort keys an agent's own configuration can carry, read from the
 * file that is in effect: Claude's file answers with its role models and its
 * effort level, Codex's with its reasoning effort. A key the file does not hold
 * — absent, blank, or not a string — is null; nothing is filled in with a value
 * nobody wrote. Only the keys of that agent's own file are there: Codex's
 * project record answers with its one key and never a Claude role key.
 */
export interface ApiSettings {
  primary?: string | null;
  opus?: string | null;
  sonnet?: string | null;
  haiku?: string | null;
  subagent?: string | null;
  effort?: string | null;
  reasoning?: string | null;
}
/** What one scope's API configuration currently says. Never a secret — only whether one is set. */
export interface ApiConfiguration {
  relative: string;
  exists: boolean;
  /** Whether the keys present are the ones Avenic wrote, per the ledger. */
  owned: boolean;
  /**
   * Whether the file still holds those keys with the values Avenic wrote. A
   * user who deletes or edits a key outside Avenic leaves `owned` true — the
   * ledger can still prove what is Avenic's — and `present` false: provider
   * and model are then the past, not the configuration in effect, and a
   * surface must not show them as the latter.
   */
  present: boolean;
  provider: string | null;
  baseUrl: string | null;
  model: string | null;
  credentialSet: boolean;
  /**
   * The model block of the file in effect, read from that file itself — a key
   * the user wrote there is part of it. Null exactly when `present` is false:
   * like provider and model, it is present-tense only.
   */
  settings: ApiSettings | null;
}
export function readApiConfiguration(projectRoot: string, agentId: string, scope: Scope, options?: { homeDir?: string; environment?: ProcessEnvLike }): Promise<ApiConfiguration | null>;
/**
 * Where a project's API questions start: for each agent whose answer is API,
 * the fields to show, read from the file Avenic wrote — with `credentialSet`
 * saying a secret is already there, never what it is. Without this an edit
 * would open on empty fields, and applying them would take the configuration
 * away.
 */
export function apiPrefill(
  projectRoot: string,
  agents: Record<string, { authMethod?: AuthMethod; configScope?: Scope }>,
  options?: { homeDir?: string; environment?: ProcessEnvLike },
): Promise<Record<string, ApiFields & { credentialSet: boolean }>>;
export function writeApiConfiguration(projectRoot: string, agentId: string, scope: Scope, fields?: ApiFields, options?: { homeDir?: string; environment?: ProcessEnvLike }): Promise<unknown>;
/**
 * Remove only the keys the ledger proves Avenic wrote; a key the user has
 * since changed is a conflict, counted and left alone. `deleted` is true only
 * when the whole file was Avenic's own creation and is now empty.
 */
export function removeApiConfiguration(projectRoot: string, agentId: string, scope: Scope, options?: { homeDir?: string; environment?: ProcessEnvLike }): Promise<{ relative: string | null; removed: number; conflicts: number; kept: number; deleted: boolean }>;
export function codexLaunchArguments(record: ApiFields): string[];
export function readCodexProjectConfig(projectRoot: string): Promise<ApiFields | null>;

// ---- project-local agent home: an agent's own config and auth, under the project ----
// The directory a Project-scope Account signs in to, reached by the agent's own
// configuration-root variable. It is not session storage — sessions stay under
// `.agents/sessions`.
export function agentHomeRoot(projectRoot: string, agentId: string): string;

// ---- runtime: gitignore / project-root / process / sessions / adapters ----

export const REQUIRED_RULES: readonly string[];
export const SESSIONS_RULE: string;
export function ensureRuntimeGitignore(projectRoot: string): Promise<boolean>;
export function removeRuntimeGitignore(projectRoot: string, options?: { sessions?: boolean }): Promise<unknown>;
export function sessionsGitIgnored(projectRoot: string): Promise<boolean>;
export function setSessionsGitIgnored(projectRoot: string, ignored: boolean): Promise<boolean>;

export function locateProjectRoot(startDirectory?: string): string;
export function enclosingProjectRoot(startDirectory?: string, options?: { includeStart?: boolean }): string | null;
// One command line for a shell to run — the quoting rule the launcher's `.cmd`
// branch and the extension's terminal `sendText` both must use.
export function quoteShellLine(executable: string, argumentsList: string[]): string;
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
export function hashContent(content: string): string;
export function readFirstJsonLine(file: string): Promise<unknown | null>;
export function listFiles(sourcePath: string): Promise<string[]>;
export function snapshotInto(source: string, destination: string): Promise<unknown>;
export function revertFrom(snapshot: string, source: string): Promise<unknown>;

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
// `title` is the title to show, never a raw session id: a session whose file
// still carries the id an earlier import named it after is listed under a short
// id, and the next import replaces that with what the conversation is about.
export function listCanonicalSessions(projectRoot: string): Promise<Array<{ id: string; title?: string; updatedAt?: string }>>;
// The session records themselves, newest first, without reading any event log:
// same directories as listCanonicalSessions, but carrying the counts a status
// view needs (eventCount and lastEventId are absent on records written before
// they were stored; countCanonicalEvents fills that in for one session).
export interface CanonicalSessionRecord {
  id: string;
  /** The display title. See listCanonicalSessions; never a raw session id. */
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  eventCount?: number;
  lastEventId?: string | null;
  [key: string]: unknown;
}
export function listCanonicalSessionRecords(projectRoot: string): Promise<CanonicalSessionRecord[]>;
// Everything about a session except its events: the record and its native
// mappings. A host that has to show which agents a conversation belongs to asks
// with this, because the answer is in the mappings and opening the event log to
// find it means reading a conversation to draw a badge.
export function readCanonicalSessionRecord(projectRoot: string, id: string): Promise<{
  session: CanonicalSessionRecord;
  mappings: { schemaVersion: number; canonicalSessionId: string; projections: Record<string, NativeSessionMapping> };
}>;
export function countCanonicalEvents(projectRoot: string, id: string): Promise<number>;
export function observeSharedNativeSessions(projectRoot: string, agentId: string, options?: Record<string, unknown>): Promise<{ changed: boolean; imported: number; diagnostics: unknown[] }>;
export function formatSessionDiagnostics(diagnostics?: unknown[]): { warnings: string[]; notes: string[] };
export interface LaunchGroup {
  member: string;
  release: () => Promise<unknown>;
}
export function joinLaunchGroup(projectRoot: string, agentId: string, options?: { environment?: ProcessEnvLike }): Promise<LaunchGroup | null>;
export function beginLaunch(
  projectRoot: string,
  agentId: string,
  options?: {
    /** The agent's effective configuration; only `sessionScope` is read. */
    config?: { sessionScope?: Scope } | null;
    environment?: ProcessEnvLike;
    /** Skips handing the agent the project's records (`sessions continue` reads native storage itself). */
    skipRestore?: boolean;
  },
): Promise<{ portable: boolean; member: string | null }>;
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
export function applyProjectConfiguration(projectRoot: string, draft: { agents?: Record<string, AgentRuntimeConfig>; historyMode?: HistoryMode; api?: Record<string, ApiFields> }, options?: { environment?: ProcessEnvLike; environmentForAgent?: (agentId: string) => ProcessEnvLike }): Promise<{ previous: HistoryMode; mode: HistoryMode; imported: unknown[]; config: ProjectConfig }>;
/** `session.title` is the display title — see listCanonicalSessions — and the stored file is not rewritten to produce it. */
export function readCanonicalSession(projectRoot: string, id: string): Promise<{ session: Record<string, unknown>; events: CanonicalEvent[]; mappings: { projections: Record<string, NativeSessionMapping> } }>;
// One canonical conversation, read as a timeline. Both hosts render this and
// neither computes a second answer: a turn belongs to the agent that produced
// it, and "You" is only ever the person at the keyboard.
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
  /** The display title: the session's own name, the first thing the user said, or a short id. Never a uuid. */
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
/** What a continuation's `capture` hook is told about the launch it belongs to. */
export interface ContinuationCaptureContext {
  /** The prepared projection or handoff: which agent, how it opens, and the argv. */
  continuation?: {
    agentId?: string;
    mode?: string;
    nativeSessionId?: string | null;
    launch?: { argumentsList?: string[]; input?: string } | null;
    handoff?: { markdown?: string } | null;
  };
  /** Whatever the host's own `launch` hook returned, echoed back for the "after" capture. */
  launched?: {
    nativeSessionId?: string;
    nativeRevision?: string;
    /** A read taken inside the launch itself, reused instead of reading the same file twice. */
    capturedDuringLaunch?: NativeCanonicalRead | null;
  } & Record<string, unknown>;
}
/**
 * One continuation, start to finish: capture the target's current state, prepare the
 * projection or handoff, launch, capture what the launch produced, and record the
 * mapping. The host supplies the two ends core cannot reach — how to read the agent's
 * own session, and how to launch it — and the return value is what actually happened.
 */
export function continueCanonicalSession(options: {
  projectRoot: string;
  canonicalId: string;
  targetAgent: string;
  environment?: ProcessEnvLike;
  /** Repair stale native mappings out of canonical history before the "before" capture. */
  captureKnown?: () => Promise<void>;
  /** Rebuild the target's projection up front instead of waiting for a merge to need it. */
  materialize?: boolean;
  /** Skip a resume the caller already knows is stale. Implied when the "before" capture says so. */
  forceBootstrap?: boolean;
  /** `null` when the target has no native session to read at that moment. */
  capture(stage: "before" | "after", context?: ContinuationCaptureContext): Promise<NativeCanonicalRead | null>;
  launch(continuation: unknown): Promise<ContinuationResult & { capturedDuringLaunch?: NativeCanonicalRead | null }>;
}): Promise<{
  continuation: unknown;
  launched: ContinuationResult & { capturedDuringLaunch?: NativeCanonicalRead | null };
  captured: NativeCanonicalRead | null;
  mapping: NativeSessionMapping;
  diagnostics: string[];
}>;

export interface SessionAdapterResult {
  count: number;
  changed?: boolean;
  added?: number;
  updated?: number;
  conflicts?: number;
}
/** One native conversation, read back in the canonical shape — what a capture hook returns. */
export interface NativeCanonicalRead {
  nativeSessionId: string;
  title: string | null;
  events: CanonicalEvent[];
  revision: string | null;
  diagnostics?: unknown[];
}
export interface SessionAdapter {
  capture(projectRoot: string, options?: { environment?: ProcessEnvLike }): Promise<SessionAdapterResult>;
  restore(projectRoot: string, options?: { environment?: ProcessEnvLike }): Promise<SessionAdapterResult>;
  status(projectRoot: string, options?: { environment?: ProcessEnvLike }): Promise<{ count: number }>;
  snapshotNative?: (projectRoot: string, snapshotRoot: string, options?: { environment?: ProcessEnvLike }) => Promise<void>;
  revertNative?: (snapshotRoot: string, projectRoot: string, options?: { environment?: ProcessEnvLike }) => Promise<void>;
  /** The target's own record of one conversation, or a thrown error when it is gone. */
  readCanonical(projectRoot: string, nativeSessionId: string, options?: { environment?: ProcessEnvLike; canonicalSessionId?: string; revision?: string }): Promise<NativeCanonicalRead>;
  /** The session the agent just created, for a launch that had no native id to resume. */
  discoverNativeSession(projectRoot: string, options?: { environment?: ProcessEnvLike; notBefore?: number }): Promise<string>;
}
export function getSessionAdapter(agentId: string): SessionAdapter;
/** The argv one prepared continuation is launched with, projection first and handoff second. */
export function continuationLaunchArguments(continuation?: Record<string, unknown>): { argumentsList: string[]; input?: string };

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
export function skillCoveredByPacks(packs: Map<string, Pack>, packIds: string[], sourceId: string, skillName: string): boolean;
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
export function readDirectState(context: InstallContext): Promise<DirectSourceState>;
export function addDirectSkills(context: InstallContext, sourceReference: string, skillNames: string[], options?: { io?: Io; targets?: string[]; createLink?: (canonicalPath: string, linkPath: string) => Promise<void> }): Promise<{ names: string[]; sourceId: string; revision: string; alreadyInstalled?: boolean }>;
// 克隆并列出直装源发布的 Skill，不安装任何东西（Add 流程的发现步骤）。
export function discoverDirectSkills(context: InstallContext, sourceReference: string): Promise<{ sourceId: string; revision: string; skillRoot: string | undefined; names: string[] }>;
export function removeDirectSkills(context: InstallContext, skillNames: string[]): Promise<string[]>;
export function removeExternalSkills(context: InstallContext, skillNames: string[], options?: { io?: Io }): Promise<{ directRemoved: string[]; removedDirectories: number }>;

// ---- status: one project, one description ----
// Every host renders this same object: the terminal as text, `status --json`
// unchanged, the extension as a tree. Read-only and local — no network, no git
// fetch, no launch reconciliation, no agent CLI started — so it is safe to call
// from a render pass or a file watch.

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
  /** "native" for an agent that answers for its own authentication and provider. */
  runtime: "native" | null;
  /**
   * The two methods answer with different facts and a host shows the one the
   * method owns: an Account says where its sign-in lives and whether it has
   * happened (`home`, `status`); an API configuration says which file carries
   * it and what it selects (`configuration`). Null when the agent is not
   * initialized or names no method. Nothing here is a probe: an unreadable
   * state is "unknown", never a sign-in Avenic performed, and a credential is
   * reported as set or not set, never printed.
   */
  auth: {
    method: AuthMethod;
    scope: Scope;
    source: "local" | "project" | null;
    /**
     * Where this Account's sign-in lives, and where `status` below was read
     * from: project-relative and forward-slashed for a Project-scope Account,
     * `~`-prefixed for the machine's own. Null for an API configuration, which
     * names a file (`configuration.relative`) instead of a home.
     */
    home: string | null;
    /** "signed-in" | "not-signed-in" | "unknown", read from the agent's own credential file. */
    status: string | null;
    configuration: ApiConfiguration | null;
  } | null;
  sessions: Scope | null;
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
