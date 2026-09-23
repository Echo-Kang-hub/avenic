import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyModelConfiguration,
  applyProjectDraft,
  claudeTemplate,
  ensureModelConfiguration,
  loadRuntime,
  modelConfigCandidate,
  modelConfigPresence,
  modelConfigTarget,
  legacyModelConfiguration,
  projectConfig,
  projectDraft,
  projectWizardSteps,
  readModelConfiguration,
  removeModelConfiguration,
} from "../packages/core/src/index.mjs";

// 「API」不是 Avenic 的 provider 编辑器：它只把 agent 自己读的那个原生配置文件
// 准备好。这组测试驱动的是 CLI 与扩展共用的那几个函数（草稿 → 步骤 → 落盘），
// 因为「init 跑完之后文件到底在不在」是这一轮的核心缺陷：向导能答完所有的题、
// runtime.json 也写得对，而 `.claude/settings.local.json` 从来没被创建过。

async function withProject(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-model-config-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// 草稿要按两个宿主建草稿的方式建（dispatcher、agents-commands）：除了项目设置，
// 还带着「文件里现在是什么」——凭据能不能留空这一问题就取决于它，少传 files 就是在
// 测一个宿主从不发出来的草稿。
async function draftFor(root) {
  const config = projectConfig(await loadRuntime(root));
  return projectDraft(config, { files: await modelConfigPresence(root, config.agents) });
}

// 答案按顺序写进草稿，每答一题就重算步骤——下一题是什么由前面的答案决定，
// 与向导里发生的事完全一样。
function fill(draft, answers) {
  for (const [id, value] of answers) {
    const step = projectWizardSteps(draft).find((entry) => entry.id === id);
    assert.ok(step, `the wizard asks ${id}`);
    step.write(draft, value);
  }
  return draft;
}

async function configure(root, answers) {
  return applyProjectDraft(root, fill(await draftFor(root), answers));
}

const claudeApi = (scope = "project") => [
  ["agents", ["claude"]],
  ["auth:claude", "api"],
  ["configuration-scope:claude", scope],
  ["sessions:claude", "project"],
  ["history", "shared"],
];

async function runtimeAgents(root) {
  return JSON.parse(await readFile(path.join(root, ".agents", "runtime.json"), "utf8")).agents;
}

test("Claude Project + API prepares the configuration file it points at", async () => {
  await withProject(async (root) => {
    await configure(root, claudeApi());
    const file = path.join(root, ".claude", "settings.local.json");
    assert.equal(existsSync(file), true, "the file Claude itself reads for this project exists");
    // 最小且有效：Claude 接受的一整份空配置。Avenic 不往里写 provider、model、占位符。
    assert.equal(await readFile(file, "utf8"), "{}\n");
    assert.deepEqual((await runtimeAgents(root)).claude, {
      enabled: true,
      authMethod: "api",
      configScope: "project",
      sessionScope: "project",
    });
  });
});

test("a second change that changes nothing leaves the file byte for byte", async () => {
  await withProject(async (root) => {
    await configure(root, claudeApi());
    const file = path.join(root, ".claude", "settings.local.json");
    const first = await readFile(file, "utf8");
    await configure(root, claudeApi());
    assert.equal(await readFile(file, "utf8"), first);
  });
});

test("a file the user filled in is preserved completely, byte for byte", async () => {
  await withProject(async (root) => {
    await configure(root, claudeApi());
    const file = path.join(root, ".claude", "settings.local.json");
    // 用户（或 cc-switch、或手写）写进去的真实配置：Avenic 之后再跑一次，必须原样。
    const written = '{\n  "env": {\n    "ANTHROPIC_BASE_URL": "https://provider.fixture.invalid",\n    "ANTHROPIC_MODEL": "fixture-model"\n  },\n  "permissions": {\n    "allow": ["Bash(ls:*)"]\n  }\n}\n';
    await writeFile(file, written, "utf8");
    await configure(root, claudeApi());
    assert.equal(await readFile(file, "utf8"), written, "not reformatted, not merged, not rewritten");
  });
});

test("an Account answer creates no configuration file", async () => {
  await withProject(async (root) => {
    await configure(root, [
      ["agents", ["claude"]],
      ["auth:claude", "account"],
      ["account-scope:claude", "project"],
      ["sessions:claude", "project"],
      ["history", "shared"],
    ]);
    assert.equal(existsSync(path.join(root, ".claude", "settings.local.json")), false);
    // The project's own account home is the agent's, and Avenic creates the
    // directory it signs into — never a credential, never a config file.
    assert.equal(existsSync(path.join(root, ".agents", "local", "claude")), true);
    assert.deepEqual((await runtimeAgents(root)).claude, {
      enabled: true,
      authMethod: "account",
      accountScope: "project",
      sessionScope: "project",
    });
  });
});

test("switching Account → API creates the file that was missing", async () => {
  await withProject(async (root) => {
    await configure(root, [
      ["agents", ["claude"]],
      ["auth:claude", "account"],
      ["account-scope:claude", "global"],
      ["sessions:claude", "project"],
      ["history", "shared"],
    ]);
    const file = path.join(root, ".claude", "settings.local.json");
    assert.equal(existsSync(file), false);
    await configure(root, claudeApi());
    assert.equal(await readFile(file, "utf8"), "{}\n");
    assert.equal((await runtimeAgents(root)).claude.authMethod, "api");
  });
});

test("Codex Project + API uses its own project home, not Claude's file", async () => {
  await withProject(async (root) => {
    await configure(root, [
      ["agents", ["codex"]],
      ["auth:codex", "api"],
      ["configuration-scope:codex", "project"],
      ["sessions:codex", "project"],
      ["history", "shared"],
    ]);
    const file = path.join(root, ".agents", "local", "codex", "config.toml");
    assert.equal(existsSync(file), true, "Codex reads its configuration from its own home");
    // TOML 的最小有效形态是一份空文档——Avenic 不编造 Codex 的键。
    assert.equal(await readFile(file, "utf8"), "");
    assert.equal(existsSync(path.join(root, ".claude", "settings.local.json")), false, "Claude's file is never imposed on Codex");
  });
});

// ---- 读回来的那一半：面板上的 Provider / Model 只能来自文件本身 ----
//
// Dashboard 的卡片要显示用户填进去的 provider 和 model。那是**读**，而且只能读那个
// 文件——Avenic 没有自己的一份记录（账本里只有路径和哈希，按设计不该有内容），所以
// 「文件里没写」必须如实读成「没写」，而不是补一个默认值。

const claudeFilled = '{\n  "env": {\n    "ANTHROPIC_BASE_URL": "https://provider.fixture.invalid/v1",\n    "ANTHROPIC_MODEL": "fixture-model",\n    "ANTHROPIC_DEFAULT_OPUS_MODEL": "fixture-opus",\n    "ANTHROPIC_AUTH_TOKEN": "fixture-token-not-a-real-secret"\n  }\n}\n';

test("a Claude configuration reads back the provider and model the file names", async () => {
  await withProject(async (root) => {
    await mkdir(path.join(root, ".claude"), { recursive: true });
    await writeFile(path.join(root, ".claude", "settings.local.json"), claudeFilled, "utf8");
    const facts = await readModelConfiguration(root, "claude", "project");
    assert.equal(facts.exists, true);
    assert.equal(facts.valid, true);
    assert.equal(facts.configured, true);
    // provider 是 endpoint 的主机名：文件里没有一个叫 provider 的键，编一个名字出
    // 来就是把「我不知道」说成「我知道」。
    assert.equal(facts.baseUrl, "https://provider.fixture.invalid/v1");
    assert.equal(facts.provider, "provider.fixture.invalid");
    assert.equal(facts.model, "fixture-model");
    assert.equal(facts.settings.opus, "fixture-opus");
    assert.equal(facts.credentialSet, true, "a credential is reported as set, never echoed");
    assert.equal(JSON.stringify(facts).includes("fixture-token-not-a-real-secret"), false, "never the value, not even in a field nobody reads");
  });
});

test("an empty configuration reads as nothing configured, not as a default", async () => {
  await withProject(async (root) => {
    await configure(root, claudeApi());
    const facts = await readModelConfiguration(root, "claude", "project");
    assert.equal(facts.exists, true);
    assert.equal(facts.configured, false, "the file Avenic prepared names no provider and no model");
    assert.equal(facts.provider, null);
    assert.equal(facts.model, null);
    assert.equal(facts.baseUrl, null);
  });
});

// 用户把 Avenic 建的那份文件删了之后，「这个文件是 Avenic 建的、现在不在了」和
// 「这里从来就没有过文件」是两件事：前者有救（再跑一次 change 就回来了），后者是
// 这个 agent 还没配。账本记得，因此这一页必须说得出来 —— 它要说的是事实，而不是
// 一份只看得见现在的事实。
test("a file Avenic created and the user deleted is still named as Avenic's", async () => {
  await withProject(async (root) => {
    await configure(root, claudeApi());
    const file = path.join(root, ".claude", "settings.local.json");
    await rm(file, { force: true });
    const facts = await readModelConfiguration(root, "claude", "project");
    assert.equal(facts.exists, false);
    assert.equal(facts.owned, true, "账本说这个路径是 Avenic 建的，删掉它的人不是账本");
    assert.equal(facts.unchanged, false, "没有文件就没有「还和写下去时一模一样」");
    assert.equal(facts.configured, false);
    // 一份从没被 Avenic 碰过的文件不见了，就只是不见了。
    const untouched = await readModelConfiguration(root, "codex", "project");
    assert.equal(untouched.exists, false);
    assert.equal(untouched.owned, false);
  });
});

// 同一个事实的另一半：一个 Avenic 建过、现在读不出内容的路径（这里用同名目录
// 逼出来），账本说的仍然是账本的事，不该跟着「读不出来」一起消失。
test("a configuration that cannot be read still carries what the ledger says", async () => {
  await withProject(async (root) => {
    await configure(root, claudeApi());
    const file = path.join(root, ".claude", "settings.local.json");
    await rm(file, { force: true });
    await mkdir(file, { recursive: true });
    const facts = await readModelConfiguration(root, "claude", "project");
    assert.equal(facts.exists, true);
    assert.equal(facts.valid, false);
    assert.equal(facts.owned, true);
  });
});

test("a file that is not valid JSON is reported as such, never repaired", async () => {
  await withProject(async (root) => {
    await mkdir(path.join(root, ".claude"), { recursive: true });
    await writeFile(path.join(root, ".claude", "settings.local.json"), "{ this is not json", "utf8");
    const facts = await readModelConfiguration(root, "claude", "project");
    assert.equal(facts.exists, true);
    assert.equal(facts.valid, false);
    assert.equal(facts.configured, false);
    // 坏掉的文件不是 Avenic 的：它不被改写、不被重排、不被删掉。
    assert.equal(await readFile(path.join(root, ".claude", "settings.local.json"), "utf8"), "{ this is not json");
  });
});

test("a Codex configuration reads back its own keys, and only those", async () => {
  await withProject(async (root) => {
    await configure(root, [
      ["agents", ["codex"]],
      ["auth:codex", "api"],
      ["configuration-scope:codex", "project"],
      ["sessions:codex", "project"],
      ["history", "shared"],
    ]);
    const file = path.join(root, ".agents", "local", "codex", "config.toml");
    await writeFile(file, [
      'model = "fixture-model"',
      'model_provider = "fixture"',
      'model_reasoning_effort = "high"',
      "",
      "[model_providers.fixture]",
      'name = "Fixture Provider"',
      'base_url = "https://provider.fixture.invalid/v1"',
      'env_key = "FIXTURE_API_KEY"',
      "",
    ].join("\n"), "utf8");
    const facts = await readModelConfiguration(root, "codex", "project");
    assert.equal(facts.provider, "Fixture Provider");
    assert.equal(facts.baseUrl, "https://provider.fixture.invalid/v1");
    assert.equal(facts.model, "fixture-model");
    assert.equal(facts.credentialSet, true);
    assert.deepEqual(facts.settings, { reasoning: "high" });
  });
});

// ---- 归还：只有能证明是自己建的、且没人动过的文件才删 ----

test("a file Avenic created and nobody touched is given back", async () => {
  await withProject(async (root) => {
    await configure(root, claudeApi());
    const outcome = await removeModelConfiguration(root, "claude", "project");
    assert.equal(outcome.outcome, "deleted");
    assert.equal(existsSync(path.join(root, ".claude", "settings.local.json")), false);
    // 账本里那一行也跟着走：删掉之后不该留下一条指向不存在文件的记录。
    const ledger = JSON.parse(await readFile(path.join(root, ".agents", "local", "ownership.json"), "utf8").catch(() => '{"files":{}}'));
    assert.equal(ledger.files["claude:project"], undefined);
  });
});

// 账本里那个哈希记的是「Avenic 上一次写下去的字节」。它不跟着第二次写入更新，Avenic
// 就认不出自己刚写的文件：用户一个字没动，界面却说他改过 —— 于是这个文件永远收不回来。
test("a second apply still leaves the file Avenic's to give back", async () => {
  await withProject(async (root) => {
    await configure(root, claudeApi());
    const file = path.join(root, ".claude", "settings.local.json");
    const first = await readFile(file, "utf8");

    await applyModelConfiguration(root, "claude", "project", claudeTemplate("moonshot", {
      apiKey: "fixture-not-a-real-secret",
      model: "fixture-model-2",
    }));
    assert.notEqual(await readFile(file, "utf8"), first, "第二次 Apply 确实改写了这个文件");

    const outcome = await removeModelConfiguration(root, "claude", "project");
    assert.equal(outcome.outcome, "deleted", "没人动过它，收回来就不该说它被改过");
    assert.equal(existsSync(file), false);
  });
});

// 凭据那一问留空是「别动文件里那份凭据」。这句话只有在文件里那份属于同一家供应商时
// 才成立：换了一家还留空，写下去的是新供应商的地址配上上一家的钥匙——文件里的 key 会
// 跟着新地址一起发出去，轻则连不上，重则把上一家的凭据交给了新供应商。
const switched = [
  ["provider:claude", "deepseek"],
  ["model:claude", "fixture-deepseek-model"],
  ["key:claude", "fixture-key-one"],
];

test("a blank credential is refused when the file's credential is not that provider's", async () => {
  await withProject(async (root) => {
    await configure(root, [...claudeApi(), ...switched]);
    const file = path.join(root, ".claude", "settings.local.json");
    const before = await readFile(file, "utf8");
    assert.equal(JSON.parse(before).env.ANTHROPIC_AUTH_TOKEN, "fixture-key-one");

    const draft = fill(await draftFor(root), [
      ["provider:claude", "moonshot"],
      ["model:claude", "fixture-moonshot-model"],
      ["key:claude", ""],
    ]);
    await assert.rejects(() => applyProjectDraft(root, draft), /not Moonshot/);
    assert.equal(await readFile(file, "utf8"), before, "一句话都没写下去：这份文件仍然指向配得上这把钥匙的那一家");
  });
});

// 同一条规则的另外半边在提问处：留空能不能算个答案，取决于文件里那份凭据是不是这一
// 家的。不是，钥匙就得问出来——否则 CLI 会把空白当成一个回答收下。
test("the credential question stops being optional when the answer switches provider", async () => {
  await withProject(async (root) => {
    await configure(root, [...claudeApi(), ...switched]);
    const stepOf = (draft, id) => projectWizardSteps(draft).find((entry) => entry.id === id);

    const draft = await draftFor(root);
    // 再开一次向导：第一问照旧先问 provider，而它预选的就是文件里那一家。
    fill(draft, [["provider:claude", "deepseek"]]);
    assert.equal(stepOf(draft, "key:claude").optional, true, "文件里已经有这一家的凭据：留空是「别动它」");
    fill(draft, [["provider:claude", "moonshot"]]);
    assert.equal(stepOf(draft, "key:claude").optional, false, "换了一家，留空不再是个答案");
    fill(draft, [["provider:claude", "deepseek"]]);
    assert.equal(stepOf(draft, "key:claude").optional, true, "换回来，文件里那份凭据又是这一家的了");
  });
});

// 这条规则的边界：用户自己的网关（custom）不是「另一家供应商」——地址是他写的，那扇门
// 收哪把钥匙由他说了算。留空在这里仍然是「别动它」，而不是一个要挡下来的错误：把网关
// 用户挡在门外，等于用一条保护规则拆掉一条合法配置。
test("a provider the user runs themselves keeps the file's credential on a blank answer", async () => {
  await withProject(async (root) => {
    await configure(root, [...claudeApi(), ...switched]);
    const file = path.join(root, ".claude", "settings.local.json");

    const draft = fill(await draftFor(root), [
      ["provider:claude", "custom"],
      ["baseurl:claude", "https://gateway.fixture.invalid/anthropic"],
      ["model:claude", "fixture-gateway-model"],
      ["key:claude", ""],
    ]);
    assert.equal(projectWizardSteps(draft).find((entry) => entry.id === "key:claude").optional, true, "自己的网关：留空还是别动它");
    await applyProjectDraft(root, draft);

    const written = JSON.parse(await readFile(file, "utf8"));
    assert.equal(written.env.ANTHROPIC_BASE_URL, "https://gateway.fixture.invalid/anthropic");
    assert.equal(written.env.ANTHROPIC_MODEL, "fixture-gateway-model");
    assert.equal(written.env.ANTHROPIC_AUTH_TOKEN, "fixture-key-one", "文件里那把钥匙留在原处");
  });
});

test("a file the user has edited since is preserved and named", async () => {
  await withProject(async (root) => {
    await configure(root, claudeApi());
    const file = path.join(root, ".claude", "settings.local.json");
    await writeFile(file, claudeFilled, "utf8");
    const outcome = await removeModelConfiguration(root, "claude", "project");
    assert.equal(outcome.outcome, "modified");
    assert.equal(await readFile(file, "utf8"), claudeFilled, "a value Avenic did not write is not Avenic's to delete");
  });
});

test("a file Avenic merely found is never deleted", async () => {
  await withProject(async (root) => {
    await mkdir(path.join(root, ".claude"), { recursive: true });
    await writeFile(path.join(root, ".claude", "settings.local.json"), claudeFilled, "utf8");
    const outcome = await removeModelConfiguration(root, "claude", "project");
    assert.equal(outcome.outcome, "foreign");
    assert.equal(existsSync(path.join(root, ".claude", "settings.local.json")), true);
  });
});

test("a file that is already gone is reported as gone, not as removed", async () => {
  await withProject(async (root) => {
    await configure(root, claudeApi());
    await rm(path.join(root, ".claude", "settings.local.json"), { force: true });
    const outcome = await removeModelConfiguration(root, "claude", "project");
    assert.equal(outcome.outcome, "missing");
    assert.equal(outcome.removed, false);
  });
});

// 账本里只有「哪个文件、是不是 Avenic 建的、写下去时哈希是多少」——没有内容，
// 因此永远不会有密钥被 Avenic 自己记在本子上。
test("the ownership ledger holds a path and a hash, never a value", async () => {
  await withProject(async (root) => {
    await configure(root, claudeApi());
    const ledger = await readFile(path.join(root, ".agents", "local", "ownership.json"), "utf8");
    assert.match(ledger, /"file": "\.claude\/settings\.local\.json"/);
    assert.match(ledger, /sha256:[0-9a-f]{64}/);
    const record = JSON.parse(ledger).files["claude:project"];
    assert.deepEqual(Object.keys(record).sort(), ["createdByAvenic", "file", "hash"]);
  });
});

// ---- 全局作用域：写在 agent 自己那个变量指着的家里，永远不是这个进程的家 ----

test("a Global answer is prepared in the home the environment names", async () => {
  await withProject(async (root) => {
    const elsewhere = await mkdtemp(path.join(os.tmpdir(), "avenic-global-home-"));
    try {
      const environment = { ...process.env, CLAUDE_CONFIG_DIR: elsewhere, CODEX_HOME: elsewhere };
      // Claude 的全局配置文件是它自己的 settings.json，不是项目里的那一份。
      const claude = await ensureModelConfiguration(root, "claude", "global", { environment });
      assert.equal(claude.relative, "$CLAUDE_CONFIG_DIR/settings.json");
      assert.equal(await readFile(path.join(elsewhere, "settings.json"), "utf8"), "{}\n");
      const codex = await ensureModelConfiguration(root, "codex", "global", { environment });
      assert.equal(codex.relative, "$CODEX_HOME/config.toml");
      assert.equal(await readFile(path.join(elsewhere, "config.toml"), "utf8"), "");
      // 项目里不该因此多出任何东西。
      assert.equal(existsSync(path.join(root, ".claude", "settings.local.json")), false);
      assert.equal(existsSync(path.join(root, ".agents", "local", "codex", "config.toml")), false);
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });
});

test("Claude's Project answer names the project file; Codex's names its own home", () => {
  assert.equal(modelConfigTarget(null, "claude", "project").relative, ".claude/settings.local.json");
  assert.equal(modelConfigTarget(null, "codex", "project").relative, ".agents/local/codex/config.toml");
  assert.equal(modelConfigTarget(null, "claude", "global", { environment: {} }).relative, "~/.claude/settings.json");
  assert.equal(modelConfigTarget(null, "codex", "global", { environment: {} }).relative, "~/.codex/config.toml");
});

// ---- 向导打开时读到的事实：哪份文件在、是不是 Avenic 的、动过没有 ----

test("the wizard's prefill describes only API answers, and says whether the file is still Avenic's", async () => {
  await withProject(async (root) => {
    await configure(root, claudeApi());
    const presence = await modelConfigPresence(root, { claude: { authMethod: "api", configScope: "project" }, codex: { sessionScope: "project" } });
    assert.deepEqual(Object.keys(presence), ["claude"], "an agent with no API answer has no file to describe");
    // 空文件读出来是「什么都不说」：没有 endpoint、没有 model、没有凭据 —— 于是
    // Center 的那几问从零开始，而不是从一个编出来的默认值开始。
    assert.deepEqual(presence.claude, {
      relative: ".claude/settings.local.json",
      scope: "project",
      exists: true,
      owned: true,
      unchanged: true,
      valid: true,
      baseUrl: null,
      model: null,
      credentialSet: false,
    });
    // 用户改过之后，向导看到的就是「在，但不是原样了」—— 破坏性那一问正是问这个。
    // 同时它也说得出文件现在指向哪一家：Center 打开时就是靠这几个字段落在正确的
    // 那一项上，凭据本身永远不在其中（只要「有没有」）。
    await writeFile(path.join(root, ".claude", "settings.local.json"), claudeFilled, "utf8");
    const edited = await modelConfigPresence(root, { claude: { authMethod: "api", configScope: "project" } });
    assert.equal(edited.claude.exists, true);
    assert.equal(edited.claude.owned, true);
    assert.equal(edited.claude.unchanged, false);
    assert.equal(edited.claude.baseUrl, "https://provider.fixture.invalid/v1");
    assert.equal(edited.claude.model, "fixture-model");
    assert.equal(edited.claude.credentialSet, true);
    assert.equal(JSON.stringify(edited.claude).includes("fixture-token-not-a-real-secret"), false, "描述里不含凭据的值");
  });
});

test("a configuration an earlier Avenic wrote is named, and never touched", async () => {
  await withProject(async (root) => {
    // 1.8.3 把 Codex 的项目作用域 API 配置写在自己的 `.agents/api/codex.json`
    // 里。这份文件可能带着真的凭据，所以升级只做一件事：告诉用户它在哪儿。
    const legacy = path.join(root, ".agents", "api", "codex.json");
    await mkdir(path.dirname(legacy), { recursive: true });
    await writeFile(legacy, '{"provider":"FixtureProvider","baseUrl":"https://provider.fixture.invalid/v1"}\n');
    await configure(root, [
      ["agents", ["codex"]],
      ["auth:codex", "api"],
      ["configuration-scope:codex", "project"],
      ["sessions:codex", "project"],
      ["history", "shared"],
    ]);
    // 新答案的文件准备好了，旧文件一个字节没动。
    assert.equal(existsSync(path.join(root, ".agents", "local", "codex", "config.toml")), true);
    assert.equal(await readFile(legacy, "utf8"), '{"provider":"FixtureProvider","baseUrl":"https://provider.fixture.invalid/v1"}\n');
    const older = await legacyModelConfiguration(root, "codex");
    assert.equal(older.exists, true);
    assert.equal(older.relative, ".agents/api/codex.json");
    assert.equal(await legacyModelConfiguration(root, "claude"), null, "只有 Codex 的项目配置换过地方");
  });
});

test("an Account answer is checked against the project file an API answer would have used", async () => {
  await withProject(async (root) => {
    await configure(root, [
      ["agents", ["claude"]],
      ["auth:claude", "account"],
      ["account-scope:claude", "project"],
      ["sessions:claude", "project"],
      ["history", "shared"],
    ]);
    assert.equal(modelConfigCandidate(root, "claude").exists, false, "nothing is there to be inactive");
    await mkdir(path.join(root, ".claude"), { recursive: true });
    await writeFile(path.join(root, ".claude", "settings.local.json"), claudeFilled, "utf8");
    const candidate = modelConfigCandidate(root, "claude");
    assert.equal(candidate.exists, true);
    assert.equal(candidate.relative, ".claude/settings.local.json");
  });
});
