import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  initializeAgent,
  launchMethodQuestion,
  launchMethodReadiness,
  resolveEffectiveAgentRuntime,
} from "../packages/core/src/index.mjs";
import { fillApiConfiguration } from "./helpers/api-fixture.mjs";

test("effective runtime resolution preserves the normal environment and does not invent a model", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-runtime-resolution-"));
  try {
    await initializeAgent(root, "claude", { authMethod: "account", accountScope: "global", sessionScope: "project" });
    // An environment that already carries a provider and a model, as a user's
    // shell may: global Account mode changes nothing about it, because the
    // agent is using this machine's own sign-in and Avenic configures no model.
    const environment = { PATH: "C:\\agents", ANTHROPIC_BASE_URL: "https://provider.invalid", ANTHROPIC_MODEL: "provider-model" };
    const runtime = await resolveEffectiveAgentRuntime(root, "claude", { environment, argumentsList: ["--resume", "native"] });
    assert.equal(runtime.authMethod, "account");
    assert.equal(runtime.scope, "global");
    assert.deepEqual(runtime.argumentsList, ["--resume", "native"], "no provider or model arguments are added");
    assert.equal(runtime.environment, environment, "a launch that adds nothing hands its caller's environment back by identity");
    assert.equal(runtime.environment.ANTHROPIC_MODEL, "provider-model");
    assert.equal(runtime.environment.ANTHROPIC_BASE_URL, "https://provider.invalid");
    assert.equal(runtime.environment.CLAUDE_CONFIG_DIR, undefined, "a global account is the machine's own");

    // A project-scoped account changes exactly one variable — the agent's own
    // configuration home — and leaves the rest of the environment alone.
    await initializeAgent(root, "claude", { authMethod: "account", accountScope: "project" });
    const scoped = await resolveEffectiveAgentRuntime(root, "claude", { environment, argumentsList: [] });
    assert.deepEqual(Object.keys(scoped.environment).filter((name) => !(name in environment)), ["CLAUDE_CONFIG_DIR"]);
    assert.equal(path.resolve(scoped.environment.CLAUDE_CONFIG_DIR), path.resolve(root, ".agents", "local", "claude"));
    assert.equal(scoped.environment.ANTHROPIC_MODEL, "provider-model");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the launch question names the methods this project already has, and only reads", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-runtime-readiness-"));
  const machineHome = await mkdtemp(path.join(os.tmpdir(), "avenic-runtime-machine-"));
  // 这台机器自己的家指向一个空目录：一个还没答过认证的项目，启动时读的正是这里，
  // 于是「什么都没设置」这句话说的是一台没有任何配置的机器，而不是开发者的。
  const environment = { HOME: machineHome, USERPROFILE: machineHome };
  try {
    await initializeAgent(root, "claude", { authMethod: "account", accountScope: "project", sessionScope: "project" });
    // Nothing is set up yet: a project home exists because Account·Project
    // needs one, but no sign-in has happened in it and no configuration has
    // been written.
    const nothing = await launchMethodReadiness(root, "claude", { environment });
    assert.deepEqual(nothing, { account: false, api: null });
    const plain = launchMethodQuestion("claude", nothing);
    assert.equal(plain.options[0].description, "use Claude Code's native account sign-in");
    assert.equal(plain.options[1].description, "use a provider/model/API configuration");

    // The agent's own login writes its own credential file, in its own format,
    // in the home the project scope points at. Avenic only reads it.
    const projectHome = path.join(root, ".agents", "local", "claude");
    await mkdir(projectHome, { recursive: true });
    await writeFile(path.join(projectHome, ".credentials.json"), `${JSON.stringify({ claudeAiOauth: { scopes: ["user:inference"] } })}\n`);
    const signedIn = await launchMethodReadiness(root, "claude", { environment });
    assert.deepEqual(signedIn, { account: true, api: null });

    // Switching to API and keeping the account home — the default — leaves both
    // methods usable, which is the state the question has to describe rather
    // than offer two identical-looking choices. The user fills the file Avenic
    // prepared; the launch reads it and asks nothing of Avenic.
    await fillApiConfiguration(root, "claude", "project", {
      provider: "FixtureProvider",
      baseUrl: "https://provider.fixture.invalid/v1",
      model: "fixture-model",
      credential: "fixture-credential-not-a-real-secret",
    });
    const both = await launchMethodReadiness(root, "claude", { environment });
    assert.deepEqual(both, { account: true, api: ".claude/settings.local.json" });
    const informed = launchMethodQuestion("claude", both);
    assert.equal(informed.options[0].description, "use Claude Code's native account sign-in — already signed in here");
    assert.equal(informed.options[1].description, "use a provider/model/API configuration — .claude/settings.local.json is ready");
    // Both options still carry the value a launch runs under, so drawing the
    // question cannot change what the answer means.
    assert.deepEqual(informed.options.map((option) => option.value), ["account", "api"]);

    // A sign-in that cannot be established is not a sign-in: a credential file
    // this reader cannot parse leaves the method unclaimed rather than guessed.
    await writeFile(path.join(projectHome, ".credentials.json"), "{ not json\n");
    assert.deepEqual(await launchMethodReadiness(root, "claude", { environment }), { account: false, api: ".claude/settings.local.json" });
    // Reading is the whole contract: the credential the agent wrote is still
    // there, byte for byte, and no file was created next to it.
    assert.equal(await readFile(path.join(projectHome, ".credentials.json"), "utf8"), "{ not json\n");
    assert.deepEqual(await readdir(projectHome), [".credentials.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(machineHome, { recursive: true, force: true });
  }
});

