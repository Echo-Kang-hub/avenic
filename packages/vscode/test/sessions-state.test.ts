import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { buildSessionsData, DEFAULT_TURN_LIMIT } from "../src/sessions/state.ts";
import { isSessionsViewMessage } from "../src/sessions/protocol.ts";
import { OLDER_ID, SHARED_ID, seedTranscriptProject } from "./fixtures/transcript-project.ts";

// The Sessions page is a reader: what it shows has to be the shared store as
// core reads it, with every turn attributed to whoever actually said it. These
// tests seed a fictional conversation that moved between two agents and check
// the model the webview receives.

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = path.join(packageRoot, "cli", "scripts", "skills.mjs");
// ESC：终端转义序列的起始字符。写成 fromCharCode，源码里就不该出现真正的控制字符。
const ESCAPE = String.fromCharCode(27);

async function withProject(run: (projectRoot: string) => Promise<void>): Promise<void> {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), "avenic-sessions-"));
  try {
    await seedTranscriptProject(projectRoot);
    await run(projectRoot);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
}

test("the active conversation is the one read by default, and an unknown id falls back to it", async () => {
  await withProject(async (projectRoot) => {
    const data = await buildSessionsData(projectRoot);
    assert.equal(data.projectRoot, projectRoot);
    assert.equal(data.activeId, SHARED_ID, "默认读活动会话");
    assert.equal(data.transcript?.session.id, SHARED_ID);
    // 列表行来自 core 的会话记录：标题、计数、更新时间，不解析事件日志。
    assert.deepEqual(data.sessions.map((row) => row.id), [SHARED_ID, OLDER_ID]);
    assert.equal(data.sessions[0]?.title, "Nightly export");
    assert.equal(data.sessions[0]?.events, 4);
    assert.equal(typeof data.sessions[0]?.updatedAt, "string");
    assert.equal(data.sessions[1]?.title, "Report cleanup");
    assert.equal(data.sessions[1]?.events, 0, "空会话的计数是 0，不是 undefined");
    // 已不存在（或干脆是路径）的选择不报错、也不会被当成路径：退回默认。
    assert.equal((await buildSessionsData(projectRoot, { id: "gone-with-the-wind" })).transcript?.session.id, SHARED_ID);
    assert.equal((await buildSessionsData(projectRoot, { id: "../../runtime.json" })).transcript?.session.id, SHARED_ID);
    // 显式点名的会话被读出来。
    const older = await buildSessionsData(projectRoot, { id: OLDER_ID });
    assert.equal(older.transcript?.session.id, OLDER_ID);
    assert.deepEqual(older.transcript?.turns, []);
  });
});

test("every turn carries its speaker: a foreign agent's answer is that agent's, not the user's", async () => {
  await withProject(async (projectRoot) => {
    const { transcript, participants } = await buildSessionsData(projectRoot);
    const turns = transcript!.turns;
    assert.deepEqual(turns.map((turn) => [turn.kind, turn.speaker, turn.agent]), [
      ["user", "You", "claude"],
      ["agent", "Claude", "claude"],
      ["agent", "Codex", "codex"],
    ]);
    assert.deepEqual(participants, ["Claude", "Codex"], "参与者是 core 给出的显示名");
    // 工具流量属于跑它的那一轮，且带上了工具名与目标。
    assert.deepEqual(turns[1]?.tools.map((tool) => [tool.kind, tool.name, tool.detail]), [
      ["call", "Read", "src/exporter.ts"],
      ["result", "result", "exportLedger(accounts): reads ledger.tsv per account"],
    ]);
    assert.equal(turns[1]?.model, "claude-sonnet-5");
    assert.equal(turns[1]?.at, "2026-09-19T09:01:00.000Z");
    // 摘要行要说明每个代理从哪条原生会话回答、游标是否跟上。
    assert.deepEqual(transcript!.session.projections.map((projection) => [projection.label, projection.nativeSessionId, projection.state]), [
      ["Claude", "session-a", "stale"],
      ["Codex", "session-b", "current"],
    ]);
    assert.equal(transcript!.session.events, 4);
    assert.equal(transcript!.session.turns, 3);
  });
});

test("a long conversation is delivered as the newest turns, and never with terminal escapes", async () => {
  await withProject(async (projectRoot) => {
    assert.equal(DEFAULT_TURN_LIMIT, 200);
    const limited = await buildSessionsData(projectRoot, { id: SHARED_ID, limit: 2 });
    assert.deepEqual(limited.transcript!.turns.map((turn) => turn.speaker), ["Claude", "Codex"], "留最新的一段");
    assert.equal(limited.transcript!.session.turns, 3, "总数仍是整段对话");
    // 模型里没有终端转义：颜色是 CSS 的事，数据里一个控制字符都不该有。
    const full = await buildSessionsData(projectRoot, { id: SHARED_ID, limit: 0 });
    assert.equal(JSON.stringify(full).includes(ESCAPE), false);
    assert.equal(JSON.stringify(limited).includes(ESCAPE), false);
  });
});

// 面板渲染的就是 CLI 打的那份 JSON。这条对照跑真正的 CLI（同一个仓库、同一份
// core），任何一侧偷偷改了字段名或措辞都会立刻红。
test("the page's model is what `avenic sessions show --json` prints", async () => {
  await withProject(async (projectRoot) => {
    const data = await buildSessionsData(projectRoot, { limit: 0 });
    const result = spawnSync(process.execPath, [cli, "sessions", "show", SHARED_ID, "--json"], {
      cwd: projectRoot,
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, NO_COLOR: "1" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(data.transcript, JSON.parse(result.stdout));
  });
});

test("the webview can only ask for a session id and a turn limit", () => {
  assert.equal(isSessionsViewMessage({ type: "ready" }), true);
  assert.equal(isSessionsViewMessage({ type: "refresh" }), true);
  assert.equal(isSessionsViewMessage({ type: "select", id: "handoff" }), true);
  assert.equal(isSessionsViewMessage({ type: "limit", limit: 0 }), true);
  // id 只当字符串收下；不认识的选择会被宿主退回默认会话（见上一条），永远不落到路径上。
  assert.equal(isSessionsViewMessage({ type: "select", id: "" }), false);
  assert.equal(isSessionsViewMessage({ type: "limit", limit: -1 }), false);
  assert.equal(isSessionsViewMessage({ type: "limit", limit: "all" }), false);
  assert.equal(isSessionsViewMessage({ type: "command", command: "sessions.open" }), false);
  assert.equal(isSessionsViewMessage(null), false);
});
