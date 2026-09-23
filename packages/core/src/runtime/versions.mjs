import { agentNpmPackage, classifyAgentExecutable, parseCliVersion } from "./agents.mjs";
import { spawnExecutable } from "./process.mjs";

// "Which version is this machine running, and which version exists?" is one
// question with two halves, both answered by running an external tool and both
// asked by hosts that cannot stop their event loop (the VS Code extension
// host, the CLI's prompts). They live together, and they run asynchronously,
// because the synchronous probe freezes a window for as long as npm or the
// agent's CLI takes to start.

// The installation record above, probed the same way but without stopping the
// caller's event loop. The classification is shared with the synchronous path,
// so what counts as a standalone/brew/npm install is decided once.
export async function detectAgentInstallationAsync(agentId, options = {}) {
  const classified = classifyAgentExecutable(agentId, options);
  return {
    ...classified,
    version: classified.executable ? await installedCliVersion(classified.executable, options) : null,
  };
}

// The version the agent's own executable reports, or null when it cannot run.
//
// This question is bounded the same way the registry's is. Every caller is a
// surface a person is waiting on — the VS Code footer, `avenic status`, the
// version read before installing hooks — and none of them can decide anything
// while an executable that never answers holds the question open.
export async function installedCliVersion(executable, options = {}) {
  const result = await spawnExecutable(executable, ["--version"], {
    env: options.environment ?? process.env,
    timeout: options.timeoutMs ?? 15_000,
  });
  return result.status === 0 ? parseCliVersion(result.stdout) : null;
}

// The version the registry currently publishes for an agent. Null means "no
// answer" — npm is missing, the network is down, the package is unknown — and
// callers decide whether that is tolerable: a tree row tolerates it, while an
// update that must not silently succeed fails on its own.
export async function latestPublishedVersion(agentId, options = {}) {
  const spec = options.packageSpec ?? agentNpmPackage(agentId);
  const result = await spawnExecutable("npm", ["view", spec, "version"], {
    env: options.environment ?? process.env,
    timeout: options.timeoutMs ?? 15_000,
  });
  return result.status === 0 ? parseCliVersion(result.stdout) : null;
}
