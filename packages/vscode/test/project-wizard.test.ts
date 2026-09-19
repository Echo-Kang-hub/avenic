import assert from "node:assert/strict";
import test from "node:test";
import { projectDraft, projectDraftSubmission, projectWizardSteps } from "@avenic/core";
import type { ProjectConfig, ProjectDraft } from "@avenic/core";
import { runProjectWizard } from "../src/ui/project-wizard.ts";
import type { AnsweredStep, WizardAnswer, WizardView } from "../src/ui/project-wizard.ts";

/** 被问到的那一刻，这一步长什么样。 */
interface SeenStep {
  id: string;
  index: number;
  total: number;
  answered: AnsweredStep[];
  /** multi：当时勾选项；single：当时高亮项。 */
  values?: string[];
  value?: unknown;
}

// 脚本化主机：按顺序交答案（值 / "back" / "cancel"），并记录它被问到的每一步。
// 驱动器的全部行为都能这样观察，不需要起 VS Code。
function scriptedHost(answers: WizardAnswer[]) {
  const seen: SeenStep[] = [];
  let asked = 0;
  return {
    seen,
    host: {
      async ask(view: WizardView<ProjectDraft>): Promise<WizardAnswer> {
        // 视图里持有的是活的草稿对象，所以必须在此刻快照：否则断言读到的是整轮走完后的终态，
        // 而不是那一刻用户看到的画面。
        seen.push({
          id: view.step.id,
          index: view.index,
          total: view.total,
          answered: view.answered,
          values: view.step.values?.(view.draft),
          value: view.step.value?.(view.draft),
        });
        assert.ok(asked < answers.length, `脚本没喂够答案：第 ${asked + 1} 步（${view.step.id}）时已用完`);
        return answers[asked++];
      },
    },
  };
}

function oneAgent(agentId = "claude"): ProjectConfig {
  return { agents: { [agentId]: { auth: "global", sessions: "project" } }, sessionInterop: "shared" };
}

async function run(answers: WizardAnswer[], config: ProjectConfig = oneAgent()) {
  const draft = projectDraft(config);
  const { seen, host } = scriptedHost(answers);
  const commits: ProjectDraft[] = [];
  const outcome = await runProjectWizard(draft, (d) => projectWizardSteps(d), host, async (d) => { commits.push(d); });
  return { draft, seen, commits, outcome };
}

test("walks core's steps in order and commits once on Yes", async () => {
  const { draft, seen, commits, outcome } = await run([
    { value: ["claude"] },
    { value: "project" },
    { value: "global" },
    { value: "isolated" },
    { value: true },
  ]);
  assert.deepEqual(seen.map((v) => v.id), ["agents", "auth:claude", "sessions:claude", "history", "apply"]);
  assert.deepEqual(draft.agents.claude, { auth: "project", sessions: "global" });
  assert.equal(draft.sessionInterop, "isolated");
  assert.equal(commits.length, 1, "确认只提交一次");
  assert.equal(outcome.applied, true);
});

test("answered steps are handed over collapsed, and the apply step never is", async () => {
  const { seen } = await run([
    { value: ["claude"] },
    { value: "project" },
    { value: "global" },
    { value: "isolated" },
    { value: true },
  ]);
  assert.deepEqual(seen[0].answered, [], "第一步之前没有任何已答行");
  assert.equal(seen[0].index, 0);
  assert.equal(seen[0].total, 5);

  const last = seen.at(-1)!;
  assert.equal(last.id, "apply");
  assert.deepEqual(last.answered, [
    { title: "Select agents", summary: "Claude Code" },
    { title: "Claude Code authentication", summary: "Project" },
    { title: "Claude Code session storage", summary: "Global" },
    { title: "Session history", summary: "Isolated" },
  ]);
});

