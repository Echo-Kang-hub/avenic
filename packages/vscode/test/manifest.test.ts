import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("vscode extension manifest identity", async () => {
  const manifest = JSON.parse(await readFile(path.join(pkgDir, "package.json"), "utf8"));
  assert.equal(manifest.name, "avenic-agent-manager");
  assert.equal(manifest.displayName, "Avenic Agent Manager");
  assert.equal(manifest.main, "./dist/extension.js");
  assert.equal(manifest.type, "module");
  assert.deepEqual(manifest.engines, { vscode: "^1.90.0" });
  assert.equal(manifest.activationEvents, undefined, "1.75+ 由 contributes 自动激活，不写 activationEvents");
});

test("esbuild test runner emits executable tests", async (t) => {
  const bundle = path.join(pkgDir, ".test-out", "manifest.test.js");
  // 本文件会被根仓库 `node --test` 扫描到（Node 24 默认匹配 *.test.ts），那是一次源码运行、
  // 不经由 build-tests.mjs，不代表 .test-out 已构建；仅 bundle 运行时才校验产物存在。
  if (path.basename(path.dirname(fileURLToPath(import.meta.url))) !== ".test-out") {
    t.skip("源码运行：由 build-tests.mjs 打包执行时校验");
    return;
  }
  await stat(bundle); // bundle 运行：esbuild 必须已产出可执行测试
});

// 菜单条目里的 `view == avenic.x` 指向一个已经不存在的视图时，那条绑定就是死的：
// 它不会报错，只是永远不显示。删掉一棵树之后最容易漏的就是这些残留，所以这里从
// 清单自己声明过的视图 id 反推。
test("no menu entry names a view the manifest does not contribute", async () => {
  const manifest = JSON.parse(await readFile(path.join(pkgDir, "package.json"), "utf8"));
  const views = new Set<string>();
  for (const group of Object.values(manifest.contributes.views as Record<string, Array<{ id: string }>>)) {
    for (const view of group) views.add(view.id);
  }
  assert.ok(views.size > 0, "清单必须真的贡献了视图，否则这条测试是空转");
  const menus = (manifest.contributes.menus ?? {}) as Record<string, Array<{ command?: string; when?: string }>>;
  let checked = 0;
  for (const [where, entries] of Object.entries(menus)) {
    for (const entry of entries) {
      for (const m of (entry.when ?? "").matchAll(/view\s*==\s*([A-Za-z][\w.]*)/g)) {
        checked += 1;
        assert.ok(views.has(m[1]!), `${where} 里的 ${entry.command} 绑定到不存在的视图 ${m[1]}`);
      }
    }
  }
  assert.ok(checked >= 3, `只解析到 ${checked} 条视图绑定——正则过期了`);
});

test("active editor window has vscode engine", async () => {
  const manifest = JSON.parse(await readFile(path.join(pkgDir, "package.json"), "utf8"));
  assert.equal(manifest.workspaces, undefined, "不得引入 workspaces 字段");
  assert.equal(manifest.private, true, "防止误发 npm");
});

// 只钉住已知清单是不够的：新加一个 register("…") 而忘了写清单，那种测试照样是绿的。
// 这条从源码里的 register 调用反推（前缀从各文件的 registerCommand 模板里读，不写死），
// 两个方向都查：注册了的必须声明，声明了的必须真有人注册。
test("registered commands and the manifest declare the same set", async () => {
  const manifest = JSON.parse(await readFile(path.join(pkgDir, "package.json"), "utf8"));
  const declared: string[] = manifest.contributes.commands.map((entry: { command: string }) => entry.command);
  const dir = path.join(pkgDir, "src", "commands");
  const registered = new Set<string>();
  for (const file of await readdir(dir)) {
    if (!file.endsWith(".ts")) continue;
    const source = await readFile(path.join(dir, file), "utf8");
    const prefix = source.match(/registerCommand\(`([^`$]*)\$\{id\}/)?.[1] ?? "";
    for (const m of source.matchAll(/\bregister\("([^"]+)"/g)) registered.add(`${prefix}${m[1]!}`);
  }
  assert.ok(registered.size > 10, `只解析到 ${registered.size} 个 register 调用——正则过期了`);
  for (const id of registered) assert.ok(declared.includes(id), `registerCommand 了未声明的命令 ${id}`);
  for (const id of declared) assert.ok(registered.has(id), `清单声明了 ${id}，但没有任何 register 实现它`);
});
