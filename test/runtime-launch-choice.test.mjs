import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { configureProject, loadRuntime } from "../packages/core/src/runtime/config.mjs";
import {
  launchMethodQuestion,
  resolveEffectiveAgentRuntime,
} from "../packages/core/src/runtime/agent-runtime.mjs";

// A launch is the one place the two answers meet the agent: Account hands the
// agent a place to sign in, API hands it a provider. These tests pin that they
// never cross — an API launch must not carry a project account home, an Account
// launch must not carry provider variables, and a project that has not answered
// yet is asked instead of guessed.

async function project(t, draft) {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-launch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (draft) await configureProject(root, draft);
  return root;
}

// A fixture environment, never the machine's own: the assertions below are
// about what Avenic adds, and a developer's shell already holds real provider
// variables.
const base = { PATH: "/fixture/bin", HOME: "/fixture/home" };
const account = { authMethod: "account", accountScope: "project", sessionScope: "project" };
const api = { authMethod: "api", configScope: "project", sessionScope: "project" };

test("a project account gets the agent's own config home, and nothing else", async (t) => {
  const root = await project(t, { agents: { claude: account }, historyMode: "shared" });
  const runtime = await resolveEffectiveAgentRuntime(root, "claude", { environment: base });
  assert.equal(runtime.environment.CLAUDE_CONFIG_DIR, path.join(root, ".agents", "local", "claude"));
  assert.equal(runtime.environment.ANTHROPIC_BASE_URL, undefined);
  assert.equal(runtime.environment.ANTHROPIC_AUTH_TOKEN, undefined);
  const state = await loadRuntime(root);
  assert.equal(state.runtime.agents.claude.accountScope, "project");
});

test("a global account launch leaves the environment exactly as it is", async (t) => {
  const root = await project(t, { agents: { claude: { ...account, accountScope: "global" } }, historyMode: "shared" });
  const runtime = await resolveEffectiveAgentRuntime(root, "claude", { environment: base });
  assert.equal(runtime.environment, base);
  assert.equal(runtime.authMethod, "account");
});

test("an API launch never carries a project account home", async (t) => {
  const root = await project(t, { agents: { claude: api }, historyMode: "shared" });
  const runtime = await resolveEffectiveAgentRuntime(root, "claude", { environment: base });
  assert.equal(runtime.environment.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(runtime.argumentsList.length, 0);
  assert.equal(runtime.authMethod, "api");
  assert.equal(runtime.scope, "project");
});

test("a project Codex API configuration reaches the agent through its own home, not through arguments", async (t) => {
  const root = await project(t, { agents: { codex: api }, historyMode: "shared" });
  // Codex has no project-scope configuration file of its own, so the project's
  // answer is a home the project owns — and the file in it is the user's, read
  // by Codex natively. Avenic adds no override of its own: a second copy of the
  // same configuration is a second thing to keep in step.
  await mkdir(path.join(root, ".agents", "local", "codex"), { recursive: true });
  await writeFile(path.join(root, ".agents", "local", "codex", "config.toml"), 'model = "fixture-model"\n', "utf8");
  const runtime = await resolveEffectiveAgentRuntime(root, "codex", { environment: base });
  assert.equal(runtime.environment.CODEX_HOME, path.join(root, ".agents", "local", "codex"));
  assert.deepEqual(runtime.argumentsList, [], "the file says what the launch runs on, not the command line");
  assert.equal(runtime.environment.FIXTURE_API_KEY, undefined, "the key itself comes from the user's own environment");
});

test("a project Codex account gets its own home, and no provider arguments", async (t) => {
  const root = await project(t, { agents: { codex: account }, historyMode: "shared" });
  const runtime = await resolveEffectiveAgentRuntime(root, "codex", { environment: base });
  assert.equal(runtime.environment.CODEX_HOME, path.join(root, ".agents", "local", "codex"));
  assert.deepEqual(runtime.argumentsList, []);
});

test("an unanswered project is asked, not guessed", async (t) => {
  const root = await project(t, { agents: { claude: { sessionScope: "project" } }, historyMode: "shared" });
  const state = await loadRuntime(root);
  assert.equal(state.runtime.agents.claude.authMethod, undefined);
  const question = launchMethodQuestion("claude");
  assert.equal(question.title, "Claude Code authentication");
  assert.deepEqual(question.options.map((option) => option.value), ["account", "api"]);
  assert.equal(question.options[0].label, "Account");
  // Without an answer from a host, a launch refuses rather than assuming.
  // 那句话用的是面板的词：Authentication 这一行、它的值 Not chosen。
  await assert.rejects(
    () => resolveEffectiveAgentRuntime(root, "claude", { environment: base }),
    /Authentication Not chosen/i,
  );
  const resolved = await resolveEffectiveAgentRuntime(root, "claude", { environment: base, launchMethod: "account" });
  assert.equal(resolved.authMethod, "account");
  assert.equal(resolved.environment, base, "an unanswered project asked as Account stays a global account launch");
});

test("an agent that manages its own authentication has no method to be asked about", async (t) => {
  // OpenCode answers for its own sign-in and provider. Avenic records where its
  // sessions live; a launch here runs on OpenCode's own state, and no question
  // exists to ask — including for a project that never "answered", because
  // there is no answer for it to give.
  const { launchMethodReadiness } = await import("../packages/core/src/runtime/agent-runtime.mjs");
  const root = await project(t, { agents: { opencode: { sessionScope: "project" } }, historyMode: "shared" });
  assert.deepEqual(await launchMethodReadiness(root, "opencode", { environment: base }), { account: false, api: null });
  const runtime = await resolveEffectiveAgentRuntime(root, "opencode", { environment: base });
  assert.equal(runtime.authMethod, null);
  assert.equal(runtime.scope, null);
  assert.equal(runtime.environment, base, "OpenCode's own environment is handed over unchanged");
  assert.deepEqual(runtime.argumentsList, []);
});

test("a remembered answer is a project-local override that deletes nothing", async (t) => {
  const root = await project(t, { agents: { claude: { sessionScope: "project" } }, historyMode: "shared" });
  const { setLocalAuth, effectiveAgentConfig } = await import("../packages/core/src/runtime/config.mjs");
  await setLocalAuth(root, "claude", { authMethod: "api", configScope: "global" });
  const state = await loadRuntime(root);
  assert.equal(state.runtime.agents.claude.authMethod, undefined, "the project's own answer is untouched");
  const effective = effectiveAgentConfig(state, "claude");
  assert.equal(effective.authMethod, "api");
  assert.equal(effective.configScope, "global");
  assert.equal(effective.source, "local");
  assert.deepEqual(state.runtime.agents.claude, { enabled: true, sessionScope: "project" });
});
