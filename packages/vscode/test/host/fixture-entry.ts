// The Extension Host check drives a real editor, so the project it drives has
// to be built by the *production* calls — the panel reads what the services
// write, and a fixture assembled by hand would prove only that hand-written
// data renders. This module re-exports exactly those calls so
// test/host/fixture.mjs can bundle them (they are TypeScript, and their
// neighbours import `vscode`) and make a real project on disk.
//
// Same step, same reason as test/visual/capture-entry.ts: the two harnesses
// differ in where the payload goes — a webview here, a fixture JSON there —
// not in who produces it.
export { buildDashboardData } from "../../src/dashboard/state.ts";
export { initialize, invalidateAgentStatusCache } from "../../src/services/agents.ts";
export { installPacks, installedPackIds, invalidateSkillsSnapshot, readSkillsSnapshot } from "../../src/services/skills.ts";
export { select } from "../../src/services/catalog.ts";
export { importProjectSessions, writeApiConfiguration } from "@avenic/core";
export { makeCatalogFixture, testEnv, withAgentHomes } from "../helpers.ts";
