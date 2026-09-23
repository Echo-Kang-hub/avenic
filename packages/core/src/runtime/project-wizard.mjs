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
// agent's own configuration files carries it. That file is the agent's own — in
// the agent's keys, in the agent's format — and there are two honest ways to fill
// it: by hand (Avenic prepares an empty, valid file and writes nothing into it,
// which is what `Set up by hand` means, and the default), or through the Center,
// which asks for a provider, a model and — only when the file has no credential
// yet — a key, and merges exactly those into the file the agent already reads.
//
// The Center is a way to answer, never a settings format of its own: the answers
// do not become Avenic's configuration. They are written into the agent's file and
// read back out of it, because a provider the interface remembers and a provider
// the file holds are two answers, and only the second one is real.
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
import { applyModelConfiguration, modelConfigRelative, previewModelConfiguration } from "./model-config.mjs";
import { claudeTemplate, codexTemplate, providerForBaseUrl, providerPreset, providersForAgent } from "./providers.mjs";
import { applyProjectConfiguration, leftoverTargets, methodSwitches, releasePreviousMethod } from "./session-interop.mjs";

/** The answer that means "the file is mine to fill in" — and the default one. */
const BY_HAND = "hand";

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

/**
 * The Center's questions for one API agent, as steps.
 *
 * They are asked only where Avenic knows the agent's own format — `providersForAgent`
 * is the answer to that, and for an agent that keeps its own provider registry it
 * is empty, so OpenCode is asked none of these. The first question always offers
 * `Set up by hand` and opens on it unless the agent's file already names a
 * provider: a project that never opens the Center must not be changed by it.
 *
 * The key is asked last, and only when the file has no credential yet — someone
 * who already has one in the file is changing a model, not re-entering a secret.
 * Codex is never asked for a key at all: its configuration names the environment
 * variable its key lives in, so the secret stays in the environment, and the one
 * thing the user does need to know is said in a note rather than asked.
 *
 * `entry.baseUrl`/`entry.model` are filled from the file the agent already reads
 * when the two hosts disagree about nothing: the value a previous answer left in
 * the draft wins, and the file is the fallback, so going back re-opens the
 * question with the answer it already has.
 */
function centerSteps(draft, agentId, name, entryOf, setField) {
  const providers = providersForAgent(agentId);
  if (providers.length === 0) return [];
  const ask = (step) => ({ kind: "single", group: agentId, groupTitle: name, ...step });
  const chosenProvider = (draft_, entry) => entry.provider ?? providerForBaseUrl(agentId, draft_.files?.[agentId]?.baseUrl)?.id ?? BY_HAND;
  const presetOf = (entry) => providerPreset(entry.provider);
  const steps = [
    ask({
      id: `provider:${agentId}`,
      title: agentQuestion(name, LABELS.provider),
      description: "Set up by hand — Avenic prepares the file and writes nothing into it · or choose a provider and the Center fills in the endpoint and model it documents",
      options: [
        { value: BY_HAND, label: "Set up by hand", description: "your own file, your own tool" },
        ...providers.map((preset) => ({ value: preset.id, label: preset.displayName, description: preset.docs })),
      ],
      value: (draft_) => chosenProvider(draft_, entryOf(draft_, agentId)),
      write: (draft_, value) => setField(draft_, agentId, "provider", value),
      summary: (draft_) => {
        const entry = entryOf(draft_, agentId);
        const provider = chosenProvider(draft_, entry);
        return { label: LABELS.provider, value: provider === BY_HAND ? "by hand" : providerPreset(provider)?.displayName ?? provider };
      },
    }),
  ];
  const entry = entryOf(draft, agentId);
  if ((entry.provider ?? null) === null || entry.provider === BY_HAND) return steps;
  const preset = presetOf(entry);
  if (preset === null) return steps;
  const format = preset[agentId];
  // A preset with no address of its own is a proxy the user runs: the address is
  // theirs to type, and without it there is nothing to write.
  if (format.baseUrl === null) {
    steps.push({
      kind: "text",
      group: agentId,
      groupTitle: name,
      id: `baseurl:${agentId}`,
      title: agentQuestion(name, LABELS.baseUrl),
      placeholder: "https://gateway.internal/anthropic",
      emptyMessage: "Enter the provider's base URL",
      value: (draft_) => entryOf(draft_, agentId).baseUrl ?? "",
      write: (draft_, value) => setField(draft_, agentId, "baseUrl", value),
      summary: (draft_) => ({ label: LABELS.baseUrl, value: entryOf(draft_, agentId).baseUrl ?? "" }),
    });
  }
  steps.push({
    kind: "text",
    group: agentId,
    groupTitle: name,
    id: `model:${agentId}`,
    title: agentQuestion(name, LABELS.model),
    // The names the vendor documents ride along as the hint, not as a list to
    // choose from: a provider's models change more often than this file does.
    placeholder: preset.curated.length > 0 ? preset.curated.join(" · ") : "the model id your provider documents",
    emptyMessage: "Enter a model",
    value: (draft_) => entryOf(draft_, agentId).model ?? draft_.files?.[agentId]?.model ?? "",
    write: (draft_, value) => setField(draft_, agentId, "model", value),
    summary: (draft_) => ({ label: LABELS.model, value: entryOf(draft_, agentId).model ?? "" }),
  });
  if (agentId === "codex") {
    steps.push({
      id: `key-note:${agentId}`,
      kind: "note",
      group: agentId,
      groupTitle: name,
      title: `${name} credential`,
      summary: () => `${preset.codex.envKey} — Codex reads its key from that environment variable, so nothing secret is written into its configuration file.`,
    });
    return steps;
  }
  steps.push({
    kind: "text",
    group: agentId,
    groupTitle: name,
    id: `key:${agentId}`,
    title: agentQuestion(name, LABELS.credential),
    placeholder: "the key is written to the configuration file and never shown again",
    mask: true,
    // 文件里已经有凭据：留空是「别动它」，不是「清掉它」。
    optional: Boolean(draft.files?.[agentId]?.credentialSet),
    emptyMessage: "Enter the API key, or answer Set up by hand to keep your credential out of the file",
    value: () => "",
    write: (draft_, value) => setField(draft_, agentId, "apiKey", value),
    summary: (draft_) => ({
      label: LABELS.credential,
      value: entryOf(draft_, agentId).apiKey ? `written to ${modelConfigRelative(agentId, scopeOf(entryOf(draft_, agentId)) ?? "global")}` : "left as the file has it",
    }),
  });
  return steps;
}

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
        steps.push(...centerSteps(draft, agentId, name, entryOf, setField));
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
 * The Center's answers, as the templates that would be written — built and
 * *previewed* before anything is committed, so a file Avenic cannot read stops
 * the run while the project settings are still untouched and the user is left
 * with both answers in view rather than one of them.
 *
 * The credential is read from the in-memory draft here and nowhere else: it is
 * not part of the submission, so it never reaches the project's own settings,
 * and the only file that ever holds it is the agent's own.
 */
