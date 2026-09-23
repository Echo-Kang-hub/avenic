import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cursorFilePath } from "../packages/core/src/runtime/cursors.mjs";
import { joinLaunchGroup } from "../packages/core/src/runtime/session-interop.mjs";
import { launchGroupState, sessionLeasePath } from "../packages/core/src/runtime/sessions.mjs";
import { withClaudeProject } from "./helpers/session-fixture.mjs";

// One project, one identity. Everything Avenic keeps *inside* a project is
// addressed relative to it, so the filesystem decides what counts as the same
// place — and on Windows the filesystem folds case. The state that lives
// *outside* the project is addressed by a hash of the path instead: the launch
// lease sits in the temp directory, the capture cursors in machine state. Those
// hashes have to fold exactly what the filesystem folds, or one project keeps
// two leases and two cursors.
//
// The mismatch is not hypothetical. A host hands its own spelling along: the
// VS Code extension reads the folder back from a workspace URI, which lowercases
// the drive letter, while the CLI's `process.cwd()` reports the spelling the OS
// itself uses. A dashboard watching one spelling can never see the launch the
// other one recorded — it reads an empty directory and reports idle forever.

// The same directory as the OS would spell it when asked from a different door.
function otherSpelling(projectRoot) {
  return process.platform === "win32"
    ? projectRoot.replace(/^([A-Za-z]):/, (_all, letter) => `${letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase()}:`)
    : projectRoot;
}

test("a drive letter's case is not part of a project's identity", { skip: process.platform === "win32" ? false : "this filesystem tells C:\\a and c:\\a apart, so one spelling is all there is" }, async () => {
  await withClaudeProject(async ({ projectRoot, environment }) => {
    const elsewhere = otherSpelling(projectRoot);
    assert.notEqual(elsewhere, projectRoot, "the fixture is on a drive whose case can be flipped");

    assert.equal(sessionLeasePath("claude", elsewhere), sessionLeasePath("claude", projectRoot), "one launch group per project");
    assert.equal(cursorFilePath(elsewhere, environment), cursorFilePath(projectRoot, environment), "one cursor per project");

    const group = await joinLaunchGroup(projectRoot, "claude", { environment });
    assert.ok(group, "an agent with its own native directory joins the group");
    assert.equal(
      await launchGroupState("claude", elsewhere),
      "running",
      "a watcher that spells the project the way a host does still sees the launch",
    );
    await group.release();
  });
});

test("a filesystem that tells case apart keeps two projects apart", { skip: process.platform === "win32" ? "no two directories here differ only by case" : false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-identity-"));
  try {
    const directories = [path.join(root, "Project"), path.join(root, "project")];
    await Promise.all(directories.map((directory) => mkdir(directory)));
    if ((await realpath(directories[0])) === (await realpath(directories[1]))) return; // one directory wearing two names
    assert.notEqual(sessionLeasePath("claude", directories[0]), sessionLeasePath("claude", directories[1]));
    assert.notEqual(cursorFilePath(directories[0]), cursorFilePath(directories[1]));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a spelling the filesystem itself collapses names the same project", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-identity-"));
  try {
    const projectRoot = path.join(root, "project");
    await mkdir(projectRoot);
    for (const spelling of [`${projectRoot}${path.sep}`, path.join(projectRoot, ".", "nested", ".."), path.join(root, "project")]) {
      assert.equal(sessionLeasePath("claude", spelling), sessionLeasePath("claude", projectRoot), spelling);
      assert.equal(cursorFilePath(spelling), cursorFilePath(projectRoot), spelling);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
