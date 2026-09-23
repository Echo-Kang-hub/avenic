import { classifyAgentExecutable, parseCliVersion } from "./agents.mjs";
import { spawnExecutable } from "./process.mjs";

// "Which version is this machine running?" is one question, answered by running
// an external tool, and asked by hosts that cannot stop their event loop (the
// VS Code extension host, the CLI's prompts). It runs asynchronously, because
// the synchronous probe freezes a window for as long as the agent's CLI takes
// to start. Which version the registry publishes is a different question and is
// not asked here: the only surface that asks it is `avenic self-update`, from a
// command the user typed, and it fails loudly rather than answering null.

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
// This question is bounded. Every caller is a surface a person is waiting on —
// the VS Code footer, `avenic status`, the version read before installing hooks
// — and none of them can decide anything while an executable that never answers
// holds the question open.
export async function installedCliVersion(executable, options = {}) {
  const result = await spawnExecutable(executable, ["--version"], {
    env: options.environment ?? process.env,
    timeout: options.timeoutMs ?? 15_000,
  });
  return result.status === 0 ? parseCliVersion(result.stdout) : null;
}
