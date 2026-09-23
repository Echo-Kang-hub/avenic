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
  /**
   * What an earlier API answer left on disk, per agent, read once when the
   * wizard opens. The keep/remove question is about exactly these files, so the
   * answer must describe the file as it is — not as the configuration says it
   * should be.
   */
  files: Record<string, ModelFilePresence>;
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
/** One line of a collapsed answer: the label and the value that belongs to it. */
export interface WizardSummaryLine {
  label: string;
  value: string;
}
export interface ProjectWizardStep<D = ProjectDraft> {
  id: string;
  /**
   * `note` is a step nobody answers: it is read on the way past (the "your old
   * configuration is still there" line) and has a summary but no question, so a
   * host skips over it in both directions and shows it among the answered ones.
   */
  kind: "single" | "multi" | "text" | "note";
  title: string;
  description?: string;
  /** single/multi: the choices. A text step asks for free text instead. */
  options?: ProjectWizardChoice[];
  /**
   * Consecutive steps sharing a group are one question to the user: a host
   * folds them into a single answered line, titled by the group's first step.
   */
  group?: string;
  /** The fold's heading, when it differs from the group's first step title. */
  groupTitle?: string;
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
  /**
   * The answered line: a bare string, or the label/value pairs the dashboard's
   * own card shows — the terminal draws each pair as one row of the same
   * two-column table the card uses, and a host that can only draw one line
   * joins them with " │ ". A falsy summary means "nothing to show".
   */
  summary?: (draft: D) => string | WizardSummaryLine | WizardSummaryLine[] | null | undefined;
  apply?: boolean;
  appliedTitle?: string;
  /** A host's own line under the step (key hints, a reminder). */
  footer?: string;
}
export function agentChoices(): ProjectWizardChoice<string>[];
export function projectDraft(config: ProjectConfig, options?: { files?: Record<string, ModelFilePresence> }): ProjectDraft;
export function projectWizardSteps(draft: ProjectDraft, editing?: boolean): ProjectWizardStep<ProjectDraft>[];
export function projectDraftSubmission(draft: ProjectDraft): { agents: Record<string, AgentRuntimeConfig>; historyMode: HistoryMode };
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

// ---- runtime: model configuration ----
// An API answer is where the agent reads its provider, endpoint and model from:
// a configuration file of the agent's own, in the agent's own shape. Avenic
// makes sure that file is there and then gets out of the way — the contents are
// the user's (their own hand, or the tool they configured it with), so a file
// that is present is preserved byte for byte and only a missing one is created,
// empty. There is no Avenic model catalog and no Avenic credential format; the
// ledger records only that Avenic created a path, never a value out of it.
export interface ModelConfigTarget {
  file: string;
  /** The path as a host prints it, with `~` for the home scope. */
  relative: string;
  format: string;
}
/** The agents whose provider configuration is a file Avenic can prepare. */
export function modelConfigAgents(): string[];
export function modelConfigTarget(projectRoot: string | null, agentId: string, scope: Scope, options?: { homeDir?: string; environment?: ProcessEnvLike; projectRoot?: string }): ModelConfigTarget | null;
/** The same path as a host prints it, without needing a project root. */
export function modelConfigRelative(agentId: string, scope: Scope): string;
/** Prepare the file the agent reads: create it empty when missing, touch nothing when it is there. */
export function ensureModelConfiguration(projectRoot: string, agentId: string, scope: Scope, options?: { homeDir?: string; environment?: ProcessEnvLike }): Promise<{ relative: string; file: string; created: boolean }>;
/**
 * The model/effort keys an agent's own configuration can carry, read from the
 * file itself: Claude's file answers with its role models and its effort level,
 * Codex's with its reasoning effort. A key the file does not hold — absent,
 * blank, or not a string — is null; nothing is filled in with a value nobody
 * wrote.
 */
