import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdir, readFile, rename, writeFile as writeFileTo } from "node:fs/promises";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { writeFileAtomic } from "../packages/core/src/runtime/atomic-file.mjs";
import { REQUIRED_RULES } from "../packages/core/src/runtime/gitignore.mjs";

// A real Windows run of the cross-agent experiment died in the middle of a
// write the product makes on every capture:
//
//   EPERM: operation not permitted, rename
//     '...\canonical\claude-…\mappings.json.tmp-56440-e82da602-…' ->
//     '...\canonical\claude-…\mappings.json'
//
// The rename is transiently refused when something else — a virus scanner, a
// search indexer — is holding the freshly written file, which is exactly the
// case a retry is for. These tests pin the retry, its bound, and the fact that
// only a refusal is retried.

function scratch() {
  const root = mkdtempSync(path.join(os.tmpdir(), "avenic-atomic-"));
  mkdirSync(path.join(root, "nested"), { recursive: true });
  return root;
}

/** A rename that refuses the first `refusals` calls, then really renames. */
function refusingRename(refusals, code = "EPERM") {
  let calls = 0;
  return {
    get calls() { return calls; },
    rename: async (from, to) => {
      calls += 1;
      if (calls <= refusals) {
        const error = new Error(`${code}: operation not permitted, rename '${from}' -> '${to}'`);
        error.code = code;
        throw error;
      }
      await rename(from, to);
    },
  };
}

test("a rename the file system refuses twice still lands the write", async () => {
  const root = scratch();
  try {
    const file = path.join(root, "nested", "mappings.json");
    const refusing = refusingRename(2);

    await writeFileAtomic(file, '{"mapped":true}\n', { renameFile: refusing.rename, delayMs: 0 });

    assert.equal(await readFile(file, "utf8"), '{"mapped":true}\n', "the content is the new one");
    assert.equal(refusing.calls, 3, "the refusal was retried rather than reported");
    assert.deepEqual(await readdir(path.dirname(file)), ["mappings.json"], "no temporary file survives");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a refusal that never stops is reported after a bounded number of attempts", async () => {
  const root = scratch();
  try {
    const file = path.join(root, "cursors.json");
    const refusing = refusingRename(Number.MAX_SAFE_INTEGER);

    await assert.rejects(
      writeFileAtomic(file, "{}\n", { renameFile: refusing.rename, delayMs: 0, attempts: 4 }),
      (error) => error.code === "EPERM",
      "the refusal reaches the caller once the budget runs out",
    );

    assert.equal(refusing.calls, 4, "the budget is what stops it — not an unbounded loop");
    assert.deepEqual((await readdir(root)).filter((name) => name.includes(".tmp-")), [], "the temporary file is not left behind");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failure that only looks similar is reported at once", async () => {
  const root = scratch();
  try {
    const file = path.join(root, "config.json");
    let calls = 0;
    const renameFile = async () => {
      calls += 1;
      const error = new Error("ENOSPC: no space left on device");
      error.code = "ENOSPC";
      throw error;
    };

    await assert.rejects(writeFileAtomic(file, "{}\n", { renameFile, delayMs: 0 }), (error) => error.code === "ENOSPC");

    assert.equal(calls, 1, "a full disk is not a transient refusal and is not retried");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a write that fails on the way in takes its temporary file with it", async () => {
  const root = scratch();
  try {
    const file = path.join(root, "nested", "state.json");
    await writeFileAtomic(file, "what was there\n");
    // 第一步自己失败（磁盘满了、目录不可写）。这时候临时文件已经落在旁边了——它是
    // Avenic 自己的，失败不能把它留下，也不能碰到已经在那儿的那一份。
    const failing = async (target) => {
      await writeFileTo(target, "half a file");
      const error = new Error("ENOSPC: no space left on device");
      error.code = "ENOSPC";
      throw error;
    };

    await assert.rejects(writeFileAtomic(file, "value\n", { writeFile: failing }), (error) => error.code === "ENOSPC");

    assert.deepEqual(await readdir(path.dirname(file)), ["state.json"], "写坏的那一次不留碎片");
    assert.equal(await readFile(file, "utf8"), "what was there\n", "失败的那一次不动已经在盘上的那一份");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the name a killed write leaves behind is a name the project ignores", async () => {
  // 中间态就住在目标旁边，而它可能是同一个文件的一份副本 —— 项目的配置里就放着凭证。
  // 留在那里的那一个必须是被忽略的，所以写入器用的名字和 gitignore 声明的名字只能是
  // 同一个名字；两边各叫各的，一次中断就是一次提交。
  const root = scratch();
  try {
    spawnSync("git", ["init", "-q"], { cwd: root });
    await writeFileTo(path.join(root, ".gitignore"), `${REQUIRED_RULES.join("\n")}\n`);
    const file = path.join(root, ".claude", "settings.local.json");
    mkdirSync(path.dirname(file), { recursive: true });
    // 一次只差改名就完成、然后进程消失的写入：临时文件留在盘上。
    const killed = async () => {
      const error = new Error("ENOSPC: no space left on device");
      error.code = "ENOSPC";
      throw error;
    };
    await assert.rejects(writeFileAtomic(file, '{"env":{}}\n', { renameFile: killed, removeFile: async () => {} }));

    const leftovers = (await readdir(path.dirname(file))).filter((name) => name !== "settings.local.json");
    assert.equal(leftovers.length, 1, "the killed write's temporary is what this test is about");
    const ignored = spawnSync("git", ["check-ignore", "-q", path.join(".claude", leftovers[0])], { cwd: root });
    assert.equal(ignored.status, 0, `${leftovers[0]} 必须是被忽略的名字 —— 它是那个装着凭证的文件的副本`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the write replaces what was there and writes where it was asked to", async () => {
  const root = scratch();
  try {
    const file = path.join(root, "nested", "state.json");

    await writeFileAtomic(file, "first\n");
    await writeFileAtomic(file, "second\n");

    assert.equal(await readFile(file, "utf8"), "second\n", "the later write is the one on disk");
    assert.deepEqual(await readdir(path.dirname(file)), ["state.json"], "one file, not one per write");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
