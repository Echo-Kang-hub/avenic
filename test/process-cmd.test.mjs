import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import { quoteShellLine, spawnExecutable, spawnExecutableSync } from "../packages/core/src/index.mjs";

const windows = process.platform === "win32";

// 子进程站在哪个目录、它从 PWD 读到哪个目录，必须是同一个：shell 里 `cd` 会同时改两者，
// 但这里的启动路径可以单独指定 cwd —— agent 拿到的是「项目根」，而项目根是从用户所在目录
// 向上找出来的（`avenic` 在子目录里运行时两者本就不一致）。OpenCode 把 PWD 当作它的项目；
// 两者不一致时，一条被续接的投影会话答完就不再退出（2x2 见
// dist/logs/opencode-pwd-matrix.txt）。下面两条把这条规则钉在两个 spawmer 上。
const whereAmI = "process.stdout.write(JSON.stringify({ cwd: process.cwd(), pwd: process.env.PWD }))";

function runIn(cwd, pwd) {
  return spawnExecutableSync(process.execPath, ["-e", whereAmI], {
    cwd,
    env: { ...process.env, PWD: pwd },
    stdio: "pipe",
    encoding: "utf8",
    windowsHide: true,
  });
}


// .cmd/.bat 经 cmd.exe 透传（见 runtime/process.mjs 的 invocation）：参数里的 & | ^ < > ( )
// 会被 cmd 二次解析，必须整体加引号。下面用 `echo %*` 桩把真实到达批处理的参数回显出来。
async function withCmdStub(run) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "avenic-cmd-"));
  try {
    const stub = path.join(dir, "avenic-args.cmd");
    await writeFile(stub, "@echo off\r\necho %*\r\n");
    return await run(stub);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function run(executable, argumentsList) {
  return spawnExecutableSync(executable, argumentsList, {
    env: process.env,
    stdio: "pipe",
    encoding: "utf8",
    windowsHide: true,
  });
}

test("cmd shim arguments containing & are quoted before reaching the shell", { skip: !windows }, async () => {
  await withCmdStub((stub) => {
    const result = run(stub, ["https://x.example/v1?a=1&b=2"]);
    assert.equal(result.status, 0);
    const lines = result.stdout.split(/\r?\n/);
    assert.ok(
      lines.some((line) => line.includes("a=1&b=2")),
      `"&" must not split the argument, got: ${JSON.stringify(result.stdout)}`,
    );
  });
});

test("cmd shim arguments containing ^ and parentheses are quoted before reaching the shell", { skip: !windows }, async () => {
  await withCmdStub((stub) => {
    const result = run(stub, ["a^b", "(x)"]);
    assert.equal(result.status, 0);
    assert.ok(result.stdout.includes("a^b"), `"^" must survive cmd parsing, got: ${JSON.stringify(result.stdout)}`);
    assert.ok(result.stdout.includes("(x)"), `"(" must survive cmd parsing, got: ${JSON.stringify(result.stdout)}`);
  });
});

// 计划注明 % 与 ! 不在加固集合内（% 在 cmd 引号内也会展开），由 model/schema.mjs 的
// validateBaseUrl 白名单在源头拒绝。这里钉住边界：含 % 的参数不会被本层加引号。
test("cmd shim leaves percent signs unquoted (rejected upstream by the whitelist)", { skip: !windows }, async () => {
  await withCmdStub((stub) => {
    const result = run(stub, ["50%"]);
    assert.equal(result.status, 0);
    assert.ok(result.stdout.includes("50%"), `"%" must pass through, got: ${JSON.stringify(result.stdout)}`);
    assert.ok(!result.stdout.includes('"50%"'), `"%" must stay unquoted, got: ${JSON.stringify(result.stdout)}`);
  });
});

// 临时目录含空格（%TEMP% 可被用户改到含空格的路径）：整个命令串由 shell:true 的
// cmd /d /s /c "..." 包裹，桩路径自身必须带引号才能被找到。
test("cmd shim resolves when its directory path contains spaces", { skip: !windows }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "avenic cmd space "));
  try {
    const stub = path.join(dir, "avenic-args.cmd");
    await writeFile(stub, "@echo off\r\necho %*\r\n");
    const result = run(stub, ["https://x.example/v1?a=1&b=2"]);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.ok(
      result.stdout.split(/\r?\n/).some((line) => line.includes("a=1&b=2")),
      `argument must survive, got: ${JSON.stringify(result.stdout)}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// 参数里带双引号时没有一条「对谁都对」的转义：cmd 里是 `""`，POSIX 与 PowerShell
// 读的是 `\"`，同一条命令两种 shell 两种含义。整层能做的诚实选择是拒绝，而不是发出
// 一行某处会静默变意的命令——启动参数（session id、路径）本也不该带它。
test("a part containing a double quote is refused rather than quoted into another meaning", () => {
  assert.throws(() => quoteShellLine("claude", ["--cd", 'a"b c']), /double quote/);
});

// 跨平台：.exe/原生命令不走 cmd 拼接，参数原样到达（两平台一致，Linux 下真实执行）。
test("plain executable arguments reach the process untouched", () => {
  const argument = "a&b|c^d(e)";
  const result = run(process.execPath, ["-e", "process.stdout.write(process.argv[1])", argument]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, argument);
});

// POSIX 直启：非 shell 路径不应被引号包裹（win32 下无法直启 .sh，skip）。
test("POSIX executables receive arguments unmodified", { skip: windows }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "avenic-sh-"));
  try {
    const stub = path.join(dir, "avenic-args.sh");
    await writeFile(stub, "#!/bin/sh\nprintf '%s\\n' \"$1\"\n");
    await chmod(stub, 0o755);
    const result = run(stub, ["a&b|c^d(e)"]);
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim(), "a&b|c^d(e)");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a child started in a directory is told that directory, not the shell's", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "avenic-cwd-"));
  const elsewhere = await mkdtemp(path.join(os.tmpdir(), "avenic-pwd-"));
  try {
    const result = runIn(dir, elsewhere);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout), { cwd: dir, pwd: dir });
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(elsewhere, { recursive: true, force: true });
  }
});

test("the async spawmer tells its child the same thing", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "avenic-cwd-"));
  const elsewhere = await mkdtemp(path.join(os.tmpdir(), "avenic-pwd-"));
  try {
    const result = await spawnExecutable(process.execPath, ["-e", whereAmI], {
      cwd: dir,
      env: { ...process.env, PWD: elsewhere },
      windowsHide: true,
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout), { cwd: dir, pwd: dir });
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(elsewhere, { recursive: true, force: true });
  }
});
