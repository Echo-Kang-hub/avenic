// §12：同一个项目在四个面上必须读到同一组词 —— `avenic init` 的摘要、`avenic status`、
// VS Code 的 Configure 问卷、以及 Dashboard 的卡片。词只有一个来处（core 的
// labels.mjs），这个文件把四个面用同一份事实并排摆出来：哪一面自己造了词，这里就红。
//
// 另一半是禁用词表：那些词描述的是 Avenic 内部怎么想这件事（"Runtime"、
// "model configuration"…），而不是用户答过什么。用户在任何一个面上都不该读到它们。
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  LABELS,
  agentCard,
  agentQuestion,
  applyProjectDraft,
  authenticationValue,
  initializeAgent,
  agentCardRows,
  loadRuntime,
  projectConfig,
  projectDraft,
  projectWizardSteps,
  setHistoryMode,
} from "../packages/core/src/index.mjs";
import { renderStatus } from "../packages/cli/src/cli/status-cli.mjs";
import { fakeStdout } from "./helpers/fake-tty.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = (relative) => path.join(packageRoot, relative);

// 一份装在磁盘上的项目：claude 走 API · Project（文件里写着 provider、地址和模型），
// codex 走 Account · Project，History 是 Isolated。四个面读的就是这一份。
async function withProject(run) {
  const { mkdtemp, mkdir, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const directory = await mkdtemp(path.join(os.tmpdir(), "avenic-vocabulary-"));
  // 这台机器上的东西一件都不读：家目录、agent 自己的家、以及 Avenic 的缓存
  // （状态页会读 Skills 的 Hub 缓存，它属于「这台机器」，不属于任何项目）。
  const environment = {
    HOME: path.join(directory, "home"),
    USERPROFILE: path.join(directory, "home"),
    AVENIC_STATE_DIR: path.join(directory, "state"),
  };
  try {
    await mkdir(environment.HOME, { recursive: true });
    await initializeAgent(directory, "claude", { authMethod: "api", configScope: "project", sessionScope: "project" }, { environment });
    await initializeAgent(directory, "codex", { authMethod: "account", accountScope: "project", sessionScope: "project" }, { environment });
    await setHistoryMode(directory, "isolated");
    await run(directory, environment);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("one project reads the same on every surface", async () => {
  await withProject(async (projectRoot, environment) => {
    const api = authenticationValue({ authMethod: "api", authScope: "project" });
    const account = authenticationValue({ authMethod: "account", authScope: "project" });
    assert.equal(api, "API (Project)");
    assert.equal(account, "Account (Project)");

    // Configure：扩展问的每一题都来自 core，所以这里读的就是扩展画出来的那一行。
    const draft = projectDraft(projectConfig(await loadRuntime(projectRoot)));
    const steps = projectWizardSteps(draft);
    const authStep = steps.find((step) => step.id === "auth:claude");
    assert.equal(authStep.title, agentQuestion("Claude Code", LABELS.authentication), "问题的标题也来自同一张词表");
    assert.deepEqual(authStep.summary(draft), { label: LABELS.authentication, value: api }, "已答的那一行：方法与它自己的作用域");
    assert.equal(steps.find((step) => step.id === "configuration-scope:claude").title, agentQuestion("Claude Code", LABELS.configurationScopeQuestion));

    // Dashboard：卡片上的每一行来自 core 的 agentCardRows —— 扩展只是把它画出来。
    const card = await agentCard(projectRoot, "claude", { environment: { ...process.env, ...environment } });
    const row = agentCardRows(card, "isolated").find((entry) => entry.key === "authentication");
    assert.deepEqual({ label: row.label, value: row.value }, { label: LABELS.authentication, value: api }, "卡片与问卷逐字相同");

    // status：同一件事在这一页上也是同一句话（值列是补齐过的，所以放宽空白）。
    const lines = [];
    const status = await (await import("../packages/core/src/status.mjs")).collectStatus(projectRoot, { environment: { ...process.env, ...environment } });
    renderStatus(status, { log: (line) => lines.push(line) }, {
      stdout: fakeStdout({ columns: 120, isTTY: false }),
      environment: { ...environment, NO_COLOR: "1" },
    });
    const page = lines.join("\n");
    // 一页一行地读：Compact 页把认证画成一列，`avenic <agent> status` 与 Dashboard
    // 画的是同一批行 —— 三个面读的都是 agentCardRows，所以值只可能有一种写法。
    assert.equal(page.match(/API \(Project\)/g)?.length, 1, `status 那一页说的也是这句话：\n${page}`);
    assert.equal(page.match(/Account \(Project\)/g)?.length, 1, "另一个 agent 的答案用同一句话的另一种写法");
    assert.doesNotMatch(page, /API · Project|Account · Project|API · Global/, "没有第二种写法");
  });
});

// 用户可见的词只有一套：值怎么念，方法怎么念，作用域怎么念，都由 labels.mjs 说了算。
// 这个测试扫的是两个宿主源码里的**字符串字面量** —— 注释不算，因为注释是在解释这些
// 词从哪来，正是该提到它们的地方。大小写也不设防：`authentication method` 小写写在
// 句子中间，和首字母大写是同一个词。
test("no host writes its own words into a string a user can read", () => {
  const banned = [
    "Runtime scope",
    "Authentication method",
    "Model configuration",
    "Model configuration scope",
    "Session storage",
    "Session history",
  ];
  // 唯一的例外：写进用户 `.gitignore` 的那行分节注释。它不是界面上的词，也从不称呼
  // 产品里的任何东西，而它已经写进了无数项目的文件里 —— 改它只会让新旧项目对不上。
  const allowed = ["# Agent Runtime"];

  const files = [];
  const walk = (directory) => {
    for (const name of readdirSync(directory)) {
      const full = path.join(directory, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(mjs|ts|js|css|html)$/.test(name)) files.push(full);
    }
  };
  for (const directory of ["packages/core/src", "packages/cli/src", "packages/vscode/src", "packages/vscode/media"]) walk(root(directory));

  // 注释先去掉：`//` 前面是 `:` 的地方是 URL（https://…），不是注释。
  const withoutComments = (source) => source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const literals = /"([^"\\\n]*)"|'([^'\\\n]*)'|`([^`]*)`/g;

  const offenders = [];
  for (const file of files) {
    const source = withoutComments(readFileSync(file, "utf8"));
    for (const match of source.matchAll(literals)) {
      const text = match[1] ?? match[2] ?? match[3] ?? "";
      if (allowed.some((entry) => text.includes(entry))) continue;
      const lower = text.toLowerCase();
      for (const term of banned) {
        if (lower.includes(term.toLowerCase())) offenders.push(`${path.relative(packageRoot, file)}: ${term} in ${JSON.stringify(text.slice(0, 80))}`);
      }
      // "Runtime" 单独一个词也是禁的：它是 Avenic 内部那份文件的名字，不是界面的词。
      if (/\bRuntime\b/.test(text)) offenders.push(`${path.relative(packageRoot, file)}: "Runtime" in ${JSON.stringify(text.slice(0, 80))}`);
      // 认证那个值只有一种写法：`API (Project)`。用中点拼出来的 `API · Project`
      // 是这一轮之前的旧措辞 —— 面板上从来没有过它。谁再自己拼一次，四个宿主就会
      // 从这里开始重新各说各的，所以拼不出第二种写法是这条测试守的事。
      if (/Account · |API · /.test(text)) offenders.push(`${path.relative(packageRoot, file)}: the Authentication value is spelled with a middot in ${JSON.stringify(text.slice(0, 80))}`);
    }
  }
  assert.deepEqual(offenders, [], "用户可见的文字里不许有实现词");
});
