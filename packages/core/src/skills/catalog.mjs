import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fail } from "../util/fail.mjs";
import { readJson } from "../util/json.mjs";
import { git, gitFailure, normalizeRepositoryInput, repositoryIdentity } from "./git.mjs";
import { loadPacks } from "./packs.mjs";
import { shortTimestamp } from "../util/stamp.mjs";
import { catalogCacheRoot, defaultCatalogFile, deprecatedEnvironmentValue, knownCatalogsFile } from "./paths.mjs";

const DEFAULT_CATALOG_SPEC = "Echo-Kang-hub/SkillsHub#main";

export function parseCatalogSpec(spec) {
  if (typeof spec !== "string" || spec.length === 0) {
    fail(`Invalid catalog spec: ${spec}`);
  }
  const hashIndex = spec.lastIndexOf("#");
  const repository = hashIndex === -1 ? spec : spec.slice(0, hashIndex);
  const ref = hashIndex === -1 ? "main" : spec.slice(hashIndex + 1) || "main";
  return { repository: normalizeRepositoryInput(repository), ref };
}

export async function loadDefaultCatalogSpec(environment = process.env) {
  const catalogSpec = deprecatedEnvironmentValue(environment, "AVENIC_CATALOG_SPEC", "AGENTHOME_CATALOG_SPEC");
  if (catalogSpec) {
    return catalogSpec;
  }
  const file = defaultCatalogFile(environment);
  if (existsSync(file)) {
    const config = await readJson(file);
    if (typeof config.spec === "string" && config.spec.length > 0) {
      return config.spec;
    }
  }
  return DEFAULT_CATALOG_SPEC;
}

export async function setDefaultCatalogSpec(environment = process.env, spec) {
  const file = defaultCatalogFile(environment);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ schemaVersion: 1, spec }, null, 2)}\n`, "utf8");
}

// Short label for a catalog spec: "owner/repo" for remotes, the directory
// name for local paths. Preserves the original spelling for display.
export function catalogDisplayName(spec) {
  const { repository } = parseCatalogSpec(spec);
  if (/^(https?:\/\/|ssh:\/\/)/i.test(repository)) {
    const clean = repository.replace(/\.git$/i, "").replace(/\/+$/, "");
    return clean.split("/").slice(-2).join("/");
  }
  if (/^git@/i.test(repository)) {
    return repository.replace(/\.git$/i, "").split(":").at(-1);
  }
  return repository.split(/[\\/]/).filter(Boolean).at(-1) ?? repository;
}

export async function loadKnownCatalogs(environment = process.env) {
  const file = knownCatalogsFile(environment);
  if (!existsSync(file)) {
    return [];
  }
  const config = await readJson(file);
  const catalogs = Array.isArray(config.catalogs) ? config.catalogs : [];
  return catalogs.filter((entry) => typeof entry.spec === "string" && entry.spec.length > 0);
}

// Record a catalog in the registry (most recently used first, deduplicated by
// spec). The registry drives `catalog select`; the current spec stays in the
// default catalog file.
export async function registerKnownCatalog(environment = process.env, spec) {
  const known = await loadKnownCatalogs(environment);
  const next = [{ name: catalogDisplayName(spec), spec }, ...known.filter((entry) => entry.spec !== spec)];
  const file = knownCatalogsFile(environment);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ schemaVersion: 1, catalogs: next }, null, 2)}\n`, "utf8");
}

// Where one Hub lives in the local cache. Exported because the extension needs
// to read the same directory: re-deriving it from the same slug rule meant a
// change here silently pointed the editor at a directory the CLI never wrote.
export function catalogCacheDirectory(spec, environment = process.env) {
  const { repository } = parseCatalogSpec(spec);
  const identity = repositoryIdentity(repository).replace(/\\/g, "/");
  const parts = identity.split("/").filter(Boolean);
  const owner = parts.at(-2) ?? "catalog";
  const name = parts.at(-1) ?? "catalog";
  const slug = `${owner}-${name}`
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
  return path.join(catalogCacheRoot(environment), slug);
}

export function shortRevision(revision) {
  return typeof revision === "string" ? revision.slice(0, 7) : "";
}

// One line, the same in both front ends: "Synced · a1b2c3d · 2026-09-19 14:03".
export function hubSyncSummary(info, date = new Date()) {
  const when = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  return `Synced · ${shortRevision(info.revision)} · ${shortTimestamp(when)}`;
}

// Filesystem trouble is about this machine, never about the Hub, so it must not
// be reported with the Hub's vocabulary.
const CACHE_FAILURE_CODES = new Set(["EACCES", "EPERM", "EEXIST", "ENOTDIR", "ENOSPC", "EROFS", "EBUSY"]);

// A ref that is a commit names one revision exactly; anything else — a branch, a
// tag — is a name whose current meaning only the remote knows.
function looksLikeRevision(ref) {
  return /^[0-9a-f]{7,40}$/i.test(ref);
}

const sameRevision = (left, right) => left.toLowerCase().startsWith(right.toLowerCase());

// The cache's HEAD is a file. Every sync ends in `checkout --detach`, so it holds
// the revision itself and reading it needs no git at all — which is what lets
// browsing work on a machine with git uninstalled. A symbolic HEAD (someone
// checked out a branch by hand) is not answerable this way.
async function headRevision(directory) {
  try {
    const head = (await readFile(path.join(directory, ".git", "HEAD"), "utf8")).trim();
    return /^[0-9a-f]{40}$/i.test(head) ? head : null;
  } catch {
    return null;
  }
}

