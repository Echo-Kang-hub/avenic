import { mkdir } from "node:fs/promises";
import process from "node:process";
import { resolveOnPath, spawnExecutable } from "../runtime/process.mjs";
import { fail } from "../util/fail.mjs";

export { fail };

// git says what went wrong in prose, and exits 128 for all of it. The user's
// next move differs per cause — log in, fix the spec, fix the branch, fix the
// network, install git — so the first thing a failure does is name its kind.
// The patterns are git's own wording, most specific first: "unable to access"
// appears in both the 403 and the DNS message, so authentication is matched
// before network ever sees it.
const GIT_FAILURE_KINDS = [
  {
    kind: "authentication",
    hint: "Your git credentials were rejected. Check them with: gh auth status, ssh -T git@github.com, or your credential helper.",
    pattern: /authentication failed|could not read username|could not read password|permission denied \(publickey\)|invalid username or password|terminal prompts disabled|support for password authentication was removed|returned error: (?:401|403)|403 forbidden|401 unauthorized|access denied/i,
  },
  {
    kind: "repo-missing",
    hint: "The Hub repository was not found. Check the owner/repo spelling, and that your account can see it.",
    pattern: /repository not found|repository .* does not exist|does not appear to be a git repository|remote: not found|returned error: 404|\b404\b/i,
  },
  {
    kind: "ref-missing",
    hint: "That branch or ref does not exist. Check the part after '#' in the Hub spec.",
    pattern: /couldn't find remote ref|could not find remote ref|remote branch .* not found|unknown revision|not our ref|bad revision/i,
  },
  {
    kind: "git-missing",
    hint: "Install git and make sure it is on PATH, then try again.",
    pattern: /not recognized as an internal or external command|command not found|no such file or directory/i,
  },
  {
    kind: "network",
    hint: "The network or a proxy blocked the connection. Check your connection, proxy or VPN, then try again.",
    pattern: /could not resolve host|failed to connect|connection (?:timed out|refused|reset)|operation timed out|ssl|tls|schannel|unable to access/i,
  },
];

export function classifyGitFailure(stderr) {
  const text = String(stderr ?? "");
  for (const entry of GIT_FAILURE_KINDS) {
    if (entry.pattern.test(text)) return { kind: entry.kind, hint: entry.hint };
  }
  return { kind: "unknown", hint: "Run the same git command by hand to see the full output." };
}

export function gitFailure(kind, { detail, hint } = {}) {
  const known = GIT_FAILURE_KINDS.find((entry) => entry.kind === kind) ?? GIT_FAILURE_KINDS.at(-1);
  const error = new Error(detail ? `${detail}\n${hint ?? known.hint}` : hint ?? known.hint);
  error.kind = kind;
  return error;
}

function failureFrom(command, argumentsList, result) {
  const stderr = String(result.stderr ?? "").trim();
  if (result.error?.code === "ENOENT") {
    const error = gitFailure("git-missing", { detail: `Unable to run ${command}: ${result.error.message}` });
    error.cause = result.error;
    return error;
  }
  const { kind, hint } = classifyGitFailure(stderr);
  const detail = `${command} ${argumentsList.join(" ")} failed${stderr ? `: ${stderr}` : ""}`;
  const error = gitFailure(kind, { detail, hint });
  if (result.error) error.cause = result.error;
  return error;
}

// Every git call is asynchronous, including the ones that only read local
// state: the extension host runs on the same thread as the editor, and a
// synchronous clone freezes the window for as long as the network takes.
// Set options.detached to keep a write to the local machine only (a caller that
// has to hold the answer synchronously can still inject options.spawn).
export async function run(command, argumentsList, options = {}) {
  const spawn = options.spawn ?? spawnExecutable;
  const result = await spawn(command, argumentsList, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    capture: options.capture !== false,
    stdio: options.stdio,
  });
  if (result.error || result.status !== 0) {
    throw failureFrom(command, argumentsList, result);
  }
  return options.capture === false ? "" : String(result.stdout ?? "").trim();
}

// The environment a caller hands us describes the machine, so it decides where
// git is. An environment that mentions no PATH at all is a partial override of
// this process's own, and the real PATH still applies.
export function gitExecutable(environment = process.env) {
  const pathValue = environment.PATH ?? environment.Path ?? process.env.PATH ?? process.env.Path ?? "";
  const located = resolveOnPath("git", { PATH: pathValue });
  if (!located) {
    throw gitFailure("git-missing", { detail: `Unable to find git on PATH (${pathValue || "PATH is empty"}).` });
  }
  return located;
}

export function git(argumentsList, options = {}) {
  return run(gitExecutable(options.env ?? process.env), argumentsList, options);
}

export function normalizeRepositoryInput(repository) {
  if (/^[^\s/:@]+\/[^\s/]+$/.test(repository)) {
    return `https://github.com/${repository.replace(/\.git$/i, "")}.git`;
  }
  return repository;
}

export function repositoryIdentity(repository) {
  return normalizeRepositoryInput(repository)
    .replace(/^git\+/, "")
    .replace(/^git@github\.com:/i, "https://github.com/")
    .replace(/\.git$/i, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

export function deriveSourceId(repository) {
  const parts = repositoryIdentity(repository).split(/[/:]/).filter(Boolean);
  const owner = parts.at(-2) ?? "source";
  const name = parts.at(-1) ?? "skills";
  return `${owner}-${name}`
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
}

export async function currentRepositoryState(catalogRoot) {
  let repository = null;
  let revision = null;
  let dirty = null;
  try {
    const remotes = (await git(["-C", catalogRoot, "remote"], { capture: true }))
      .split(/\r?\n/)
      .filter(Boolean);
    if (remotes.length > 0) {
      repository = await git(["-C", catalogRoot, "remote", "get-url", remotes[0]], { capture: true });
    }
    revision = await git(["-C", catalogRoot, "rev-parse", "HEAD"], { capture: true });
    dirty = Boolean(await git(["-C", catalogRoot, "status", "--porcelain"], { capture: true }));
  } catch {
    // npm's cache copy is intentionally not a Git working tree.
  }
  return { repository, revision, dirty };
}

export async function cloneHead(source, destination, options = {}) {
  await git(["clone", "--depth", "1", source.repository, destination], options);
  return git(["-C", destination, "rev-parse", "HEAD"], { ...options, capture: true });
}

export async function cloneRevision(source, destination, options = {}) {
  await mkdir(destination, { recursive: true });
  await git(["-C", destination, "init", "--quiet"], options);
  await git(["-C", destination, "remote", "add", "origin", source.repository], options);
  await git(["-C", destination, "fetch", "--depth", "1", "origin", source.revision], options);
  await git(["-C", destination, "checkout", "--quiet", "--detach", "FETCH_HEAD"], options);
}

export async function remoteHead(source, options = {}) {
  const output = await git(["ls-remote", source.repository, "HEAD"], { ...options, capture: true });
  const revision = output.split(/\s+/)[0];
  if (!/^[0-9a-f]{40}$/i.test(revision)) {
    fail(`Unable to read upstream HEAD: ${source.id}`);
  }
  return revision;
}
