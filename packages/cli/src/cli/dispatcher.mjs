import path from "node:path";
import process from "node:process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  AGENTS,
  agentCard,
  agentCardRows,
  agentChoices,
  agentLabel,
  applyProjectConfiguration,
  applyProjectDraft,
  effectiveAgentEnvironment,
  agentExecutableAvailable,
  clearLocalAuth,
  deinitializeAgent,
  effectiveAgentConfig,
  enclosingProjectRoot,
  getAgent,
  getActiveCanonicalSessionId,
  getSessionAdapter,
  git,
  initializeAgent,
  importProjectSessions,
  recoverSharedNativeSessions,
  loadRuntime,
  locateProjectRoot,
  listCanonicalSessions,
  captureCanonicalSession,
  reconcileCanonicalSession,
  continueCanonicalSession,
  continuationLaunchArguments,
  prepareCanonicalContinuation,
  projectCanonicalSession,
  readCanonicalSession,
  historyLabel,
  projectConfig,
  projectDraft,
  projectWizardSteps,
  LABELS,
  leftoverTargets,
  methodSwitches,
  modelConfigPresence,
  modelConfigRelative,
  releasePreviousMethod,
  sessionsGitIgnored,
  setLocalAuth,
  setSessionsGitIgnored,
  setActiveCanonicalSession,
  transcriptModel,
  validateAuthMethod,
  validateHistoryMode,
  validateScope,
  viewOf,
} from "#core";
import { dispatchHub, dispatchSkills } from "./skills-cli.mjs";
import { updateAvenic } from "./self-update.mjs";
import { takeOption } from "./options.mjs";
import { collectLines, confirm, field, intro, isInteractive, line, multiSelect, note, palette, searchableSelect, section, singleSelect, warning, wizard } from "./prompts.mjs";
import { fullLogo } from "./brand.mjs";
import { launchAgent, reportSessionDiagnostics } from "./launch.mjs";
import { loadTranscript, printTranscript, transcriptPreview } from "./transcript-cli.mjs";
import { accountStatusNote, configurationStateNote, detectedNote, dispatchStatusCommand, legacyNote } from "./status-cli.mjs";
import { mark, reportLaunchTiming, timed } from "#core/runtime/timing.mjs";

// Everything above this line is the price of being able to answer the command
// at all: node starting, then the CLI and core modules loading.
mark("modules");

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const packageVersion = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")).version;

// Skills verbs that are also accepted at the top level. Each one is the same
// command under `avenic skills`, so the top-level spelling says so and then
// runs the identical code path — there is no second implementation to keep in
// step, and nothing to remove later beyond these seven words.
const LEGACY_SKILLS_VERBS = new Set(["add", "remove", "adopt", "install", "uninstall", "packs", "tree"]);

function parseAgentList(value) {
  const agents = value.split(",").filter(Boolean);
  if (agents.length === 0) throw new Error("Select at least one agent");
  for (const agentId of agents) getAgent(agentId);
  return [...new Set(agents)];
}

/**
 * The configuration a command just wrote, as the dashboard draws it: one ◇
 * block per agent, then one for the project's History. The rows themselves come
 * from core (`agentCardRows`), so `init`, `avenic <agent> status`, the VS Code
 * Configure page and the dashboard card cannot disagree about a name or an
 * order — and a file the user has already filled in reports its provider and
 * model here, the way the card does.
 */
async function configurationRows(projectRoot, config, options) {
  const sections = [];
  for (const agentId of Object.keys(config.agents)) {
    const agent = getAgent(agentId);
    const card = await agentCard(projectRoot, agentId, options);
    sections.push([agent.displayName, agentCardRows(card, config.historyMode).map((row) => [row.label, row.value])]);
  }
  sections.push([LABELS.history, [historyLabel(config.historyMode)]]);
  return sections;
}

/**
 * A result block, drawn by the one terminal layer: the ◆ heading over the
 * project it is about, then a ◇ section per question with a │ line per answer.
 * Every command that reports what it did ends in this shape, so a result has
 * the same rails and colours as the wizard that produced it and as
 * `avenic status`. `labelWidth` is fixed per command rather than measured, so
 * a value column never re-flows between two runs of the same command.
 */
function printResult(title, projectRoot, groups, options = {}) {
  const { sink, flush } = collectLines(options.io ?? console);
  const labelWidth = options.labelWidth ?? 14;
  // A flat [[label, value], …] is one unnamed group; [[title, rows], …] is several.
  const sections = Array.isArray(groups[0]?.[1]) ? groups : [[null, groups]];
  intro(sink, title, { description: projectRoot });
  for (const [sectionTitle, rows] of sections) {
    sink.write("\n");
    if (sectionTitle) section(sink, sectionTitle);
    // 一行可以是一对 [标签, 值]，也可以是一个没有标签的值：History 那一格说的是
    // 「Shared」这件事本身，给它编一个标签只会多出一个 Dashboard 上没有的词。
    for (const row of rows) {
      if (Array.isArray(row)) field(sink, row[0], row[1], { labelWidth });
      else line(sink, String(row));
    }
  }
  flush();
}

/**
 * The project wizard, as one state machine: `null` when the user cancelled
 * (nothing was written), otherwise the applied configuration. The questions
 * themselves live in core (project-wizard.mjs) so this host and the VS Code
 * extension ask the same things; this function only draws them and, on the
 * Apply step, runs the one project-settings writer. Questions are answered in
 * memory and nothing is written until then.
 */
async function interactiveProjectDraft(projectRoot, editing = false, prompts = {}) {
  const config = projectConfig(await loadRuntime(projectRoot));
  // 草稿带上那次读取的文件事实（哪个文件在、是不是 Avenic 建的、动过没有）：
  // 「换了一种认证方式，旧的那份怎么办」这一问说的必须是磁盘上真实存在的文件，
  // 而不是一个可能存在的路径。
  const draft = projectDraft(config, { files: await modelConfigPresence(projectRoot, config.agents) });
  return wizard({
    ...prompts,
    draft,
    stepsFor: (draft_) => projectWizardSteps(draft_, editing),
    apply: async (draft_) => {
      // The destructive answer was already confirmed by its own step, while
      // `esc` could still mean nothing had happened — so by the time the write
      // runs there is nothing left to ask, and a key pressed now cannot decide
      // an answer that is already being written.
      const result = await applyProjectDraft(projectRoot, draft_);
      for (const entry of result.released ?? []) reportRelease(entry);
      return { result, summary: `Avenic project ${editing ? "updated" : "initialized"} · ${projectRoot}` };
    },
  });
}

/**
 * The directory a `init`/`change` run is about.
 *
 * An explicit root wins: the flag the user typed, or the directory a host
 * passed because the command was invoked on it (VS Code names the selected
 * workspace folder). Otherwise `init` is about exactly the directory the
 * command was run in — never the repository root it happens to live in, since
 * one repository can hold several projects and the directory a user is
 * standing in is the one they mean. `change` edits the project a directory
 * belongs to, so it walks up the way every other command does.
 */
async function setupRoot(values, editing, options) {
  const rootOption = takeOption(values, "--root");
  const explicit = options.projectRootOverride ?? rootOption ?? null;
  const start = path.resolve(explicit ?? options.cwd ?? process.cwd());
  if (explicit || !editing) return { projectRoot: start, start, explicit: explicit !== null };
  return { projectRoot: await locateProjectRoot(start), start, explicit: false };
}

