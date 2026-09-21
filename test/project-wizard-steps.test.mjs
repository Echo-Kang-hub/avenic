import assert from "node:assert/strict";
import test from "node:test";
import {
  projectDraftSubmission,
  projectWizardSteps,
} from "../packages/core/src/index.mjs";

// The wizard is data: `init`, `change` and the VS Code extension render the
// same steps. These tests pin the converged question set — authentication
// method, then the scope that belongs to that method, then session storage —
// so no host can grow its own order or its own conditionals.

const draft = (agents, historyMode = "shared") => ({
  selected: Object.keys(agents),
  agents,
  historyMode,
});

const ids = (steps) => steps.map((step) => step.id);
const stepById = (steps, id) => steps.find((step) => step.id === id);

test("an Account answer opens the account scope question and nothing about providers", () => {
  const steps = projectWizardSteps(draft({
    claude: { authMethod: "account", accountScope: "global", sessionScope: "project" },
  }));
  assert.deepEqual(ids(steps), ["agents", "auth:claude", "account-scope:claude", "sessions:claude", "history", "apply"]);
  const scope = stepById(steps, "account-scope:claude");
  assert.deepEqual(scope.options.map((option) => option.value), ["global", "project"]);
  assert.match(scope.description, /\.agents\/local\/claude/);
});

test("an API answer opens the configuration scope and the provider fields as one block", () => {
  const steps = projectWizardSteps(draft({
    claude: { authMethod: "api", configScope: "project", sessionScope: "project" },
  }));
  assert.deepEqual(ids(steps), [
    "agents",
    "auth:claude",
    "api-scope:claude", "api-provider:claude", "api-url:claude", "api-model:claude", "api-credential:claude",
    "sessions:claude",
    "history",
    "apply",
  ]);
  for (const id of ["api-scope:claude", "api-provider:claude", "api-url:claude", "api-model:claude", "api-credential:claude"]) {
    assert.equal(stepById(steps, id).group, "claude-api", `${id} collapses under one block`);
  }
  const scope = stepById(steps, "api-scope:claude");
  assert.deepEqual(scope.options.map((option) => option.value), ["global", "project"]);
  assert.match(scope.options.find((option) => option.value === "project").description, /\.claude\/settings\.local\.json/);
  // The one field that must never be echoed back to the terminal.
  assert.equal(stepById(steps, "api-credential:claude").mask, true);
});

// 同一个问题的默认值只有一种：没答过时 API 的作用域是 global——与 `avenic change
// --auth api` 不带 --scope 时 core 写下的、与 README 说的是同一个答案。向导自己
// 默认 project，等于让同一条命令的两种走法写出不同的文件。答过的仍然是它自己。
test("an unanswered API scope opens on the answer the rest of core defaults to", () => {
  const unanswered = draft({ claude: { authMethod: "api", sessionScope: "project" } });
  assert.equal(stepById(projectWizardSteps(unanswered), "api-scope:claude").value(unanswered), "global");
  const answered = draft({ claude: { authMethod: "api", configScope: "project", sessionScope: "project" } });
  assert.equal(stepById(projectWizardSteps(answered), "api-scope:claude").value(answered), "project", "答过的作用域不被默认值覆盖");
});

test("Codex renders the same questions in the same order", () => {
  const steps = projectWizardSteps(draft({
    codex: { authMethod: "api", configScope: "global", sessionScope: "project" },
  }));
  assert.deepEqual(ids(steps), [
    "agents",
    "auth:codex",
    "api-scope:codex", "api-provider:codex", "api-url:codex", "api-model:codex", "api-credential:codex",
    "sessions:codex",
    "history",
    "apply",
  ]);
});

test("OpenCode is asked about session storage only", () => {
  const steps = projectWizardSteps(draft({ opencode: { sessionScope: "project" } }));
  assert.deepEqual(ids(steps), ["agents", "sessions:opencode", "history", "apply"]);
});

test("changing the answer changes the next question", () => {
  const current = draft({ claude: { authMethod: "account", accountScope: "global", sessionScope: "project" } });
  assert.ok(ids(projectWizardSteps(current)).includes("account-scope:claude"));
  current.agents.claude = { authMethod: "api", configScope: "global", sessionScope: "project" };
  const steps = projectWizardSteps(current);
  assert.equal(ids(steps).includes("account-scope:claude"), false);
  assert.ok(ids(steps).includes("api-provider:claude"));
});

test("account, codex and opencode keep their existing order when several agents are selected", () => {
  const steps = projectWizardSteps(draft({
    claude: { authMethod: "account", accountScope: "project", sessionScope: "project" },
    codex: { authMethod: "account", accountScope: "project", sessionScope: "project" },
    opencode: { sessionScope: "project" },
  }));
  assert.deepEqual(ids(steps), [
    "agents",
    "auth:claude", "account-scope:claude", "sessions:claude",
    "auth:codex", "account-scope:codex", "sessions:codex",
    "sessions:opencode",
    "history", "apply",
  ]);
});

test("the destructive confirm opens on Keep, never on the answer before it", () => {
  // The second question exists so a bare Enter at the frame after "Remove"
  // cannot decide two frames at once: it must open on the non-destructive row
  // whatever the first question was answered. A cursor that inherited
  // "remove" would delete a file on one Enter.
  const switching = {
    ...draft({ claude: { authMethod: "api", configScope: "project", sessionScope: "project" } }),
    stored: { claude: { authMethod: "api", configScope: "global" } },
    switchMode: "remove",
  };
  const steps = projectWizardSteps(switching);
  const question = stepById(steps, "switch");
  assert.equal(question.value({}), "keep", "an unanswered switch opens on Keep");
  const confirm = stepById(steps, "switch-confirm");
  assert.ok(confirm, "removing an API configuration is asked a second time");
  assert.deepEqual(confirm.options.map((option) => option.value), ["keep", "remove"]);
  assert.equal(confirm.value(switching), "keep");
  assert.match(confirm.description, /\.claude\/settings\.json/, "the file it would delete is named (the stored scope's)");
});

test("the submission carries the API fields and only the fields the method uses", () => {
  const current = draft({
    claude: { authMethod: "api", configScope: "project", sessionScope: "global" },
    codex: { authMethod: "account", accountScope: "project", sessionScope: "project" },
  });
  current.api = {
    claude: { provider: "Fixture Provider", baseUrl: "https://provider.fixture.invalid", model: "fixture-model", credential: "fixture-token-not-a-secret" },
  };
  const submission = projectDraftSubmission(current);
  assert.deepEqual(submission.agents.claude, {
    authMethod: "api", configScope: "project", sessionScope: "global",
  });
  assert.equal("accountScope" in submission.agents.claude, false);
  assert.deepEqual(submission.agents.codex, {
    authMethod: "account", accountScope: "project", sessionScope: "project",
  });
  assert.equal("configScope" in submission.agents.codex, false);
  assert.deepEqual(submission.api.claude, current.api.claude);
  assert.equal(submission.historyMode, "shared");
});
