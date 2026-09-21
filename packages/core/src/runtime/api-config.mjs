import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getAgent } from "./agents.mjs";
import { environmentHome } from "./environment.mjs";

// API mode writes the agent's *own* configuration — the file it reads
// natively — and nothing else. There is no provider catalog, no preset table
// and no per-agent credential format: the wizard collects a provider label, an
// endpoint, a model and a credential, and this module puts them where that
// agent already looks:
//
//   Claude  .claude/settings.local.json (project) / ~/.claude/settings.json
//           env.ANTHROPIC_BASE_URL, env.ANTHROPIC_MODEL, env.ANTHROPIC_AUTH_TOKEN
//   Codex   ~/.codex/config.toml (global): model + model_provider + a
//           [model_providers.<id>] table with name/base_url/env_key/wire_api.
//           Codex has no project-scope config file, so the project's answer
//           lives in Avenic's own `.agents/api/codex.json` and reaches the
//           agent through Codex's documented `-c key=value` overrides.
//
// A file the user also writes to cannot be edited by value alone, so every
// native write keeps a ledger of the exact key paths it created, what it
// wrote, and what was there before. Removal then gives back only what it can
// prove it wrote; a foreign key, a permission block, a hook, a file whose
// ownership cannot be proven — all stay exactly as found. The ledger never
// contains a secret: a credential row keeps a hash, so "unchanged since we
// wrote it" is still provable without a second copy of the key.
const PROJECTION_FILE = ".agents/projection.json";
const PROJECTION_SCHEMA_VERSION = 1;
const SECRET_KEYS = new Set(["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"]);

const hashOf = (value) => `sha256:${createHash("sha256").update(String(value)).digest("hex")}`;
const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** The credential field each agent's native configuration expects. */
export function apiCredential(agentId) {
  return agentId === "codex"
    ? { key: "OPENAI_API_KEY", secret: false, label: "Credential variable", hint: "the environment variable Codex reads for the key — Avenic never stores the key itself" }
    : { key: "ANTHROPIC_AUTH_TOKEN", secret: true, label: "API credential", hint: "the bearer token this endpoint expects" };
}

// codex reads `wire_api` from the provider table: OpenAI's own endpoint speaks
// the Responses API, everything else Avenic can write a config for is a
// chat-completions endpoint.
export function codexWireApi(baseUrl) {
  try {
    return new URL(baseUrl).hostname === "api.openai.com" ? "responses" : "chat";
  } catch {
    return "chat";
  }
}

