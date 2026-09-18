import { build } from "esbuild";
import { readdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";

const testDir = path.resolve("test");
const entryPoints = (await readdir(testDir)).filter((f) => f.endsWith(".test.ts")).map((f) => path.join(testDir, f));
await build({
  bundle: true,
  format: "esm",
  platform: "node",
  outdir: ".test-out",
  entryPoints,
  // 测试不 import vscode；显式声明以防未来误引入时快速失败。esbuild 自身是 CJS + 动态
  // require，bundled 成 ESM 会在运行时炸掉，所以它也必须留作外部依赖。
  external: ["vscode", "esbuild"],
});
// 传显式产物路径而非目录：`node --test <dir>` 在 Node 24（Windows）上会把目录当入口模块执行并报 MODULE_NOT_FOUND
const testFiles = entryPoints.map((f) => path.join(".test-out", path.basename(f).replace(/\.ts$/, ".js")));
execFileSync("node", ["--test", ...testFiles], { stdio: "inherit" });
