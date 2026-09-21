// The project-setup questions, as data.
//
// `avenic init`, `avenic change`, and the VS Code extension all ask the same
// things in the same order — which agents, then each agent's authentication,
// the scope that answer belongs to, and its sessions, then the project's
// History, then the keep/remove question when an answer replaced one, then a
// confirmation — and all three must write the same configuration when they are
// done. The questions live here so no host can drift: a host decides how to
// *draw* a step (a terminal rail, a QuickPick, a webview), never what the steps
// are, and never what one of them is called.
//
// The words are the dashboard's (labels.mjs): Authentication is Account or API,
// an Account answer has an Account Scope and an API answer a Configuration
// Scope, sessions are Sessions and the project's conversation policy is History.
//
// Authentication and configuration are two different questions. Account answers
// "who signs in", and its scope decides whose account state that is. API answers
// "run on a provider/model configuration", and its scope decides which of the
// agent's own configuration files carries it — Avenic prepares that file and
// never fills it in, so there is nothing else to ask: no provider, no endpoint,
// no model, no credential. Those are the file's business (the user's own hand,
// their tooling, cc-switch) and the dashboard reads them back out of the file
// once they are there.
//
// A step answers four questions about itself and nothing else:
//   - what may be chosen (`options`),
//   - what the draft says now (`value(draft)`),
//   - what a choice means (`write(draft, value)`),
//   - and the row a finished answer leaves in the record (`summary(draft)`) —
//     a string, or a `{label, value}` row the host lines up like every other
//     label/value surface, so the summary reads as the dashboard card does.
// Steps are recomputed from the draft after every answer, which is how "which
// agents" decides what is asked next. A step's id is stable across
// recomputations, so going back re-opens the same question with the answer it
// already has — including an agent that was deselected in the meantime: its
// draft survives in memory and is only left out of what gets submitted.
import { AGENTS, getAgent } from "./agents.mjs";
import { accountHomeRelative } from "./agent-home.mjs";
import { LABELS, agentQuestion, authenticationValue, historyLabel, methodLabel, scopeLabel, scopedHomeValue } from "../labels.mjs";
import { modelConfigRelative } from "./model-config.mjs";
import { applyProjectConfiguration, leftoverTargets, methodSwitches, releasePreviousMethod } from "./session-interop.mjs";

const titleCase = (word) => word.charAt(0).toUpperCase() + word.slice(1);

/** Every agent the registry knows, as a choice: the id travels with the name. */
export function agentChoices() {
  return Object.entries(AGENTS).map(([id, agent]) => ({ value: id, label: agent.displayName }));
}

/**
 * The draft a wizard starts from: the project's current configuration, which for
 * a directory nobody has configured is an empty selection and defaults. Editing
 * an existing project therefore starts from what it is. `options.files` carries
 * what an earlier API answer left on disk (read once, when the wizard opens) so
 * the questions can describe it without the question list itself reading the
 * filesystem on every repaint.
 */
export function projectDraft(config, options = {}) {
  return {
    selected: Object.keys(config.agents),
    agents: Object.fromEntries(Object.entries(config.agents).map(([agentId, entry]) => [agentId, { ...entry }])),
    // What the project said before this run: the wizard needs it to tell an
    // answer that merely arrives from an answer that *replaces* one, and only
    // the second kind leaves something behind to ask about.
    stored: Object.fromEntries(Object.entries(config.agents).map(([agentId, entry]) => [agentId, { ...entry }])),
    files: Object.fromEntries(Object.entries(options.files ?? {}).map(([agentId, file]) => [agentId, { ...file }])),
    historyMode: config.historyMode,
  };
}

const scopeOf = (entry) => (entry?.authMethod === "account" ? entry.accountScope : entry.configScope);

