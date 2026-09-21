import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { CREDENTIAL_FILE, getAgent } from "./agents.mjs";
import { apiCredential, codexLaunchArguments, readApiConfiguration, readCodexProjectConfig } from "./api-config.mjs";
import { agentHomeRoot, effectiveAgentConfig, loadRuntime } from "./config.mjs";
import { environmentHome } from "./environment.mjs";

/**
 * The environment one agent process runs in.
 *
 * Authentication has two shapes and they never mix. An **account** launch
 * delegates to the agent's own sign-in: globally it uses the machine's own
 * credentials and changes nothing, and for the project scope it points the
 * agent's *own* configuration-home variable at `.agents/local/<agent>` so the
 * login it performs there is the project's alone — Avenic writes no credential
 * of its own and never touches the user's global account. An **API** launch
 * hands the agent the provider configuration the project chose, from the
 * agent's own configuration file, and never loads account state on top of it.
 *
 * `durableEnvironment` (environment.mjs) is the other half of the boundary: it
 * narrows what a detached watchdog may *persist*. "Do not write secrets down"
 * must never become "strip secrets from the live agent" — the process that runs
 * the conversation needs them.
 */
// The base every launch starts from: this process's own environment — the
// machine's world, untouched. It is deliberately NOT named for the agent: the
// world an *agent* runs in is `agentRuntimeEnvironment` below, composed with
// the project's answer. A caller that read the old name as that answer handed
// session paths the machine's home while the run wrote to the project's.
export function machineEnvironment() {
  return process.env;
}

