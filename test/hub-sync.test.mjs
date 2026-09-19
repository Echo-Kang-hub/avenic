import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ensureCatalog, hubSyncSummary } from "../packages/core/src/skills/catalog.mjs";
import { catalogCacheDirectory } from "../packages/core/src/index.mjs";
import { classifyGitFailure, gitExecutable } from "../packages/core/src/skills/git.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliBin = path.join(packageRoot, "packages", "cli", "scripts", "skills.mjs");

function gitQuiet(cwd, argumentsList) {
  const result = spawnSync("git", ["-C", cwd, ...argumentsList], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function fixtureHub(root) {
  await mkdir(path.join(root, "skills", "s"), { recursive: true });
  await mkdir(path.join(root, "packs"), { recursive: true });
  await writeFile(path.join(root, "skills", "s", "SKILL.md"), "---\nname: s\n---\nv1\n");
  await writeFile(path.join(root, "packs", "common.json"), `${JSON.stringify({ schemaVersion: 1, id: "common", name: "Common", sources: [{ source: "s-source", skills: ["s"] }] })}\n`);
  await writeFile(path.join(root, "sources.lock.json"), `${JSON.stringify({ schemaVersion: 1, sources: [] })}\n`);
  gitQuiet(root, ["init", "--quiet", "-b", "main"]);
  gitQuiet(root, ["add", "-A"]);
  gitQuiet(root, ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "--quiet", "-m", "one"]);
}

async function withTemp(prefix, run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// ---- 一个真能被解析的 Hub（本文件后半段的 fixture） ----
// `fixtureHub` 上面那个只够让 ensureCatalog 克隆下来；Pack 解析、安装、status 都
// 要先 buildCatalog，所以那几件事的测试需要来源 + 它发布的 Skill + 引用它们的
// Pack。内容全部虚构，凭据从不进入 fixture，也永远不会碰真的 GitHub。

/** 一个 Pack 文件：`skills` 是它引用的名字，可以故意写 Hub 里没有的。 */
async function writePack(root, id, skills, name = id) {
  await mkdir(path.join(root, "packs"), { recursive: true });
  await writeFile(
    path.join(root, "packs", `${id}.json`),
    `${JSON.stringify({ schemaVersion: 1, id, name, sources: [{ source: "s-source", skills }] }, null, 2)}\n`,
  );
}

/** Hub 内容：一个来源、它发布的 Skill、引用它们的 Pack。 */
async function publishHub(root, { skills = ["s"], packs = { common: ["s"] } } = {}) {
  await mkdir(root, { recursive: true });
  await writeFile(
    path.join(root, "sources.lock.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      sources: [{
        id: "s-source",
        name: "S Source",
        repository: "https://github.com/example/s.git",
        skillRoot: "skills",
        revision: "a".repeat(40),
      }],
    }, null, 2)}\n`,
  );
  for (const skill of skills) {
    await mkdir(path.join(root, "skills", "s-source", skill), { recursive: true });
    await writeFile(path.join(root, "skills", "s-source", skill, "SKILL.md"), `---\nname: ${skill}\n---\n`);
  }
  for (const [id, names] of Object.entries(packs)) {
    await writePack(root, id, names);
  }
}

/** 建一个全新的 Hub 仓库，返回它的第一个修订。 */
async function initHub(root) {
  gitQuiet(root, ["init", "--quiet", "-b", "main"]);
  return commitHub(root, "one");
}

/** 提交 Hub 的当前内容并返回新修订（没有改动时不要调用：git 会拒绝空提交）。 */
function commitHub(root, message) {
  gitQuiet(root, ["add", "-A"]);
  gitQuiet(root, ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", message]);
  return gitQuiet(root, ["rev-parse", "HEAD"]);
}

function runCli(cwd, argumentsList, environment) {
  return spawnSync(process.execPath, [cliBin, ...argumentsList], {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    env: { ...process.env, ...environment },
  });
}

/** 没有 git 的环境：任何一次 git 调用都会以 git-missing 失败，所以它是一次证明。 */
async function withoutGit(root, environment) {
  const emptyBin = path.join(root, "empty-bin");
  await mkdir(emptyBin, { recursive: true });
  return { ...environment, PATH: emptyBin, Path: emptyBin };
}

/** 在目录树里找一段文本；凭据测试用它证明「哪里都没有写下来」。 */
async function findText(directory, needle) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const found = await findText(full, needle);
      if (found) return found;
      continue;
    }
    if (entry.isFile() && (await readFile(full, "utf8").catch(() => "")).includes(needle)) {
      return full;
    }
  }
  return null;
}

/** 检出的文件行尾由这台机器的 git 配置决定（core.autocrlf），比较内容前先归一。 */
async function textOf(file) {
  return (await readFile(file, "utf8")).replace(/\r\n/g, "\n");
}

/** 一个同步过的 Hub + 一个项目目录：缓存测试的共同开头。 */
async function syncedHub(root) {
  const hub = path.join(root, "hub");
  const project = path.join(root, "project");
  await mkdir(hub, { recursive: true });
  await mkdir(project, { recursive: true });
  await publishHub(hub);
  const revision = await initHub(hub);
  const environment = { AVENIC_STATE_DIR: path.join(root, "state"), AVENIC_CATALOG_SPEC: hub };
  // 第一次同步顺手留一份 git trace：冷启动跑了什么，是后面「热缓存没有重来一遍」
  // 那些断言的反面对照。
  const coldTrace = path.join(root, "cold-trace.log");
  const result = runCli(project, ["hub", "sync"], { ...environment, GIT_TRACE: coldTrace });
  assert.equal(result.status, 0, result.stderr);
  return { hub, project, environment, revision, coldTrace, cache: catalogCacheDirectory(hub, environment) };
}

// git writes one sentence per cause, and the exit code is 128 for all of them.
// The strings below are copied from real git output; each one has to send the
// user somewhere different, which is the only reason the table exists.
test("git failures are told apart by what git actually said", () => {
  const cases = [
    ["fatal: Authentication failed for 'https://github.com/owner/private.git/'", "authentication"],
    ["fatal: could not read Username for 'https://github.com': terminal prompts disabled", "authentication"],
    ["git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.", "authentication"],
    ["fatal: unable to access 'https://github.com/owner/private.git/': The requested URL returned error: 403", "authentication"],
    ["remote: Repository not found.\nfatal: repository 'https://github.com/owner/gone.git/' not found", "repo-missing"],
    ["fatal: '/tmp/nothing-here' does not appear to be a git repository", "repo-missing"],
    ["fatal: not a git repository (or any of the parent directories): .git", "repo-missing"],
    ["fatal: couldn't find remote ref release", "ref-missing"],
    ["fatal: unable to access 'https://github.com/owner/hub.git/': Could not resolve host: github.com", "network"],
    ["fatal: unable to access 'https://github.com/owner/hub.git/': SSL certificate problem: unable to get local issuer certificate", "network"],
    ["fatal: unable to access 'https://github.com/owner/hub.git/': Failed to connect to github.com port 443 after 21074 ms: Couldn't connect to server", "network"],
  ];
  for (const [stderr, kind] of cases) {
    assert.equal(classifyGitFailure(stderr).kind, kind, stderr);
    assert.ok(classifyGitFailure(stderr).hint.length > 0, `every kind needs a next step: ${stderr}`);
  }
  assert.equal(classifyGitFailure("fatal: something nobody has seen before").kind, "unknown");
});

test("a sync reports the short revision and when it happened", async () => {
  await withTemp("hub-sync-", async (root) => {
    const hub = path.join(root, "hub");
    await fixtureHub(hub);
    const info = await ensureCatalog(hub, { environment: { AVENIC_STATE_DIR: path.join(root, "state") } });
    assert.match(info.revision, /^[0-9a-f]{40}$/);
    assert.equal(info.shortSha, info.revision.slice(0, 7));
    assert.match(info.syncedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(hubSyncSummary(info), `Synced · ${info.shortSha} · ${hubSyncSummary(info).split(" · ")[2]}`);
    assert.match(hubSyncSummary(info), /^Synced · [0-9a-f]{7} · \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});

test("a missing Hub is reported as a missing repository, not as a login problem", async () => {
  await withTemp("hub-missing-", async (root) => {
    const error = await ensureCatalog(path.join(root, "not-a-hub"), {
      environment: { AVENIC_STATE_DIR: path.join(root, "state") },
    }).then(() => null, (failure) => failure);
    assert.ok(error, "syncing a missing Hub must fail");
    assert.equal(error.kind, "repo-missing");
    assert.doesNotMatch(error.message, /gh auth login/, "a missing repository is not an authentication problem");
  });
});

test("a missing branch is reported as a missing ref", async () => {
  await withTemp("hub-ref-", async (root) => {
    const hub = path.join(root, "hub");
    await fixtureHub(hub);
    const error = await ensureCatalog(`${hub}#no-such-branch`, {
      environment: { AVENIC_STATE_DIR: path.join(root, "state") },
    }).then(() => null, (failure) => failure);
    assert.equal(error?.kind, "ref-missing");
  });
});