/** The steps for a draft, as the host should present them. */
export function projectWizardSteps(draft, editing = false) {
  const entryOf = (draft_, agentId) => draft_.agents[agentId] ?? {};
  const setField = (draft_, agentId, field, value) => {
    draft_.agents[agentId] = { ...entryOf(draft_, agentId), [field]: value };
  };
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
  for (const agentId of draft.selected) {
    const name = getAgent(agentId).displayName;
    const managesOwnAuth = Boolean(getAgent(agentId).managesOwnAuth);
    // OpenCode answers for its own authentication and provider configuration:
    // Avenic asks it about sessions and nothing else, and says so on the record
    // rather than leaving the row out — "who signs in" was answered, by the
    // agent, with the agent's own UI.
    if (!managesOwnAuth) {
      const methods = [
        { value: "account", label: LABELS.method.account.label, description: LABELS.method.account.description },
        { value: "api", label: LABELS.method.api.label, description: LABELS.method.api.description },
      ];
      steps.push(single({
        id: `auth:${agentId}`,
        group: agentId,
        groupTitle: name,
        title: agentQuestion(name, LABELS.authentication),
        description: methods.map((option) => `${option.label} — ${option.description}`).join(" · "),
        options: methods,
        value: (draft_) => entryOf(draft_, agentId).authMethod ?? null,
        write: (draft_, value) => setField(draft_, agentId, "authMethod", value),
        // 作用域还没答时只写方法名：那一刻的选择就是「API」，把默认的 (Global) 写进
        // 记录等于替用户答了下一题。答过之后就带上它——与 Dashboard 同一句话。
        summary: (draft_) => {
          const entry = entryOf(draft_, agentId);
          if (!entry.authMethod) return "";
          const scope = scopeOf(entry);
          return {
            label: LABELS.authentication,
            value: scope ? authenticationValue({ authMethod: entry.authMethod, authScope: scope }) : methodLabel(entry.authMethod),
          };
        },
      }));
      const method = entryOf(draft, agentId).authMethod;
      if (method === "account") {
        const options = [
          { value: "global", label: LABELS.scope.global, description: "use the machine's own account" },
          { value: "project", label: LABELS.scope.project, description: `a project-only account the agent signs in to, under .agents/local/${agentId}` },
        ];
        steps.push(single({
          id: `account-scope:${agentId}`,
          group: agentId,
          groupTitle: name,
          title: agentQuestion(name, LABELS.accountScopeQuestion),
          description: options.map((option) => `${option.label} — ${option.description}`).join(" · "),
          options,
          value: (draft_) => entryOf(draft_, agentId).accountScope ?? "global",
          write: (draft_, value) => setField(draft_, agentId, "accountScope", value),
          summary: (draft_) => {
            const scope = entryOf(draft_, agentId).accountScope ?? "global";
            return { label: LABELS.accountScope, value: scopedHomeValue(scope, accountHomeRelative(agentId, scope)) };
          },
        }));
      }
      if (method === "api") {
        const options = ["global", "project"].map((scope) => ({
          value: scope,
          label: scopeLabel(scope),
          description: `write ${modelConfigRelative(agentId, scope)}`,
        }));
        steps.push(single({
          id: `configuration-scope:${agentId}`,
          group: agentId,
          groupTitle: name,
          title: agentQuestion(name, LABELS.configurationScopeQuestion),
          description: options.map((option) => `${option.label} — ${option.description}`).join(" · "),
          options,
          value: (draft_) => entryOf(draft_, agentId).configScope ?? "global",
          write: (draft_, value) => setField(draft_, agentId, "configScope", value),
          // 记录里写的是文件本身，不是「Project」两个字：这一题的答案就是「配置住在
          // 哪个文件」，而 Dashboard 的卡片上也是这一行。
          summary: (draft_) => ({
            label: LABELS.configSource,
            value: modelConfigRelative(agentId, entryOf(draft_, agentId).configScope ?? "global"),
          }),
        }));
      }
    }
    steps.push(single({
      id: `sessions:${agentId}`,
      group: agentId,
      groupTitle: name,
      title: agentQuestion(name, LABELS.sessions),
      description: "Global — every project shares one record · Project — this project's own, under .agents/sessions",
      options: [
        { value: "global", label: LABELS.scope.global },
        { value: "project", label: LABELS.scope.project },
      ],
      value: (draft_) => entryOf(draft_, agentId).sessionScope ?? "project",
      write: (draft_, value) => setField(draft_, agentId, "sessionScope", value),
      summary: (draft_) => [
        ...(managesOwnAuth ? [{ label: LABELS.authentication, value: LABELS.native }] : []),
        { label: LABELS.sessions, value: scopeLabel(entryOf(draft_, agentId).sessionScope ?? "project") },
      ],
    }));
  }
  steps.push(single({
    id: "history",
    title: LABELS.history,
    description: "Shared — selected agents can continue the same Avenic history · Isolated — each agent keeps independent histories",
    options: [{ value: "shared", label: LABELS.historyMode.shared }, { value: "isolated", label: LABELS.historyMode.isolated }],
    value: (draft_) => draft_.historyMode ?? "shared",
    write: (draft_, value) => { draft_.historyMode = value; },
    summary: (draft_) => historyLabel(draft_.historyMode ?? "shared"),
  }));
  // The one answer that replaces an answer: asked after the new draft is
  // complete and before Apply, with Keep as the offered default. Nothing here
  // deletes anything — the answer rides along in the draft and is carried out by
  // `applyProjectDraft`, which deletes only what Avenic can prove it created.
  const leftovers = leftoverTargets(draft);
  if (leftovers.length > 0) {
    for (const target of leftovers) {
      // A settled line of its own, before the question, naming the file the
      // answer left behind: the question below it is about that file.
      steps.push({
        id: `leftover:${target.agentId}`,
        kind: "note",
        group: `leftover:${target.agentId}`,
        title: `Existing ${target.name} configuration`,
        summary: () => `${target.relative} is still present.`,
      });
    }
    const named = methodSwitches(draft)
      .filter(({ before }) => before === "api")
      .map(({ agentId, before, after }) => {
        const name = getAgent(agentId).displayName;
        const method = (entry) => authenticationValue({ authMethod: entry, authScope: scopeOf(draft.agents?.[agentId]) });
        const stock = draft.stored?.[agentId] ?? {};
        if (before !== after) {
          return `${name} ${authenticationValue({ authMethod: before, authScope: scopeOf(stock) })} → ${method(after)}`;
        }
        // Same method, different scope: it is the file that moved, and saying
        // "API → API" would not tell the reader what did.
        return `${name} ${authenticationValue({ authMethod: "api", authScope: scopeOf(stock) })} → ${method("api")}`;
      })
      .join(" · ");
    steps.push(single({
      id: "switch",
      title: "What should Avenic do?",
      description: `${named} · Keep — nothing is deleted · Remove — delete the file Avenic created, if you have not changed it`,
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
    // happened. No is what the question offers first, whatever the answer
    // before it was.
    const deletable = leftovers.filter((target) => target.removable);
    if (draft.switchMode === "remove" && deletable.length > 0) {
      steps.push(single({
        id: "switch-confirm",
        title: "Remove old configuration? This cannot be undone.",
        description: `${deletable.map((target) => `${target.name} · ${target.relative}`).join(" · ")} · only a file Avenic created and that still holds exactly what it wrote is deleted`,
        options: [{ value: "remove", label: "Yes" }, { value: "keep", label: "No" }],
        // This second, destructive question always opens on No: the answer to
        // the question before it must never be what a bare Enter repeats.
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
 * carrying the answers its own method uses and nothing of the other method's. A
 * deselected agent's answers stay in the draft rather than in the configuration,
 * so backing up, turning an agent off and applying does not leave a
 * half-configured agent behind.
 */
export function projectDraftSubmission(draft) {
  const agents = {};
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
      continue;
    }
    // No method answered: the project says it does not know, and a plain
    // launch asks (see agent-runtime.mjs) instead of a guess being stored.
    agents[agentId] = { sessionScope };
  }
  return { agents, historyMode: draft.historyMode ?? "shared" };
}

/**
 * Commit a finished draft through the one project-settings writer, and — only
 * when the wizard's own question was answered "Remove" — give back what the
 * previous answer left behind. After, never before: a write that fails must not
 * leave the user with neither answer.
 */
export async function applyProjectDraft(projectRoot, draft, options = {}) {
  const result = await applyProjectConfiguration(projectRoot, projectDraftSubmission(draft), options);
  const released = [];
  if (draft.switchMode === "remove") {
    for (const { agentId } of methodSwitches(draft)) {
      const outcome = await releasePreviousMethod(projectRoot, agentId, draft.stored?.[agentId], options);
      if (outcome) released.push(outcome);
    }
  }
  return { ...result, released };
}