/** The provider id a Codex provider table is keyed by: derived, never asked. */
export function providerIdFor(provider) {
  const slug = String(provider ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return slug || "custom";
}

function targetFor(projectRoot, agentId, scope, options) {
  // The home comes from the environment the caller handed in, the same way
  // every other home does: a host that redirected its environment — a fixture,
  // an editor asking about another workspace — must not have the global half of
  // a configuration read from, or written to, this process's own home.
  const home = options.homeDir ?? environmentHome(options.environment);
  const root = projectRoot ?? options.projectRoot ?? ".";
  if (agentId === "claude") {
    return scope === "project"
      ? { file: path.join(root, ".claude", "settings.local.json"), relative: ".claude/settings.local.json", format: "json", native: true }
      : { file: path.join(home, ".claude", "settings.json"), relative: "~/.claude/settings.json", format: "json", native: true };
  }
  if (agentId === "codex") {
    return scope === "project"
      ? { file: path.join(root, ".agents", "api", "codex.json"), relative: ".agents/api/codex.json", format: "avenic", native: false }
      : { file: path.join(home, ".codex", "config.toml"), relative: "~/.codex/config.toml", format: "toml", native: true };
  }
  return null;
}

/** Where one agent's API configuration lives, per scope. */
export function apiTarget(projectRoot, agentId, scope, options = {}) {
  return targetFor(projectRoot, agentId, scope, options);
}

/** The same path as a host prints it, without needing a project root. */
export function apiRelative(agentId, scope) {
  const target = targetFor(null, agentId, scope, {});
  // An agent with no Avenic-managed API target of its own (OpenCode writes its
  // provider configuration itself) has no path to name: the caller gets a
  // sentence instead of a property read on null.
  if (target === null) throw new Error(`${getAgent(agentId).displayName} manages its own authentication and provider configuration`);
  return target.relative;
}

export function apiAgents() {
  return ["claude", "codex"];
}

/** The key paths one agent's API configuration owns, in its file's shape. */
export function apiEntries(agentId, fields = {}) {
  const text = (value) => (typeof value === "string" ? value.trim() : "");
  if (agentId === "claude") {
    const rows = [];
    if (text(fields.baseUrl)) rows.push({ path: ["env", "ANTHROPIC_BASE_URL"], value: text(fields.baseUrl) });
    if (text(fields.model)) rows.push({ path: ["env", "ANTHROPIC_MODEL"], value: text(fields.model) });
    if (text(fields.credential)) rows.push({ path: ["env", "ANTHROPIC_AUTH_TOKEN"], value: text(fields.credential) });
    return rows;
  }
  if (agentId === "codex") {
    const id = providerIdFor(fields.provider);
    const rows = [];
    if (text(fields.model)) rows.push({ path: ["model"], value: text(fields.model) });
    if (text(fields.provider)) rows.push({ path: ["model_provider"], value: id });
    if (text(fields.baseUrl)) rows.push({ path: ["model_providers", id, "base_url"], value: text(fields.baseUrl) });
    if (text(fields.provider)) rows.push({ path: ["model_providers", id, "name"], value: text(fields.provider) });
    if (text(fields.credential)) rows.push({ path: ["model_providers", id, "env_key"], value: text(fields.credential) });
    if (text(fields.baseUrl)) rows.push({ path: ["model_providers", id, "wire_api"], value: codexWireApi(text(fields.baseUrl)) });
    return rows;
  }
  return [];
}

// The three shapes a target file can have, behind one interface: a document
// type, and read/write/delete of one key path inside it. JSON keeps its parsed
// object; TOML stays text and is edited line by line so every key Avenic does
// not own survives byte for byte.
const FORMATS = {
  json: {
    parse: (text) => JSON.parse(text.replace(/^﻿/, "")),
    serialize: (document) => `${JSON.stringify(document, null, 2)}\n`,
    get(document, pathArray) {
      let cursor = document;
      for (const key of pathArray) {
        if (!isPlainObject(cursor) || !Object.hasOwn(cursor, key)) return { exists: false };
        cursor = cursor[key];
      }
      return { exists: true, value: cursor };
    },
    set(document, pathArray, value) {
      let cursor = document;
      for (const key of pathArray.slice(0, -1)) {
        if (!isPlainObject(cursor[key])) cursor[key] = {};
        cursor = cursor[key];
      }
      cursor[pathArray.at(-1)] = value;
      return document;
    },
    remove(document, pathArray) {
      let cursor = document;
      for (const key of pathArray.slice(0, -1)) {
        if (!isPlainObject(cursor?.[key])) return document;
        cursor = cursor[key];
      }
      delete cursor[pathArray.at(-1)];
      return document;
    },
    // "Nothing left" means nothing beyond the one block Avenic filled in: a
    // file the user wrote into — even just a permissions or hooks block —
    // stays, however empty it looks.
    isEmpty: (document) => Object.keys(document).length === 0
      || (Object.keys(document).length === 1 && isPlainObject(document.env) && Object.keys(document.env).length === 0),
    empty: () => ({}),
  },
  toml: {
    parse: (text) => text,
    serialize: (text) => (text === "" || text.endsWith("\n") ? text : `${text}\n`),
    get: (text, pathArray) => {
      const found = tomlLocate(text, pathArray);
      return found ? { exists: true, value: found.value } : { exists: false };
    },
    set: (text, pathArray, value) => tomlWrite(text, pathArray, tomlQuote(value)),
    remove: (text, pathArray) => tomlDelete(text, pathArray),
    isEmpty: (text) => text.trim() === "",
    empty: () => "",
  },
};

const TOML_SECTION = /^\s*\[([^\]]+)\]\s*$/;
const TOML_KEY = /^\s*([A-Za-z0-9_-]+)\s*=/;

const tomlQuote = (value) => `"${String(value).replace(/([\\"])/g, "\\$1")}"`;

