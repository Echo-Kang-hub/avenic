import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PROVIDERS, modelCatalogCachePath, modelConfigTarget, providerPreset, providersForAgent } from "@avenic/core";
import type { CenterDraft, CenterResult } from "../src/dashboard/protocol.ts";
import { buildDashboardData } from "../src/dashboard/state.ts";
import { initialize } from "../src/services/agents.ts";
import { applyCenter, centerState, docsLink, fillFromPreset, previewCenter, refreshCenterModels, testCenter } from "../src/services/center.ts";
import { fillApiConfiguration } from "./api-config.ts";
import { testEnv } from "./helpers.ts";

// 模型配置中心（宿主侧）：整页的每一个事实都必须来自 agent 自己的那个文件，凭据
// 只以「有没有」的形式离开它。这里断言的是真行为——真项目、真文件、真 diff、真请求
// （网络用注入的 fetch 换掉，除此之外没有任何 mock）——而不是某段文案长什么样。
//
// 虚构的 key：任何一条断言里都不许出现真凭据，而这几条断言本身就在证明这件事。

const KEY = "sk-test-not-a-real-key";
const TYPED = "sk-test-not-a-real-key-2";
const BASE_URL = "https://api.deepseek.com/anthropic";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 一个项目：已经选了 API，文件里写着 DeepSeek 的端点、模型与一个凭据。 */
async function deepseekProject(root: string): Promise<string> {
  const project = path.join(root, "project");
  await mkdir(project, { recursive: true });
  await initialize(project, "claude", { authMethod: "api", configScope: "project", sessionScope: "project" });
  await fillApiConfiguration(project, "claude", "project", { baseUrl: BASE_URL, model: "deepseek-v4-pro", credential: KEY });
  return project;
}

function claudeFile(project: string): string {
  const target = modelConfigTarget(project, "claude", "project");
  assert.ok(target, "Claude 的项目作用域配置有它自己的路径");
  return target.file;
}

/** 一份「用户自己写的」Claude 配置：provider、模型角色、以及一堆不属于 Avenic 的键。 */
const USER_DOCUMENT = {
  env: {
    ANTHROPIC_BASE_URL: BASE_URL,
    ANTHROPIC_AUTH_TOKEN: KEY,
    ANTHROPIC_MODEL: "deepseek-v4-pro",
    ANTHROPIC_DEFAULT_SONNET_MODEL: "deepseek-flash",
    MY_OWN_VARIABLE: "keep me",
  },
  permissions: { allow: ["Bash(ls:*)"] },
  hooks: { Stop: [{ hooks: [{ type: "command", command: "echo done" }] }] },
  enabledPlugins: { "demo@market": true },
  autoUpdatesChannel: "latest",
};

/** The draft the page holds: the same three answers, plus the form's own fields. */
function draftOf(overrides: Partial<CenterDraft> = {}): CenterDraft {
  return { provider: "deepseek", baseUrl: BASE_URL, model: "deepseek-v4-pro", credential: null, roles: {}, blocks: [], ...overrides };
}

interface Call {
  url: string;
  init: { method?: string; headers?: Record<string, string>; body?: string };
}

/** 一个记下请求的 fetch：只有网络是假的，分类与写盘全是真的。 */
function recordingFetch(body: unknown, status = 200, ok = true): { calls: Call[]; fetchImpl: (url: string, init: Call["init"]) => Promise<{ ok: boolean; status: number; text(): Promise<string> }> } {
  const calls: Call[] = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return { ok, status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) };
    },
  };
}