export interface ModelSettings {
  primary?: string | null;
  opus?: string | null;
  sonnet?: string | null;
  haiku?: string | null;
  subagent?: string | null;
  effort?: string | null;
  reasoning?: string | null;
}
/** What one configuration file currently says. Never a secret — only whether one is set. */
export interface ModelConfiguration {
  relative: string;
  file: string;
  /** Whether the file is on disk at all. */
  exists: boolean;
  /** Whether the file could be read as its own format. */
  valid: boolean;
  /**
   * Whether the file names anything that is in effect: an endpoint, a provider,
   * a model, a credential, a role or an effort. A file Avenic prepared but
   * nobody filled in is `exists` and not `configured` — which is the whole
   * difference between "the file is there" and "there is a configuration".
   */
  configured: boolean;
  /** Whether Avenic created this exact path, per the ledger. */
  owned: boolean;
  /** Whether the file still hashes to what Avenic wrote when it created it. */
  unchanged: boolean;
  /** The endpoint's host (Claude) or the provider table's name or id (Codex). */
  provider: string | null;
  baseUrl: string | null;
  model: string | null;
  credentialSet: boolean;
  /** Present-tense only: null exactly when `configured` is false. */
  settings: ModelSettings | null;
}
export function readModelConfiguration(projectRoot: string, agentId: string, scope: Scope, options?: { homeDir?: string; environment?: ProcessEnvLike }): Promise<ModelConfiguration | null>;
/**
 * What one agent's *own* home holds — the configuration the agent reads when it
 * runs on its account. Read-only, for a surface that reports the agent's real
 * configuration rather than Avenic's.
 */
export interface AccountConfiguration {
  relative: string;
  exists: boolean;
  valid: boolean;
  configured: boolean;
  provider: string | null;
  model: string | null;
  settings: ModelSettings | null;
}
export function readAccountConfiguration(projectRoot: string, agentId: string, scope: Scope, options?: { environment?: ProcessEnvLike }): Promise<AccountConfiguration | null>;
/**
 * What the file a stored API answer points at is, asked once when a wizard
 * opens: the questions can then describe what is really on disk without reading
 * the filesystem on every repaint. `owned`/`unchanged` travel with it because
 * the destructive question is about exactly those files — the ones Avenic
 * created and nobody touched.
 */
export interface ModelFilePresence {
  relative: string;
  scope: Scope;
  exists: boolean;
  owned: boolean;
  unchanged: boolean;
}
export function modelConfigPresence(
  projectRoot: string,
  agents: Record<string, { authMethod?: AuthMethod; configScope?: Scope }>,
  options?: { homeDir?: string; environment?: ProcessEnvLike },
): Promise<Record<string, ModelFilePresence>>;
/**
 * The file a project-scoped Codex API answer used to live in before 1.8.4
 * (`.agents/api/codex.json`), named and never touched — it was written by an
 * earlier Avenic and may carry a real credential. Null for every other agent.
 */
export function legacyModelConfiguration(projectRoot: string, agentId: string): { relative: string; file: string; exists: boolean } | null;
/** The file an API answer for this project would use, whether or not the project is on one. */
export function modelConfigCandidate(projectRoot: string, agentId: string, options?: { homeDir?: string; environment?: ProcessEnvLike }): { relative: string; exists: boolean } | null;
/**
 * Give back a file Avenic prepared, when — and only when — Avenic can prove it
 * prepared it: the ledger names this exact path and the file still hashes to
 * what Avenic wrote. Anything else is the user's and stays, and the outcome says
 * which of the four cases it was.
 */
export function removeModelConfiguration(projectRoot: string, agentId: string, scope: Scope, options?: { homeDir?: string; environment?: ProcessEnvLike }): Promise<{ relative: string | null; outcome: "deleted" | "modified" | "foreign" | "missing"; removed: boolean }>;
/** One line of "what this write would do", with a secret's value already masked by core. */
export interface ConfigurationDiffLine {
  kind: "same" | "add" | "remove";
  text: string;
  /** Whether masking changed this line — a secret by its name or by the shape of its value. */
  masked: boolean;
}
/**
 * The merge computed against the file that is really there. `after` is the whole
 * document that would be written, in the clear: a surface that computes a diff
 * holds it and returns lines, never the file.
 */
