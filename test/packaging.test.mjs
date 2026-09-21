import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// pacote's git-dependency preparation (pacote/lib/git.js, #prepareDir) runs a nested
// `npm install` inside the freshly extracted clone whenever the installed manifest has
// a `workspaces` field or any install-lifecycle script. On Windows that nested reify
// renames the clone directory while the global install links to it, racing away files
// and leaving `npm install -g <owner/repo>` broken (agent: MODULE_NOT_FOUND). This
// package has zero runtime dependencies, so the nested install is never needed.
const PREPARE_TRIGGERS = ["postinstall", "build", "preinstall", "install", "prepack", "prepare"];

test("root manifest must not trigger pacote git-dependency preparation", async () => {
  const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  assert.equal(manifest.workspaces, undefined, "a workspaces field triggers a nested npm install during git installs");
  for (const script of PREPARE_TRIGGERS) {
    assert.equal(
      manifest.scripts?.[script],
      undefined,
      `a "${script}" script triggers a nested npm install during git installs`,
    );
  }
});

// The CLI ships exactly two bins. Single-word names are collision-free in
// PowerShell, cmd.exe, Git Bash, bash, and zsh; earlier `ac` collided with
// PowerShell's built-in Add-Content alias (`ac init` executed as
// `Add-Content -Path init` and prompted interactively for -Value).
test("published bin names avoid shell collisions", async () => {
  const manifest = JSON.parse(await readFile(path.join(packageRoot, "packages", "cli", "package.json"), "utf8"));
  assert.deepEqual(
    Object.keys(manifest.bin).sort(),
    ["ave", "avenic"],
  );
});

test("core manifest is configured for public publishing", async () => {
  const manifest = JSON.parse(await readFile(path.join(packageRoot, "packages", "core", "package.json"), "utf8"));
  assert.equal(manifest.name, "@avenic/core");
  assert.equal(manifest.private, undefined);
  assert.equal(manifest.license, "MIT");
  // 版本号只校验形状：把具体版本写进测试，等于让每次发版都顺手改一次断言，
  // 而真正要守的不变量是「发布用的 manifest 带着一个正常的 semver」。
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(manifest.files, ["src/", "index.d.ts", "LICENSE"]);
  assert.equal(manifest.exports["."].types, "./index.d.ts");
  assert.equal(manifest.exports["."].import, "./src/index.mjs");
  assert.equal(manifest.types, "./index.d.ts");
  assert.deepEqual(manifest.engines, { node: ">=18.17" });
});

// 手写名单会随删除而腐烂（模型库删除后这里还留着 TOGGLE_KEYS/probeUrl），
// 所以改成从扩展源码反推：扩展真正 import 的每个名字，声明文件必须都有。
// 扩展的类型检查（tsc）是同一件事的另一半，但那条只在扩展目录里跑得到；
// 这一条在仓库根就能拦住「core 删了导出、扩展还在 import」。
test("core type declarations cover the extension contract", async () => {
  const dts = await readFile(path.join(packageRoot, "packages", "core", "index.d.ts"), "utf8");
  const src = path.join(packageRoot, "packages", "vscode", "src");
  const imported = new Set();
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(file); continue; }
      if (!entry.name.endsWith(".ts")) continue;
      const source = await readFile(file, "utf8");
      for (const block of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"@avenic\/core"/g)) {
        for (const raw of block[1].split(",")) {
          const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
          if (name) imported.add(name);
        }
      }
    }
  };
  await walk(src);
  assert.ok(imported.size > 40, `只解析到 ${imported.size} 个 @avenic/core 导入——正则过期了`);
  for (const name of imported) assert.match(dts, new RegExp(`\\b${name}\\b`), name);
});

test("root manifest carries the internal avenic-repo identity", async () => {
  const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  assert.equal(manifest.name, "avenic-repo");
  assert.equal(manifest.version, "1.1.0");
  assert.deepEqual(Object.keys(manifest.bin).sort(), ["ave", "avenic"]);
  assert.equal(manifest.repository.url, "git+https://github.com/Echo-Kang-hub/avenic.git");
});