async function dispatchProjectSetup(argumentsList, editing = false, options = {}) {
  const prompts = options.prompts ?? {};
  const values = [...argumentsList];
  const { projectRoot, start, explicit } = await setupRoot(values, editing, options);
  // A directory inside another Avenic project can become a project of its own,
  // but only on purpose: `init` here is a separate project, and the enclosing
  // one keeps its own configuration. Nothing is guessed and nothing is
  // redirected upward — without a terminal to ask, the command says so.
  if (!editing && !explicit) {
    const enclosing = enclosingProjectRoot(start, { includeStart: false });
    if (enclosing) {
      if (!isInteractive(prompts)) {
        throw new Error(`This directory is inside another Avenic project (${enclosing}). Run \`avenic init\` on a terminal to confirm a separate project, or pass --root <path>.`);
      }
      warning(prompts.stdout, `Current directory is inside another Avenic project: ${enclosing}`);
      const separate = await confirm({
        ...prompts,
        title: "Initialize this directory as a separate project?",
      });
      if (separate !== true) return 0;
    }
  }
  let draft;
  if (values.length === 0 && isInteractive(prompts)) {
    await fullLogo(prompts.stdout);
    // The wizard is its own result page: every answer appears once, on the rail
    // it was given on, and the frame it settles with ends in the outcome. There
    // is no second summary to print.
    const applied = await interactiveProjectDraft(projectRoot, editing, prompts);
    if (!applied) return 0;
    const { config, imported } = applied;
    if (imported.length) console.log(`Imported native histories from ${imported.length} agent(s) into the shared workspace.`);
    if (config.historyMode === "shared" && imported.length === 0) {
      const { imported: reconciled } = await reconcileSharedHistory(projectRoot, await loadRuntime(projectRoot));
      if (reconciled > 0) console.log(`Imported ${reconciled} session(s) into the shared workspace.`);
    }
    return 0;
  } else {
    const replaceAgentsIndex = values.indexOf("--replace-agents");
    const replaceAgents = replaceAgentsIndex !== -1;
    if (replaceAgents) values.splice(replaceAgentsIndex, 1);
    const agentsOption = takeOption(values, "--agents");
    const method = takeOption(values, "--auth");
    const scope = takeOption(values, "--scope");
    const sessions = takeOption(values, "--sessions");
    const history = takeOption(values, "--history");
    if (values.length > 0) throw new Error(`Unknown option: ${values[0]}`);
    const current = projectConfig(await loadRuntime(projectRoot));
    // `--replace-agents` 说的是「接下来的 --agents 整份替换，而不是合并」，它自己
    // 不点名任何 agent。少了 --agents 时它替换的是空集 —— 那既不是一份合法配置
    // （一个项目至少有一个 agent），又会把每个 agent 的认证答案顺手抹掉。所以这里
    // 和「一个都没点名」同一条路：说用法，不动盘。
    const ids = agentsOption ? parseAgentList(agentsOption) : replaceAgents ? [] : Object.keys(current.agents);
    if (ids.length === 0) throw new Error(`Usage: avenic ${editing ? "change" : "init"} --agents <claude,codex,opencode> [--auth account|api] [--scope global|project] [--sessions global|project] [--history shared|isolated]`);
    const authMethod = method ? validateAuthMethod(method) : null;
    // 一个 agent 自己管认证时，--auth 没有一个诚实的含义：写下去也不会有人读
    // （OpenCode 的 provider/auth 是它自己的）。与其把这条旗标丢掉，不如说清
    // 楚它不适用的原因。
    if (authMethod) {
      const native = ids.filter((agentId) => getAgent(agentId).managesOwnAuth).map((agentId) => getAgent(agentId).displayName);
      if (native.length > 0) {
        throw new Error(`${native.join(", ")} manages its own authentication and provider configuration — avenic does not configure either. Set sessions with --sessions instead.`);
      }
    }
    const chosenScope = scope ? validateScope(scope) : null;
    if (chosenScope && !authMethod) throw new Error("--scope applies to the method named by --auth");
    const sessionsMode = sessions ? validateScope(sessions, "Sessions") : null;
    draft = { agents: {}, historyMode: history ? validateHistoryMode(history) : current.historyMode };
    // `change --agents codex --auth api` updates Codex without silently
    // disabling Claude/OpenCode. Replacing the enabled set is explicit; the
    // interactive picker already has that explicit whole-list semantics.
    if (editing && !replaceAgents) {
      for (const [agentId, entry] of Object.entries(current.agents)) {
        draft.agents[agentId] = { ...entry, sessionScope: viewOf(entry).sessionScope };
      }
    }
    for (const agentId of ids) {
      const previous = draft.agents[agentId] ?? { sessionScope: "project" };
      // Only the named method's scope is carried: the other one belongs to an
      // answer the project is no longer giving, and `configureProject` drops it
      // on the way to disk anyway.
      const scopeKey = authMethod === "account" ? "accountScope" : "configScope";
      const answered = authMethod ? { [scopeKey]: chosenScope ?? previous[scopeKey] ?? "global" } : {};
      draft.agents[agentId] = { ...previous, ...(authMethod ? { authMethod } : {}), ...answered, sessionScope: sessionsMode ?? previous.sessionScope };
    }
  }
  const result = await applyProjectConfiguration(projectRoot, draft);
  printResult(`Avenic project ${editing ? "updated" : "initialized"}`, projectRoot, await configurationRows(projectRoot, result.config), { labelWidth: 16 });
  if (result.imported.length) console.log(`Imported native histories from ${result.imported.length} agent(s) into the shared workspace.`);
  // Reconfiguring is also a moment to look for history that was left behind,
  // since the next launch deliberately does not.
  if (result.config.historyMode === "shared" && result.imported.length === 0) {
    const { imported } = await reconcileSharedHistory(projectRoot, await loadRuntime(projectRoot));
    if (imported > 0) console.log(`Imported ${imported} session(s) into the shared workspace.`);
  }
  return 0;
}

