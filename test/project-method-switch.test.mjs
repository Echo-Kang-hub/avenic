import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyProjectDraft,
  configureProject,
  leftoverTargets,
  methodSwitches,
  modelConfigTarget,
  projectDraft,
  projectWizardSteps,
  readModelConfiguration,
  releasePreviousMethod,
} from "../packages/core/src/index.mjs";

// Switching authentication method replaces an answer, and the previous answer
// may have left something on disk. These tests pin the whole of that contract:
// which switches are switches at all, which of them have anything of Avenic's
// own to give back, and what "Remove" is then allowed to touch. Keep is the
// offered default everywhere. An Account's home — the agent's own sign-in — is
// never a deletion target, and the only file Remove may delete is one Avenic
// created and nobody has changed since. Every fixture is invented.

const fields = {
  provider: "Fixture Provider",
  baseUrl: "https://provider.fixture.invalid/v1",
  model: "fixture-model",
  credential: "fixture-token-not-a-real-secret",
};

async function project(t, files = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-switch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content, "utf8");
  }
  return root;
}

// A switch that answers Global prepares *the machine's* half of an agent's API
// configuration. The environment says which machine: without one here, the
// fixture would be written into the developer's own `~/.claude/settings.json`,
// which is exactly the accident these options exist to stop. The fixture home
// is the only place any assertion below looks for a global file.
async function home(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "avenic-switch-home-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { environment: { HOME: directory, USERPROFILE: directory }, directory };
}

const config = (agents, historyMode = "shared") => ({ agents, historyMode });
const account = (scope = "project") => ({ authMethod: "account", accountScope: scope, sessionScope: "project" });
const api = (scope = "project") => ({ authMethod: "api", configScope: scope, sessionScope: "project" });
const projectFile = path.join(".claude", "settings.local.json");
const stepById = (steps, id) => steps.find((step) => step.id === id);

// The wizard reads the disk once, when it opens, and describes what it found.
// A draft under test that is about a switch has to carry those facts with it,
// exactly as `projectDraft` hands them over.
async function draftFor(root, stored, next, options = {}) {
  const before = await readModelConfiguration(root, "claude", stored.claude.configScope ?? "global", options);
  const draft = projectDraft(config(stored));
  draft.agents.claude = next.claude;
  draft.files = { claude: { relative: before.relative, scope: stored.claude.configScope ?? "global", exists: before.exists, owned: before.owned, unchanged: before.unchanged } };
  return draft;
}

// ---- which answers are switches ----

test("only a changed method is a switch; a first answer and a repeated one are not", () => {
  const first = projectDraft(config({}));
  first.selected = ["claude"];
  first.agents.claude = api("project");
  assert.deepEqual(methodSwitches(first), [], "an agent that never answered has nothing to keep or remove");

  const same = projectDraft(config({ claude: account() }));
  same.agents.claude = account("global");
  assert.deepEqual(methodSwitches(same), [], "a new scope for the same Account is not a switch — a home is not a file to give back");
  // The same method at a new scope *is* one for API: the file the answer points
  // at moved, and the one it came from is still standing.
  const moved = projectDraft(config({ claude: api("project") }));
  moved.agents.claude = api("global");
  assert.deepEqual(methodSwitches(moved), [{ agentId: "claude", before: "api", after: "api" }]);

  const changed = projectDraft(config({ claude: account() }));
  changed.agents.claude = api("project");
  assert.deepEqual(methodSwitches(changed), [{ agentId: "claude", before: "account", after: "api" }]);
  // Back to the method the project already had: the answer changed twice but
  // nothing was replaced, so there is still nothing to keep or remove.
  changed.agents.claude = account("global");
  assert.deepEqual(methodSwitches(changed), []);
});

test("a previous Account leaves nothing to delete, so the destructive question is not asked", async (t) => {
  const root = await project(t);
  const signIn = path.join(root, ".agents", "local", "claude", ".credentials.json");
  mkdirSync(path.dirname(signIn), { recursive: true });
  writeFileSync(signIn, "{\"fixture\":true}\n", "utf8");
  const fromAccount = await draftFor(root, { claude: account() }, { claude: api("project") });
  assert.deepEqual(leftoverTargets(fromAccount), [], "an Account home belongs to the agent's own login");

  await configureProject(root, config({ claude: api("project") }));
  const fromApi = await draftFor(root, { claude: api("project") }, { claude: account("project") });
  assert.deepEqual(leftoverTargets(fromApi).map((entry) => entry.agentId), ["claude"]);
  assert.deepEqual(leftoverTargets(fromApi).map((entry) => entry.relative), [".claude/settings.local.json"],
    "the destructive question names the file every host would delete");
  assert.equal(leftoverTargets(fromApi)[0].removable, true, "Avenic created it and nothing has changed it");
});

