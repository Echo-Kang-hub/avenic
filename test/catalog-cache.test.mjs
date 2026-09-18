import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ensureCatalog,
  loadDefaultCatalogSpec,
  parseCatalogSpec,
  setDefaultCatalogSpec,
} from "../packages/core/src/skills/catalog.mjs";
import { loadKnownCatalogs, registerCatalog } from "../packages/core/src/index.mjs";

function git(cwd, argumentsList) {
  const result = spawnSync("git", ["-C", cwd, ...argumentsList], { encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function fixtureCatalog(root) {
  await mkdir(path.join(root, "skills", "s"), { recursive: true });
  await mkdir(path.join(root, "packs"), { recursive: true });
  await writeFile(path.join(root, "skills", "s", "SKILL.md"), "---\nname: s\n---\nv1\n");
  await writeFile(path.join(root, "packs", "common.json"), `${JSON.stringify({ schemaVersion: 1, id: "common", name: "Common", sources: [{ source: "s-source", skills: ["s"] }] })}\n`);
  await writeFile(path.join(root, "sources.lock.json"), `${JSON.stringify({ schemaVersion: 1, sources: [{ id: "s-source", name: "S", repository: "https://github.com/example/s.git", skillRoot: "skills", revision: "a".repeat(40) }] })}\n`);
  await writeFile(path.join(root, "package.json"), `${JSON.stringify({ name: "fixture-catalog", version: "1.0.0" })}\n`);
  git(root, ["init", "--quiet", "-b", "main"]);
  git(root, ["add", "-A"]);
  git(root, ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "--quiet", "-m", "one"]);
}

async function withTemp(prefix, run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("parseCatalogSpec handles owner/repo and pinned refs", () => {
  assert.deepEqual(parseCatalogSpec("Echo-Kang-hub/avenic-catalog"), {
    repository: "https://github.com/Echo-Kang-hub/avenic-catalog.git",
    ref: "main",
  });
  const pinned = parseCatalogSpec("owner/repo#abc123");
  assert.equal(pinned.repository, "https://github.com/owner/repo.git");
  assert.equal(pinned.ref, "abc123");
  const ssh = parseCatalogSpec("git@github.com:o/r.git#v1");
  assert.equal(ssh.repository, "git@github.com:o/r.git");
  assert.equal(ssh.ref, "v1");
});

test("ensureCatalog clones once, reuses, and pins revisions", async () => {
  await withTemp("catalog-cache-", async (root) => {
    const catalog = path.join(root, "catalog");
    const state = path.join(root, "state");
    await fixtureCatalog(catalog);
    const first = await ensureCatalog(catalog, { environment: { AVENIC_STATE_DIR: state } });
    assert.equal(first.spec, catalog);
    assert.equal(first.catalogRoot.startsWith(path.join(state, "catalog") + path.sep), true);
    assert.equal(path.basename(first.catalogRoot).endsWith("-catalog"), true);
    assert.match(await readFile(path.join(first.catalogRoot, "skills", "s", "SKILL.md"), "utf8"), /v1/);

    await writeFile(path.join(catalog, "skills", "s", "SKILL.md"), "---\nname: s\n---\nv2\n");
    git(catalog, ["add", "-A"]);
    git(catalog, ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "--quiet", "-m", "two"]);

    const pinned = await ensureCatalog(`${catalog}#${first.revision}`, { environment: { AVENIC_STATE_DIR: state } });
    assert.equal(pinned.revision, first.revision);
    assert.match(await readFile(path.join(pinned.catalogRoot, "skills", "s", "SKILL.md"), "utf8"), /v1/);

    const latest = await ensureCatalog(catalog, { environment: { AVENIC_STATE_DIR: state } });
    assert.notEqual(latest.revision, first.revision);
    assert.match(await readFile(path.join(latest.catalogRoot, "skills", "s", "SKILL.md"), "utf8"), /v2/);
  });
});

test("ensureCatalog failure names the cause the user has to act on", async () => {
  await withTemp("catalog-fail-", async (root) => {
    const state = path.join(root, "state");
    // A path that is not a repository is a spec problem. Telling the user to
    // log in would send them to fix the one thing that is not wrong.
    const missing = await ensureCatalog(path.join(root, "missing-repo"), { environment: { AVENIC_STATE_DIR: state } })
      .then(() => null, (error) => error);
    assert.equal(missing.kind, "repo-missing");
    assert.match(missing.message, /not found/i);
    assert.doesNotMatch(missing.message, /gh auth login/);
  });
});

test("catalog spec storage and sync manage the default spec", async () => {
  await withTemp("catalog-default-", async (root) => {
    const environment = { AVENIC_STATE_DIR: root };
    assert.equal(await loadDefaultCatalogSpec(environment), "Echo-Kang-hub/SkillsHub#main");
    await setDefaultCatalogSpec(environment, "my/private#abc123");
    assert.equal(await loadDefaultCatalogSpec(environment), "my/private#abc123");
    const overridden = { AVENIC_STATE_DIR: root, AVENIC_CATALOG_SPEC: "env/repo" };
    assert.equal(await loadDefaultCatalogSpec(overridden), "env/repo");
  });
});

test("registerCatalog saves the spec and tolerates preview failure", async () => {
  await withTemp("catalog-register-", async (root) => {
    const state = path.join(root, "state");
    const environment = { AVENIC_STATE_DIR: state };
    const missing = path.join(root, "no-such-catalog");
    const failed = await registerCatalog(missing, { environment, io: { log() {} } });
    assert.equal(failed.previewFailed, true);
    assert.equal(await loadDefaultCatalogSpec(environment), missing);
    assert.equal((await loadKnownCatalogs(environment))[0].spec, missing);

    const catalog = path.join(root, "catalog");
    await fixtureCatalog(catalog);
    const ok = await registerCatalog(catalog, { environment, io: { log() {} } });
    assert.equal(ok.previewFailed, false);
    assert.equal(ok.packs.length, 1);
    assert.equal(ok.packs[0].id, "common");
  });
});
