// The visual fixtures are captured payloads, not hand-written ones — except
// fixtures/a-reference.json, which is transcribed from the design image and
// says so in its own _provenance field. This module re-exports the *production*
// data builder and the real core calls the scenarios use, so test/visual/capture.mjs
// can build actual projects on disk and record what the panel would receive. A
// fixture that drifted from what the host emits would make every screenshot here
// a picture of something the user never sees.
export { buildDashboardData } from "../../src/dashboard/state.ts";
export { initialize, invalidateAgentStatusCache } from "../../src/services/agents.ts";
export { installedPackIds, installPacks, readSkillsSnapshot } from "../../src/services/skills.ts";
export { select, sync } from "../../src/services/catalog.ts";
export {
  applyProjectConfiguration,
  importProjectSessions,
  setActiveCanonicalSession,
  writeApiConfiguration,
} from "@avenic/core";
export { makeCatalogFixture, testEnv, withAgentHomes } from "../helpers.ts";