export function printHelp(io = console) {
  io.log(`Avenic ${packageVersion}

CLI: avenic (shorthand: ave)

Everyday use:
  avenic init                         Set up this directory as a project (interactive)
  avenic claude | codex | opencode    Start an agent's own TUI
  avenic status                       What this project is, and what state it is in
  avenic skills                       Manage Skills (interactive menu on a terminal)
  avenic sessions                     Manage shared sessions (interactive)
  avenic change                       Change Authentication, Sessions or History
  avenic self-update                  Update Avenic from the registry
  avenic --version                    Print the installed version

Options for init/change:
  --root <path>                     Set up this directory instead of the current one
  --agents <claude,codex,opencode>  --replace-agents  Replace the enabled set
  --auth account|api                The Authentication answer (Account is the agent's
                                    own sign-in; API is a provider configuration file)
  --scope global|project            The scope that answer owns (default global)
  --sessions global|project         Keep sessions in the agent's own storage, or in the project
  --history shared|isolated         One shared history across agents, or separate histories
Authentication is one answer per agent, and it is Account or API. Account
configures no model: the agent signs in itself, and nothing about a provider is
asked. API prepares the agent's own configuration file — Avenic creates it empty
if it is missing and never writes into it, so the provider, endpoint, model and
credential stay yours to fill in (the dashboard reads them back out). A project
that has not answered is asked once at launch.
Shared history starts empty and is imported from whatever the agents already
have; isolated histories are imported on request with \`avenic sessions sync\`.
A shared project shares a history; a plain launch still opens a new
conversation every time — \`avenic sessions continue\` is what resumes one.

Sessions:
  avenic sessions list|status          Show shared history and per-agent cursors
  avenic sessions show <id> [--json]   Read one shared conversation as a transcript
  avenic sessions continue <id> --agent <claude|codex|opencode>
  avenic sessions sync                 Import native history into the shared workspace
  avenic sessions git [on|off|status]  Whether project session records are committed

Per-agent commands (thin wrappers over the project settings):
  avenic <claude|codex> init [--auth account|api] [--scope global|project] [--sessions global|project]
  avenic opencode init [--sessions global|project]
  avenic <claude|codex|opencode> deinit [--purge [--purge-credentials]]
  avenic <claude|codex> auth [account|api|reset]     Change this project's Authentication answer
  avenic <claude|codex|opencode> status
  avenic <claude|codex|opencode> sessions [import|writeback|status]
  avenic <claude|codex|opencode> [official CLI arguments...]

Status:
  avenic status [--json]              Project, history, agents and Skills in one view

Skills:
  avenic skills                       Open the Skills menu (interactive on a terminal)
  avenic skills install [pack...]     Install Packs (no args: interactive multi-select on a terminal; scripts fall back to common)
  avenic skills [pack...]             Shorthand for skills install
  avenic skills add <owner/repo> [skill...] [-g]    Install directly from a GitHub repo
  avenic skills adopt <skill...> [-g] Adopt existing on-disk Skills into management
  avenic skills remove <skill...>     Remove external, unmanaged Skills
  avenic skills uninstall <pack...>   Remove Packs and unneeded managed Skills
  avenic skills uninstall             Remove all managed Skills (Yes/No confirm on a terminal)
  avenic skills tree [pack...]        Show source -> Skill tree
  avenic skills packs                 List available Packs
  avenic skills status [-g]           Show the installed tree
  -g, --global                        Use the global user scope

Hub:
  avenic hub add <spec>               Add a Hub source (owner/repo[#ref], URL, or local path) and preview its Packs
  avenic hub select [name|spec]       Pick the current Hub from registered ones (interactive picker on a terminal)
  avenic hub list                     List registered Hubs
  avenic hub sync                     Fetch or update the cached Hub
  avenic hub default                  Show the configured Hub spec
  Private repos use your local git credentials (gh auth login or SSH)
  avenic hub doctor|update|skill-add|remove|pack-add|pack-remove|source-add
                                      (run inside your Hub Git clone)

Deprecated, still working:
  avenic doctor                       Use: avenic status
  avenic add|remove|adopt|install|uninstall|packs|tree
                                      Use the same verb under: avenic skills
  avenic catalog                      Use: avenic hub

Update Avenic:
  avenic self-update
`);
}

// `avenic <agent> status`, for one agent: the same ◇ block, the same rows and
// the same words the dashboard card shows — both read `agentCardRows` — plus
// the notes only a terminal page can carry (a missing CLI, a sign-in that has
// not happened yet, a remedy). A project that has not answered says so, with
// the one command that answers it, never a guessed default.
async function printAgentStatus(agent, projectRoot, state) {
  const config = effectiveAgentConfig(state, agent.id);
  const historyMode = projectConfig(state).historyMode;
  const card = await agentCard(projectRoot, agent.id, { state });
  const rows = agentCardRows(card, historyMode).map((row) => [row.label, row.value]);
  printResult(`${agent.displayName} status`, projectRoot, [[agent.displayName, rows]], { labelWidth: 20 });
  if (config?.source === "local") {
    console.log("\nThis checkout runs on a local override (.agents/local/runtime.local.json), not on the project's own answer.\n");
  }
  if (!agentExecutableAvailable(agent.id)) {
    console.log(`The ${agent.executable} CLI is not on PATH — Avenic still manages this project's history for it.`);
  } else if (!config) {
    console.log(`Not configured here yet — run: avenic ${agent.id} init`);
  }
  for (const [text, options] of agentAuthNotes(agent, card)) {
    console.log(options.mark === "!" ? `! ${text}` : text);
  }
  printMethodNote(agent, config);
}

// 与 `avenic status` 同一批事实、同一句话 —— 那几个句子就在 status-cli 里写着，
// 两个命令读同一个函数。这里补的是上面那张卡片没说到的：文件还没铺开时它怎么了、
// 账号的补救、还在旁边的旧配置、以及这一页独有的「凭据在不在文件里」。
function agentAuthNotes(agent, card) {
  const auth = card.auth;
  if (!auth) return [];
  const broken = configurationStateNote(auth);
  const notes = [broken, accountStatusNote(agent, auth), legacyNote(auth), detectedNote(auth)].filter(Boolean);
  if (!broken && auth.method === "api") {
    const configuration = auth.configuration ?? {};
    notes.push({ text: `${LABELS.credential} ${configuration.credentialSet ? "set in the file" : "not in the file — the launch reads it from your own environment"}`, mark: "·" });
  }
  return notes.map((note) => [note.text, { mark: note.mark }]);
}

// The one line that says what an answer means on disk, so `init` and `auth`
// never leave the user guessing which file the next launch will read. Account
// configures no model — the agent signs in — and API is a file Avenic prepares
// and never writes into, so the sentence differs by method and by scope.
function printMethodNote(agent, config) {
  // 自管认证的 agent 没有「还没回答」这一态：认证和 provider 都是它自己的，启动
  // 路径上也不存在这一问。说它「还没有认证方式、启动时会问一次」是把别人的句子
  // 借给了它——摘要里的 Authentication 行已经说了归谁。
  if (agent.managesOwnAuth) return;
  if (!config?.authMethod) {
    console.log(`\n${agent.displayName} : ${LABELS.authentication} ${LABELS.notChosen} yet — a plain launch asks once and runs on the answer, and \`avenic change\` records it for the project.`);
    return;
  }
  if (config.authMethod === "account") {
    console.log(config.accountScope === "project"
      ? `
Account: ${agent.displayName} signs itself in under .agents/local/${agent.id}/, in its own format. Avenic stores no credential and configures no model.`
      : `
Account: ${agent.displayName} uses this machine's own sign-in. Avenic stores no credential and configures no model.`);
    return;
  }
  console.log(`
API: ${agent.displayName} reads its provider, endpoint and model from ${modelConfigRelative(agent.id, config.configScope)}, a file of its own that Avenic prepares and never writes into. Fill it in — by hand, or with whatever tool you already use — and the next launch reads it.`);
}

/**
 * Switching methods is the one place an old answer could be destroyed by
 * accident, so it is the one place that asks — and it asks before anything is
 * written, while `esc` can still mean nothing has happened. Keep writes the new
 * answer beside the old one; Remove asks a second time and the caller then
 * deletes only what Avenic can prove it wrote — an owned key in the agent's own
 * configuration file, never a global account, never another project's file, and
 * never a sign-in the agent performed itself. `"cancel"` is the user's esc: the
 * prompt has already said so, and the caller must write nothing.
 */
