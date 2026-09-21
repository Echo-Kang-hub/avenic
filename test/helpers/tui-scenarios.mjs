// The terminal surfaces, rendered once each through the production code, so a
// change to the brand or the frame layer shows up as a diff in
// test/fixtures/tui/*.ansi instead of as a surprise in a user's terminal.
//
// Colour is pinned to TrueColor here (COLORTERM=truecolor), so a golden is
// about the composition — which mark, which rail, which token — and never
// about the terminal the capture happened to run in. `normalize()` writes the
// ANSI as named tokens, which is what makes the fixtures readable and stable.
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fullLogo, compactBrand, paletteFor } from "../../packages/cli/src/cli/brand.mjs";
import {
  cancel, error, field, intro, note, outro, progress, section, success, table, warning,
} from "../../packages/cli/src/cli/prompts.mjs";
import { FakeTTY, fakeStdout, keys } from "./fake-tty.mjs";

const TRUECOLOR = { COLORTERM: "truecolor" };
const ANSI = /\x1b\[[0-9;]*m/g;

/** Raw bytes → a fixture a human can read: colours become {brand}, {muted}, …. */
export function normalize(text) {
  return String(text)
    .replace(/\x1b\[s/g, "{save}")
    .replace(/\x1b\[u\x1b\[J/g, "{repaint}")
    .replace(/\x1b\[38;2;255;122;24m/g, "{brand}")
    .replace(/\x1b\[38;2;255;77;46m/g, "{brandStrong}")
    .replace(/\x1b\[38;2;255;158;94m/g, "{brandSoft}")
    .replace(/\x1b\[1;38;2;255;122;24m/g, "{brandBold}")
    .replace(/\x1b\[32m/g, "{success}")
    .replace(/\x1b\[33m/g, "{warning}")
    .replace(/\x1b\[31m/g, "{error}")
    .replace(/\x1b\[2m/g, "{muted}")
    .replace(/\x1b\[1m/g, "{strong}")
    .replace(/\x1b\[0m/g, "{/}")
    // A timestamp is local time, so it would pin the golden to one machine's
    // timezone. Its shape is what the fixture is for; its spelling is not.
    .replace(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?Z?/g, "{time}")
    .replace(/\r/g, "");
}

function fixtureStatus() {
  return {
    project: { name: "agenthome-cli", root: "D:\\FileDownload\\Projects\\agenthome-cli", agents: ["claude", "codex"] },
    history: {
      mode: "shared",
      sessions: 24,
      active: "claude-bee6f9b7-0000-0000-0000-000000000000",
      activeTitle: "claude bee6f9b7",
      activeEvents: 5939,
      updatedAt: "2026-09-19T09:51:00.000Z",
    },
    // One golden, all three answers: an API configuration that names the file
    // the launch reads and what the user put in it, an account whose sign-in
    // lives in the project and has not happened yet, and an agent whose
    // authentication is its own business.
    agents: [
      {
        id: "claude", displayName: "Claude Code", command: "claude", available: true, initialized: true, runtime: null,
        auth: {
          method: "api", scope: "project", source: "project", home: null, status: null,
          configuration: {
            relative: ".claude/settings.local.json", file: "", exists: true, valid: true, configured: true,
            owned: true, unchanged: false, provider: "DeepSeek", baseUrl: "https://api.deepseek.invalid/anthropic",
            model: "deepseek-chat", credentialSet: true, settings: null,
          },
        },
        sessions: "project", history: { sessions: 10, sync: "current" },
      },
      {
        id: "codex", displayName: "Codex", command: "codex", available: true, initialized: true, runtime: null,
        auth: { method: "account", scope: "project", source: "local", home: ".agents/local/codex", status: "not-signed-in", configuration: null },
        sessions: "project", history: { sessions: 10, sync: "stale" },
      },
      { id: "opencode", displayName: "OpenCode", command: "opencode", available: true, initialized: false, runtime: "native", auth: null, sessions: null, history: { sessions: 0, sync: "none" } },
    ],
    skills: {
      project: { installed: 15, packs: [{ name: "optimized" }], state: "current", total: 15 },
      global: { installed: 0, packs: [], state: "none" },
      hub: { name: "Echo-Kang-hub/SkillsHub", cache: "current", revision: "9122e3a4b5c6d7e8f90a1b2c3d4e5f60718293a4", pinned: "9122e3a4b5c6d7e8f90a1b2c3d4e5f60718293a4" },
    },
  };
}

async function renderStatusPage(columns) {
  const { renderStatus } = await import("../../packages/cli/src/cli/status-cli.mjs");
  const lines = [];
  const stdout = fakeStdout({ columns });
  renderStatus(fixtureStatus(), { log: (line) => lines.push(line) }, { stdout, environment: TRUECOLOR });
  return `${lines.join("\n")}\n`;
}

/** Drive a prompt for real, then hand back every byte it painted. */
async function paintPrompt(factory, drive) {
  const stdin = new FakeTTY();
  const stdout = fakeStdout({ columns: 100 });
  const promise = factory(stdin, stdout);
  drive(keys.bind(null, stdin));
  // Esc closes whatever is still open; a settled prompt ignores it.
  stdin.write("\x1b");
  await promise.catch(() => {});
  return stdout.text();
}

const agents = [
  { value: "claude", label: "Claude Code", hint: "~/.claude · shared link" },
  { value: "codex", label: "Codex", hint: "~/.codex · shared link" },
  { value: "opencode", label: "OpenCode", hint: "~/.local/share/opencode" },
];

const packs = [
  { value: "common", label: "Common", hint: "3 Skills" },
  { value: "development", label: "Development", hint: "5 Skills" },
  { value: "research", label: "Research", hint: "4 Skills" },
];

export const SCENARIOS = {
  async "logo-truecolor"() {
    const stdout = fakeStdout({ columns: 100 });
    await fullLogo(stdout, { color: true, environment: TRUECOLOR });
    return stdout.text();
  },

  async "logo-nocolor"() {
    const stdout = fakeStdout({ columns: 100 });
    await fullLogo(stdout, { environment: { NO_COLOR: "1" } });
    return stdout.text();
  },

  async "logo-narrow"() {
    const stdout = fakeStdout({ columns: 40 });
    await fullLogo(stdout, { color: true, environment: TRUECOLOR });
    return stdout.text();
  },

  async "compact-status"() {
    const stdout = fakeStdout({ columns: 80 });
    compactBrand(stdout, { color: true, environment: TRUECOLOR, title: "Status", description: "D:\\FileDownload\\Projects\\agenthome-cli" });
    return stdout.text();
  },

  async "wizard-select-agents"() {
    const { multiSelect } = await import("../../packages/cli/src/cli/prompts.mjs");
    return paintPrompt(
      (stdin, stdout) => multiSelect({ stdin, stdout, color: true, environment: TRUECOLOR, title: "Select agents", options: agents, initial: ["claude"], minSelected: 1 }),
      (press) => press("\x1b[B"),
    );
  },

  async "wizard-select-enabled-agents"() {
    const { multiSelect } = await import("../../packages/cli/src/cli/prompts.mjs");
    return paintPrompt(
      (stdin, stdout) => multiSelect({ stdin, stdout, color: true, environment: TRUECOLOR, title: "Select enabled agents", options: agents, initial: ["claude", "codex"], minSelected: 1 }),
      (press) => press("\x1b[B", " "),
    );
  },

  // 向导的文本步骤：已答的步骤折叠成轨道，当前这一问是唯一展开的帧。这个帧曾经
  // 画两层帧头和两层帧尾（文本模型自带一套，画帧的人又加一套）——金样本让形状
  // 固定下来，谁再画第二遍就是一次 diff。
  async "wizard-text-step"() {
    const { wizard } = await import("../../packages/cli/src/cli/prompts.mjs");
    const { projectDraft, projectWizardSteps } = await import("../../packages/core/src/runtime/project-wizard.mjs");
    return paintPrompt(
      (stdin, stdout) => wizard({
        stdin,
        stdout,
        color: true,
        environment: TRUECOLOR,
        draft: projectDraft({
          agents: { claude: { authMethod: "api", configScope: "project", sessionScope: "project" } },
          historyMode: "shared",
        }),
        stepsFor: (draft) => projectWizardSteps(draft, false),
        apply: async () => ({}),
      }),
      // agents → authentication → API configuration → provider（文本）
      (press) => press("\r", "\r", "\r"),
    );
  },

  async "sessions-menu"() {
    const { singleSelect } = await import("../../packages/cli/src/cli/prompts.mjs");
    return paintPrompt(
      (stdin, stdout) => singleSelect({
        stdin,
        stdout,
        color: true,
        environment: TRUECOLOR,
        title: "Sessions (shared)",
        options: [
          { value: "continue", label: "Continue shared session", hint: "claude bee6f9b7 · 5939 events" },
          { value: "list", label: "List sessions", hint: "24 sessions" },
          { value: "import", label: "Import histories", hint: "from the agents' own stores" },
          { value: "active", label: "Set active session", hint: "what a new launch joins" },
          { value: "status", label: "Status", hint: "the same page as `avenic status`" },
        ],
      }),
      (press) => press("\x1b[B", "\x1b[B"),
    );
  },

  async "skills-menu"() {
    const { singleSelect } = await import("../../packages/cli/src/cli/prompts.mjs");
    return paintPrompt(
      (stdin, stdout) => singleSelect({
        stdin,
        stdout,
        color: true,
        environment: TRUECOLOR,
        title: "Skills",
        description: "Add, update, or remove Skills in the project scope",
        options: [
          { value: "add", label: "Add skills", hint: "SkillsHub Packs or a Git repository" },
          { value: "installed", label: "Installed skills", hint: "what this scope holds now" },
          { value: "update", label: "Update skills", hint: "re-install from the latest Hub revision" },
          { value: "remove", label: "Remove skills", hint: "Packs, direct Skills, or everything" },
          { value: "sync", label: "Sync SkillsHub", hint: "fetch the Hub with your git credentials" },
          { value: "import", label: "Import from repository", hint: "clone, then pick Skills" },
        ],
      }),
      (press) => press("\x1b[B"),
    );
  },

  async "multi-select-two"() {
    const { multiSelect } = await import("../../packages/cli/src/cli/prompts.mjs");
    return paintPrompt(
      (stdin, stdout) => multiSelect({ stdin, stdout, color: true, environment: TRUECOLOR, searchable: true, title: "Select Packs", options: packs, initial: ["common"] }),
      (press) => press("\x1b[B", " "),
    );
  },

  async "search-active"() {
    const { multiSelect } = await import("../../packages/cli/src/cli/prompts.mjs");
    return paintPrompt(
      (stdin, stdout) => multiSelect({
        stdin,
        stdout,
        color: true,
        environment: TRUECOLOR,
        searchable: true,
        title: "Select Skills",
        options: [
          { value: "alpha", label: "Alpha", hint: "tools" },
          { value: "beta", label: "Beta", hint: "docs" },
          { value: "gamma", label: "Gamma", hint: "tools" },
        ],
      }),
      (press) => press("g", "a"),
    );
  },

  async "multi-select-empty-enter"() {
    const { multiSelect } = await import("../../packages/cli/src/cli/prompts.mjs");
    return paintPrompt(
      (stdin, stdout) => multiSelect({ stdin, stdout, color: true, environment: TRUECOLOR, title: "Select agents", options: agents, minSelected: 1, emptyMessage: "Select at least one agent" }),
      (press) => press("\r"),
    );
  },

  async "settle-summary"() {
    const { multiSelect } = await import("../../packages/cli/src/cli/prompts.mjs");
    const stdin = new FakeTTY();
    const stdout = fakeStdout({ columns: 100 });
    const promise = multiSelect({ stdin, stdout, color: true, environment: TRUECOLOR, title: "Select Packs", options: packs, initial: ["common"] });
    keys(stdin, "\x1b[B", " ", "\r");
    await promise;
    return stdout.text();
  },

  async "cancel-line"() {
    const { singleSelect } = await import("../../packages/cli/src/cli/prompts.mjs");
    const stdin = new FakeTTY();
    const stdout = fakeStdout({ columns: 100 });
    const promise = singleSelect({ stdin, stdout, color: true, environment: TRUECOLOR, title: "Set active session", options: packs, cancelLabel: "Nothing changed" });
    keys(stdin, "\x1b");
    await promise;
    return stdout.text();
  },

  async "narrow-frame"() {
    const { multiSelect } = await import("../../packages/cli/src/cli/prompts.mjs");
    const stdin = new FakeTTY();
    const stdout = fakeStdout({ columns: 40 });
    const promise = multiSelect({
      stdin,
      stdout,
      color: true,
      environment: TRUECOLOR,
      title: "Install to",
      options: [
        { value: "agents", label: "Codex / OpenCode / universal agents", hint: ".agents/skills · always installed" },
        { value: "claude", label: "Claude Code with a very long label that will not fit", hint: "~/.claude/skills · shared link" },
      ],
      initial: ["agents"],
    });
    keys(stdin, "\r");
    await promise;
    return stdout.text();
  },

  async "status-page"() {
    return renderStatusPage(100);
  },

  async "status-page-plain"() {
    const { renderStatus } = await import("../../packages/cli/src/cli/status-cli.mjs");
    const lines = [];
    renderStatus(fixtureStatus(), { log: (line) => lines.push(line) }, { stdout: fakeStdout({ columns: 100, isTTY: false }), environment: { NO_COLOR: "1" } });
    return `${lines.join("\n")}\n`;
  },

  async "progress-and-lines"() {
    const stdout = fakeStdout({ columns: 100 });
    const paint = { stdout, color: true, environment: TRUECOLOR };
    const spin = progress({ ...paint, text: "Installing 3 Skills…" });
    spin.stop("Installed 3 Skills");
    const failed = progress(paint);
    failed.fail("the Hub could not be reached");
    const colors = paletteFor(true, TRUECOLOR);
    success(stdout, "Done! Installed 2 Packs", { colors });
    warning(stdout, "2 records could not be read", { colors });
    error(stdout, "boom", { colors });
    outro(stdout, "All good", { colors });
    return stdout.text();
  },

  async "result-page"() {
    const stdout = fakeStdout({ columns: 100 });
    const colors = paletteFor(true, TRUECOLOR);
    intro(stdout, "Install Skills", { colors, description: "from the SkillsHub" });
    section(stdout, "Ready to install", { colors });
    field(stdout, "Skills", "3 · alpha, beta, gamma", { colors });
    field(stdout, "Scope", "Project", { colors });
    note(stdout, "Hub revision 9122e3a is cached", { colors });
    note(stdout, "12 records could not be read", { colors, mark: "!" });
    table(stdout, ["Pack", "Skills"], [["Common", "1"], ["Development", "3"]], { colors });
    cancel(stdout, "Nothing installed", { colors });
    return stdout.text();
  },
};

/** Render every scenario into a map of name → normalized fixture text. */
export async function renderAll(filters = []) {
  const out = new Map();
  for (const [name, render] of Object.entries(SCENARIOS)) {
    if (filters.length > 0 && !filters.some((filter) => name.includes(filter))) continue;
    out.set(name, normalize(await render()));
  }
  return out;
}

/** A scratch project for scenarios that need one (none today, kept for growth). */
export async function withScratchProject(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-tui-visual-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
