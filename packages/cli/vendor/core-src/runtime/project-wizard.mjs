// The project-setup questions, as data.
//
// `avenic init`, `avenic change`, and the VS Code extension all ask the same
// things in the same order — which agents, then each agent's authentication
// and session storage, then the history mode, then the keep/remove question
// when an answer replaced one, then a confirmation — and all
// three must write the same configuration when they are done. The questions
// live here so no host can drift: a host decides how to *draw* a step (a
// terminal rail, a QuickPick, a webview), never what the steps are.
//
// Authentication and model configuration are two different questions. Account
// answers "who signs in", and its scope decides whose account state that is;
// API answers "which provider, endpoint, model and credential", and its scope
// decides which of the agent's own configuration files carries them. A step
// therefore appears only for the method that was actually chosen, and the set
// of API field steps is one block so a host can fold five answers into one
// line.
//
// A step answers three questions about itself and nothing else:
//   - what may be chosen (`options`, or free text for `kind: "text"`),
//   - what the draft says now (`value(draft)`),
//   - what a choice means (`write(draft, value)`, `summary(draft)`).
// Steps are recomputed from the draft after every answer, which is how
// "which agents" decides what is asked next. A step's id is stable across
// recomputations, so going back re-opens the same question with the answer it
// already has — including an agent that was deselected in the meantime: its
// draft survives in memory and is only left out of what gets submitted.
import { AGENTS, getAgent } from "./agents.mjs";
import { apiCredential, apiRelative } from "./api-config.mjs";
import { methodSwitches, releasePreviousMethod, removalTargets, applyProjectConfiguration } from "./session-interop.mjs";

const titleCase = (word) => word.charAt(0).toUpperCase() + word.slice(1);

const accountScopeOptions = (agentId) => [
  { value: "global", label: "Global", description: "use the machine's own account" },
  { value: "project", label: "Project", description: `a project-only account the agent signs in to, under .agents/local/${agentId}` },
];

const apiScopeOptions = (agentId) => [
  { value: "global", label: "Global", description: `write ${apiRelative(agentId, "global")}` },
  agentId === "codex"
    // Codex has no project-scope configuration file of its own, so the
    // project's answer is kept in Avenic's own file and reaches Codex through
    // its documented `-c` overrides at launch.
    ? { value: "project", label: "Project", description: "keep this project's provider in .agents/api/codex.json for its launches" }
    : { value: "project", label: "Project", description: `write ${apiRelative(agentId, "project")}` },
];

const describe = (options) => options.map((option) => `${option.label} — ${option.description}`).join(" · ");

/** Every agent the registry knows, as a choice: the id travels with the name. */
export function agentChoices() {
  return Object.entries(AGENTS).map(([id, agent]) => ({ value: id, label: agent.displayName }));
}

/**
 * The draft a wizard starts from: the project's current configuration, which
 * for a directory nobody has configured is an empty selection and defaults.
 * Editing an existing project therefore starts from what it is, and setting up
 * a new one starts from nothing selected. `options.api` carries what a scope's
 * API configuration already says (read from the native file, never a secret) so
 * a `change` run can show the endpoint and model it is editing.
 */
