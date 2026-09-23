import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { configureProject, historyLabel, hookActionsPath, runtimePaths } from "@avenic/core";
import { CORE_VERSION, DOCS_URL } from "../src/product.ts";
import { aboutFacts, aboutFileFor, type AboutOptions } from "../src/services/about.ts";
import { TEXT } from "../src/i18n/text.ts";

// 设置与关于（宿主侧）：这一页不配置任何东西，它只把「这套安装是什么、这个项目的文件在
// 哪里」说清楚。因此这里断言的是两件事——每一行都来自唯一的那一个来源（core 的路径、
// 清单里的版本、已经探过的那一次 CLI），以及一行可点的「显示」指向的路径是宿主自己
// 算出来的，而不是页面递过来的。

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = { id: "EchoKang.avenic-agent-manager", name: "avenic-agent-manager", displayName: "Avenic Agent Manager", version: "0.6.1" };
const CLI = "1.8.4";
const STORAGE = path.join(os.tmpdir(), "avenic-storage");

/** 一行的取用：按 key 找，找不到就是把这一行漏了（测试里显式失败好过 undefined 扩散）。 */
function row(facts: { rows: Array<{ key: string; label: string; value: string; reveal: boolean }> }, key: string) {
  const found = facts.rows.find((entry) => entry.key === key);
  assert.ok(found, `没有这一行：${key}`);
  return found;
}

function options(extra: Partial<AboutOptions> = {}): AboutOptions {
  return { extension: MANIFEST, coreVersion: CORE_VERSION, editorVersion: "1.100.0", cliVersion: CLI, storagePath: STORAGE, ...extra };
}

const HAS_CJK = /[㐀-鿿]/;

