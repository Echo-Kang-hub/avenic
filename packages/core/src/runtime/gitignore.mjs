import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Every path Avenic creates on a machine rather than for the repository, and
// nothing else. `.claude/settings.local.json` and `.agents/local/` are the two
// the user's own hand fills — a provider, a credential, an agent's sign-in — so
// they must never reach a commit, and a project that never picks API mode is
// unaffected by the rules for them.
const REQUIRED_RULES = [
  ".claude/skills/",
  ".claude/settings.local.json",
  // The temporary a whole-file write renames into place: it lives beside its
  // target for a moment, and one left behind by a kill can carry a credential.
  "*.avenic-tmp",
  ".agents/skills/",
  ".agents/local/",
  ".agents/tmp/",
  ".agents/direct/",
  ".agents/licenses/",
  // What a provider's model list was when this machine asked for it. A cache is
  // a fact about the machine, not about the repository.
  ".agents/cache/",
  // Two paths Avenic no longer writes and must still keep out of a commit: a
  // project that answered API before 1.8.4 holds `.agents/api/<agent>.json` (a
  // file with a real credential in it, written by that version) and a
  // `.agents/projection.json` from before the canonical store. Neither is
  // removed — `removeRuntimeGitignore` drops a rule only once the path it
  // protects is gone — and a project that never had them is unaffected.
  ".agents/api/",
  ".agents/projection.json",
];
const SESSIONS_RULE = ".agents/sessions/";

async function readGitignore(projectRoot) {
  const file = path.join(projectRoot, ".gitignore");
  return {
    content: existsSync(file) ? await readFile(file, "utf8") : "",
    file,
  };
}

async function addRules(projectRoot, rules) {
  const { content, file } = await readGitignore(projectRoot);
  const lines = new Set(content.split(/\r?\n/).map((line) => line.trim()));
  const missing = rules.filter((rule) => !lines.has(rule));
  if (missing.length === 0) return false;
  const prefix = content.length === 0 ? "" : content.endsWith("\n") ? "\n" : "\n\n";
  await writeFile(file, `${content}${prefix}# Agent Runtime\n${missing.join("\n")}\n`, "utf8");
  return true;
}

export async function ensureRuntimeGitignore(projectRoot) {
  return addRules(projectRoot, REQUIRED_RULES);
}

export async function sessionsGitIgnored(projectRoot) {
  const { content } = await readGitignore(projectRoot);
  return content.split(/\r?\n/).some((line) => line.trim() === SESSIONS_RULE);
}

export async function setSessionsGitIgnored(projectRoot, ignored) {
  if (ignored) return addRules(projectRoot, [SESSIONS_RULE]);
  const { content, file } = await readGitignore(projectRoot);
  const lines = content.split(/\r?\n/);
  const filtered = lines.filter((line) => line.trim() !== SESSIONS_RULE);
  if (filtered.length === lines.length) return false;
  await writeFile(file, filtered.join("\n"), "utf8");
  return true;
}

export async function removeRuntimeGitignore(projectRoot, options = {}) {
  const { content, file } = await readGitignore(projectRoot);
  if (!content) return false;
  const removable = new Set();
  if (options.sessions) removable.add(SESSIONS_RULE);
  // A rule may only be dropped when the thing it protects is really gone: a
  // credential file left behind by a command that forgot its own rule is one
  // `git add -A` away from being committed. `.agents/local/` survives `deinit`
  // (the agent's own sign-in lives there), so its rule goes only with the
  // directory; the API configuration and its ledger are Avenic's, so their
  // rules go when Avenic's files do.
  //
  // 这两条原来是无条件删的，而它们护着的东西删的时候并不一定跟着走：`.agents/tmp/`
  // 只有在「最后一个 agent 也被 purge」那一支才被清掉，`*.avenic-tmp` 更是任何一次原子
  // 写在崩溃后留下的兄弟文件（它按名字匹配任何一层，没法在不扫全树的前提下逐个点名）。
  // 所以和上面同样的口径：护着的目录还在，规则就留着。
  const guarded = [
    [".agents/tmp/", path.join(projectRoot, ".agents", "tmp")],
    ["*.avenic-tmp", path.join(projectRoot, ".agents")],
    [".agents/local/", path.join(projectRoot, ".agents", "local")],
    [".agents/api/", path.join(projectRoot, ".agents", "api")],
    [".agents/cache/", path.join(projectRoot, ".agents", "cache")],
    [".agents/projection.json", path.join(projectRoot, ".agents", "projection.json")],
    [".claude/settings.local.json", path.join(projectRoot, ".claude", "settings.local.json")],
  ];
  for (const [rule, target] of guarded) {
    if (!existsSync(target)) removable.add(rule);
  }
  let lines = content.split(/\r?\n/).filter((line) => !removable.has(line.trim()));
  const managedRules = new Set([...REQUIRED_RULES, SESSIONS_RULE]);
  if (!lines.some((line) => managedRules.has(line.trim()))) {
    lines = lines.filter((line) => line.trim() !== "# Agent Runtime");
  }
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  const updated = lines.length > 0 ? `${lines.join("\n")}\n` : "";
  if (updated === content) return false;
  await writeFile(file, updated, "utf8");
  return true;
}

export { REQUIRED_RULES, SESSIONS_RULE };
