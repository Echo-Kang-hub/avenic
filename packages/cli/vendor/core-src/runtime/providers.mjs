// What a provider preset is, and what it is not.
//
// It is a fact about someone else's API: where that vendor's Anthropic-format
// endpoint lives, which header carries the credential, what the vendor's own
// Claude Code guide puts in each model role, and which page all of that was read
// from. Every line here came from `docs/provider-endpoints.md`, which came from
// the vendors' own pages and the installed binaries — a provider that could not
// be verified is not in the table, and a preset for an agent whose format was
// never confirmed is absent rather than guessed. `custom` is the door for
// everything else: name the base URL yourself and Avenic stops presuming.
//
// A model list is a full URL, not a base URL plus a path, because the two are
// not the same host: Moonshot's list answers at `/v1/models` on the root and 404s
// under `/anthropic`, and MiniMax's `/anthropic/v1/models` is rooted at the host
// too. Joining one onto the other is how a working provider turns into a 404, so
// the join is only written where the two really are one — a proxy the user runs,
// whose root is theirs to name.
//
// It is not a settings format of its own. A preset does not describe how Avenic
// stores anything; it describes how to fill *the agent's* native configuration —
// Claude's `env` block, Codex's `model_providers` table — so that the file on
// disk stays the agent's file, in the agent's own keys, readable and editable by
// the person who owns it.

/** The environment keys Claude Code documents for a third-party provider. */
export const CLAUDE_ENV = {
  base: "ANTHROPIC_BASE_URL",
  token: "ANTHROPIC_AUTH_TOKEN",
  apiKey: "ANTHROPIC_API_KEY",
  model: "ANTHROPIC_MODEL",
  opus: "ANTHROPIC_DEFAULT_OPUS_MODEL",
  sonnet: "ANTHROPIC_DEFAULT_SONNET_MODEL",
  haiku: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  fable: "ANTHROPIC_DEFAULT_FABLE_MODEL",
  subagent: "CLAUDE_CODE_SUBAGENT_MODEL",
  effort: "CLAUDE_CODE_EFFORT_LEVEL",
};

/** The roles a template can map, in the order the model table shows them. */
export const MODEL_ROLES = ["sonnet", "opus", "fable", "haiku", "subagent"];

const ROLE_ENV = {
  opus: CLAUDE_ENV.opus,
  sonnet: CLAUDE_ENV.sonnet,
  haiku: CLAUDE_ENV.haiku,
  fable: CLAUDE_ENV.fable,
  subagent: CLAUDE_ENV.subagent,
};