// A file the user filled in is still named — it is still there — but it is not
// what a destructive question is about: that question is answered by deleting,
// and nothing here can be deleted.
test("a file the user filled in is named as present and not as removable", async (t) => {
  const root = await project(t);
  await configureProject(root, config({ claude: api("project") }));
  writeFileSync(path.join(root, projectFile), `${JSON.stringify({ env: { ANTHROPIC_MODEL: "fixture-model" } }, null, 2)}\n`, "utf8");
  const draft = await draftFor(root, { claude: api("project") }, { claude: account("project") });
  const [target] = leftoverTargets(draft);
  assert.equal(target.relative, ".claude/settings.local.json");
  assert.equal(target.removable, false, "a value Avenic did not write is not Avenic's to delete");
});

// ---- the question itself ----

test("the wizard asks keep/remove after the new draft is complete and before Apply", async (t) => {
  const root = await project(t);
  await configureProject(root, config({ claude: api("project") }));
  const draft = await draftFor(root, { claude: api("project") }, { claude: account("project") });
  const steps = projectWizardSteps(draft);
  // The file is named on a settled line of its own, then the question is asked
  // about it, and Apply is the last thing on the page — the answer that could
  // delete something is never the answer that commits it.
  assert.deepEqual(steps.map((step) => step.id), [
    "agents", "auth:claude", "account-scope:claude", "sessions:claude",
    "history", "leftover:claude", "switch", "apply",
  ]);
  const step = stepById(steps, "switch");
  assert.equal(step.title, "What should Avenic do?");
  assert.deepEqual(step.options.map((option) => option.value), ["keep", "remove"]);
  assert.equal(step.value(draft), "keep", "Keep is what a bare Enter answers");
});

test("no switch, no question", () => {
  const unchanged = projectDraft(config({ claude: account() }));
  unchanged.agents.claude = account("project");
  assert.equal(projectWizardSteps(unchanged).some((step) => step.id === "switch"), false);

  const firstTime = projectDraft(config({}));
  firstTime.selected = ["claude"];
  firstTime.agents.claude = api("global");
  assert.equal(projectWizardSteps(firstTime).some((step) => step.id === "switch"), false);
});

// ---- what the answer does ----

test("Keep writes the new answer and leaves the previous file exactly where it was", async (t) => {
  const root = await project(t);
  await configureProject(root, config({ claude: api("project") }));
  const before = readFileSync(path.join(root, projectFile), "utf8");

  const draft = await draftFor(root, { claude: api("project") }, { claude: account("project") });
  draft.switchMode = "keep"; // the offered default
  const result = await applyProjectDraft(root, draft);

  assert.deepEqual(result.released, [], "Keep releases nothing");
  assert.equal(readFileSync(path.join(root, projectFile), "utf8"), before, "the previous configuration is byte-for-byte the same");
  assert.equal((await readModelConfiguration(root, "claude", "project")).owned, true, "and Avenic's proof that it made the file is untouched, so a later removal can still give it back");
});

test("not answering the question at all is Keep", async (t) => {
  const root = await project(t);
  await configureProject(root, config({ claude: api("project") }));
  const draft = await draftFor(root, { claude: api("project") }, { claude: account("project") });
  const result = await applyProjectDraft(root, draft);
  assert.deepEqual(result.released, []);
  assert.equal(existsSync(path.join(root, projectFile)), true);
});

test("Remove gives back the file Avenic created, and leaves a file the user wrote alone", async (t) => {
  const root = await project(t);
  await configureProject(root, config({ claude: api("project") }));
  const file = path.join(root, projectFile);
  // What Avenic prepared, and then what the user made of it: their own keys in
  // the same file. Avenic wrote none of these values, so none of them are its.
  const userWritten = `${JSON.stringify({ env: { ANTHROPIC_BASE_URL: fields.baseUrl, USER_OWN_VARIABLE: "kept" }, permissions: { allow: ["Bash(ls:*)"] } }, null, 2)}\n`;
  writeFileSync(file, userWritten, "utf8");

  const draft = await draftFor(root, { claude: api("project") }, { claude: account("project") });
  draft.switchMode = "remove";
  const result = await applyProjectDraft(root, draft);

  const released = result.released.find((entry) => entry.agentId === "claude");
  assert.equal(released.relative, ".claude/settings.local.json");
  assert.equal(released.outcome, "modified");
  assert.equal(released.removed, false);
  assert.equal(readFileSync(file, "utf8"), userWritten, "not one byte of a file the user wrote is Avenic's to change");
});

test("Remove gives the file back when it still holds exactly what Avenic wrote", async (t) => {
  const root = await project(t);
  await configureProject(root, config({ claude: api("project") }));
  const draft = await draftFor(root, { claude: api("project") }, { claude: account("project") });
  draft.switchMode = "remove";
  const result = await applyProjectDraft(root, draft);
  const released = result.released.find((entry) => entry.agentId === "claude");
  assert.equal(released.outcome, "deleted");
  assert.equal(released.removed, true);
  assert.equal(existsSync(path.join(root, projectFile)), false);
  // Nothing Avenic cannot prove is ever deleted, so a file Avenic merely found
  // at that path would have stayed — which `readModelConfiguration` still says.
  assert.equal((await readModelConfiguration(root, "claude", "project")).owned, false);
});

