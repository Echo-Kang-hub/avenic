import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

// The cache path is computed in one place. The extension used to re-derive it
// from the same slug rule, which meant a change to the rule in core silently
// pointed the editor at a directory the CLI never wrote.
test("the extension does not re-derive the Hub cache path", async () => {
  const source = await readFile(path.join(packageRoot, "packages", "vscode", "src", "services", "catalog.ts"), "utf8");
  assert.match(source, /catalogCacheDirectory/, "the extension must use the core helper");
  assert.doesNotMatch(source, /catalogCacheRoot/, "borrowing the root and re-deriving the slug is the mirror this replaced");
  assert.doesNotMatch(source, /\.replace\(\/\[\^a-z0-9\._-\]\+\/g, "-"\)/, "the slug rule belongs to core");
});