async function centerPlans(projectRoot, draft, options) {
  const plans = [];
  for (const agentId of draft.selected) {
    const entry = draft.agents?.[agentId] ?? {};
    if (entry.authMethod !== "api" || !entry.provider || entry.provider === BY_HAND) continue;
    const scope = entry.configScope ?? "global";
    // 文件里已经写着这家供应商：那么这是一次编辑，不是一次新建 —— 供应商推荐的
    // 模型角色属于「新建一份配置」这件事，不属于「回来改一下 History」。
    const presetFills = providerForBaseUrl(agentId, draft.files?.[agentId]?.baseUrl)?.id !== entry.provider;
    // 凭据那一问留空是「别动它」，不是「清掉它」，而模板把空凭据当作错误 —— 所以
    // 空的答案在这里就变成「不给这个字段」（那是模板对「别动它」的说法）。两者是
    // 同一件事的两半：只有这个知道文件里已经有凭据的地方能把空答案读成「保持原样」，
    // 别的地方给的空白仍然是一份会失败的配置，而不是一份悄悄没有凭据的配置。
    const apiKey = typeof entry.apiKey === "string" && entry.apiKey.trim() === "" ? undefined : entry.apiKey;
    const template = agentId === "codex"
      ? codexTemplate(entry.provider, { model: entry.model, baseUrl: entry.baseUrl })
      : claudeTemplate(entry.provider, { apiKey, model: entry.model, baseUrl: entry.baseUrl, roles: entry.roles, presetRoles: presetFills }, entry.blocks ?? []);
    const preview = await previewModelConfiguration(projectRoot, agentId, scope, template, options);
    plans.push({ agentId, scope, template, preview });
  }
  return plans;
}

/**
 * Commit a finished draft through the one project-settings writer, and — only
 * when the wizard's own question was answered "Remove" — give back what the
 * previous answer left behind. After, never before: a write that fails must not
 * leave the user with neither answer.
 *
 * The Center's answers are committed first, and only after all of them have been
 * previewed: each one is a merge into a file that also holds the user's own
 * permissions, hooks and plugins, so what comes back is the same projection a
 * person reads on screen — which file, whether it changed, and the masked diff —
 * never the file's next bytes, which hold the credential.
 */
export async function applyProjectDraft(projectRoot, draft, options = {}) {
  const plans = await centerPlans(projectRoot, draft, options);
  const center = [];
  for (const plan of plans) {
    const applied = await applyModelConfiguration(projectRoot, plan.agentId, plan.scope, plan.template, options);
    center.push({
      agentId: plan.agentId,
      relative: applied.relative,
      file: applied.file,
      scope: applied.scope,
      exists: applied.exists,
      changed: applied.changed,
      written: applied.written,
      diff: applied.diff,
    });
  }
  const result = await applyProjectConfiguration(projectRoot, projectDraftSubmission(draft), options);
  const released = [];
  if (draft.switchMode === "remove") {
    for (const { agentId } of methodSwitches(draft)) {
      const outcome = await releasePreviousMethod(projectRoot, agentId, draft.stored?.[agentId], options);
      if (outcome) released.push(outcome);
    }
  }
  return { ...result, released, center };
}