test("an unanswered project describes the account a launch there would run with", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-runtime-unanswered-"));
  const home = await mkdtemp(path.join(os.tmpdir(), "avenic-runtime-global-"));
  try {
    // Nothing has been answered for this project, so a launch uses the
    // machine's own account — the same home an answered `Account · Global`
    // would use. That is the sign-in the question has to describe.
    await writeFile(path.join(home, ".credentials.json"), `${JSON.stringify({ claudeAiOauth: { scopes: ["user:inference"] } })}\n`);
    const environment = { CLAUDE_CONFIG_DIR: home };
    assert.deepEqual(await launchMethodReadiness(root, "claude", { environment }), { account: true, api: null });
    const question = launchMethodQuestion("claude", { account: true, api: null });
    assert.equal(question.options[0].description, "use Claude Code's native account sign-in — already signed in here");

    // A sign-in in the project's own home is not that account, and a project
    // that never chose Account · Project does not run on it.
    const projectHome = path.join(root, ".agents", "local", "claude");
    await mkdir(projectHome, { recursive: true });
    await writeFile(path.join(projectHome, ".credentials.json"), `${JSON.stringify({ claudeAiOauth: { scopes: ["user:inference"] } })}\n`);
    await rm(path.join(home, ".credentials.json"));
    assert.deepEqual(
      await launchMethodReadiness(root, "claude", { environment }),
      { account: false, api: null },
      "the project's own home is only an account when the project answered Account · Project",
    );
    await initializeAgent(root, "claude", { authMethod: "account", accountScope: "project", sessionScope: "project" });
    assert.deepEqual(await launchMethodReadiness(root, "claude", { environment }), { account: true, api: null });
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("a configuration edited out of the file is not a method a launch has", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-runtime-stale-api-"));
  const home = await mkdtemp(path.join(os.tmpdir(), "avenic-runtime-stale-home-"));
  // 这台机器自己的账号状态与用例无关：环境指向一个空 home，两种方法都由夹具决定。
  const environment = { CLAUDE_CONFIG_DIR: home };
  try {
    await initializeAgent(root, "claude", { authMethod: "api", configScope: "project", sessionScope: "project" });
    await fillApiConfiguration(root, "claude", "project", {
      provider: "FixtureProvider",
      baseUrl: "https://provider.fixture.invalid/v1",
      model: "fixture-model",
      credential: "fixture-credential-not-a-real-secret",
    });
    assert.deepEqual(await launchMethodReadiness(root, "claude", { environment }), { account: false, api: ".claude/settings.local.json" });
    // 用户在 Avenic 之外清空了配置：文件还在，但这次启动不会带着任何 API 配置跑
    // 起来 —— 问题里就不能再把它说成一种可用的方法（那正是会误导人的那一次回答：
    // 用户选了它，agent 却起在没有任何 provider 的状态上）。
    const file = path.join(root, ".claude", "settings.local.json");
    const document = JSON.parse(await readFile(file, "utf8"));
    delete document.env;
    await writeFile(file, `${JSON.stringify(document, null, 2)}\n`);
    assert.deepEqual(await launchMethodReadiness(root, "claude", { environment }), { account: false, api: null });
    // 启动本身也要说得出为什么，并说得出下一步：文件在、里面没写。
    const runtime = await resolveEffectiveAgentRuntime(root, "claude", { environment });
    assert.match(runtime.note ?? "", /\.claude\/settings\.local\.json does not name a provider or a model yet — fill it in/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});
