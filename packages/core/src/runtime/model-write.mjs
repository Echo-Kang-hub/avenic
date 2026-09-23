// Writing a provider into an agent's own configuration without taking the file
// away from its owner.
//
// The file Avenic writes into is not Avenic's: it also holds the user's
// permissions, their hooks, their plugins, their own environment variables and
// their comments. So a write here is a merge and never a rewrite — parse, change
// the keys the template names, put everything else back exactly where it was,
// write atomically — and the two formats are handled as what they are rather
// than as text that looks similar:
//
//   Claude   JSON, so the document is parsed and re-serialised. Unknown keys
//            survive because they are values in the same object; their order
//            survives because JavaScript objects keep insertion order; the
//            user's own env vars sit next to the template's. A file that cannot
//            be parsed is never repaired — it is the one case where a merge
//            refuses, because rewriting a file we did not understand is how a
//            person loses a file.
//
//   Codex    TOML, edited line by line. Codex's config is full of comments and
//            tables Avenic has no business reformatting, and there is no
//            standard-library TOML writer, so the merge touches the lines it
//            names and leaves every other byte alone. Codex reads its credential
//            from an environment variable named by `env_key`, which is why the
//            secret itself never appears in this file at all.

const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const stripBom = (text) => String(text ?? "").replace(/^﻿/, "");
const singleLine = (value, label) => {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (trimmed === "" || /[\r\n]/.test(trimmed)) throw new Error(`${label} must be a single non-empty line`);
  return trimmed;
};
const tomlString = (value, label) => `"${singleLine(value, label).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

/**
 * A key whose value is a secret — the name is what decides, never the value.
 * Names are compared with their separators gone (`x-api-key`, `apiKey` and
 * `API_KEY` are one name), because a header a user wrote by hand spells it
 * however it likes. `KEY` on its own is deliberately not a secret word:
 * `env_key` names the variable a credential lives in, and hiding that would
 * hide the one thing the user needs to see.
 *
 * The word has to be the whole end of the name, and it has to be the word that
 * names a credential: `author`, `secretary`, `authentic` and `tokenizer` are
 * somebody's fields, not secrets. `TOKEN` is the one word kept singular — every
 * native record carries `usage.input_tokens`, OpenCode files each message's
 * `tokens`, and those are a count rather than a credential, while a token that
 * is used as one is always qualified (`AUTH_TOKEN`, `accessToken`,
 * `REFRESH_TOKENS`). The same rule has to serve the canonical store, which
 * drops the keys it names from a conversation nobody may lose — an over-broad
 * word there does not hide a value, it deletes one.
 */
const SECRET_NAME = /(?:APIKEYS?|AUTHTOKENS?|ACCESSTOKENS?|REFRESHTOKENS?|IDTOKENS?|SECRETKEYS?|PRIVATEKEYS?|CLIENTSECRETS?|SECRETS?|PASSWORDS?|PASSWD|CREDENTIALS?|AUTHORIZATIONS?|TOKEN|COOKIES?)$/;
export const isSecretName = (name) => SECRET_NAME.test(String(name).toUpperCase().replace(/[^A-Z0-9]+/g, ""));
/**
 * A *value* that is a credential no matter what name it sits under — an API
 * key's own prefix, a GitHub token, an authorization header. The name-based
 * rule cannot see these: a custom provider's header or a field the user named
 * themselves can hold a real key under a name that says nothing, and a preview
 * that misses one credential is the leak the file's permissions exist to
 * prevent.
 */
const SECRET_VALUE = /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{16,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|Bearer\s+\S+)/g;

/**
 * A JSON configuration, parsed — and the one refusal both writers give.
 *
 * A file that cannot be parsed is never repaired: it is the one case where a
 * merge stops, because rewriting a file we did not understand is how a person
 * loses a file. The hooks writer refuses with the same sentence, which is why
 * this is one function and not two copies of a try/catch.
 */
export function parseJsonObject(text) {
  const source = stripBom(text);
  let parsed;
  try {
    parsed = source.trim() === "" ? {} : JSON.parse(source);
  } catch {
    throw new Error("the configuration is not valid JSON — Avenic will not rewrite a file it cannot read");
  }
  if (!isPlainObject(parsed)) throw new Error("the configuration is not a JSON object");
  return parsed;
}

function mergeInto(target, template) {
  for (const [key, value] of Object.entries(template)) {
    target[key] = isPlainObject(value) && isPlainObject(target[key]) ? mergeInto(target[key], value) : value;
  }
  return target;
}

/**
 * Claude's settings, with the template's keys merged in.
 *
 * `changed` is the answer to "would this write anything", and it compares the
 * parsed values rather than the text: a file the user formatted differently
 * holds the same configuration, so a merge that changes no value must leave the
 * bytes — and the formatting — alone.
 */
export function mergeClaudeSettings(existingText, template) {
  const parsed = parseJsonObject(existingText);
  const merged = mergeInto(structuredClone(parsed), template);
  return { text: `${JSON.stringify(merged, null, 2)}\n`, changed: JSON.stringify(merged) !== JSON.stringify(parsed), value: merged };
}

/** Root-level `key = value` lines, and the table headers they sit above. */
function findRootKey(lines, key) {
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index])) break;
    if (new RegExp(`^\\s*${key}\\s*=`).test(lines[index])) return index;
  }
  return -1;
}

function findTable(lines, header) {
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s*\[/.test(lines[index])) {
      end = index;
      break;
    }
  }
  return { start, end };
}

function findTableKey(lines, table, key, limit) {
  for (let index = table.start + 1; index < limit; index += 1) {
    if (new RegExp(`^\\s*${key}\\s*=`).test(lines[index])) return index;
  }
  return -1;
}

/**
 * Codex's config.toml with this provider's keys set, and every other line —
 * comments, other tables, other providers — untouched.
 */
export function mergeCodexConfig(existingText, provider) {
  const original = stripBom(existingText);
  const lines = original.split("\n");
  const wanted = {
    model: tomlString(provider.model, "the model"),
    model_provider: tomlString(provider.providerId, "the provider id"),
  };
  for (const [key, value] of Object.entries(wanted)) {
    const index = findRootKey(lines, key);
    if (index === -1) {
      // New root keys go at the end of the root block: after the comments that
      // introduce the file, before the first table that belongs to someone else.
      const first = lines.findIndex((line) => /^\s*\[/.test(line));
      lines.splice(first === -1 ? lines.length : first, 0, `${key} = ${value}`);
    } else {
      lines[index] = `${key} = ${value}`;
    }
  }

  const header = `[model_providers.${provider.providerId}]`;
  const table = findTable(lines, header);
  const entries = [
    ["name", tomlString(provider.displayName, "the provider name")],
    ["base_url", tomlString(provider.baseUrl, "the base URL")],
    ["env_key", tomlString(provider.envKey, "the environment variable")],
    // The old value, `chat`, was removed from Codex and now fails loudly.
    ["wire_api", '"responses"'],
  ];
  if (table === null) {
    if (lines.length > 0 && lines[lines.length - 1].trim() !== "") lines.push("");
    lines.push(header, ...entries.map(([key, value]) => `${key} = ${value}`));
  } else {
    let end = table.end;
    for (const [key, value] of entries) {
      const index = findTableKey(lines, table, key, end);
      if (index === -1) {
        lines.splice(end, 0, `${key} = ${value}`);
        end += 1;
      } else {
        lines[index] = `${key} = ${value}`;
      }
    }
  }
  const text = lines.join("\n");
  return { text, changed: text !== original };
}

/**
 * A credential's value, hidden. The key stays visible — a diff has to say which
 * line changed — and the value becomes four dots, whether it is being added,
 * replaced or removed. `env_key` is deliberately not a secret: it names the
 * variable a key lives in, and hiding it would hide the one thing the user needs
 * to see to know where to put their secret.
 *
 * Two rules, because a secret can be recognisable by its name or only by what
 * it looks like. A name that says nothing (`"x-api-key"`, a field the user
 * invented) is covered by the value itself.
 */
export function maskSecrets(line) {
  const named = String(line).replace(/(["']?)([A-Za-z0-9_.-]+)\1(\s*[:=]\s*)("[^"]*"|[^\s,}]+)/g, (all, quote, name, separator) =>
    isSecretName(name) ? `${quote}${name}${quote}${separator}"••••"` : all);
  return named.replace(SECRET_VALUE, "••••");
}

/** A document's lines. An empty document has none: `"".split("\n")` is one empty
 * line, and a preview whose first line removes nothing is a preview nobody trusts. */
function linesOf(text) {
  const body = stripBom(text);
  return body === "" ? [] : body.split("\n");
}

function indexFrom(list, line, start) {
  for (let index = start; index < list.length; index += 1) if (list[index].trim() === line.trim()) return index;
  return -1;
}

/**
 * What a write would do, line by line — the thing the user approves before
 * anything touches the disk. Secret values are masked on the way out, so the
 * preview cannot become the leak that the file's own permissions exist to
 * prevent, and a changed credential still shows which line it was.
 *
 * Lines are compared by what they say, not by how they are indented: a merge
 * rewrites the whole document in its own indent, which would otherwise turn
 * every line into a change — including a credential the merge never touched,
 * shown as a removal and an addition of a value nobody can read (see the test
 * that keeps it out). Re-indenting is not a change; what the user approves is
 * the lines whose meaning moved.
 *
 * The merge only ever replaces or appends lines, so aligning the two sides by
 * the next line they share is enough to say what moved — this is a preview, not
 * a patch format, and nothing consumes it but a person and a test.
 */
export function configurationDiff(before, after) {
  const from = linesOf(before);
  const to = linesOf(after);
  const out = [];
  // `masked` 说的是「这一行为什么被遮」：遮罩改过它，它就有秘密 —— 名字认出来的和
  // 值认出来的都算，比较一次胜过把两条规则再写一遍。
  const push = (kind) => (line) => {
    const text = maskSecrets(line);
    out.push({ kind, text, masked: kind !== "same" && text !== line });
  };
  const same = push("same");
  const add = push("add");
  const remove = push("remove");
  let left = 0;
  let right = 0;
  while (left < from.length && right < to.length) {
    if (from[left].trim() === to[right].trim()) {
      same(from[left]);
      left += 1;
      right += 1;
      continue;
    }
    const aheadInNew = indexFrom(to, from[left], right + 1);
    const aheadInOld = indexFrom(from, to[right], left + 1);
    if (aheadInNew !== -1 && (aheadInOld === -1 || aheadInNew - right <= aheadInOld - left)) {
      add(to[right]);
      right += 1;
    } else if (aheadInOld !== -1) {
      remove(from[left]);
      left += 1;
    } else {
      remove(from[left]);
      add(to[right]);
      left += 1;
      right += 1;
    }
  }
  while (left < from.length) {
    remove(from[left]);
    left += 1;
  }
  while (right < to.length) {
    add(to[right]);
    right += 1;
  }
  return out;
}