async function askMethodSwitch(targets, prompts) {
  if (!isInteractive(prompts)) return "keep";
  const named = targets.map(({ name, relative }) => `${name} · ${relative}`).join(" · ");
  const answer = await singleSelect({
    ...prompts,
    title: "What should Avenic do?",
    description: targets.length === 0
      ? "The previous answer left no file behind"
      : `${named} · still present`,
    options: [
      { value: "keep", label: "Keep", hint: "nothing is deleted" },
      { value: "remove", label: "Remove", hint: "delete the file Avenic created, if you have not changed it" },
    ],
  });
  if (answer === null) return "cancel";
  if (answer !== "remove") return "keep";
  // Nothing to name means nothing Avenic can show it created: an account home is
  // the agent's own sign-in, so the second, destructive question is not asked —
  // a confirmation for a deletion that is never going to happen teaches users
  // to click through them. The answer stands, and the release reports where the
  // old answer remains.
  if (deletable(targets).length === 0) return "remove";
  const destructive = await confirm({
    ...prompts,
    title: "Remove old configuration? This cannot be undone.",
    description: `${deletable(targets).map(({ name, relative }) => `${name} · ${relative}`).join(" · ")} · only a file Avenic created and that still holds exactly what it wrote is deleted`,
    initial: false,
  });
  // Esc still means nothing happened: the prompt said so, and the caller writes
  // nothing. Answering No is the other reading — keep, which is the default.
  if (destructive === null) return "cancel";
  return destructive === true ? "remove" : "keep";
}

const deletable = (targets) => targets.filter((target) => target.removable);

/**
 * What releasing a previous API answer did, in the one wording every host
 * repeats. Avenic wrote an empty, valid configuration file and nothing else, so
 * there are exactly three answers a release can have: it was Avenic's and
 * untouched, so it is gone; the user has edited it since, so it is theirs; or it
 * was never Avenic's to begin with. Nothing here is a deletion Avenic merely
 * suspects it owns — a file it cannot prove it created stays.
 */
function releaseLines(entry) {
  switch (entry.outcome) {
    case "deleted":
      return [`Removed ${entry.relative} — Avenic created it and nothing had changed it since.`];
    case "modified":
      return [`Configuration in ${entry.relative} was modified outside Avenic and will be preserved.`];
    case "foreign":
      return [`Kept ${entry.relative} — Avenic did not create it, so it is not Avenic's to delete.`];
    default:
      return [`${entry.relative} was already gone — nothing to remove.`];
  }
}

// A release that returned nothing released nothing: an Account's home is the
// agent's own sign-in, so there is no file to name and no line to print.
function reportRelease(entry, io = console) {
  if (!entry) return;
  for (const line of releaseLines(entry)) io.log(line);
}