// The variable each agent reads to find its own configuration and auth home,
// and the directory it defaults to. Naming them is the whole mechanism: the
// agent's login writes its own files there, in its own format, and Avenic never
// invents one. One map, because "where does this agent's home live" is asked by
// the launcher, the watchdog and the status page, and they must not answer it
// differently.
const AGENT_HOME_VARIABLE = { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME" };
const NATIVE_HOME = { claude: ".claude", codex: ".codex" };

// The home an Account's sign-in lives in for a scope: the project's own, or the
// agent's global one, which the same variable can relocate.
export function accountHome(projectRoot, agentId, scope, environment = process.env) {
  const variable = AGENT_HOME_VARIABLE[agentId];
  // An agent with no configuration-home variable of its own has no home to
  // name here: its state is its own, and a caller that asks anyway gets a
  // sentence rather than a path built out of `undefined`.
  if (!variable) throw new Error(`${getAgent(agentId).displayName} keeps its own configuration home`);
  if (scope === "project") return agentHomeRoot(projectRoot, agentId);
  return environment[variable] || path.join(environmentHome(environment), NATIVE_HOME[agentId]);
}

// Signed in, signed out, or an answer this reader cannot support: a platform
// where the credential may live outside the file (macOS keeps Claude's in the
// keychain), and a file that is there but unreadable — "not signed in" would be
// a claim about a credential nobody has seen, and an absent file is the only
// shape that really says so. Reading only: no network, no launch, no model, and
// never a value.
export async function accountSignInStatus(agentId, home) {
  let text = null;
  try {
    text = await readFile(path.join(home, CREDENTIAL_FILE[agentId]), "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") return "unknown";
  }
  let record = null;
  if (text !== null) {
    try {
      record = JSON.parse(text.replace(/^﻿/, ""));
    } catch {
      return "unknown";
    }
  }
  if (agentId === "claude") {
    if (record?.claudeAiOauth) return "signed-in";
    return process.platform === "darwin" ? "unknown" : "not-signed-in";
  }
  if (record?.OPENAI_API_KEY || Object.keys(record?.tokens ?? {}).length > 0) return "signed-in";
  return "not-signed-in";
}

/**
 * The environment an agent's *own process* runs in, which is also the one its
 * native storage lives under: a Project-scope account is isolated by pointing
 * the agent's configuration-home variable at `.agents/local/<agent>`, and
 * Claude and Codex both keep their sessions inside that same home. Everything
 * that reads or restores native storage around a launch — the snapshot, the
 * durability watch, the exit capture — therefore has to be handed this
 * environment and not the caller's: reading the user's global root during a run
 * that wrote to the project's would capture nothing and revert the wrong tree.
 * One definition, so a launch and its capture cannot disagree about where the
 * conversation went.
 */
export function agentRuntimeEnvironment(projectRoot, agentId, config, environment = process.env) {
  const scoped = config?.authMethod === "account" && (config.accountScope ?? "global") === "project";
  if (!scoped || !AGENT_HOME_VARIABLE[agentId]) return environment;
  return { ...environment, [AGENT_HOME_VARIABLE[agentId]]: agentHomeRoot(projectRoot, agentId) };
}

/**
 * The composition above, resolved from the project's own configuration: the
 * environment one project's runs of one agent read and write their own storage
 * under. Every path that touches native storage asks this question, so the
 * launch that wrote a conversation and the import that reads it cannot disagree
 * about where it is — a caller hands the base it was given (or nothing), and the
 * project's answer still decides the redirect.
 */
export async function effectiveAgentEnvironment(projectRoot, agentId, environment = process.env) {
  const config = effectiveAgentConfig(await loadRuntime(projectRoot), agentId);
  return agentRuntimeEnvironment(projectRoot, agentId, config, environment);
}

/**
 * The question a plain launch asks when the project has not answered yet: which
 * authentication this agent runs under here. A host draws it; the answer is
 * either remembered for the project (a local override, which replaces nothing)
 * or used for this launch alone.
 */
export function launchMethodQuestion(agentId, readiness = null) {
  const name = getAgent(agentId).displayName;
  const account = `use ${name}'s native account sign-in`;
  const api = "use a provider/model/API configuration";
  return {
    id: `runtime:${agentId}`,
    title: `${name} runtime`,
    options: [
      // Both methods can already be set up here — switching keeps the previous
      // configuration unless you say otherwise — so the question says which
      // ones are, instead of offering two choices that look alike. Readiness is
      // read from local files only: the agent's own credential, the ledger.
      { value: "account", label: "Account", description: readiness?.account ? `${account} — already signed in here` : account },
      { value: "api", label: "API", description: readiness?.api ? `${api} — ${readiness.api} is already written` : api },
    ],
    rememberTitle: "Remember for this project?",
  };
}

/**
 * Which methods this project could run under right now, read from local state
 * alone — no probe, no network, no model. An Account is ready when the home
 * this scope uses holds a sign-in the agent itself performed; an API is ready
 * when a configuration Avenic wrote is there to read, and is named by the file
 * that carries it. Both at once is the ordinary result of switching method and
 * keeping what was there, which is why the launch question reports it.
 */
export async function launchMethodReadiness(projectRoot, agentId, options = {}) {
  // An agent that manages its own authentication has no method here to be
  // ready: the honest answer is "nothing to report", not a home this function
  // would have to invent.
  if (getAgent(agentId).managesOwnAuth) return { account: false, api: null };
  const environment = options.environment ?? process.env;
  const config = options.config ?? effectiveAgentConfig(await loadRuntime(projectRoot), agentId);
  // The home the run would actually use, not the one this project happens to
  // have: a launch runs on the machine's own account unless the answer named
  // Account *and* the project scope, so readiness looks there. Reading the
  // project home for an unanswered project would describe a sign-in the launch
  // will not use.
  const accountScope = config?.authMethod === "account" ? config.accountScope ?? "global" : "global";
  const signedIn = await accountSignInStatus(agentId, accountHome(projectRoot, agentId, accountScope, environment));
  let api = null;
  // Either scope can be the one holding it: the method's own scope when the
  // project answered API, and otherwise whichever scope the kept configuration
  // was written at.
  for (const scope of config?.authMethod === "api" ? [config.configScope ?? "global"] : ["project", "global"]) {
    const record = await readApiConfiguration(projectRoot, agentId, scope, options);
    // present，不是 owned：这个方法说的是「启动会带着哪份配置跑」。一份被用户在
    // 外面删掉的配置，账本还记得（owned），但启动不会带上它——把它列成可用的
    // 方法，用户会选中一个起不来任何 provider 的答案。
    if (record?.present) { api = record.relative; break; }
  }
  return { account: signedIn === "signed-in", api };
}

// Resolve the exact runtime used by an ordinary agent launch. Session
// continuation may add only session arguments; it must not select a model or
// provider of its own.
export async function resolveEffectiveAgentRuntime(projectRoot, agentId, options = {}) {
  const state = options.state ?? await loadRuntime(projectRoot);
  const config = effectiveAgentConfig(state, agentId);
  if (!config) throw new Error(`${getAgent(agentId).displayName} is not initialized`);
  // The project's answer, a remembered override or the option a host resolved
  // at launch: one of them decides the method. Nothing else may guess it. An
  // agent that manages its own authentication has no method here, and that is
  // an answer rather than a gap: the launch runs on the agent's own sign-in.
  const authMethod = config.authMethod ?? options.launchMethod ?? null;
  if (!getAgent(agentId).managesOwnAuth && authMethod !== "account" && authMethod !== "api") {
    throw new Error(`${getAgent(agentId).displayName} has no authentication method for this project`);
  }
  const scope = authMethod === null
    ? null
    : authMethod === "account"
      ? (config.accountScope ?? "global")
      : (config.configScope ?? "global");
  const notes = [];
  const inherited = options.environment ?? machineEnvironment();
  // A launch that adds nothing hands the agent the environment it was given,
  // unchanged and by identity: "this launch changes nothing" is then a fact a
  // caller can check, not a promise.
  const environment = agentRuntimeEnvironment(projectRoot, agentId, { authMethod, accountScope: scope }, inherited);
  let argumentsList = options.argumentsList ?? [];
  if (authMethod === "api" && !getAgent(agentId).managesOwnAuth) {
    const agent = getAgent(agentId);
    if (agentId === "codex" && scope === "project") {
      // Codex has no project-scope configuration file, so the project's answer
      // arrives the way Codex documents for one run: `-c key=value` overrides.
      const record = await readCodexProjectConfig(projectRoot);
      if (record) {
        argumentsList = [...codexLaunchArguments(record), ...argumentsList];
        const envKey = record.envKey || apiCredential("codex").key;
        if (!environment[envKey]) {
          notes.push(`${envKey} is not set: Codex reads this provider's key from that environment variable.`);
        }
      } else {
        notes.push(`No API configuration is stored for ${agent.displayName} — run \`avenic change\` to set one.`);
      }
    } else {
      const api = await readApiConfiguration(projectRoot, agentId, scope, options);
      if (!api?.present) {
        // Three ways for "not in effect", three different truths. The
        // configuration Avenic wrote may have been edited away outside Avenic
        // (the ledger still proves it was ours); the file may hold a
        // configuration Avenic did not write, the user's own, put there before
        // this project answered API — or by the version it upgraded from; or
        // there may be nothing at all. The remedy is the same, and calling the
        // middle case missing is the one the note must not do.
        notes.push(api?.owned
          ? `${api.relative} no longer holds the API configuration Avenic wrote — run \`avenic change\` to write it again.`
          : api?.exists
            ? `${api.relative} holds a provider configuration Avenic did not write — run \`avenic change\` to put it under Avenic's management.`
            : `No API configuration is stored for ${agent.displayName} in ${api?.relative ?? scope} — run \`avenic change\` to set one.`);
      }
    }
  }
  return {
    executable: getAgent(agentId).executable,
    authMethod,
    scope,
    config,
    argumentsList,
    environment,
    note: notes.length > 0 ? notes.join("\n") : null,
  };
}
