#!/usr/bin/env node

// The forensic chain behind one complaint: `.agents/sessions/claude` holds the
// project's Claude conversations, yet inside `avenic claude` the agent's own
// `/resume` says "No conversations found in this project."
//
// The claim under test is a mechanism, so it is checked as a chain, with the
// real official CLI and a real launch — every link observed rather than
// assumed: native -> capture -> portable -> canonical -> revert -> next
// launch -> restore -> the agent's own resume. "Prepare the resume catalog" and
// "resume one of them" are different acts; the chain has to show the first
// happening on every plain launch and the second happening only when asked.
//
// The world is isolated: a temp home and CLAUDE_CONFIG_DIR whose credentials
// are hard links to the machine's own (never copies, never read), a temp
// project, and provider variables inherited so the agent can actually answer.
// Nothing here touches the real profile's sessions; the temp world is removed
// at the end unless --keep is passed.
//
// Run: node scripts/forensics/claude-resume-chain.mjs [--keep]

import { spawn } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeAgent, listCanonicalSessions, setHistoryMode } from "../../packages/core/src/index.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(REPO, "packages", "cli", "scripts", "skills.mjs");
const KEEP = process.argv.includes("--keep");

const MARKERS = {
  a: "SHARE_A_ALPHA",
  b: "SHARE_B_BRAVO",
  c: "SHARE_C_CHARLIE",
};
const ids = {
  a: "11110000-0000-4000-8000-00000000000a",
  b: "11110000-0000-4000-8000-00000000000b",
  c: "11110000-0000-4000-8000-00000000000c",
  direct: "11110000-0000-4000-8000-00000000000d",
  global: "11110000-0000-4000-8000-00000000000e",
};

const results = [];
function check(label, ok, detail = "") {
  results.push({ label, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

// The world the official CLI resolves at startup: the config root it reads
// credentials from, the home its global state lives in, and the provider
// environment the machine actually runs the agent with. Names of secret
// variables are never printed.
function isolatedEnvironment(home, configDir) {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (/^CLAUDE_CODE_|^CLAUDECODE$|^CLAUDE_PID$/.test(name)) delete environment[name];
  }
  return { ...environment, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: configDir };
}

function buildWorld(prefix) {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  const home = path.join(root, "home");
  const configDir = path.join(home, ".claude");
  mkdirSync(configDir, { recursive: true });
  const realConfig = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  for (const [from, to] of [
    [path.join(realConfig, ".credentials.json"), path.join(configDir, ".credentials.json")],
    [path.join(os.homedir(), ".claude.json"), path.join(home, ".claude.json")],
    [path.join(realConfig, "settings.json"), path.join(configDir, "settings.json")],
  ]) {
    if (!existsSync(from)) continue;
    try {
      linkSync(from, to);
    } catch {
      // A world without the file is still a world; the chain texts say which.
    }
  }
  return { root, home, configDir, environment: isolatedEnvironment(home, configDir) };
}

/** The native project directory the official CLI uses for a cwd. */
function nativeDirectory(configDir, projectRoot) {
  return path.join(configDir, "projects", projectRoot.replace(/[^a-zA-Z0-9]/g, "-"));
}

function nativeListing(configDir, projectRoot) {
  try {
    return readdirSync(nativeDirectory(configDir, projectRoot)).sort();
  } catch {
    return [];
  }
}

function portableListing(projectRoot) {
  try {
    return readdirSync(path.join(projectRoot, ".agents", "sessions", "claude")).sort();
  } catch {
    return [];
  }
}

/** Poll a directory while a launch runs: the shelf at the moment it existed. */
function observe(configDir, projectRoot, intervalMs = 75) {
  const frames = [];
  const timer = setInterval(() => {
    const now = nativeListing(configDir, projectRoot).join(",");
    if (frames[frames.length - 1] !== now) frames.push(now);
  }, intervalMs);
  return {
    frames,
    stop() {
      clearInterval(timer);
      return frames.filter((frame) => frame !== "");
    },
  };
}

function run(command, argumentsList, { cwd, environment, label }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, argumentsList, { cwd, env: environment, stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => chunks.push(chunk));
    child.on("exit", (status) => {
      const output = Buffer.concat(chunks).toString("utf8");
      console.log(`  · ran ${label} (${Date.now() - started} ms, exit ${status})`);
      resolve({ status, output });
    });
  });
}

