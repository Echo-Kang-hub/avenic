import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { initializeAgent, readCanonicalSession } from "@avenic/core";
import { invalidateAgentStatusCache } from "../src/services/agents.ts";
import { continueSession } from "../src/services/continue.ts";
import { testEnv, withAgentHomes } from "./helpers.ts";
import { SHARED_ID, seedTranscriptProject } from "./fixtures/transcript-project.ts";

// 「继续」的验收点是它真的把话说回去了：一次继续之后，共享历史里必须多出目标
// agent 这一轮说的话，而且这条对话从此有一个稳定的原生会话。
//
// 假 CLI 只做真 CLI 用同样参数会做的事：按 --resume/--session-id 里的 id 往自己的
// 原生存储写一条记录。它不认识 Avenic，也不需要认识——插件不解析 agent 的输出，
// 只问 adapter 要这条会话。

async function appendNativeTurn(home: string, projectRoot: string, sessionId: string, text: string, index: number): Promise<void> {
  const directory = path.join(home, "projects", "fixture-project");
  await mkdir(directory, { recursive: true });
  const line = JSON.stringify({
    type: "user",
    uuid: `fixture-${index}`,
    sessionId,
    timestamp: new Date(Date.UTC(2026, 8, 20, 10, index)).toISOString(),
    cwd: projectRoot,
    message: { role: "user", model: "claude-sonnet-5", content: [{ type: "text", text }] },
  });
  const file = path.join(directory, `${sessionId}.jsonl`);
  const existing = await readFile(file, "utf8").catch(() => "");
  await writeFile(file, `${existing}${line}\n`);
}

// 真 CLI 的参数里就写着它要打开（或新建）哪条会话；假 CLI 照着写。
function sessionIdFrom(command: string): string {
  const match = command.match(/--(?:resume|session-id)\s+(\S+)/);
  assert.notEqual(match, null, `启动参数里必须带着要打开的那条会话：${command}`);
  return match![1].replace(/^["']|["']$/g, "");
}

async function preparedProject(root: string): Promise<string> {
  const project = path.join(root, "project");
  await mkdir(project, { recursive: true });
  await seedTranscriptProject(project);
  await initializeAgent(project, "claude", { authMethod: "account", accountScope: "global", sessionScope: "project" });
  invalidateAgentStatusCache();
  return project;
}

test("continuing a shared session writes the target's new turn back into it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-continue-"));
  const home = path.join(root, "home");
  try {
    await withAgentHomes(home, async () => {
      const project = await preparedProject(root);
      const before = (await readCanonicalSession(project, SHARED_ID)).events.length;
      const runs: string[] = [];

      const result = await continueSession(project, SHARED_ID, "claude", {
        run: async (definition) => {
          runs.push(definition.command);
          await appendNativeTurn(path.join(home, ".claude"), project, sessionIdFrom(definition.command), "index the ledger before the loop", runs.length);
          return 0;
        },
      });

      assert.equal(runs.length, 1, "一次继续只启动一次 agent");
      assert.ok(result.nativeSessionId.length > 0);
      const after = await readCanonicalSession(project, SHARED_ID);
      assert.ok(after.events.length > before, "agent 这一轮说的话回到了共享历史里");
      const added = after.events.slice(before);
      assert.ok(added.some((event) => event.role === "user" && JSON.stringify(event.content).includes("index the ledger before the loop")));
      assert.equal(after.mappings.projections.claude.nativeSessionId, result.nativeSessionId, "映射落在刚刚跑过的那条原生会话上");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the same conversation always opens the same native session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-continue-"));
  const home = path.join(root, "home");
  try {
    await withAgentHomes(home, async () => {
      const project = await preparedProject(root);
      const targets: string[] = [];
      const run = async (definition: { command: string }): Promise<number> => {
        const sessionId = sessionIdFrom(definition.command);
        targets.push(sessionId);
        await appendNativeTurn(path.join(home, ".claude"), project, sessionId, `turn ${targets.length}`, targets.length);
        return 0;
      };

      const first = await continueSession(project, SHARED_ID, "claude", { run });
      const second = await continueSession(project, SHARED_ID, "claude", { run });

      assert.equal(targets.length, 2);
      assert.equal(targets[0], targets[1], "第二次继续打开的是同一条原生会话，不是新开一条");
      assert.equal(first.nativeSessionId, second.nativeSessionId);
      const session = await readCanonicalSession(project, SHARED_ID);
      assert.ok(session.events.some((event) => JSON.stringify(event.content).includes("turn 2")));
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a launch the agent refuses fails by name and captures nothing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-continue-"));
  const home = path.join(root, "home");
  try {
    await withAgentHomes(home, async () => {
      const project = await preparedProject(root);
      const before = (await readCanonicalSession(project, SHARED_ID)).events.length;
      await assert.rejects(
        continueSession(project, SHARED_ID, "claude", { run: async () => 1 }),
        /Claude Code exited with status 1/,
      );
      const after = await readCanonicalSession(project, SHARED_ID);
      // 准备阶段确实把共享历史投影成了一条原生会话（映射因此变真），但那一次
      // 没有跑起来，所以共享历史里一个字都不该多。
      assert.equal(after.events.length, before, "没跑成就不该有半截捕获进历史");
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a terminal that never opens surfaces its own failure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-continue-"));
  const home = path.join(root, "home");
  try {
    await withAgentHomes(home, async () => {
      const project = await preparedProject(root);
      await assert.rejects(
        continueSession(project, SHARED_ID, "claude", { run: async () => { throw new Error("terminal could not open"); } }),
        /terminal could not open/,
      );
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// Account · Project hands the run the project's own home, so that is where the
// agent reads and writes. The projection this continuation builds and the turn
// this run leaves behind must be read back from that same home — and the
// machine's `~/.claude` must stay out of it, or the conversation the user sees
// continuing is not the one that ran.
test("continuing under Account · Project reads and writes the project's own home", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-continue-"));
  const home = path.join(root, "home");
  try {
    await withAgentHomes(home, async () => {
      const project = path.join(root, "project");
      await mkdir(project, { recursive: true });
      await seedTranscriptProject(project);
      await initializeAgent(project, "claude", { authMethod: "account", accountScope: "project", sessionScope: "project" });
      invalidateAgentStatusCache();
      const before = (await readCanonicalSession(project, SHARED_ID)).events.length;

      const result = await continueSession(project, SHARED_ID, "claude", {
        run: async (definition) => {
          // 真 CLI 在项目自己的 home 里写这一轮：这正是启动环境给它的那份。
          await appendNativeTurn(path.join(project, ".agents", "local", "claude"), project, sessionIdFrom(definition.command), "read the project's ledger, not the machine's", 1);
          return 0;
        },
      });

      assert.ok(result.nativeSessionId.length > 0);
      const after = await readCanonicalSession(project, SHARED_ID);
      assert.ok(
        after.events.some((event) => event.role === "user" && JSON.stringify(event.content).includes("read the project's ledger, not the machine's")),
        "agent 这一轮说的话回到了共享历史里（从项目自己的 home 读回来的）",
      );
      assert.equal(after.events.length > before, true);
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