async function dispatchAgent(agentId, argumentsList, options = {}) {
  const agent = getAgent(agentId);
  const projectRoot = options.projectRoot ?? await timed("project", () => locateProjectRoot());
  const [command, ...remainingArguments] = argumentsList;

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return 0;
  }

  if (command === "init") {
    const initArguments = [...remainingArguments];
    const methodOption = takeOption(initArguments, "--auth");
    const scopeOption = takeOption(initArguments, "--scope");
    const sessionsOption = takeOption(initArguments, "--sessions");
    if (initArguments.length > 0) {
      throw new Error(`Unknown option: ${initArguments[0]}`);
    }
    const entry = {};
    if (methodOption && agent.managesOwnAuth) {
      throw new Error(`${agent.displayName} manages its own authentication and provider configuration — avenic does not configure either. Set sessions with --sessions instead.`);
    }
    if (methodOption) {
      entry.authMethod = validateAuthMethod(methodOption);
      entry[entry.authMethod === "account" ? "accountScope" : "configScope"] =
        scopeOption ? validateScope(scopeOption) : "global";
    } else if (scopeOption) {
      throw new Error("--scope applies to the method named by --auth");
    }
    if (sessionsOption) entry.sessionScope = validateScope(sessionsOption, "Sessions");
    const result = await initializeAgent(projectRoot, agentId, entry);
    const configured = effectiveAgentConfig(result, agentId);
    const card = await agentCard(projectRoot, agentId, { state: result });
    printResult("Avenic project", projectRoot, [
      [agent.displayName, agentCardRows(card, projectConfig(result).historyMode).map((row) => [row.label, row.value])],
      ["Project", [
        ["Settings", result.configChanged ? "Updated" : "Unchanged"],
        ["Git ignore", result.gitignoreChanged ? "Updated" : "Unchanged"],
        ["Structure", result.structureRepaired ? "Repaired" : "Intact"],
        ["Session Git", (await sessionsGitIgnored(projectRoot)) ? "Off" : "On"],
      ]],
    ], { labelWidth: 18 });
    const changedSomething = result.configChanged || result.gitignoreChanged || result.structureRepaired;
    console.log(changedSomething ? "\nChanged:" : "\nAlready up to date — nothing changed.");
    if (result.configChanged) {
      console.log("  .agents/runtime.json          Project settings (Authentication, Sessions, History)");
    }
    if (result.gitignoreChanged) {
      console.log("  .gitignore                    Added ignore rules for .agents/ and .claude/skills/");
    }
    if (result.structureRepaired) {
      console.log(`  .agents/sessions/${agentId}/       Portable sessions (in Git by default)`);
      if (entry.authMethod === "account" && entry.accountScope === "project") {
        // The directory, not the credential: the agent's own login writes there
        // in its own format, and Avenic never invents one.
        console.log(`  .agents/local/${agentId}/       Project Account home (the agent signs in there itself)`);
      }
    }
    printMethodNote(agent, configured);
    console.log(`\nUsage:
  avenic ${agentId}              Launch ${agent.displayName}
  avenic ${agentId} status       Show configuration
  avenic ${agentId} deinit       Undo init (--purge also deletes data; keeps the agent's own sign-in)
`);
    console.log(
      "Project sessions may contain prompts, source code, command output, file paths, and secrets. Only commit sessions to repositories you trust.\n",
    );
    return 0;
  }

  if (command === "deinit") {
    const purge = remainingArguments.includes("--purge");
    const purgeCredentials = remainingArguments.includes("--purge-credentials");
    const unknown = remainingArguments.find((argument) => argument !== "--purge" && argument !== "--purge-credentials");
    if (unknown) {
      throw new Error(`Unknown option: ${unknown}`);
    }
    // --purge 清的是 Avenic 的数据；agent 自己的登录住在 .agents/local/<agent>/，
    // 是它自己写的（release 路径正因为不是 Avenic 的东西而拒绝删）。删它要第二个
    // 开关，不能靠 --purge 顺带。
    if (purgeCredentials && !purge) {
      throw new Error("--purge-credentials requires --purge");
    }
    const result = await deinitializeAgent(projectRoot, agentId, purge ? { purge: true, purgeCredentials } : undefined);
    printResult(`${agent.displayName} deinitialization`, projectRoot, [
      ["Settings", result.changed ? "Removed" : "Already absent"],
      ["Data", result.purged ? "Purged" : "Preserved"],
      ["Agents", `${result.remaining} remaining`],
    ], { labelWidth: 10 });
    if (purge) {
      // 说出真正被删的是什么：Avenic 的数据，以及（默认不删的）那个登录文件。
      // 之前的句子里点名的 settings.local.json 从来不在这棵树里 —— 那是另一处
      // 文件，API 配置的家。
      console.log(`\nPurged: .agents/sessions/${agentId}/`);
      if (result.keptCredential !== null) {
        console.log(`Kept ${result.keptCredential} — the sign-in ${agent.displayName} wrote itself; Avenic does not delete it without being asked twice (avenic ${agentId} deinit --purge --purge-credentials).`);
      } else {
        console.log(`Purged: .agents/local/${agentId}/ — any sign-in the agent kept there is gone; the next launch asks you to sign in again.`);
      }
    } else {
      console.log(`\nReinitialize later without losing portable sessions:\n  avenic ${agentId} init`);
    }
    return 0;
  }

  if (command === "auth") {
    if (remainingArguments.length === 0) {
      await printAgentStatus(agent, projectRoot, await loadRuntime(projectRoot));
      return 0;
    }
    const values = [...remainingArguments];
    const scopeOption = takeOption(values, "--scope");
    const [action, ...extra] = values;
    if (extra.length > 0) {
      throw new Error(`Unknown option: ${extra[0]}`);
    }
    const prompts = options.prompts ?? {};
    if (action === "reset") {
      await clearLocalAuth(projectRoot, agentId);
      await printAgentStatus(agent, projectRoot, await loadRuntime(projectRoot));
      return 0;
    }
    if (agent.managesOwnAuth) {
      throw new Error(`${agent.displayName} manages its own authentication and provider configuration`);
    }
    const authMethod = validateAuthMethod(action);
    const state = await loadRuntime(projectRoot);
    const previous = effectiveAgentConfig(state, agentId);
    if (!previous) {
      throw new Error(`${agent.displayName} is not initialized. Run: avenic ${agentId} init`);
    }
    const scopeKey = authMethod === "account" ? "accountScope" : "configScope";
    const scopeAnswer = scopeOption ? { [scopeKey]: validateScope(scopeOption) } : {};
    // What this command is about to replace, drawn from the model's own switch
    // helper — the same one the wizard's step list comes from — so a terminal
    // and an editor cannot ask about different switches or name different
    // files. An unset scope reads as global to that helper because it is what
    // the write below will say.
    const switchDraft = {
      selected: [agentId],
      stored: { [agentId]: previous },
      agents: { [agentId]: { authMethod, ...scopeAnswer } },
      files: await modelConfigPresence(projectRoot, { [agentId]: previous }),
    };
    const decision = methodSwitches(switchDraft).length > 0 ? await askMethodSwitch(leftoverTargets(switchDraft), prompts) : "keep";
    if (decision === "cancel") return 0;
    await setLocalAuth(projectRoot, agentId, { authMethod, ...scopeAnswer });
    // After, never before: the write above can fail, and a failed write must not
    // leave the user with neither answer. `previous` is a captured fact, so the
    // release does not need the live configuration to still describe it.
    if (decision === "remove") {
      reportRelease(await releasePreviousMethod(projectRoot, agentId, previous, { environment: process.env }));
    }
    // The result of a switch is a page like every other command's: what the
    // agent now runs under, followed by the one sentence saying what that means
    // on disk. Reporting it as prose alone left the user to run `status` to see
    // what they had just changed.
    await printAgentStatus(agent, projectRoot, await loadRuntime(projectRoot));
    return 0;
  }

  if (command === "status") {
    await printAgentStatus(agent, projectRoot, await loadRuntime(projectRoot));
    return 0;
  }

  if (command === "sessions") {
    const state = await loadRuntime(projectRoot);
    if (!effectiveAgentConfig(state, agentId)) {
      throw new Error(`${agent.displayName} is not initialized. Run: avenic ${agentId} init`);
    }
    const action = remainingArguments[0] ?? "status";
    if (remainingArguments.length > 1 || !["import", "writeback", "status"].includes(action)) {
      throw new Error(`Usage: avenic ${agentId} sessions [import|writeback|status]`);
    }
    const adapter = getSessionAdapter(agentId);
    if (action === "status") {
      const result = await adapter.status(projectRoot);
      printResult(`${agent.displayName} portable sessions`, projectRoot, [["Sessions", String(result.count)]], { labelWidth: 10 });
      return 0;
    }
    // Import composes the home inside core; the writeback writes raw, so it is
    // handed the same composed environment here.
    const result = action === "import"
      ? await importProjectSessions(projectRoot, agentId)
      : await adapter.restore(projectRoot, { environment: await effectiveAgentEnvironment(projectRoot, agentId) });
    printResult(`${agent.displayName} session ${action}`, projectRoot, [
      ["Sessions", action === "import" ? `${result.discovered} discovered; ${result.imported} imported; ${result.unchanged} unchanged; ${result.failed} failed` : String(result.count)],
      [action === "import" ? "Portable" : "Written back", action === "import" ? (result.changed ? "Updated" : "Unchanged") : String(result.added + result.updated)],
    ], { labelWidth: 14 });
    if (action === "import") reportSessionDiagnostics(result.diagnostics, { missingRoots: true });
    if (result.conflicts > 0) {
      console.log(`Conflicts ${result.conflicts} (project sessions overwrote native storage)`);
    }
    return 0;
  }

  // The plain launch is its own module so that starting an Agent loads only
  // what starting an Agent needs. There is one implementation of it.
  return launchAgent(agentId, argumentsList, { ...options, projectRoot });
}

async function dispatchDoctor() {
  const projectRoot = locateProjectRoot();
  const state = await loadRuntime(projectRoot);
  console.log("Avenic Doctor\n");
  console.log(`Project root       OK  ${projectRoot}`);
  // 「项目设置」而不是那份文件的名字：`Runtime` 是 Avenic 内部的说法，
  // 而这一页是给用户看的诊断 —— init 的结果页叫它 Settings，这里也叫它 Settings。
  console.log(`Project settings   ${state.runtime.agents ? "OK" : "ERROR"}`);
  for (const agentId of Object.keys(AGENTS)) {
    const agent = getAgent(agentId);
    console.log(`${agent.displayName.padEnd(18)} ${agentExecutableAvailable(agent.id) ? "OK" : "NOT FOUND"}`);
  }
  return 0;
}

// Sessions leave the Git index through the same git Avenic uses everywhere
// else, so a checkout with no git on PATH, or a locked index, is reported with
// one of the classified failure kinds instead of a bare "unable to remove".
async function untrackSessions(projectRoot) {
  const tracked = await git(["ls-files", "--", ".agents/sessions"], { cwd: projectRoot })
    // A project that is not a checkout has nothing tracked to remove — the same
    // answer as an empty index, and not a failure worth stopping the command.
    .catch((error) => (error.kind === "repo-missing" ? "" : Promise.reject(error)));
  if (!tracked) return 0;
  await git(["rm", "-r", "--cached", "--force", "--ignore-unmatch", "--", ".agents/sessions"], {
    cwd: projectRoot,
    stdio: "inherit",
  });
  return tracked.split(/\r?\n/).filter(Boolean).length;
}

// Shared history is reconciled when the user looks at it, never on the way
// into an agent. A run whose exit path never happened (closed terminal, killed
// editor, dead watchdog) is picked up here instead of costing every launch.
// Returns the diagnostics the caller must surface once.
async function reconcileSharedHistory(projectRoot, state) {
  if (projectConfig(state).historyMode !== "shared") return { imported: 0, diagnostics: [] };
  const agentIds = Object.keys(projectConfig(state).agents);
  if (agentIds.length === 0) return { imported: 0, diagnostics: [] };
  const results = await recoverSharedNativeSessions(projectRoot, agentIds);
  return {
    imported: results.reduce((total, result) => total + (result.imported ?? 0), 0),
    diagnostics: results.flatMap((result) => result.diagnostics ?? []).filter(Boolean),
  };
}

