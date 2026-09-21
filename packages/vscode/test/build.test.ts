import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { extensionBuildOptions } from "../build-options.mjs";
import { LEGACY_COMMAND_ALIASES } from "../src/views/legacy.ts";

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The artifact, not the sources: everything else in this suite imports src/,
// so nothing else would notice a bundle that fails to load. Both tests below
// build it the way `npm run build` builds it — from the same options — into a
// temporary directory, so they neither depend on a previous build nor race the
// packaging test that rewrites dist/.
let artifact: Promise<{ js: string; activated: { commands: string[]; subscriptions: number } }> | null = null;
let artifactDirectory: string | null = null;

after(async () => {
  if (artifactDirectory) await rm(artifactDirectory, { recursive: true, force: true });
});

function builtArtifact() {
  artifact ??= buildArtifact();
  return artifact;
}

async function buildArtifact() {
  const out = await mkdtemp(path.join(os.tmpdir(), "avenic-bundle-"));
  artifactDirectory = out;
  const outfile = path.join(out, "extension.js");
  await build(extensionBuildOptions({ directory: pkgDir, outfile }));
  const js = await readFile(outfile, "utf8");

  // Activating the bundle needs a `vscode` module. The editor supplies one at
  // install time; here a stub stands in for it, and the alias replaces the
  // bundle's import with that stub. What comes back is the artifact's own
  // command registry.
  const loader = path.join(out, "activate.mjs");
  await writeFile(loader, [
    `import { activate } from ${JSON.stringify(outfile)};`,
    `import { registered, Uri, ExtensionMode } from "vscode";`,
    `const state = { get: () => undefined, update: async () => {}, keys: () => [] };`,
    `const context = {`,
    `  subscriptions: [],`,
    `  extensionUri: Uri.file(${JSON.stringify(pkgDir)}),`,
    `  extensionPath: ${JSON.stringify(pkgDir)},`,
    `  globalState: state, workspaceState: { get: () => undefined, update: async () => {}, keys: () => [] },`,
    `  secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },`,
    `  environmentVariableCollection: {},`,
    `  extensionMode: ExtensionMode.Test,`,
    `  asAbsolutePath: (value) => value,`,
    `  logPath: ${JSON.stringify(out)},`,
    `};`,
    `activate(context);`,
    `process.stdout.write(JSON.stringify({ commands: [...registered.keys()], subscriptions: context.subscriptions.length }));`,
    "",
  ].join("\n"));
  const activation = path.join(out, "activated.mjs");
  await build({
    ...extensionBuildOptions({ directory: pkgDir, outfile: activation }),
    entryPoints: [loader],
    // 别名要生效，vscode 就不能是 external——external 的导入 esbuild 原样保留，
    // 于是产物会带着一个运行时解析不了的 bare import。
    external: [],
    alias: { vscode: path.join(pkgDir, "test", "fixtures", "vscode-stub.mjs") },
    logLevel: "silent",
  });
  const stdout = execFileSync(process.execPath, [activation], { encoding: "utf8" });
  return { js, activated: JSON.parse(stdout) };
}

test("the production bundle carries core", async () => {
  const { js } = await builtArtifact();
  assert.ok(js.includes("avenic"), "bundle 应含 core 逻辑");
});

// 清单与注册必须两边都对得上：声明了没人注册 = 一个点了就报「命令不存在」的面板项，
// 注册了没声明 = 用户永远够不到。命令 id 由模板串拼出（`avenic.model.${id}`），所以
// 只能问运行中的注册表，不能拿清单里的字符串去 grep 产物。
test("the bundle activates and registers exactly what the manifest declares", async () => {
  const manifest = JSON.parse(await readFile(path.join(pkgDir, "package.json"), "utf8"));
  const declared: string[] = manifest.contributes.commands.map((entry: { command: string }) => entry.command);
  const { activated } = await builtArtifact();
  assert.equal(activated.subscriptions > 0, true, "激活必须挂上订阅，否则命令随激活对象一起被回收");
  // 旧 id 的别名是有意注册的：它们不进清单（命令面板里不该再出现旧名字），所以允许集合
  // 是「清单声明 + 那张常量表」。表里每一条都指向清单里真有的命令，由
  // dashboard-open.test.ts 反查——这里只保证它没变成一条偷偷注册别的东西的后门。
  const allowed = new Set([...declared, ...Object.keys(LEGACY_COMMAND_ALIASES)]);
  for (const id of declared) assert.ok(activated.commands.includes(id), `清单声明了 ${id}，但产物没有注册`);
  for (const id of activated.commands) assert.ok(allowed.has(id), `产物注册了未声明的命令 ${id}`);
});

test("vsce package produces a VSIX via npm script", async () => {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  // Windows: Node >=20.12 拒绝对 .cmd 直接 spawnSync（CVE-2024-27980 缓解），需经 shell 执行
  execFileSync(npm, ["--prefix", pkgDir, "run", "package"], { stdio: "inherit", shell: process.platform === "win32" });
  const info = await stat(path.join(pkgDir, "dist", "avenic-agent-manager.vsix"));
  assert.ok(info.size > 0, "VSIX 应已产出");
});