function tomlUnquote(raw) {
  const text = raw.trim();
  return text.startsWith('"') && text.endsWith('"') && text.length >= 2
    ? text.slice(1, -1).replace(/\\(["\\])/g, "$1")
    : text;
}

// The line a key path lives on, in the top-level area or in its provider table.
function tomlLocate(text, pathArray) {
  const section = pathArray.length === 1 ? null : `model_providers.${pathArray[1]}`;
  const key = pathArray.at(-1);
  let current = null;
  for (const line of text.split("\n")) {
    const header = line.match(TOML_SECTION);
    if (header) {
      current = header[1].trim();
      continue;
    }
    if (current !== section) continue;
    const match = line.match(TOML_KEY);
    if (match && match[1] === key) {
      return { value: tomlUnquote(line.slice(match[0].length)) };
    }
  }
  return null;
}

function tomlWrite(text, pathArray, literal) {
  const section = pathArray.length === 1 ? null : `model_providers.${pathArray[1]}`;
  const key = pathArray.at(-1);
  const line = `${key} = ${literal}`;
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  let current = null;
  let sectionAt = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const header = lines[index].match(TOML_SECTION);
    if (header) {
      current = header[1].trim();
      if (current === section) sectionAt = index;
      continue;
    }
    const match = lines[index].match(TOML_KEY);
    if (match && match[1] === key && current === section) {
      lines[index] = line;
      return lines.join("\n");
    }
  }
  if (section === null) {
    // Top-level keys belong above the first table, whatever order they arrive in.
    const at = lines.findIndex((row) => TOML_SECTION.test(row));
    const index = at === -1 ? lines.length : at;
    lines.splice(index, 0, line);
    return lines.join("\n");
  }
  if (sectionAt === -1) {
    if (lines.length > 0) lines.push("");
    lines.push(`[${section}]`, line);
    return lines.join("\n");
  }
  let end = sectionAt + 1;
  while (end < lines.length && !TOML_SECTION.test(lines[end])) end += 1;
  while (end > sectionAt + 1 && lines[end - 1].trim() === "") end -= 1;
  lines.splice(end, 0, line);
  return lines.join("\n");
}

function tomlDelete(text, pathArray) {
  const section = pathArray.length === 1 ? null : `model_providers.${pathArray[1]}`;
  const key = pathArray.at(-1);
  const lines = text.replace(/\n$/, "").split("\n");
  let current = null;
  let sectionAt = -1;
  let at = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const header = lines[index].match(TOML_SECTION);
    if (header) {
      current = header[1].trim();
      if (current === section) sectionAt = index;
      continue;
    }
    const match = lines[index].match(TOML_KEY);
    if (match && match[1] === key && current === section) {
      at = index;
      break;
    }
  }
  if (at === -1) return text;
  lines.splice(at, 1);
  // A table we emptied is not left behind as an empty heading.
  if (section !== null && sectionAt !== -1) {
    const rest = lines.slice(sectionAt + 1).findIndex((row) => TOML_SECTION.test(row));
    const end = rest === -1 ? lines.length : sectionAt + 1 + rest;
    if (lines.slice(sectionAt + 1, end).every((row) => row.trim() === "")) {
      lines.splice(sectionAt, end - sectionAt);
      if (lines.at(-1) === "") lines.pop();
    }
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

const emptyLedger = () => ({ schemaVersion: PROJECTION_SCHEMA_VERSION, agents: {} });

async function readLedger(projectRoot) {
  const file = path.join(projectRoot, PROJECTION_FILE);
  if (!existsSync(file)) return emptyLedger();
  try {
    const parsed = JSON.parse((await readFile(file, "utf8")).replace(/^﻿/, ""));
    return isPlainObject(parsed) && isPlainObject(parsed.agents) ? parsed : emptyLedger();
  } catch {
    // A ledger that cannot be read cannot prove ownership: nothing it would
    // have owned is treated as Avenic's, so every value stays where it is.
    return emptyLedger();
  }
}

async function writeLedger(projectRoot, ledger) {
  const file = path.join(projectRoot, PROJECTION_FILE);
  // An ownership record with nothing in it is not left on disk: removing the
  // last configuration removes the record too.
  if (Object.keys(ledger.agents ?? {}).length === 0) {
    if (!existsSync(file)) return false;
    await rm(file, { force: true });
    return true;
  }
  const content = `${JSON.stringify(ledger, null, 2)}\n`;
  if (existsSync(file) && (await readFile(file, "utf8")) === content) return false;
  await writeOwnedFile(file, content);
  return true;
}

// A file replaced whole, through a temporary that sits beside it — the rename
// is the same filesystem's, so a reader sees the old file or the new one and
// never half of either. The temporary is created private (a configuration can
// carry a credential, and a kill in the window must not leave one readable),
// and named with the suffix `REQUIRED_RULES` ignores, so one left behind by a
// kill is never one `git add -A` away from a commit.
const TEMPORARY_SUFFIX = ".avenic-tmp";

async function writeAtomic(file, content) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}${TEMPORARY_SUFFIX}`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, file);
}

// Avenic's own project files are written whole: no merge, no ledger, because
// nothing but Avenic writes them.
async function writeOwnedFile(file, content) {
  await writeAtomic(file, content);
}

function recordFor(ledger, agentId, scope) {
  return ledger.agents?.[agentId]?.[scope] ?? null;
}

function dropRecord(ledger, agentId, scope) {
  delete ledger.agents?.[agentId]?.[scope];
  if (isPlainObject(ledger.agents?.[agentId]) && Object.keys(ledger.agents[agentId]).length === 0) {
    delete ledger.agents[agentId];
  }
}

async function readDocument(file, format) {
  if (!existsSync(file)) return { document: FORMATS[format].empty(), created: true };
  const text = await readFile(file, "utf8");
  try {
    return { document: FORMATS[format].parse(text), created: false };
  } catch {
    throw new Error(`Refusing to edit ${file}: it is not a valid ${format} document`);
  }
}

async function saveDocument(file, format, document) {
  await writeAtomic(file, FORMATS[format].serialize(document));
}

function beforeOf(format, document, pathArray) {
  const found = FORMATS[format].get(document, pathArray);
  if (!found.exists) return { exists: false };
  return SECRET_KEYS.has(pathArray.at(-1))
    ? { exists: true, hash: hashOf(found.value) }
    : { exists: true, value: found.value };
}

// Whether a key still holds what Avenic wrote there: values compare by value,
// credentials by hash (the ledger never stores the value). One rule, shared by
// the read that reports whether the configuration is still in the file and the
// removal that gives the row back — two copies would drift apart.
function holdsWrittenValue(found, row) {
  if (!found.exists) return false;
  return row.writtenHash !== undefined ? hashOf(found.value) === row.writtenHash : found.value === row.written;
}

// Give one owned row back to the file: a key still holding what we wrote is
// restored to its before-value, or removed; a key the user has since changed
// is theirs again and stays.
function restore(format, document, row) {
  const found = FORMATS[format].get(document, row.path);
  if (!found.exists) return { outcome: "missing", document };
  if (!holdsWrittenValue(found, row)) return { outcome: "conflict", document };
  if (row.before?.exists === true) {
    // A credential of the user's that was already there is kept in the ledger
    // as a hash alone, because the ledger never holds a value. Such a before
    // state cannot be given back, so the key is left exactly as it is: deleting
    // it would destroy something Avenic provably did not write, and reporting
    // a clean restore on top of that would be worse than either. The caller is
    // told, and can say which key it could not put back.
    if (row.before.value === undefined) return { outcome: "kept", document };
    return { outcome: "restored", document: FORMATS[format].set(document, row.path, row.before.value) };
  }
  return { outcome: "removed", document: FORMATS[format].remove(document, row.path) };
}

// A record that only Avenic writes: the project's Codex answer, which Codex
// itself reads through `-c` overrides at launch.
async function writeAvenicRecord(target, agentId, fields) {
  const text = (value) => (typeof value === "string" ? value.trim() : "");
  // A blank credential answer means "unchanged" here too. The wizard shows the
  // credential as kept, so this answer set does not name it — and defaulting
  // the variable name to OPENAI_API_KEY would be a silent edit to something the
  // user typed, in the one file Avenic fully owns: the launch would pass Codex
  // a name nothing in the environment answers to. Only a readable old record
  // may supply it; an unreadable file gets the default.
  let previous = null;
  if (existsSync(target.file)) {
    try { previous = JSON.parse(await readFile(target.file, "utf8")); } catch { previous = null; }
  }
  const record = {
    provider: text(fields.provider),
    baseUrl: text(fields.baseUrl),
    model: text(fields.model),
    envKey: text(fields.credential) || text(previous?.envKey) || apiCredential(agentId).key,
  };
  const created = !existsSync(target.file);
  await writeOwnedFile(target.file, `${JSON.stringify({ ...record, wireApi: codexWireApi(record.baseUrl) }, null, 2)}\n`);
  return { relative: target.relative, created, removed: [] };
}

/**
 * Apply one API configuration. Missing directories and a missing file are
 * created; an existing file keeps every key Avenic does not own. A key Avenic
 * owned before and the new answers no longer name is given back the same way
 * `remove` gives it back — the file always states the current selection.
 */
export async function writeApiConfiguration(projectRoot, agentId, scope, fields = {}, options = {}) {
  const target = targetFor(projectRoot, agentId, scope, options);
  if (!target) throw new Error(`${agentId} has no Avenic-managed API configuration`);
  if (!target.native) return writeAvenicRecord(target, agentId, fields);
  const format = FORMATS[target.format];
  const ledger = await readLedger(projectRoot);
  const previous = recordFor(ledger, agentId, scope);
  const opened = await readDocument(target.file, target.format);
  let document = opened.document;
  const created = opened.created;
  const entries = apiEntries(agentId, fields);
  const claimed = new Set(entries.map((entry) => entry.path.join("\u0000")));
  const rows = [];
  const retained = [];
  for (const row of previous?.entries ?? []) {
    if (claimed.has(row.path.join("\u0000"))) continue;
    // A secret Avenic wrote is never shown to the reader, so it can never be
    // retyped: an answer set that does not name it means "unchanged", never
    // "remove". Clearing the configuration is the keep/remove question's job,
    // and `removeApiConfiguration` gives the value back its before-state.
    if (SECRET_KEYS.has(row.path.at(-1))) {
      // Kept only while the key is still there: a user who deleted it by hand
      // must not leave the ledger claiming a value that is gone.
      if (FORMATS[target.format].get(document, row.path).exists) retained.push(row);
      continue;
    }
    document = restore(target.format, document, row).document;
  }
  for (const entry of entries) {
    const prior = (previous?.entries ?? []).find((row) => row.path.join("\u0000") === entry.path.join("\u0000"));
    // Rewriting a key we already own keeps the *original* before-value, or a
    // later removal would hand back our own old value as if it were the user's.
    const before = prior ? prior.before : beforeOf(target.format, document, entry.path);
    document = format.set(document, entry.path, entry.value);
    rows.push(SECRET_KEYS.has(entry.path.at(-1))
      ? { path: entry.path, before, writtenHash: hashOf(entry.value) }
      : { path: entry.path, before, written: entry.value });
  }
  await saveDocument(target.file, target.format, document);
  ledger.agents ??= {};
  ledger.agents[agentId] ??= {};
  ledger.agents[agentId][scope] = {
    file: target.relative,
    created: previous?.created ?? created,
    provider: (typeof fields.provider === "string" && fields.provider.trim()) || previous?.provider || null,
    entries: [...rows, ...retained],
  };
  await writeLedger(projectRoot, ledger);
  return { relative: target.relative, created, removed: [] };
}

/**
 * What one scope's API configuration says, for the wizard's prefill and the
 * status page. Only keys the ledger proves Avenic wrote are reported — a
 * provider key the user wrote themselves is the user's answer, not this
 * project's. A credential is reported as present or absent, never printed.
 * `owned` and `present` are two different questions — see below.
 */
export async function readApiConfiguration(projectRoot, agentId, scope, options = {}) {
  const target = targetFor(projectRoot, agentId, scope, options);
  if (!target) return null;
  const result = { relative: target.relative, exists: existsSync(target.file), owned: false, present: false, provider: null, baseUrl: null, model: null, credentialSet: false };
  if (!result.exists) return result;
  try {
    if (!target.native) {
      const record = JSON.parse(await readFile(target.file, "utf8"));
      // Avenic's own whole file: its content *is* the configuration, so
      // provenance and presence coincide.
      return { ...result, owned: true, present: true, provider: record.provider || null, baseUrl: record.baseUrl || null, model: record.model || null, credentialSet: Boolean(record.envKey) };
    }
    const ledger = await readLedger(projectRoot);
    const record = recordFor(ledger, agentId, scope);
    if (!record) return result;
    const { document } = await readDocument(target.file, target.format);
    const values = {};
    for (const row of record.entries ?? []) {
      const found = FORMATS[target.format].get(document, row.path);
      if (found.exists) values[row.path.join(".")] = found.value;
    }
    const entry = (name) => Object.entries(values).find(([key]) => key === name || key.endsWith(`.${name}`))?.[1] ?? null;
    // 「Avenic 写过」（owned）与「Avenic 写的那份还在文件里」（present）是两个问题。
    // 用户在 Avenic 之外删掉或改掉一个键之后，第一个仍然成立——账本还证明得了哪些
    // 键是 Avenic 的，将来归还全靠它——第二个不再成立。provider/model 那样的字段
    // 只有在 present 时才是现在时；present 为假时把它们显示出来，就是把过去时当
    // 既成事实。逐行比对与 restore() 用同一条规则。
    const present = (record.entries ?? []).length > 0
      && (record.entries ?? []).every((row) => holdsWrittenValue(FORMATS[target.format].get(document, row.path), row));
    return {
      ...result,
      owned: true,
      present,
      provider: record.provider ?? entry("name"),
      baseUrl: entry("ANTHROPIC_BASE_URL") ?? entry("base_url"),
      model: entry("ANTHROPIC_MODEL") ?? entry("model"),
      credentialSet: Boolean(entry("ANTHROPIC_AUTH_TOKEN") ?? entry("env_key")),
    };
  } catch {
    return result;
  }
}

/**
 * Where a project's API questions start: for each agent whose answer is API,
 * the fields the wizard shows, read from the file Avenic wrote. Without this an
 * edit would open on empty fields, and applying them would be an answer that
 * takes the configuration away. The credential is reported as already set and
 * never as a value — it is never echoed back, so an empty field means "keep",
 * which is why the writer retains a secret an answer set does not name.
 */
export async function apiPrefill(projectRoot, agents, options = {}) {
  const fields = {};
  for (const [agentId, entry] of Object.entries(agents ?? {})) {
    if (entry?.authMethod !== "api") continue;
    const record = await readApiConfiguration(projectRoot, agentId, entry.configScope ?? "global", options);
    fields[agentId] = {
      provider: record?.provider ?? "",
      baseUrl: record?.baseUrl ?? "",
      model: record?.model ?? "",
      credentialSet: record?.credentialSet === true,
    };
  }
  return fields;
}

/**
 * Give back exactly what Avenic wrote. A native file Avenic created is deleted
 * when removing its keys left nothing else in it. Conflicts — a key the user
 * changed after Avenic wrote it — are reported and kept; so is a credential
 * whose earlier value Avenic never stored, and a `kept` count says how many
 * keys were left standing rather than given back.
 */
export async function removeApiConfiguration(projectRoot, agentId, scope, options = {}) {
  const target = targetFor(projectRoot, agentId, scope, options);
  if (!target) return { relative: null, removed: 0, conflicts: 0, kept: 0, deleted: false };
  if (!target.native) {
    if (!existsSync(target.file)) return { relative: target.relative, removed: 0, conflicts: 0, kept: 0, deleted: false };
    await rm(target.file, { force: true });
    return { relative: target.relative, removed: 0, conflicts: 0, kept: 0, deleted: true };
  }
  const ledger = await readLedger(projectRoot);
  const record = recordFor(ledger, agentId, scope);
  if (!record || !existsSync(target.file)) return { relative: target.relative, removed: 0, conflicts: 0, kept: 0, deleted: false };
  let document = (await readDocument(target.file, target.format)).document;
  let removed = 0;
  let conflicts = 0;
  let kept = 0;
  for (const row of record.entries ?? []) {
    const outcome = restore(target.format, document, row);
    document = outcome.document;
    if (outcome.outcome === "conflict") conflicts += 1;
    else if (outcome.outcome === "kept") kept += 1;
    else removed += 1;
  }
  let deleted = false;
  if (record.created === true && FORMATS[target.format].isEmpty(document)) {
    await rm(target.file, { force: true });
    deleted = true;
  } else {
    await saveDocument(target.file, target.format, document);
  }
  dropRecord(ledger, agentId, scope);
  await writeLedger(projectRoot, ledger);
  return { relative: target.relative, removed, conflicts, kept, deleted };
}

/** The project's Codex answer, as the launch path needs it. */
export async function readCodexProjectConfig(projectRoot) {
  const file = path.join(projectRoot, ".agents", "api", "codex.json");
  if (!existsSync(file)) return null;
  try {
    const record = JSON.parse(await readFile(file, "utf8"));
    return isPlainObject(record) && record.baseUrl ? record : null;
  } catch {
    return null;
  }
}

// Codex's own override channel, documented by `codex --help`: the same keys
// the global config.toml would carry, for one launch.
export function codexLaunchArguments(record) {
  if (!record?.baseUrl || !record.model) return [];
  const id = providerIdFor(record.provider);
  const values = [
    ["model", record.model],
    ["model_provider", id],
    [`model_providers.${id}.name`, record.provider || id],
    [`model_providers.${id}.base_url`, record.baseUrl],
    [`model_providers.${id}.env_key`, record.envKey || apiCredential("codex").key],
    [`model_providers.${id}.wire_api`, record.wireApi || codexWireApi(record.baseUrl)],
  ];
  return values.flatMap(([key, value]) => ["-c", `${key}=${value}`]);
}

export { PROJECTION_FILE };
