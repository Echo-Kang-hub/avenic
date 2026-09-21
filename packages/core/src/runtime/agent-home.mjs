import path from "node:path";
import process from "node:process";
import { getAgent } from "./agents.mjs";
import { environmentHome } from "./environment.mjs";
import { agentHomeRoot } from "./project-paths.mjs";

// The variable each agent reads to find its own configuration and auth home,
// and the directory it defaults to. Naming them is the whole mechanism: the
// agent's login writes its own files there, in its own format, and Avenic never
// invents one. One map, because "where does this agent's home live" is asked by
// the launcher, the watchdog, the configuration writer and the status page, and
// they must not answer it differently.
export const AGENT_HOME_VARIABLE = { claude: "CLAUDE_CONFIG_DIR", codex: "CODEX_HOME" };
export const NATIVE_HOME = { claude: ".claude", codex: ".codex" };

/** The file inside a home the agent reads its provider/model configuration from. */
export const CONFIG_FILE = { claude: "settings.json", codex: "config.toml" };
export const CONFIG_FORMAT = { claude: "json", codex: "toml" };

// Auth · Project 时 agent 的家（也是账户的家），以及全局那一个——同一个变量可以
// 把它挪到别处，所以先问变量、再问用户的家。Agent 自己没有这个变量的（OpenCode
// 之类）在这里没有家可报，抛一句而不是拼一个 undefined 进去。
export function accountHome(projectRoot, agentId, scope, environment = process.env) {
  const variable = AGENT_HOME_VARIABLE[agentId];
  if (!variable) throw new Error(`${getAgent(agentId).displayName} keeps its own configuration home`);
  if (scope === "project") return agentHomeRoot(projectRoot, agentId);
  return environment[variable] || path.join(environmentHome(environment), NATIVE_HOME[agentId]);
}

// The same home as a host prints it, without needing a project root — the row
// under an Account answer (`Project (.agents/local/codex)`). A home the user
// relocated through the agent's own variable is named by that variable rather
// than by a `~` that is no longer where it is.
export function accountHomeRelative(agentId, scope, environment = process.env) {
  const variable = AGENT_HOME_VARIABLE[agentId];
  if (!variable) throw new Error(`${getAgent(agentId).displayName} keeps its own configuration home`);
  if (scope === "project") return `.agents/local/${agentId}`;
  return environment[variable] ? `$${variable}` : `~/${NATIVE_HOME[agentId]}`;
}
