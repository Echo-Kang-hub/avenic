import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
  assert.equal(manifest.version, "1.4.2");
  assert.deepEqual(manifest.files, ["src/", "index.d.ts", "LICENSE"]);
  assert.equal(manifest.exports["."].types, "./index.d.ts");
  assert.equal(manifest.exports["."].import, "./src/index.mjs");
  assert.equal(manifest.types, "./index.d.ts");
  assert.deepEqual(manifest.engines, { node: ">=18.17" });
});

test("core type declarations cover the extension contract", async () => {
  const dts = await readFile(path.join(packageRoot, "packages", "core", "index.d.ts"), "utf8");
  for (const name of [
    "AGENTS", "getAgent", "agentExecutableAvailable",
    "initializeAgent", "deinitializeAgent", "setLocalAuth", "clearLocalAuth",
    "effectiveAgentConfig", "loadRuntime", "getSessionAdapter", "spawnExecutableSync",
    "createInstallContext", "installedPackIds", "installPacks", "uninstallPacks",
    "skillsInstallationStatus", "resolveInstallSource", "addDirectSkills", "removeExternalSkills",
    "readDirectState", "loadKnownCatalogs", "setDefaultCatalogSpec", "loadDefaultCatalogSpec",
    "registerCatalog", "ensureCatalog", "buildCatalog", "loadPacks", "resolvePacks",
    "cloneHead", "detectSkillRoot", "discoverSourceSkills", "locateProjectRoot",
    // 扩展面板直接依赖的三个导出：开关清单/开关落点表（面板显示「实际写入的键名」）与
    // 测试请求地址解析（「将请求：<地址>」实时预览）。缺任何一个，面板就只能自己抄一份
    // 业务逻辑，而设计 §9.7 禁止那样做。
    "TOGGLE_KEYS", "TOGGLE_ENTRIES", "probeUrl",
  ]) {
    assert.match(dts, new RegExp(`\\b${name}\\b`), name);
  }
});

test("root manifest carries the internal avenic-repo identity", async () => {
  const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  assert.equal(manifest.name, "avenic-repo");
  assert.equal(manifest.version, "1.1.0");
  assert.deepEqual(Object.keys(manifest.bin).sort(), ["ave", "avenic"]);
  assert.equal(manifest.repository.url, "git+https://github.com/Echo-Kang-hub/avenic.git");
});
