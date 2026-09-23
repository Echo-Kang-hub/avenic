// The Model Configuration Center's core: what a provider preset is, what a
// template becomes, and what a merge is allowed to do to a person's file.
//
// Two rules run through every test here. Nothing is invented: an endpoint, a
// model name or a provider's very existence comes from `docs/provider-endpoints.md`
// (read off the vendors' own pages and the installed binaries), never from
// memory, and a preset for an agent we could not verify is simply absent. And a
// write never becomes a rewrite: the merge touches the keys the template names
// and leaves every other byte of the user's file where it was, which is the only
// thing that makes it safe to write into a file that also holds their hooks,
// permissions and plugins.
import assert from "node:assert/strict";
import test from "node:test";
import {
  CLAUDE_ENV,
  PROVIDERS,
  claudeTemplate,
  codexTemplate,
  providerForBaseUrl,
  providerPreset,
  providersForAgent,
} from "../packages/core/src/runtime/providers.mjs";
import { configurationDiff, mergeClaudeSettings, mergeCodexConfig, maskSecrets } from "../packages/core/src/runtime/model-write.mjs";

const KEY = "sk-test-not-a-real-key";

test("every preset names an endpoint the research verified, and cites where it was read", () => {
  // 端点写死在断言里：这条测试是「不许凭记忆加供应商」的闸门 —— 换一个 URL 就得
  // 先证明它，而证明只能来自 docs/provider-endpoints.md 里引到的官方页面。
  const verified = {
    deepseek: "https://api.deepseek.com/anthropic",
    openrouter: "https://openrouter.ai/api",
    moonshot: "https://api.moonshot.ai/anthropic",
    zhipu: "https://api.z.ai/api/anthropic",
    qwen: "https://dashscope.aliyuncs.com/apps/anthropic",
    minimax: "https://api.minimax.io/anthropic",
    siliconflow: "https://api.siliconflow.com/",
    litellm: null, // 自建代理：根地址由用户给
  };
  for (const [id, baseUrl] of Object.entries(verified)) {
    const preset = providerPreset(id);
    assert.ok(preset, `${id} 必须在表里`);
    assert.equal(preset.claude?.baseUrl ?? null, baseUrl, `${id} 的 Claude 端点`);
    assert.match(preset.docs, /^https:\/\//, `${id} 要说得出事实是从哪一页读来的`);
    assert.equal(preset.displayName.length > 0, true);
  }
  assert.equal(providerPreset("nonesuch"), null);
  // 永远有一个自定义项：供应商比这份表长，表不覆盖的要能自己填。
  assert.ok(PROVIDERS.some((preset) => preset.id === "custom"), "自定义供应商必须在");
});

test("a preset's model list is the vendor's own URL, never its base URL with a path guessed onto it", () => {
  // 这一条是 2026-09-24 的无凭据探针换来的：Moonshot 的清单在主机根上
  // （`/v1/models` 401、不存在的路径 404），把它拼在 Anthropic 基址下面就是
  // `…/anthropic/v1/models` —— 一个 404。MiniMax 同形。所以清单地址写成整条，
  // 谁都不许再拿基址去拼；Probe 的校准结果一并记在 docs/provider-endpoints.md。
  const verified = {
    deepseek: "https://api.deepseek.com/models",
    openrouter: "https://openrouter.ai/api/v1/models",
    moonshot: "https://api.moonshot.ai/v1/models",
    zhipu: "https://api.z.ai/api/anthropic/v1/models",
    minimax: "https://api.minimax.io/anthropic/v1/models",
    siliconflow: "https://api.siliconflow.com/v1/models",
  };
  for (const [id, url] of Object.entries(verified)) {
    const { catalog } = providerPreset(id);
    assert.ok(catalog, `${id} 的清单是查过的`);
    assert.equal(catalog.url ?? null, url, `${id} 的清单地址`);
  }
  // 凭据头也是查过的：名字决定谁来发凭据，schema 由名字推出来（Bearer 或裸值）。
  assert.equal(providerPreset("minimax").catalog.header, "X-Api-Key");
  assert.equal(providerPreset("deepseek").catalog.header, "Authorization");
  assert.equal(providerPreset("openrouter").catalog.header, null, "公开清单不带凭据");
  // 查不到的就是查不到：Qwen 的 Anthropic 端点没有 /v1/models（探针 404），
  // 自建网关的清单形状由用户决定。空着比编一个地址诚实。
  assert.equal(providerPreset("qwen").catalog, null);
  assert.equal(providerPreset("custom").catalog, null);
  // 自建代理没有能写死的地址：路径拼在用户自己填的根址上。
  assert.equal(providerPreset("litellm").catalog.url, undefined);
  assert.equal(providerPreset("litellm").catalog.path, "/v1/models");
  for (const preset of PROVIDERS) {
    if (preset.catalog === null) continue;
    const hasUrl = typeof preset.catalog.url === "string";
    const hasPath = typeof preset.catalog.path === "string";
    assert.equal(hasUrl !== hasPath, true, `${preset.id} 的清单要么是整条地址，要么是用户根址下的一段路径：两者都是或都不是，调用方就得猜`);
  }
});

test("a preset exists for an agent only where that agent's own format was verified", () => {
  const claude = providersForAgent("claude").map((preset) => preset.id);
  const codex = providersForAgent("codex").map((preset) => preset.id);
  for (const id of ["deepseek", "openrouter", "moonshot", "zhipu", "qwen", "minimax", "siliconflow", "litellm", "custom"]) {
    assert.ok(claude.includes(id), `${id} 的 Claude 端点是查过的`);
  }
  // 反过来：Codex 走 OpenAI 格式，只有官方文档给过 OpenAI 端点的才在表里。
  assert.ok(codex.includes("deepseek") && codex.includes("openrouter") && codex.includes("litellm") && codex.includes("custom"));
  for (const id of ["qwen", "minimax", "zhipu"]) assert.equal(codex.includes(id), false, `${id} 没有查过的 OpenAI 端点，就不该出现在 Codex 的下拉里`);
  assert.equal(providersForAgent("opencode").length, 0, "OpenCode 自己管 provider，Avenic 不替它选");
});

test("a configured endpoint is named by the preset it came from, and one from nowhere is named by nothing", () => {
  // 面板要能说「现在选的是 DeepSeek」——那句话只能由这张表回答，不能由界面上
  // 记住的某个下拉框回答：文件是用户自己的手也能改的。
  assert.equal(providerForBaseUrl("claude", "https://api.deepseek.com/anthropic")?.id, "deepseek");
  assert.equal(providerForBaseUrl("claude", "https://api.deepseek.com/anthropic/")?.id, "deepseek", "尾斜杠是同一个地址");
  assert.equal(providerForBaseUrl("claude", "HTTPS://API.DEEPSEEK.COM/anthropic")?.id, "deepseek", "主机名不分大小写");
  // 用户自己改过路径而主机没变：仍然是那一家 —— 认的是供应商，不是字符串相等。
  assert.equal(providerForBaseUrl("claude", "https://api.deepseek.com/v1/anthropic")?.id, "deepseek");
  // 同一个主机在 Codex 侧也是那一家，但只在这个问题问的是 Codex 的时候。
  assert.equal(providerForBaseUrl("codex", "https://api.deepseek.com")?.id, "deepseek");
  assert.equal(providerForBaseUrl("opencode", "https://api.deepseek.com/anthropic"), null, "OpenCode 的供应商不在 Avenic 的表里，Avenic 不替它认");
  // 表外的主机不许被算成任何一家：认不出来就是认不出来，界面上的高亮比沉默更会骗人。
  assert.equal(providerForBaseUrl("claude", "https://my-gateway.internal/anthropic"), null);
  assert.equal(providerForBaseUrl("claude", ""), null);
  assert.equal(providerForBaseUrl("claude", "not a url"), null);
  // 一个主机在同一张表里只能属于一家：撞了的话「是哪一家」就有两个答案，而
  // providerForBaseUrl 只会给出先遇到的那个 —— 这条闸门保证那个顺序不会变成谎。
  const hosts = new Map();
  for (const preset of PROVIDERS) {
    for (const agentId of ["claude", "codex"]) {
      const url = preset[agentId]?.baseUrl;
      if (typeof url !== "string") continue;
      const key = `${agentId}:${new URL(url).hostname}`;
      assert.equal(hosts.has(key), false, `${key} 同时属于 ${hosts.get(key)} 和 ${preset.id}`);
      hosts.set(key, preset.id);
    }
  }
});

test("the template carries the user's own key and model, never a placeholder", () => {
  const template = claudeTemplate("deepseek", { apiKey: KEY, model: "deepseek-v4-pro" });
  assert.equal(template.env[CLAUDE_ENV.base], "https://api.deepseek.com/anthropic");
  assert.equal(template.env[CLAUDE_ENV.token], KEY);
  assert.equal(template.env[CLAUDE_ENV.model], "deepseek-v4-pro");
  // 一个没填的地方不许变成 `<USER_API_KEY>` 那样的字面量：模板只写真实输入。
  assert.equal(JSON.stringify(template).includes("<"), false, "模板里不许出现占位符");
  assert.throws(() => claudeTemplate("deepseek", { apiKey: "  ", model: "deepseek-v4-pro" }), /key/i, "没有 key 就没有模板");
  assert.throws(() => claudeTemplate("nonesuch", { apiKey: KEY, model: "m" }), /provider/i);
});

test("omitting the key leaves the credential alone; typing nothing is still a refusal", () => {
  // 已经有 key 的用户只想改一个模型，不该被要求把 key 再打一遍。省略（不给这个字段）
  // 是「别动它」，而空字符串是「我填错了」—— 两者不能是同一件事，否则一个只想换模型
  // 的人要么被迫重打凭据，要么在空白里把凭据删掉。
  const kept = claudeTemplate("deepseek", { model: "deepseek-v4-pro" });
  assert.equal(CLAUDE_ENV.token in kept.env, false, "没有 key 就不写 token 那一行");
  assert.equal(kept.env[CLAUDE_ENV.base], "https://api.deepseek.com/anthropic", "端点照写");
  assert.equal(kept.env[CLAUDE_ENV.model], "deepseek-v4-pro");
  assert.equal(CLAUDE_ENV.token in claudeTemplate("deepseek", { apiKey: null, model: "m" }).env, false);
  assert.throws(() => claudeTemplate("deepseek", { apiKey: "", model: "m" }), /key/i, "空字符串是错的，不是决定");
  // 合并时凭据原样留着：省略 key 的那份模板不碰它。
  const existing = `${JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "already-there" } }, null, 2)}
`;
  const { text, changed } = mergeClaudeSettings(existing, kept);
  assert.equal(JSON.parse(text).env.ANTHROPIC_AUTH_TOKEN, "already-there", "省略 key 的合并不动凭据");
  assert.equal(changed, true, "但端点和模型确实是新写的");
});

test("a vendor that documents the other variable empty gets it empty, and nobody else does", () => {
  // OpenRouter 的 Claude Code 接入页要求 ANTHROPIC_API_KEY 显式置空：它自己认的是
  // ANTHROPIC_AUTH_TOKEN，而一个非空的 API_KEY 会被当成另一套凭据发出去。这是那家
  // 自己的要求，写在它自己的预置里；没有这条要求的供应商不许凭空多出一个空变量。
  const template = claudeTemplate("openrouter", { apiKey: KEY, model: "anthropic/claude-sonnet-4.5" });
  assert.equal(template.env[CLAUDE_ENV.token], KEY, "带凭据的是 AUTH_TOKEN");
  assert.equal(template.env[CLAUDE_ENV.apiKey], "", "OpenRouter 要求 API_KEY 空着");
  const deepseek = claudeTemplate("deepseek", { apiKey: KEY, model: "deepseek-v4-pro" });
  assert.equal(CLAUDE_ENV.apiKey in deepseek.env, false, "DeepSeek 的指南没有这一条");
});

test("the model-role mapping is the provider's, and the caller may override every role", () => {
  const preset = claudeTemplate("deepseek", { apiKey: KEY, model: "deepseek-v4-pro" });
  // DeepSeek 自己的指南：opus → v4-pro，sonnet/haiku → flash。
  assert.equal(preset.env[CLAUDE_ENV.opus], "deepseek-v4-pro");
  assert.equal(preset.env[CLAUDE_ENV.sonnet], "deepseek-v4-pro");
  assert.equal(preset.env[CLAUDE_ENV.haiku], "deepseek-flash");
  const mapped = claudeTemplate("deepseek", {
    apiKey: KEY,
    model: "deepseek-v4-pro",
    roles: { sonnet: "deepseek-flash", subagent: "deepseek-flash" },
  });
  assert.equal(mapped.env[CLAUDE_ENV.sonnet], "deepseek-flash");
  assert.equal(mapped.env[CLAUDE_ENV.subagent], "deepseek-flash");
  // 没查过角色映射的供应商不编：那一栏留空，由用户自己填。
  const custom = claudeTemplate("custom", { apiKey: KEY, model: "my-model", baseUrl: "https://gateway.internal/anthropic" });
  assert.equal(custom.env[CLAUDE_ENV.base], "https://gateway.internal/anthropic");
  assert.equal(CLAUDE_ENV.opus in custom.env, false, "自定义供应商不猜角色");
});

test("the optional blocks are named, and only the named ones are written", () => {
  const bare = claudeTemplate("deepseek", { apiKey: KEY, model: "deepseek-v4-pro" });
  assert.equal("includeCoAuthoredBy" in bare, false, "没勾就不写");
  const blocked = claudeTemplate("deepseek", { apiKey: KEY, model: "deepseek-v4-pro" }, ["signature", "teammates", "thinkingBudget", "autoUpgrade"]);
  assert.equal(blocked.includeCoAuthoredBy, false);
  assert.deepEqual(blocked.attribution, { commit: "", pr: "" });
  assert.equal(blocked.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS, "1");
  assert.equal(blocked.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "31972");
  assert.equal(blocked.autoUpdatesChannel, "latest");
  // 用户自己的插件与市场不在 Avenic 能写的清单里：那是他们自己的清单。
  assert.equal("enabledPlugins" in blocked, false);
  assert.equal("extraKnownMarketplaces" in blocked, false);
  assert.throws(() => claudeTemplate("deepseek", { apiKey: KEY, model: "m" }, ["nonesuch"]), /nonesuch/, "不认识的开关要报错，不许静默忽略");
});

test("a merge changes the named keys and nothing else", () => {
  const existing = `${JSON.stringify({
    permissions: { allow: ["Bash(git status)"] },
    hooks: { Stop: [{ hooks: [{ type: "command", command: "avenic hook emit --agent claude" }] }] },
    env: { ANTHROPIC_BASE_URL: "https://old.example/anthropic", MY_OWN_VAR: "1" },
    theme: "dark",
  }, null, 2)}\n`;
  const { text, changed } = mergeClaudeSettings(existing, claudeTemplate("deepseek", { apiKey: KEY, model: "deepseek-v4-pro" }, ["autoUpgrade"]));
  assert.equal(changed, true);
  const merged = JSON.parse(text);
  // 用户的东西一件不少。
  assert.deepEqual(merged.permissions, { allow: ["Bash(git status)"] });
  assert.equal(merged.hooks.Stop[0].hooks[0].command, "avenic hook emit --agent claude");
  assert.equal(merged.env.MY_OWN_VAR, "1");
  assert.equal(merged.theme, "dark");
  // 模板点名的键被换成新的，包括 env 里面那一个。
  assert.equal(merged.env.ANTHROPIC_BASE_URL, "https://api.deepseek.com/anthropic");
  assert.equal(merged.env.ANTHROPIC_AUTH_TOKEN, KEY);
  assert.equal(merged.autoUpdatesChannel, "latest");
  // 原有键的位置不动：换掉的值留在原处，新键追加在后面。
  assert.deepEqual(Object.keys(merged), ["permissions", "hooks", "env", "theme", "autoUpdatesChannel"]);
  assert.deepEqual(Object.keys(merged.env), ["ANTHROPIC_BASE_URL", "MY_OWN_VAR", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL"]);
  assert.match(text, /\n$/, "写完仍然是一个以换行结尾的文本文件");
});

test("a merge that would change nothing says so instead of rewriting the file", () => {
  const template = claudeTemplate("deepseek", { apiKey: KEY, model: "deepseek-v4-pro" });
  const first = mergeClaudeSettings("{}\n", template);
  const again = mergeClaudeSettings(first.text, template);
  assert.equal(again.changed, false, "第二次同样的合并没有改动");
});

test("an empty or unreadable file is not a reason to lose what a user wrote", () => {
  // 空文件就是空文档：合并进去得到一份完整配置，而不是一片空白。
  const fromEmpty = mergeClaudeSettings("", claudeTemplate("deepseek", { apiKey: KEY, model: "deepseek-v4-pro" }));
  assert.equal(JSON.parse(fromEmpty.text).env.ANTHROPIC_BASE_URL, "https://api.deepseek.com/anthropic");
  // 读不出来的文件绝不覆盖：那是别人的东西，交给调用者去说。
  assert.throws(() => mergeClaudeSettings("{ not json", claudeTemplate("deepseek", { apiKey: KEY, model: "deepseek-v4-pro" })), /JSON/i);
});

test("the Codex merge writes its own native keys, keeps comments, and never carries the secret", () => {
  const existing = [
    "# my own codex config",
    'model = "gpt-5-codex"',
    "model_provider = \"openai\"",
    "",
    "[mcp_servers.docs]",
    'command = "npx"',
    "",
    "[model_providers.openai]",
    'name = "OpenAI"',
    'base_url = "https://api.openai.com/v1"',
    'env_key = "OPENAI_API_KEY"',
    'wire_api = "responses"',
    "",
  ].join("\n");
  const { text, changed } = mergeCodexConfig(existing, { providerId: "deepseek", displayName: "DeepSeek", baseUrl: "https://api.deepseek.com", envKey: "DEEPSEEK_API_KEY", model: "deepseek-v4-pro" });
  assert.equal(changed, true);
  assert.match(text, /^# my own codex config/, "注释还在原位");
  assert.match(text, /\[mcp_servers\.docs\]/, "别人的表不动");
  assert.match(text, /\[model_providers\.openai\]/, "原来的供应商块也留着");
  assert.match(text, /^model = "deepseek-v4-pro"$/m);
  assert.match(text, /^model_provider = "deepseek"$/m);
  assert.match(text, /\[model_providers\.deepseek\]/);
  assert.match(text, /^base_url = "https:\/\/api\.deepseek\.com"$/m);
  assert.match(text, /^env_key = "DEEPSEEK_API_KEY"$/m, "Codex 从环境变量读 key，秘密不进文件");
  assert.match(text, /^wire_api = "responses"$/m, "chat 已经没了，只能写 responses");
  assert.equal(text.includes(KEY), false, "文件里不存在任何 API Key 值");
  const again = mergeCodexConfig(text, { providerId: "deepseek", displayName: "DeepSeek", baseUrl: "https://api.deepseek.com", envKey: "DEEPSEEK_API_KEY", model: "deepseek-v4-pro" });
  assert.equal(again.changed, false, "同样的合并第二次没有改动");
});

test("the diff a user approves never shows a credential", () => {
  const before = `${JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "old-secret-value" } }, null, 2)}\n`;
  const after = mergeClaudeSettings(before, claudeTemplate("deepseek", { apiKey: KEY, model: "deepseek-v4-pro" })).text;
  const diff = configurationDiff(before, after);
  const lines = diff.map((entry) => entry.text).join("\n");
  assert.equal(lines.includes(KEY), false, "新 key 不出现在 diff 里");
  assert.equal(lines.includes("old-secret-value"), false, "旧 key 也不出现");
  assert.ok(diff.some((entry) => entry.kind === "add" && entry.text.includes("ANTHROPIC_MODEL")), "改了什么要看得到");
  assert.ok(diff.some((entry) => entry.text.includes("ANTHROPIC_AUTH_TOKEN") && entry.masked === true), "被遮掉的那一行也要在，只是值被遮了");
  // 遮罩本身：值没了，键还在。
  assert.equal(maskSecrets('"ANTHROPIC_AUTH_TOKEN": "abc123"'), '"ANTHROPIC_AUTH_TOKEN": "••••"');
  assert.equal(maskSecrets('env_key = "DEEPSEEK_API_KEY"').includes("DEEPSEEK_API_KEY"), true, "env_key 是变量名，不是秘密");
});

// 用户手写的文件缩进和 Avenic 写的不一样，而这一次要改的只是模型：合并会把整份文件
// 按自己的缩进重排一遍，于是按行比较时每一行都算「变了」——包括那个字节都没动过的凭据
// 行（值被遮成 ••••，看上去就是「你的 key 被换掉了」）。这一屏说的是这次改动是什么，
// 不是哪些字节不同；重排不是改动，凭据那一行更没有理由出现在上面。
test("a re-indent does not turn a credential nobody touched into a change", () => {
  const before = `${JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: "old-secret-value", ANTHROPIC_BASE_URL: "https://api.deepseek.com/anthropic", ANTHROPIC_MODEL: "deepseek-v4-pro" } }, null, 4)}\n`;
  const after = mergeClaudeSettings(before, claudeTemplate("deepseek", { model: "deepseek-flash" })).text;
  const changed = configurationDiff(before, after).filter((entry) => entry.kind !== "same");
  assert.equal(changed.some((entry) => entry.text.includes("ANTHROPIC_AUTH_TOKEN")), false, "凭据没有变，就不该出现在这一屏上");
  assert.ok(changed.some((entry) => entry.kind === "add" && entry.text.includes("deepseek-flash")), "真变了的那一行要在");
});

// 文件还不存在 —— before 是空字符串（Codex 的项目配置就是这一条路：合并出来的文本不带
// 结尾换行）。空文档不是「一行空行」：那样的开头是一句「删掉一个空行」，而这一笔什么都
// 没删——一个从来没存在过的文件里也没有东西可删。
test("a file that does not exist yet is an addition, not a removal of nothing", () => {
  assert.deepEqual(
    configurationDiff("", 'model = "fixture-model"').filter((entry) => entry.kind !== "same"),
    [{ kind: "add", text: 'model = "fixture-model"', masked: false }],
    "新建一份文件只有加，没有减",
  );
  assert.deepEqual(configurationDiff("", ""), [], "空对空没有可看的改动");
});

test("a credential is masked even when its name says nothing", () => {
  // 名字不说自己是秘密的（自定义 provider 的 header、用户自己起的字段名）就得靠值本身
  // 认出来。预览是用户批准改动时读的东西，漏一个凭据，这一屏自己就成了泄漏点。
  const cases = [
    ['"x-api-key": "sk-live-0123456789abcdef"', "sk-live-0123456789abcdef"],
    ["Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def", "eyJhbGciOiJIUzI1NiJ9.abc.def"],
    ['endpoint = "ghp_abcdefghijklmnopqrst"', "ghp_abcdefghijklmnopqrst"],
    // 名字认不出来、值也不带任何厂商前缀的：一个连字符拼写的 header 名字仍要认出来，
    // 而一个 JWT 从长相上就是凭证，跟谁给它起的名字无关。
    ['"x-api-key": "opaque-fixture-value"', "opaque-fixture-value"],
    ['"custom-header": "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmaXh0dXJlIn0.c2lnbmF0dXJl"', "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmaXh0dXJlIn0.c2lnbmF0dXJl"],
  ];
  for (const [line, token] of cases) assert.equal(maskSecrets(line).includes(token), false, line);
  // 不是凭据的照常看得见：掩掉一个模型名是小事，掩掉一个 URL 会让人不知道为什么连不上。
  assert.equal(maskSecrets('base_url = "https://api.deepseek.com/anthropic"'), 'base_url = "https://api.deepseek.com/anthropic"');
});

// ---- 落盘：先给用户看要改什么，再改，而且只改模板点名的那些 ----
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { applyModelConfiguration, previewModelConfiguration } from "../packages/core/src/runtime/model-config.mjs";

async function world(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-center-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("a preview reads the real file and says what the write would change", async (t) => {
  const root = await world(t);
  await mkdir(path.join(root, ".claude"), { recursive: true });
  const file = path.join(root, ".claude", "settings.local.json");
  await writeFile(file, `${JSON.stringify({ permissions: { allow: ["Bash(ls)"] }, env: { MY_OWN_VAR: "1" } }, null, 2)}\n`);
  const template = claudeTemplate("deepseek", { apiKey: KEY, model: "deepseek-v4-pro" });

  const preview = await previewModelConfiguration(root, "claude", "project", template);
  assert.equal(preview.relative, ".claude/settings.local.json");
  assert.equal(preview.changed, true);
  assert.equal(preview.exists, true);
  // 预览不落盘：文件在磁盘上一个字节都没动。
  assert.equal(await readFile(file, "utf8"), `${JSON.stringify({ permissions: { allow: ["Bash(ls)"] }, env: { MY_OWN_VAR: "1" } }, null, 2)}\n`);
  // diff 里看得到改了哪几行，但看不到 key 的值。
  const shown = preview.diff.filter((entry) => entry.kind !== "same").map((entry) => entry.text).join("\n");
  assert.match(shown, /ANTHROPIC_BASE_URL/);
  assert.equal(shown.includes(KEY), false);
});

test("applying writes the merge, keeps the user's keys, and gives the file back to them", async (t) => {
  const root = await world(t);
  const template = claudeTemplate("deepseek", { apiKey: KEY, model: "deepseek-v4-pro" });
  const applied = await applyModelConfiguration(root, "claude", "project", template);
  assert.equal(applied.changed, true);
  const written = JSON.parse(await readFile(path.join(root, ".claude", "settings.local.json"), "utf8"));
  assert.equal(written.env.ANTHROPIC_AUTH_TOKEN, KEY);
  // 权限最紧的一档：这个文件里有别人的 key。POSIX 位只有类 Unix 表达得出来
  // （Windows 上 Node 忽略 mode，stat 永远报 666），所以两侧各断言它看得见的那
  // 一半：类 Unix 上断言同组与他人读不到；Windows 上断言没被写成只读——最紧的
  // 一档也不该把文件的主人关在门外。请求本身是跨平台的，由下一条测试盯着。
  const stats = await stat(path.join(root, ".claude", "settings.local.json"));
  if (process.platform === "win32") {
    assert.equal((stats.mode & 0o200) !== 0, true, "最紧的权限也不能写成只读，那是用户自己的文件");
  } else {
    const mode = stats.mode & 0o777;
    assert.equal(mode & 0o077, 0, `文件不该让同组或其他人读到，实际 ${mode.toString(8)}`);
  }
  // 账本只记「谁建的、当时是什么内容」，不记内容本身。
  const ledger = await readFile(path.join(root, ".agents", "local", "ownership.json"), "utf8");
  assert.equal(ledger.includes(KEY), false, "账本里不许出现 key");
  assert.match(ledger, /settings\.local\.json/);
  // 第二次应用同样的模板：值没变，文件不动，也不需要再写一次。
  const again = await applyModelConfiguration(root, "claude", "project", template);
  assert.equal(again.changed, false);
});

test("every write into a user's configuration goes through the one that asks for 0o600", async () => {
  // 请求本身是跨平台的，所以这一半钉在源码上：Windows 看不见 POSIX 位，看得见的
  // 只有「谁在写、以什么模式写」。写盘只能有一个出口，出口只能点名 0o600——
  // 多一个出口，模式就多一处可以忘。
  const source = await readFile(new URL("../packages/core/src/runtime/model-config.mjs", import.meta.url), "utf8");
  const helper = source.match(/async function writeAtomic[\s\S]*?\n}/);
  assert.ok(helper, "写盘要有一个唯一的出口，才能被钉住");
  assert.match(helper[0], /mode:\s*0o600/, "写一个装着 key 的文件，模式只能是 0o600");
  assert.equal((source.match(/\bwriteFile(Atomic)?\(/g) ?? []).length, 1, "只有那一个出口能碰磁盘");
  assert.equal((source.match(/await writeAtomic\(/g) ?? []).length, 3, "创建、迁移与合并三条路径都从出口走");
});

test("a Codex answer lands in Codex's own home for the project, never in Claude's file", async (t) => {
  const root = await world(t);
  const applied = await applyModelConfiguration(root, "codex", "project", codexTemplate("deepseek", { model: "deepseek-v4-pro" }));
  assert.equal(applied.relative, ".agents/local/codex/config.toml");
  const text = await readFile(applied.file, "utf8");
  assert.match(text, /^model = "deepseek-v4-pro"$/m);
  assert.match(text, /^model_provider = "deepseek"$/m);
  assert.equal(text.includes(KEY), false);
});
