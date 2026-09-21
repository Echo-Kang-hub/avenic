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
        const answer = answers[asked++];
        // 脚本数错步子会把一个值喂给别的步骤，然后在这一轮深处炸开；这里就地点名。
        if (typeof answer === "object") {
          assert.equal(Array.isArray(answer.value), view.step.kind === "multi", `第 ${asked} 步（${view.step.id}，${view.step.kind}）拿到的答案形状不对`);
        }
        return answer;
      },
    },
  };
}

function oneAgent(agentId = "claude"): ProjectConfig {
  return { agents: { [agentId]: { sessionScope: "project", authMethod: "account", accountScope: "global" } }, historyMode: "shared" };
}

// 一个从没答过方法的项目：被问到的第一件事就是方法本身，因此 API 的五个字段
// 都是「第一次回答」而不是「替换」。需要替换语义的用例自己给配置。
function noMethod(agentId = "claude"): ProjectConfig {
  return { agents: { [agentId]: { sessionScope: "project" } }, historyMode: "shared" };
}

async function run(answers: WizardAnswer[], config: ProjectConfig = oneAgent(), files?: Record<string, unknown>) {
  const draft = projectDraft(config, { files: files as never });
  const { seen, host } = scriptedHost(answers);
  const commits: ProjectDraft[] = [];
  const outcome = await runProjectWizard(draft, (d) => projectWizardSteps(d), host, async (d) => { commits.push(d); return d; });
  return { draft, seen, commits, outcome };
}

test("walks core's steps in order and commits once on Yes", async () => {
  const { draft, seen, commits, outcome } = await run([
    { value: ["claude"] },
    { value: "account" },
    { value: "project" },
    { value: "global" },
    { value: "isolated" },
    { value: true },
  ]);
  assert.deepEqual(seen.map((v) => v.id), ["agents", "auth:claude", "account-scope:claude", "sessions:claude", "history", "apply"]);
  assert.deepEqual(draft.agents.claude, { authMethod: "account", accountScope: "project", sessionScope: "global" });
  assert.equal(draft.historyMode, "isolated");
  assert.equal(commits.length, 1, "确认只提交一次");
  assert.equal(outcome.applied, true);
  assert.deepEqual(outcome.result, draft, "提交的返回值交给调用方，而不是藏在回调外的变量里");
});

test("answered steps are handed over collapsed, and the apply step never is", async () => {
  const { seen } = await run([
    { value: ["claude"] },
    { value: "account" },
    { value: "project" },
    { value: "global" },
    { value: "isolated" },
    { value: true },
  ]);
  assert.deepEqual(seen[0].answered, [], "第一步之前没有任何已答行");
  assert.equal(seen[0].index, 0);
  assert.equal(seen[0].total, 6);

  const last = seen.at(-1)!;
  assert.equal(last.id, "apply");
  // 同一个 agent 的几答折成一块，块标题是 agent 自己的名字，块里每一行是「标签 值」，
  // 行与行之间用 │ 串起来 —— 这与终端轨道上折出来的那一块是同一份答案、同一种排法。
  // 值本身与 Dashboard 的卡片逐字相同：认证那一行说的是方法与它自己的作用域
  // （"Account (Project)"），账号作用域那一行把作用域和承载它的目录一起写出来。
  assert.deepEqual(last.answered.map((line) => line.title), ["Select agents", "Claude Code", "History"]);
  assert.deepEqual(last.answered.map((line) => line.summary), [
    "Claude Code",
    "Authentication Account (Project) │ Account Scope Project (.agents/local/claude) │ Sessions Global",
    "Isolated",
  ]);
});