export interface ModelConfigurationPlan {
  relative: string;
  file: string;
  scope: Scope;
  exists: boolean;
  /** Whether anything at all would change; false means the write is a no-op, byte for byte. */
  changed: boolean;
  diff: ConfigurationDiffLine[];
  after: string;
}
/** What the merge would do to the file, for a surface that shows it before it is written. */
export function previewModelConfiguration(projectRoot: string, agentId: string, scope: Scope, template: Record<string, unknown>, options?: { homeDir?: string; environment?: ProcessEnvLike }): Promise<ModelConfigurationPlan>;
/**
 * The same merge, written atomically at the tightest permissions that still let
 * the agent read the file — and not written at all when nothing changed.
 */
export function applyModelConfiguration(projectRoot: string, agentId: string, scope: Scope, template: Record<string, unknown>, options?: { homeDir?: string; environment?: ProcessEnvLike }): Promise<ModelConfigurationPlan & { written: boolean }>;
/**
 * The preview itself, for a host that has two documents and no plan: line by
 * line, with every credential masked on the way out.
 */
export function configurationDiff(before: string, after: string): ConfigurationDiffLine[];
/** One line, credentials hidden — by the name they sit under and by their own shape. */
export function maskSecrets(line: string): string;

// ---- runtime: model providers ----
// A provider preset is a fact about someone else's API: where that vendor's
// Anthropic-format endpoint lives, which header carries the credential, what the
// vendor's own Claude Code guide puts in each model role, and which page all of
// that was read from. It is not a settings format of its own — a preset
// describes how to fill *the agent's* native configuration, so the file on disk
// stays the agent's file, in the agent's own keys. `custom` is the door for
// everything else: name the base URL yourself and Avenic stops presuming.

/** The environment keys Claude Code documents for a third-party provider. */
export const CLAUDE_ENV: {
  base: string;
  token: string;
  apiKey: string;
  model: string;
  opus: string;
  sonnet: string;
  haiku: string;
  fable: string;
  subagent: string;
  effort: string;
};
/** The roles a template can map, in the order the model table shows them. */
export const MODEL_ROLES: readonly string[];
/** One vendor's side of the table, in that agent's own format. */
export interface ProviderFormat {
  /** The preset's own endpoint, or null for a proxy the user runs — the URL is then theirs to type. */
  baseUrl: string | null;
  /** The vendor's recommendation per Claude model role, or null where it published none. */
  roles?: Record<string, string> | null;
  /** Keys the vendor's own guide always writes, e.g. OpenRouter's empty ANTHROPIC_API_KEY. */
  env?: Record<string, string>;
  /** The environment variable a Codex configuration names as its key's home. */
  envKey?: string;
}
/** One verified vendor: the two agents' sides, where its model list answers, and where that was read. */
export interface ProviderPreset {
  id: string;
  displayName: string;
  docs: string;
  claude: ProviderFormat;
  codex: ProviderFormat | null;
  /** A full URL, or a path joined to the user's own root. Null for a vendor with no list route. */
  catalog: { url?: string; path?: string; header: string | null } | null;
  /** The model names the vendor documents itself; empty where it publishes none. */
  curated: string[];
}
export const PROVIDERS: readonly ProviderPreset[];
export function providerPreset(id: string): ProviderPreset | null;
/**
 * The preset a configured endpoint came from, or null when it came from nowhere
 * in this table — a wrong highlight is worse than none. A URL whose host matches
 * a preset but whose path does not is still that provider.
 */
export function providerForBaseUrl(agentId: string, baseUrl: string | null | undefined): ProviderPreset | null;
/** The presets that can fill one agent's native configuration. Empty for an agent that keeps its own registry. */
export function providersForAgent(agentId: string): ProviderPreset[];
/**
 * The optional halves of a Claude configuration: each one is a value Avenic can
 * state truthfully, toggled by name. The user's own plugin and marketplace
 * lists are deliberately absent — a preset that invented one would be writing a
 * configuration the user never chose.
 */
export const CLAUDE_BLOCKS: readonly { id: string; values?: Record<string, unknown>; env?: Record<string, string> }[];
/**
 * The object to merge into Claude's settings for one provider, in Claude's own
 * keys. An `apiKey` of `null`/`undefined` is an *omission* — the credential stays
 * exactly where it is; an empty string is a refusal and throws. `presetRoles:
 * false` says the file already names this provider, so the vendor's role mapping
 * fills a configuration being created and never one already in place.
 */
