#!/usr/bin/env node

// P7 — the shared conversation, run for real, across two different agents.
//
// The claim under test is a mechanism the fixtures can only imitate: one
// conversation, opened by Claude, continued by Codex — an agent that was never
// in the room — and then read back by Claude, which must know both halves. The
// only way to know whether the second agent really received the first agent's
// words is to let it answer with them.
//
// Legs (all with the real binaries, all in a temp world):
//
//   A  `avenic claude -p` opens the shared conversation with a marker.
//   B  the shared conversation is projected into a *native Codex thread* by the
//      product's own projection code, and then Codex itself — through the
//      official non-interactive surface `codex exec resume <thread>` — is asked
//      what the first speaker told it to remember. Only a correct answer proves
//      the projection carried the words rather than a summary of them.
//   C  the same conversation, projected back into Claude, must now know A and B.
//
// The one substitution: the interactive `codex resume <thread>` TUI is replaced
// by `codex exec resume <thread>`, because a TUI cannot be driven from a script.
// Everything around it — the projection, the native session, the capture back
// into canonical history — is the product's real code path.
//
// Then the store itself is read: the three markers in order, each exactly once,
// no control records, no tool output masquerading as the person's words, and a
// second capture that adds nothing.
//
// Run: node scripts/forensics/shared-cross-agent.mjs [--keep]

import { spawn } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  completeCanonicalContinuation,
  initializeAgent,
  listCanonicalSessions,
  prepareCanonicalContinuation,
  projectionItems,
  readCanonicalSession,
  reconcileCanonicalSession,
  setHistoryMode,
} from "../../packages/core/src/index.mjs";
import { eventAgent, turnKind } from "../../packages/core/src/runtime/projection.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = path.join(REPO, "packages", "cli", "scripts", "skills.mjs");
const KEEP = process.argv.includes("--keep");

const MARKERS = {
  a: "SHARE_A_ALPHA",
  b: "SHARE_B_BRAVO",
  c: "SHARE_C_CHARLIE",
};

// A phrase only leg A's own prompt contains. A projection is a delta, so this
// must never appear in what a later agent is handed: if it does, the whole
// conversation was replayed rather than the part the target is missing.
const A_PROMPT_ONLY = "Remember this exact word";
const ids = { a: "11110000-0000-4000-8000-0000000000a1" };

// Control records Claude's own transcript carries. None of them is something a
// person said, so none of them may reach another agent as one.
const CONTROL_SIGNS = [
  "<local-command-caveat>",
  "<local-command-stdout>",
  "<command-name>",
  "<command-message>",
  "<command-args>",
  "<system-reminder>",
  '"isMeta":true',
];

