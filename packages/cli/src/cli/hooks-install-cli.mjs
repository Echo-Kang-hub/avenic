// `avenic hook install|uninstall|status` — the half that writes.
//
// The emit path runs on every turn of every agent, so it is loaded for a few
// milliseconds and nothing else; this one runs when a person asks Avenic to set
// the hooks up or take them away, so it may take its time: read the agent's own
// version, read the file, and show exactly what would change before changing
// it. It lives in its own module for that reason — `hooks-cli.mjs` pulls it in
// only when one of these three verbs is the one being run.

import { hookPlan, hookStatus, installHooks, uninstallHooks } from "#core/runtime/hook-install.mjs";
import { hookCapability } from "#core/runtime/hooks.mjs";
import { configurationDiff, maskSecrets } from "#core/runtime/model-write.mjs";
import { locateProjectRoot } from "#core/runtime/project-root.mjs";
import { detectAgentInstallationAsync } from "#core/runtime/versions.mjs";
import { takeOption } from "./options.mjs";

const AGENT_IDS = "claude|codex|opencode";
const SCOPES = "project|global";
const USAGE = {
  install: `Usage: avenic hook install --agent ${AGENT_IDS} [--scope ${SCOPES}] [--dry-run] [--json]`,
  uninstall: `Usage: avenic hook uninstall --agent ${AGENT_IDS} [--scope ${SCOPES}] [--json]`,
  status: `Usage: avenic hook status [--agent ${AGENT_IDS}] [--scope ${SCOPES}] [--json]`,
};
/** The same three lines `avenic hook --help` prints — one string, two readers. */
export const SETUP_USAGE = [USAGE.install, USAGE.uninstall, USAGE.status];

function fail(io, message) {
  io.error(message);
  return 1;
}

function takeFlag(values, flag) {
  const index = values.indexOf(flag);
  if (index === -1) return false;
  values.splice(index, 1);
  return true;
}

/** The two options every verb here takes, read the way the rest of the CLI reads them. */
function takeTarget(values, verb, { agentRequired }) {
  let agentId;
  let scope;
  try {
    agentId = takeOption(values, "--agent");
    scope = takeOption(values, "--scope");
  } catch (error) {
    return { error: `${error.message}. ${USAGE[verb]}` };
  }
  if (agentRequired && agentId === null) return { error: `Missing --agent. ${USAGE[verb]}` };
  if (agentId !== null && hookCapability(agentId) === null) return { error: `Unknown agent: ${agentId}. ${USAGE[verb]}` };
  if (scope !== null && scope !== "project" && scope !== "global") return { error: `Unknown scope: ${scope}. ${USAGE[verb]}` };
  return { agentId, scope: scope ?? "project" };
}

// 装不装得上取决于装在这台机器上的那个 agent 的版本，而版本只有问它自己才知道 ——
// 读不出来就不说支持（`hookSupport` 的那句话），不猜。
async function planFor(agentId, scope, context) {
  const { environment, projectRoot } = context;
  const installation = await detectAgentInstallationAsync(agentId, { environment });
  return hookPlan(agentId, { scope, projectRoot, environment, version: installation.version });
}

/** The preview: what would be added and what would go, with the secrets masked. */
function diffLines(plan) {
  return configurationDiff(plan.before, plan.contents).map((line) => {
    if (line.kind === "same") return null;
    return `${line.kind === "add" ? "+" : "-"} ${maskSecrets(line.text)}`;
  }).filter((line) => line !== null);
}

function report(io, plan, { verb, changed, dryRun }) {
  const scope = plan.scope === "project" ? "this project" : "everywhere";
  if (dryRun) {
    io.log(`Would ${verb === "install" ? "install" : "remove"} ${plan.displayName} hooks for ${scope}: ${plan.file}`);
    for (const line of diffLines(plan)) io.log(line);
    io.log(`Nothing was written — this was --dry-run.`);
    return 0;
  }
  io.log(`${changed ? (verb === "install" ? "Installed" : "Removed") : (verb === "install" ? "Already installed" : "Nothing to remove")}: ${plan.displayName} hooks for ${scope} — ${plan.file}`);
  if (changed && verb === "install" && plan.caveat !== "") io.log(plan.caveat);
  return 0;
}

