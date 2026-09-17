import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { bindProject, removeProfile, upsertProfile } from "../packages/core/src/index.mjs";

// 启动注入是这条命令族的核心承诺：绑定了 profile 的项目，启动 Agent 时必须真的把端点/模型
// 送进子进程。此前**随包套件对这条主路径零判别力**——把注入整个丢掉、把 agentId 写死成
// "claude"、把坏绑定的 catch 删掉、把 dangling 提示吞掉，聚焦套件都是 9/9 全绿（T10 评审
// 的 M08/M09/M14/M16）。这里用假的可执行文件把子进程真正拉起来，把那条路径钉住。

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agentBin = path.join(packageRoot, "packages", "cli", "scripts", "skills.mjs");

// 子进程侧：把自己收到的 argv 与关心的环境变量写成 JSON。用 node 脚本而不是纯 batch，
// 因为 cmd 的引号/转义规则会让「argv 是否被拆碎」这类断言本身变得不可信。
const PROBE = `
import { writeFileSync } from "node:fs";
const KEYS = ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_MODEL", "AVENIC_MODEL_KEY", "OPENCODE_CONFIG_CONTENT", "AVENIC_LAUNCH_SENTINEL"];
const env = {};
for (const key of KEYS) env[key] = process.env[key] ?? null;
env.PATH = process.env.PATH ?? "";
writeFileSync(process.env.AVENIC_PROBE_FILE, JSON.stringify({ argumentsList: process.argv.slice(2), env }));
`;

// Windows 上 npm 全局安装产出的 agent CLI 就是 .cmd shim，core 的 resolveOnPath 也正是
// 按 .exe/.com/.ps1/.cmd/.bat 的顺序找的——用 .cmd 假件走的就是真实那条路径（含 shell 引号化）。
const SHIM = (probePath) => `@echo off\r\nnode "${probePath}" %*\r\n`;
const POSIX_SHIM = (probePath) => `#!/bin/sh\nexec node "${probePath}" "$@"\n`;

async function withRig(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-launch-cli-"));
  const projectRoot = path.join(root, "project");
  const stateDir = path.join(root, "state");
  const binDir = path.join(root, "bin");
  await mkdir(projectRoot, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  const probePath = path.join(binDir, "probe.mjs");
  await writeFile(probePath, PROBE);
  for (const name of ["claude", "codex", "opencode"]) {
    const shim = process.platform === "win32" ? path.join(binDir, `${name}.cmd`) : path.join(binDir, name);
    await writeFile(shim, process.platform === "win32" ? SHIM(probePath) : POSIX_SHIM(probePath));
    if (process.platform !== "win32") await chmod(shim, 0o755);
  }
  const probeFile = path.join(root, "probe.json");
  const environment = {
    AVENIC_STATE_DIR: stateDir,
    AVENIC_PROBE_FILE: probeFile,
    AVENIC_LAUNCH_SENTINEL: "preserved-9c3f",
    // 假件放最前，其余 PATH 逐字保留——这也是"注入不得吞掉宿主环境"的断言基础
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
  };
  // 宿主机的 ANTHROPIC_*/CLAUDE_* 必须剥掉：开发机自己往往就跑在某个自定义端点上（本机正是），
  // 留着它们则"未绑定/坏绑定 → 不注入"的否定断言永远为假，且断言会随开发机漂移。
  const spawnEnv = { ...sanitizedHostEnv(), ...environment };
  try {
    await run({ projectRoot, environment, spawnEnv, probeFile });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function sanitizedHostEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(?:ANTHROPIC_|CLAUDE_)/.test(key)) continue;
    env[key] = value;
  }
  return env;
}

function launch(spawnEnv, projectRoot, agentId, extra = []) {
  return spawnSync(process.execPath, [agentBin, agentId, ...extra], {
    cwd: projectRoot,
    encoding: "utf8",
    windowsHide: true,
    env: spawnEnv,
  });
}

// 启动日志里会打印库路径等；断言只看子进程收到什么，避免与文案耦合。
async function readProbe(probeFile) {
  return JSON.parse(await readFile(probeFile, "utf8"));
}

