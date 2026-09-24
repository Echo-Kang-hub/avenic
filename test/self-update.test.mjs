import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { updateAvenic } from "../packages/cli/src/cli/self-update.mjs";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPackageRoot = path.join(packageRoot, "packages", "cli");

function recordingSpawn(status = 0) {
  const calls = [];
  return {
    calls,
    spawn(executable, argumentsList) {
      calls.push({ executable, argumentsList });
      return { status, stdout: "" };
    },
  };
}

test("a self-update that leaves the old version on PATH fails loudly", async () => {
  const { calls, spawn } = recordingSpawn();
  await assert.rejects(
    updateAvenic(cliPackageRoot, {
      currentVersion: "1.4.4",
      latestVersion: "1.4.5",
      // npm exited 0, but the executable PATH resolves is still the old one.
      probeVersion: () => "1.4.4",
      installedVersion: () => "1.4.4",
      spawn,
    }),
    (error) => {
      assert.match(error.message, /1\.4\.5/, "the failure must name the version the registry has");
      assert.match(error.message, /1\.4\.4/, "the failure must name the version that is actually active");
      assert.match(error.message, /PATH/i, "the failure must point at the likely cause");
      return true;
    },
  );
  assert.deepEqual(calls.map((call) => call.executable), ["npm"], "the update itself must still have been attempted");
});

test("a self-update succeeds when npm installed the target even though PATH still resolves the old shim", async () => {
  const { calls, spawn } = recordingSpawn();
  const result = await updateAvenic(cliPackageRoot, {
    currentVersion: "1.4.4",
    latestVersion: "1.4.5",
    // A terminal keeps the command lookup it started with until its PATH is
    // refreshed, but the package npm just installed is already usable from a
    // fresh terminal.
    probeVersion: () => "1.4.4",
    installedVersion: () => "1.4.5",
    spawn,
  });

  assert.equal(result.updated, true);
  assert.equal(result.active, "1.4.5");
  assert.equal(result.pathVersion, "1.4.4");
  assert.deepEqual(calls.map((call) => call.executable), ["npm"]);
});

test("a self-update verifies the package npm installed instead of the stale command lookup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-global-"));
  try {
    await mkdir(path.join(root, "avenic"));
    await writeFile(path.join(root, "avenic", "package.json"), JSON.stringify({ version: "1.4.5" }));
    const calls = [];
    const result = await updateAvenic(cliPackageRoot, {
      currentVersion: "1.4.4",
      latestVersion: "1.4.5",
      probeVersion: () => "1.4.4",
      spawn(executable, argumentsList) {
        calls.push({ executable, argumentsList });
        if (argumentsList[0] === "root") return { status: 0, stdout: `${root}\n` };
        return { status: 0, stdout: "" };
      },
    });
    assert.equal(result.updated, true);
    assert.equal(result.active, "1.4.5");
    assert.deepEqual(calls.map((call) => call.argumentsList), [
      ["install", "--global", "avenic@latest"],
      ["root", "--global"],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an already current install does not reinstall", async () => {
  const { calls, spawn } = recordingSpawn();
  const result = await updateAvenic(cliPackageRoot, {
    currentVersion: "1.4.5",
    latestVersion: "1.4.5",
    probeVersion: () => "1.4.5",
    spawn,
  });
  assert.equal(result.updated, false);
  assert.deepEqual(calls, [], "nothing may be installed when the versions already match");
});

test("a failed registry query says the update was not attempted", async () => {
  const { calls, spawn } = recordingSpawn(1);
  await assert.rejects(
    updateAvenic(cliPackageRoot, { currentVersion: "1.4.4", spawn }),
    /update was not attempted/i,
  );
  assert.deepEqual(calls.map((call) => call.executable), ["npm"]);
});

test("a failing npm install surfaces its exit code", async () => {
  const spawn = (executable, argumentsList) => {
    void argumentsList;
    return { status: executable === "npm" ? 7 : 0, stdout: "" };
  };
  await assert.rejects(
    updateAvenic(cliPackageRoot, { currentVersion: "1.4.4", latestVersion: "1.4.5", spawn }),
    /exit code 7/,
  );
});

test("avenic --version reports the version this package actually has", () => {
  const declared = JSON.parse(readFileSync(path.join(cliPackageRoot, "package.json"), "utf8")).version;
  const result = spawnSync(process.execPath, [path.join(cliPackageRoot, "scripts", "skills.mjs"), "--version"], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), `Avenic ${declared}`);
});