export function claudeTemplate(
  presetId: string,
  input?: { apiKey?: string | null; baseUrl?: string | null; model?: string; roles?: Record<string, string>; presetRoles?: boolean },
  blocks?: readonly string[],
): Record<string, unknown>;
/** The Codex side of the same answers, in Codex's own keys. */
export function codexTemplate(presetId: string, input?: { baseUrl?: string | null; model?: string }): { providerId: string; displayName: string; baseUrl: string; envKey: string; model: string };

// ---- runtime: model catalog ----
// The two network calls a surface can make for a provider, and the cache it
// reads when it makes neither. Both are made only when a user asks for one —
// never on a page being drawn — and the credential goes in a header and nowhere
// else: not in a URL, not in a result, not in a cache file, not in a log.

/** Why a model list was not fetched. `unreadable` is a body that is not a list, never an empty vendor. */
export type CatalogFailure = "unauthorized" | "http-error" | "unreadable" | "timeout" | "network-error";
/** What one connection probe answered. A 404 is `model-unavailable`: the gateway authenticated first. */
export type ConnectionState = "connected" | "authentication-failed" | "model-unavailable" | "network-error" | "timeout" | "unreadable" | "http-error";
/**
 * Ask one provider for its model list. A failure is reported as what it was and
 * never as an empty list, which would read as "this provider has no models".
 */