test("a Remove that arrives with a history-mode change still writes the new answer", async (t) => {
  const root = await project(t);
  const user = await home(t);
  const { environment } = user;
  // Stored: an API configuration at the machine scope, isolated history.
  await configureProject(root, config({ claude: api("global") }, "isolated"), { environment });

  // One draft that both moves the API answer to the project scope and flips
  // history to Shared, answered Remove. The mode decides how history is
  // imported, never whether the rest of the draft is written — a dropped
  // write would leave the project with neither configuration once the old
  // one is released.
  const draft = await draftFor(root, { claude: api("global") }, { claude: api("project") }, { environment });
  draft.historyMode = "shared";
  draft.switchMode = "remove";
  const result = await applyProjectDraft(root, draft, { environment });

  assert.equal(existsSync(path.join(root, projectFile)), true, "the new answer was prepared by the same draft that released the old one");
  const released = result.released.find((entry) => entry.agentId === "claude");
  assert.equal(released.relative, "~/.claude/settings.json");
  assert.equal(existsSync(path.join(user.directory, ".claude", "settings.json")), false,
    "the old configuration was given back — and the project is not left with nothing");
});

test("Remove gives back the old API configuration and still leaves the new account home alone", async (t) => {
  const root = await project(t, { ".agents/local/claude/.credentials.json": "{\"fixture\":true}\n" });
  await configureProject(root, config({ claude: api("project") }));
  const draft = await draftFor(root, { claude: api("project") }, { claude: account("project") });
  draft.switchMode = "remove";
  const result = await applyProjectDraft(root, draft);
  // The release is about the method being left behind: it takes the API file and
  // nothing else. The home of the account just chosen is the agent's own sign-in.
  assert.deepEqual(result.released.map((entry) => [entry.agentId, entry.outcome]), [["claude", "deleted"]]);
  assert.equal(existsSync(path.join(root, projectFile)), false);
  assert.equal(existsSync(path.join(root, ".agents", "local", "claude", ".credentials.json")), true);
});

test("a release with no previous API answer has nothing to release, and returns nothing", async (t) => {
  const root = await project(t);
  // `null` rather than a report about a file that was never there: an Account
  // has no file of Avenic's, and a report for it would have to invent one.
  assert.equal(await releasePreviousMethod(root, "claude", undefined), null);
  assert.equal(await releasePreviousMethod(root, "claude", account("project")), null);
});

test("a released Account leaves the sign-in in place and names nothing to delete", async (t) => {
  const root = await project(t, { ".agents/local/claude/.credentials.json": "{\"fixture\":true}\n" });
  const user = await home(t);
  const draft = await draftFor(root, { claude: account("project") }, { claude: api("global") }, { environment: user.environment });
  draft.switchMode = "remove";
  const result = await applyProjectDraft(root, draft, { environment: user.environment });
  assert.deepEqual(result.released, [], "an Account is not a file Avenic can give back");
  assert.equal(existsSync(path.join(root, ".agents", "local", "claude", ".credentials.json")), true, "登录是 agent 自己的，Avenic 不代删");
  // The new Global answer lands in the home the environment names — the file is
  // Avenic's, empty, because the user has not filled it in yet.
  const globalFile = modelConfigTarget(root, "claude", "global", { environment: user.environment }).file;
  assert.equal(globalFile, path.join(user.directory, ".claude", "settings.json"), "an API · Global answer is prepared in the environment's own home");
  assert.equal(existsSync(globalFile), true);
  const read = await readModelConfiguration(root, "claude", "global", { environment: user.environment });
  assert.equal(read.relative, "~/.claude/settings.json", "the relative name stays the machine-level one");
  assert.equal(read.owned, true);
});

test("the write happens first: a switch that keeps both answers is never left half applied", async (t) => {
  const root = await project(t);
  await configureProject(root, config({ claude: api("project") }));
  const draft = await draftFor(root, { claude: api("project") }, { claude: account("global") });
  draft.switchMode = "remove";
  const result = await applyProjectDraft(root, draft);
  // The new answer is in the project's runtime file and the old file is gone —
  // both, not one: a release that ran before the write would leave neither.
  assert.equal(result.config.agents.claude.authMethod, "account");
  assert.equal(result.config.agents.claude.accountScope, "global");
  assert.equal((await readModelConfiguration(root, "claude", "project")).owned, false, "the record of the removed file is gone with it");
  assert.equal(existsSync(path.join(root, projectFile)), false, "a file Avenic created and nobody touched is removed");
});