async function reportReconciliation(projectRoot) {
  const { diagnostics } = await reconcileSharedHistory(projectRoot, await loadRuntime(projectRoot));
  reportSessionDiagnostics(diagnostics);
}

// The outermost layer is the only place that reports what could not be read

// What a continuation is about to hand the target, in one phrase: how many
// turns a projection carried, or how many events a fallback prompt summarised.
function continuationDelta(continuation) {
  const turns = continuation?.projection?.turns?.length;
  if (typeof turns === "number") {
    const checkpoint = continuation.projection.checkpoint ? ", plus a condensed checkpoint" : "";
    return `projection of ${turns} turn(s)${checkpoint}`;
  }
  return `delta of ${continuation?.handoff?.delta?.length ?? 0} event(s)`;
}

// One continuation sequence for every agent: capture what the target already
// has, prepare the delta, let the official CLI run in the foreground, capture
// what it produced, and only then commit the mapping. Claude and Codex reach it
// by resuming their mapped native session; OpenCode reaches it with a fresh
// official session when the one Avenic projected will not start.
async function runCanonicalContinuation({ projectRoot, state, environment, mode, agentId, forceBootstrap = false }) {
  const targetAdapter = getSessionAdapter(agentId);
  // A stale cursor means the target needs a semantic delta, not a new native
  // thread. Let the official resume command preserve the target's native
  // context; only an unavailable mapping or a failed resume falls back to a
  // fresh official thread below.
  let capturedDuringLaunch = null;
  const result = await continueCanonicalSession({
    projectRoot,
    canonicalId: mode,
    targetAgent: agentId,
    environment,
    forceBootstrap,
    // Every call resolves the normal auth/runtime environment for that agent.
    // Sessions never manufacture or migrate credential directories.
    captureKnown: async () => {
      const results = await reconcileCanonicalSession(projectRoot, mode);
      for (const result of results.filter((entry) => entry.stale)) {
        console.warn(`${getAgent(result.agentId).displayName} native mapping is stale; rehydrating from canonical history.`);
      }
    },
    capture: async (stage, context = {}) => {
      if (stage === "after" && context.launched?.capturedDuringLaunch) return context.launched.capturedDuringLaunch;
      const nativeSessionId = context.launched?.nativeSessionId
        ?? context.continuation?.nativeSessionId
        ?? (await readCanonicalSession(projectRoot, mode)).mappings.projections[agentId]?.nativeSessionId;
      if (!nativeSessionId) return null;
      return targetAdapter.readCanonical(projectRoot, nativeSessionId, { environment });
    },
    launch: async (continuation) => {
      let launchedContinuation = continuation;
      // A projection names the native session it prepared; only the handoff
      // fallback has no native side yet, and only it needs discovery after the
      // run.
      let nativeSessionId = continuation.nativeSessionId ?? null;
      let launch = continuationLaunchArguments(continuation);
      const launchStartedAt = Date.now() - 1000;
      console.log(`Continuing ${mode} with ${getAgent(agentId).displayName}: ${continuation.mode}, ${continuationDelta(continuation)}.`);
      const launchOptions = {
        projectRoot,
        environment,
        input: launch.input,
        skipCanonical: true,
        skipRestore: true,
        onExit: async () => {
          const nativeId = nativeSessionId ?? await targetAdapter.discoverNativeSession(projectRoot, { environment, notBefore: launchStartedAt });
          capturedDuringLaunch = await targetAdapter.readCanonical(projectRoot, nativeId, { environment, canonicalSessionId: mode });
        },
      };
      let status = await dispatchAgent(agentId, launch.argumentsList, launchOptions);
      // A session the target will not open is not the end of the shared
      // conversation. Rebuild it natively first — that is still the target's
      // own session, just a fresh one — and only when the target cannot take a
      // projection at all hand it the bounded transcript. Escalate in that
      // order, and never repeat a command that already failed.
      const display = getAgent(agentId).displayName;
      const tried = new Set([JSON.stringify(launch.argumentsList)]);
      const rebuilds = [
        {
          message: `${display} session could not be opened; rebuilding it from shared canonical history.`,
          prepare: () => prepareCanonicalContinuation(projectRoot, mode, agentId, { environment, forceBootstrap: true }),
        },
        {
          message: `${display} could not be started with the projected session; continuing in a fresh official session from shared canonical history.`,
          prepare: () => prepareCanonicalContinuation(projectRoot, mode, agentId, { environment, handoff: true }),
        },
      ];
      for (const rebuild of status === 0 ? [] : rebuilds) {
        console.log(rebuild.message);
        const next = await rebuild.prepare();
        const nextLaunch = continuationLaunchArguments(next);
        const key = JSON.stringify(nextLaunch.argumentsList);
        if (tried.has(key)) continue;
        tried.add(key);
        launchedContinuation = next;
        launch = nextLaunch;
        nativeSessionId = next.nativeSessionId ?? null;
        status = await dispatchAgent(agentId, launch.argumentsList, { ...launchOptions, input: launch.input });
        if (status === 0) break;
      }
      if (status !== 0) throw new Error(`${display} exited with status ${status}`);
      const discoveredId = nativeSessionId
        ?? await targetAdapter.discoverNativeSession(projectRoot, { environment, notBefore: launchStartedAt });
      return {
        nativeSessionId: discoveredId,
        projectionHash: launchedContinuation.projection?.hash ?? launchedContinuation.handoff?.hash ?? null,
        capturedDuringLaunch,
      };
    },
  });
  reportSessionDiagnostics(result.diagnostics);
  await setActiveCanonicalSession(projectRoot, mode);
  return result;
}

// One conversation, read from the shared store. `stamp` here is the same slice
// the rest of the CLI prints, so a transcript and a status page never disagree
// about when something happened.
async function canonicalSessionsWithPreview(projectRoot) {
  const sessions = await listCanonicalSessions(projectRoot);
  const rows = [];
  for (const session of sessions) {
    const record = await readCanonicalSession(projectRoot, session.id);
    const transcript = await loadTranscript(projectRoot, session.id, { record });
    rows.push({ session, record, transcript });
  }
  return rows;
}

/**
 * The Sessions browser: List → pick a conversation → read it, continue it, or
 * make it the active one. Reading is the first thing offered because looking at
 * what the agents already said is what a user opens this menu to do.
 */
async function browseSessions(projectRoot, options = {}) {
  const prompts = options.prompts ?? {};
  const sessions = await listCanonicalSessions(projectRoot);
  if (sessions.length === 0) throw new Error("No shared sessions are available. Import histories or switch to Shared mode first.");
  const choices = [];
  for (const row of await canonicalSessionsWithPreview(projectRoot)) {
    choices.push({
      value: row.session.id,
      label: row.session.title ?? row.session.id,
      hint: `${row.transcript.summary.turns} turns · ${transcriptPreview(row.transcript, 40)}`,
    });
  }
  const selected = await searchableSelect({ ...prompts, title: "Sessions", options: choices });
  if (!selected) return 0;
  return sessionActions(projectRoot, selected, options);
}

