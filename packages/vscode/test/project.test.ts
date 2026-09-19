import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PROJECT_ROOT_STATE_KEY, lastProjectRoot, projectRootForActiveEditor, rememberProjectRoot, rememberedProjectRoot, resolveProjectRoot, sameRootPath } from "../src/project.ts";

function fakeState() {
  const data = new Map<string, unknown>();
  return {
    data,
    get(key: string) { return data.get(key); },
    update(key: string, value: unknown) { data.set(key, value); return Promise.resolve(); },
  };
}

test("single workspace folder resolves to its fsPath", () => {
  assert.equal(resolveProjectRoot([{ uri: { fsPath: "C:/proj" } }]), "C:/proj");
});

test("no folders returns null", () => {
  assert.equal(resolveProjectRoot([]), null);
});

test("multi-root returns null (caller must pick)", () => {
  assert.equal(resolveProjectRoot([{ uri: { fsPath: "C:/a" } }, { uri: { fsPath: "C:/b" } }]), null);
});

// 配置命令落在用户选中的那个文件夹上，不会顺着仓库往上飘（与 `avenic init` 同一条规则：
// 初始化的是当前目录，不是 git 根）。这条用例只有在有人给解析链加上 git 根提升时才会红。
test("a folder nested in a git repository is never promoted to the repository root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-git-subdir-"));
  try {
    const nested = path.join(root, "packages", "app");
    await mkdir(nested, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: root });
    const folders = [{ uri: { fsPath: nested } }];
    assert.equal(resolveProjectRoot(folders), nested);
    assert.equal(projectRootForActiveEditor(folders, path.join(nested, "src", "index.ts")), nested);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("remember/last round-trips through state", () => {
  const state = fakeState();
  assert.equal(lastProjectRoot(state), null);
  rememberProjectRoot(state, "C:/proj");
  assert.equal(lastProjectRoot(state), "C:/proj");
});

test("remembered root returns the folder when memory matches a live folder", () => {
  const state = fakeState();
  rememberProjectRoot(state, "C:/b");
  const folders = [{ uri: { fsPath: "C:/a" } }, { uri: { fsPath: "C:/b" } }];
  assert.equal(rememberedProjectRoot(folders, state), "C:/b");
});

test("remembered root returns null for stale memory not in live folders", () => {
  const state = fakeState();
  rememberProjectRoot(state, "C:/gone");
  assert.equal(rememberedProjectRoot([{ uri: { fsPath: "C:/a" } }], state), null);
});

test("remembered root returns null with no memory", () => {
  const state = fakeState();
  assert.equal(rememberedProjectRoot([{ uri: { fsPath: "C:/a" } }, { uri: { fsPath: "C:/b" } }], state), null);
});

test("state key is stable", () => {
  assert.equal(PROJECT_ROOT_STATE_KEY, "avenic.projectRoot");
});

test("sameRootPath compares case-insensitively on win32", () => {
  assert.equal(sameRootPath("C:/Proj", "c:/proj", "win32"), true);
  assert.equal(sameRootPath("C:/a", "C:/b", "win32"), false);
});

test("sameRootPath compares exactly on non-win32 platforms", () => {
  assert.equal(sameRootPath("/alpha/proj", "/alpha/PROJ", "linux"), false);
  assert.equal(sameRootPath("/alpha/proj", "/alpha/proj", "darwin"), true);
});

test("projectRootForActiveEditor picks the folder that owns the active editor", () => {
  const folders = [{ uri: { fsPath: "/work/a" } }, { uri: { fsPath: "/work/b" } }];
  assert.equal(projectRootForActiveEditor(folders, "/work/b/src/index.ts"), "/work/b");
  assert.equal(projectRootForActiveEditor(folders, "/elsewhere/file.ts"), null);
  assert.equal(projectRootForActiveEditor(folders, undefined), null);
});

// 归属判定用 core 的 isInside（path.relative）：尾分隔符根与文件系统根都算命中。
// 手写前缀比较在这两种根上会漏判——根后面的第一个字符属于下一级路径名，不是分隔符。
test("projectRootForActiveEditor accepts roots that end in a separator", () => {
  assert.equal(projectRootForActiveEditor([{ uri: { fsPath: "/work/b/" } }], "/work/b/src/x.ts"), "/work/b/");
  assert.equal(projectRootForActiveEditor([{ uri: { fsPath: "/" } }], "/work/b/x.ts"), "/");
});

// win32 的大小写不敏感来自宿主路径语义（path.win32.relative），不能在别的平台上注入复现。
test("projectRootForActiveEditor matches case-insensitively on Windows", { skip: process.platform !== "win32" }, () => {
  assert.equal(projectRootForActiveEditor([{ uri: { fsPath: "C:\\work\\A" } }], "c:\\work\\a\\src\\x.ts"), "C:\\work\\A");
  assert.equal(projectRootForActiveEditor([{ uri: { fsPath: "C:\\" } }], "C:\\work\\x.ts"), "C:\\");
  assert.equal(projectRootForActiveEditor([{ uri: { fsPath: "C:\\work\\A" } }], "C:\\work\\A"), "C:\\work\\A");
});

test("projectRootForActiveEditor prefers the longest matching root and never guesses", () => {
  const nested = [{ uri: { fsPath: "/work" } }, { uri: { fsPath: "/work/b" } }];
  assert.equal(projectRootForActiveEditor(nested, "/work/b/src/x.ts"), "/work/b");
  // 文件恰好等于根（无分隔符后缀）也算命中；仅前缀相同的兄弟目录不算
  assert.equal(projectRootForActiveEditor([{ uri: { fsPath: "/work/b" } }], "/work/b"), "/work/b");
  assert.equal(projectRootForActiveEditor([{ uri: { fsPath: "/work/b" } }], "/work/bc/x.ts"), null);
  assert.equal(projectRootForActiveEditor([], "/work/b/x.ts"), null);
});
