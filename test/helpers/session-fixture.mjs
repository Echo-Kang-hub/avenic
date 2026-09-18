// Shared fixture for the session tests: a temp HOME with real-shaped native
// history, a temp project, a valid runtime config and a fake agent binary, so
// every launch, capture and recovery test exercises the production paths.
import { spawn, spawnSync } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function claudeProjectKey(projectRoot) {
  return path.resolve(projectRoot).replace(/[^a-zA-Z0-9]/g, "-");
}

// One record shaped like a real Claude Code transcript line.
export function claudeRecord(sessionId, index, cwd) {
  return JSON.stringify({
    type: index % 2 === 0 ? "user" : "assistant",
    uuid: `uuid-${sessionId}-${index}`,
    sessionId,
    timestamp: new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString(),
    cwd,
    message: {
      role: index % 2 === 0 ? "user" : "assistant",
      model: "claude-sonnet-5",
      content: [{ type: "text", text: `message ${index}` }],
    },
  });
}

export function codexRecord(sessionId, index, cwd) {
  if (index === 0) {
    return JSON.stringify({ type: "session_meta", payload: { id: sessionId, cwd, model_provider: "openai" } });
  }
  return JSON.stringify({
    timestamp: new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString(),
    type: "response_item",
    payload: {
      id: `payload-${sessionId}-${index}`,
      type: "message",
      role: index % 2 === 1 ? "user" : "assistant",
      content: [{ type: "input_text", text: `codex message ${index}` }],
    },
  });
}

