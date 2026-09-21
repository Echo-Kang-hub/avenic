import path from "node:path";

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
