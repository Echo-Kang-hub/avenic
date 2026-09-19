// The project-setup questions, as data.
//
// `avenic init`, `avenic change`, and the VS Code extension all ask the same
// things in the same order — which agents, then each agent's authentication and
// session storage, then the history mode, then a confirmation — and all three
// must write the same configuration when they are done. The questions live here
// so no host can drift: a host decides how to *draw* a step (a terminal rail, a
// QuickPick, a webview), never what the steps are.
//
// A step answers three questions about itself and nothing else:
//   - what may be chosen (`options`),
//   - what the draft says now (`value(draft)`),
//   - what a choice means (`write(draft, value)`, `summary(draft)`).
// Steps are recomputed from the draft after every answer, which is how
// "which agents" decides what is asked next. A step's id is stable across
// recomputations, so going back re-opens the same question with the answer it
// already has — including an agent that was deselected in the meantime: its
// draft survives in memory and is only left out of what gets submitted.
import { AGENTS, getAgent } from "./agents.mjs";
import { applyProjectConfiguration } from "./session-interop.mjs";

const titleCase = (word) => word.charAt(0).toUpperCase() + word.slice(1);

const MODES = [{ value: "global", label: "Global" }, { value: "project", label: "Project" }];

/** Every agent the registry knows, as a choice: the id travels with the name. */
export function agentChoices() {
  return Object.entries(AGENTS).map(([id, agent]) => ({ value: id, label: agent.displayName }));
}

/**
 * The draft a wizard starts from: the project's current configuration, which
 * for a directory nobody has configured is the default set of agents and
 * defaults. Editing an existing project therefore starts from what it is, and
 * setting up a new one starts from nothing selected.
 */
export function projectDraft(config) {
  return {
    selected: Object.keys(config.agents),
    agents: Object.fromEntries(Object.entries(config.agents).map(([agentId, entry]) => [agentId, { ...entry }])),
    sessionInterop: config.sessionInterop,
  };
}

/** The steps for a draft, as the host should present them. */
export function projectWizardSteps(draft, editing = false) {
  const steps = [
    {
      id: "agents",
      kind: "multi",
      title: editing ? "Select enabled agents" : "Select agents",
      options: agentChoices(),
      values: (draft_) => draft_.selected,
      minSelected: 1,
      emptyMessage: "Select at least one agent",
      write: (draft_, value) => { draft_.selected = value; },
      summary: (draft_) => draft_.selected.map((agentId) => getAgent(agentId).displayName).join(", "),
    },
  ];
  const single = (id, title, options, value, write, summary, description) => ({
    id, kind: "single", title, description, options, value, write, summary,
  });
  for (const agentId of draft.selected) {
    const name = getAgent(agentId).displayName;
    steps.push(single(
      `auth:${agentId}`,
      `${name} authentication`,
      MODES,
      (draft_) => draft_.agents[agentId]?.auth ?? "global",
      (draft_, value) => { draft_.agents[agentId] = { ...draft_.agents[agentId], auth: value }; },
      (draft_) => titleCase(draft_.agents[agentId]?.auth ?? "global"),
    ));
    steps.push(single(
      `sessions:${agentId}`,
      `${name} session storage`,
      MODES,
      (draft_) => draft_.agents[agentId]?.sessions ?? "project",
      (draft_, value) => { draft_.agents[agentId] = { ...draft_.agents[agentId], sessions: value }; },
      (draft_) => titleCase(draft_.agents[agentId]?.sessions ?? "project"),
    ));
  }
  steps.push(single(
    "history",
    "Session history",
    [{ value: "shared", label: "Shared" }, { value: "isolated", label: "Isolated" }],
    (draft_) => draft_.sessionInterop,
    (draft_, value) => { draft_.sessionInterop = value; },
    (draft_) => titleCase(draft_.sessionInterop ?? "shared"),
    "Shared — selected agents can continue the same Avenic history · isolated — each agent keeps independent histories",
  ));
  steps.push({
    id: "apply",
    kind: "single",
    title: "Apply configuration?",
    options: [{ value: true, label: "Yes" }, { value: false, label: "No" }],
    value: () => true,
    apply: true,
    appliedTitle: editing ? "Configuration updated" : "Configuration applied",
  });
  return steps;
}

/**
 * What a finished draft submits: only the agents that are enabled now. A
 * deselected agent's answers stay in the draft rather than in the
 * configuration, so backing up, turning an agent off and applying does not
 * leave a half-configured agent behind.
 */
export function projectDraftSubmission(draft) {
  return {
    agents: Object.fromEntries(draft.selected.map((agentId) => [
      agentId,
      draft.agents[agentId] ?? { auth: "global", sessions: "project" },
    ])),
    sessionInterop: draft.sessionInterop,
  };
}

/** Commit a finished draft through the one project-settings writer. */
export async function applyProjectDraft(projectRoot, draft, options = {}) {
  return applyProjectConfiguration(projectRoot, projectDraftSubmission(draft), options);
}