export function fetchModelCatalog(options?: {
  baseUrl?: string | null;
  /** A full URL is used as it stands; a path is joined onto `baseUrl`. */
  listPath?: string | null;
  header?: string | null;
  apiKey?: string | null;
  timeoutMs?: number;
  fetchImpl?: (url: string, init: { method?: string; headers?: Record<string, string>; body?: string; signal?: unknown }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
}): Promise<{ ok: true; models: string[] } | { ok: false; reason: CatalogFailure; status: number | null }>;
/**
 * The cheapest request that proves a base URL and a credential: a one-token call
 * on the messages wire — or, when the provider has a model-list endpoint of its
 * own (`listUrl`), a read of that list. Nothing is guessed: a provider without a
 * list URL is asked on the messages wire, and a 404 on the list URL is the URL
 * being wrong, never the model's name.
 */
export function testProviderConnection(options?: {
  baseUrl?: string | null;
  header?: string | null;
  apiKey?: string | null;
  model?: string;
  /** The provider's own model-list endpoint (a full URL, or a path joined onto `baseUrl`). Absent → the messages wire. */
  listUrl?: string | null;
  timeoutMs?: number;
  fetchImpl?: (url: string, init: { method?: string; headers?: Record<string, string>; body?: string; signal?: unknown }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
}): Promise<{ state: ConnectionState; status: number | null }>;
/** The file one provider's list is kept in, so a surface can be drawn without a request. */
export function modelCatalogCachePath(projectRoot: string, providerId: string): string;
/** The list a previous fetch left behind, read without a network call; null for anything that is not one. */
export function readModelCatalogCache(projectRoot: string, providerId: string): Promise<{ providerId: string; baseUrl: string; fetchedAt: string | null; models: string[] } | null>;
/** Keep a fetched list where the Center can read it again. A list and the URL it came from — no field here could hold a credential. */
export function writeModelCatalogCache(projectRoot: string, providerId: string, entry?: { baseUrl?: string | null; models?: string[] }): Promise<{ providerId: string; baseUrl: string; fetchedAt: string; models: string[] }>;

// ---- runtime: hooks ----
// One small vocabulary, not one integration per agent: six events say everything
// the rest of the product needs, and every native mechanism is translated into
// those six here, once. A mechanism that cannot report an event says `absent`
// with the reason attached — a hook Avenic invented fires never, and a
// notification that never arrives reads as a broken agent, not as a missing one.

/** The six things an agent can report, in the order a session lives them. */
export const HOOK_EVENTS: readonly string[];
/** The thresholds a dispatcher obeys, in one place because both hosts ask the same question. */
export const HOOK_POLICY: { completedMinSeconds: number; attentionImmediate: boolean; failedImmediate: boolean; dedupeSeconds: number };
/** One native mechanism's answer for one event: which hook fires, how much it can be trusted, and why. */
export interface HookEventCapability {
  native: string | null;
  reliability: "reliable" | "conditional" | "absent";
  note: string;
  /** The payload field carrying the reason, and the only values that count as this event. */
  reason?: string;
  reasons?: string[];
  detail?: string;
}
export interface HookCapability {
  displayName: string;
  mechanism: string;
  /** The file or directory the mechanism is installed into. */
  file: string;
  /** How a turn's duration is measured: from the payload, or correlated between two events. */
  duration: "correlated" | string;
  /** The version this row of the matrix was read off, and the one the mechanism arrived in. */
  verified: string;
  since: string;
  /** Which payload field carries each fact. */
  reads: { event: string; session: string; turn: string | null; cwd: string };
  events: Record<string, HookEventCapability>;
}
export const HOOK_CAPABILITIES: Record<string, HookCapability>;
export function hookCapability(agentId: string): HookCapability | null;
/** Whether the agent installed on this machine is one the matrix was read off. */
export function hookSupport(agentId: string, version: string | null | undefined): { supported: boolean; since: string; note: string | null } | null;
/** One native payload in Avenic's own words, or null when it is not an event Avenic knows how to read. */
export function normalizeHook(agentId: string, payload: unknown): {
  agent: string;
  event: string;
  sessionId: string | null;
  turnId: string | null;
  cwd: string | null;
  reason: string | null;
  detail: string | null;
} | null;
/** The identity of one happening, for the dedupe window — deliberately not when it happened. */
export function hookFingerprint(event: { agent: string; event: string; sessionId?: string | null; turnId?: string | null; reason?: string | null }): string;

// ---- runtime: hook install & actions ----
// The other end of the vocabulary: putting Avenic into each native mechanism,
// and deciding what a notification is when one arrives. `hookPlan` is read-only
// and carries the bytes an install would write, so every host shows the same
// diff from the same plan. The actions file is Avenic's own (not an agent's
// configuration), which is why it is written whole by one writer instead of
// merged — and why nothing but the four dispatchable kinds is accepted.

/** The four things an action may be, in the order a picker offers them. */
export const HOOK_ACTION_KINDS: readonly ("desktop" | "openclaw" | "webhook" | "command")[];
export interface HookAction {
  id: string;
  kind: "desktop" | "openclaw" | "webhook" | "command";
  /** webhook: where it posts. openclaw: gateway and path, defaulting to the local one. */
  url?: string;
  gateway?: string;
  path?: string;
  /** A hook token, or the name of the environment variable holding it. Never echoed, never logged. */
  token?: string;
  tokenEnv?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** command: the program and its arguments. The event arrives on stdin; the shell's credentials do not. */
  command?: string;
  args?: string[];
}
/** One action's attempt at one event. A refusal is a result, never a thrown hook. */
export interface HookActionResult {
  id: string;
  kind: string;
  state: "sent" | "failed" | "skipped";
  detail: string;
}
export interface HookEmitResult {
  /** Whether the native payload was one Avenic could read at all. */
  accepted: boolean;
  event: { agent: string; event: string; sessionId: string | null; turnId: string | null; cwd: string | null; reason: string | null; detail: string | null } | null;
  fingerprint: string | null;
  /** Why nothing ran, when nothing did: deduped inside the window, or under the duration floor. */
  skipped: "unknown-event" | "deduped" | "too-short" | null;
  results: HookActionResult[];
}
export function hookActionsPath(projectRoot: string): string;
/** The actions of one scope, exactly as that scope's own file holds them. */
export function readHookActionsAt(projectRoot: string, scope: "project" | "global", environment?: Record<string, string | undefined>): HookAction[];
/** Both scopes, the project winning by id — the list a dispatch actually runs. */
export function readHookActions(projectRoot: string, environment?: Record<string, string | undefined>): HookAction[];
/** One scope's list written as the whole list. Throws rather than write a file it cannot read. */
export function writeHookActions(projectRoot: string, scope: "project" | "global", actions: HookAction[], options?: { environment?: Record<string, string | undefined> }): Promise<{ changed: boolean; file: string }>;
/** Everything one native payload turns into: the event, its fingerprint, and one result per action. */
export function emitHook(options: {
  agentId: string;
  payload: unknown;
  projectRoot: string;
  environment?: Record<string, string | undefined>;
  io?: { now?: () => number; platform?: string; spawn?: (...args: unknown[]) => unknown; fetch?: typeof fetch };
}): Promise<HookEmitResult>;

/** What installing (or removing) one agent's hooks in one scope would do — read-only, and carrying the bytes. */
export interface HookPlan {
  agent: string;
  displayName: string;
  scope: "project" | "global";
  /** The native mechanism in Avenic's words, and the exact file it lives in. */
  mechanism: string;
  file: string;
  version: string | null;
  supported: boolean;
  /** Why not, when unsupported. */
  note: string | null;
  /** A condition the mechanism imposes that no screen can see from here (Codex's trust review). Empty when there is none. */
  caveat: string;
  installed: boolean;
  before: string;
  contents: string;
}
export function hookPlan(agentId: string, options: { scope: "project" | "global"; projectRoot: string; environment?: Record<string, string | undefined>; version?: string | null }): Promise<HookPlan>;
/**
 * Whether this scope currently holds Avenic's hooks, without building a write
 * plan. `installed` is null — with the reason in `error` — when the file exists
 * but cannot be read: that is this agent's answer, not a failure of the call.
 */
export function hookStatus(agentId: string, options: { scope: "project" | "global"; projectRoot: string; environment?: Record<string, string | undefined>; version?: string | null }): Promise<{ agent: string; scope: "project" | "global"; file: string; installed: boolean | null; supported: boolean; note: string | null; caveat: string; error?: string }>;
/** Merge Avenic's entry into the file's current state — never the snapshot the plan carried. */
export function installHooks(plan: HookPlan): Promise<{ changed: boolean; file: string; skipped?: string | null }>;
/** Remove Avenic's entry, and only Avenic's: a file Avenic did not write is never truncated. */
export function uninstallHooks(plan: HookPlan): Promise<{ changed: boolean; file: string }>;

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
/**
 * The tiny file a watching host reads to learn that a launch started, ended or a
 * conversation arrived. It is a change signal, not a second source of truth: the
 * revision moves with every meaningful change while the answers themselves stay
 * in `launchGroupState` and the canonical store, and a reader that has been
 * notified re-asks rather than believing the stamp.
 */
export interface StateStamp {
  schemaVersion: number;
  revision: number;
  updatedAt: string;
  launches: Record<string, "idle" | "running" | "interrupted">;
  sessions: {
    count: number;
    active: string | null;
    /** Conversation content growing — the one change count and launches both miss. */
    revision: number;
  };
}
export function stateStampFile(projectRoot: string): string;
export function readStateStamp(projectRoot: string): Promise<StateStamp | null>;
/** Re-derive the stamp from the truth and write it only when something moved. */
export function refreshStateStamp(projectRoot: string, options?: { active?: string | null; grew?: number }): Promise<StateStamp>;
export const STATE_STAMP_SCHEMA_VERSION: number;
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
/**
 * Switch a project's history mode, importing whatever the new mode requires.
 * `previous` is what the mode was, so a host can say what changed rather than
 * only what is; `imported` is the native sessions the switch pulled in.
 */
export function setHistoryMode(projectRoot: string, mode: HistoryMode, options?: { environment?: ProcessEnvLike; environmentForAgent?: (agentId: string) => ProcessEnvLike; agents?: Record<string, AgentRuntimeConfig>; draft?: { agents?: Record<string, AgentRuntimeConfig>; historyMode?: HistoryMode } }): Promise<{ previous: HistoryMode; mode: HistoryMode; imported: unknown[]; config: ProjectConfig }>;
export function applyProjectConfiguration(projectRoot: string, draft: { agents?: Record<string, AgentRuntimeConfig>; historyMode?: HistoryMode }, options?: { environment?: ProcessEnvLike; environmentForAgent?: (agentId: string) => ProcessEnvLike; homeDir?: string }): Promise<{ previous: HistoryMode; mode: HistoryMode; imported: unknown[]; config: ProjectConfig }>;
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
/** Is a projection behind the conversation? Shared by the session list and the projector. */
export function mappingState(mapping: NativeSessionMapping | null | undefined, lastEventId: string | null): "none" | "stale" | "current";
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
    /**
     * What the agent's *own* home says while it runs on its account: read from
     * the agent's configuration file, so a model the agent really uses is
     * reported and nothing is invented for one it does not name.
     */
    account: AccountConfiguration | null;
    /** The file this API answer points at, and what that file currently says. */
    configuration: ModelConfiguration | null;
    /**
     * A configuration the same agent left in a file Avenic no longer uses (a
     * pre-1.8.4 project-scoped Codex answer), named and never read, moved or
     * deleted. Present only when that file is still on disk, so an upgrade
     * cannot look like a provider that silently stopped applying.
     */
    legacy: { relative: string; file: string; exists: boolean } | null;
    /**
     * A project-scope configuration that is on disk while this project runs on
     * an Account: present, and not in effect. A surface says so rather than
     * showing it as the configuration that is being used.
     */
    detected: { relative: string } | null;
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

// ---- one agent's card: the rows every surface draws ----
//
// `avenic <agent>`, the extension's Configure page and the dashboard card all
// draw *these* rows, in this order, under these words. A host styles by `key`
// and must never match on `label`: the label is the user-visible word and the
// word may change without a host breaking.
export interface AgentCardRow {
  key: string;
  label: string;
  value: string;
}
export interface StatusAgentCard {
  id: string;
  displayName: string;
  runtime: StatusAgent["runtime"];
  auth: StatusAgent["auth"];
  sessions: Scope | null;
}
export function agentCard(projectRoot: string, agentId: string, options?: { environment?: ProcessEnvLike; homeDir?: string }): Promise<StatusAgentCard>;
export function agentCardRows(agent: StatusAgentCard | StatusAgent, historyMode: HistoryMode | null): AgentCardRow[];

// ---- the one vocabulary: labels.mjs ----
//
// The final VS Code dashboard is the source of truth for Avenic's user-facing
// terminology. The CLI's wizard, `avenic status`, the extension's Configure
// page, the dashboard and the documentation all describe the same two
// dimensions with the same words, and the words are the dashboard's.
export const LABELS: {
  authentication: string;
  account: string;
  api: string;
  accountScope: string;
  accountScopeQuestion: string;
  configurationScope: string;
  configurationScopeQuestion: string;
  accountStatus: string;
  configSource: string;
  provider: string;
  model: string;
  opusModel: string;
  sonnetModel: string;
  haikuModel: string;
  subAgentModel: string;
  defaultEffort: string;
  reasoningEffort: string;
  credential: string;
  sessions: string;
  history: string;
  /** "Native (OpenCode UI)" — the one name an agent's own authentication has. */
  native: string;
  scope: { global: string; project: string };
  historyMode: { shared: string; isolated: string };
  signIn: { "signed-in": string; "not-signed-in": string; unknown: string };
  /** "Detected but inactive" — a configuration that is present and not in effect. */
  detectedButInactive: string;
  notChosen: string;
  method: {
    account: { label: string; description: string };
    api: { label: string; description: string };
  };
};
/** `<Agent> <noun>` — how the wizard titles a question the user answers per agent. */
export function agentQuestion(name: string, noun: string): string;
/** `account` · `model` · `api` · `native` — the one name the answer has for a reader. */
export function methodLabel(method: string | null | undefined): string;
export function scopeLabel(scope: string | null | undefined): string;
export function historyLabel(mode: string | null | undefined): string;
export function signInLabel(status: string | null | undefined): string;
/** `API (Project)`, `Account (Global)`, `Native (OpenCode UI)`. */
export function authenticationValue(entry: { authMethod?: string | null; authScope?: string | null; configScope?: string | null } | null | undefined): string;
/** `Project (.agents/local/codex)` — the scope and the home it lives in. */
export function scopedHomeValue(scope: string, home: string | null | undefined): string;
