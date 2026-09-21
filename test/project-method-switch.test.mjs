import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyProjectDraft,
  configureProject,
  methodSwitches,
  projectDraft,
  projectWizardSteps,
  readApiConfiguration,
  releasePreviousMethod,
  removalTargets,
  writeApiConfiguration,
} from "../packages/core/src/index.mjs";

// Switching authentication method replaces an answer, and the previous answer
// may have left something on disk. These tests pin the whole of that contract:
// which switches are switches at all, which of them have anything of Avenic's
// own to delete, and what "Remove" is then allowed to touch. Keep is the
// offered default everywhere, and an Account's home — the agent's own sign-in —
// is never a deletion target. Every fixture is invented.

const TOKEN = "fixture-token-not-a-real-secret";
const fields = {
  provider: "Fixture Provider",
  baseUrl: "https://provider.fixture.invalid/v1",
  model: "fixture-model",
  credential: TOKEN,
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

// A switch that answers Global writes *the machine's* half of an agent's API
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
const readJson = (root, relative) => JSON.parse(readFileSync(path.join(root, relative), "utf8"));

// ---- which answers are switches ----

test("only a changed method is a switch; a first answer and a repeated one are not", () => {
  const first = projectDraft(config({}));
  first.selected = ["claude"];
  first.agents.claude = api("project");
  assert.deepEqual(methodSwitches(first), [], "an agent that never answered has nothing to keep or remove");

  const same = projectDraft(config({ claude: account() }));
  same.agents.claude = account("global");
  assert.deepEqual(methodSwitches(same), [], "a new scope for the same method is not a switch");

  const changed = projectDraft(config({ claude: account() }));
  changed.agents.claude = api("project");
  assert.deepEqual(methodSwitches(changed), [{ agentId: "claude", before: "account", after: "api" }]);
  // Back to the method the project already had: the answer changed twice but
  // nothing was replaced, so there is still nothing to keep or remove.
  changed.agents.claude = account("global");
  assert.deepEqual(methodSwitches(changed), []);
});

test("a previous Account is never deletable, so the destructive question is not asked", () => {
  const fromAccount = projectDraft(config({ claude: account() }));
  fromAccount.agents.claude = api("project");
  assert.equal(removalTargets(fromAccount).length, 0, "an Account home belongs to the agent's own login");

  const fromApi = projectDraft(config({ claude: api("project") }));
  fromApi.agents.claude = account("project");
  assert.deepEqual(removalTargets(fromApi).map((entry) => entry.agentId), ["claude"]);
  assert.deepEqual(removalTargets(fromApi).map((entry) => entry.relative), [".claude/settings.local.json"],
    "the destructive question names the file every host would delete");
});

// ---- the question itself ----

test("the wizard asks keep/remove after the new draft is complete and before Apply", () => {
  const fresh = projectDraft(config({ claude: account() }));
  fresh.agents.claude = api("project");
  const steps = projectWizardSteps(fresh);
  assert.deepEqual(steps.slice(-4).map((step) => step.id), ["sessions:claude", "history", "switch", "apply"]);
  const step = steps.at(-2);
  assert.match(step.title, /Keep previous configuration\?/);
  assert.deepEqual(step.options.map((option) => option.value), ["keep", "remove"]);
  assert.equal(step.value(fresh), "keep", "Keep is what a bare Enter answers");
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

test("Keep writes the new answer and leaves the previous configuration exactly where it was", async (t) => {
  const root = await project(t);
  await writeApiConfiguration(root, "claude", "project", fields);
  const before = readJson(root, ".claude/settings.local.json");

  const draft = projectDraft(config({ claude: api("project") }));
  draft.agents.claude = account("project");   // the new answer
  draft.switchMode = "keep";                  // the offered default
  draft.api.claude = { provider: "", baseUrl: "", model: "", credential: "" };
  const result = await applyProjectDraft(root, draft);

  assert.deepEqual(result.released, [], "Keep releases nothing");
  assert.deepEqual(readJson(root, ".claude/settings.local.json"), before, "the previous configuration is byte-for-byte the same");
  assert.equal((await readApiConfiguration(root, "claude", "project")).owned, true, "and Avenic's record of what it wrote is untouched, so a later removal can still prove it");
});

test("not answering the question at all is Keep", async (t) => {
  const root = await project(t);
  await writeApiConfiguration(root, "claude", "project", fields);
  const draft = projectDraft(config({ claude: api("project") }));
  draft.agents.claude = account("project");
  const result = await applyProjectDraft(root, draft);
  assert.deepEqual(result.released, []);
  assert.equal(existsSync(path.join(root, ".claude", "settings.local.json")), true);
});

test("Remove deletes only the keys Avenic wrote and leaves the user's own alone", async (t) => {
  const root = await project(t);
  await writeApiConfiguration(root, "claude", "project", fields);
  // A key the user has since added, and one Avenic never wrote.
  const file = path.join(root, ".claude", "settings.local.json");
  const document = JSON.parse(readFileSync(file, "utf8"));
  document.permissions = { allow: ["Bash(ls:*)"] };
  document.env.USER_OWN_VARIABLE = "kept";
  writeFileSync(file, JSON.stringify(document, null, 2), "utf8");

  const draft = projectDraft(config({ claude: api("project") }));
  draft.agents.claude = account("project");
  draft.switchMode = "remove";
  const result = await applyProjectDraft(root, draft);

  const released = result.released.find((entry) => entry.agentId === "claude");
  assert.equal(released.method, "api");
  assert.equal(released.relative, ".claude/settings.local.json");
  assert.equal(released.deleted, false, "the file is not Avenic's to delete once the user has more in it");
  const after = readJson(root, ".claude/settings.local.json");
  assert.equal(after.env.ANTHROPIC_AUTH_TOKEN, undefined, "the credential Avenic wrote is gone");
  assert.equal(after.env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(after.env.ANTHROPIC_MODEL, undefined);
  assert.equal(after.env.USER_OWN_VARIABLE, "kept");
  assert.deepEqual(after.permissions, { allow: ["Bash(ls:*)"] });
});

test("a Remove that arrives with a history-mode change still writes the new answer", async (t) => {
  const root = await project(t);
  const user = await home(t);
  const { environment } = user;
  // Stored: an API configuration at the machine scope, isolated history.
  await configureProject(root, config({ claude: api("global") }, "isolated"));
  await writeApiConfiguration(root, "claude", "global", fields, { environment });

  // One draft that both moves the API answer to the project scope and flips
  // history to Shared, answered Remove. The mode decides how history is
  // imported, never whether the rest of the draft is written — a dropped
  // write would leave the project with neither configuration once the old
  // one is released.
  const draft = projectDraft(config({ claude: api("global") }, "isolated"));
  draft.agents.claude = api("project");
  draft.historyMode = "shared";
  draft.switchMode = "remove";
  draft.api.claude = fields;
  const result = await applyProjectDraft(root, draft, { environment });

  assert.equal(readJson(root, ".claude/settings.local.json").env.ANTHROPIC_MODEL, "fixture-model",
    "the new answer was written by the same draft that released the old one");
  const released = result.released.find((entry) => entry.agentId === "claude");
  assert.equal(released.relative, "~/.claude/settings.json");
  assert.equal(existsSync(path.join(user.directory, ".claude", "settings.json")), false,
    "the old configuration was given back — and the project is not left with nothing");
});

test("Remove cleans the old API configuration and still leaves the new account home alone", async (t) => {
  const root = await project(t, { ".agents/local/claude/.credentials.json": "{\"fixture\":true}\n" });
  await writeApiConfiguration(root, "claude", "project", fields);
  const draft = projectDraft(config({ claude: api("project") }));
  draft.agents.claude = account("project");
  draft.switchMode = "remove";
  const result = await applyProjectDraft(root, draft);
  // The release is about the method being left behind: it takes the API file and
  // nothing else. The home of the account just chosen is the agent's own sign-in.
  assert.deepEqual(result.released.map((entry) => [entry.method, entry.home]), [["api", null]]);
  assert.equal(existsSync(path.join(root, ".claude", "settings.local.json")), false);
  assert.equal(existsSync(path.join(root, ".agents", "local", "claude", ".credentials.json")), true);
});

test("a release with no previous answer reports no method, rather than inventing an Account", async (t) => {
  const root = await project(t);
  const released = await releasePreviousMethod(root, "claude", undefined);
  assert.equal(released.method, null, "no previous answer means no method to name");
  assert.equal(released.home, null);
  assert.equal(released.removed, 0);
});

test("a released Account reports the home it left in place rather than deleting it", async (t) => {
  const root = await project(t, { ".agents/local/claude/.credentials.json": "{\"fixture\":true}\n" });
  const user = await home(t);
  const draft = projectDraft(config({ claude: account("project") }));
  draft.agents.claude = api("global");
  draft.switchMode = "remove";
  draft.api.claude = fields;
  const result = await applyProjectDraft(root, draft, { environment: user.environment });
  const released = result.released.find((entry) => entry.agentId === "claude");
  assert.equal(released.method, "account");
  assert.equal(released.deleted, false);
  assert.equal(released.home, ".agents/local/claude");
  assert.equal(existsSync(path.join(root, ".agents", "local", "claude", ".credentials.json")), true, "登录是 agent 自己的，Avenic 不代删");
  // The new Global answer landed in the home the environment names — under the
  // agent's own filename — and nowhere else.
  const globalFile = path.join(user.directory, ".claude", "settings.json");
  assert.equal(existsSync(globalFile), true, "an API · Global answer is written to the environment's home");
  const written = JSON.parse(readFileSync(globalFile, "utf8"));
  assert.equal(written.env.ANTHROPIC_BASE_URL, fields.baseUrl);
  const read = await readApiConfiguration(root, "claude", "global", { environment: user.environment });
  assert.equal(read.relative, "~/.claude/settings.json", "the relative name stays the machine-level one");
  assert.equal(read.baseUrl, fields.baseUrl, "and reading it back through the same environment finds it");
});

test("the write happens first: a switch that keeps both answers is never left half applied", async (t) => {
  const root = await project(t);
  await writeApiConfiguration(root, "claude", "project", fields);
  const draft = projectDraft(config({ claude: api("project") }));
  draft.agents.claude = account("global");
  draft.switchMode = "remove";
  const result = await applyProjectDraft(root, draft);
  // The new answer is in the project's runtime file and the old one is gone —
  // both, not one: a release that ran before the write would leave neither.
  assert.equal(result.config.agents.claude.authMethod, "account");
  assert.equal(result.config.agents.claude.accountScope, "global");
  assert.equal((await readApiConfiguration(root, "claude", "project")).owned, false, "the record of the removed keys is gone with them");
  assert.equal(existsSync(path.join(root, ".claude", "settings.local.json")), false, "a file Avenic created and emptied is removed");
});