/** 缓存里能回答 `ref` 的修订；答不上来（还没克隆过、要的修订不在 checkout 上）返回 null。 */
async function cachedRevision(directory, ref) {
  const head = await headRevision(directory);
  if (head === null || !looksLikeRevision(ref)) return head;
  return sameRevision(head, ref) ? head : null;
}

/**
 * 只读缓存地取一个 Catalog：缓存答不上来就返回 null —— 绝不 clone、绝不 fetch，
 * 也绝不启动 git。展开 Hub、浏览内容树（`avenic skills tree` / `packs`、编辑器里
 * 展开的那棵树）都是读操作，不是联网指令：联网只发生在 `hub add`、`hub sync`
 * 和安装里。缓存按仓库分（同一个 Hub 换个 ref 也共用一份），所以分支名拿到的是
 * 「缓存里当前这一份」；要看最新那一份，先 `avenic hub sync`。
 */
export async function cachedCatalog(spec, environment = process.env) {
  const { repository, ref } = parseCatalogSpec(spec);
  const directory = catalogCacheDirectory(spec, environment);
  const revision = await cachedRevision(directory, ref);
  if (revision === null) return null;
  return {
    catalogRoot: directory,
    repository,
    ref,
    revision,
    shortSha: shortRevision(revision),
    syncedAt: null,
    spec,
  };
}

// 点名的修订在不在本地仓库里。允许跑 git（本地只读），但绝不联网：这正是
// 「锁文件钉住的安装不必再去拉一次」的那一步。
async function pinnedRevision(directory, ref) {
  const head = await headRevision(directory);
  if (head !== null && sameRevision(head, ref)) return head;
  try {
    return await git(["-C", directory, "rev-parse", "--verify", `${ref}^{commit}`]);
  } catch {
    return null;
  }
}

export async function ensureCatalog(spec, options = {}) {
  const environment = options.environment ?? process.env;
  const { repository, ref } = parseCatalogSpec(spec);
  const directory = catalogCacheDirectory(spec, environment);
  try {
    // 缓存优先的另一半：点名的修订已经在本地时，同一个 commit 不必再去拉一次——
    // 锁文件钉住的安装因此不碰网络，拿到的内容也与上次逐字节相同（跨设备可复现）。
    // 分支不同：它今天指向哪个 commit 只有远端知道，所以照旧去问。
    const pinned = looksLikeRevision(ref) ? await pinnedRevision(directory, ref) : null;
    if (pinned !== null) {
      if ((await headRevision(directory)) !== pinned) {
        await git(["-C", directory, "checkout", "--quiet", "--detach", pinned]);
      }
      // syncedAt 是「刚刚同步过」的时间，这里没有同步发生，所以是 null。
      return { catalogRoot: directory, repository, ref, revision: pinned, shortSha: shortRevision(pinned), syncedAt: null, spec };
    }
    if (existsSync(path.join(directory, ".git"))) {
      await git(["-C", directory, "fetch", "--depth", "1", "origin", ref]);
    } else {
      await mkdir(directory, { recursive: true });
      await git(["-C", directory, "init", "--quiet"]);
      await git(["-C", directory, "remote", "add", "origin", repository]);
      await git(["-C", directory, "fetch", "--depth", "1", "origin", ref]);
    }
    await git(["-C", directory, "checkout", "--quiet", "--detach", "FETCH_HEAD"]);
    const revision = await git(["-C", directory, "rev-parse", "HEAD"]);
    return {
      catalogRoot: directory,
      repository,
      ref,
      revision,
      shortSha: shortRevision(revision),
      syncedAt: new Date().toISOString(),
      spec,
    };
  } catch (error) {
    if (CACHE_FAILURE_CODES.has(error?.code) || error?.path === directory || /^E[A-Z]+:/.test(error?.message ?? "")) {
      const blocked = gitFailure("cache-filesystem", {
        detail: `Unable to use the Hub cache directory ${directory}: ${error.message}`,
        hint: "Remove whatever occupies that path, or set AVENIC_STATE_DIR to a writable directory.",
      });
      blocked.cause = error;
      throw blocked;
    }
    if (error?.kind) {
      const wrapped = gitFailure(error.kind, { detail: `${error.message}\nUnable to sync Hub: ${spec}` });
      wrapped.cause = error;
      throw wrapped;
    }
    fail(
      `${error.message}\nUnable to fetch Hub: ${spec}\n` +
      "Check your GitHub authentication (gh auth login, SSH key, or credential helper) and the Hub spec.\n" +
      "To point Avenic at your own Hub: avenic hub add <owner/repo>",
    );
  }
}

// Register a catalog: save the default spec and the known-catalog entry
// first, then try to fetch and preview its Packs. The spec stays configured
// even when the preview fails (offline, missing credentials, no Packs yet).
export async function registerCatalog(spec, options = {}) {
  const io = options.io ?? console;
  parseCatalogSpec(spec);
  await setDefaultCatalogSpec(options.environment, spec);
  await registerKnownCatalog(options.environment, spec);
  try {
    const catalogInfo = await ensureCatalog(spec, { environment: options.environment, io });
    const packs = [...(await loadPacks(catalogInfo.catalogRoot)).values()];
    return { spec, catalogInfo, packs, previewFailed: false };
  } catch (error) {
    return { spec, packs: [], previewFailed: true, error };
  }
}