async function sessionActions(projectRoot, sessionId, options = {}) {
  const prompts = options.prompts ?? {};
  const stdout = prompts.stdout ?? process.stdout;
  const transcript = await loadTranscript(projectRoot, sessionId);
  const historyMode = options.historyMode ?? projectConfig(await loadRuntime(projectRoot)).historyMode;
  const participants = transcript.summary.agents.map(agentLabel).join(", ") || "no agent turns yet";
  const action = await singleSelect({
    ...prompts,
    title: `Session ${transcript.summary.title}`,
    description: `${transcript.summary.turns} turns · ${participants}`,
    options: [
      { value: "view", label: "View history", hint: `${transcript.summary.events} events` },
      ...(historyMode === "shared" ? [
        { value: "continue", label: "Continue with an agent", hint: "the shared conversation, handed over natively" },
        // "Active" is the conversation `avenic status` reports this project is
        // on — it is not what a plain launch resumes. Saying "new launches join
        // this one" promised the auto-resume that used to make `avenic claude`
        // open an old conversation instead of a new one.
        { value: "active", label: "Set as active session", hint: "the one avenic status calls Active" },
      ] : []),
    ],
  });
  if (!action) return 0;
  if (action === "view") {
    printTranscript(stdout, transcript, { environment: options.environment });
    // Back to the same choices, so reading a long conversation and then
    // continuing it does not mean walking the whole menu again.
    return sessionActions(projectRoot, sessionId, options);
  }
  if (action === "active") {
    await setActiveCanonicalSession(projectRoot, sessionId);
    console.log(`Active shared session: ${sessionId}`);
    return 0;
  }
  const agentId = await singleSelect({ ...prompts, title: "Continue with", options: agentChoices() });
  if (!agentId) return 0;
  return dispatchSessions(["continue", sessionId, "--agent", agentId], options);
}

async function dispatchSessions(argumentsList, options = {}) {
  const [command, mode = "status", ...extra] = argumentsList;
  const prompts = options.prompts ?? {};
  const projectRoot = options.projectRootOverride ?? locateProjectRoot();
  if (!command && isInteractive(prompts)) {
    await fullLogo(prompts.stdout);
    const historyMode = projectConfig(await loadRuntime(projectRoot)).historyMode;
    const action = await singleSelect({
      ...prompts,
      title: `Sessions (${historyMode})`,
      options: [
        ...(historyMode === "shared" ? [{ value: ["continue"], label: "Continue shared session" }] : []),
        { value: ["list"], label: "List sessions" },
        { value: ["sync"], label: "Import histories" },
        ...(historyMode === "shared" ? [{ value: ["active"], label: "Set active session" }] : []),
        ...(historyMode === "isolated" ? [{ value: ["migrate"], label: "Switch to Shared" }] : []),
        { value: ["status"], label: "Status" },
      ],
    });
    if (!action) return 0;
    if (action[0] === "migrate") return dispatchProjectSetup([], true, options);
    // Continue and Set active list shared history directly, so reconcile
    // before the choices are drawn.
    if (action[0] === "active" || action[0] === "continue") await reportReconciliation(projectRoot);
    if (action[0] === "active") {
      const sessions = await listCanonicalSessions(projectRoot);
      if (sessions.length === 0) throw new Error("No shared sessions are available. Import histories or switch to Shared mode first.");
      const sessionId = await singleSelect({ ...prompts, title: "Set active session", options: sessions.map((session) => ({ value: session.id, label: session.title ?? session.id })) });
      if (!sessionId) return 0;
      await setActiveCanonicalSession(projectRoot, sessionId);
      console.log(`Active shared session: ${sessionId}`);
      return 0;
    }
    if (action[0] === "list") {
      // Reading a conversation must show what the agents have already said, not
      // what the last import happened to catch.
      await reportReconciliation(projectRoot);
      return browseSessions(projectRoot, options);
    }
    if (action[0] !== "continue") return dispatchSessions(action, options);
    const sessions = await listCanonicalSessions(projectRoot);
    if (sessions.length === 0) throw new Error("No shared sessions are available. Import histories or switch to Shared mode first.");
    const sessionId = await singleSelect({ ...prompts, title: "Continue shared session", options: sessions.map((session) => ({ value: session.id, label: session.title ?? session.id })) });
    if (!sessionId) return 0;
    const agentId = await singleSelect({ ...prompts, title: "Continue with", options: agentChoices() });
    if (!agentId) return 0;
    return dispatchSessions(["continue", sessionId, "--agent", agentId], options);
  }
  if (!command) return dispatchSessions(["status"], options);
  // `sync` reconciles every agent itself, in every mode.
  if (command === "list" || command === "status" || command === "continue") {
    await reportReconciliation(projectRoot);
  }
  if (command === "show") {
    const id = mode === "status" ? null : mode;
    let json = false;
    let limit = 0;
    for (let index = 0; index < extra.length; index += 1) {
      const value = extra[index];
      if (value === "--json") { json = true; continue; }
      if (value === "--limit") { limit = Number.parseInt(extra[index + 1] ?? "", 10) || 0; index += 1; continue; }
      throw new Error(`Unknown option for avenic sessions show: ${value}`);
    }
    if (!id) throw new Error("Usage: avenic sessions show <id> [--json] [--limit <turns>]");
    // Reading is a pure read of the shared store: no capture, no projection, no
    // network. `sessions list` is what brings native history up to date.
    const transcript = await loadTranscript(projectRoot, id);
    if (json) {
      // Machine output is the model, never the drawing.
      process.stdout.write(`${JSON.stringify(transcriptModel(transcript), null, 2)}\n`);
      return 0;
    }
    printTranscript(prompts.stdout ?? process.stdout, transcript, { limit, environment: options.environment });
    return 0;
  }
  if ((command === "list" || command === "status") && argumentsList.length === 1) {
    const out = prompts.stdout ?? process.stdout;
    const colors = palette(out, options.environment ?? process.env);
    const activeCanonicalId = await getActiveCanonicalSessionId(projectRoot);
    const rows = await canonicalSessionsWithPreview(projectRoot);
    intro(out, command === "status" ? "Canonical session status" : "Canonical sessions", { colors, description: projectRoot });
    field(out, "Active", activeCanonicalId ?? "none", { colors });
    if (rows.length === 0) {
      note(out, "No canonical sessions are available yet. Import histories or switch to Shared mode.", { colors });
      return 0;
    }
    for (const { session, record, transcript } of rows) {
      const latestEventId = record.events.at(-1)?.id ?? null;
      section(out, `${session.title ?? "Untitled"}`, { colors, description: session.id });
      field(out, "counts", `${record.events.length} events  ·  ${transcript.summary.turns} turns  ·  revision ${record.session.revision ?? "derived"}`, { colors });
      field(out, "updated", String(session.updatedAt ?? "unknown"), { colors });
      field(out, "last", transcriptPreview(transcript, 72), { colors });
      const projections = Object.entries(record.mappings.projections ?? {}).filter(([, mapping]) => mapping?.nativeSessionId);
      if (projections.length === 0) {
        field(out, "native", "no agent session yet", { colors });
        continue;
      }
      for (const [agentId, mapping] of projections) {
        const current = mapping.lastCanonicalEventId === latestEventId;
        // The cursor is the whole story of a switch: it says how far the
        // agent's own session has been brought, and whether the next launch
        // needs a delta or nothing at all.
        const state = command === "status"
          ? `${current ? colors.success("current") : colors.warning("stale")}  @${mapping.lastCanonicalEventId ?? "none"}`
          : `${current ? colors.success("current") : colors.warning("stale")}`;
        field(out, agentLabel(agentId), `${mapping.nativeSessionId}  ${state}`, { colors });
      }
    }
    return 0;
  }
  if (command === "continue") {
    if (extra.length !== 2 || extra[0] !== "--agent" || !["claude", "codex", "opencode"].includes(extra[1])) {
      throw new Error("Usage: avenic sessions continue <id> --agent <claude|codex|opencode>");
    }
    const agentId = extra[1];
    const state = await loadRuntime(projectRoot);
    if (projectConfig(state).historyMode !== "shared") {
      throw new Error("Shared continuation is disabled for this project. Run: avenic change --history shared");
    }
    if (!effectiveAgentConfig(state, agentId)) {
      throw new Error(`${getAgent(agentId).displayName} is not initialized. Run: avenic ${agentId} init`);
    }
    // The projection, the run and the read-back all have to name one home: the
    // agent's own, resolved from this project's answer — Account · Project's is
    // inside the project, not the machine's.
    const environment = await effectiveAgentEnvironment(projectRoot, agentId);
    if (agentId === "opencode") {
      // OpenCode's history is only reachable through its own CLI, so the
      // projection is created by `opencode import` and continued with
      // `opencode --session`. When that session will not start — most often a
      // message, or a configured model, naming a provider this machine does not
      // have — the shared history is still intact, so continue it the way the
      // other agents do: a fresh official session handed the canonical delta.
      const projection = await projectCanonicalSession(projectRoot, mode, agentId, { environment });
      const status = await dispatchAgent(agentId, ["--session", projection.nativeSessionId], { projectRoot, environment });
      await captureCanonicalSession(projectRoot, mode, agentId, { environment });
      if (status === 0) return 0;
      console.warn(`${getAgent(agentId).displayName} could not be started with the projected session (exit ${status}); continuing in a fresh official session from shared canonical history.`);
      const fallback = await runCanonicalContinuation({ projectRoot, state, environment, mode, agentId, forceBootstrap: true });
      return fallback.launched.status ?? 0;
    }

    const result = await runCanonicalContinuation({ projectRoot, state, environment, mode, agentId });
    return result.launched.status ?? 0;
  }
  if (command === "sync" && argumentsList.length === 1) {
    const state = await loadRuntime(projectRoot);
    const results = [];
    for (const agentId of Object.keys(projectConfig(state).agents)) {
      results.push({ agentId, ...(await importProjectSessions(projectRoot, agentId, { setActive: false })) });
    }
    console.log(`Synced ${results.reduce((total, item) => total + (item.imported ?? 0), 0)} native session(s).`);
    reportSessionDiagnostics(results.flatMap((result) => result.diagnostics ?? []), { missingRoots: true });
    return 0;
  }
  if (command !== "git") {
    throw new Error("Usage: avenic sessions git [on|off|status]");
  }
  if (extra.length > 0 || !["on", "off", "status"].includes(mode)) {
    throw new Error("Usage: avenic sessions git [on|off|status]");
  }
  if (mode === "off") {
    const changed = await setSessionsGitIgnored(projectRoot, true);
    const untracked = await untrackSessions(projectRoot);
    console.log("Session Git sync\n");
    console.log(`Project    ${projectRoot}`);
    console.log("Status     Off");
    console.log(`Git ignore ${changed ? "Updated" : "Unchanged"}`);
    console.log(`Untracked  ${untracked}`);
    return 0;
  }
  if (mode === "on") {
    const changed = await setSessionsGitIgnored(projectRoot, false);
    console.log("Session Git sync\n");
    console.log(`Project    ${projectRoot}`);
    console.log("Status     On");
    console.log(`Git ignore ${changed ? "Updated" : "Unchanged"}`);
    return 0;
  }
  console.log(`Session Git sync: ${(await sessionsGitIgnored(projectRoot)) ? "Off" : "On"}`);
  return 0;
}

