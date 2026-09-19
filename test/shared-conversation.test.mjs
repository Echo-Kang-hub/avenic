import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  appendCanonicalEvents,
  readCanonicalSession,
  setActiveCanonicalSession,
} from "../packages/core/src/index.mjs";
import { withClaudeProject } from "./helpers/session-fixture.mjs";

// The acceptance test for the one promise Shared mode makes: a user can move
// the same conversation from one agent to another and each agent continues it
// instead of being handed a summary of it.
//
// Everything here is fabricated — invented turns, a temporary HOME, and
// stand-in agent binaries that answer exactly the official surfaces Avenic
// uses (`claude --resume` and Codex's documented app server). No model is
// called and nothing is written outside the temp tree.

const HISTORY = 60;

function argsOf(probe) {
  return probe?.argv ?? [];
}

function argumentAfter(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] ?? null : null;
}

/**
 * What Claude actually reads: `--append-system-prompt-file` names a file, so a
 * test has to open it — which is also the point of the flag, since a multi-line
 * briefing inlined into an argument does not survive a Windows .cmd shim.
 */
async function briefingFor(argv) {
  const file = argumentAfter(argv, "--append-system-prompt-file");
  if (!file) return null;
  return readFile(file, "utf8");
}

/** Every injected turn, in order, as text. */
function injectedTexts(entries) {
  return entries.flatMap((entry) => entry.items ?? [])
    .map((item) => item?.content?.[0]?.text ?? "")
    .filter(Boolean);
}