// API 那一块在已答区是一行：这一问的答案就是「配置住在哪个文件」，摘要写的就是那个
// 文件本身（core 给的相对路径），因此面板上那一行与 `avenic status` 的那一格逐字相同。
test("the API block folds into one answered line naming the file it writes", async () => {
  const { seen, draft } = await run([
    { value: ["claude"] },
    { value: "api" },
    { value: "project" },
    { value: "project" },
    { value: "shared" },
    { value: true },
  ], noMethod());
  const answered = seen.at(-1)!.answered;
  assert.deepEqual(answered.map((line) => line.title), ["Select agents", "Claude Code", "History"]);
  const claude = answered.find((line) => line.title === "Claude Code")!.summary;
  assert.equal(claude.includes("Config Source .claude/settings.local.json"), true, "说的是承载配置的那个文件，不是「Project」两个字");
  assert.equal(claude.includes("Authentication API (Project)"), true, "方法与作用域是同一句话的两半");
  assert.equal(claude.includes("Provider"), false, "Avenic 不问 provider、地址、模型或凭据：文件是用户的");
  assert.equal(draft.agents.claude.configScope, "project");
});

test("shift+tab re-opens the previous step holding the answer it already has", async () => {
  const { seen, commits, outcome } = await run([
    { value: ["claude"] },
    { value: "account" },
    { value: "project" },
    { value: "global" },
    "back",                       // 回到 sessions:claude
    "back",                       // 回到 account-scope:claude，应带着 "project"
    { value: "global" },          // 就地改掉
    { value: "global" },
    { value: "shared" },
    { value: true },
  ]);
  assert.equal(seen[4].id, "history", "答完会话就往前走了一步");
  assert.equal(seen[5].id, "sessions:claude");
  assert.equal(seen[5].value, "global", "返回时必须展开上一次的答案");
  assert.equal(seen[6].id, "account-scope:claude");
  assert.equal(seen[6].value, "project");
  assert.deepEqual(seen[6].answered.map((a) => a.title), ["Select agents", "Claude Code"], "返回后后面的步骤退回未答");
  assert.equal(outcome.applied, true);
  assert.deepEqual(
    commits.at(-1)!.agents.claude,
    { authMethod: "account", accountScope: "global", sessionScope: "global" },
    "改了再往前走，提交的是改后的值",
  );
});

test("shift+tab on the first step is a no-op, not a cancel", async () => {
  const { seen, outcome } = await run([
    "back",
    { value: ["claude"] },
    { value: "account" },
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
    { value: "account" },
    "cancel",
  ]);
  assert.equal(outcome.applied, false);
  assert.equal(outcome.result, null);
  assert.deepEqual(commits, [], "取消不得提交 —— 项目配置仍是原样");
});

test("answering No on the apply step writes nothing", async () => {
  const { commits, outcome } = await run([
    { value: ["claude"] },
    { value: "account" },
    { value: "project" },
    { value: "project" },
    { value: "shared" },
    { value: false },
  ]);
  assert.equal(outcome.applied, false);
  assert.equal(outcome.result, null);
  assert.deepEqual(commits, []);
});

test("an empty selection is re-asked rather than accepted", async () => {
  const { seen, outcome } = await run([
    { value: [] },
    { value: ["claude"] },
    { value: "account" },
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
    { value: "account" },   // claude 认证
    { value: "project" },   // claude 账号作用域
    { value: "global" },    // claude 会话
    { value: "shared" },
    // 答完 history 后落在 apply 上；从这里一路退回 agents 要走六步。
    "back", "back", "back", "back", "back", "back",
    { value: ["codex"] },           // 换一个 agent
    { value: "account" },
    { value: "global" },
    { value: "project" },
    { value: "shared" },
    { value: true },
  ]);
  assert.equal(seen[11].id, "agents");
  assert.deepEqual(seen.slice(12).map((v) => v.id), ["auth:codex", "account-scope:codex", "sessions:codex", "history", "apply"]);
  assert.deepEqual(draft.selected, ["codex"]);
  assert.deepEqual(
    draft.agents.claude,
    { authMethod: "account", accountScope: "project", sessionScope: "global" },
    "被取消勾选的 agent 的答案留在草稿里",
  );
  const submitted = projectDraftSubmission(commits.at(-1)!);
  assert.deepEqual(Object.keys(submitted.agents), ["codex"], "但只提交仍启用的 agent");
});