async function writeRuntime(projectRoot, agents, sessionInterop) {
  await mkdir(path.join(projectRoot, ".agents"), { recursive: true });
  await writeFile(
    path.join(projectRoot, ".agents", "runtime.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      agents: Object.fromEntries(Object.entries(agents).map(([id, config]) => [id, { enabled: true, ...config }])),
      sessionInterop,
    }, null, 2)}\n`,
  );
}

// The stand-in agent records what the project looked like at the instant the
// official TUI would have appeared, so a launch test can assert what Avenic
// did and did not do on the critical path.
async function writeFakeAgent(bin, name) {
  await mkdir(bin, { recursive: true });
  const target = path.join(bin, `${name}.mjs`);
  await writeFile(target, `import { appendFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
const startedAt = Date.now();
const probe = process.env.AVENIC_AGENT_PROBE;
const canonical = path.join(process.cwd(), ".agents", "sessions", "canonical");
const snapshot = () => { try { return readdirSync(canonical); } catch { return []; } };
if (probe) {
  mkdirSync(path.dirname(probe), { recursive: true });
  writeFileSync(probe, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), canonical: snapshot(), startedAt }));
}
// AVENIC_AGENT_WRITE lets a test drive a live agent: the file a working agent
// is appending to, how many records, and how long to stay alive afterwards.
if (process.env.AVENIC_AGENT_WRITE) {
  const { file, records, sleepMs } = JSON.parse(process.env.AVENIC_AGENT_WRITE);
  const lines = [];
  for (let i = 0; i < records; i += 1) {
    lines.push(JSON.stringify({
      type: i % 2 === 0 ? "assistant" : "user",
      uuid: \`live-\${i}\`,
      sessionId: path.basename(file, ".jsonl"),
      timestamp: new Date(Date.UTC(2026, 5, 1) + i * 1000).toISOString(),
      cwd: process.cwd(),
      message: { role: i % 2 === 0 ? "assistant" : "user", model: "claude-sonnet-5", content: [{ type: "text", text: \`live message \${i}\` }] },
    }));
  }
  appendFileSync(file, \`\${lines.join("\\n")}\\n\`);
  if (sleepMs) {
    if (probe) writeFileSync(probe, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), canonical: snapshot(), startedAt, wroteAt: Date.now() }));
    await new Promise((resolve) => setTimeout(resolve, sleepMs));
  }
}
process.exit(0);
`);
  if (process.platform === "win32") {
    await writeFile(path.join(bin, `${name}.cmd`), `@echo off\r\n"${process.execPath}" "${target}" %*\r\n`);
  } else {
    const script = path.join(bin, name);
    await writeFile(script, `#!/bin/sh\nexec "${process.execPath}" "${target}" "$@"\n`, { mode: 0o755 });
  }
}

/**
 * A stand-in `opencode` that answers the session commands a capture uses and
 * records every invocation. OpenCode is the one agent whose history is only
 * reachable through its CLI, so "did anything move?" has to be asked rather
 * than stat'ed; this fake is how a test proves the asking stays cheap. It also
 * answers the shapes a continuation uses — `import`, `debug config`, and the
 * interactive CLI itself (`--session`, `--prompt`) — because OpenCode is the
 * only agent whose launches are also its storage API.
 */
async function writeOpenCodeCli(bin, stateFile, logFile) {
  await mkdir(bin, { recursive: true });
  const target = path.join(bin, "opencode.mjs");
  await writeFile(target, `import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const log = ${JSON.stringify(logFile)};
const state = () => JSON.parse(readFileSync(${JSON.stringify(stateFile)}, "utf8"));
const save = (value) => writeFileSync(${JSON.stringify(stateFile)}, \`\${JSON.stringify(value, null, 2)}\\n\`);
const [command, ...rest] = process.argv.slice(2);
appendFileSync(log, \`\${[command, ...rest].join(" ")}\\n\`);
// The official interactive CLI. Avenic starts it with --session to continue a
// projected session, or with --prompt to start a fresh one from a handoff.
if (command?.startsWith("--")) {
  const current = state();
  if (command === "--session") {
    if (current.failContinue) {
      process.stderr.write("Error: the selected session could not be started\\n");
      process.exit(1);
    }
    process.exit(0);
  }
  if (command === "--prompt") {
    const id = current.nextSessionId ?? "ses_bootstrap";
    const created = Date.now();
    current.sessions.push({ id, created, updated: created, directory: process.cwd() });
    current.exports[id] = JSON.stringify({
      id,
      messages: [{ info: { id: \`\${id}-0-user\`, role: "user", time: { created } }, parts: [{ type: "text", text: rest[0] ?? "" }] }],
    });
    save(current);
    process.exit(0);
  }
  process.exit(0);
}
if (command === "session" && rest[0] === "list") {
  process.stdout.write(JSON.stringify(state().sessions ?? []));
  process.exit(0);
}
if (command === "export") {
  process.stdout.write(state().exports?.[rest[0]] ?? "{}");
  process.exit(0);
}
// A projection is created by OpenCode itself: importing the envelope makes the
// session real, exactly as it does on a machine whose OpenCode accepted it.
if (command === "import") {
  const current = state();
  const payload = JSON.parse(readFileSync(rest[0], "utf8"));
  const created = Date.now();
  current.sessions.push({ id: payload.info.id, title: payload.info.title, created, updated: created, directory: payload.info.directory ?? process.cwd() });
  current.exports[payload.info.id] = JSON.stringify(payload);
  save(current);
  process.exit(0);
}
if (command === "debug" && rest[0] === "config") {
  process.stdout.write(JSON.stringify(state().config ?? { $schema: "https://opencode.ai/config.json" }));
  process.exit(0);
}
process.exit(0);
`);
  if (process.platform === "win32") {
    await writeFile(path.join(bin, "opencode.cmd"), `@echo off\r\n"${process.execPath}" "${target}" %*\r\n`);
  } else {
    await writeFile(path.join(bin, "opencode"), `#!/bin/sh\nexec "${process.execPath}" "${target}" "$@"\n`, { mode: 0o755 });
  }
}

// A minimal but real-shaped export: one user and one assistant message per
// turn, which is what the adapter reads back as canonical events.
function openCodeExport(id, turn) {
  const messages = [];
  for (let index = 0; index < turn; index += 1) {
    for (const role of ["user", "assistant"]) {
      messages.push({
        info: {
          id: `${id}-${index}-${role}`,
          role,
          time: { created: Date.UTC(2026, 0, 1) + index * 1000 },
          modelID: "gpt-5",
          providerID: "openai",
        },
        parts: [{ type: "text", text: `${role} turn ${index}` }],
      });
    }
  }
  return JSON.stringify({ id, messages });
}

/**
 * A project whose only agent is OpenCode, plus the state its CLI reads. The
 * caller drives OpenCode by editing that state, the way a real agent would.
 */
export async function withOpenCodeProject(run, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-opencode-fixture-"));
  const home = path.join(root, "home");
  const projectRoot = path.join(root, "project");
  const bin = path.join(root, "bin");
  const stateFile = path.join(root, "opencode-state.json");
  const logFile = path.join(root, "opencode-invocations.log");
  await mkdir(home, { recursive: true });
  await mkdir(path.join(projectRoot, ".agents"), { recursive: true });
  await writeOpenCodeCli(bin, stateFile, logFile);

  const inheritedPath = process.env.PATH ?? process.env.Path ?? "";
  const environment = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    AVENIC_STATE_DIR: path.join(root, "state"),
    PATH: `${bin}${path.delimiter}${inheritedPath}`,
    Path: `${bin}${path.delimiter}${inheritedPath}`,
  };

  const sessions = new Map();
  const state = { config: { $schema: "https://opencode.ai/config.json" }, failContinue: false, nextSessionId: "ses_bootstrap" };
  // OpenCode reports a session's revision as a flat millisecond timestamp
  // (`updated`), not as a nested time object — the fixture answers the shape
  // the installed CLI actually prints.
  const writeState = async () => writeFile(stateFile, `${JSON.stringify({
    ...state,
    sessions: [...sessions.entries()].map(([id, session]) => ({ id, directory: projectRoot, created: session.created, updated: session.updated })),
    exports: Object.fromEntries([...sessions].map(([id, session]) => [id, session.exported])),
  }, null, 2)}\n`);
  await writeState();

  const helpers = {
    root,
    home,
    projectRoot,
    environment,
    portableRoot: path.join(projectRoot, ".agents", "sessions", "opencode"),

    /** Add a session the way OpenCode would: it exists, then it grows. */
    async createSession(id = `ses_${sessions.size}`, { updated = 1 } = {}) {
      sessions.set(id, { created: updated, updated, exported: openCodeExport(id, 1) });
      await writeState();
      return id;
    },
    /** A turn happened: OpenCode's own revision for the session moves. */
    async appendTurn(id, turn) {
      const session = sessions.get(id);
      session.updated = turn;
      session.exported = openCodeExport(id, turn);
      await writeState();
    },
    async removeSession(id) {
      sessions.delete(id);
      await writeState();
    },
    /** An OpenCode build that does not report a session revision at all. */
    async forgetSessionRevision(id) {
      sessions.get(id).updated = undefined;
      await writeState();
    },
    /** What `opencode debug config` resolves to — the model the user chose. */
    async setConfiguredModel(model) {
      state.config = { ...state.config, model };
      await writeState();
    },
    /** A projection OpenCode imports but cannot start (a model it lacks). */
    async failProjectedContinue() {
      state.failContinue = true;
      await writeState();
    },
    /** The session the next fresh `--prompt` launch should create. */
    async setNextSessionId(id) {
      state.nextSessionId = id;
      await writeState();
    },
    /** Every `opencode <command>` this fixture has answered. */
    async invocations() {
      return (await readFile(logFile, "utf8").catch(() => "")).split("\n").filter(Boolean);
    },

    /** Run the real CLI in this project with the fixture environment. */
    runCli(argumentsList, overrides = {}) {
      return spawnSync(
        process.execPath,
        [path.join(packageRoot, "packages", "cli", "scripts", "skills.mjs"), ...argumentsList],
        { cwd: projectRoot, env: { ...environment, ...overrides }, encoding: "utf8" },
      );
    },

    /** Start the official agent itself, the way Avenic hands it a user's tty. */
    launchAgent(argumentsList, overrides = {}) {
      const windows = process.platform === "win32";
      return spawnSync(
        windows ? `"${path.join(bin, "opencode.cmd")}" ${argumentsList.join(" ")}` : path.join(bin, "opencode"),
        windows ? [] : argumentsList,
        { cwd: projectRoot, env: { ...environment, ...overrides }, encoding: "utf8", shell: windows },
      );
    },
    async resetInvocations() {
      await writeFile(logFile, "");
    },
  };

  try {
    await run(helpers);
  } finally {
    await removeTree(root);
  }
}

/**
 * Build a temp HOME + project, seed native Claude history for this workspace,
 * and hand the caller a set of helpers. Always removes the tree afterwards.
 */
export async function withClaudeProject(run, options = {}) {
  const sessions = options.sessions ?? 2;
  const records = options.records ?? 4;
  const agents = options.agents ?? { claude: { auth: "global", sessions: "project" } };
  const sessionInterop = options.sessionInterop ?? "shared";
  // A real machine holds other workspaces' history too. Those sessions must be
  // recognised as foreign, which is the only part of discovery whose cost grows
  // with the size of the machine rather than the size of this project.
  const otherWorkspaces = options.otherWorkspaces ?? { projects: 0, sessions: 0 };

  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-session-fixture-"));
  const home = path.join(root, "home");
  const projectRoot = path.join(root, "project");
  const bin = path.join(root, "bin");
  const stateDir = path.join(root, "state");
  const claudeHome = path.join(home, ".claude");
  const nativeRoot = path.join(claudeHome, "projects", claudeProjectKey(projectRoot));
  const codexHome = path.join(home, ".codex");
  await mkdir(nativeRoot, { recursive: true });
  await mkdir(path.join(projectRoot, ".agents"), { recursive: true });
  for (const name of ["claude", "codex", "opencode"]) await writeFakeAgent(bin, name);

  const inheritedPath = process.env.PATH ?? process.env.Path ?? "";
  const environment = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: claudeHome,
    CODEX_HOME: codexHome,
    AVENIC_STATE_DIR: stateDir,
    PATH: `${bin}${path.delimiter}${inheritedPath}`,
    Path: `${bin}${path.delimiter}${inheritedPath}`,
  };

  const sessionIds = [];
  for (let index = 0; index < sessions; index += 1) {
    const sessionId = `11111111-2222-3333-4444-${String(index).padStart(12, "0")}`;
    sessionIds.push(sessionId);
    await writeFile(
      path.join(nativeRoot, `${sessionId}.jsonl`),
      `${Array.from({ length: records }, (_, i) => claudeRecord(sessionId, i, projectRoot)).join("\n")}\n`,
    );
  }
  let foreignSessions = 0;
  for (let project = 0; project < otherWorkspaces.projects; project += 1) {
    const directory = path.join(claudeHome, "projects", `-other-workspace-${project}`);
    await mkdir(directory, { recursive: true });
    const cwd = `C:\\other\\workspace-${project}`;
    for (let index = 0; index < otherWorkspaces.sessions; index += 1) {
      const sessionId = `other-${project}-${index}`;
      foreignSessions += 1;
      await writeFile(
        path.join(directory, `${sessionId}.jsonl`),
        `${Array.from({ length: records }, (_, i) => claudeRecord(sessionId, i, cwd)).join("\n")}\n`,
      );
    }
  }
  await writeRuntime(projectRoot, agents, sessionInterop);

  const helpers = {
    root,
    home,
    bin,
    projectRoot,
    nativeRoot,
    codexHome,
    environment,

    sessionIds,
    foreignSessions,
    nativeFile: (sessionId) => path.join(nativeRoot, `${sessionId}.jsonl`),
    portableFile: (sessionId) => path.join(projectRoot, ".agents", "sessions", "claude", `${sessionId}.jsonl`),
    canonicalDirectory: (canonicalId) => path.join(projectRoot, ".agents", "sessions", "canonical", canonicalId),

    /** Append records to an existing native session, like a live agent would. */
    async appendRecords(sessionId, count, from = records) {
      const lines = Array.from({ length: count }, (_, i) => claudeRecord(sessionId, from + i, projectRoot));
      await appendFile(path.join(nativeRoot, `${sessionId}.jsonl`), `${lines.join("\n")}\n`);
    },

    /** A brand-new native session that no capture has ever seen. */
    async createUnmappedSession(count, id = `99999999-2222-3333-4444-${String(Date.now()).slice(-12)}`) {
      await writeFile(
        path.join(nativeRoot, `${id}.jsonl`),
        `${Array.from({ length: count }, (_, i) => claudeRecord(id, i, projectRoot)).join("\n")}\n`,
      );
      return id;
    },

    /** Leave a half-written final record, the shape a live writer produces. */
    async truncateTail(sessionId) {
      const file = path.join(nativeRoot, `${sessionId}.jsonl`);
      await appendFile(file, '{"type":"assistant","uuid":"torn');
    },

    /** The launch group's native isolation: snapshot before, revert after. */
    async snapshotAndRevert(agent = "claude") {
      const { getSessionAdapter } = await import("../../packages/core/src/runtime/adapters/index.mjs");
      const adapter = getSessionAdapter(agent);
      const snapshotRoot = path.join(root, "snapshot");
      await adapter.snapshotNative(projectRoot, snapshotRoot, { environment });
      await adapter.revertNative(snapshotRoot, projectRoot, { environment });
    },

    /** Every native byte, for asserting that Avenic never rewrites it. */
    async nativeSnapshot() {
      const snapshot = {};
      for (const entry of await readdir(nativeRoot)) {
        snapshot[entry] = await readFile(path.join(nativeRoot, entry), "utf8");
      }
      return snapshot;
    },

    async nativeStat(sessionId) {
      return stat(path.join(nativeRoot, `${sessionId}.jsonl`));
    },

    /** Run the real CLI in this project with the fixture environment. */
    runCli(argumentsList, overrides = {}) {
      return spawnSync(
        process.execPath,
        [path.join(packageRoot, "packages", "cli", "scripts", "skills.mjs"), ...argumentsList],
        { cwd: projectRoot, env: { ...environment, ...overrides }, encoding: "utf8" },
      );
    },

    /**
     * Start a launch without waiting for it, so a test can watch what Avenic
     * does while the agent is still running.
     */
    async launchAsync(argumentsList, overrides = {}) {
      const probe = path.join(projectRoot, ".agent-probe.json");
      await rm(probe, { force: true });
      const startedAt = Date.now();
      const child = spawn(
        process.execPath,
        [path.join(packageRoot, "packages", "cli", "scripts", "skills.mjs"), ...argumentsList],
        { cwd: projectRoot, env: { ...environment, ...overrides, AVENIC_AGENT_PROBE: probe }, stdio: "ignore" },
      );
      const completion = new Promise((resolve) => {
        child.on("exit", (status) => resolve({ status, elapsedMs: Date.now() - startedAt }));
      });
      return {
        child,
        completion,
        elapsedMs: () => Date.now() - startedAt,
        async probe() {
          try {
            return JSON.parse(await readFile(probe, "utf8"));
          } catch {
            return null;
          }
        },
      };
    },

    /**
     * Run a launch and report both what the agent saw at spawn time and how
     * long the wrapper took to get there.
     */
    async launch(argumentsList) {
      const probe = path.join(projectRoot, ".agent-probe.json");
      await rm(probe, { force: true });
      const startedAt = Date.now();
      const started = process.hrtime.bigint();
      const result = helpers.runCli(argumentsList, { AVENIC_AGENT_PROBE: probe });
      let observed = null;
      try {
        observed = JSON.parse(await readFile(probe, "utf8"));
      } catch {}
      return {
        ...result,
        elapsedMs: Number(process.hrtime.bigint() - started) / 1e6,
        // What a user actually waits for: the delay before the official agent
        // process starts, not the wrapper's total lifetime (which includes the
        // capture that runs after the agent exits).
        toAgentMs: observed?.startedAt ? observed.startedAt - startedAt : null,
        probe: observed,
      };
    },
  };

  try {
    await run(helpers);
  } finally {
    await removeTree(root);
  }
}

// Launches may leave a detached watchdog that finishes the run's bookkeeping
// after the CLI process is gone, so a temp tree can still be written to while
// it is being removed. Windows reports that as ENOTEMPTY/EBUSY/EPERM, which is
// always transient here: retry until the writer is done.
export async function removeTree(root, attempts = 10) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      return;
    } catch (error) {
      if (attempt >= attempts || !["ENOTEMPTY", "EBUSY", "EPERM", "EACCES"].includes(error.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100 * attempt));
    }
  }
}
