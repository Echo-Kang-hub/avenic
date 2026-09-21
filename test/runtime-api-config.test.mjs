import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  apiCredential,
  apiRelative,
  codexLaunchArguments,
  providerIdFor,
  readApiConfiguration,
  readCodexProjectConfig,
  removeApiConfiguration,
  writeApiConfiguration,
} from "../packages/core/src/runtime/api-config.mjs";

// API mode writes into files the user also edits. These tests pin the two
// halves of that contract: a value Avenic wrote is given back exactly, and a
// value the user wrote is never touched — not on write, not on removal. Every
// fixture is invented; nothing here reads a real configuration.

const TOKEN = "fixture-token-not-a-real-secret";
const fields = {
  provider: "Fixture Provider",
  baseUrl: "https://provider.fixture.invalid/v1",
  model: "fixture-model",
  credential: TOKEN,
};
// Codex's credential field names the environment variable it reads; Avenic
// never stores the key itself for that agent.
const codexFields = { ...fields, credential: "FIXTURE_API_KEY" };

async function project(t, files = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-api-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content, "utf8");
  }
  return root;
}

const readJson = (root, relative) => JSON.parse(readFileSync(path.join(root, relative), "utf8"));
const readText = (root, relative) => readFileSync(path.join(root, relative), "utf8");

test("a project API configuration lands in Claude's own project settings file", async (t) => {
  const root = await project(t);
  const { relative, created } = await writeApiConfiguration(root, "claude", "project", fields);
  assert.equal(relative, ".claude/settings.local.json");
  assert.equal(created, true);
  assert.deepEqual(readJson(root, relative).env, {
    ANTHROPIC_BASE_URL: fields.baseUrl,
    ANTHROPIC_MODEL: fields.model,
    ANTHROPIC_AUTH_TOKEN: TOKEN,
  });
  const read = await readApiConfiguration(root, "claude", "project");
  assert.equal(read.owned, true);
  assert.equal(read.provider, "Fixture Provider");
  assert.equal(read.model, "fixture-model");
  assert.equal(read.credentialSet, true);
});

test("an existing settings file keeps every key Avenic does not own", async (t) => {
  const existing = {
    permissions: { allow: ["Bash(git status)"] },
    hooks: { Stop: [{ hooks: [{ type: "command", command: "echo done" }] }] },
    model: "someones-own-model",
    env: { KEEP_ME: "1" },
  };
  const root = await project(t, { ".claude/settings.local.json": `${JSON.stringify(existing, null, 2)}\n` });
  await writeApiConfiguration(root, "claude", "project", fields);
  const written = readJson(root, ".claude/settings.local.json");
  assert.deepEqual(written.permissions, existing.permissions);
  assert.deepEqual(written.hooks, existing.hooks);
  assert.equal(written.model, "someones-own-model");
  assert.equal(written.env.KEEP_ME, "1");
  assert.equal(written.env.ANTHROPIC_MODEL, fields.model);
  await removeApiConfiguration(root, "claude", "project");
  assert.deepEqual(readJson(root, ".claude/settings.local.json"), existing);
});

test("the ledger records ownership without keeping the secret", async (t) => {
  const root = await project(t);
  await writeApiConfiguration(root, "claude", "project", fields);
  const ledger = readText(root, ".agents/projection.json");
  assert.equal(ledger.includes(TOKEN), false, "a credential value must not be written into the ownership record");
  assert.match(ledger, /writtenHash/);
  const record = JSON.parse(ledger).agents.claude.project;
  assert.equal(record.created, true);
  assert.equal(record.entries.some((row) => row.path.join(".") === "env.ANTHROPIC_BASE_URL" && row.written === fields.baseUrl), true);
});

test("a value the user changed after the write is theirs again, and stays", async (t) => {
  const root = await project(t);
  await writeApiConfiguration(root, "claude", "project", fields);
  const file = path.join(root, ".claude/settings.local.json");
  const edited = JSON.parse(readFileSync(file, "utf8"));
  edited.env.ANTHROPIC_MODEL = "the-user-changed-this";
  writeFileSync(file, `${JSON.stringify(edited, null, 2)}\n`, "utf8");
  const outcome = await removeApiConfiguration(root, "claude", "project");
  assert.equal(outcome.conflicts, 1);
  assert.equal(readJson(root, ".claude/settings.local.json").env.ANTHROPIC_MODEL, "the-user-changed-this");
  assert.equal(readJson(root, ".claude/settings.local.json").env.ANTHROPIC_BASE_URL, undefined);
});

