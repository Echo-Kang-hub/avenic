# Provider endpoints, verified from the vendors' own docs

Accessed 2026-09-24. Installed here: Claude Code 2.1.274 · Codex CLI 0.154.0 ·
OpenClaw 2026.9.4 · Node v24.20.0. Nothing below is from memory: each line cites
the vendor page it was read from, and the places where a fact could not be
confirmed are listed at the end rather than guessed.

Avenic stores these in a provider preset table (`packages/core/src/runtime/`,
one preset per agent), never as a second settings format of its own.

## Anthropic-format base URLs

| Provider | Base URL | Model list | Notes |
|---|---|---|---|
| DeepSeek | `https://api.deepseek.com/anthropic` | `GET /models`, Bearer | OpenAI format is `https://api.deepseek.com` |
| OpenRouter | `https://openrouter.ai/api` | `GET /api/v1/models`, public | `ANTHROPIC_API_KEY` must be set **empty** |
| Moonshot / Kimi | `https://api.moonshot.ai/anthropic` | `GET /v1/models`, Bearer | |
| Zhipu GLM | `https://api.z.ai/api/anthropic` (intl) · `https://open.bigmodel.cn/api/anthropic` (CN) | unverified | |
| Qwen / DashScope | `https://dashscope.aliyuncs.com/apps/anthropic` (CN) · `https://coding.dashscope.aliyuncs.com/apps/anthropic` | not on the Anthropic endpoint | "Do not end the base URL with `/v1/`" |
| MiniMax | `https://api.minimax.io/anthropic` (intl) · `https://api.minimax.cn/anthropic` (CN) | `GET /anthropic/v1/models`, `X-Api-Key` | |
| SiliconFlow | `https://api.siliconflow.com/` (intl) · `https://api.siliconflow.cn/` (CN) | `GET /v1/models`, Bearer | bare origin, no `/anthropic` segment |
| LiteLLM (self-hosted) | the proxy root, no `/v1` | `GET /v1/models` | |

## Environment and settings

- The variables Claude Code documents for a third-party provider:
  `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` (sends `Authorization: Bearer`),
  `ANTHROPIC_API_KEY` (sends `x-api-key`), `ANTHROPIC_MODEL`,
  `ANTHROPIC_DEFAULT_OPUS_MODEL` / `_SONNET_` / `_HAIKU_` / `_FABLE_`, plus the
  `_NAME` / `_DESCRIPTION` picker variants, `CLAUDE_CODE_SUBAGENT_MODEL`,
  `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, `CLAUDE_CODE_EFFORT_LEVEL`
  (low|medium|high|xhigh|max|auto), `ENABLE_TOOL_SEARCH`,
  `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`, `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY`.
- Settings precedence: managed → `--settings` and flags → `.claude/settings.local.json`
  → `.claude/settings.json` → `~/.claude/settings.json`. Lists merge, scalars take
  the highest level. `env` in a settings file overrides the same shell variable.
- The documented name is `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`; the
  unprefixed `DISABLE_NONESSENTIAL_TRAFFIC` is not in any current page.
- DeepSeek's own Claude Code guide: `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`,
  `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_MODEL`, the three `_DEFAULT_*_MODEL` names,
  `CLAUDE_CODE_SUBAGENT_MODEL`, `CLAUDE_CODE_EFFORT_LEVEL=max`.
- DeepSeek models today are `deepseek-flash` and `deepseek-v4-pro`; `deepseek-chat`
  and `deepseek-reasoner` are gone from the docs. Names beginning `claude-opus`
  map to `deepseek-v4-pro`, `claude-sonnet`/`claude-haiku` to `deepseek-flash`.

## Codex

- Config: `${CODEX_HOME}/config.toml` (default `~/.codex`), plus `<repo>/.codex/config.toml`.
  Project-local config may **not** set `model_provider`, `model_providers`,
  `openai_base_url` or `profile` (they are denylisted, because the file comes from
  a repository); custom providers belong in the user file.
- `ModelProviderInfo` fields: `name`, `base_url`, `env_key`, `env_key_instructions`,
  `auth` (command-backed bearer), `wire_api`, `query_params`, `http_headers`,
  `env_http_headers`, retry and timeout fields, `model_catalog_url`.
- `wire_api` accepts only `"responses"` now — `"chat"` was removed and fails loudly.
- Model catalog: `codex debug models` prints it as JSON, `--bundled` works offline.
- `codex doctor` reports installation, config, auth and runtime health.

## Testing a connection

The cheapest documented validation is a one-token request straight at the
endpoint: `POST $BASE_URL/v1/messages` with `max_tokens: 1`. A body beginning
`{"id":"msg_` proves the URL and credential work; an error naming an unknown
model proves the same (the gateway authenticated before rejecting the model);
`401` means the credential was rejected — try the other header. Providers with
`GET /v1/models` are cheaper still. Errors are matched on status code, not text:
`401` authentication, `402` billing, `403` permission, `404` not found, `429`
rate limit, `500` server, `529` overloaded.

## Could not be confirmed

- `developers.openai.com` returns 403 from this network, so Codex config keys are
  cited from OpenAI's own repository source rather than the rendered page.
- Zhipu/GLM has no `/models` path in its OpenAPI spec; Qwen states the Anthropic
  endpoint has no `/v1/models`; SiliconFlow's docs never use the words
  "Anthropic-compatible".
- `api.minimaxi.com` and a `dashscope-intl` claude-code-proxy host appear in no
  official doc.
- No authenticated call was made to any provider: no key was used, and nothing
  here was verified by spending a request.

Sources: api-docs.deepseek.com (Anthropic API, pricing, list-models, error codes,
Claude Code guide) · openrouter.ai/docs (Claude Code integration, models API,
errors) · platform.kimi.ai/docs/guide/claude-code-kimi · docs.z.ai · alibabacloud.com
Model Studio and Anthropic-compatible API · platform.minimax.io/docs · docs.siliconflow.com ·
docs.litellm.ai/proxy/client_setup/claude_code · code.claude.com/docs (settings,
settings-reference, env-vars, llm-gateway-connect, llm-gateway-protocol, errors,
managed-settings, cli-reference, model-config) · github.com/openai/codex (config
sources, loader, model-provider-info) · docs.openclaw.ai (gateway, config-hooks,
webhooks).
