import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { getAgent } from "./agents.mjs";
import { AGENT_HOME_VARIABLE, CONFIG_FILE, CONFIG_FORMAT, NATIVE_HOME, accountHome } from "./agent-home.mjs";
import { environmentHome } from "./environment.mjs";
import { agentHomeRoot, ownershipFile } from "./project-paths.mjs";

// What Avenic's own "API · <scope>" answer prepares, and all it does there.
//
// The agent reads its provider, endpoint and model from a configuration file of
// its own, in its own format. Avenic's job is to make sure that file is where
// the agent will look — and then to get out of the way: the file's contents are
// the user's (their own hand, or the tool they configured it with), so Avenic
// never writes a provider, a model or a credential into it, never reformats it,
// and never edits a file it finds. A file that is there is preserved byte for
// byte; only a missing one is created, and an empty valid document is all it
// gets, because a configuration nobody has filled in is exactly that.
//
//   Claude  .claude/settings.local.json (project)   $CLAUDE_CONFIG_DIR/settings.json or ~/.claude/settings.json (global)
//   Codex   .agents/local/codex/config.toml (project)   $CODEX_HOME/config.toml or ~/.codex/config.toml (global)
//
// Claude's project file is read by Claude itself from the project, wherever its
// own home points; Codex has no project-scope configuration file of its own, so
// a project-scoped answer lives in a home the project owns and reaches Codex
// through its own CODEX_HOME variable at launch — the agent's mechanism, not a
// format Avenic made up.
//
// Deleting is the one destructive thing that can happen here, and it is bounded
// by proof: a row in `.agents/local/ownership.json` records that Avenic created
// this exact file and what its bytes hashed to at that moment. A file Avenic
// merely found is never its to delete, and one the user has edited since is
// theirs again — the ledger's hash is the whole test, and it never stores a
// value out of the file, so no credential ever ends up in Avenic's own records.

const OWNERSHIP_SCHEMA_VERSION = 1;

const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const hashOf = (text) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const keyOf = (agentId, scope) => `${agentId}:${scope}`;
const text = (value) => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);

/** The two agents whose provider configuration is a file Avenic can prepare. */
export function modelConfigAgents() {
  return Object.keys(CONFIG_FILE);
}

const emptyLedger = () => ({ schemaVersion: OWNERSHIP_SCHEMA_VERSION, files: {} });

async function writeAtomic(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, file);
}

async function readLedger(projectRoot) {
  const file = ownershipFile(projectRoot);
  if (!existsSync(file)) return emptyLedger();
  try {
    const parsed = JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
    return isPlainObject(parsed) && isPlainObject(parsed.files) ? { ...emptyLedger(), ...parsed, files: parsed.files } : emptyLedger();
  } catch {
    // A ledger that cannot be read cannot prove anything: nothing it would have
    // owned counts as Avenic's, so every file stays exactly where it is.
    return emptyLedger();
  }
}

async function writeLedger(projectRoot, ledger) {
  const file = ownershipFile(projectRoot);
  if (Object.keys(ledger.files).length === 0) {
    if (!existsSync(file)) return false;
    await rm(file, { force: true });
    return true;
  }
  const content = `${JSON.stringify(ledger, null, 2)}\n`;
  if (existsSync(file) && (await readFile(file, "utf8")) === content) return false;
  await writeAtomic(file, content);
  return true;
}

/**
 * Where one agent reads its provider/model configuration from, for one scope.
 * `homeDir` names the user's home when the caller is describing a world that is
 * not this process's own; `environment` carries the agent's own home variable,
 * which relocates the global target for real users of it.
 */