// Git runs with the user's own environment on purpose — that is what makes a
// private Hub authenticate with the credentials they already have. A machine
// without git therefore has to be recognised before anything is spawned, and
// the answer must not be "check your GitHub authentication".
test("git missing from PATH is named as such, not blamed on the network", async () => {
  await withTemp("hub-nogit-", async (root) => {
    const emptyBin = path.join(root, "empty-bin");
    await mkdir(emptyBin, { recursive: true });
    const missing = { PATH: emptyBin, Path: emptyBin };
    assert.throws(() => gitExecutable(missing), (error) => {
      assert.equal(error.kind, "git-missing");
      assert.match(error.message, /install git/i);
      return true;
    });

    const hub = path.join(root, "hub");
    await fixtureHub(hub);
    // The command itself, with git nowhere on its PATH: it must fail with the
    // git message rather than with a stack trace or an authentication hint.
    const result = spawnSync(process.execPath, [cliBin, "hub", "sync"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, ...missing, AVENIC_STATE_DIR: path.join(root, "state"), AVENIC_CATALOG_SPEC: hub },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /install git/i);
    assert.doesNotMatch(result.stderr, /gh auth login|authentication/i);
  });
});

test("an unusable cache directory is blamed on the cache, not on the Hub", async () => {
  await withTemp("hub-cache-", async (root) => {
    const hub = path.join(root, "hub");
    await fixtureHub(hub);
    const environment = { AVENIC_STATE_DIR: path.join(root, "state") };
    const blocked = catalogCacheDirectory(hub, environment);
    await mkdir(path.dirname(blocked), { recursive: true });
    await writeFile(blocked, "not a directory\n");
    const error = await ensureCatalog(hub, { environment }).then(() => null, (failure) => failure);
    assert.equal(error?.kind, "cache-filesystem");
    assert.match(error.message, new RegExp(blocked.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")));
  });
});

// The extension host shares one event loop with the editor. A synchronous git
// child here freezes the window for as long as the network takes, which is
// exactly what the async clone/fetch path exists to avoid.
test("hub sync never blocks the event loop on git", async () => {
  await withTemp("hub-async-", async (root) => {
    const hub = path.join(root, "hub");
    await fixtureHub(hub);
    let timerFired = false;
    const timer = setTimeout(() => { timerFired = true; }, 0);
    try {
      await ensureCatalog(hub, { environment: { AVENIC_STATE_DIR: path.join(root, "state") } });
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(timerFired, true, "a zero-delay timer must get a turn while git runs");
    } finally {
      clearTimeout(timer);
    }
  });
});

test("avenic hub sync says what it is doing and then what it did", async () => {
  await withTemp("hub-cli-", async (root) => {
    const hub = path.join(root, "hub");
    await fixtureHub(hub);
    const result = spawnSync(process.execPath, [cliBin, "hub", "sync"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, AVENIC_STATE_DIR: path.join(root, "state"), AVENIC_CATALOG_SPEC: hub },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Syncing/);
    assert.match(result.stdout, /^Synced · [0-9a-f]{7} · \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/m);
    assert.ok(result.stdout.indexOf("Syncing") < result.stdout.indexOf("Synced"), "progress comes before the result");
  });
});

// ---- 缓存行为：一个私有 Hub 从克隆到复用的完整生命周期 ----

test("a sync fills the cache, and a second sync fetches into it instead of cloning again", async () => {
  await withTemp("hub-warm-", async (root) => {
    const { hub, project, environment, revision, cache, coldTrace } = await syncedHub(root);
    assert.equal((await readFile(path.join(cache, ".git", "HEAD"), "utf8")).trim(), revision);
    assert.equal(await textOf(path.join(cache, "skills", "s-source", "s", "SKILL.md")), "---\nname: s\n---\n");

    // 冷启动建了仓库、挂了远程；下面「热缓存不该再做这些」才有对照。
    const cold = await readFile(coldTrace, "utf8");
    assert.match(cold, /init --quiet/);
    assert.match(cold, /remote add origin/);
    assert.match(cold, /fetch --depth 1 origin main/);

    // 一个 git 不跟踪的文件：再克隆一次会连它一起抹掉，fetch + checkout 不会。
    await writeFile(path.join(cache, "MARKER"), "keep me\n");
    // 同时记下 git 真正跑了什么：热缓存只该 fetch，不该 init / remote add。
    const warmTrace = path.join(root, "warm-trace.log");
    const second = runCli(project, ["hub", "sync"], { ...environment, GIT_TRACE: warmTrace });
    assert.equal(second.status, 0, second.stderr);
    const traced = await readFile(warmTrace, "utf8");
    assert.match(traced, /fetch --depth 1 origin main/);
    assert.doesNotMatch(traced, /init --quiet/, "热缓存不该被重新 init");
    assert.doesNotMatch(traced, /remote add origin/, "热缓存不该重新挂远程");
    assert.ok(existsSync(path.join(cache, "MARKER")), "热缓存是被 fetch 进去的，不是被换掉的");
    assert.match(second.stdout, new RegExp(`Synced · ${revision.slice(0, 7)}`));
    // 一个 Hub 一个缓存目录：复用而不是并排再建一个。
    assert.deepEqual(await readdir(path.dirname(cache)), [path.basename(cache)]);

    // 复用的前提是 fetch 真的把新修订取回来了。
    await writeFile(path.join(hub, "skills", "s-source", "s", "SKILL.md"), "---\nname: s\n---\nv2\n");
    const moved = commitHub(hub, "two");
    const third = runCli(project, ["hub", "sync"], environment);
    assert.equal(third.status, 0, third.stderr);
    assert.equal((await readFile(path.join(cache, ".git", "HEAD"), "utf8")).trim(), moved);
    assert.equal(await textOf(path.join(cache, "skills", "s-source", "s", "SKILL.md")), "---\nname: s\n---\nv2\n");
    assert.ok(existsSync(path.join(cache, "MARKER")), "更新一次也不该是一次重新克隆");
    assert.match(third.stdout, new RegExp(`Synced · ${moved.slice(0, 7)}`));
  });
});

test("a Hub entry that names a missing Skill fails loudly, and the cache survives it", async () => {
  await withTemp("hub-broken-", async (root) => {
    const { hub, project, environment, cache } = await syncedHub(root);

    // 同步只搬仓库，不解析 Pack：坏掉的条目在同步时就该原样落地，等读的人发现。
    await writePack(hub, "common", ["ghost"]);
    const brokenRevision = commitHub(hub, "names a Skill the Hub does not publish");
    const sync = runCli(project, ["hub", "sync"], environment);
    assert.equal(sync.status, 0, sync.stderr);
    assert.equal((await readFile(path.join(cache, ".git", "HEAD"), "utf8")).trim(), brokenRevision);

    const preview = runCli(project, ["skills", "tree", "common"], environment);
    assert.equal(preview.status, 1);
    assert.match(preview.stderr, /Pack common references missing Skill: ghost/);
    assert.doesNotMatch(preview.stderr, /\n\s+at /, "坏掉的 Hub 条目是一条消息，不是一串堆栈");
    assert.doesNotMatch(preview.stderr, /gh auth login|authentication/i, "缺一个 Skill 不是登录问题");

    // 失败没有把缓存留在半路上：还是一个完整的 checkout，Skill 文件也还在。
    assert.equal((await readFile(path.join(cache, ".git", "HEAD"), "utf8")).trim(), brokenRevision);
    assert.ok(existsSync(path.join(cache, ".git")), "缓存目录仍然是一个 git checkout");
    assert.equal(await textOf(path.join(cache, "skills", "s-source", "s", "SKILL.md")), "---\nname: s\n---\n");

    // 修好之后同步一次就照常可用：内容树是读缓存，Hub 的新内容由显式的
    // `hub sync` 带进来，缓存不需要谁手工去清。
    await writePack(hub, "common", ["s"]);
    commitHub(hub, "fixed");
    const synced = runCli(project, ["hub", "sync"], environment);
    assert.equal(synced.status, 0, synced.stderr);
    const fixed = runCli(project, ["skills", "tree", "common"], environment);
    assert.equal(fixed.status, 0, fixed.stderr);
    assert.match(fixed.stdout, /Packs: common/);
    assert.match(fixed.stdout, /└── s\s*$/m, "修好之后 Pack 里的 Skill 又列得出来");
  });
});

// 锁文件把安装钉在某个修订上，是为了跨设备可复现。既然那个修订已经在本地缓存里，
// 再去拉一次不会改变任何字节 —— 于是这一次安装不该有 fetch（GIT_TRACE 里看得见）。
test("an install pinned by the lock reuses the cached revision without fetching", async () => {
  await withTemp("hub-pinned-", async (root) => {
    const { project, environment, revision } = await syncedHub(root);
    const first = runCli(project, ["skills", "install", "common"], environment);
    assert.equal(first.status, 0, first.stderr);
    const lock = JSON.parse(await readFile(path.join(project, ".avenic.lock.json"), "utf8"));
    assert.equal(lock.catalog.revision, revision, "安装把这次的修订写进了项目锁");

    const trace = path.join(root, "install-trace.log");
    const second = runCli(project, ["skills", "install", "common"], { ...environment, GIT_TRACE: trace });
    assert.equal(second.status, 0, second.stderr);
    const traced = await readFile(trace, "utf8").catch(() => "");
    assert.doesNotMatch(traced, /fetch|clone/, "缓存里已经有这个修订，装它不该再联网");
  });
});

// 浏览 Hub 是读，不是同步：`tree`/`packs` 只读缓存，一次 git 都不跑。PATH 指向空
// 目录，于是任何一次 git 调用都会以 git-missing 死掉 —— 跑通就是证明。
test("browsing the Hub reads the cache and never runs git", async () => {
  await withTemp("hub-browse-", async (root) => {
    const { project, environment } = await syncedHub(root);
    const noGit = await withoutGit(root, environment);

    for (const argumentsList of [["skills", "tree"], ["skills", "tree", "common"], ["skills", "packs"]]) {
      const result = runCli(project, argumentsList, noGit);
      assert.equal(result.status, 0, `${argumentsList.join(" ")}\n${result.stderr}`);
      assert.doesNotMatch(`${result.stdout}${result.stderr}`, /install git/i, "浏览不该需要 git");
    }
  });
});

// 缓存还空着的时候，浏览不该自己去联网，也不该把 git 的报错甩给用户：它知道该敲
// 哪条命令，就直接说出来。
test("browsing an unsynced Hub says what to run instead of fetching", async () => {
  await withTemp("hub-browse-cold-", async (root) => {
    const hub = path.join(root, "hub");
    const project = path.join(root, "project");
    await mkdir(project, { recursive: true });
    await publishHub(hub);
    await initHub(hub);
    const environment = { AVENIC_STATE_DIR: path.join(root, "state"), AVENIC_CATALOG_SPEC: hub };

    const noGit = await withoutGit(root, environment);
    const tree = runCli(project, ["skills", "tree"], noGit);
    assert.equal(tree.status, 1);
    assert.match(tree.stderr, /not cached/i);
    assert.match(tree.stderr, /avenic hub sync/);
    assert.doesNotMatch(tree.stderr, /install git/i, "没缓存不是 git 的问题，说清楚该做什么就够了");
    // 没联网就没留下缓存：说「先同步」的时候缓存确实还是空的。
    assert.ok(!existsSync(catalogCacheDirectory(hub, environment)), "browsing must not have fetched anything");
  });
});

test("a Hub that cannot be reached leaves the warm cache readable", async () => {
  await withTemp("hub-offline-", async (root) => {
    const { hub, project, environment, revision, cache } = await syncedHub(root);
    const away = `${hub}-away`;
    await rename(hub, away);

    const offline = runCli(project, ["hub", "sync"], environment);
    assert.equal(offline.status, 1);
    assert.match(`${offline.stdout}${offline.stderr}`, /does not appear to be a git repository|not found/i);
    assert.doesNotMatch(offline.stderr, /gh auth login|authentication/i, "够不着 Hub 不是登录问题");
    assert.equal((await readFile(path.join(cache, ".git", "HEAD"), "utf8")).trim(), revision);

    // 读缓存不经过 Hub：这条路径只读 .git/HEAD 和锁文件。
    const status = runCli(project, ["status"], environment);
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, new RegExp(`hub · current · ${revision.slice(0, 7)}`));

    await rename(away, hub);
    const recovered = runCli(project, ["hub", "sync"], environment);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.match(recovered.stdout, new RegExp(`Synced · ${revision.slice(0, 7)}`));
  });
});

// The cache is the whole point of the Hub being local: once it is warm, the
// reader paths must not need git at all. PATH points at an empty directory, so
// any git call would die as git-missing — a passing run is the proof.
test("a warm cache is read without git", async () => {
  await withTemp("hub-nogit-read-", async (root) => {
    const { project, environment, revision } = await syncedHub(root);
    const install = runCli(project, ["skills", "install", "common"], environment);
    assert.equal(install.status, 0, install.stderr);

    const noGit = await withoutGit(root, environment);
    // 对照组：同一个环境里，要 git 的命令确实会失败 —— 上面两条通过不是因为
    // PATH 被谁忽略了。
    const sync = runCli(project, ["hub", "sync"], noGit);
    assert.equal(sync.status, 1);
    assert.match(sync.stderr, /install git/i);

    const status = runCli(project, ["status"], noGit);
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, new RegExp(`Hub\\s+hub · current · ${revision.slice(0, 7)}`));
    assert.doesNotMatch(`${status.stdout}${status.stderr}`, /install git/i);

    const skills = runCli(project, ["skills", "status"], noGit);
    assert.equal(skills.status, 0, skills.stderr);
    assert.match(skills.stdout, /Current Project Skills/);
    assert.match(skills.stdout, /Packs: common/);
    assert.match(skills.stdout, /Optimized|Degraded|Incomplete/);
    assert.doesNotMatch(`${skills.stdout}${skills.stderr}`, /install git/i);
  });
});