function launchCli(projectRoot, argumentsList, { environment, configDir, label }) {
  const watcher = observe(configDir, projectRoot);
  return run(process.execPath, [CLI, ...argumentsList], { cwd: projectRoot, environment, label })
    .then((result) => ({ ...result, frames: watcher.stop() }));
}

async function main() {
  console.log("== world ==");
  const world = buildWorld("avenic-resume-chain-");
  const project = path.join(world.root, "project");
  mkdirSync(project, { recursive: true });
  await initializeAgent(project, "claude", { authMethod: "account", accountScope: "global", sessionScope: "project" });
  await setHistoryMode(project, "shared");
  console.log(`  · isolated world at ${world.root}`);
  console.log(`  · project at ${project}`);

  const providerNote = process.env.ANTHROPIC_BASE_URL ? "provider variables inherited" : "no provider base URL in the environment";
  console.log(`  · ${providerNote}`);

  console.log("\n== link 0: where the official CLI keeps this project's conversations ==");
  const direct = await run(
    "claude",
    ["-p", "--session-id", ids.direct, "Reply with exactly: OK"],
    { cwd: project, environment: world.environment, label: "direct claude (control)" },
  );
  const directOk = direct.status === 0;
  check("a direct claude run answers in the isolated world", directOk, directOk ? "" : direct.output.trim().split("\n").slice(-1)[0]);
  const directListing = nativeListing(world.configDir, project);
  check(
    "the official CLI writes this project's transcripts into the directory Avenic names",
    directListing.includes(`${ids.direct}.jsonl`),
    `native now holds ${directListing.length} file(s)`,
  );
  check("nothing of that run has reached the project store yet", !portableListing(project).includes(`${ids.direct}.jsonl`));

  console.log("\n== link 1: run A through avenic, watch the shelf before and after ==");
  const runA = await launchCli(project, ["claude", "-p", "--session-id", ids.a, `Remember this exact word: ${MARKERS.a}. Reply with OK.`], {
    environment: world.environment, configDir: world.configDir, label: "avenic claude (A)",
  });
  const duringA = runA.frames.flatMap((frame) => frame.split(","));
  check("during A the run's own session is in native storage", duringA.includes(`${ids.a}.jsonl`), `frames: ${runA.frames.join(" | ")}`);
  const afterA = nativeListing(world.configDir, project);
  check("after A exits the run's session is gone from native storage", !afterA.includes(`${ids.a}.jsonl`), afterA.join(", "));
  check("after A exits the project store holds it", portableListing(project).includes(`${ids.a}.jsonl`));
  const canonical = await listCanonicalSessions(project);
  check("after A exits the shared history holds it", canonical.some((session) => session.id === `claude-${ids.a}`));

  console.log("\n== link 2: run B the same way ==");
  const runB = await launchCli(project, ["claude", "-p", "--session-id", ids.b, `Remember this exact word: ${MARKERS.b}. Reply with OK.`], {
    environment: world.environment, configDir: world.configDir, label: "avenic claude (B)",
  });
  const afterB = nativeListing(world.configDir, project);
  check("after B exits the project holds both conversations", portableListing(project).includes(`${ids.a}.jsonl`) && portableListing(project).includes(`${ids.b}.jsonl`));
  check("after B exits neither is left in native storage", !afterB.includes(`${ids.a}.jsonl`) && !afterB.includes(`${ids.b}.jsonl`), afterB.join(", "));

  console.log("\n== link 3: the third plain launch — a new conversation, and a readable shelf ==");
  const runC = await launchCli(project, ["claude", "-p", "--session-id", ids.c, `Remember this exact word: ${MARKERS.c}. Reply with OK.`], {
    environment: world.environment, configDir: world.configDir, label: "avenic claude (C, plain)",
  });
  // The shelf as the agent found it: the last frame recorded before the agent's
  // own transcript appears. The frames before that are the wrapper's own work.
  const agentAppearsAt = runC.frames.findIndex((frame) => frame.includes(`${ids.c}.jsonl`));
  const shelf = (agentAppearsAt === -1 ? runC.frames : runC.frames.slice(0, agentAppearsAt)).join(",");
  check(
    "at the moment the third launch starts, the shelf holds A and B",
    shelf.includes(`${ids.a}.jsonl`) && shelf.includes(`${ids.b}.jsonl`),
    `frames: ${runC.frames.join(" | ")}`,
  );
  check("and not yet C — the agent had not run", agentAppearsAt !== 0);
  const afterC = nativeListing(world.configDir, project);
  check(
    "the third launch is a new conversation, not a resume of A or B",
    !afterC.includes(`${ids.a}.jsonl`) && !afterC.includes(`${ids.b}.jsonl`) && !afterC.includes(`${ids.c}.jsonl`) && portableListing(project).includes(`${ids.c}.jsonl`),
    `native after exit: ${afterC.join(", ") || "(empty)"}`,
  );

  console.log("\n== link 4: the agent's own resume, inside an avenic launch ==");
  const continued = await launchCli(project, ["claude", "-p", "-c", "What exact word were you told to remember? Reply with just that word, or NOTHING if you have no memory."], {
    environment: world.environment, configDir: world.configDir, label: "avenic claude -c (most recent)",
  });
  const found = [MARKERS.a, MARKERS.b, MARKERS.c].find((marker) => continued.output.includes(marker));
  check(
    "`-c` discovers a restored project conversation by recency",
    found !== undefined && !continued.output.includes("NOTHING"),
    `${found ?? "no marker"} — ${continued.output.trim().split("\n").slice(-1)[0]}`,
  );
  const resumed = await launchCli(project, ["claude", "-p", "-r", ids.a, "What exact word were you told to remember? Reply with just that word."], {
    environment: world.environment, configDir: world.configDir, label: "avenic claude -r <A>",
  });
  check("`-r <A>` opens A itself", resumed.output.includes(MARKERS.a) && !resumed.output.includes(MARKERS.b), resumed.output.trim().split("\n").slice(-1)[0]);

  console.log("\n== link 5: global scope isolates nothing and needs no catalog ==");
  const globalProject = path.join(world.root, "project-global");
  mkdirSync(globalProject, { recursive: true });
  await initializeAgent(globalProject, "claude", { authMethod: "account", accountScope: "global", sessionScope: "global" });
  const runGlobal = await launchCli(globalProject, ["claude", "-p", "--session-id", ids.global, `Remember this exact word: ${MARKERS.a}. Reply with OK.`], {
    environment: world.environment, configDir: world.configDir, label: "avenic claude (global scope)",
  });
  const globalNative = nativeListing(world.configDir, globalProject);
  check("in global scope the run's session stays in native storage", globalNative.includes(`${ids.global}.jsonl`), globalNative.join(", "));
  check("and nothing of it is copied into the project store", !portableListing(globalProject).includes(`${ids.global}.jsonl`));
  check("the other project's conversations are not in this project's shelf", !globalNative.includes(`${ids.a}.jsonl`) && !globalNative.includes(`${ids.b}.jsonl`));
  check("both launches answered", runA.status === 0 && runB.status === 0 && runC.status === 0 && runGlobal.status === 0);

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} links held`);
  if (KEEP) console.log(`world kept at ${world.root}`);
  else {
    // The agent's own processes may still hold a handle for a moment.
    try {
      rmSync(world.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      console.log(`world could not be removed yet: ${world.root}`);
    }
  }
  process.exitCode = failed.length === 0 ? 0 : 1;
}

await main();
