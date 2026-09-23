import assert from "node:assert/strict";
import test from "node:test";
import {
  projectDraftSubmission,
  projectWizardSteps,
} from "../packages/core/src/index.mjs";

// 向导是一份数据：`init`、`change` 和 VS Code 扩展渲染的是同一串步骤。这组测试钉住
// 收敛之后的问题集 —— 选 agent、每个 agent 的 Authentication、那个答案的作用域、
// Sessions，然后项目的 History —— 于是没有哪个宿主能长出自己的一套顺序或条件。
//
// 被删掉的那几问（provider、endpoint、model、credential）在这份清单里没有位置：
// API 只是「把 agent 自己读的那个配置文件准备好」，内容归用户和他们的工具。这一组
// 测试因此也是那条边界：它们失败的方式就是有人又加回了一问。

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
  assert.equal(scope.title, "Claude Code account scope", "the question says whose it is — the rail that will hold it is titled by the agent");
  assert.deepEqual(scope.options.map((option) => option.value), ["global", "project"]);
  assert.match(scope.description, /\.agents\/local\/claude/);
});

test("an API answer asks where the configuration lives, then what fills it", () => {
  const steps = projectWizardSteps(draft({
    claude: { authMethod: "api", configScope: "project", sessionScope: "project" },
  }));
  // 这一支问两件事：配置住在哪个文件（原有的那一问），以及谁来填它（Center）。
  // Center 的那一问开在「自己来」上 —— 没选 provider 的项目，Avenic 仍然只准备
  // 文件、不填内容，这是它在 Center 出现之前就有的契约。
  assert.deepEqual(ids(steps), ["agents", "auth:claude", "configuration-scope:claude", "provider:claude", "sessions:claude", "history", "apply"]);
  const answer = draft({ claude: { authMethod: "api", configScope: "project", sessionScope: "project" } });
  assert.equal(stepById(steps, "provider:claude").value(answer), "hand");
  const scope = stepById(steps, "configuration-scope:claude");
  assert.equal(scope.title, "Claude Code configuration scope");
  assert.deepEqual(scope.options.map((option) => option.value), ["global", "project"]);
  // 这一问的答案就是一个文件，因此选项直接说出那个文件。
  assert.equal(scope.options.find((option) => option.value === "project").description, "write .claude/settings.local.json");
  assert.equal(scope.options.find((option) => option.value === "global").description, "write ~/.claude/settings.json");
});

test("every per-agent question collapses under the agent's own name", () => {
  const steps = projectWizardSteps(draft({
    codex: { authMethod: "api", configScope: "project", sessionScope: "project" },
  }));
  for (const id of ["auth:codex", "configuration-scope:codex", "sessions:codex"]) {
    const step = stepById(steps, id);
    assert.equal(step.group, "codex", `${id} collapses into one block`);
    assert.equal(step.groupTitle, "Codex", `${id} takes the agent's display name as the block's title`);
  }
});

// 同一个问题的默认值只有一种：没答过时 API 的作用域是 global —— 与 `avenic change
// --auth api` 不带 --scope 时 core 写下的、与 README 说的是同一个答案。向导自己
// 默认 project，等于让同一条命令的两种走法写出不同的文件。答过的仍然是它自己。
test("an unanswered configuration scope opens on the answer the rest of core defaults to", () => {
  const unanswered = draft({ claude: { authMethod: "api", sessionScope: "project" } });
  assert.equal(stepById(projectWizardSteps(unanswered), "configuration-scope:claude").value(unanswered), "global");
  const answered = draft({ claude: { authMethod: "api", configScope: "project", sessionScope: "project" } });
  assert.equal(stepById(projectWizardSteps(answered), "configuration-scope:claude").value(answered), "project", "答过的作用域不被默认值覆盖");
});

test("Codex renders the same questions in the same order, and is asked for no key", () => {
  const steps = projectWizardSteps(draft({
    codex: { authMethod: "api", configScope: "global", sessionScope: "project" },
  }));
  // 顺序与 Claude 同形，只有在 provider 之后少一题：Codex 的凭据从不进它的配置文件。
  assert.deepEqual(ids(steps), ["agents", "auth:codex", "configuration-scope:codex", "provider:codex", "sessions:codex", "history", "apply"]);
});

test("OpenCode is asked about Sessions only, and the record says who authenticates it", () => {
  const opencode = draft({ opencode: { sessionScope: "project" } });
  const steps = projectWizardSteps(opencode);
  assert.deepEqual(ids(steps), ["agents", "sessions:opencode", "history", "apply"]);
  // 「谁登录」这一问对它是被回答过的 —— 由它自己回答，用它自己的界面。漏掉这一行
  // 会让摘要少说一件事，而不是少问一件事。
  assert.deepEqual(stepById(steps, "sessions:opencode").summary(opencode), [
    { label: "Authentication", value: "Native (OpenCode UI)" },
    { label: "Sessions", value: "Project" },
  ]);
});