test("the state is read off the agent's own file, in the preset's own words", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-center-"));
  try {
    const project = await deepseekProject(root);
    const state = await centerState(project, "claude", testEnv(path.join(root, "state")));

    assert.equal(state.agent, "claude");
    assert.equal(state.label, "Claude Code");
    assert.equal(state.auth, "api");
    assert.equal(state.scope, "project");
    assert.equal(state.relative, ".claude/settings.local.json");
    // 供应商不是页面记住的，是文件里那个地址读回来的：api.deepseek.com 是 DeepSeek。
    assert.equal(state.provider, "deepseek");
    assert.equal(state.baseUrl, BASE_URL);
    assert.equal(state.model, "deepseek-v4-pro");
    assert.equal(state.credentialSet, true, "文件里有凭据这件事可以说，凭据本身不可以");
    // 供应商推荐的映射与文件现在写着的值，是两件事。
    const sonnet = state.roles.find((role) => role.id === "sonnet");
    assert.deepEqual(sonnet, { id: "sonnet", recommended: "deepseek-v4-pro", current: null });
    assert.equal(JSON.stringify(state).includes(KEY), false, "凭据不得出现在整份状态里");
    // 预设栅格：这个 agent 的原生格式装得下的每一家，表里的顺序；选中的只有文件里那个地址。
    assert.deepEqual(state.providers.map((entry) => entry.id), providersForAgent("claude").map((preset) => preset.id));
    assert.deepEqual(state.providers.filter((entry) => entry.selected).map((entry) => entry.id), ["deepseek"]);
    const custom = state.providers.find((entry) => entry.id === "custom");
    assert.equal(custom?.baseUrl, null, "自己跑代理的那一家没有地址可推荐：地址是用户敲的");
    assert.ok(state.providers.every((entry) => entry.name.length > 0 && /^https?:\/\//.test(entry.docs)), "每一格都要有名字和自己那一页的地址");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a grid with no endpoint, and an agent with no grid, are both drawn honestly", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-center-grid-"));
  try {
    const env = testEnv(path.join(root, "state"));
    const project = path.join(root, "project");
    await mkdir(project, { recursive: true });
    // 还在用账号的 agent：栅格照样画得出来 —— 「能填哪些」与「文件里填了什么」是两件事，
    // 只是还没有一格是选中的（文件里没有地址，就没有哪一家被认出来）。
    await initialize(project, "claude", { authMethod: "account", configScope: "project", sessionScope: "project" });
    const account = await centerState(project, "claude", env);
    assert.equal(account.provider, null);
    assert.ok(account.providers.length > 0);
    assert.deepEqual(account.providers.filter((entry) => entry.selected), []);
    // 自管的那一家一个都不列：页面的那个空态说的就是这件事。
    assert.deepEqual((await centerState(project, "opencode", env)).providers, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the roles a file already maps are reported as current, and its other keys survive a write", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-center-roles-"));
  try {
    const project = await deepseekProject(root);
    const file = claudeFile(project);
    await writeFile(file, `${JSON.stringify(USER_DOCUMENT, null, 2)}\n`);

    const state = await centerState(project, "claude", testEnv(path.join(root, "state")));
    assert.equal(state.roles.find((role) => role.id === "sonnet")?.current, "deepseek-flash", "文件里写着的模型角色要读回来");
    assert.equal(state.roles.find((role) => role.id === "opus")?.recommended, "deepseek-v4-pro");
    // 可选块：文件里真的写着的那一个才叫开着。
    assert.deepEqual(state.blocks.map((block) => block.id), ["signature", "teammates", "toolSearch", "thinkingBudget", "autoUpgrade"]);
    assert.equal(state.blocks.find((block) => block.id === "autoUpgrade")?.on, true);
    assert.equal(state.blocks.find((block) => block.id === "signature")?.on, false);
    assert.ok(state.blocks.every((block) => block.name.length > 0), "每一块都要有一个名字，页面才有东西可画");
    // 这几块的名字也是宿主说的话（页面照原样画它）：编辑器是中文时它就得说中文。
    const zh = await centerState(project, "claude", testEnv(path.join(root, "state")), "zh-cn");
    assert.deepEqual(zh.blocks.map((block) => block.id), state.blocks.map((block) => block.id));
    assert.ok(zh.blocks.every((block) => /[㐀-鿿]/.test(block.name)), "中文编辑器里这几块的名字要是中文");

    const written = await applyCenter(project, "claude", draftOf({ model: "deepseek-flash" }), { environment: testEnv(path.join(root, "state")) });
    assert.equal(written.kind === "diff" && written.written, true);
    const after = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual(after.permissions, USER_DOCUMENT.permissions, "用户的 permissions 是用户的");
    assert.deepEqual(after.hooks, USER_DOCUMENT.hooks);
    assert.deepEqual(after.enabledPlugins, USER_DOCUMENT.enabledPlugins);
    assert.equal(after.env.MY_OWN_VARIABLE, "keep me");
    assert.equal(after.env.ANTHROPIC_DEFAULT_SONNET_MODEL, "deepseek-flash", "合并只动名字点到的键，别人的键原样留下");
    assert.equal(after.env.ANTHROPIC_AUTH_TOKEN, KEY, "没给凭据就是别动它");
    // 原子写：临时文件不留在目录里，留下的是一份完整的文档。
    assert.deepEqual((await readdir(path.dirname(file))).filter((name) => name.includes(".tmp-")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a draft that omits the credential leaves the file byte for byte alone", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-center-keep-"));
  try {
    const project = await deepseekProject(root);
    const file = claudeFile(project);
    const before = await readFile(file, "utf8");

    const preview = await previewCenter(project, "claude", draftOf(), { environment: testEnv(path.join(root, "state")) });
    assert.equal(preview.kind, "diff");
    assert.equal(preview.kind === "diff" && preview.written, false);
    assert.deepEqual(preview.kind === "diff" ? preview.lines.filter((line) => line.kind !== "same") : [null], [], "什么都没改就没有增删行");

    const applied = await applyCenter(project, "claude", draftOf(), { environment: testEnv(path.join(root, "state")) });
    assert.equal(applied.kind === "diff" && applied.written, false, "没有变化就不写盘");
    assert.equal(await readFile(file, "utf8"), before, "文件必须一个字节都没动");
    assert.ok(before.includes(KEY), "...包括文件里那个凭据");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an empty credential is a refusal, not a deletion", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-center-refuse-"));
  try {
    const project = await deepseekProject(root);
    const file = claudeFile(project);
    const before = await readFile(file, "utf8");

    await assert.rejects(
      () => previewCenter(project, "claude", draftOf({ credential: "" }), { environment: testEnv(path.join(root, "state")) }),
      /an API key is required/,
      "空白照模板的规矩是一份会失败的配置，不是一份悄悄没有凭据的配置",
    );
    await assert.rejects(() => applyCenter(project, "claude", draftOf({ credential: "" }), { environment: testEnv(path.join(root, "state")) }), /an API key is required/);
    assert.equal(await readFile(file, "utf8"), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 留空是「别动文件里那份凭据」——而那份凭据属于谁，只有文件说得出来。表单一换供应商，
// 这句话就不成立了：写下去的是新地址配上旧钥匙，每一次请求都会把它送到新供应商那里。
// 与 `avenic change` 是同一条规则：能不能留空，取决于文件里那份凭据是不是这一家的。
test("a blank credential is refused once the form names another provider", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-center-switch-"));
  try {
    const project = await deepseekProject(root);
    const file = claudeFile(project);
    const before = await readFile(file, "utf8");
    const env = testEnv(path.join(root, "state"));
    const moonshot = { provider: "moonshot", baseUrl: "https://api.moonshot.ai/anthropic", model: "fixture-moonshot-model" };

    await assert.rejects(
      () => previewCenter(project, "claude", draftOf(moonshot), { environment: env }),
      /belongs to another provider/,
      "文件里那把钥匙不是这一家的，空白就不再是一个答案",
    );
    await assert.rejects(() => applyCenter(project, "claude", draftOf(moonshot), { environment: env }));
    assert.equal(await readFile(file, "utf8"), before, "一个字节都没动：地址没换，旧钥匙也没有配上一个新地址");
    assert.ok(before.includes(KEY), "文件里原来那份凭据还在原处");

    // 换了家、也给了新钥匙：那就没有说不通的地方了。
    const applied = await applyCenter(project, "claude", draftOf({ ...moonshot, credential: TYPED }), { environment: env });
    assert.equal(applied.kind === "diff" && applied.written, true);
    const after = JSON.parse(await readFile(file, "utf8"));
    assert.equal(after.env.ANTHROPIC_BASE_URL, moonshot.baseUrl);
    assert.equal(after.env.ANTHROPIC_AUTH_TOKEN, TYPED, "新钥匙写下去，旧的那把不再留在文件里");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a typed key goes into the file and nowhere else — the diff masks it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-center-mask-"));
  try {
    const project = await deepseekProject(root);
    const preview = await previewCenter(project, "claude", draftOf({ credential: TYPED, model: "deepseek-flash" }), { environment: testEnv(path.join(root, "state")) });
    assert.equal(preview.kind, "diff");
    if (preview.kind !== "diff") return;
    assert.ok(preview.lines.some((line) => line.kind === "add" && line.text.includes("••••")), "凭据那一行要出现，值要被打掉");
    assert.equal(JSON.stringify(preview).includes(TYPED), false, "结果里不得有打出来的 key");
    assert.equal(JSON.stringify(preview).includes(KEY), false, "文件里原来那个也不许露出来");
    assert.deepEqual(Object.keys(preview).sort(), ["kind", "lines", "written"], "结果就是协议里那三个字段：没有 after 那样的整份文件");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a Codex provider is probed on the model list its vendor documents, a Claude one on the messages wire", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-center-wire-"));
  try {
    const env = { ...testEnv(path.join(root, "state")), DEEPSEEK_API_KEY: KEY };
    // Codex 只认 wire_api = "responses"（chat 那条线已经被删掉了，见
    // docs/provider-endpoints.md）：拿 chat/completions 去探，一个好好的网关会被要求改一个
    // 从来没错过的模型名。所以这一家探的是供应商自己文档里的模型名单 —— 不花 token，401 是
    // 认证失败，而名单里没有这个名字才是模型不可用。
    const list = recordingFetch({ data: [{ id: "deepseek-v4-pro" }, { id: "deepseek-flash" }] });
    const codex = await testCenter("codex", draftOf({ baseUrl: "https://api.deepseek.com", credential: null }), { environment: env, fetchImpl: list.fetchImpl });
    assert.deepEqual(codex, { kind: "connection", state: "connected", status: 200 });
    assert.equal(list.calls[0]?.url, "https://api.deepseek.com/models", "Codex 探的是供应商给的模型表地址");
    assert.equal(list.calls[0]?.init.method, "GET", "名单是读的，不是发的");
    assert.equal(list.calls[0]?.init.headers?.authorization, `Bearer ${KEY}`, "Codex 的凭据从它自己命名的环境变量里读");
    assert.equal(list.calls[0]?.url.includes(KEY), false, "key 不在 URL 里");

    // 名单在、名字不在：这是供应商自己的名单在说这件事，而且它说的是模型，不是地址。
    const short = recordingFetch({ data: [{ id: "deepseek-v4-pro" }] });
    const missing = await testCenter("codex", draftOf({ baseUrl: "https://api.deepseek.com", model: "no-such-model", credential: null }), { environment: env, fetchImpl: short.fetchImpl });
    assert.deepEqual(missing, { kind: "connection", state: "model-unavailable", status: 200 });

    const refusedList = recordingFetch({ error: "nope" }, 401, false);
    const unauthorized = await testCenter("codex", draftOf({ baseUrl: "https://api.deepseek.com", credential: null }), { environment: env, fetchImpl: refusedList.fetchImpl });
    assert.deepEqual(unauthorized, { kind: "connection", state: "authentication-failed", status: 401 }, "状态按状态码分类，不读正文");

    const messages = recordingFetch({ id: "msg_fixture" });
    const claude = await testCenter("claude", draftOf({ credential: TYPED }), { environment: env, fetchImpl: messages.fetchImpl });
    assert.deepEqual(claude, { kind: "connection", state: "connected", status: 200 });
    assert.equal(messages.calls[0]?.url, `${BASE_URL}/v1/messages`, "Claude 的话走 messages 那条线");
    assert.equal(messages.calls[0]?.init.headers?.authorization, `Bearer ${TYPED}`);

    const refused = recordingFetch({ error: "nope" }, 401, false);
    const failed = await testCenter("claude", draftOf({ credential: TYPED }), { environment: env, fetchImpl: refused.fetchImpl });
    assert.deepEqual(failed, { kind: "connection", state: "authentication-failed", status: 401 }, "状态按状态码分类，不读正文");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a probe says when there is nothing to probe with, instead of asking anyway", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-center-nokey-"));
  try {
    const env = testEnv(path.join(root, "state"));
    // 页面留空＝别动文件里那个 key —— 而那个 key 读不回来，所以没什么可测的。
    const kept = await testCenter("claude", draftOf(), { environment: env, fetchImpl: recordingFetch({}).fetchImpl });
    assert.equal(kept.kind, "error");
    assert.equal(kept.kind === "error" && kept.message.includes(KEY), false);
    // Codex 的凭据在它自己命名的环境变量里，那里没设就没得测。
    const codex = await testCenter("codex", draftOf({ baseUrl: "https://api.deepseek.com" }), { environment: env, fetchImpl: recordingFetch({}).fetchImpl });
    assert.equal(codex.kind, "error");
    assert.match(codex.kind === "error" ? codex.message : "", /DEEPSEEK_API_KEY/);
    // 还有第三种「没得测」：这个供应商没有公开的模型表地址（custom 就是用户自己的网关）。
    // 猜一条 /v1/models 去问就是拿一条编出来的路径去否定一个地址 —— 宁可说探不了。
    const nothing = recordingFetch({});
    const custom = await testCenter("codex", draftOf({ provider: "custom", baseUrl: "https://gateway.example/v1", credential: null }), { environment: { ...env, AVENIC_PROVIDER_API_KEY: KEY }, fetchImpl: nothing.fetchImpl });
    assert.equal(custom.kind, "error");
    assert.match(custom.kind === "error" ? custom.message : "", /documents no model list endpoint/);
    assert.equal(nothing.calls.length, 0, "探不了的那一次一个请求都不发");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the model catalog is fetched only when it is asked for, and the cache never holds the key", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-center-catalog-"));
  const realFetch = globalThis.fetch;
  try {
    const project = await deepseekProject(root);
    const env = testEnv(path.join(root, "state"));
    const cache = modelCatalogCachePath(project, "deepseek");
    // 「画这一页会去问供应商吗」——把整台机器的网络拔掉来回答。
    globalThis.fetch = async () => { throw new Error("drawing the page must not reach the network"); };
    const state = await centerState(project, "claude", env);
    assert.deepEqual(state.catalog, { at: null, note: null });
    assert.equal(existsSync(cache), false);
    await previewCenter(project, "claude", draftOf({ model: "deepseek-flash" }), { environment: env });
    assert.equal(existsSync(cache), false, "预览不刷新模型表");
    globalThis.fetch = realFetch;

    const list = recordingFetch({ data: [{ id: "deepseek-v4-pro" }, { id: "deepseek-flash" }, { id: "deepseek-v4-pro" }] });
    const result = await refreshCenterModels(project, "claude", draftOf({ credential: TYPED }), { environment: env, fetchImpl: list.fetchImpl });
    assert.deepEqual(result, { kind: "catalog", state: "fetched", provider: "deepseek", models: ["deepseek-v4-pro", "deepseek-flash"], note: null });
    assert.equal(list.calls[0]?.url, "https://api.deepseek.com/models", "模型表在供应商自己给的地址上");
    assert.equal(list.calls[0]?.init.headers?.authorization, `Bearer ${TYPED}`);
    assert.equal(list.calls[0]?.url.includes(TYPED), false);

    const kept = await readFile(cache, "utf8");
    assert.deepEqual(JSON.parse(kept).models, ["deepseek-v4-pro", "deepseek-flash"]);
    assert.equal(kept.includes(TYPED), false, "缓存里只有模型名和它们来的地址");
    const after = await centerState(project, "claude", env);
    assert.ok(after.catalog.at, "刷过之后这一页不用再问一次");
    assert.deepEqual(after.models, ["deepseek-v4-pro", "deepseek-flash"], "列表先给供应商自己文档里的名字，再给拉回来的那一份");

    // 刷新问的不是模型名：还不知道要填哪个模型的人，正是要刷新的人（协议里 requireModel=false）。
    const unnamed = await refreshCenterModels(project, "claude", draftOf({ model: "", credential: TYPED }), { environment: env, fetchImpl: recordingFetch({ data: [{ id: "deepseek-v4-pro" }] }).fetchImpl });
    assert.equal(unnamed.kind === "catalog" && unnamed.state, "fetched", "没有模型名也刷新得成");
  } finally {
    globalThis.fetch = realFetch;
    await rm(root, { recursive: true, force: true });
  }
});

// 用户可以在把新供应商写进文件之前就先问它的模型表（挑模型本来就在写之前）。那一问取回来的
// 是**那一家**的名字，所以它落进那一家自己的缓存文件，答案也说出这份名单属于谁——页面手里
// 的表单正是那一家，名单的归属不带回来，它就只能摆文件里那一家的名字。
test("a list fetched for another provider is cached under it, and the answer says whose it is", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-center-catalog-other-"));
  try {
    const project = await deepseekProject(root);
    const env = testEnv(path.join(root, "state"));
    const list = recordingFetch({ data: [{ id: "kimi-k2" }, { id: "kimi-k2-turbo" }] });
    const draft = draftOf({ provider: "moonshot", baseUrl: "https://api.moonshot.ai/anthropic", model: "", credential: TYPED });
    const result = await refreshCenterModels(project, "claude", draft, { environment: env, fetchImpl: list.fetchImpl });

    assert.deepEqual(result, { kind: "catalog", state: "fetched", provider: "moonshot", models: ["kimi-k2", "kimi-k2-turbo"], note: null });
    assert.equal(list.calls[0]?.url, "https://api.moonshot.ai/v1/models", "问的是这一家文档里的那一页，不是文件里那一家");
    assert.equal(list.calls[0]?.init.headers?.authorization, `Bearer ${TYPED}`);
    assert.deepEqual(JSON.parse(await readFile(modelCatalogCachePath(project, "moonshot"), "utf8")).models, ["kimi-k2", "kimi-k2-turbo"]);
    assert.equal(existsSync(modelCatalogCachePath(project, "deepseek")), false, "别家的名字不许落进这一家的缓存文件里");

    // 文件一句话都没动：页面读的仍然是文件里那一家（以及它自己的那一份名单）。
    const state = await centerState(project, "claude", env);
    assert.equal(state.provider, "deepseek");
    assert.deepEqual(state.models, ["deepseek-v4-pro", "deepseek-flash"]);
    assert.equal(state.catalog.at, null, "另一家的缓存不是这一家刷过");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a preset fills the form with what the vendor documents, and nothing else", () => {
  const claude = fillFromPreset("claude", "deepseek");
  assert.deepEqual(claude, { provider: "deepseek", baseUrl: BASE_URL, model: "deepseek-v4-pro", credential: null, roles: { opus: "deepseek-v4-pro", sonnet: "deepseek-v4-pro", haiku: "deepseek-flash" }, blocks: [] });
  // Codex 的配置里不写凭据，只写它该读哪个环境变量：所以这张表也没有 key 可填。
  const codex = fillFromPreset("codex", "deepseek");
  assert.equal(codex.credential, null);
  assert.equal(codex.baseUrl, "https://api.deepseek.com");
  // 自管的 agent 没有预设可填，也不该被悄悄换成一个别的。
  assert.throws(() => fillFromPreset("opencode", "deepseek"), /keeps its own provider configuration/);
  assert.throws(() => fillFromPreset("claude", "not-a-provider"), /does not know the provider not-a-provider/);
});

// 「供应商文档」这条链接由宿主查自己的表：页面只报 id。webview 手里的链接就是 webview
// 可能被骗着持有的链接，所以这一条既要有地址，也要在拿不到地址时什么都不做。
test("the vendor documentation link is looked up by the host, never handed to it", async () => {
  assert.equal(docsLink("deepseek"), providerPreset("deepseek")?.docs, "地址只从 core 的表里来");
  assert.match(docsLink("deepseek") ?? "", /^https:\/\//);
  assert.equal(docsLink("not-a-provider"), null, "不认识的 id 没有链接可开");
  assert.equal(docsLink(""), null);
  // 这道闸门要挡住的是 http(s) 以外的东西（file:、javascript: 之类）。表里今天一个这样的
  // 地址都没有 —— 所以这不是一条「碰得到的」分支，而是一条不许被碰的分支。
  for (const preset of PROVIDERS) assert.match(preset.docs, /^https?:\/\//, `${preset.id} 的文档地址`);
  const source = await readFile(path.join(pkgDir, "src", "commands", "center-commands.ts"), "utf8");
  assert.match(source, /case "centerOpenDocs"[\s\S]{0,300}docsLink\(action\.provider\)/, "开的那一页必须是宿主查出来的");
  assert.equal(source.includes("Uri.parse(action"), false, "地址不许从页面来");
});

test("a draft is validated against the preset before anything is written", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-center-validate-"));
  try {
    const project = await deepseekProject(root);
    const env = testEnv(path.join(root, "state"));
    await assert.rejects(() => previewCenter(project, "claude", draftOf({ provider: "nope" }), { environment: env }), /does not know the provider nope/, "没人认识的 id 是错，不是回退到 custom");
    // 用户自己敲的地址不属于表里任何一家：那就是 custom 这扇门，写的是他敲的那个地址。
    const preview = await previewCenter(project, "claude", draftOf({ baseUrl: "https://gateway.internal/anthropic", provider: "deepseek" }), { environment: env });
    assert.equal(preview.kind, "diff");
    if (preview.kind !== "diff") return;
    assert.ok(preview.lines.some((line) => line.kind === "add" && line.text.includes("https://gateway.internal/anthropic")));
    // 自管的 agent 没有可写的东西，这一页也不假装有。
    await assert.rejects(() => previewCenter(project, "opencode", draftOf(), { environment: env }), /keeps its own provider configuration/);
    const opencode = await centerState(project, "opencode", env);
    assert.deepEqual([opencode.provider, opencode.relative, opencode.credentialSet], [null, null, false]);
    assert.deepEqual([opencode.roles, opencode.blocks, opencode.models], [[], [], []]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the payload carries the Center's state only on the Center's own section", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-center-payload-"));
  try {
    const project = await deepseekProject(root);
    const env = testEnv(path.join(root, "state"));
    const other = await buildDashboardData(project, env, {});
    assert.equal(other.center, null, "别的分区不为这一页读一次盘");
    assert.equal(other.centerResult, null);

    const result: CenterResult = { kind: "diff", lines: [], written: false };
    const center = await buildDashboardData(project, env, { centerAgent: "claude", centerResult: result });
    assert.equal(center.center?.agent, "claude");
    assert.equal(center.center?.provider, "deepseek");
    assert.deepEqual(center.centerResult, result, "上一次问了什么，页面照样读到");

    // 编辑器自己的语言要一路走到这几块的名字上：面板知道它，页面只画收到的那句。
    const zh = await buildDashboardData(project, env, { centerAgent: "claude", language: "zh-cn" });
    assert.ok((zh.center?.blocks ?? []).every((block) => /[㐀-鿿]/.test(block.name)), "中文编辑器里这几块的名字要是中文");

    // 模型表那一行说的是「手里有多少」与「上一次问供应商的结果」：失败的原因不在盘上
    // （缓存只留成功的名单），所以它跟着面板记着的那份结果回到状态里。
    const failed: CenterResult = { kind: "catalog", state: "failed", note: "The provider answered HTTP 500." };
    const noted = await buildDashboardData(project, env, { centerAgent: "claude", centerResult: failed });
    assert.equal(noted.center?.catalog.note, "The provider answered HTTP 500.", "上一次刷新的原话要回到页面上");

    const none = await buildDashboardData(null, env, { centerAgent: "claude", centerResult: result });
    assert.equal(none.center, null, "没有项目就没有 agent 的文件可读");
    assert.equal(none.centerResult, null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Change 落在哪一页，取决于这个 agent 自己那份答案：API 的模型配置归中心，Account
// 仍然走那场项目问答。这个判断活在命令层，而命令层 import vscode —— 所以这条从源码
// 上钉住它（与 manifest/dashboard-open 那几条同一手法）：路由不许再把 agent 忘掉。
test("the Change button asks the agent's own answer before choosing a page", async () => {
  const source = await readFile(path.join(pkgDir, "src", "commands", "dashboard-commands.ts"), "utf8");
  assert.match(source, /case "change"[\s\S]{0,700}auth\?\.method === "api"[\s\S]{0,300}centerOn\(/, "P34：change 必须按这个 agent 的认证方式分流，API 的进中心，其余仍是项目问答");
  const protocol = await readFile(path.join(pkgDir, "src", "dashboard", "protocol.ts"), "utf8");
  assert.match(protocol, /case "centerOpen":/, "中心自己那一条入口也真的接上了");
});