// A private Hub authenticates with whatever the user already has. That only
// works because git inherits the caller's environment: no token is minted, none
// is passed on the command line, and none is written beside the checkout.
test("a sync uses the user's own git environment and stores nothing of its own", async () => {
  await withTemp("hub-auth-", async (root) => {
    const hub = path.join(root, "hub");
    const project = path.join(root, "project");
    await mkdir(project, { recursive: true });
    await publishHub(hub);
    await initHub(hub);

    const trace = path.join(root, "git-trace.log");
    // 哨兵：它出现在磁盘上的任何地方，都说明有人把凭据抄了下来。
    const sentinel = "SENTINEL-DO-NOT-STORE-9f3c";
    const environment = {
      AVENIC_STATE_DIR: path.join(root, "state"),
      AVENIC_CATALOG_SPEC: hub,
      GIT_TRACE: trace,
      GH_TOKEN: sentinel,
      GITHUB_TOKEN: sentinel,
    };
    const result = runCli(project, ["hub", "sync"], environment);
    assert.equal(result.status, 0, result.stderr);

    // GIT_TRACE 只会写到子进程真的收到的那个路径上，所以它同时证明了环境继承。
    const traced = await readFile(trace, "utf8");
    assert.match(traced, /fetch --depth 1 origin main/);
    assert.match(traced, /remote add origin/);
    assert.doesNotMatch(traced, new RegExp(sentinel));
    // 认证发生在 git 与它自己的配置之间：命令行上没有凭据参数。
    assert.doesNotMatch(traced, /extraheader|Authorization|x-access-token/i);

    const cache = catalogCacheDirectory(hub, environment);
    const config = await readFile(path.join(cache, ".git", "config"), "utf8");
    assert.match(config, /\[remote "origin"\]/);
    assert.doesNotMatch(config, /extraheader|credential|Authorization|x-access-token/i);
    assert.doesNotMatch(config, /https?:\/\/[^\s/]*@/, "远程地址里不该有内嵌的用户信息");
    const url = (config.match(/^\s*url = (.*)$/m)?.[1] ?? "").trim().replace(/^"|"$/g, "").replace(/\\\\/g, "\\");
    assert.equal(url, hub, "远程就该是这个 Hub，没有被换成别的地址");

    // Avenic 自己也不该有一台造 token 的机器。
    const gitModule = await readFile(path.join(packageRoot, "packages", "core", "src", "skills", "git.mjs"), "utf8");
    assert.doesNotMatch(gitModule, /extraheader|x-access-token|Authorization|GITHUB_TOKEN|GH_TOKEN/i);

    assert.equal(await findText(root, sentinel), null, "凭据一个字节都不该落到磁盘上");
  });
});

// Where the cache lives, and what counts as "the cache can answer this", are both
// core's answers. The extension used to re-derive the path from the same slug
// rule and decide by itself that a directory holding a `packs` subdirectory was
// usable — two mirrors of one rule, either of which could point the editor at
// something the CLI never wrote.
test("the extension reads the Hub cache through core, not through its own rules", async () => {
  const source = await readFile(path.join(packageRoot, "packages", "vscode", "src", "services", "catalog.ts"), "utf8");
  assert.match(source, /cachedCatalog/, "the extension must ask core what the cache can answer");
  assert.doesNotMatch(source, /catalogCacheRoot/, "borrowing the root and re-deriving the slug is the mirror this replaced");
  assert.doesNotMatch(source, /catalogCacheDirectory/, "the path itself is computed in core too");
  assert.doesNotMatch(source, /\.replace\(\/\[\^a-z0-9\._-\]\+\/g, "-"\)/, "the slug rule belongs to core");
});
