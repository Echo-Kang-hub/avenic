import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { collectStatus } from "../packages/core/src/status.mjs";
import {
  appendCanonicalEvents,
  createCanonicalSession,
  getSessionAdapter,
  setActiveCanonicalSession,
  syncNativeMapping,
} from "../packages/core/src/index.mjs";
import { sessionLeasePath } from "../packages/core/src/runtime/sessions.mjs";
import { fakeStdout } from "./helpers/fake-tty.mjs";
import { withClaudeProject } from "./helpers/session-fixture.mjs";

const event = (id, role = "assistant") => ({
  id,
  role,
  createdAt: "2026-09-19T00:00:00.000Z",
  content: [{ type: "text", text: id }],
});

/** Point the project's shared history at a canonical session with a mapping. */
async function seedSharedHistory(projectRoot, mapping) {
  const { id } = await createCanonicalSession(projectRoot, { title: "Status fixture" });
  await appendCanonicalEvents(projectRoot, id, [event(`${id}:1`, "user"), event(`${id}:2`)]);
  if (mapping) await syncNativeMapping(projectRoot, id, { canonicalSessionId: id, ...mapping });
  await setActiveCanonicalSession(projectRoot, id);
  return id;
}

/** A launch group left behind by a launch that never reached its exit path. */
async function withLaunchState(agentId, projectRoot, run) {
  const stateDir = sessionLeasePath(agentId, projectRoot);
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, "snapshot.ok"), "");
  try {
    await run(stateDir);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

test("status describes the project, its agents, and its history from one model", async () => {
  await withClaudeProject(async ({ projectRoot, environment }) => {
    const status = await collectStatus(projectRoot, { environment });
    assert.equal(status.schemaVersion, 1);
    assert.equal(status.project.root, path.resolve(projectRoot));
    assert.equal(status.project.name, path.basename(projectRoot));
    assert.equal(status.project.configured, true);
    assert.deepEqual(status.project.agents, ["claude"]);
    assert.equal(status.history.mode, "shared");
    assert.deepEqual(status.agents.map((agent) => agent.id), ["claude", "codex", "opencode"]);
    const claude = status.agents[0];
    assert.equal(claude.initialized, true);
    assert.equal(claude.auth, "global");
    assert.equal(claude.sessions, "project");
    assert.equal(claude.history.sync, "current");
    assert.equal(claude.history.sessions, 0);
    assert.equal(status.agents[1].initialized, false);
    assert.equal(status.agents[1].history.sync, "none");
    // Serialisable: the extension and `--json` read this object unchanged.
    assert.deepEqual(JSON.parse(JSON.stringify(status)), status);
  });
});

test("status counts the sessions the project holds for each agent", async () => {
  await withClaudeProject(async ({ projectRoot, environment, sessionIds }) => {
    await seedSharedHistory(projectRoot, { agentId: "claude", nativeSessionId: sessionIds[0] });
    await getSessionAdapter("claude").capture(projectRoot, { environment });
    const status = await collectStatus(projectRoot, { environment });
    assert.equal(status.agents[0].history.sessions, sessionIds.length);
    assert.equal(status.history.sessions, 1);
    assert.equal(status.history.activeTitle, "Status fixture");
    assert.equal(status.history.activeEvents, 2);
    assert.equal(status.history.activeLastEventId.endsWith(":2"), true);
  });
});

test("a projection behind its canonical events reads as stale", async () => {
  await withClaudeProject(async ({ projectRoot, environment, sessionIds }) => {
    await seedSharedHistory(projectRoot, {
      agentId: "claude",
      nativeSessionId: sessionIds[0],
      lastCanonicalEventId: "an-event-that-is-not-the-last-one",
    });
    const status = await collectStatus(projectRoot, { environment });
    assert.equal(status.agents[0].history.sync, "stale");
  });
});

test("history the project expects but does not hold reads as missing", async () => {
  await withClaudeProject(async ({ projectRoot, environment, sessionIds }) => {
    const canonicalId = await seedSharedHistory(projectRoot, { agentId: "claude", nativeSessionId: sessionIds[0] });
    // The mapping names the last canonical event, so nothing is behind; the
    // project simply holds no copy of the session the mapping points at.
    const stored = JSON.parse(await readFile(path.join(projectRoot, ".agents", "sessions", "canonical", canonicalId, "session.json"), "utf8"));
    await syncNativeMapping(projectRoot, canonicalId, {
      agentId: "claude",
      nativeSessionId: sessionIds[0],
      lastCanonicalEventId: stored.lastEventId,
    });
    const status = await collectStatus(projectRoot, { environment });
    assert.equal(status.agents[0].history.sync, "missing");
  });
});

test("a launch that never finished reads as dirty, a live one as running", async () => {
  await withClaudeProject(async ({ projectRoot, environment }) => {
    await withLaunchState("claude", projectRoot, async (stateDir) => {
      const interrupted = await collectStatus(projectRoot, { environment });
      assert.equal(interrupted.agents[0].history.sync, "dirty");
      assert.equal(interrupted.agents[0].history.launchGroup, "interrupted");
      await mkdir(path.join(stateDir, "pids"), { recursive: true });
      await writeFile(path.join(stateDir, "pids", `${process.pid}-1-0`), "");
      const running = await collectStatus(projectRoot, { environment });
      assert.equal(running.agents[0].history.sync, "running");
      assert.equal(running.agents[0].history.launchGroup, "running");
    });
  });
});

test("a completed launch group reads as idle even though its snapshot remains", async () => {
  await withClaudeProject(async ({ projectRoot, environment }) => {
    await withLaunchState("claude", projectRoot, async (stateDir) => {
      await writeFile(path.join(stateDir, "snapshot.clean"), "");
      const status = await collectStatus(projectRoot, { environment });
      assert.equal(status.agents[0].history.launchGroup, "idle");
      assert.equal(status.agents[0].history.sync, "current");
    });
  });
});

test("an agent whose CLI is not installed is still described", async () => {
  await withClaudeProject(async ({ projectRoot, environment }) => {
    const status = await collectStatus(projectRoot, { environment: { ...environment, PATH: "", Path: "" } });
    assert.equal(status.agents[0].available, false);
    assert.equal(status.agents[0].command, "claude");
    assert.equal(status.agents[0].initialized, true);
    assert.equal(status.skills.project.state, "none");
  });
});

test("status reads no Hub and runs no git when this machine has no cache", async () => {
  await withClaudeProject(async ({ projectRoot, environment }) => {
    const calls = path.join(projectRoot, "git-calls");
    const shim = path.join(environment.AVENIC_STATE_DIR, "..", "git-shim");
    await mkdir(shim, { recursive: true });
    const recorder = path.join(shim, "git.mjs");
    await writeFile(recorder, `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(calls)}, "git\\n");\nprocess.exit(1);\n`);
    await writeFile(path.join(shim, "git.cmd"), `@echo off\r\n"${process.execPath}" "${recorder}" %*\r\n`);
    const status = await collectStatus(projectRoot, {
      environment: { ...environment, PATH: `${shim}${path.delimiter}${environment.PATH}` },
    });
    assert.equal(status.skills.hub.cache, "missing");
    assert.equal(status.skills.hub.name, "Echo-Kang-hub/SkillsHub");
    assert.equal(status.skills.hub.revision, null);
    await assert.rejects(readFile(calls, "utf8"), "status must not shell out to git");
  });
});

test("the missing remedy is a command the project's mode can actually run", async () => {
  // `avenic sessions continue` 会拒绝 isolated 项目（它按定义要用共享历史），而
  // `missing` 在 isolated 项目里同样会出现。状态行给的是「下一步跑什么」，那就
  // 不能把用户指向一个当场就报错的命令。
  const { renderStatus } = await import("../packages/cli/src/cli/status-cli.mjs");
  const render = (mode) => {
    const lines = [];
    const status = {
      project: { root: "/tmp/avenic-status", name: "avenic-status", agents: ["claude"] },
      history: { mode, sessions: 1, active: null, updatedAt: null },
      agents: [{
        id: "claude",
        displayName: "Claude Code",
        command: "claude",
        available: true,
        initialized: true,
        auth: "subscription",
        sessions: 2,
        history: { sync: "missing" },
      }],
      skills: { project: { state: "none" }, global: { state: "none" }, hub: { configured: false } },
    };
    renderStatus(status, { log: (line) => lines.push(line) }, {
      stdout: fakeStdout({ columns: 120, isTTY: false }),
      environment: { NO_COLOR: "1" },
    });
    return lines.join("\n");
  };

  const isolated = render("isolated");
  const shared = render("shared");
  assert.match(isolated, /Claude Code: missing —/, "the note is the one under test");
  assert.doesNotMatch(
    isolated,
    /missing — run: avenic sessions continue/,
    "an isolated project is told to run a command that refuses there",
  );
  assert.match(isolated, /run: avenic sessions sync/, "the mode-independent import still leads");
  assert.match(shared, /run: avenic sessions continue <id> --agent <agent>/, "shared mode can rebuild it");
});