// `roles` names the vendor's own recommendation for each Claude model role, and
// is `null` where the vendor has not published one: an invented mapping would
// silently send a request to a model the account may not have, which is worse
// than leaving the field empty for the user to fill.
export const PROVIDERS = [
  {
    id: "deepseek",
    displayName: "DeepSeek",
    docs: "https://api-docs.deepseek.com",
    claude: { baseUrl: "https://api.deepseek.com/anthropic", roles: { opus: "deepseek-v4-pro", sonnet: "deepseek-v4-pro", haiku: "deepseek-flash" } },
    // DeepSeek's OpenAI-format endpoint is the same host without the /anthropic
    // segment; Codex talks to it with an env key of the user's own, so no secret
    // is written into config.toml.
    codex: { baseUrl: "https://api.deepseek.com", envKey: "DEEPSEEK_API_KEY" },
    catalog: { url: "https://api.deepseek.com/models", header: "Authorization" },
    curated: ["deepseek-v4-pro", "deepseek-flash"],
  },
  {
    id: "openrouter",
    displayName: "OpenRouter",
    docs: "https://openrouter.ai/docs",
    // OpenRouter's own Claude Code page asks for ANTHROPIC_API_KEY to be set
    // empty: it authenticates the bearer token, and a non-empty API_KEY is a
    // second, wrong credential. A settings file's `env` outranks the same shell
    // variable, so an empty value here is what stops an unrelated key in the
    // user's environment from being sent to OpenRouter.
    claude: { baseUrl: "https://openrouter.ai/api", roles: null, env: { [CLAUDE_ENV.apiKey]: "" } },
    codex: { baseUrl: "https://openrouter.ai/api/v1", envKey: "OPENROUTER_API_KEY" },
    // OpenRouter's model list is public: no credential, and it lives on the
    // /api/v1 root, not on the Anthropic-format one.
    catalog: { url: "https://openrouter.ai/api/v1/models", header: null },
    curated: [],
  },
  {
    id: "moonshot",
    displayName: "Moonshot / Kimi",
    docs: "https://platform.kimi.ai/docs/guide/claude-code-kimi",
    claude: { baseUrl: "https://api.moonshot.ai/anthropic", roles: null },
    codex: { baseUrl: "https://api.moonshot.ai/v1", envKey: "MOONSHOT_API_KEY" },
    // Rooted at the host, not under /anthropic: the latter is a 404 here.
    catalog: { url: "https://api.moonshot.ai/v1/models", header: "Authorization" },
    curated: [],
  },
  {
    id: "zhipu",
    displayName: "Zhipu GLM",
    docs: "https://docs.z.ai",
    claude: { baseUrl: "https://api.z.ai/api/anthropic", roles: null },
    codex: null,
    // The list route exists (an unauthenticated call is answered with the
    // vendor's own auth error) but Zhipu answers HTTP 200 for paths that do not
    // exist too, so a status code there means nothing: what came back is read as
    // a body, and a body that is not a list is unreadable rather than empty.
    catalog: { url: "https://api.z.ai/api/anthropic/v1/models", header: "Authorization" },
    curated: [],
  },
  {
    id: "qwen",
    displayName: "Qwen / DashScope",
    docs: "https://www.alibabacloud.com/help/en/model-studio",
    claude: { baseUrl: "https://dashscope.aliyuncs.com/apps/anthropic", roles: null },
    codex: null,
    catalog: null,
    curated: [],
  },
  {
    id: "minimax",
    displayName: "MiniMax",
    docs: "https://platform.minimax.io/docs",
    claude: { baseUrl: "https://api.minimax.io/anthropic", roles: null },
    codex: null,
    // Rooted at the host: /anthropic/v1/models, not <anthropic base>/v1/models.
    catalog: { url: "https://api.minimax.io/anthropic/v1/models", header: "X-Api-Key" },
    curated: [],
  },
  {
    id: "siliconflow",
    displayName: "SiliconFlow",
    docs: "https://docs.siliconflow.com",
    claude: { baseUrl: "https://api.siliconflow.com/", roles: null },
    codex: null,
    catalog: { url: "https://api.siliconflow.com/v1/models", header: "Authorization" },
    curated: [],
  },
  {
    id: "litellm",
    displayName: "LiteLLM (self-hosted)",
    docs: "https://docs.litellm.ai/proxy/client_setup/claude_code",
    // A proxy you run yourself: the address is yours, so this preset carries the
    // mechanism and not an endpoint.
    claude: { baseUrl: null, roles: null },
    codex: { baseUrl: null, envKey: "LITELLM_API_KEY" },
    // A proxy you run: the root is the user's, so the list is a path joined to it.
    catalog: { path: "/v1/models", header: "Authorization" },
    curated: [],
  },
  {
    id: "custom",
    displayName: "Custom Provider",
    docs: "https://code.claude.com/docs/en/llm-gateway-connect",
    claude: { baseUrl: null, roles: null },
    codex: { baseUrl: null, envKey: "AVENIC_PROVIDER_API_KEY" },
    catalog: null,
    curated: [],
  },
];

export function providerPreset(id) {
  return PROVIDERS.find((preset) => preset.id === id) ?? null;
}

const normalizeUrl = (value) => {
  const trimmed = typeof value === "string" ? value.trim().replace(/\/+$/, "").toLowerCase() : "";
  return trimmed === "" ? null : trimmed;
};

const hostOf = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
};

/**
 * The preset a configured endpoint came from, or `null` when it came from
 * nowhere in this table.
 *
 * The question this answers is "which provider is selected?", and the answer is
 * read off the user's file rather than remembered by a screen: the file is
 * theirs, and a hand-edit is allowed to change it. A URL whose host matches a
 * preset but whose path does not is still that provider — the user may have
 * added a segment — while a host that is in no preset is *no* preset, because a
 * wrong highlight is worse than none. Each host belongs to one preset (a gate in
 * the suite keeps it that way), so "the first match" is never a coin toss.
 */
export function providerForBaseUrl(agentId, baseUrl) {
  const key = agentId === "claude" ? "claude" : agentId === "codex" ? "codex" : null;
  const wanted = normalizeUrl(baseUrl);
  if (key === null || wanted === null) return null;
  const presets = PROVIDERS.filter((preset) => normalizeUrl(preset[key]?.baseUrl) !== null);
  return (
    presets.find((preset) => normalizeUrl(preset[key].baseUrl) === wanted) ??
    presets.find((preset) => hostOf(normalizeUrl(preset[key].baseUrl)) === hostOf(wanted)) ??
    null
  );
}