export function projectDraft(config, options = {}) {
  return {
    selected: Object.keys(config.agents),
    agents: Object.fromEntries(Object.entries(config.agents).map(([agentId, entry]) => [agentId, { ...entry }])),
    // What the project said before this run: the wizard needs it to tell an
    // answer that merely arrives from an answer that *replaces* one, and only
    // the second kind leaves something behind to ask about.
    stored: Object.fromEntries(Object.entries(config.agents).map(([agentId, entry]) => [agentId, { ...entry }])),
    api: Object.fromEntries(Object.entries(options.api ?? {}).map(([agentId, fields]) => [agentId, { ...fields }])),
    historyMode: config.historyMode,
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
  const single = (step) => ({ kind: "single", ...step });
  const text = (step) => ({ kind: "text", ...step });
  const entryOf = (draft_, agentId) => draft_.agents[agentId] ?? {};
  const setField = (draft_, agentId, field, value) => {
    draft_.agents[agentId] = { ...entryOf(draft_, agentId), [field]: value };
  };
  const apiField = (draft_, agentId) => draft_.api?.[agentId] ?? {};
  const setApiField = (draft_, agentId, field, value) => {
    draft_.api ??= {};
    draft_.api[agentId] = { ...apiField(draft_, agentId), [field]: value };
  };
  for (const agentId of draft.selected) {
    const name = getAgent(agentId).displayName;
    // OpenCode answers for its own authentication and provider configuration:
    // Avenic asks it about session storage and nothing else. The registry says
    // which agents those are, so the launch question and this one cannot
    // disagree about who owns authentication.
    if (!getAgent(agentId).managesOwnAuth) {
      const methods = [
        { value: "account", label: "Account", description: `use ${name}'s native account sign-in` },
        { value: "api", label: "API", description: "use a provider/model/API configuration" },
      ];
      steps.push(single({
        id: `auth:${agentId}`,
        title: `${name} authentication`,
        description: describe(methods),
        options: methods,
        value: (draft_) => entryOf(draft_, agentId).authMethod ?? null,
        write: (draft_, value) => setField(draft_, agentId, "authMethod", value),
        summary: (draft_) => {
          const method = entryOf(draft_, agentId).authMethod;
          return method === "api" ? "API" : method === "account" ? "Account" : "";
        },
      }));
      const method = entryOf(draft, agentId).authMethod;
      if (method === "account") {
        const options = accountScopeOptions(agentId);
        steps.push(single({
          id: `account-scope:${agentId}`,
          title: `${name} account scope`,
          description: describe(options),
          options,
          value: (draft_) => entryOf(draft_, agentId).accountScope ?? "global",
          write: (draft_, value) => setField(draft_, agentId, "accountScope", value),
          summary: (draft_) => titleCase(entryOf(draft_, agentId).accountScope ?? "global"),
        }));
      }
      if (method === "api") {
        const group = `${agentId}-api`;
        const credential = apiCredential(agentId);
        const options = apiScopeOptions(agentId);
        steps.push(single({
          id: `api-scope:${agentId}`,
          group,
          title: `${name} API configuration`,
          description: describe(options),
          options,
          // 没答过时的默认值只有一个：global。`avenic change --auth api` 不带
          // --scope 时 core 写下的就是它，README 说的也是它；向导在同一个问题上
          // 默认 project，等于让两种走法写出不同的文件。
          value: (draft_) => entryOf(draft_, agentId).configScope ?? "global",
          write: (draft_, value) => setField(draft_, agentId, "configScope", value),
          summary: (draft_) => titleCase(entryOf(draft_, agentId).configScope ?? "global"),
        }));
        steps.push(text({
          id: `api-provider:${agentId}`,
          group,
          title: `${name} provider`,
          description: `the provider this endpoint belongs to — a label, shown back to you and stored with the keys Avenic owns`,
          value: (draft_) => apiField(draft_, agentId).provider ?? "",
          write: (draft_, value) => setApiField(draft_, agentId, "provider", value),
          // The endpoint itself is left out of the folded line: the provider
          // and the model already say which configuration this is.
          summary: (draft_) => {
            const provider = apiField(draft_, agentId).provider;
            return provider ? `Provider ${provider}` : "";
          },
        }));
        steps.push(text({
          id: `api-url:${agentId}`,
          group,
          title: `${name} base URL`,
          description: agentId === "codex"
            ? "the provider's API base URL — Codex speaks the Responses API to OpenAI's own endpoint and chat completions to every other one"
            : "the provider's API base URL, exactly as the provider documents it",
          value: (draft_) => apiField(draft_, agentId).baseUrl ?? "",
          write: (draft_, value) => setApiField(draft_, agentId, "baseUrl", value),
          summary: () => "",
        }));
        steps.push(text({
          id: `api-model:${agentId}`,
          group,
          title: `${name} model`,
          description: "the model id this configuration sends",
          value: (draft_) => apiField(draft_, agentId).model ?? "",
          write: (draft_, value) => setApiField(draft_, agentId, "model", value),
          summary: (draft_) => {
            const model = apiField(draft_, agentId).model;
            return model ? `Model ${model}` : "";
          },
        }));
        steps.push(text({
          id: `api-credential:${agentId}`,
          group,
          title: `${name} ${credential.label}`,
          description: credential.secret
            ? `${credential.hint} — stored in ${apiRelative(agentId, draft.agents[agentId]?.configScope ?? "global")} and never echoed back`
            : `${credential.hint} — it stays in your environment, not in this project`,
          mask: credential.secret,
          placeholder: credential.key,
          // A field the page leaves empty usually means "no answer", and is
          // refused. This one is different: a secret is never echoed, so when a
          // credential is already there an empty field *is* the answer — keep
          // it — and a host must let Enter through. Codex's field names the
          // environment variable its provider reads and has a documented
          // default, so leaving it empty is an answer there too.
          optional: !credential.secret || Boolean(apiField(draft, agentId).credentialSet),
          value: (draft_) => apiField(draft_, agentId).credential ?? "",
          write: (draft_, value) => setApiField(draft_, agentId, "credential", value),
          // Whatever this answer is, it is not repeated into the folded line.
          // A credential that is already there and is not retyped stays: the
          // field is never filled in for the reader, so "kept" is the honest
          // report and an empty field can only mean unchanged.
          summary: (draft_) => {
            const field = apiField(draft_, agentId);
            if (field.credential) return "Credential set";
            return field.credentialSet ? "Credential kept" : "";
          },
        }));
      }
    }
    steps.push(single({
      id: `sessions:${agentId}`,
      title: `${name} sessions`,
      description: `Global — Avenic keeps every project's session records together · Project — this project keeps its own under .agents/sessions`,
      options: [
        { value: "global", label: "Global" },
        { value: "project", label: "Project" },
      ],
      value: (draft_) => entryOf(draft_, agentId).sessionScope ?? "project",
      write: (draft_, value) => setField(draft_, agentId, "sessionScope", value),
      summary: (draft_) => titleCase(entryOf(draft_, agentId).sessionScope ?? "project"),
    }));
  }
  steps.push(single({
    id: "history",
    title: "Session history",
    description: "Shared — selected agents can continue the same Avenic history · Isolated — each agent keeps independent histories",
    options: [{ value: "shared", label: "Shared" }, { value: "isolated", label: "Isolated" }],
    value: (draft_) => draft_.historyMode ?? "shared",
    write: (draft_, value) => { draft_.historyMode = value; },
    summary: (draft_) => titleCase(draft_.historyMode ?? "shared"),
  }));
  // The one answer that replaces an answer: asked after the new draft is
  // complete and before Apply, with Keep as the offered default. Nothing here
  // deletes anything — the answer rides along in the draft and is carried out
  // by `applyProjectDraft`, which deletes only what Avenic can prove it wrote.
  const switched = methodSwitches(draft);
  if (switched.length > 0) {
    const named = switched
      .map(({ agentId, before, after }) => {
        const name = getAgent(agentId).displayName;
        if (before !== after) return `${name} ${titleCase(before)} → ${titleCase(after)}`;
        // The same method at a different scope is not a switch of method, and
        // saying "API → API" would not tell the reader what moved.
        const scope = (entry) => titleCase(entry?.configScope ?? "global");
        return `${name} API ${scope(draft.stored?.[agentId])} → ${scope(draft.agents?.[agentId])}`;
      })
      .join(" · ");
    steps.push(single({
      id: "switch",
      title: "Existing Account/API configuration detected. Keep previous configuration?",
      description: `${named} · Keep — the previous configuration stays where it is · Remove — delete only what Avenic wrote for the previous answer`,
      options: [{ value: "keep", label: "Keep" }, { value: "remove", label: "Remove" }],
      value: (draft_) => draft_.switchMode ?? "keep",
      write: (draft_, value) => { draft_.switchMode = value; },
      summary: (draft_) => titleCase(draft_.switchMode ?? "keep"),
    }));
    // The destructive answer is asked a second time, as a question of its own,
    // before anything is written. It is a step and not a prompt inside the
    // write: a frame drawn during the write cannot be cancelled — the write it
    // would have to cancel is already running — and one keypress would then
    // decide two frames at once. Answered here, `esc` still means nothing has
    // happened. Remove is named with the file it deletes, and Keep is what the
    // question offers first.
    const targets = removalTargets(draft);
    if (draft.switchMode === "remove" && targets.length > 0) {
      steps.push(single({
        id: "switch-confirm",
        title: "Delete the previous API configuration? This cannot be undone.",
        description: `${targets.map((target) => `${target.name} · ${target.relative}`).join(" · ")} · only the keys Avenic wrote are taken back out`,
        options: [{ value: "keep", label: "Keep" }, { value: "remove", label: "Delete" }],
        // This second, destructive question always opens on Keep: the answer
        // to the question before it must never be what a bare Enter repeats.
        value: () => "keep",
        write: (draft_, value) => { draft_.switchMode = value; },
        summary: (draft_) => titleCase(draft_.switchMode ?? "keep"),
      }));
    }
  }
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
 * What a finished draft submits: only the agents that are enabled now, each
 * carrying the answers its own method uses and nothing of the other method's,
 * plus the API fields for the agents that chose an API configuration. A
 * deselected agent's answers stay in the draft rather than in the
 * configuration, so backing up, turning an agent off and applying does not
 * leave a half-configured agent behind.
 */
export function projectDraftSubmission(draft) {
  const agents = {};
  const api = {};
  for (const agentId of draft.selected) {
    const entry = draft.agents[agentId] ?? {};
    const sessionScope = entry.sessionScope ?? "project";
    if (agentId === "opencode") {
      agents[agentId] = { sessionScope };
      continue;
    }
    if (entry.authMethod === "account") {
      agents[agentId] = { authMethod: "account", accountScope: entry.accountScope ?? "global", sessionScope };
      continue;
    }
    if (entry.authMethod === "api") {
      agents[agentId] = { authMethod: "api", configScope: entry.configScope ?? "global", sessionScope };
      // `credentialSet` is what the page showed, not an answer: it says whether
      // a secret is already there, and it is never written back as one.
      const answers = { ...(draft.api?.[agentId] ?? {}) };
      delete answers.credentialSet;
      api[agentId] = answers;
      continue;
    }
    // No method answered: the project says it does not know, and a plain
    // launch asks (see agent-runtime.mjs) instead of a guess being stored.
    agents[agentId] = { sessionScope };
  }
  return { agents, api, historyMode: draft.historyMode ?? "shared" };
}

/**
 * Commit a finished draft through the one project-settings writer, and — only
 * when the wizard's own question was answered "Remove" — release what the
 * previous method left behind. After, never before: a write that fails must not
 * leave the user with neither answer.
 */
export async function applyProjectDraft(projectRoot, draft, options = {}) {
  const result = await applyProjectConfiguration(projectRoot, projectDraftSubmission(draft), options);
  const released = [];
  if (draft.switchMode === "remove") {
    for (const { agentId } of methodSwitches(draft)) {
      released.push(await releasePreviousMethod(projectRoot, agentId, draft.stored?.[agentId], options));
    }
  }
  return { ...result, released };
}