test("a credential that was there before Avenic is never removed", async (t) => {
  // The user's own token was in the file first. The ledger keeps a hash where a
  // value would be a secret, so the earlier value cannot be given back — and
  // what cannot be given back must not be taken: removing it would destroy
  // something Avenic provably did not write, while reporting a clean restore.
  const existing = { env: { ANTHROPIC_AUTH_TOKEN: "the-users-own-token", ANTHROPIC_MODEL: "users-own-model" } };
  const root = await project(t, { ".claude/settings.local.json": `${JSON.stringify(existing, null, 2)}\n` });
  await writeApiConfiguration(root, "claude", "project", fields);
  assert.equal(readJson(root, ".claude/settings.local.json").env.ANTHROPIC_AUTH_TOKEN, TOKEN);
  const outcome = await removeApiConfiguration(root, "claude", "project");
  assert.equal(outcome.kept, 1, "the unrecoverable credential is reported, not silently counted as removed");
  const env = readJson(root, ".claude/settings.local.json").env;
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, TOKEN, "the key stands as Avenic left it");
  assert.equal(env.ANTHROPIC_MODEL, "users-own-model", "and the user's own value is back");
});

test("a file Avenic created is deleted when its keys are the only content left", async (t) => {
  const root = await project(t);
  await writeApiConfiguration(root, "claude", "project", fields);
  const outcome = await removeApiConfiguration(root, "claude", "project");
  assert.equal(outcome.deleted, true);
  assert.equal(existsSync(path.join(root, ".claude/settings.local.json")), false);
  assert.equal(existsSync(path.join(root, ".agents/projection.json")), false, "an empty ledger is not left behind");
});

test("re-applying the same answers does not churn the file", async (t) => {
  const root = await project(t);
  await writeApiConfiguration(root, "claude", "project", fields);
  const file = path.join(root, ".claude/settings.local.json");
  const first = readFileSync(file, "utf8");
  const before = readFileSync(file, "utf8");
  await writeApiConfiguration(root, "claude", "project", fields);
  assert.equal(readFileSync(file, "utf8"), first);
  assert.equal(readFileSync(file, "utf8"), before);
});

test("a dropped field is given back, not left behind", async (t) => {
  const existing = { env: { ANTHROPIC_MODEL: "users-own-model" } };
  const root = await project(t, { ".claude/settings.local.json": `${JSON.stringify(existing, null, 2)}\n` });
  await writeApiConfiguration(root, "claude", "project", fields);
  assert.equal(readJson(root, ".claude/settings.local.json").env.ANTHROPIC_MODEL, fields.model);
  await writeApiConfiguration(root, "claude", "project", { provider: fields.provider, baseUrl: fields.baseUrl, model: "", credential: TOKEN });
  assert.equal(readJson(root, ".claude/settings.local.json").env.ANTHROPIC_MODEL, "users-own-model");
});

test("the credential is never given back by an answer that cannot name it", async (t) => {
  const root = await project(t);
  await writeApiConfiguration(root, "claude", "project", fields);
  // The page never fills this field in — a secret is not echoed — so "the user
  // did not retype it" and "the user asked for it to go" look identical from
  // here. Only one of those readings can be undone later; this is the one.
  await writeApiConfiguration(root, "claude", "project", { provider: fields.provider, baseUrl: fields.baseUrl, model: fields.model });
  assert.equal(readJson(root, ".claude/settings.local.json").env.ANTHROPIC_AUTH_TOKEN, TOKEN);
  assert.equal((await readApiConfiguration(root, "claude", "project")).credentialSet, true, "and the ledger still owns it");
  // A key the user deleted by hand is not claimed back: the ledger records what
  // is there, not what used to be.
  writeFileSync(path.join(root, ".claude/settings.local.json"), `${JSON.stringify({ env: { ANTHROPIC_BASE_URL: fields.baseUrl } }, null, 2)}\n`);
  await writeApiConfiguration(root, "claude", "project", { provider: fields.provider, baseUrl: fields.baseUrl, model: fields.model });
  const ledger = JSON.parse(readFileSync(path.join(root, ".agents/projection.json"), "utf8"));
  assert.deepEqual(ledger.agents.claude.project.entries.map((row) => row.path.at(-1)), ["ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL"]);
});