test("shift+tab re-opens the previous step holding the answer it already has", async () => {
  const { seen, commits, outcome } = await run([
    { value: ["claude"] },
    { value: "project" },
    { value: "global" },
    "back",                       // 回到 sessions:claude，应带着 "global"
    "back",                       // 回到 auth:claude，应带着 "project"
    { value: "global" },          // 就地改掉
    { value: "global" },
    { value: "shared" },
    { value: true },
  ]);
  assert.equal(seen[4].id, "sessions:claude");
  assert.equal(seen[4].value, "global", "返回时必须展开上一次的答案");
  assert.equal(seen[5].id, "auth:claude");
  assert.equal(seen[5].value, "project");
  assert.deepEqual(seen[5].answered.map((a) => a.title), ["Select agents"], "返回后后面的步骤退回未答");
  assert.equal(outcome.applied, true);
  assert.deepEqual(commits.at(-1)!.agents.claude, { auth: "global", sessions: "global" }, "改了再往前走，提交的是改后的值");
});

test("shift+tab on the first step is a no-op, not a cancel", async () => {
  const { seen, outcome } = await run([
    "back",
    { value: ["claude"] },
    { value: "global" },
    { value: "project" },
    { value: "shared" },
    { value: true },
  ]);
  assert.equal(seen[1].id, "agents", "第一步按返回仍停在第一步");
  assert.equal(seen[1].index, 0);
  assert.equal(outcome.applied, true);
});

test("escape cancels the wizard without writing anything", async () => {
  // 答案只落在内存草稿里；写入项目的唯一出口是提交，所以“什么都没改”就是“没提交”。
  const { commits, outcome } = await run([
    { value: ["claude"] },
    { value: "project" },
    "cancel",
  ]);
  assert.equal(outcome.applied, false);
  assert.deepEqual(commits, [], "取消不得提交 —— 项目配置仍是原样");
});

test("answering No on the apply step writes nothing", async () => {
  const { commits, outcome } = await run([
    { value: ["claude"] },
    { value: "project" },
    { value: "project" },
    { value: "shared" },
    { value: false },
  ]);
  assert.equal(outcome.applied, false);
  assert.deepEqual(commits, []);
});

test("an empty selection is re-asked rather than accepted", async () => {
  const { seen, outcome } = await run([
    { value: [] },
    { value: ["claude"] },
    { value: "global" },
    { value: "project" },
    { value: "shared" },
    { value: true },
  ]);
  assert.equal(seen[1].id, "agents", "零选中回车后仍是同一道题");
  assert.equal(outcome.applied, true);
});

test("dropping an agent drops its questions but keeps its answers in the draft", async () => {
  const { draft, seen, commits } = await run([
    { value: ["claude"] },
    { value: "project" },   // claude 认证
    { value: "global" },    // claude 会话
    { value: "shared" },
    "back", "back", "back", "back", // 回到 agents
    { value: ["codex"] },           // 换一个 agent
    { value: "global" },
    { value: "project" },
    { value: "shared" },
    { value: true },
  ]);
  assert.equal(seen[8].id, "agents");
  assert.deepEqual(seen.slice(9).map((v) => v.id), ["auth:codex", "sessions:codex", "history", "apply"]);
  assert.deepEqual(draft.selected, ["codex"]);
  assert.deepEqual(draft.agents.claude, { auth: "project", sessions: "global" }, "被取消勾选的 agent 的答案留在草稿里");
  const submitted = projectDraftSubmission(commits.at(-1)!);
  assert.deepEqual(Object.keys(submitted.agents), ["codex"], "但只提交仍启用的 agent");
});

test("applying an existing project starts from what the project is", async () => {
  const config: ProjectConfig = {
    agents: { claude: { auth: "project", sessions: "global" }, codex: { auth: "global", sessions: "global" } },
    sessionInterop: "isolated",
  };
  const { draft, seen } = await run([{ value: ["codex"] }, { value: "global" }, { value: "global" }, { value: "shared" }, { value: true }], config);
  assert.deepEqual(seen[0].values, ["claude", "codex"], "进入时已勾选当前启用的 agent");
  assert.equal(seen[1].id, "auth:codex");
  assert.equal(seen[1].value, "global", "当前值就是 QuickPick 的默认高亮项");
  assert.equal(draft.sessionInterop, "shared");
});