test("changing the answer changes the next question", () => {
  const current = draft({ claude: { authMethod: "account", accountScope: "global", sessionScope: "project" } });
  assert.ok(ids(projectWizardSteps(current)).includes("account-scope:claude"));
  current.agents.claude = { authMethod: "api", configScope: "global", sessionScope: "project" };
  const steps = projectWizardSteps(current);
  assert.equal(ids(steps).includes("account-scope:claude"), false);
  assert.equal(ids(steps).includes("configuration-scope:claude"), true);
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

// 摘要就是 Dashboard 卡片上的那几行，连写法都算：方法后面永远跟着它自己的作用域，
// 因为「API」两个字没有说这份配置在哪儿 —— 而卡片上写的是 `API (Project)`。
test("a settled answer reads as the dashboard card reads", () => {
  const api = draft({ claude: { authMethod: "api", configScope: "project", sessionScope: "global" } });
  assert.deepEqual(stepById(projectWizardSteps(api), "auth:claude").summary(api), { label: "Authentication", value: "API (Project)" });
  assert.deepEqual(stepById(projectWizardSteps(api), "configuration-scope:claude").summary(api), {
    label: "Config Source", value: ".claude/settings.local.json",
  });
  // 作用域还没答的那一刻只写方法名：把默认的 (Global) 写进记录，等于替用户答了下一题。
  const half = draft({ claude: { authMethod: "api", sessionScope: "global" } });
  assert.deepEqual(stepById(projectWizardSteps(half), "auth:claude").summary(half), { label: "Authentication", value: "API" });
  const account = draft({ claude: { authMethod: "account", accountScope: "project", sessionScope: "project" } });
  assert.deepEqual(stepById(projectWizardSteps(account), "account-scope:claude").summary(account), {
    label: "Account Scope", value: "Project (.agents/local/claude)",
  });
});

test("History is the project's own answer, and it is the last question before Apply", () => {
  const current = draft({ opencode: { sessionScope: "project" } }, "isolated");
  const steps = projectWizardSteps(current);
  const history = stepById(steps, "history");
  assert.equal(history.summary(current), "Isolated");
  assert.equal(steps.at(-1).id, "apply");
  assert.equal(stepById(steps, "apply").apply, true);
});

test("the destructive confirm opens on Keep, never on the answer before it", () => {
  // The second question exists so a bare Enter at the frame after "Remove"
  // cannot decide two frames at once: it must open on the non-destructive row
  // whatever the first question was answered. A cursor that inherited
  // "remove" would delete a file on one Enter.
  const switching = {
    ...draft({ claude: { authMethod: "account", accountScope: "project", sessionScope: "project" } }),
    stored: { claude: { authMethod: "api", configScope: "global" } },
    files: { claude: { relative: "~/.claude/settings.json", scope: "global", exists: true, owned: true, unchanged: true } },
    switchMode: "remove",
  };
  const steps = projectWizardSteps(switching);
  const question = stepById(steps, "switch");
  assert.equal(question.title, "What should Avenic do?");
  assert.deepEqual(question.options.map((option) => option.value), ["keep", "remove"]);
  assert.equal(question.value({}), "keep", "an unanswered switch opens on Keep");
  // 先说清楚哪份文件还在，再问怎么办 —— 问题是关于那份文件的。
  assert.equal(stepById(steps, "leftover:claude").kind, "note");
  assert.equal(stepById(steps, "leftover:claude").summary(), "~/.claude/settings.json is still present.");
  const confirm = stepById(steps, "switch-confirm");
  assert.ok(confirm, "removing an API configuration is asked a second time");
  assert.deepEqual(confirm.options.map((option) => option.value), ["remove", "keep"]);
  assert.equal(confirm.value(switching), "keep");
  assert.match(confirm.description, /~\/\.claude\/settings\.json/, "the file it would delete is named");
});

// 一份自己改过的文件不是 Avenic 的：第二问就不该为它出现，因为第二问的答案不会
// 删掉它。问题问的是「要不要删」，可删的东西为空时那个问题没有内容。
test("a file the user has edited is not something the destructive question offers to delete", () => {
  const switching = {
    ...draft({ claude: { authMethod: "account", accountScope: "project", sessionScope: "project" } }),
    stored: { claude: { authMethod: "api", configScope: "global" } },
    files: { claude: { relative: "~/.claude/settings.json", scope: "global", exists: true, owned: true, unchanged: false } },
    switchMode: "remove",
  };
  const steps = projectWizardSteps(switching);
  assert.ok(stepById(steps, "leftover:claude"), "the file is still named — it is still there");
  assert.equal(stepById(steps, "switch-confirm"), undefined, "nothing Avenic can prove is its own is being deleted");
});

test("an answer that replaces nothing asks nothing", () => {
  const steps = projectWizardSteps(draft({ claude: { authMethod: "api", configScope: "project", sessionScope: "project" } }));
  assert.equal(stepById(steps, "switch"), undefined);
  assert.equal(stepById(steps, "switch-confirm"), undefined);
});

test("the submission carries the answers the method uses and nothing of the other's", () => {
  const current = draft({
    claude: { authMethod: "api", configScope: "project", sessionScope: "global" },
    codex: { authMethod: "account", accountScope: "project", sessionScope: "project" },
    opencode: { sessionScope: "global" },
  });
  const submission = projectDraftSubmission(current);
  assert.deepEqual(submission.agents.claude, { authMethod: "api", configScope: "project", sessionScope: "global" });
  assert.equal("accountScope" in submission.agents.claude, false);
  assert.deepEqual(submission.agents.codex, { authMethod: "account", accountScope: "project", sessionScope: "project" });
  assert.equal("configScope" in submission.agents.codex, false);
  assert.deepEqual(submission.agents.opencode, { sessionScope: "global" });
  assert.equal(submission.historyMode, "shared");
});

test("an agent nobody answered for is submitted without a method, not with a guess", () => {
  const submission = projectDraftSubmission(draft({ opencode: { sessionScope: "project" }, claude: { sessionScope: "global" } }));
  assert.deepEqual(submission.agents.claude, { sessionScope: "global" });
});
