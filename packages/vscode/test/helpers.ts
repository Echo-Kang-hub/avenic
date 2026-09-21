import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

// 测试环境隔离：剥离宿主所有 AVENIC_/AGENTHOME_ 变量（读到的用户真机配置不得影响测试），
// 再注入隔离的 AVENIC_STATE_DIR——若省略 stateDir，则返回无任何 Avenic 变量的环境副本。
export function testEnv(stateDir?: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("AVENIC_") || key.startsWith("AGENTHOME_")) continue;
    env[key] = value;
  }
  if (stateDir !== undefined) env.AVENIC_STATE_DIR = stateDir;
  return env;
}

// prepareAgentLaunch / initialize 读真实 process.env（与生产一致），所以夹具把
// Agent 的配置根临时指向临时目录并在结束时还原。1.8.4 之前这件事由启动自己完成
// （project auth 把 CLAUDE_CONFIG_DIR 重定向进项目）——那个重定向正是被修复的 P0，
// 隔离从此必须显式：不隔离，原生快照/还原会落到开发机真实的 ~/.claude。
export async function withAgentHomes<T>(home: string, run: () => Promise<T>): Promise<T> {
  const variables: Record<string, string> = {
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    CODEX_HOME: path.join(home, ".codex"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
  };
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(variables)) {
    saved.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

export async function makeCatalogFixture(root: string): Promise<void> {
  await mkdir(path.join(root, "packs"), { recursive: true });
  await mkdir(path.join(root, "skills", "demo", "alpha"), { recursive: true });
  await mkdir(path.join(root, "skills", "demo", "beta"), { recursive: true });
  await writeFile(path.join(root, "skills", "demo", "alpha", "SKILL.md"), "---\nname: alpha\n---\n");
  await writeFile(path.join(root, "skills", "demo", "beta", "SKILL.md"), "---\nname: beta\n---\n");
  await writeFile(path.join(root, "packs", "common.json"), `${JSON.stringify({ schemaVersion: 1, id: "common", name: "Common", sources: [{ source: "demo", skills: ["alpha"] }] }, null, 2)}\n`);
  // 第二个非 common pack：core 语义下 common 永驻（normalizePackIds 自动注入且卸载时被跳过），
  // 卸载回环须有一个真正可移除的 pack。
  await writeFile(path.join(root, "packs", "extra.json"), `${JSON.stringify({ schemaVersion: 1, id: "extra", name: "Extra", sources: [{ source: "demo", skills: ["beta"] }] }, null, 2)}\n`);
  await writeFile(path.join(root, "sources.lock.json"), `${JSON.stringify({ schemaVersion: 1, sources: [{ id: "demo", name: "Demo", repository: "https://github.com/example/demo.git", skillRoot: "skills", revision: "a".repeat(40) }] }, null, 2)}\n`);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e", "add", "-A"], { cwd: root });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e", "commit", "-qm", "one"], { cwd: root });
}
