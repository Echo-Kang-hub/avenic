// The measurement fixture both performance harnesses share: a temp HOME with
// real-shaped native history, a temp project, an isolated state directory, and
// a PATH that puts a stub of every agent first. Kept in one place so the two
// harnesses cannot drift apart in what they measure.
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

export function claudeProjectKey(projectRoot) {
  return path.resolve(projectRoot).replace(/[^a-zA-Z0-9]/g, "-");
}

export function claudeRecord(sessionId, index, cwd) {
  return {
    type: "assistant",
    uuid: `uuid-${sessionId}-${index}`,
    sessionId,
    timestamp: new Date(1700000000000 + index * 1000).toISOString(),
    cwd,
    message: {
      role: index % 2 === 0 ? "user" : "assistant",
      model: "claude-sonnet-5",
      content: [{ type: "text", text: `message ${index} ${"x".repeat(200)}` }],
    },
  };
}

export function codexRecord(index, cwd) {
  return {
    timestamp: new Date(1700000000000 + index * 1000).toISOString(),
    type: "response_item",
    payload: {
      id: `p-${index}`,
      cwd,
      type: "message",
      role: index % 2 === 0 ? "user" : "assistant",
      content: [{ type: "input_text", text: `codex ${index} ${"y".repeat(200)}` }],
    },
  };
}

async function seedClaude(home, projectRoot, sessions, records, foreignProjects) {
  const dir = path.join(home, ".claude", "projects", claudeProjectKey(projectRoot));
  await mkdir(dir, { recursive: true });
  for (let s = 0; s < sessions; s += 1) {
    const sessionId = `11111111-2222-3333-4444-${String(s).padStart(12, "0")}`;
    const lines = [];
    for (let i = 0; i < records; i += 1) lines.push(JSON.stringify(claudeRecord(sessionId, i, projectRoot)));
    await writeFile(path.join(dir, `${sessionId}.jsonl`), `${lines.join("\n")}\n`);
  }
  // Other projects' history: it must cost nothing to skip.
  for (let s = 0; s < foreignProjects; s += 1) {
    const other = path.join(home, ".claude", "projects", `-other-project-${s}`);
    await mkdir(other, { recursive: true });
    const lines = [];
    for (let i = 0; i < 50; i += 1) lines.push(JSON.stringify(claudeRecord(`other-${s}`, i, `C:\\other\\${s}`)));
    await writeFile(path.join(other, `other-${s}.jsonl`), `${lines.join("\n")}\n`);
  }
}

async function seedCodex(home, projectRoot, rollouts) {
  const root = path.join(home, ".codex", "sessions", "2026", "09", "18");
  await mkdir(root, { recursive: true });
  for (let s = 0; s < rollouts; s += 1) {
    const cwd = s % 3 === 0 ? projectRoot : `C:\\other\\${s}`;
    const lines = [JSON.stringify({ type: "session_meta", payload: { id: `rollout-${s}`, cwd } })];
    for (let i = 0; i < 60; i += 1) lines.push(JSON.stringify(codexRecord(i, cwd)));
    await writeFile(path.join(root, `rollout-${s}.jsonl`), `${lines.join("\n")}\n`);
  }
}

/** A stub agent that exits immediately: the fixture's stand-in for the TUI. */
export async function writeStubAgent(bin, name) {
  await mkdir(bin, { recursive: true });
  const target = path.join(bin, process.platform === "win32" ? `${name}.cmd` : name);
  if (process.platform === "win32") {
    await writeFile(target, "@echo off\r\nexit /b 0\r\n");
  } else {
    await writeFile(target, "#!/bin/sh\nexit 0\n");
    await chmod(target, 0o755);
  }
}

/**
 * Build the fixture. `stubAgents: true` writes the exit-immediately stubs
 * (profile.mjs); leave it off when a harness supplies its own PATH entry for
 * the real agents.
 */
export async function createPerfFixture({
  claudeSessions = Number(process.env.CLAUDE_SESSIONS ?? 40),
  claudeRecords = Number(process.env.CLAUDE_RECORDS ?? 400),
  codexRollouts = Number(process.env.CODEX_ROLLOUTS ?? 120),
  foreignProjects = 60,
  stubAgents = true,
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-perf-"));
  const home = path.join(root, "home");
  const projectRoot = path.join(root, "project");
  const bin = path.join(root, "bin");
  await mkdir(home, { recursive: true });
  await mkdir(projectRoot, { recursive: true });
  await seedClaude(home, projectRoot, claudeSessions, claudeRecords, foreignProjects);
  await seedCodex(home, projectRoot, codexRollouts);
  if (stubAgents) for (const name of ["claude", "codex", "opencode"]) await writeStubAgent(bin, name);

  const inherited = process.env.PATH ?? process.env.Path ?? "";
  const environment = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    HOMEDRIVE: path.parse(home).root.replace(/\\$/, ""),
    HOMEPATH: home.slice(path.parse(home).root.length - 1),
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    CODEX_HOME: path.join(home, ".codex"),
    AVENIC_STATE_DIR: path.join(root, "state"),
    PATH: `${bin}${path.delimiter}${inherited}`,
    Path: `${bin}${path.delimiter}${inherited}`,
  };

  return {
    root,
    home,
    projectRoot,
    bin,
    environment,
    sizes: { claudeSessions, claudeRecords, codexRollouts },
    async dispose() {
      // A just-killed agent can still hold its working directory open, and a
      // process still writing into the tree makes rmdir report the directory as
      // not empty on Windows even though it is being emptied: both are "wait
      // and try again", not failures.
      for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
          await rm(root, { recursive: true, force: true });
          return;
        } catch (error) {
          if (error.code === "ENOENT") return;
          if (error.code !== "EBUSY" && error.code !== "EPERM" && error.code !== "ENOTEMPTY") throw error;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

/** Nearest-rank percentile over a small sample, which is what a user runs. */
export function percentile(samples, fraction) {
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}