const results = [];
function check(label, ok, detail = "") {
  results.push({ label, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

/** The two agents' world: their own config roots, whose credentials are hard
 * links to the machine's own — never copies, never read — plus a home.
 *
 * It sits outside the system temp directory on purpose. Codex refuses to write
 * its helper binaries under a temporary directory ("Refusing to create helper
 * binaries under temporary dir …"), which makes a world inside %TEMP% unable to
 * run it at all. Nothing here is a real profile: the roots are created fresh
 * and removed at the end. */
function buildWorld(prefix) {
  const scratch = path.join(os.homedir(), ".avenic-forensics");
  mkdirSync(scratch, { recursive: true });
  const root = mkdtempSync(path.join(scratch, prefix));
  const home = path.join(root, "home");
  const claudeConfig = path.join(home, ".claude");
  const codexHome = path.join(home, ".codex");
  mkdirSync(claudeConfig, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  const realClaude = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  const realCodex = process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const links = [
    [path.join(realClaude, ".credentials.json"), path.join(claudeConfig, ".credentials.json")],
    [path.join(os.homedir(), ".claude.json"), path.join(home, ".claude.json")],
    [path.join(realClaude, "settings.json"), path.join(claudeConfig, "settings.json")],
    [path.join(realCodex, "auth.json"), path.join(codexHome, "auth.json")],
    [path.join(realCodex, "config.toml"), path.join(codexHome, "config.toml")],
  ];
  for (const [from, to] of links) {
    if (!existsSync(from)) continue;
    try {
      linkSync(from, to);
    } catch {
      // A world without the file is still a world; the checks below say so.
    }
  }
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    // The host session's own plumbing: the variables its runtime sets for the
    // processes it starts. A world is a machine with a profile, not a child of
    // this session, and it authenticates from the linked credentials above.
    if (/^CLAUDE_CODE_|^CLAUDECODE$|^CLAUDE_PID$/.test(name)) delete environment[name];
  }
  // Model routing is deliberately *not* stripped. This machine reaches a model
  // through the host session's endpoint and token, and a world without them
  // cannot run an agent at all: the profile's own `model` setting then names a
  // model the endpoint does not recognise, and leg A exits 1 before it speaks.
  // Which model answers is host configuration on every leg, and the checks
  // below never read it — they read what each agent was *told*.
  Object.assign(environment, {
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: claudeConfig,
    CODEX_HOME: codexHome,
  });
  // The script's own core calls resolve agent homes from `process.env` when a
  // caller supplies none — `reconcileCanonicalSession` does exactly that — so
  // the world has to be this process's environment too. Without this a
  // reconcile looks for the projections in the machine's real profile and
  // reports them stale, and a capture could import real sessions into the
  // subject world.
  for (const name of Object.keys(process.env)) {
    if (name in environment) process.env[name] = environment[name];
    else delete process.env[name];
  }
  return { root, home, claudeConfig, codexHome, environment };
}

// A real model call is the one part of this experiment whose duration is not
// Avenic's to control: `codex exec` has taken 2 minutes and has taken 6 on this
// machine (it falls back from WebSocket to HTTPS). The budget is generous
// because a timeout here would report the harness's patience as a product
// failure, and every leg prints what it actually ran.
function run(command, argumentsList, { cwd, environment, label, timeoutMs = 600_000 }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, argumentsList, { cwd, env: environment, stdio: ["ignore", "pipe", "pipe"] });
    const out = [];
    const err = [];
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("exit", (status) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(out).toString("utf8");
      const stderr = Buffer.concat(err).toString("utf8");
      console.log(`  · ran ${label} (${Date.now() - started} ms, exit ${status}${killed ? ", TIMED OUT" : ""})`);
      resolve({ status, output: `${stdout}${stderr}`, stdout, stderr, killed });
    });
  });
}

/** A failed command says everything it said, not a summary of it. */
function dump(result, label) {
  const text = `${result.stdout ? `--- stdout ---\n${result.stdout}\n` : ""}--- stderr ---\n${result.stderr}`;
  console.log(`${label} output (${text.length} chars):\n${text.slice(-4000)}`);
}

function launchCli(projectRoot, argumentsList, { environment, label }) {
  return run(process.execPath, [CLI, ...argumentsList], { cwd: projectRoot, environment, label });
}

/** A failed leg says why: both ends of its own output, not just one. */
function preview(output, lines = 3) {
  const all = output.trim().split("\n").map((line) => line.trim()).filter(Boolean);
  if (all.length <= lines * 2) return all.join(" / ").slice(0, 300);
  return `${all.slice(0, lines).join(" / ")} … ${all.slice(-lines).join(" / ")}`.slice(0, 300);
}

/** The last non-empty line of an agent's answer — what a marker check reads. */
function answer(output) {
  return output.trim().split("\n").map((line) => line.trim()).filter(Boolean).slice(-1)[0] ?? "";
}

function findMarker(text, marker) {
  return text.toUpperCase().includes(marker);
}

/** The turns a person actually spoke, told apart from tool traffic by the
 * product's own classification rather than by the storage role. */
function userTurns(record) {
  return (record.events ?? []).filter((event) => turnKind(event) === "user");
}

function agentTurns(record, agentId) {
  return (record.events ?? []).filter((event) => turnKind(event) === "agent" && eventAgent(event) === agentId);
}

/** The text of a turn or of one projected item: blocks, not a string. */
function textOf(event) {
  const content = event?.content ?? event?.blocks ?? [];
  if (typeof content === "string") return content;
  return (Array.isArray(content) ? content : [])
    .map((block) => (typeof block === "string" ? block : block?.text ?? ""))
    .join("\n");
}

