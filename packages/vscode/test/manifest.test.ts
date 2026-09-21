import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DASHBOARD_VIEW_ID } from "../src/views/view-ids.ts";

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

// 视图 id 只能有一个来源。清单、注册、菜单 when 各写一遍字面量时，它们会在原地升级
// 那一刻分叉：工作台按新清单要一个 id，还在跑的旧代码注册的是另一个——用户拿到的就是
// VS Code 自己的 "No view is registered with id: …"，一句话里既没有原因也没有动作。
test("the dashboard view id has one source, and the manifest spells it the same", async () => {
  const manifest = JSON.parse(await readFile(path.join(pkgDir, "package.json"), "utf8"));
  const views = manifest.contributes.views.avenic as Array<{ id: string }>;
  assert.equal(views.length, 1, "活动栏里只该有一行入口");
  assert.equal(views[0]!.id, DASHBOARD_VIEW_ID);

  const titles = manifest.contributes.menus["view/title"] as Array<{ command: string; when: string }>;
  assert.ok(titles.length >= 3, `标题栏按钮的 when 也要落在同一个 id 上，实际 ${titles.length} 条`);
  for (const entry of titles) assert.equal(entry.when, `view == ${DASHBOARD_VIEW_ID}`, entry.command);

  // 反方向：全仓只有 id 模块自己写着这个字面量，别处一律读常量。
  const offenders: string[] = [];
  const dir = path.join(pkgDir, "src");
  const walk = async (at: string): Promise<void> => {
    for (const entry of await readdir(at, { withFileTypes: true })) {
      const file = path.join(at, entry.name);
      if (entry.isDirectory()) { await walk(file); continue; }
      if (!entry.name.endsWith(".ts") || entry.name === "view-ids.ts") continue;
      const source = await readFile(file, "utf8");
      if (source.includes(`"${DASHBOARD_VIEW_ID}"`) || source.includes(`'${DASHBOARD_VIEW_ID}'`)) offenders.push(path.relative(pkgDir, file));
    }
  };
  await walk(dir);
  assert.deepEqual(offenders, [], `这些文件把视图 id 又写了一遍，应改读 DASHBOARD_VIEW_ID`);
  const extension = await readFile(path.join(dir, "extension.ts"), "utf8");
  assert.match(extension, /createTreeView\(\s*DASHBOARD_VIEW_ID/, "注册用的就是那个常量");
});

// 挂 provider 要排在激活体里所有可能失败的事情之前：它前面任何一步抛错，用户看到的就是
// 活动栏里那一行变成 VS Code 的一句话。挂载失败也不得 return——仪表盘面板不依赖这棵树，
// 命令注册是用户唯一还能用上它的路。顺序与保护都落在源码里，所以从源码里查。
test("the launcher provider is mounted before anything else that can fail, and the rest is guarded", async () => {
  const source = await readFile(path.join(pkgDir, "src", "extension.ts"), "utf8");
  const body = source.slice(source.indexOf("export function activate"));
  assert.ok(body.startsWith("export function activate"), "extension.ts 里找不到 activate");
  const at = (needle: string, text = source): number => {
    const index = text.indexOf(needle);
    assert.notEqual(index, -1, `extension.ts 里找不到 ${needle}`);
    return index;
  };
  const mounted = at("mountLauncher(context, launcher)", body);
  // 挂载之前只允许放不需要等待、也抛不出来的东西（常量、new LauncherView）。多一步
  // createOutputChannel / createWebviewPanel / 一次读盘，就多一个能把入口行变没的失败点。
  const prefix = body.slice(0, mounted);
  assert.doesNotMatch(prefix, /\b(register\w*|createOutputChannel|createWebviewPanel|createTreeView|readFile|await)\s*\(/, "挂载之前不许有能失败或要等的事情");
  assert.doesNotMatch(prefix, /\bnew\s+ActivityLog\s*\(/);
  // 壳体（活动日志、四组命令、旧 id 别名、版本探测）全在挂载之后，且整段受保护。
  assert.ok(mounted < at("startShell(context, launcher", body), "壳体排在挂载之后");
  assert.match(source, /try \{\s*const failureUi = startShell\(/, "壳体整段在 try 里");
  assert.match(source, /catch \(error\) \{[\s\S]*?reportFailure\(STARTUP_FAILED/, "壳体失败报到用户面前");
  // 挂载自己：用唯一常量、受保护、失败返回原因而不是抛。
  assert.match(source, /function mountLauncher[\s\S]*?try \{[\s\S]*?createTreeView\(DASHBOARD_VIEW_ID/, "挂载用常量且受保护");
  assert.match(source, /catch \(error\) \{[\s\S]*?return error;/, "挂载失败返回原因而不是抛");
  assert.match(source, /if \(viewError !== null\) void reportDashboardFailure\(viewError/, "挂不上时说 Avenic 自己那句话");
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