test("the page answers what this install is and where its files are, each fact from its one source", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-about-"));
  try {
    // 存储目录是编辑器建的，先让它真的在：一行「可点」的意思就是它指着的东西真的存在。
    await mkdir(STORAGE, { recursive: true });
    const facts = await aboutFacts(root, options());
    assert.deepEqual(facts.rows.map((entry) => entry.key), ["extension", "editor", "cli", "core", "project", "config", "hooks", "logs", "storage"], "还没配置过的项目：没有历史那一行");

    assert.equal(row(facts, "extension").value, "Avenic Agent Manager 0.6.1", "扩展自己的名字与版本来自清单");
    assert.equal(row(facts, "editor").value, "Visual Studio Code 1.100.0");
    assert.equal(row(facts, "cli").value, CLI, "CLI 那一行说的是这台机器上真正在用的那份（已经探过），这里不探第二次");
    assert.equal(row(facts, "core").value, CORE_VERSION);
    assert.equal(row(facts, "project").value, root);
    // 两个文件行说的就是 core 的两条路径：插件不自己拼 .agents/…。
    assert.equal(row(facts, "config").value, runtimePaths(root).runtimeFile);
    assert.equal(row(facts, "hooks").value, hookActionsPath(root));
    assert.equal(row(facts, "storage").value, STORAGE);
    assert.equal(row(facts, "logs").value, TEXT["about.logs-value"].en);

    // 还没写过的那两个文件：行照旧说出路径，但不可点 —— 「显示」一个不存在的文件是坏控件。
    assert.equal(row(facts, "config").reveal, false);
    assert.equal(row(facts, "hooks").reveal, false);
    assert.equal(row(facts, "project").reveal, true);
    assert.equal(row(facts, "storage").reveal, true);

    // 配置摘要说了这个项目现在是哪一种历史；文件在，这一行才是事实。
    await configureProject(root, { historyMode: "isolated" });
    await mkdir(path.dirname(hookActionsPath(root)), { recursive: true });
    await writeFile(hookActionsPath(root), "[]\n");
    const configured = await aboutFacts(root, options());
    assert.deepEqual(configured.rows.map((entry) => entry.key), ["extension", "editor", "cli", "core", "project", "config", "hooks", "history", "logs", "storage"], "配置写过之后，历史这一行才是事实");
    assert.equal(row(configured, "history").value, historyLabel("isolated"), "历史那两个词是 core 的，不是插件编的");
    assert.equal(row(configured, "history").reveal, false, "历史是一句话，不是一个可打开的文件");
    assert.equal(row(configured, "config").reveal, true);
    assert.equal(row(configured, "hooks").reveal, true);
    assert.equal(row(configured, "config").value, runtimePaths(root).runtimeFile, "值一直只是路径");

    // 版本探不到就是不编一个：那一行说没检测到，而不是留空。
    const missing = await aboutFacts(root, options({ cliVersion: null }));
    assert.equal(row(missing, "cli").value, TEXT["about.not-detected"].en);

    // 打开 VS Code 设置那一行的查询由宿主拼：@ext: 从来不在载荷里。
    assert.equal(facts.settings.label, TEXT["about.vscode-settings"].en);
    assert.equal(JSON.stringify(facts).includes("@ext:"), false, "页面拿不到那个查询字符串");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a Chinese editor reads the same page in Chinese, and the paths stay paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-about-zh-"));
  try {
    const en = await aboutFacts(root, options());
    const zh = await aboutFacts(root, options({ language: "zh-cn" }));
    for (const entry of zh.rows) assert.match(entry.label, HAS_CJK, `${entry.key} 的标签在中文编辑器里要是中文`);
    // 事实不分语言：路径与版本两半一模一样。
    for (const key of ["extension", "editor", "cli", "core", "project", "config", "hooks", "storage"]) {
      assert.equal(row(zh, key).value, row(en, key).value, `${key} 不是一句可翻译的话`);
    }
    assert.match(row(zh, "logs").value, HAS_CJK, "「日志在哪里」是一句话，中文编辑器里说中文");
    assert.match(zh.settings.label, HAS_CJK);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("no project says so, and offers nothing it cannot show", async () => {
  await mkdir(STORAGE, { recursive: true });
  const facts = await aboutFacts(null, options());
  assert.deepEqual(facts.rows.map((entry) => entry.key), ["extension", "editor", "cli", "core", "project", "logs", "storage"]);
  assert.equal(row(facts, "project").value, TEXT["about.no-project"].en);
  assert.equal(row(facts, "project").reveal, false, "没有项目就没有可显示的东西");
  // 只有存储那一行是「这台机器/这个配置文件」的事，没有项目也真实存在。
  for (const entry of facts.rows) assert.equal(entry.reveal, entry.key === "storage", `${entry.key} 不该可点`);

  // 还没配置的项目：历史那一行不是「Shared」，而是根本不存在 —— 没写过的东西不猜。
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-about-fresh-"));
  try {
    const fresh = await aboutFacts(root, options());
    assert.equal(fresh.rows.some((entry) => entry.key === "history"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a row's key resolves to a path the host knows, never to anything the page names", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-about-key-"));
  try {
    const facts = await aboutFacts(root, options());
    assert.equal(aboutFileFor(root, "config", STORAGE), runtimePaths(root).runtimeFile);
    assert.equal(aboutFileFor(root, "hooks", STORAGE), hookActionsPath(root));
    assert.equal(aboutFileFor(root, "project", STORAGE), root);
    assert.equal(aboutFileFor(root, "storage", STORAGE), STORAGE);
    // 有路径的行才可点，而且能点的行一定解析得出路径。
    assert.equal(aboutFileFor(root, "extension", STORAGE), null, "版本那一行没有可打开的路径");
    assert.equal(aboutFileFor(root, "history", STORAGE), null);
    assert.equal(aboutFileFor(root, "../../etc/passwd", STORAGE), null, "页面递来的键只是一个键");
    assert.equal(aboutFileFor(root, "", STORAGE), null);
    // 可点 ⇒ 解析得出；反过来不一定：路径知道，只是盘上还没有那个文件，那时没有可打开
    // 的东西，所以那一行不可点（坏控件是 0）。
    for (const entry of facts.rows) {
      if (entry.reveal) assert.notEqual(aboutFileFor(root, entry.key, STORAGE), null, `${entry.key} 说可点就要解析得出路径`);
    }
    assert.equal(row(facts, "config").reveal, false);
    assert.notEqual(aboutFileFor(root, "config", STORAGE), null);
    assert.equal(aboutFileFor(null, "config", STORAGE), null, "没有项目就没有这个项目的文件");
    assert.equal(aboutFileFor(null, "storage", STORAGE), STORAGE, "存储是配置文件级的，与项目无关");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("core's version is the one core ships, not a number this package remembers", async () => {
  const corePackage = JSON.parse(await readFile(path.join(pkgDir, "..", "core", "package.json"), "utf8")) as { version: string };
  assert.equal(CORE_VERSION, corePackage.version, "core 是被打进扩展里的：它的版本只能在这里对住，漂了就要红");
  const manifest = JSON.parse(await readFile(path.join(pkgDir, "package.json"), "utf8")) as { version: string; publisher: string; name: string; repository: { url: string } };
  assert.equal(MANIFEST.version, manifest.version);
  assert.equal(MANIFEST.id, `${manifest.publisher}.${manifest.name}`, "清单里的那个 id 就是设置页那一行的 @ext: 查询");
  // 文档那一行指着的必须是真地址：仓库自己的地址，去掉 git 的后缀。
  assert.equal(DOCS_URL, manifest.repository.url.replace(/\.git$/, ""));
  assert.match(DOCS_URL, /^https:\/\/github\.com\//, "不是开发机上的某条路径");
});