export function modelConfigTarget(projectRoot, agentId, scope, options = {}) {
  if (!CONFIG_FILE[agentId]) return null;
  const root = projectRoot ?? options.projectRoot ?? ".";
  const environment = options.environment ?? process.env;
  const format = CONFIG_FORMAT[agentId];
  // Claude's project file is read from the project itself — that is what makes
  // it the project's answer, and it is why a Project-scope Claude answer needs
  // no home redirect at all.
  if (agentId === "claude" && scope === "project") {
    return { file: path.join(root, ".claude", "settings.local.json"), relative: ".claude/settings.local.json", format };
  }
  const variable = AGENT_HOME_VARIABLE[agentId];
  const home = scope === "project"
    ? agentHomeRoot(root, agentId)
    : options.homeDir
      ? path.join(options.homeDir, NATIVE_HOME[agentId])
      : environment[variable] || path.join(environmentHome(environment), NATIVE_HOME[agentId]);
  const relative = scope === "project"
    ? `.agents/local/${agentId}/${CONFIG_FILE[agentId]}`
    : environment[variable]
      ? `$${variable}/${CONFIG_FILE[agentId]}`
      : `~/${NATIVE_HOME[agentId]}/${CONFIG_FILE[agentId]}`;
  return { file: path.join(home, CONFIG_FILE[agentId]), relative, format };
}

/** The same path as a host prints it, without needing a project root. */
export function modelConfigRelative(agentId, scope) {
  const target = modelConfigTarget(null, agentId, scope, {});
  if (target === null) throw new Error(`${getAgent(agentId).displayName} keeps its own provider configuration`);
  return target.relative;
}

/**
 * Prepare the file the agent reads: create it — empty, in the agent's own
 * minimal valid shape — when it is missing, and touch nothing when it is there.
 * Returns what it did, so a caller can say whether this run created it.
 */
export async function ensureModelConfiguration(projectRoot, agentId, scope, options = {}) {
  const target = modelConfigTarget(projectRoot, agentId, scope, options);
  if (!target) throw new Error(`${getAgent(agentId).displayName} keeps its own provider configuration`);
  if (existsSync(target.file)) return { relative: target.relative, file: target.file, created: false };
  const content = target.format === "json" ? "{}\n" : "";
  await writeAtomic(target.file, content);
  const ledger = await readLedger(projectRoot);
  ledger.files[keyOf(agentId, scope)] = { file: target.relative, createdByAvenic: true, hash: hashOf(content) };
  await writeLedger(projectRoot, ledger);
  return { relative: target.relative, file: target.file, created: true };
}

