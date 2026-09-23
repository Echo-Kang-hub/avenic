import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Where a project keeps what Avenic owns inside it. One definition, because a
// mistyped join does not fail — it grows a second directory nobody reads.
export function runtimePaths(projectRoot) {
  const agentsRoot = path.join(projectRoot, ".agents");
  const localRoot = path.join(agentsRoot, "local");
  return {
    localRoot,
    runtimeFile: path.join(agentsRoot, "runtime.json"),
    localRuntimeFile: path.join(localRoot, "runtime.local.json"),
    sessionsRoot: path.join(agentsRoot, "sessions"),
  };
}

// Whether two spellings name the same place. Everything Avenic keeps *inside* a
// project is addressed relative to it, and the filesystem settles that question
// on its own; this is for the comparisons that happen in memory — a native
// session's recorded cwd against a project root, a link target against the file
// it points at — and for the state that lives *outside* the project and is
// therefore keyed by a hash of the path: the launch lease in the temp directory
// and the capture cursors in machine state.
//
// That hash has to fold exactly what the filesystem folds, or one project keeps
// two leases and two cursors. A host hands its own spelling along: the VS Code
// extension reads a workspace folder back from a URI, which lowercases the drive
// letter (`c:\Users\...`), while the CLI's `process.cwd()` reports the spelling
// the OS uses (`C:\Users\...`). A dashboard watching one spelling then reads an
// empty lease directory and reports idle through a launch it cannot see.
//
// Resolving a path through the filesystem is the expensive half of comparing
// two identities, and discovery compares the same few spellings — this project's
// root, plus one cwd per other workspace on the machine — once for every session
// file it finds. On a machine with a long history of unrelated projects that was
// seconds per pass; with the memo it is one resolution per distinct spelling.
// The cache holds what this process believes each spelling means, which is the
// same guarantee the OS path cache gives: a directory created mid-process is
// recognised from the next process on, not instantly.
const identityCache = new Map();
const IDENTITY_CACHE_LIMIT = 4096;

export function projectIdentity(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const cached = identityCache.get(value);
  if (cached !== undefined) return cached;
  let target = value;
  try {
    if (/^file:/i.test(target)) target = fileURLToPath(target);
  } catch {
    return null;
  }
  let resolved = path.normalize(path.resolve(target));
  // Resolve junctions/symlinks when the path exists, while retaining the
  // lexical fallback for native metadata that references a deleted path.
  try { resolved = realpathSync.native(resolved); } catch {}
  if (process.platform === "win32") resolved = resolved.toLowerCase();
  if (identityCache.size >= IDENTITY_CACHE_LIMIT) identityCache.clear();
  identityCache.set(value, resolved);
  return resolved;
}

// The project-local home a Project-scope account lives in: the agent's own
// config and auth directory, moved under the project by the agent's own
// configuration-root variable (never by Avenic inventing a credential format).
// It is not session storage — sessions stay under `.agents/sessions`.
export function agentHomeRoot(projectRoot, agentId) {
  return path.join(runtimePaths(projectRoot).localRoot, agentId);
}

// Where one agent's portable session copies live inside the project. Every
// adapter and the import path derive it, and a mistyped join would silently
// grow a second history.
export function agentSessionsRoot(projectRoot, agentId) {
  return path.join(runtimePaths(projectRoot).sessionsRoot, agentId);
}

// What Avenic created and still holds exactly what it wrote — one row per file,
// never a credential and never a file's contents.
export function ownershipFile(projectRoot) {
  return path.join(runtimePaths(projectRoot).localRoot, "ownership.json");
}

// The tiny file a watching host reads to learn that a launch started, ended or
// a conversation arrived: one path, so a watcher and its writers cannot
// disagree about where the answer lives.
export function stateStampFile(projectRoot) {
  return path.join(runtimePaths(projectRoot).localRoot, "state.json");
}
