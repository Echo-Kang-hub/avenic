import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { add, defaultSpec, listKnown, packStructure, packsFor, select, sync } from "../src/services/catalog.ts";
import { makeCatalogFixture, testEnv } from "./helpers.ts";

test("catalog add → select → sync round-trip with local fixture", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-catalog-"));
  try {
    const catalogDir = path.join(root, "catalog");
    const env = testEnv(path.join(root, "state"));
    await makeCatalogFixture(catalogDir);
    const added = await add(catalogDir, env);
    assert.equal(added.previewFailed, false);
    assert.equal(added.packs.some((p) => p.id === "common"), true);
    const known = await listKnown(env);
    assert.equal(known.filter((k) => k.spec === catalogDir).length, 1);
    await select(catalogDir, env);
    // select 后默认 Catalog 指向 fixture（core 原样持久化 spec，本地路径不做 URL 化）
    assert.equal(await defaultSpec(env), catalogDir);
    const info = await sync(catalogDir, env);
    assert.match(info.revision, /^[0-9a-f]{40}$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("packsFor previews the packs of a catalog spec (read-only view data)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-catalog-"));
  try {
    const catalogDir = path.join(root, "catalog");
    const env = testEnv(path.join(root, "state"));
    await makeCatalogFixture(catalogDir);
    const packs = await packsFor(catalogDir, env);
    assert.ok(packs !== null, "Catalog 树展开须拿到 Pack 列表");
    assert.deepEqual([...packs.keys()].sort(), ["common", "extra"]);
    assert.deepEqual(packs.get("common")?.sources.flatMap((s) => s.skills), ["alpha"]);
    assert.deepEqual(packs.get("extra")?.sources.flatMap((s) => s.skills), ["beta"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cache-only catalog preview never fetches a newly registered local Hub", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-catalog-"));
  try {
    const catalogDir = path.join(root, "catalog");
    const env = testEnv(path.join(root, "state"));
    await makeCatalogFixture(catalogDir);
    // The cache directory is intentionally absent: rendering a tree must not
    // synchronously clone/fetch merely because a user expands the Hub row.
    const cacheOnly = packsFor as unknown as (spec: string, environment: NodeJS.ProcessEnv, options: { cachedOnly: boolean }) => ReturnType<typeof packsFor>;
    assert.equal(await cacheOnly(catalogDir, env, { cachedOnly: true }), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("packStructure resolves the source-grouped skill layers of a pack (cache-first)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-catalog-"));
  try {
    const catalogDir = path.join(root, "catalog");
    const env = testEnv(path.join(root, "state"));
    await makeCatalogFixture(catalogDir);
    await select(catalogDir, env);
    await sync(catalogDir, env); // 先同步保证缓存（packStructure 只读，绝不做 fetch）
    const structure = await packStructure(catalogDir, "extra", env);
    assert.ok(structure !== null);
    assert.deepEqual(structure.names, ["beta"]);
    assert.equal(structure.groups.length, 1);
    assert.equal(structure.groups[0].source.id, "demo");
    assert.equal(structure.groups[0].source.name, "Demo");
    assert.deepEqual(structure.groups[0].skills.map((s) => s.name), ["beta"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("manifest registers the five catalog command ids with pack-row and title menus", async () => {
  const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = JSON.parse(await readFile(path.join(pkgDir, "package.json"), "utf8"));
  const ids = manifest.contributes?.commands ?? [];
  for (const id of ["avenic.catalog.add", "avenic.catalog.select", "avenic.catalog.default", "avenic.catalog.sync", "avenic.catalog.installPack"]) {
    assert.ok(ids.some((c: { command: string }) => c.command === id), id);
  }
  // installPack：Catalog 树 Pack 行右键 + 悬停 inline 键
  const contextMenus: Array<{ command: string; when: string; group?: string }> = manifest.contributes?.menus?.["view/item/context"] ?? [];
  const packBinding = "view == avenic.catalog && viewItem == catalog-pack";
  assert.ok(contextMenus.some((m) => m.command === "avenic.catalog.installPack" && m.when === packBinding && m.group === "inline@1"), "pack 行悬停键位");
  assert.ok(contextMenus.some((m) => m.command === "avenic.catalog.installPack" && m.when === packBinding && m.group === undefined), "pack 行右键菜单");
  // Catalog 标题栏三键位
  const titleMenus: Array<{ command: string; when: string }> = manifest.contributes?.menus?.["view/title"] ?? [];
  for (const id of ["avenic.catalog.add", "avenic.catalog.select", "avenic.catalog.sync"]) {
    assert.ok(titleMenus.some((m) => m.command === id && m.when === "view == avenic.catalog"), id);
  }
});