/** The line scanner for the one TOML shape a Codex configuration has. */
function tomlValue(source, key, section = null) {
  let current = null;
  for (const line of source.split("\n")) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) {
      current = header[1].trim();
      continue;
    }
    if (current !== section) continue;
    const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/);
    if (match && match[1] === key) {
      const raw = line.slice(match[0].length).trim();
      return raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2 ? raw.slice(1, -1).replace(/\\(["\\])/g, "$1") : raw;
    }
  }
  return null;
}

const hostOf = (baseUrl) => {
  try {
    return new URL(baseUrl).hostname || null;
  } catch {
    return null;
  }
};

// What one file says, in the agent's own keys. `null` means the file could not
// be read as its format at all — which is a fact a caller reports, not one it
// repairs.
function parseConfiguration(agentId, format, source) {
  try {
    if (agentId === "claude") {
      const parsed = JSON.parse(source.replace(/^\uFEFF/, ""));
      const env = isPlainObject(parsed?.env) ? parsed.env : {};
      const baseUrl = text(env.ANTHROPIC_BASE_URL);
      return {
        baseUrl,
        provider: hostOf(baseUrl),
        model: text(env.ANTHROPIC_MODEL),
        credentialSet: Boolean(text(env.ANTHROPIC_AUTH_TOKEN) ?? text(env.ANTHROPIC_API_KEY)),
        settings: {
          primary: text(env.ANTHROPIC_MODEL),
          opus: text(env.ANTHROPIC_DEFAULT_OPUS_MODEL),
          sonnet: text(env.ANTHROPIC_DEFAULT_SONNET_MODEL),
          haiku: text(env.ANTHROPIC_DEFAULT_HAIKU_MODEL),
          subagent: text(env.CLAUDE_CODE_SUBAGENT_MODEL),
          effort: text(env.CLAUDE_CODE_EFFORT_LEVEL),
        },
      };
    }
    if (format === "toml") {
      const id = tomlValue(source, "model_provider");
      const table = id ? `model_providers.${id}` : null;
      const declared = table ? tomlValue(source, "name", table) : null;
      return {
        baseUrl: table ? tomlValue(source, "base_url", table) : null,
        provider: declared ?? id,
        model: tomlValue(source, "model"),
        credentialSet: Boolean(table ? tomlValue(source, "env_key", table) : null),
        settings: { reasoning: tomlValue(source, "model_reasoning_effort") },
      };
    }
    return { baseUrl: null, provider: null, model: null, credentialSet: false, settings: {} };
  } catch {
    return null;
  }
}

// What Avenic can say about one configuration file: whether it is there, what it
// names, and whether Avenic is the one that made it. Every field is read from
// the file itself — a provider or model the file does not carry is `null`, and
// is never filled in with a guess, because "the file does not name one" is the
// honest answer and the one a user acts on.
export async function readModelConfiguration(projectRoot, agentId, scope, options = {}) {
  const target = modelConfigTarget(projectRoot, agentId, scope, options);
  if (!target) return null;
  const result = {
    relative: target.relative,
    file: target.file,
    exists: false,
    valid: true,
    configured: false,
    owned: false,
    unchanged: false,
    provider: null,
    baseUrl: null,
    model: null,
    credentialSet: false,
    settings: null,
  };
  const ledger = await readLedger(projectRoot);
  const record = ledger.files[keyOf(agentId, scope)] ?? null;
  // 「这个路径是 Avenic 建的」是账本里的一条记录，不是此刻磁盘上的一件东西：
  // 用户把 Avenic 建的那份文件删了，要说的仍然是「Avenic 建过的那份不在了」，
  // 而不是「这里从来没有过文件」。所以它在每一个出口都跟着走，包括读不出来
  // 的那些 —— 那两句话对读这一页的人是两件不同的事。
  const owned = Boolean(record?.createdByAvenic === true && record.file === target.relative);
  if (!existsSync(target.file)) return { ...result, owned };
  let source;
  try {
    source = await readFile(target.file, "utf8");
  } catch {
    return { ...result, exists: true, valid: false, owned };
  }
  const facts = parseConfiguration(agentId, target.format, source);
  if (facts === null) return { ...result, exists: true, valid: false, owned };
  const settings = Object.values(facts.settings ?? {}).some((value) => value !== null) ? facts.settings : null;
  return {
    ...result,
    exists: true,
    owned,
    unchanged: owned && record.hash === hashOf(source),
    provider: facts.provider,
    baseUrl: facts.baseUrl,
    model: facts.model,
    credentialSet: facts.credentialSet,
    settings,
    configured: Boolean(facts.provider || facts.baseUrl || facts.model || facts.credentialSet || settings),
  };
}

/**
 * What one agent's *own* home holds — the configuration the agent reads when it
 * runs on its account. Read-only, for the status page: an account's home can
 * name a model of its own, and reporting it is describing the agent's real
 * configuration rather than Avenic's.
 */
export async function readAccountConfiguration(projectRoot, agentId, scope, options = {}) {
  if (!CONFIG_FILE[agentId]) return null;
  const environment = options.environment ?? process.env;
  const home = accountHome(projectRoot, agentId, scope, environment);
  const file = path.join(home, CONFIG_FILE[agentId]);
  const relative = scope === "project" ? `.agents/local/${agentId}/${CONFIG_FILE[agentId]}` : `~/${NATIVE_HOME[agentId]}/${CONFIG_FILE[agentId]}`;
  if (!existsSync(file)) return { relative, exists: false, valid: true, configured: false, provider: null, model: null, settings: null };
  try {
    const facts = parseConfiguration(agentId, CONFIG_FORMAT[agentId], await readFile(file, "utf8"));
    if (facts === null) return { relative, exists: true, valid: false, configured: false, provider: null, model: null, settings: null };
    const settings = Object.values(facts.settings ?? {}).some((value) => value !== null) ? facts.settings : null;
    return { relative, exists: true, valid: true, provider: facts.provider, model: facts.model, settings, configured: Boolean(facts.provider || facts.model || settings) };
  } catch {
    return { relative, exists: true, valid: false, configured: false, provider: null, model: null, settings: null };
  }
}

/**
 * What the file a stored API answer points at is, asked once when a wizard
 * opens: the questions the user is shown can then describe what is really on
 * disk without the question list itself reading the filesystem on every
 * repaint. `owned`/`unchanged` travel with it because the destructive question
 * is about exactly those files — the ones Avenic created and nobody touched.
 */
export async function modelConfigPresence(projectRoot, agents, options = {}) {
  const presence = {};
  for (const [agentId, entry] of Object.entries(agents ?? {})) {
    if (entry?.authMethod !== "api") continue;
    const scope = entry.configScope ?? "global";
    const facts = await readModelConfiguration(projectRoot, agentId, scope, options);
    if (!facts) continue;
    presence[agentId] = { relative: facts.relative, scope, exists: facts.exists, owned: facts.owned, unchanged: facts.unchanged };
  }
  return presence;
}

/**
 * The file a project-scoped Codex API answer used to live in. Codex has no
 * project-scope configuration file of its own, so before 1.8.4 Avenic kept the
 * project's answer in a format of its own — `.agents/api/codex.json` — and
 * handed it to Codex as `-c` overrides at launch. The answer now lives in the
 * agent's own `config.toml`, under a home the project owns.
 *
 * The old file is never read, moved or deleted here. It was written by an
 * earlier Avenic and may carry a real credential, and a file with someone's
 * credential in it is moved by the person who owns it — so all this says is
 * where it is, which is what stops an upgrade from looking like a provider that
 * silently stopped applying. `null` for every other agent: no other answer ever
 * changed its file.
 */
export function legacyModelConfiguration(projectRoot, agentId) {
  if (agentId !== "codex") return null;
  const relative = ".agents/api/codex.json";
  const file = path.join(projectRoot, ".agents", "api", "codex.json");
  return { relative, file, exists: existsSync(file) };
}

/**
 * The file an API answer for this project would use, whether or not this
 * project is on one: what an Account answer is checked against when the status
 * page asks "is there a configuration here that is not in effect".
 */
export function modelConfigCandidate(projectRoot, agentId, options = {}) {
  const target = modelConfigTarget(projectRoot, agentId, "project", options);
  if (!target) return null;
  return { relative: target.relative, exists: existsSync(target.file) };
}

/**
 * Give back the file Avenic prepared, when — and only when — Avenic can prove it
 * prepared it: the ledger names this exact path, and the file still hashes to
 * what Avenic wrote. Anything else is the user's and stays, and the outcome says
 * which of the four cases it was so the caller can tell them apart.
 */
export async function removeModelConfiguration(projectRoot, agentId, scope, options = {}) {
  const target = modelConfigTarget(projectRoot, agentId, scope, options);
  const ledger = await readLedger(projectRoot);
  const record = ledger.files[keyOf(agentId, scope)] ?? null;
  if (!target) return { relative: null, outcome: "foreign", removed: false };
  const forget = async () => {
    if (!record) return;
    delete ledger.files[keyOf(agentId, scope)];
    await writeLedger(projectRoot, ledger);
  };
  if (!existsSync(target.file)) {
    await forget();
    return { relative: target.relative, outcome: "missing", removed: false };
  }
  if (!record || record.createdByAvenic !== true || record.file !== target.relative) {
    return { relative: target.relative, outcome: "foreign", removed: false };
  }
  const source = await readFile(target.file, "utf8");
  if (hashOf(source) !== record.hash) {
    return { relative: target.relative, outcome: "modified", removed: false };
  }
  await rm(target.file, { force: true });
  await forget();
  return { relative: target.relative, outcome: "deleted", removed: true };
}