async function dispatchSkillsCommand(argumentsList) {
  return dispatchSkills(argumentsList, {
    io: console,
    cwd: process.cwd(),
    environment: process.env,
  });
}

// The interactive surfaces (the project wizard and the Sessions menu) draw on
// whatever terminal the caller hands them, and resolve the project from the
// caller's root. Production passes neither; a test drives the real prompts
// with a fake TTY this way instead of re-implementing them.
function terminalOptions(options) {
  return { prompts: options.prompts, projectRootOverride: options.projectRootOverride, cwd: options.cwd };
}

export async function runCli(options = {}) {
  const argumentsList = options.argumentsList ?? process.argv.slice(2);
  const forcedAgent = options.forcedAgent;
  if (forcedAgent) {
    return dispatchAgent(forcedAgent, argumentsList, { ...terminalOptions(options), projectRoot: options.projectRootOverride });
  }
  const [command, ...remainingArguments] = argumentsList;
  mark("command");
  if (command === "--version" || command === "-v" || command === "version") {
    console.log(`Avenic ${packageVersion}`);
    return 0;
  }
  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return 0;
  }
  if (Object.hasOwn(AGENTS, command)) {
    // 调用方点名的根要一路传到 agent 分支：`avenic <agent>` 在宿主眼里和 init/change
    // 一样是「对这个目录做的事」，丢掉它就会去猜 cwd 的项目。
    return dispatchAgent(command, remainingArguments, { ...terminalOptions(options), projectRoot: options.projectRootOverride });
  }
  if (command === "init") {
    return dispatchProjectSetup(remainingArguments, false, terminalOptions(options));
  }
  if (command === "change") {
    return dispatchProjectSetup(remainingArguments, true, terminalOptions(options));
  }
  if (command === "skills") {
    return dispatchSkillsCommand(remainingArguments);
  }
  if (command === "hub" || command === "catalog") {
    // `catalog` 是弃用别名：继续可用，但警告（与 AGENTHOME_* 环境变量的弃用风格一致）
    if (command === "catalog") console.warn("warning: `avenic catalog` is deprecated; use `avenic hub`");
    return dispatchHub(remainingArguments, {
      io: console,
      cwd: process.cwd(),
      environment: process.env,
    });
  }
  if (command === "sessions") {
    return dispatchSessions(remainingArguments, terminalOptions(options));
  }
  if (command === "update") {
    if (remainingArguments.length > 0) {
      throw new Error("Usage: avenic self-update");
    }
    await updateAvenic(packageRoot);
    return 0;
  }
  if (command === "status") {
    return dispatchStatusCommand(remainingArguments, { io: console, environment: process.env });
  }
  if (command === "doctor") {
    console.warn("warning: `avenic doctor` is deprecated; use `avenic status`");
    return dispatchDoctor();
  }
  // Anything left is either a legacy top-level command (add, install,
  // uninstall, packs, tree, ...) or a Pack id. A bare Pack id is how a Pack is
  // installed and is not an alias of anything; the rest are the older spelling
  // of a Skills verb, so each one names the spelling that replaces it.
  if (LEGACY_SKILLS_VERBS.has(command)) {
    console.warn(`warning: \`avenic ${command}\` is deprecated; use \`avenic skills ${command}\``);
  }
  return dispatchSkills(argumentsList, {
    io: console,
    cwd: process.cwd(),
    environment: process.env,
  });
}