test("applying an existing project starts from what the project is", async () => {
  const config: ProjectConfig = {
    agents: {
      claude: { authMethod: "account", accountScope: "project", sessionScope: "global" },
      codex: { authMethod: "api", configScope: "global", sessionScope: "global" },
    },
    historyMode: "isolated",
  };
  const { draft, seen } = await run([
    { value: ["codex"] },
    { value: "api" },                       // 保持 api，因此没有 switch 那一问
    { value: "global" },                    // 配置来源（codex 的全局配置）
    { value: "global" },                    // 会话
    { value: "isolated" },
    { value: true },
  ], config);
  assert.deepEqual(seen[0].values, ["claude", "codex"], "进入时已勾选当前启用的 agent");
  assert.equal(seen[1].id, "auth:codex");
  assert.equal(seen[1].value, "api", "当前值就是 QuickPick 的默认高亮项");
  assert.equal(draft.historyMode, "isolated");
  // claude 被取消了勾选，它的答案留在草稿里但不进配置。
  assert.deepEqual(draft.selected, ["codex"]);
});

// 换方法会留下上一个答案写下的东西，所以回退的最后一问是「留还是删」，
// 默认 Keep；它出现在新答案已经答完之后、写盘之前 —— 而那一问之前还有一行
// 只读的 ◇：旧文件还在，读的人得先知道这件事，才知道下面这一问是关于什么的。
function switchedFiles() {
  return { claude: { relative: ".claude/settings.local.json", scope: "project", exists: true, owned: true, unchanged: true } };
}

test("replacing a method asks the keep/remove question before Apply, defaulting to Keep", async () => {
  const config: ProjectConfig = {
    agents: { claude: { authMethod: "api", configScope: "project", sessionScope: "project" } },
    historyMode: "shared",
  };
  const { draft, seen } = await run([
    { value: ["claude"] },
    { value: "account" },
    { value: "project" },
    { value: "project" },   // 会话
    { value: "shared" },    // history
    { value: "keep" },      // 那一问
    { value: true },
  ], config, switchedFiles());
  // note 那一行没有人答，两个方向都跳过它：它只是「已答」区里的一行。
  assert.deepEqual(seen.map((view) => view.id), [
    "agents", "auth:claude", "account-scope:claude", "sessions:claude", "history", "switch", "apply",
  ], "只读的那一行从不成为当前问题");
  assert.equal(seen.at(-2)!.id, "switch");
  assert.equal(seen.at(-2)!.value, "keep", "默认项是 Keep");
  const answered = seen.at(-1)!.answered.map((line) => line.title);
  assert.equal(answered.includes("Existing Claude Code configuration"), true, "旧文件那一行在已答区里读得到");
  assert.deepEqual(seen.at(-1)!.answered.at(-1), { title: "What should Avenic do?", summary: "Keep" });
  assert.equal(draft.switchMode, "keep");
});

// Remove 是唯一会删东西的答案，所以它被问第二次，而第二次的第一项是 No ——
// 前一问的答案绝不能是一个空回车就能重复的。
test("Remove asks a second time, and the second question opens on No", async () => {
  const config: ProjectConfig = {
    agents: { claude: { authMethod: "api", configScope: "project", sessionScope: "project" } },
    historyMode: "shared",
  };
  const { draft, seen } = await run([
    { value: ["claude"] },
    { value: "account" },
    { value: "project" },
    { value: "project" },
    { value: "shared" },
    { value: "remove" },
    { value: "keep" },      // 第二次回答：No
    { value: true },
  ], config, switchedFiles());
  const confirm = seen.find((view) => view.id === "switch-confirm")!;
  assert.equal(confirm.value, "keep", "第二个问题打开在 No 上");
  assert.equal(draft.switchMode, "keep", "答 No 之后什么都不删");
  // 一个 Avenic 建不出、也因此删不掉的旧文件（用户自己写的）不会被问第二次：
  // 能删的只有「Avenic 创建、且没人动过」的那些。
  const foreign = await run([
    { value: ["claude"] },
    { value: "account" },
    { value: "project" },
    { value: "project" },
    { value: "shared" },
    { value: "remove" },
    { value: true },
  ], config, { claude: { relative: ".claude/settings.local.json", scope: "project", exists: true, owned: false, unchanged: false } });
  assert.equal(foreign.seen.some((view) => view.id === "switch-confirm"), false, "只找到的文件不进入那一问");
  assert.equal(foreign.seen.at(-2)!.id, "switch");
  assert.equal(foreign.draft.switchMode, "remove");
});
