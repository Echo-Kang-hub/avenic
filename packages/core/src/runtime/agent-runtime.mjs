import { getAgent } from "./agents.mjs";
import { effectiveAgentConfig, loadRuntime, projectAuthEnvironment } from "./config.mjs";
import { bindProject, projectModelStatus, resolveProjectProfile } from "../model/binding.mjs";
import { buildLaunchInjection } from "../model/inject.mjs";

// Resolve the exact runtime used by an ordinary agent launch. Session
// continuation may add only session arguments; it must not select a model or
// provider of its own.
export async function resolveEffectiveAgentRuntime(projectRoot, agentId, options = {}) {
  const state = options.state ?? await loadRuntime(projectRoot);
  const config = effectiveAgentConfig(state, agentId);
  if (!config) throw new Error(`${getAgent(agentId).displayName} is not initialized`);
  const environment = options.environment ?? (config.auth === "project"
    ? { ...process.env, ...projectAuthEnvironment(agentId, projectRoot) }
    : process.env);
  let profile = null;
  try {
    const resolved = await resolveProjectProfile(projectRoot, environment, options.io ?? console);
    profile = resolved.profile;
    if (resolved.message) (options.io?.log ?? console.log)(resolved.message);
    if (profile) {
      const status = await projectModelStatus(projectRoot, environment);
      if (status.projection && !status.projection.fingerprintMatches) {
        await bindProject(projectRoot, environment, profile.id);
      }
    }
  } catch (error) {
    (options.io?.log ?? console.log)(`Model configuration skipped: ${error.message}`);
  }
  const injection = buildLaunchInjection({
    agentId,
    profile,
    argumentsList: options.argumentsList ?? [],
    environment: { ...environment },
  });
  return {
    executable: getAgent(agentId).executable,
    authScope: config.auth,
    provider: profile?.name ?? null,
    endpoint: profile?.endpoint?.baseUrl ?? null,
    model: profile?.models?.main?.id ?? null,
    config,
    profile,
    argumentsList: injection.argumentsList,
    environment: injection.environment,
    note: injection.note ?? null,
  };
}