test("a Global answer is written to the home the environment names, never this process's", async (t) => {
  const root = await project(t);
  const home = await project(t);
  const environment = { HOME: home, USERPROFILE: home };
  await writeApiConfiguration(root, "claude", "global", fields, { environment });
  const written = readJson(home, ".claude/settings.json");
  assert.equal(written.env.ANTHROPIC_BASE_URL, fields.baseUrl);
  assert.equal(written.env.ANTHROPIC_AUTH_TOKEN, TOKEN);
  assert.equal(existsSync(path.join(root, ".claude", "settings.json")), false, "the project is not where a Global answer goes");
  const read = await readApiConfiguration(root, "claude", "global", { environment });
  assert.equal(read.relative, "~/.claude/settings.json");
  assert.equal(read.baseUrl, fields.baseUrl);
  assert.equal(read.credentialSet, true);
  // homeDir wins when a caller knows the directory outright: it does not have
  // to describe an environment to say where the user's home is.
  const outcome = await removeApiConfiguration(root, "claude", "global", { homeDir: home, environment: { HOME: path.join(home, "elsewhere"), USERPROFILE: path.join(home, "elsewhere") } });
  assert.equal(outcome.deleted, true, "the file Avenic created held nothing else, so removal takes it");
  assert.equal(existsSync(path.join(home, ".claude", "settings.json")), false);
  assert.equal(existsSync(path.join(home, "elsewhere")), false, "the environment is not consulted when the home is named");
});

test("Codex global configuration is merged into the user's own config.toml", async (t) => {
  const existing = [
    'model = "gpt-5"',
    "",
    "[windows]",
    'sandbox = "elevated"',
    "",
    "[projects.'d:\\fixture']",
    'trust_level = "trusted"',
    "",
    "[model_providers.other]",
    'name = "Other"',
    'base_url = "https://other.fixture.invalid/v1"',
    "",
  ].join("\n");
  const root = await project(t);
  const home = await project(t, { ".codex/config.toml": existing });
  await writeApiConfiguration(root, "codex", "global", codexFields, { homeDir: home });
  const text = readText(home, ".codex/config.toml");
  assert.match(text, /^model = "fixture-model"$/m);
  assert.match(text, /^model_provider = "fixture-provider"$/m);
  assert.match(text, /\[model_providers\.fixture-provider\]/);
  assert.match(text, /^base_url = "https:\/\/provider\.fixture\.invalid\/v1"$/m);
  assert.match(text, /^env_key = "FIXTURE_API_KEY"$/m);
  assert.match(text, /^wire_api = "chat"$/m);
  // Everything the user had, except the two keys Avenic was asked to set, is
  // still there byte for byte.
  for (const line of existing.split("\n")) {
    if (line.trim() === "" || line === 'model = "gpt-5"') continue;
    assert.equal(text.includes(line), true, `lost a user line: ${line}`);
  }
  const read = await readApiConfiguration(root, "codex", "global", { homeDir: home });
  assert.equal(read.owned, true);
  assert.equal(read.baseUrl, fields.baseUrl);
  assert.equal(read.credentialSet, true);
  const outcome = await removeApiConfiguration(root, "codex", "global", { homeDir: home });
  assert.equal(outcome.conflicts, 0);
  const after = readText(home, ".codex/config.toml");
  assert.equal(after.includes("fixture-provider"), false, "the table Avenic created is removed with its keys");
  assert.equal(after.includes("https://other.fixture.invalid/v1"), true, "the user's own provider table stays");
  assert.equal(after.includes('[projects.\'d:\\fixture\']'), true);
  assert.match(after, /^model = "gpt-5"$/m, "the value Avenic replaced is handed back on removal");
  assert.doesNotMatch(after, /^model_provider = /m);
});