/** The presets that can fill one agent's native configuration. */
export function providersForAgent(agentId) {
  const key = agentId === "claude" ? "claude" : agentId === "codex" ? "codex" : null;
  // OpenCode keeps its own provider registry and its own sign-in: Avenic writing
  // a provider there would be a second, foreign configuration of the same thing.
  if (key === null) return [];
  return PROVIDERS.filter((preset) => preset[key] !== null);
}

// The optional halves of a Claude configuration: each one is a value Avenic can
// state truthfully, toggled by name. `enabledPlugins` and
// `extraKnownMarketplaces` are deliberately not here — they are the user's own
// lists, and a preset that invented a plugin name would be writing a
// configuration the user never chose.
export const CLAUDE_BLOCKS = [
  { id: "signature", values: { attribution: { commit: "", pr: "" }, includeCoAuthoredBy: false } },
  { id: "teammates", env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" } },
  { id: "toolSearch", env: { ENABLE_TOOL_SEARCH: "true" } },
  { id: "thinkingBudget", env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: "31972" } },
  { id: "autoUpgrade", values: { autoUpdatesChannel: "latest" } },
];

const required = (value, message) => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed === "") throw new Error(message);
  return trimmed;
};

/**
 * The object to merge into Claude's settings for one provider.
 *
 * Everything in it is either the user's own input (the key, the model, the role
 * overrides, a self-hosted address) or a verified fact about the vendor (the
 * endpoint, the recommended role mapping). Nothing is a placeholder: a key that
 * was not typed is a refusal, not a `<USER_API_KEY>` — a file with a literal
 * placeholder in it is a configuration that fails later, at the one moment the
 * user cannot see why.
 *
 * A key that was *omitted* is a different answer from a key that was blank. Omit
 * it and the credential is left exactly where it is, which is what lets someone
 * who already has one in the file change their model without being asked to type
 * the key again. Type nothing and it is a refusal: a blank field is a mistake,
 * not a decision — the caller that knows the file already holds a credential is
 * the one that turns a blank answer into an omission, and this refusal is what
 * stops every other caller from writing a configuration with no credential in it.
 *
 * `input.presetRoles === false` says the file already names this provider, so
 * its own role mapping stays as it is: what the vendor recommends fills a
 * configuration that is being created, never one that is already in place.
 */
export function claudeTemplate(presetId, input = {}, blocks = []) {
  const preset = providerPreset(presetId);
  if (preset === null) throw new Error(`Unknown provider: ${presetId}`);
  const apiKey = input.apiKey === undefined || input.apiKey === null
    ? null
    : required(input.apiKey, `${preset.displayName}: an API key is required`);
  const baseUrl = required(input.baseUrl ?? preset.claude.baseUrl, `${preset.displayName}: a base URL is required`);
  const model = required(input.model, `${preset.displayName}: a model is required`);
  if (/[\r\n]/.test(apiKey) || /[\r\n]/.test(baseUrl)) throw new Error(`${preset.displayName}: the value must be a single line`);

  // The vendor's own extras sit between the credential and the model: they are
  // facts about the vendor, not about the user, and no vendor key collides with
  // the three Avenic always writes.
  const env = {
    [CLAUDE_ENV.base]: baseUrl,
    ...(apiKey === null ? {} : { [CLAUDE_ENV.token]: apiKey }),
    ...(preset.claude.env ?? {}),
    [CLAUDE_ENV.model]: model,
  };
  const roles = { ...(input.presetRoles === false ? {} : preset.claude.roles ?? {}), ...(input.roles ?? {}) };
  for (const role of MODEL_ROLES) {
    const name = typeof roles[role] === "string" ? roles[role].trim() : "";
    if (name !== "") env[ROLE_ENV[role]] = name;
  }
  const template = { env };
  for (const id of blocks) {
    const block = CLAUDE_BLOCKS.find((candidate) => candidate.id === id);
    if (block === undefined) throw new Error(`Unknown option: ${id}`);
    Object.assign(template, block.values ?? {});
    Object.assign(env, block.env ?? {});
  }
  return template;
}

/** The Codex side of the same answers, in Codex's own keys. */
export function codexTemplate(presetId, input = {}) {
  const preset = providerPreset(presetId);
  if (preset === null || preset.codex === null) throw new Error(`Unknown provider: ${presetId}`);
  return {
    providerId: preset.id,
    displayName: preset.displayName,
    baseUrl: required(input.baseUrl ?? preset.codex.baseUrl, `${preset.displayName}: a base URL is required`),
    envKey: preset.codex.envKey,
    model: required(input.model, `${preset.displayName}: a model is required`),
  };
}