const CLAUDE_PROFILE = {
  id: "bound",
  name: "Bound",
  endpoint: { baseUrl: "https://launch-e2e.example/anthropic", api: "anthropic", authField: "ANTHROPIC_AUTH_TOKEN", apiKey: "sk-launch-e2e-1234" },
  models: { main: { id: "launch-e2e-model" } },
};

// 需要 Responses 端点才可注入 Codex：没有 overrides.codex 时 core 会判定不兼容。
const CODEX_PROFILE = {
  id: "codexprof",
  name: "Codex Prof",
  endpoint: { baseUrl: "https://launch-e2e.example/anthropic", api: "anthropic", authField: "ANTHROPIC_AUTH_TOKEN", apiKey: "sk-launch-e2e-1234" },
  overrides: { codex: { baseUrl: "https://launch-e2e.example/v1", api: "openai-responses", authField: "ANTHROPIC_API_KEY", apiKey: "sk-launch-e2e-1234" } },
  models: { main: { id: "launch-e2e-model" } },
};

test("launching a bound Claude project hands the injected endpoint to the child process", async () => {
  await withRig(async ({ projectRoot, spawnEnv, probeFile }) => {
    assert.equal(launch(spawnEnv, projectRoot, "claude", ["init", "--auth", "global", "--sessions", "global"]).status, 0);
    await upsertProfile(spawnEnv, CLAUDE_PROFILE);
    await bindProject(projectRoot, spawnEnv, "bound");

    const run = launch(spawnEnv, projectRoot, "claude");
    assert.equal(run.status, 0, run.stderr);
    const probe = await readProbe(probeFile);

    assert.equal(probe.env.ANTHROPIC_BASE_URL, "https://launch-e2e.example/anthropic");
    assert.equal(probe.env.ANTHROPIC_AUTH_TOKEN, "sk-launch-e2e-1234");
    assert.equal(probe.env.ANTHROPIC_MODEL, "launch-e2e-model");
    // 注入是"合并"进宿主环境，不是替换：哨兵与 PATH 都必须逐字还在（否则终端/CLI 起不来）
    assert.equal(probe.env.AVENIC_LAUNCH_SENTINEL, "preserved-9c3f");
    assert.ok(probe.env.PATH.includes(path.dirname(probeFile)), "假件目录必须仍在 PATH 里");
    assert.ok(probe.env.PATH.includes(process.env.PATH ?? ""), "宿主 PATH 必须逐字保留");
    // Claude 走环境变量，不需要 argv
    assert.deepEqual(probe.argumentsList, [], "Claude 不应收到注入的 argv");
  });
});

test("launching a bound Codex project hands the injected argv to the child process", async () => {
  await withRig(async ({ projectRoot, spawnEnv, probeFile }) => {
    assert.equal(launch(spawnEnv, projectRoot, "codex", ["init", "--auth", "global", "--sessions", "global"]).status, 0);
    await upsertProfile(spawnEnv, CODEX_PROFILE);
    await bindProject(projectRoot, spawnEnv, "codexprof");

    const run = launch(spawnEnv, projectRoot, "codex");
    assert.equal(run.status, 0, run.stderr);
    const probe = await readProbe(probeFile);

    // argv 必须成对且未被 shell 拆碎：含空格的 provider 名整段在同一个元素里
    const pairs = [];
    for (let index = 0; index < probe.argumentsList.length - 1; index += 1) {
      if (probe.argumentsList[index] === "-c") pairs.push(probe.argumentsList[index + 1]);
    }
    assert.ok(pairs.includes("model_provider=avenic_codexprof"), `缺少 model_provider 注入：${probe.argumentsList.join(" ")}`);
    assert.ok(pairs.includes("model_providers.avenic_codexprof.name=Codex Prof"), "含空格的 provider 名必须仍是单个参数");
    assert.ok(pairs.includes("model_providers.avenic_codexprof.base_url=https://launch-e2e.example/v1"));
    assert.ok(pairs.includes("model_providers.avenic_codexprof.wire_api=responses"));
    const modelAt = probe.argumentsList.indexOf("-m");
    assert.ok(modelAt !== -1 && probe.argumentsList[modelAt + 1] === "launch-e2e-model", "-m 与其取值必须是两个独立参数");
    assert.equal(probe.env.AVENIC_MODEL_KEY, "sk-launch-e2e-1234");
    assert.equal(probe.env.AVENIC_LAUNCH_SENTINEL, "preserved-9c3f");
  });
});