test("a blank credential answer keeps the recorded variable name instead of resetting it", async (t) => {
  const root = await project(t);
  await writeApiConfiguration(root, "codex", "project", { ...codexFields, credential: "AZURE_OPENAI_KEY" });
  assert.equal(readJson(root, ".agents/api/codex.json").envKey, "AZURE_OPENAI_KEY");
  // The gesture the wizard labels "Credential kept": the answer set does not
  // name the credential, which on the native path means "unchanged". Rebuilding
  // this record must not replace the variable the user typed with the default —
  // the launch would then hand Codex a name nothing in the environment answers
  // to, and the change would be reported as an ordinary one.
  await writeApiConfiguration(root, "codex", "project", { provider: codexFields.provider, baseUrl: codexFields.baseUrl, model: "fixture-model-2" });
  const record = readJson(root, ".agents/api/codex.json");
  assert.equal(record.envKey, "AZURE_OPENAI_KEY");
  assert.equal(record.model, "fixture-model-2");
});

test("an OpenAI endpoint is written as the Responses API, another provider as chat", async (t) => {
  const root = await project(t);
  const home = await project(t);
  await writeApiConfiguration(root, "codex", "global", { ...codexFields, provider: "OpenAI", baseUrl: "https://api.openai.com/v1" }, { homeDir: home });
  assert.match(readText(home, ".codex/config.toml"), /^wire_api = "responses"$/m);
  assert.equal(providerIdFor("Fixture Provider"), "fixture-provider");
  assert.equal(apiCredential("codex").secret, false);
});

test("Codex project configuration is Avenic's own file, and reaches the agent as -c", async (t) => {
  const root = await project(t);
  await writeApiConfiguration(root, "codex", "project", codexFields);
  const record = JSON.parse(readText(root, ".agents/api/codex.json"));
  assert.deepEqual(record, {
    provider: "Fixture Provider",
    baseUrl: fields.baseUrl,
    model: fields.model,
    envKey: "FIXTURE_API_KEY",
    wireApi: "chat",
  });
  assert.deepEqual(await readCodexProjectConfig(root), record);
  assert.deepEqual(codexLaunchArguments(record), [
    "-c", `model=${fields.model}`,
    "-c", "model_provider=fixture-provider",
    "-c", "model_providers.fixture-provider.name=Fixture Provider",
    "-c", `model_providers.fixture-provider.base_url=${fields.baseUrl}`,
    "-c", "model_providers.fixture-provider.env_key=FIXTURE_API_KEY",
    "-c", "model_providers.fixture-provider.wire_api=chat",
  ]);
  const outcome = await removeApiConfiguration(root, "codex", "project");
  assert.equal(outcome.deleted, true);
  assert.equal(await readCodexProjectConfig(root), null);
});

// 用户可能在 Avenic 之外动这份文件。删掉 env 块之后，账本仍然证明那些键是 Avenic
// 写的（owned —— 将来还给谁、还什么，全靠它），但「配置现在生效」已不再是事实。
// 两个问题分开答，界面才有一句真话可说：文件里已经没有 Avenic 写的那份配置了。
test("a file edited outside Avenic stops claiming the configuration is in effect", async (t) => {
  const root = await project(t);
  const { relative } = await writeApiConfiguration(root, "claude", "project", fields);
  const fresh = await readApiConfiguration(root, "claude", "project");
  assert.equal(fresh.owned, true);
  assert.equal(fresh.present, true);
  const file = path.join(root, relative);
  // 整块被拿掉：同步工具重写了文件，或用户自己删的。
  const document = readJson(root, relative);
  delete document.env;
  writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  const gutted = await readApiConfiguration(root, "claude", "project");
  assert.equal(gutted.owned, true, "账本还证明得了这些键是 Avenic 写的");
  assert.equal(gutted.present, false, "但配置已不在文件里");
  // 改掉一个值是另一种「不在」：文件里的模型不再是 Avenic 写下的那个，
  // 这份配置就不再是 Avenic 的答案。
  writeFileSync(file, `${JSON.stringify({ env: { ANTHROPIC_MODEL: "someone-elses-model" } }, null, 2)}\n`, "utf8");
  const edited = await readApiConfiguration(root, "claude", "project");
  assert.equal(edited.owned, true);
  assert.equal(edited.present, false, "文件持有的不再全是 Avenic 写下的值");
});

// 问一个根本没有 Avenic 管理的 API 目标的 agent 要路径（OpenCode 自己的 provider
// 配置 Avenic 从不写），得到的应该是一句能读懂的话，而不是 null 解引用的崩溃。
test("asking an agent that owns its provider configuration for a path says so", () => {
  assert.throws(() => apiRelative("opencode", "global"), /manages its own authentication and provider configuration/);
});