async function setupVerb(verb, argumentsList, context) {
  const { io } = context;
  const values = [...argumentsList];
  const target = takeTarget(values, verb, { agentRequired: true });
  if (target.error !== undefined) return fail(io, target.error);
  const dryRun = verb === "install" && takeFlag(values, "--dry-run");
  const asJson = takeFlag(values, "--json");
  if (values.length > 0) return fail(io, `Unknown option for avenic hook ${verb}: ${values[0]}. ${USAGE[verb]}`);

  const plan = await planFor(target.agentId, target.scope, context);
  if (!plan.supported) return fail(io, plan.note);
  if (asJson && dryRun) {
    io.log(JSON.stringify({ agent: plan.agent, scope: plan.scope, file: plan.file, supported: plan.supported, installed: plan.installed, diff: diffLines(plan) }));
    return 0;
  }
  const result = dryRun ? { changed: false } : await (verb === "install" ? installHooks(plan) : uninstallHooks(plan));
  if (asJson) {
    io.log(JSON.stringify({ agent: plan.agent, scope: plan.scope, file: plan.file, changed: result.changed, caveat: plan.caveat }));
    return 0;
  }
  return report(io, plan, { verb, changed: dryRun ? false : result.changed, dryRun });
}

async function statusVerb(argumentsList, context) {
  const { io } = context;
  const values = [...argumentsList];
  const target = takeTarget(values, "status", { agentRequired: false });
  if (target.error !== undefined) return fail(io, target.error);
  const asJson = takeFlag(values, "--json");
  if (values.length > 0) return fail(io, `Unknown option for avenic hook status: ${values[0]}. ${USAGE.status}`);

  const agents = target.agentId === null ? ["claude", "codex", "opencode"] : [target.agentId];
  const rows = [];
  for (const agentId of agents) {
    // 一个读不动的文件是**一个** agent 的答案，不是另外两个的：整条 status 挂掉会让用户
    // 一次失去三个答案。这一行说出读不动的那个，另外两行照常回答。
    try {
      const plan = await planFor(agentId, target.scope, context);
      rows.push({ agent: plan.agent, displayName: plan.displayName, scope: plan.scope, file: plan.file, installed: plan.installed, supported: plan.supported, note: plan.note, caveat: plan.caveat });
    } catch (error) {
      rows.push({ agent: agentId, displayName: hookCapability(agentId).displayName, scope: target.scope, file: null, installed: null, supported: null, note: null, caveat: "", error: error?.message ?? String(error) });
    }
  }
  if (asJson) {
    io.log(JSON.stringify({ scope: target.scope, agents: rows }));
    return 0;
  }
  for (const row of rows) {
    if (row.error !== undefined) {
      io.log(`${row.displayName}  could not be read — ${row.error}`);
      continue;
    }
    const state = !row.supported ? "unsupported" : row.installed ? "installed" : "not installed";
    io.log(`${row.displayName}  ${state}  ${row.file}`);
  }
  const unsupported = rows.filter((row) => row.supported === false && row.note !== null);
  for (const row of unsupported) io.log(row.note);
  const installed = rows.filter((row) => row.installed === true && row.caveat !== "");
  for (const row of installed) io.log(`${row.displayName}: ${row.caveat}`);
  return 0;
}

/**
 * The three verbs. Returns the process's exit code: 0 when the answer was given
 * (including "nothing to do"), 1 for a usage mistake, an agent that cannot
 * carry the hooks, or a file Avenic may not rewrite.
 */
export async function dispatchHookSetup(verb, argumentsList, context) {
  const cwd = context.cwd ?? process.cwd();
  const full = { ...context, projectRoot: locateProjectRoot(cwd) };
  try {
    if (verb === "status") return await statusVerb(argumentsList, full);
    return await setupVerb(verb, argumentsList, full);
  } catch (error) {
    // 写不动的原因（读不懂的 JSON、没有配对的标记）是用户要读的那句话本身，
    // 不是一段栈。
    return fail(full.io, error?.message ?? String(error));
  }
}