async function codexInjections(environment) {
  const file = environment.AVENIC_CODEX_INJECT_LOG;
  try {
    return (await readFile(file, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

test("one shared conversation survives Claude → Codex → Claude → Codex", async () => {
  await withClaudeProject(async ({ projectRoot, sessionIds, runCli, environment, root }) => {
    const nativeClaude = sessionIds[0];
    const probe = path.join(root, "agent-probe.json");
    const injectLog = path.join(root, "codex-inject.jsonl");
    const env = {
      ...environment,
      AVENIC_AGENT_PROBE: probe,
      AVENIC_CODEX_INJECT_LOG: injectLog,
      // The stand-in Codex answers the turn it was just given, the way a real
      // Codex turn lands in its own rollout.
      AVENIC_CODEX_REPLY: "Codex: I cached the token stream.",
    };
    const continueWith = (agent, options = {}) => runCli(["sessions", "continue", canonicalId, "--agent", agent], { ...env, ...options });

    // 1. Claude has been working: its whole native history is the shared
    //    conversation so far.
    const listed = runCli(["sessions", "list"]);
    assert.equal(listed.status, 0, listed.stderr);
    const canonicalId = `claude-${nativeClaude}`;
    await setActiveCanonicalSession(projectRoot, canonicalId);
    const seeded = await readCanonicalSession(projectRoot, canonicalId);
    assert.equal(seeded.events.length, HISTORY, "the native history is the shared history");

    // 2. Codex has since answered four turns in this same conversation (the
    //    conversation already moved between agents once).
    const codexTurns = [
      ["u1", "user", "now make the tests pass"],
      ["a1", "assistant", "Codex: two assertions were wrong; fixed."],
      ["u2", "user", "and check the CLI help text"],
      ["a2", "assistant", "Codex: the help text was missing sessions show."],
    ];
    await appendCanonicalEvents(projectRoot, canonicalId, codexTurns.map(([suffix, role, text]) => ({
      id: `codex:native-codex-1:${suffix}`,
      agent: "codex",
      role,
      createdAt: "2026-09-19T00:00:02.000Z",
      content: [{ type: "text", text }],
    })));

    // 3. Continuation 1 — Claude. The delta is the four Codex turns: not one of
    //    Claude's own turns is sent back to it, and no giant handoff appears.
    const firstStarted = Date.now();
    const claudeFirst = continueWith("claude");
    const claudeMs = Date.now() - firstStarted;
    assert.equal(claudeFirst.status, 0, claudeFirst.stderr);
    const claudeArgs = argsOf(JSON.parse(await readFile(probe, "utf8")));
    assert.deepEqual(claudeArgs.slice(0, 2), ["--resume", nativeClaude], "Claude continues its own session");
    const briefing = await briefingFor(claudeArgs);
    assert.ok(briefing, `Claude must receive the shared turns:\n${claudeArgs.join(" ")}`);
    assert.ok(briefing.includes("Codex: two assertions were wrong; fixed."), "the other agent's newest work is in the briefing");
    assert.ok(!briefing.includes("message 12"), "turns Claude already has must not be repeated");
    assert.ok(briefing.length < 4_000, `the briefing is a delta, not a handoff (${briefing.length} chars)`);

    // 4. Continuation 2 — Codex. No Codex session exists yet, so the projection
    //    materializes a real thread from the complete conversation.
    const codexStarted = Date.now();
    const codexFirst = continueWith("codex");
    const codexMs = Date.now() - codexStarted;
    assert.equal(codexFirst.status, 0, codexFirst.stderr);
    const materialized = await codexInjections(env);
    assert.equal(materialized.length, 1, "one thread was given the conversation");
    assert.ok(materialized[0].items.length >= HISTORY, `a fresh thread receives the whole conversation (${materialized[0].items.length})`);
    assert.ok(injectedTexts(materialized).some((text) => text.includes("fixed.")), "including what the other agent just said");

    // Codex's own answer was captured back into the one conversation.
    const afterCodex = await readCanonicalSession(projectRoot, canonicalId);
    assert.equal(afterCodex.events.length, HISTORY + codexTurns.length + 1, "Codex's turn joined the shared history exactly once");
    assert.ok(afterCodex.events.some((event) => event.agent === "codex" && JSON.stringify(event.content).includes("I cached the token stream")), "Codex's answer is in canonical history");

    // 5. Continuation 3 — back to Claude. Claude must be told what Codex just
    //    did, and still not be re-sent its own history.
    const claudeSecond = continueWith("claude");
    assert.equal(claudeSecond.status, 0, claudeSecond.stderr);
    const secondBriefing = await briefingFor(argsOf(JSON.parse(await readFile(probe, "utf8"))));
    assert.ok(secondBriefing.includes("I cached the token stream"), "Claude is told what Codex just did");
    assert.ok(!secondBriefing.includes("message 12"), "and is still not re-sent its own turns");

    // 6. Continuation 4 — Codex again. It now has its own thread, so this is a
    //    resume with a delta, not a rebuild: the tenth switch costs the tenth
    //    delta, never the whole conversation.
    const codexSecond = continueWith("codex");
    assert.equal(codexSecond.status, 0, codexSecond.stderr);
    const all = await codexInjections(env);
    const resumed = all.slice(materialized.length);
    const secondInjected = resumed.reduce((total, entry) => total + (entry.items?.length ?? 0), 0);
    assert.ok(secondInjected < 10, `a resumed thread receives only the delta, not ${HISTORY + 8} events (got ${secondInjected})`);

    // 7. The transcript is one conversation, in order, with every turn
    //    attributed to the agent that produced it.
    const shown = runCli(["sessions", "show", canonicalId, "--json"]);
    assert.equal(shown.status, 0, shown.stderr);
    const model = JSON.parse(shown.stdout);
    const ids = model.turns.map((turn) => turn.id);
    assert.equal(new Set(ids).size, ids.length, "no turn appears twice");
    const agents = new Set(model.turns.filter((turn) => turn.kind === "agent").map((turn) => turn.agent));
    assert.deepEqual([...agents].sort(), ["claude", "codex"], "both agents' turns are in the one transcript");
    assert.equal(model.session.events, HISTORY + codexTurns.length + 1);
    assert.ok(model.turns.at(-1).agent === "codex", "the newest turn is the one Codex just gave");

    const report = { claudeResumeMs: claudeMs, codexMaterializeMs: codexMs, events: model.session.events, turns: model.turns.length };
    console.log(`shared conversation: ${JSON.stringify(report)}`);
  }, {
    sessions: 1,
    records: HISTORY,
    agents: { claude: { auth: "global", sessions: "project" }, codex: { auth: "global", sessions: "project" } },
    sessionInterop: "shared",
  });
});

// The delta rule decides *which* turns travel; this decides what shape they
// arrive in. A switch is supposed to hand over the conversation itself, so a
// turn arrives whole — a clipped answer is a different answer, and a
// conversation that silently condenses is exactly the "you have to re-explain"
// failure Shared mode exists to remove.
test("every turn of the shared conversation reaches the next agent whole", async () => {
  await withClaudeProject(async ({ projectRoot, sessionIds, runCli, environment, root }) => {
    const nativeClaude = sessionIds[0];
    const probe = path.join(root, "agent-probe.json");
    const injectLog = path.join(root, "codex-inject.jsonl");
    const env = { ...environment, AVENIC_AGENT_PROBE: probe, AVENIC_CODEX_INJECT_LOG: injectLog };

    const synced = runCli(["sessions", "sync"]);
    assert.equal(synced.status, 0, synced.stderr);
    const canonicalId = `claude-${nativeClaude}`;
    await setActiveCanonicalSession(projectRoot, canonicalId);

    // Two answers long enough that clipping one would be visible from the end of
    // it, and enough short turns around them to make this a real conversation.
    const claudeLong = `CLAUDE-LONG-START ${"api ".repeat(660)}CLAUDE-LONG-END`;
    const codexLong = `CODEX-LONG-START ${"cli ".repeat(660)}CODEX-LONG-END`;
    const handed = [
      ["h1", "codex", "user", "the request that starts this stretch"],
      ["h2", "claude", "assistant", claudeLong],
      ["h3", "codex", "user", "and the follow-up"],
      ["h4", "codex", "assistant", codexLong],
    ];
    await appendCanonicalEvents(projectRoot, canonicalId, handed.map(([suffix, agent, role, text]) => ({
      id: `${agent}:native-${agent}-hand:${suffix}`,
      agent,
      role,
      createdAt: "2026-09-19T00:00:04.000Z",
      content: [{ type: "text", text }],
    })));

    // 1. Claude — a bootstrap, so the projection is the whole conversation, and
    //    nothing in it may be clipped or folded into a summary.
    const claudeRun = runCli(["sessions", "continue", canonicalId, "--agent", "claude"], env);
    assert.equal(claudeRun.status, 0, claudeRun.stderr);
    const briefing = await briefingFor(argsOf(JSON.parse(await readFile(probe, "utf8"))));
    assert.ok(briefing, "Claude receives the shared turns");
    assert.ok(briefing.includes("CODEX-LONG-END"), `a long answer reaches Claude whole, not clipped at ${briefing.length} chars`);
    assert.doesNotMatch(briefing, /\[condensed\]/, "a conversation this size is handed over, not summarised");

    // 2. Codex materialises from the same conversation: every turn, in order,
    //    with the speaker still attributable.
    const codexRun = runCli(["sessions", "continue", canonicalId, "--agent", "codex"], env);
    assert.equal(codexRun.status, 0, codexRun.stderr);
    const items = injectedTexts(await codexInjections(env));
    assert.equal(items.length, HISTORY + handed.length, "every turn of the conversation is injected");
    assert.equal(items[0], "message 0", "the oldest turn is still there");
    assert.deepEqual(
      items.slice(-handed.length),
      [
        "the request that starts this stretch",
        `Claude: ${claudeLong}`,
        "and the follow-up",
        codexLong,
      ],
      "the newest turns arrive in order, whole, with the other agent named",
    );
  }, {
    sessions: 1,
    records: HISTORY,
    agents: { claude: { auth: "global", sessions: "project" }, codex: { auth: "global", sessions: "project" } },
    sessionInterop: "shared",
  });
});

test("a long shared conversation is projected from its delta, not replayed", async () => {
  await withClaudeProject(async ({ projectRoot, sessionIds, runCli, environment, root }) => {
    const nativeClaude = sessionIds[0];
    const probe = path.join(root, "agent-probe.json");
    const injectLog = path.join(root, "codex-inject.jsonl");
    const env = { ...environment, AVENIC_AGENT_PROBE: probe, AVENIC_CODEX_INJECT_LOG: injectLog };

    const listed = runCli(["sessions", "sync"]);
    assert.equal(listed.status, 0, listed.stderr);
    const canonicalId = `claude-${nativeClaude}`;
    await setActiveCanonicalSession(projectRoot, canonicalId);

    // A conversation as long as a real one: 600 more turns, most of them
    // Claude's own, and a handful from Codex.
    const filler = [];
    for (let index = 0; index < 600; index += 1) {
      const fromCodex = index % 100 === 99;
      const agent = fromCodex ? "codex" : "claude";
      filler.push({
        id: `${agent}:${fromCodex ? "native-codex-1" : nativeClaude}:x${index}`,
        agent,
        role: index % 2 === 0 ? "user" : "assistant",
        createdAt: "2026-09-19T00:00:03.000Z",
        content: [{ type: "text", text: `turn ${index}` }],
      });
    }
    await appendCanonicalEvents(projectRoot, canonicalId, filler);

    const started = Date.now();
    const result = runCli(["sessions", "continue", canonicalId, "--agent", "claude"], env);
    const elapsedMs = Date.now() - started;
    assert.equal(result.status, 0, result.stderr);
    const briefing = await briefingFor(argsOf(JSON.parse(await readFile(probe, "utf8"))));
    assert.ok(briefing, "Claude receives the delta");
    // Six foreign turns (five Codex answers plus what came before) — not 660.
    assert.ok(briefing.length < 8_000, `a 660-turn conversation must not become a handoff (${briefing.length} chars)`);
    assert.ok(!briefing.includes("turn 12 \n"), "Claude's own turns are not replayed");

    const stored = await readCanonicalSession(projectRoot, canonicalId);
    console.log(`long conversation: ${JSON.stringify({ events: stored.events.length, briefingChars: briefing.length, elapsedMs })}`);
    assert.ok(elapsedMs < 8_000, `a switch over a 660-event conversation stays interactive (${elapsedMs}ms)`);
  }, {
    sessions: 1,
    records: 6,
    agents: { claude: { auth: "global", sessions: "project" }, codex: { auth: "global", sessions: "project" } },
    sessionInterop: "shared",
  });
});
