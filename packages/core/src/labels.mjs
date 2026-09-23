// The one vocabulary every surface renders from.
//
// The final VS Code dashboard is the source of truth for Avenic's user-facing
// terminology. The CLI's wizard, `avenic status`, the VS Code Configure page,
// the dashboard, the tree view and the documentation all describe the same two
// dimensions with the same words, and the words are the dashboard's:
//
//   Authentication      Account · API          (OpenCode: Native (OpenCode UI))
//     Account  →        Account Scope   Global · Project
//     API      →        Configuration Scope  Global · Project
//   Sessions            Global · Project
//   History             Shared · Isolated
//
// When each host spelled this itself it drifted — one said "Runtime", the next
// "Model configuration", a third "Session storage" — and the same project read
// differently depending on where it was looked at. Names live here instead, so
// a host that wants a different word for one of them has to change it for every
// host at once. "Runtime scope", "authentication method", "model configuration"
// and "session storage" are implementation words: two hosts must not disagree
// about which question a scope belongs to, so the scope is named after the
// answer it belongs to and nothing else.
//
// `api` is the one spelling a released file may hold where `model` is now
// stored internally; every reader renders both as **API**.

export const LABELS = {
  authentication: "Authentication",
  account: "Account",
  api: "API",
  accountScope: "Account Scope",
  accountScopeQuestion: "Account scope",
  configurationScope: "Configuration Scope",
  configurationScopeQuestion: "Configuration scope",
  accountStatus: "Account Status",
  configSource: "Config Source",
  provider: "Provider",
  model: "Model",
  opusModel: "Opus Model",
  sonnetModel: "Sonnet Model",
  haikuModel: "Haiku Model",
  subAgentModel: "Sub Agent Model",
  defaultEffort: "Default Effort",
  reasoningEffort: "Reasoning Effort",
  credential: "Credential",
  sessions: "Sessions",
  history: "History",
  native: "Native (OpenCode UI)",
  scope: { global: "Global", project: "Project" },
  historyMode: { shared: "Shared", isolated: "Isolated" },
  signIn: { "signed-in": "Signed in", "not-signed-in": "Not signed in", unknown: "Unknown" },
  detectedButInactive: "Detected but inactive",
  notChosen: "Not chosen",
  // The two answers to the authentication question, with the one line of
  // explanation a reader may need. The names themselves are never anything else.
  method: {
    account: { label: "Account", description: "use the Agent's native account sign-in" },
    api: { label: "API", description: "use a provider/model/API configuration" },
  },
};

/**
 * One agent's own question, as the wizard's active step titles it: the agent,
 * then the noun. A question the user answers once per agent cannot be titled by
 * the noun alone — "Account scope" says nothing about whose — and the agent's
 * name is already the block it collapses into once it is answered.
 */
export function agentQuestion(name, noun) {
  return `${name} ${noun.charAt(0).toLowerCase()}${noun.slice(1)}`;
}

/** `account` · `model` · `api` — the one name the answer has for a reader. */
export function methodLabel(method) {
  if (method === "account") return LABELS.method.account.label;
  if (method === "model" || method === "api") return LABELS.method.api.label;
  if (method === "native") return LABELS.native;
  return LABELS.notChosen;
}

export function scopeLabel(scope) {
  return LABELS.scope[scope] ?? LABELS.notChosen;
}

export function historyLabel(mode) {
  return LABELS.historyMode[mode] ?? LABELS.historyMode.shared;
}

export function signInLabel(status) {
  return LABELS.signIn[status] ?? LABELS.signIn.unknown;
}

/**
 * The value the Authentication row shows, scope and all: `API (Project)`,
 * `Account (Global)`, `Native (OpenCode UI)`. The scope travels with the method
 * because the two together are what the answer was — a method without its scope
 * says nothing about where the account or the configuration lives — and because
 * every host drawing this row must draw the same string. An unanswered project
 * says so instead of showing a default it did not answer.
 */
export function authenticationValue(entry) {
  if (entry?.authMethod === "account") return `${LABELS.method.account.label} (${scopeLabel(entry.authScope ?? "global")})`;
  if (entry?.authMethod === "model" || entry?.authMethod === "api") {
    return `${LABELS.method.api.label} (${scopeLabel(entry.authScope ?? entry.configScope ?? "global")})`;
  }
  return LABELS.notChosen;
}

/** `Project (.agents/local/codex)` — the scope and the home it lives in. */
export function scopedHomeValue(scope, home) {
  return home ? `${scopeLabel(scope)} (${home})` : scopeLabel(scope);
}
