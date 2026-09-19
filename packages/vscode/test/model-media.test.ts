import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { maskSecret, normalizeProfile } from "@avenic/core";
import { buildDraftPreview, panelOptions, profileToDraft } from "../src/model/state.ts";
import type { DraftPreview, ProfileDraft } from "../src/model/protocol.ts";
// DOM 桩与渲染往返（renderDataMessage/fire/buttons/allText）是媒体页共用的：
// 会话页的测试跑的是同一份，页面的渲染路径只有一套执行环境。
import { allText, buttons, fire, lastPosted, plain, renderDataMessage, type Rendered, type StubNode } from "./fixtures/dom-stub.ts";

const mediaRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "media", "model");

test("view.html has the CSP placeholders and no remote resources", async () => {
  const html = await readFile(path.join(mediaRoot, "view.html"), "utf8");
  assert.match(html, /\{\{nonce\}\}/);
  assert.match(html, /\{\{cspSource\}\}/);
  assert.match(html, /\{\{mainJs\}\}/);
  assert.match(html, /\{\{style\}\}/);
  assert.equal(/https?:\/\//.test(html.replaceAll("{{cspSource}}", "")), false);
});

test("main.js renders user data with textContent only", async () => {
  const script = await readFile(path.join(mediaRoot, "main.js"), "utf8");
  assert.equal(script.includes("innerHTML"), false);
  assert.equal(/https?:\/\//.test(script), false);
  assert.match(script, /acquireVsCodeApi/);
  assert.match(script, /textContent/);
});

test("style.css uses VS Code theme variables", async () => {
  const style = await readFile(path.join(mediaRoot, "style.css"), "utf8");
  assert.match(style, /--vscode-/);
  assert.equal(/https?:\/\//.test(style), false);
});

/**
 * **当前**编辑器子树里符合条件的节点（按 className 精确匹配）。
 * rendered.created 是「本次 vm 生命周期里造过的所有节点」，重建编辑区后里面还留着上一轮的
 * 游离节点——数行数/找标红必须走挂载树，否则会把已经不在界面上的节点也算进去。
 */
function inEditor(rendered: Rendered, className: string | RegExp): StubNode[] {
  const root = rendered.byId.get("editor") as StubNode | undefined;
  if (root === undefined) return [];
  const matches = (value: string): boolean =>
    typeof className === "string" ? value === className : className.test(value);
  const found: StubNode[] = [];
  const walk = (node: StubNode): void => {
    for (const child of node.children) {
      if (matches(child.className)) found.push(child);
      walk(child);
    }
  };
  walk(root);
  return found;
}

// 草稿夹具由两份**真实来源**拼成，而不是手写一份可能漂移的假货：
//  * options ← state.ts 的 panelOptions()（成员与顺序来自 @avenic/core）
//  * profile ← profileToDraft(core 的 profile)
// 这样 core 加了角色/开关、或 host 改了 options 的形状，媒体测试会立刻红。
const SECRET = "sk-live-abcdefghijklmnop";

/** 配置库里真实存着的那份（含明文密钥）——host 侧预览要用它算「保留密钥」的结果。 */
const STORED = normalizeProfile({
  id: "mimo",
  name: "小米 MiMo",
  endpoint: {
    baseUrl: "https://token-plan-cn.xiaomimimo.com/anthropic",
    api: "anthropic",
    authField: "ANTHROPIC_AUTH_TOKEN",
    apiKey: SECRET,
  },
  models: { main: { id: "mimo-v2.5-pro" } },
});

function draftFixture(): ProfileDraft {
  return profileToDraft(STORED);
}

/**
 * host 侧的草稿 → 预览回包。直接调**真实的** buildDraftPreview，并且像 ModelPanel 一样把
 * 库中现有配置传成 existing（草稿 apiKey === null 时，预览里那条认证键就是它的掩码）。
 * 所以 requestUrl / 掩码 / 问题定位都不是测试手写的假数据。
 */
function projectionFor(draft: ProfileDraft): DraftPreview {
  return buildDraftPreview(structuredClone(draft), STORED);
}

function lastDraft(rendered: Rendered, type: string): ProfileDraft {
  const message = lastPosted(rendered, type);
  assert.ok(message, `没有收到 ${type} 消息`);
  return message.profile as ProfileDraft;
}

/** 把 host 的回包补给面板：清掉「有一条预览在飞」的状态，让后续操作能立刻再发一条。 */
function settle(rendered: Rendered, draft: ProfileDraft): void {
  rendered.send({ type: "projection", payload: projectionFor(draft) });
}

function card(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const draft = draftFixture();
  return {
    id: draft.id,
    name: draft.name,
    baseUrl: draft.baseUrl,
    api: draft.api,
    apiKeyMasked: maskSecret(SECRET),
    hasStoredApiKey: true,
    mainModel: draft.models.main?.id ?? "",
    current: false,
    compatibility: {
      claude: { ok: true },
      codex: { ok: false, reason: "需 Responses API" },
      opencode: { ok: true },
    },
    profile: draft,
    ...overrides,
  };
}

function panelData(projectRoot: string | null): Record<string, unknown> {
  return {
    libraryPath: "C:\\Users\\x\\.config\\avenic\\models.json",
    libraryExists: true,
    libraryBroken: null,
    projectRoot,
    cards: [card({ current: true }), card({ id: "kimi", name: "项目 B 配置（Kimi）" })],
    binding: projectRoot === null ? null : { profileId: "mimo", name: "小米 MiMo" },
    projection: null,
    options: panelOptions(),
    notes: [],
    message: null,
  };
}

/** 打开卡片编辑区（点击卡片上的「编辑」）。 */
function openEditor(rendered: Rendered): void {
  const edit = buttons(rendered, "编辑")[0];
  assert.ok(edit, "卡片上必须有「编辑」按钮");
  fire(edit);
}

function requestHint(rendered: Rendered): StubNode | undefined {
  return rendered.created.filter((node) => node.className === "hint" && node.textContent.startsWith("将请求：")).at(-1);
}

function projectionPre(rendered: Rendered): StubNode | undefined {
  return rendered.created.filter((node) => node.tagName === "PRE" && node.className === "json").at(-1);
}

/** 编辑区里的某个输入框：按当前值找（面板的输入框都没有 id/name）。 */
function inputWithValue(rendered: Rendered, value: string): StubNode | undefined {
  return rendered.created.filter((node) => node.tagName === "INPUT" && node.value === value).at(-1);
}

// 回归钉子（设计 §9.3）：这两个特性**已经存在**，重写不得把它们弄丢。
// 回包夹具由 projectionFor() 生成（与 host 同一条路径），不是手写的假数据。
test("the editor keeps a live request-URL preview that follows Base URL and API type", async () => {
  const source = await readFile(path.join(mediaRoot, "main.js"), "utf8");
  const rendered = renderDataMessage(panelData("/repo/proj-a"), source);
  openEditor(rendered);
  const draft = draftFixture();

  // 1. 打开即请求 host 预览（面板不再自己拼地址），回包后显示解析结果。
  assert.equal(lastPosted(rendered, "preview") !== undefined, true, "打开编辑区必须请求一次 host 预览");
  settle(rendered, draft);
  assert.equal(requestHint(rendered)?.textContent, "将请求：https://token-plan-cn.xiaomimimo.com/anthropic/v1/messages");

  // 2. 改 Base URL 会再发一条 preview（地址本身仍以 host 回包为准）。
  const baseUrlInput = inputWithValue(rendered, "https://token-plan-cn.xiaomimimo.com/anthropic");
  assert.ok(baseUrlInput, "编辑区必须有 Base URL 输入框，且回显卡片当前值");
  const before = rendered.posted.length;
  baseUrlInput.value = "https://token-plan-cn.xiaomimimo.com/anthropic/v1";
  fire(baseUrlInput, "input");
  const sent = rendered.posted.slice(before).filter((message) => (message as { type: string }).type === "preview");
  assert.equal(sent.length, 1, "编辑一次只发一条预览请求");
  assert.equal(lastDraft(rendered, "preview").baseUrl, "https://token-plan-cn.xiaomimimo.com/anthropic/v1");
  draft.baseUrl = "https://token-plan-cn.xiaomimimo.com/anthropic/v1"; // 与面板同步，让 host 重算
  settle(rendered, draft);
  // core 的 /v1 去重规则生效：已含 /v1 就不再追加。
  assert.equal(requestHint(rendered)?.textContent, "将请求：https://token-plan-cn.xiaomimimo.com/anthropic/v1/messages");

  // 3. 切换 API 类型换后缀。
  const apiSelect = rendered.created.filter((node) => node.tagName === "SELECT").at(0);
  assert.ok(apiSelect, "编辑区必须有 API 类型下拉框");
  apiSelect.value = "openai-responses";
  fire(apiSelect, "change");
  draft.api = "openai-responses";
  settle(rendered, draft);
  assert.equal(requestHint(rendered)?.textContent, "将请求：https://token-plan-cn.xiaomimimo.com/anthropic/v1/responses");

  // 4. baseUrl 无效：host 回 requestUrl === null + 一条定位到 baseUrl 的问题。
  draft.baseUrl = "not-a-url";
  settle(rendered, draft);
  assert.equal(requestHint(rendered)?.textContent, "将请求：（Base URL 无效，无法解析请求地址）");
  assert.match(allText(rendered), /Base URL/);
});

test("the editor keeps a folded, masked projection preview", async () => {
  const source = await readFile(path.join(mediaRoot, "main.js"), "utf8");
  const rendered = renderDataMessage(panelData("/repo/proj-a"), source);
  openEditor(rendered);

  const details = rendered.created.filter((node) => node.tagName === "DETAILS" && node.className === "preview").at(-1);
  assert.ok(details, "投影预览必须是可折叠的 <details class=\"preview\">");
  const summary = details.children.find((child) => child.tagName === "SUMMARY");
  assert.match(summary?.textContent ?? "", /\.claude\/settings\.local\.json/);
  assert.equal(details.children.some((child) => child.tagName === "PRE"), true, "折叠区里必须是 <pre>");

  // 回包里的密钥值本来就是掩码——面板拿到什么就渲染什么（它自己也从不持有明文）。
  settle(rendered, draftFixture());
  const json = projectionPre(rendered)?.textContent ?? "";
  assert.match(json, /ANTHROPIC_BASE_URL/);
  assert.match(json, new RegExp(maskSecret(SECRET)));
  assert.equal(json.includes(SECRET), false, "预览里绝不能出现完整密钥");
});

// §7 的边界：面板打开时拿到的卡片数据里就没有明文，输入框也必须是空的。
// 反例（修复前的真实行为）：host 送 apiKeyPrefill 明文、面板把它当成表单值塞进密码框，
// 于是"打开编辑区"就等于把密钥复制了一份到 webview 的 DOM 里。
test("opening the editor never puts a stored secret into the webview", async () => {
  const source = await readFile(path.join(mediaRoot, "main.js"), "utf8");
  const rendered = renderDataMessage(panelData("/repo/proj-a"), source);
  openEditor(rendered);

  const payload = panelData("/repo/proj-a");
  assert.equal(JSON.stringify(payload.cards).includes(SECRET), false, "卡片数据里不得有明文密钥");

  const passwords = rendered.created.filter((node) => node.tagName === "INPUT" && node.type === "password");
  assert.equal(passwords.length, 1, "编辑区必须有一个密码框");
  assert.equal(passwords[0].value, "", "密码框必须是空的（空 = 保留库中密钥）");
  assert.equal(rendered.texts.join("\n").includes(SECRET), false, "界面上任何地方都不得出现明文密钥");

  // 不碰密钥直接保存 → 草稿里 apiKey === null（保留），而不是任何掩码字符串。
  const save = buttons(rendered, "保存")[0];
  assert.ok(save);
  fire(save);
  const saved = rendered.posted.filter((message) => (message as { type: string }).type === "saveProfile").at(-1) as { profile: ProfileDraft };
  assert.equal(saved.profile.apiKey, null, "没动过密钥 → 保留现有密钥（null）");
  assert.equal(JSON.stringify(saved).includes("…"), false, "掩码字符串绝不能当值回传");
});

// §7 的三态：清空输入框 = 不修改；输入新密钥 = 替换；点「清除密钥」= 明确删除。
test("the API key box expresses keep / replace / clear without ever showing a mask as a value", async () => {
  const source = await readFile(path.join(mediaRoot, "main.js"), "utf8");
  const rendered = renderDataMessage(panelData("/repo/proj-a"), source);
  openEditor(rendered);
  const password = rendered.created.filter((node) => node.tagName === "INPUT" && node.type === "password")[0];
  const lastSave = () => rendered.posted.filter((message) => (message as { type: string }).type === "saveProfile").at(-1) as { profile: ProfileDraft };

  // 键入新密钥 → 明文回传（这是用户自己输入的新值），且预览请求里带的是新值。
  password.value = "sk-brand-new-key-0001";
  fire(password, "input");
  fire(buttons(rendered, "保存")[0]);
  assert.equal(lastSave().profile.apiKey, "sk-brand-new-key-0001");

  // 再清空输入框 → 回到「不修改」。
  password.value = "";
  fire(password, "input");
  fire(buttons(rendered, "保存")[0]);
  assert.equal(lastSave().profile.apiKey, null);

  // 点「清除密钥」→ 空串（明确删除），输入框同时被清空。
  const clear = buttons(rendered, "清除密钥")[0];
  assert.ok(clear, "必须有「清除密钥」按钮");
  fire(clear);
  assert.equal(password.value, "");
  fire(buttons(rendered, "保存")[0]);
  assert.equal(lastSave().profile.apiKey, "", "清除 = 空串，而不是 null");
});

// §9.3「预设」：磁贴存在、只填起点字段、永不自动落盘、不得覆盖已有的模型 ID。
test("preset tiles prefill only the spec fields and never touch the model mapping", async () => {
  const source = await readFile(path.join(mediaRoot, "main.js"), "utf8");
  const rendered = renderDataMessage(panelData("/repo/proj-a"), source);
  openEditor(rendered);
  const draft = draftFixture(); // main 已有 ID：mimo-v2.5-pro

  settle(rendered, draft); // 先把打开编辑区时那条预览请求结掉
  const presets = panelOptions().presets;
  assert.ok(presets.length >= 6, `预设至少 6 个磁贴，实际 ${presets.length}`);
  const tiles = rendered.created.filter((node) => node.className === "preset");
  assert.equal(tiles.length, presets.length, "每个预设一个磁贴");
  assert.match(allText(rendered), /预设只是起点，请以服务商文档为准/);

  const before = rendered.posted.length;
  fire(tiles[0]);

  // 1. 只发预览请求；**没有任何** saveProfile（永不自动保存）。
  const after = rendered.posted.slice(before);
  assert.equal(after.some((message) => (message as { type: string }).type === "saveProfile"), false, "点预设绝不能自动保存");
  const preview = lastDraft(rendered, "preview");
  assert.equal(after.some((message) => (message as { type: string }).type === "preview"), true, "点预设要刷新一次 host 预览");
  assert.equal(preview.baseUrl, presets[0].baseUrl);
  assert.equal(preview.api, presets[0].api);
  // 2. 已有的模型 ID 原样保留（预设不碰 models）。
  assert.equal(preview.models.main?.id, draft.models.main?.id);
  assert.deepEqual(plain(preview.models), plain(draft.models));
});

// §5.2 / §9.3「认证字段」：下拉框的选项来自 core 的 AUTH_FIELDS，改动带回草稿。
test("the auth field select offers exactly core's AUTH_FIELDS and round-trips", async () => {
  const source = await readFile(path.join(mediaRoot, "main.js"), "utf8");
  const rendered = renderDataMessage(panelData("/repo/proj-a"), source);
  openEditor(rendered);

  const expected = panelOptions().authFields;
  const select = rendered.created
    .filter((node) => node.tagName === "SELECT")
    .find((node) => node.children.filter((child) => child.tagName === "OPTION").map((child) => child.value).join(",") === expected.join(","));
  assert.ok(select, `必须有认证字段下拉框，选项为 ${expected.join("/")}`);

  select.value = expected[1];
  fire(select, "change");
  assert.equal(lastDraft(rendered, "preview").authField, expected[1]);
});

// §9.3「完整模型映射」：六个角色都有输入行；显示名只出现在 core 会写 `_MODEL_NAME` 的角色；
// 1M 勾选框只给 Opus / Sonnet；「同主模型」一键填充。
test("the model table covers every core role with display names and 1M only where the spec allows", async () => {
  const source = await readFile(path.join(mediaRoot, "main.js"), "utf8");
  const rendered = renderDataMessage(panelData("/repo/proj-a"), source);
  openEditor(rendered);
  const opts = panelOptions();

  for (const role of opts.roles) {
    assert.ok(allText(rendered).includes(role.label), `模型行缺少角色 ${role.label}`);
  }
  assert.equal(rendered.created.filter((node) => node.className === "model-row").length, opts.roles.length);

  // 1M 勾选框只出现在 longContextRoles 上（设计只允许 Opus / Sonnet）。
  const oneM = rendered.created.filter((node) => node.tagName === "SPAN" && node.textContent === "1M");
  assert.equal(oneM.length, opts.longContextRoles.length);
  assert.deepEqual(opts.longContextRoles, ["opus", "sonnet"]);

  // 显示名的分界线来自 core 的 ROLE_KEYS（不是面板自己编的）。
  const display = rendered.created.filter((node) => node.tagName === "INPUT" && node.placeholder === "显示名（可留空）");
  assert.equal(display.length, opts.displayRoles.length);
  assert.deepEqual(opts.displayRoles, ["opus", "sonnet", "haiku", "fable"]);

  // 「同主模型」：把主模型 ID 填进该行。主模型为空时按钮禁用。
  const sameButtons = buttons(rendered, "同主模型");
  assert.equal(sameButtons.length, opts.roles.length - 1, "除主模型外每行一个「同主模型」");
  const opusRow = rendered.created.filter((node) => node.className === "model-row")[opts.roles.findIndex((role) => role.id === "opus")];
  assert.equal(opusRow.children.some((child) => child.value === draftFixture().models.main?.id), false, "初始时 opus 行没有主模型 ID");
  fire(sameButtons.find((button) => opusRow.children.includes(button)) as StubNode);
  assert.equal(lastDraft(rendered, "preview").models.opus?.id, draftFixture().models.main?.id);

  // 改一个角色的 ID 会带回草稿（round-trip 的起点）；清空 = 删除该映射。
  const fableRow = rendered.created.filter((node) => node.className === "model-row")[opts.roles.findIndex((role) => role.id === "fable")];
  const fableInput = fableRow.children.find((child) => child.tagName === "INPUT");
  assert.ok(fableInput);
  fableInput.value = "fable-1";
  fire(fableInput, "input");
  assert.equal(lastDraft(rendered, "preview").models.fable?.id, "fable-1");
});

// §9.3「六个开关」：人话名称 + **实际写入的键名**（键名来自 core 的 TOGGLE_ENTRIES）。
test("every toggle renders its human label next to the key it actually writes", async () => {
  const source = await readFile(path.join(mediaRoot, "main.js"), "utf8");
  const rendered = renderDataMessage(panelData("/repo/proj-a"), source);
  openEditor(rendered);
  const toggles = panelOptions().toggles;

  assert.equal(toggles.length, 6, "设计里正好六个开关");
  const rows = rendered.created.filter((node) => node.className === "toggle");
  assert.equal(rows.length, toggles.length);
  for (const toggle of toggles) {
    assert.ok(allText(rendered).includes(toggle.label), `开关 ${toggle.id} 缺少人话名称`);
    assert.ok(allText(rendered).includes(toggle.writes), `开关 ${toggle.id} 没有显示实际写入的键名`);
    assert.equal(toggle.writes === "" || toggle.writes === toggle.id, false, `开关 ${toggle.id} 的 writes 不像是真实键名`);
  }

  // 勾上一个开关 → 草稿的 toggles 里出现它。
  const target = toggles[2];
  const row = rows[2];
  const checkbox = row.children.find((child) => child.tagName === "INPUT");
  assert.ok(checkbox);
  checkbox.checked = true;
  fire(checkbox, "change");
  assert.deepEqual(plain(lastDraft(rendered, "preview").toggles), [target.id]);
});

// §5.5 / §9.3「高级」的自定义环境变量：加行 / 删行 / 问题定位到行。
test("custom env rows can be added and removed and carry located issues", async () => {
  const source = await readFile(path.join(mediaRoot, "main.js"), "utf8");
  const rendered = renderDataMessage(panelData("/repo/proj-a"), source);
  openEditor(rendered);
  const draft = draftFixture();
  settle(rendered, draft);

  fire(buttons(rendered, "添加一行")[0]);
  assert.deepEqual(plain(lastDraft(rendered, "preview").env), [{ key: "", value: "" }], "「添加一行」推入一个空行");

  let keyInput = rendered.created.filter((node) => node.placeholder === "变量名（如 AVENIC_FLAG）").at(-1);
  assert.ok(keyInput, "环境变量行必须有变量名输入框");
  keyInput.value = "AVENIC_FLAG";
  fire(keyInput, "input");
  const valueInput = rendered.created.filter((node) => node.placeholder === "值" && node.tagName === "INPUT").at(-1);
  assert.ok(valueInput);
  valueInput.value = "1";
  fire(valueInput, "input");
  assert.deepEqual(plain(lastDraft(rendered, "preview").env), [{ key: "AVENIC_FLAG", value: "1" }]);

  // 第二行填一个**受管键**（core 说端点会写 ANTHROPIC_BASE_URL，用户不能再自定义同名键）。
  fire(buttons(rendered, "添加一行")[0]);
  const secondKey = rendered.created.filter((node) => node.placeholder === "变量名（如 AVENIC_FLAG）").at(-1) as StubNode;
  secondKey.value = "ANTHROPIC_BASE_URL";
  fire(secondKey, "input");
  assert.equal(inEditor(rendered, /^env-row/).length, 2);

  // host 判定「与受管 env 冲突」→ 问题挂在那一行，并且那一行被标红。
  // 回包由**面板自己刚发出去的草稿**算出来（与真实 host 收到的东西逐字一致），
  // 判定本身是 core 的，不是测试手写的问题列表。
  const payload = projectionFor(lastDraft(rendered, "preview"));
  assert.equal(payload.issues.length, 1, "core 必须把受管 env 冲突报成一条问题");
  assert.equal(payload.issues[0].field, "env.1.key");
  rendered.send({ type: "projection", payload });
  assert.match(allText(rendered), /环境变量第 2 行/);
  assert.match(allText(rendered), /由 Avenic 管理/);
  assert.equal(inEditor(rendered, "env-row invalid").length, 1, "只有出问题的那一行被标红");
  assert.match(allText(rendered), /有 1 个问题需要先修正/);

  // 删除第一行 → 草稿里只剩那一行受管键（行号就是索引，删除必须重建，否则后面的行会串位）。
  const rows = inEditor(rendered, /^env-row/);
  fire(buttons(rendered, "删除").find((button) => rows[0].children.includes(button)) as StubNode);
  assert.deepEqual(plain(lastDraft(rendered, "preview").env), [{ key: "ANTHROPIC_BASE_URL", value: "" }]);
  // 删完之后问题也没了：受管键冲突是 core 按**行内容**判的，行没了问题就没了。
  assert.equal(inEditor(rendered, "env-row invalid").length, 0);
});

// §9.3：Agent 覆盖只给真实 schema 里存在的 Agent（codex / opencode），不凭空造 Claude 的。
test("Agent overrides are offered for exactly the agents core supports", async () => {
  const source = await readFile(path.join(mediaRoot, "main.js"), "utf8");
  const rendered = renderDataMessage(panelData("/repo/proj-a"), source);
  openEditor(rendered);

  const rows = rendered.created.filter((node) => node.className === "override-row");
  assert.equal(rows.length, 2, "core 的 ProfileOverrides 只有 codex / opencode");
  assert.deepEqual(rows.map((row) => row.children[0].textContent), ["Codex", "OpenCode"]);
  assert.match(allText(rendered), /Claude 直接使用上面的主端点/);

  const codexBaseUrl = rows[0].children.find((child) => child.tagName === "INPUT") as StubNode;
  codexBaseUrl.value = "https://codex.example/v1";
  fire(codexBaseUrl, "input");
  const preview = lastDraft(rendered, "preview");
  assert.equal(preview.overrides.codex?.baseUrl, "https://codex.example/v1");
  assert.equal("apiKey" in (preview.overrides.codex ?? {}), false, "覆盖草稿里没有密钥的位置");
  assert.equal("authField" in (preview.overrides.codex ?? {}), false, "覆盖草稿里没有认证字段的位置");
});

// §9.3：Codex 的 providerId / envKey / reasoningEffort 与 OpenCode 的 providerId / npmAdapter，
// 下拉取值全部来自 core 导出的清单。
test("codex and opencode fields come from core's lists", async () => {
  const source = await readFile(path.join(mediaRoot, "main.js"), "utf8");
  const rendered = renderDataMessage(panelData("/repo/proj-a"), source);
  openEditor(rendered);

  const effort = rendered.created
    .filter((node) => node.tagName === "SELECT")
    .find((node) => node.children.filter((child) => child.tagName === "OPTION").map((child) => child.value).join(",") === panelOptions().codexEffort.join(","));
  assert.ok(effort, "reasoningEffort 必须是 core 的 CODEX_EFFORTS 下拉框");
  effort.value = "high";
  fire(effort, "change");
  assert.equal(lastDraft(rendered, "preview").codex.reasoningEffort, "high");

  const providerId = rendered.created.filter((node) => node.placeholder === "留空 = core 默认 avenic_<id>").at(-1);
  assert.ok(providerId, "Codex providerId 输入框");
  providerId.value = "mycodex";
  fire(providerId, "input");
  const envKey = rendered.created.filter((node) => node.placeholder === "留空 = core 默认 AVENIC_MODEL_KEY").at(-1);
  assert.ok(envKey, "Codex envKey 输入框");
  envKey.value = "MY_KEY";
  fire(envKey, "input");
  const npmAdapter = rendered.created.filter((node) => node.placeholder === "留空 = core 默认 @ai-sdk/openai-compatible").at(-1);
  assert.ok(npmAdapter, "OpenCode npmAdapter 输入框");
  npmAdapter.value = "@ai-sdk/openai-compatible";
  fire(npmAdapter, "input");
  const preview = lastDraft(rendered, "preview");
  assert.equal(preview.codex.providerId, "mycodex");
  assert.equal(preview.codex.envKey, "MY_KEY");
  assert.equal(preview.opencode.npmAdapter, "@ai-sdk/openai-compatible");

  // Claude 顶层透传是只读的（不实现 JSON 编辑器）：展示 + 「在编辑器中打开」。
  const passthrough = rendered.created.filter((node) => node.tagName === "PRE" && node.className === "json small").at(-1);
  assert.ok(passthrough, "必须只读展示 Claude 顶层透传");
  assert.ok(buttons(rendered, "在编辑器中打开 .claude/settings.local.json").length > 0);
});

// §9.6：粘贴识别出的 `${role}Model` 落到各自的角色行，不再被一股脑塞进主模型。
// 反例（修复前的真实行为）：/Model$/ 匹配到 opusModel 也走 mainModel 分支，于是识别出的
// Opus/Haiku 模型全被写进主模型 —— 且 `mainModel === ""` 的守卫让第二行起被静默丢弃。
test("paste import routes each recognized role to its own row", async () => {
  const source = await readFile(path.join(mediaRoot, "main.js"), "utf8");
  const rendered = renderDataMessage(panelData("/repo/proj-a"), source);

  rendered.send({
    type: "parsed",
    payload: {
      json: {
        form: "claude-settings",
        recognized: [
          { field: "baseUrl", value: "https://pasted.example/anthropic" },
          { field: "apiKey", value: "sk-pasted-0000000000", source: "pasted" },
          { field: "mainModel", value: "mimo-v2.5-pro" },
          { field: "opusModel", value: "opus-4" },
          { field: "haikuModel", value: "haiku-4" },
        ],
        passthrough: { statusLine: { type: "command" } },
        candidates: {},
      },
    },
  });
  assert.match(allText(rendered), /多个候选全部列出/);
  // 结果表里出现的密钥是掩码，不是明文。
  assert.equal(allText(rendered).includes("sk-pasted-0000000000"), false, "识别结果表里只显示掩码");

  // 「填入表单」这个按钮是 view.html 里的静态元素（getElementById 拿到的），不在 created 里。
  fire(rendered.byId.get("fill") as StubNode);

  const preview = lastDraft(rendered, "preview");
  assert.equal(preview.baseUrl, "https://pasted.example/anthropic");
  assert.equal(preview.apiKey, "sk-pasted-0000000000", "用户自己粘进来的密钥作为「新密钥」进草稿");
  assert.equal(preview.models.main?.id, "mimo-v2.5-pro");
  assert.equal(preview.models.opus?.id, "opus-4", "opusModel 必须落到 opus 行");
  assert.equal(preview.models.haiku?.id, "haiku-4", "haikuModel 必须落到 haiku 行");
  assert.deepEqual(plain(preview.passthrough), { statusLine: { type: "command" } }, "claude-settings 形态的未知键进透传区");
  // 密码框仍然是空的（新密钥在草稿里，不以掩码形态冒充表单值）。
  const password = rendered.created.filter((node) => node.tagName === "INPUT" && node.type === "password").at(-1) as StubNode;
  assert.equal(password.value, "");
  assert.match(allText(rendered), /将写入新密钥/);
});

// §7：core 把掩码形态的"密钥"从识别结果里剔掉了，面板要把这条说明显示出来——
// 否则用户只会看到"没识别到密钥"而不知道原因。填入表单后草稿里的 apiKey 仍是 null
// （= 保留库里已有的），绝不会把掩码当新密钥写进去。
test("a mask-shaped pasted secret is reported and never filled into the draft", async () => {
  const source = await readFile(path.join(mediaRoot, "main.js"), "utf8");
  const rendered = renderDataMessage(panelData("/repo/proj-a"), source);
  rendered.send({
    type: "parsed",
    payload: {
      json: {
        form: "claude-settings",
        recognized: [{ field: "baseUrl", value: "https://pasted.example/anthropic" }],
        passthrough: {},
        candidates: { apiKey: [] },
        warnings: ["ANTHROPIC_AUTH_TOKEN 的值看起来是掩码（sk-…f3a2），不是完整密钥：已忽略，请粘贴完整密钥或留空后手工填写"],
      },
    },
  });
  assert.match(allText(rendered), /已忽略，请粘贴完整密钥/);

  fire(rendered.byId.get("fill") as StubNode);
  const preview = lastDraft(rendered, "preview");
  assert.equal(preview.apiKey, null, "没被识别的密钥 = 保留库里的，不是把掩码写进去");
  assert.equal(preview.baseUrl, "https://pasted.example/anthropic");
  assert.match(allText(rendered), /将保留配置库里已有的密钥/);
});

// §9.2 的 [复制]：常驻卡片操作。
test("cards expose the duplicate action", async () => {
  const source = await readFile(path.join(mediaRoot, "main.js"), "utf8");
  const rendered = renderDataMessage(panelData("/repo/proj-a"), source);
  const copies = buttons(rendered, "复制");
  assert.equal(copies.length, 2, "每张卡片都有「复制」");
  fire(copies[0]);
  assert.deepEqual(lastPosted(rendered, "duplicateProfile"), { type: "duplicateProfile", id: "mimo" });
});

test("main.js renders cards without throwing and gates binding on the project root", async () => {
  const source = await readFile(path.join(mediaRoot, "main.js"), "utf8");

  const bound = renderDataMessage(panelData("/repo/proj-a"), source);
  assert.ok(bound.texts.length > 0, "渲染路径必须发生 textContent 赋值");
  assert.ok(bound.texts.includes("小米 MiMo"), "卡片名称必须被渲染出来");
  assert.ok(bound.texts.includes("项目 B 配置（Kimi）"));
  const enabled = bound.created.filter((node) => node.tagName === "BUTTON" && node.textContent === "用于当前项目");
  assert.equal(enabled.length, 2);
  assert.equal(enabled.every((node) => node.disabled === false), true, "有项目时绑定按钮可用");

  const unbound = renderDataMessage(panelData(null), source);
  const disabled = unbound.created.filter((node) => node.tagName === "BUTTON" && node.textContent === "用于当前项目");
  assert.equal(disabled.length, 2);
  assert.equal(disabled.every((node) => node.disabled === true), true, "无项目时绑定按钮禁用");
  assert.equal(disabled.every((node) => node.title === "未打开项目文件夹"), true);
});