test("launching an unbound project injects nothing", async () => {
  await withRig(async ({ projectRoot, spawnEnv, probeFile }) => {
    assert.equal(launch(spawnEnv, projectRoot, "claude", ["init", "--auth", "global", "--sessions", "global"]).status, 0);
    await upsertProfile(spawnEnv, CLAUDE_PROFILE); // 库里有配置，但项目没绑定

    const run = launch(spawnEnv, projectRoot, "claude");
    assert.equal(run.status, 0, run.stderr);
    const probe = await readProbe(probeFile);
    assert.equal(probe.env.ANTHROPIC_BASE_URL, null, "未绑定不得注入端点");
    assert.equal(probe.env.ANTHROPIC_AUTH_TOKEN, null, "未绑定不得注入密钥");
    assert.equal(probe.env.ANTHROPIC_MODEL, null, "未绑定不得注入模型");
    assert.equal(probe.env.AVENIC_LAUNCH_SENTINEL, "preserved-9c3f", "宿主环境照常传给子进程");
  });
});

test("fake agent shims preserve a space-containing user argument on every platform", async () => {
  await withRig(async ({ projectRoot, spawnEnv, probeFile }) => {
    assert.equal(launch(spawnEnv, projectRoot, "opencode", ["init", "--auth", "global", "--sessions", "global"]).status, 0);

    const run = launch(spawnEnv, projectRoot, "opencode", ["--project", "directory with spaces"]);
    assert.equal(run.status, 0, run.stderr);
    const probe = await readProbe(probeFile);
    assert.deepEqual(probe.argumentsList, ["--project", "directory with spaces"]);
    assert.equal(probe.env.AVENIC_LAUNCH_SENTINEL, "preserved-9c3f");
    assert.ok(probe.env.PATH.includes(path.dirname(probeFile)), "fake executable directory must stay on PATH");
  });
});

// spec §13：配置读不出来绝不阻断启动，但也绝不静默。删掉降级 catch 的变异会让这里抛错退出。
test("a corrupt binding still launches the agent and says why injection was skipped", async () => {
  await withRig(async ({ projectRoot, spawnEnv, probeFile }) => {
    assert.equal(launch(spawnEnv, projectRoot, "claude", ["init", "--auth", "global", "--sessions", "global"]).status, 0);
    await upsertProfile(spawnEnv, CLAUDE_PROFILE);
    await bindProject(projectRoot, spawnEnv, "bound");
    await writeFile(path.join(projectRoot, ".agents", "model.json"), "{ not json ");

    const run = launch(spawnEnv, projectRoot, "claude");
    assert.equal(run.status, 0, `坏绑定不得阻断启动：${run.stderr}`);
    assert.match(run.stdout, /Model configuration skipped: /, "必须留下可读原因，不能静默跳过");
    const probe = await readProbe(probeFile);
    assert.equal(probe.env.ANTHROPIC_BASE_URL, null, "读不出配置就不注入");
    assert.equal(probe.env.AVENIC_LAUNCH_SENTINEL, "preserved-9c3f");
  });
});

// dangling：绑定指向已删除的 profile。core 负责安全回滚（幂等），CLI 负责让用户看见原因。
test("a dangling binding rolls back and still launches with a readable message", async () => {
  await withRig(async ({ projectRoot, spawnEnv, probeFile }) => {
    assert.equal(launch(spawnEnv, projectRoot, "claude", ["init", "--auth", "global", "--sessions", "global"]).status, 0);
    await upsertProfile(spawnEnv, { ...CLAUDE_PROFILE, id: "gone" });
    await bindProject(projectRoot, spawnEnv, "gone");
    await removeProfile(spawnEnv, "gone");

    const run = launch(spawnEnv, projectRoot, "claude");
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /no longer exists; Avenic configuration disabled for this project/);
    const probe = await readProbe(probeFile);
    assert.equal(probe.env.ANTHROPIC_BASE_URL, null, "配置已不存在 → 不注入");
  });
});
