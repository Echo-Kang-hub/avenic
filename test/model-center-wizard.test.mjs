// The Model Configuration Center's questions, and what answering them writes.
//
// The Center is not a settings format of its own: it is a small set of questions
// whose answers fill *the agent's own* configuration file, in the agent's own
// keys. The questions live in core because three hosts ask them — the terminal
// wizard, the editor's QuickPick, the dashboard — and a provider chosen in one
// has to be the provider the others read back.
//
// Two rules run through every test here. A secret travels one way only: into the
// agent's file, never into Avenic's project settings, never into a summary, never
// into a diff. And a question nobody answered writes nothing — the default answer
// is "Set up by hand", which is exactly the contract Avenic had before the Center
// existed, so a project that never opens the Center cannot be changed by it.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyProjectDraft,
  loadRuntime,
  modelConfigPresence,
  projectConfig,
  projectDraft,
  projectDraftSubmission,
  projectWizardSteps,
} from "../packages/core/src/index.mjs";

const KEY = "sk-center-not-a-real-key";

async function withProject(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-center-wizard-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** A draft standing where the caller stands: answers so far, plus what is on disk. */
async function draftFor(root, answers = [], files = {}) {
  const draft = projectDraft(projectConfig(await loadRuntime(root)), { files });
  for (const [id, value] of answers) {
    const step = stepFor(draft, id);
    step.write(draft, value);
  }
  return draft;
}

function stepFor(draft, id) {
  const step = projectWizardSteps(draft).find((entry) => entry.id === id);
  assert.ok(step, `the wizard asks ${id}`);
  return step;
}

const apiClaude = (provider) => [
  ["agents", ["claude"]],
  ["auth:claude", "api"],
  ["configuration-scope:claude", "project"],
  ["sessions:claude", "project"],
  ["history", "shared"],
  ...(provider === undefined ? [] : [["provider:claude", provider]]),
];

test("the Center asks which provider only where Avenic knows the agent's own format", async () => {
  await withProject(async (root) => {
    const draft = await draftFor(root, [["agents", ["claude", "codex", "opencode"]], ["auth:claude", "api"], ["auth:codex", "api"]]);
    for (const agentId of ["claude", "codex"]) {
      const step = stepFor(draft, `provider:${agentId}`);
      const values = step.options.map((option) => option.value);
      // 表里的每一家都在：这份清单是 core 的，不是某个界面自己记的。
      assert.ok(values.includes("deepseek") && values.includes("openrouter") && values.includes("custom"), `${agentId} 的清单来自 preset 表`);
      // 而且永远留一条「自己来」：Center 是一个可选项，不是唯一入口。
      assert.equal(values[0], "hand", "默认是不写：用户没选，Center 就不动那个文件");
      assert.equal(step.value(draft), "hand", `没配过的项目打开在「自己来」上`);
    }
    // OpenCode 管自己的认证与 provider：Avenic 不问它这一题，也不替它写。
    assert.equal(projectWizardSteps(draft).some((step) => step.id === "provider:opencode"), false);
  });
});

test("the question opens on the provider the project already uses, read from the agent's own file", async () => {
  await withProject(async (root) => {
    // 现在的供应商从 agent 自己的文件里读出来 —— 界面记不住它，用户的手改得动它。
    const presence = await modelConfigPresence(root, { claude: { authMethod: "api", configScope: "project" } });
    assert.equal(presence.claude.exists, false, "还没配过：文件不在");
    const draft = await draftFor(root, apiClaude(), {
      claude: { relative: ".claude/settings.local.json", exists: true, baseUrl: "https://api.deepseek.com/anthropic", model: "deepseek-v4-pro", credentialSet: true },
    });
    assert.equal(stepFor(draft, "provider:claude").value(draft), "deepseek", "文件指向 DeepSeek，问题就开在 DeepSeek 上");
    const unknown = await draftFor(root, apiClaude(), { claude: { baseUrl: "https://my-gateway.internal/anthropic" } });
    assert.equal(stepFor(unknown, "provider:claude").value(unknown), "hand", "表外的主机不猜成任何一家");
  });
});

test("a chosen provider asks for the model, and for a key only where the file has none", async () => {
  await withProject(async (root) => {
    const fresh = await draftFor(root, apiClaude("deepseek"));
    const model = stepFor(fresh, "model:claude");
    assert.equal(model.kind, "text");
    // 文本步骤「必答」的判定是 optional !== true（CLI 的 textModel 就是这么读的）。
    assert.notEqual(model.optional, true, "没有 model 就没有配置，这一题必须答");
    assert.match(model.placeholder ?? "", /deepseek-v4-pro/, "供应商自己说过的模型名放在提示里，不是选项里");
    const key = stepFor(fresh, "key:claude");
    assert.equal(key.kind, "text");
    assert.equal(key.mask, true, "凭据从不画在屏幕上");
    assert.notEqual(key.optional, true, "文件里还没有凭据，这一题必须答");

    // 文件里已经有凭据：重跑一次 change 去改 History，不该逼用户把 key 再打一遍。
    const configured = await draftFor(root, apiClaude("deepseek"), { claude: { credentialSet: true, baseUrl: "https://api.deepseek.com/anthropic" } });
    assert.equal(stepFor(configured, "key:claude").optional, true, "已经有凭据时，留空就是「别动它」");

    // Codex 的凭据从不进文件：config.toml 只写变量名，所以这里没有 key 这一题。
    const codex = await draftFor(root, [["agents", ["codex"]], ["auth:codex", "api"], ["configuration-scope:codex", "project"], ["sessions:codex", "project"], ["provider:codex", "deepseek"]]);
    assert.equal(projectWizardSteps(codex).some((step) => step.id === "key:codex"), false, "Codex 不把 key 写进配置文件");
    const note = projectWizardSteps(codex).find((entry) => entry.id === "key-note:codex");
    assert.ok(note, "不写凭据不等于不说它在哪");
    assert.match(note.summary(), /DEEPSEEK_API_KEY/, "变量名是 preset 里查过的那个");
  });
});

test("a provider whose address only the user knows is asked for that address", async () => {
  await withProject(async (root) => {
    const draft = await draftFor(root, [...apiClaude("custom"), ["baseurl:claude", "https://gateway.internal/anthropic"], ["model:claude", "house-model"], ["key:claude", KEY]]);
    assert.notEqual(stepFor(draft, "baseurl:claude").optional, true, "自建网关没有可写死的地址，这一题必须答");
    // 表里查过的供应商不会被问地址：它的地址是查出来的事实，不是用户的输入。
    const known = await draftFor(root, apiClaude("deepseek"));
    assert.equal(projectWizardSteps(known).some((step) => step.id === "baseurl:claude"), false);
    const result = await applyProjectDraft(root, draft);
    const written = JSON.parse(await readFile(path.join(root, ".claude", "settings.local.json"), "utf8"));
    assert.equal(written.env.ANTHROPIC_BASE_URL, "https://gateway.internal/anthropic", "写进去的是用户自己给的地址");
    assert.equal(written.env.ANTHROPIC_MODEL, "house-model");
    assert.equal(result.center[0].changed, true);
  });
});

test("the credential never reaches the project settings, a summary or a diff", async () => {
  await withProject(async (root) => {
    const draft = await draftFor(root, [...apiClaude("deepseek"), ["model:claude", "deepseek-v4-pro"], ["key:claude", KEY]]);
    const submission = projectDraftSubmission(draft);
    assert.equal(JSON.stringify(submission).includes(KEY), false, "提交里没有凭据");
    assert.equal("provider" in submission.agents.claude, false, "供应商不进项目设置：它是 agent 那个文件的事实，read 出来就有，存下来只会有两份");
    for (const step of projectWizardSteps(draft)) {
      assert.equal(JSON.stringify(step.summary?.(draft) ?? "").includes(KEY), false, `${step.id} 的摘要里没有凭据`);
    }
    const result = await applyProjectDraft(root, draft);
    assert.equal(JSON.stringify(result.center ?? []).includes(KEY), false, "返回的 diff 里没有凭据");
    assert.equal(JSON.stringify(result).includes(KEY), false, "任何返回值里都没有凭据");
    assert.equal((await readFile(path.join(root, ".agents", "runtime.json"), "utf8")).includes(KEY), false, "项目设置里没有凭据");
  });
});

test("applying writes the agent's own file through the merge, and hands back what changed", async () => {
  await withProject(async (root) => {
    await mkdir(path.join(root, ".claude"), { recursive: true });
    const file = path.join(root, ".claude", "settings.local.json");
    await writeFile(file, `${JSON.stringify({ permissions: { allow: ["Bash(ls)"] }, env: { MY_OWN_VAR: "1" } }, null, 2)}\n`);
    const draft = await draftFor(root, [...apiClaude("deepseek"), ["model:claude", "deepseek-v4-pro"], ["key:claude", KEY]]);
    const result = await applyProjectDraft(root, draft);
    const written = JSON.parse(await readFile(file, "utf8"));
    assert.equal(written.env.ANTHROPIC_BASE_URL, "https://api.deepseek.com/anthropic");
    assert.equal(written.env.ANTHROPIC_AUTH_TOKEN, KEY, "凭据进了唯一需要它的地方");
    assert.equal(written.env.MY_OWN_VAR, "1", "用户自己的变量还在");
    assert.deepEqual(written.permissions, { allow: ["Bash(ls)"] }, "用户自己的权限还在");
    const center = result.center.find((entry) => entry.agentId === "claude");
    assert.equal(center.relative, ".claude/settings.local.json");
    assert.equal(center.written, true);
    assert.ok(center.diff.some((entry) => entry.kind === "add" && entry.text.includes("ANTHROPIC_BASE_URL")), "改了什么看得到");
    // 第二次同一份草稿：值没变，文件不动，也不需要再写一次。
    const again = await applyProjectDraft(root, draft);
    assert.equal(again.center.find((entry) => entry.agentId === "claude").written, false);
  });
});

// 凭据那一问留空有两种意思，而它们是不同的答案：文件里还没有凭据时留空是没说
// 出口（那一问必答），文件里已经有凭据时留空是「别动它」—— 一个人只是回来改
// History，不该被逼着把 key 再打一遍，更不该因为没打就被清掉。
test("a blank answer to the credential keeps the one the file already has", async () => {
  await withProject(async (root) => {
    const file = path.join(root, ".claude", "settings.local.json");
    const first = await draftFor(root, [...apiClaude("deepseek"), ["model:claude", "deepseek-v4-pro"], ["key:claude", KEY]]);
    await applyProjectDraft(root, first);
    const before = await readFile(file, "utf8");
    assert.equal(JSON.parse(before).env.ANTHROPIC_AUTH_TOKEN, KEY, "第一次写下去的是用户打的那个 key");

    // 第二次只改 History；每一问都按 Enter 过去，凭据那一问因此是空答案。
    const files = await modelConfigPresence(root, { claude: { authMethod: "api", configScope: "project" } });
    const again = await draftFor(root, [...apiClaude("deepseek"), ["model:claude", "deepseek-v4-pro"], ["key:claude", ""]], files);
    const result = await applyProjectDraft(root, again);
    assert.equal(await readFile(file, "utf8"), before, "空答案不是一次删除：文件一个字节都没动");
    assert.equal(result.center[0].written, false);
  });
});

// 供应商自己推荐的模型角色是一份「新配置要填成什么样」的表，不是一条规矩：文件
// 里已经写着这家供应商时，那一份映射是文件自己的，enter 过去不该把它补上。
test("an edit does not fill in the roles the provider recommends", async () => {
  await withProject(async (root) => {
    const { fillApiConfiguration } = await import("./helpers/api-fixture.mjs");
    // 一个自己写好的文件：地址是 DeepSeek 的，角色映射一行也没有。
    await fillApiConfiguration(root, "claude", "project", {
      baseUrl: "https://api.deepseek.com/anthropic",
      model: "deepseek-v4-pro",
      credential: KEY,
    });
    const file = path.join(root, ".claude", "settings.local.json");
    const before = await readFile(file, "utf8");
    const draft = await draftFor(root, [...apiClaude("deepseek"), ["model:claude", "deepseek-v4-pro"], ["key:claude", KEY]], {
      claude: { baseUrl: "https://api.deepseek.com/anthropic", model: "deepseek-v4-pro", credentialSet: true },
    });
    const result = await applyProjectDraft(root, draft);
    assert.equal(result.center[0].written, false, "每一问都答了，答的都是文件里本来就有的那个值");
    assert.equal(await readFile(file, "utf8"), before);
  });
});

test("a provider nobody answered writes nothing at all", async () => {
  await withProject(async (root) => {
    const draft = await draftFor(root, apiClaude());
    const result = await applyProjectDraft(root, draft);
    // 老契约仍然成立：只说「API」而不配 provider，Avenic 准备文件、不填内容。
    assert.equal(await readFile(path.join(root, ".claude", "settings.local.json"), "utf8"), "{}\n");
    assert.deepEqual(result.center, [], "没有答案是「不改」，不是「按默认值改」");
  });
});

test("a file Avenic cannot read is a refusal, and the file is left byte for byte", async () => {
  await withProject(async (root) => {
    await mkdir(path.join(root, ".claude"), { recursive: true });
    const file = path.join(root, ".claude", "settings.local.json");
    const broken = "{ not json\n";
    await writeFile(file, broken);
    const draft = await draftFor(root, [...apiClaude("deepseek"), ["model:claude", "deepseek-v4-pro"], ["key:claude", KEY]]);
    await assert.rejects(() => applyProjectDraft(root, draft), /JSON/i, "读不懂的文件绝不覆盖");
    assert.equal(await readFile(file, "utf8"), broken, "一个字节都没动");
  });
});

test("Codex is written in Codex's own keys, and its key stays in the environment", async () => {
  await withProject(async (root) => {
    const draft = await draftFor(root, [
      ["agents", ["codex"]],
      ["auth:codex", "api"],
      ["configuration-scope:codex", "project"],
      ["sessions:codex", "project"],
      ["provider:codex", "deepseek"],
      ["model:codex", "deepseek-v4-pro"],
    ]);
    const result = await applyProjectDraft(root, draft);
    const center = result.center.find((entry) => entry.agentId === "codex");
    assert.equal(center.relative, ".agents/local/codex/config.toml", "Codex 的答案落在 Codex 自己的家里");
    const text = await readFile(path.join(root, ".agents", "local", "codex", "config.toml"), "utf8");
    assert.match(text, /^model = "deepseek-v4-pro"$/m);
    assert.match(text, /^model_provider = "deepseek"$/m);
    assert.match(text, /^env_key = "DEEPSEEK_API_KEY"$/m, "秘密留在环境变量里，不进文件");
    assert.equal(text.includes(KEY), false);
  });
});