async function main() {
  console.log("== world ==");
  const world = buildWorld("avenic-shared-cross-agent-");
  const project = path.join(world.root, "project");
  mkdirSync(project, { recursive: true });
  for (const agentId of ["claude", "codex"]) {
    await initializeAgent(project, agentId, { authMethod: "account", accountScope: "global", sessionScope: "project" });
  }
  await setHistoryMode(project, "shared");
  console.log(`  · isolated world at ${world.root}`);
  console.log(`  · project at ${project}`);
  console.log(`  · home and both config roots are temp; credentials are hard links, never read`);

  // ---- leg A: Claude opens the conversation ---------------------------------
  console.log("\n== leg A: a real Claude run opens the shared conversation ==");
  const runA = await launchCli(project, ["claude", "-p", "--session-id", ids.a, `Remember this exact word: ${MARKERS.a}. Reply with OK.`], {
    environment: world.environment, label: "avenic claude (A)",
  });
  check("the Claude leg answered", runA.status === 0, runA.status === 0 ? "" : answer(runA.output));
  const sessionsAfterA = await listCanonicalSessions(project);
  const canonicalId = sessionsAfterA[0]?.id ?? null;
  check("the shared conversation holds A's run", Boolean(canonicalId), canonicalId ?? "no canonical session");

  if (!canonicalId) {
    report();
    return;
  }

  // ---- leg B: Codex continues a conversation it never had -------------------
  console.log("\n== leg B: the shared conversation becomes a native Codex thread ==");
  const forCodex = await prepareCanonicalContinuation(project, canonicalId, "codex", { environment: world.environment });
  console.log(`  · projection kind=${forCodex.kind} mode=${forCodex.mode} native=${forCodex.nativeSessionId ?? "(none)"}`);
  console.log(`  · codex would be launched as: ${JSON.stringify(forCodex.launch?.argumentsList ?? null)}`);
  check("the projection produced a native Codex thread", typeof forCodex.nativeSessionId === "string" && forCodex.nativeSessionId.length > 0, forCodex.failure ?? "");
  const projected = projectionItems(forCodex.projection ?? { turns: [] });
  const projectedText = projected.map((item) => `${item.role}: ${textOf(item)}`).join("\n");
  const projectedGarbage = CONTROL_SIGNS.filter((sign) => projectedText.includes(sign));
  check("nothing from the control records reaches the second agent", projectedGarbage.length === 0, projectedGarbage.join(", "));
  check(
    "the first agent's words reach Codex as the person's turn, not as Claude's",
    projected.some((item) => item.role === "user" && findMarker(textOf(item), MARKERS.a)),
    projected.map((item) => item.role).join(",") || "(no items)",
  );

  let codexAnswered = "";
  if (forCodex.nativeSessionId) {
    // The interactive `codex resume <thread>` is what the product launches; a
    // script cannot drive a TUI, so the same thread is opened through the
    // official non-interactive surface instead. Nothing else changes.
    const runB = await run("codex", [
      "exec", "resume", forCodex.nativeSessionId,
      "Reply with exactly two lines and nothing else. Line 1: the exact word the first speaker asked you to remember, or NOTHING if you were never told one. Line 2: exactly SHARE_B_BRAVO.",
      "--skip-git-repo-check",
    ], { cwd: project, environment: world.environment, label: "codex exec resume (B)" });
    // `codex exec` echoes the prompt — including the word NOTHING — so the
    // answer is read from stdout alone. Judging the combined output made a
    // correct answer look like a failure.
    codexAnswered = runB.stdout;
    if (runB.status !== 0 || !findMarker(codexAnswered, MARKERS.a)) dump(runB, "codex exec resume");
    check(
      "Codex — which never ran before — answers with the first agent's word",
      runB.status === 0 && findMarker(codexAnswered, MARKERS.a) && !findMarker(codexAnswered, "NOTHING"),
      runB.status === 0 ? preview(codexAnswered) : preview(runB.output),
    );
  } else {
    check("Codex — which never ran before — answers with the first agent's word", false, "no native thread to resume");
  }

  // Capture B back into the shared conversation: the target's own new turn.
  const captureBefore = await readCanonicalSession(project, canonicalId);
  await completeCanonicalContinuation(project, canonicalId, "codex", {
    nativeSessionId: forCodex.nativeSessionId,
    projectionHash: forCodex.projection?.hash ?? null,
  });
  const reconciled = await reconcileCanonicalSession(project, canonicalId);
  const captureAfter = await readCanonicalSession(project, canonicalId);
  const codexTurns = agentTurns(captureAfter, "codex");
  check(
    "Codex's own answer lands in the shared conversation",
    codexTurns.some((event) => findMarker(textOf(event), MARKERS.b)),
    `${captureBefore.events.length} → ${captureAfter.events.length} event(s); reconcile: ${reconciled.map((entry) => `${entry.agentId}${entry.stale ? " stale" : ""}`).join(",") || "none"}`,
  );
  // The marker must not reach the store as the person's words. Judged by line,
  // because the driving prompt names the marker inside a sentence while the
  // answer Codex produced is the marker standing alone.
  const answeredAsPerson = userTurns(captureAfter)
    .flatMap((event) => textOf(event).split("\n").map((line) => line.trim()))
    .filter((line) => line === MARKERS.b || line === MARKERS.a);
  check(
    "and is attributed to Codex, not to the person",
    codexTurns.length > 0 && answeredAsPerson.length === 0,
    `${codexTurns.length} Codex turn(s), ${answeredAsPerson.length} answer line(s) filed as the person's`,
  );

  // ---- leg C: back to Claude, which must now know both ----------------------
  console.log("\n== leg C: Claude reads the conversation Codex added to ==");
  const forClaude = await prepareCanonicalContinuation(project, canonicalId, "claude", { environment: world.environment });
  console.log(`  · projection kind=${forClaude.kind} mode=${forClaude.mode} native=${forClaude.nativeSessionId ?? "(none)"}`);
  console.log(`  · claude would be launched as: ${JSON.stringify(forClaude.launch?.argumentsList ?? null)}`);
  // What Claude is actually handed, read off its own launch: the turns Codex
  // added travel as a file named on the command line. This is the mechanism
  // itself — inspectable, and independent of whether a model answers.
  const claudeArguments = forClaude.launch?.argumentsList ?? [];
  const briefingFlag = claudeArguments.indexOf("--append-system-prompt-file");
  const briefingFile = briefingFlag >= 0 ? claudeArguments[briefingFlag + 1] : null;
  const briefing = briefingFile && existsSync(briefingFile) ? readFileSync(briefingFile, "utf8") : "";
  check(
    "Claude is handed Codex's turn as a briefing, and only what it lacks",
    findMarker(briefing, MARKERS.b) && !briefing.includes(A_PROMPT_ONLY),
    briefingFile ? `${briefing.length} chars from ${path.basename(briefingFile)}` : "no briefing argument",
  );

  // The launch goes through Avenic, exactly as `avenic sessions continue` would:
  // the project's sessions are put back where the official CLI looks for them
  // before the process starts, and the projection's own arguments — including
  // the briefing file that carries Codex's turn — are handed over unchanged.
  const runC = await launchCli(project, [
    "claude", "-p",
    ...(forClaude.launch?.argumentsList ?? []),
    // Asked for every marker in its context, not for "the word you were asked
    // to remember": the second reading lets a correct answer omit the briefing
    // entirely, and then the check would measure nothing.
    "Reply with exactly two lines and nothing else. Line 1: every exact word starting with SHARE_ that appears anywhere in the conversation context you have been given, in the order it first appears, separated by commas. Line 2: exactly SHARE_C_CHARLIE.",
  ], { environment: world.environment, label: "avenic claude -p (C, through the projection)" });
  if (!findMarker(runC.stdout, MARKERS.b) || !findMarker(runC.stdout, MARKERS.a)) dump(runC, "claude -p (C)");
  check(
    "Claude knows both halves — its own word and the one Codex answered with",
    runC.status === 0 && findMarker(runC.stdout, MARKERS.a) && findMarker(runC.stdout, MARKERS.b) && !findMarker(runC.output, "No conversation found"),
    runC.status === 0 ? preview(runC.stdout) : preview(runC.output),
  );
  await reconcileCanonicalSession(project, canonicalId);

  // ---- the store, read back -------------------------------------------------
  console.log("\n== the shared conversation, read back ==");
  const record = await readCanonicalSession(project, canonicalId);
  const events = record.events ?? [];
  const positionOf = (predicate) => events.findIndex(predicate);
  const spokeA = positionOf((event) => turnKind(event) === "user" && findMarker(textOf(event), MARKERS.a));
  const saidB = positionOf((event) => turnKind(event) === "agent" && findMarker(textOf(event), MARKERS.b));
  const saidC = positionOf((event) => turnKind(event) === "agent" && eventAgent(event) === "claude" && findMarker(textOf(event), MARKERS.c));
  check(
    "A then B then C — one strictly continuous conversation",
    spokeA !== -1 && saidB > spokeA && saidC > saidB,
    `positions: A@${spokeA}, B@${saidB}, C@${saidC}`,
  );
  const codexSaidB = events.filter((event) => turnKind(event) === "agent" && eventAgent(event) === "codex" && findMarker(textOf(event), MARKERS.b));
  check(
    "Codex's own line was captured once, not once per capture pass",
    codexSaidB.length === 1,
    `${codexSaidB.length} Codex turn(s) carrying ${MARKERS.b}`,
  );
  // And the other half of the same rule: the injection Avenic wrote into the
  // Codex thread must not come back as a turn the person spoke, which would
  // duplicate the conversation once per switch.
  const personSaidA = events.filter((event) => turnKind(event) === "user" && findMarker(textOf(event), MARKERS.a));
  check(
    "the person's own words were captured once, not re-imported from the thread",
    personSaidA.length === 1,
    `${personSaidA.length} user turn(s) carrying ${MARKERS.a}`,
  );
  check("every event carries a unique id", new Set(events.map((event) => event.id)).size === events.length, `${events.length} event(s)`);

  const allText = events.map((event) => textOf(event)).join("\n");
  const storeGarbage = CONTROL_SIGNS.filter((sign) => allText.includes(sign));
  check("no control record reached the shared conversation", storeGarbage.length === 0, storeGarbage.join(", "));

  const mislabelledAsPerson = events.filter((event) => event.role === "user" && turnKind(event) !== "user");
  check(
    "no tool traffic is stored as a person's turn",
    mislabelledAsPerson.length === 0,
    mislabelledAsPerson.map((event) => event.id).slice(0, 3).join(", ") || "none",
  );
  const unnamed = events.filter((event) => turnKind(event) === "agent" && eventAgent(event) === "unknown");
  check("every agent turn names its agent", unnamed.length === 0, `${unnamed.length} unnamed`);

  console.log("\n== a second capture of the same native sessions ==");
  const revisionBefore = record.session.revision ?? captureAfter.session.revision;
  const eventsBefore = record.events.length;
  await reconcileCanonicalSession(project, canonicalId);
  const again = await readCanonicalSession(project, canonicalId);
  check(
    "capturing the same sessions twice adds nothing",
    again.events.length === eventsBefore && (again.session.revision ?? revisionBefore) === revisionBefore,
    `events ${eventsBefore} → ${again.events.length}, revision ${revisionBefore} → ${again.session.revision ?? revisionBefore}`,
  );

  report();
  // A failed round keeps its world: whatever went wrong is still on disk.
  if (KEEP || results.some((entry) => !entry.ok)) {
    console.log(`\nworld kept at ${world.root}`);
  } else {
    await cleanup(world.root);
  }
}

async function cleanup(root) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      rmSync(root, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  }
  console.log(`world could not be removed yet: ${root}`);
}

function report() {
  const passed = results.filter((entry) => entry.ok).length;
  console.log(`\n${passed}/${results.length} checks held`);
  if (passed !== results.length) process.exitCode = 1;
}

await main();
