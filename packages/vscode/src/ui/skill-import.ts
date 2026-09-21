import type { Scope, SkillImport } from "../services/skills.ts";

// 面板上「Import Skill」按下去之后的那场问答，与 CLI 的 Add 流程一字不差地同一场：
// 来源 → 发现 → 多选 Skill → Install to → Scope → 摘要 → 确认 → 装。业务只有 core
// 那一份实现，这里负责的是顺序与提问——每一步问什么、少答一步会怎样、以及把用户答的
// 那几个名字和几个目标原样交给 core。
//
// 宿主的两件事都是注入的：提示（ImportUi）与落盘（SkillImport）。所以这一层不 import
// vscode，整场问答可以在测试里被驱动，包括每一步的取消。

/** 一个候选项：`value` 是提交给 core 的那个身份，label/description 只是它对人说的话。 */
export interface ImportChoice<T> {
  label: string;
  description?: string;
  picked?: boolean;
  value: T;
}

/** 确认之前摆出来的那一页：写什么、写去哪、写在哪个作用域、落在哪个配置文件。 */
export interface ImportSummary {
  source: string;
  skills: string;
  targets: string;
  scope: string;
  config: string;
}

export interface ImportUi {
  askSource(): Promise<string | undefined>;
  pickMany<T>(title: string, items: ImportChoice<T>[]): Promise<T[] | undefined>;
  pickOne<T>(title: string, items: ImportChoice<T>[]): Promise<T | undefined>;
  confirm(title: string, summary: ImportSummary): Promise<boolean | undefined>;
  info(message: string): void;
  warn(message: string): void;
  /** 长活（克隆、安装）走宿主自己的进度与串行队列；report 是进度里那行字。 */
  progress<T>(title: string, work: (report: (message: string) => void) => Promise<T>): Promise<T>;
}

export type ImportOutcome =
  | { kind: "cancelled" }
  | { kind: "installed"; repo: string; names: string[]; scope: Scope; label: string; configFile: string }
  | { kind: "alreadyInstalled"; repo: string; names: string[]; sourceId: string };

const CANCELLED: ImportOutcome = { kind: "cancelled" };
const SUMMARY_NAME_LIMIT = 6;

function skillCount(count: number): string {
  return `${count} Skill${count === 1 ? "" : "s"}`;
}

/** 摘要行里的名字：多了就截断，摘要不该长成一份清单（与 CLI 同一个上限）。 */
function summarizeNames(names: string[]): string {
  const shown = names.slice(0, SUMMARY_NAME_LIMIT).join(", ");
  return names.length > SUMMARY_NAME_LIMIT ? `${shown}, +${names.length - SUMMARY_NAME_LIMIT} more` : shown;
}

export async function importSkillsFlow(service: SkillImport, ui: ImportUi): Promise<ImportOutcome> {
  // 发现先在项目作用域里做：按钮长在这个项目的面板上，多选里的「已受管」提示也是
  // 这个作用域的事实。改主意选了 Global 时，core 会在那个作用域里再落一份。
  const entered = await ui.askSource();
  const repo = (entered ?? "").trim();
  if (repo === "") return CANCELLED;

  const discovery = await ui.progress("Avenic · Reading the repository", (report) => {
    report(`Cloning ${repo}…`);
    return service.discover(repo, "project");
  });
  if (discovery.names.length === 0) {
    ui.warn("No Skills found in that repository");
    return CANCELLED;
  }
  ui.info(`Found ${discovery.names.length} skill${discovery.names.length === 1 ? "" : "s"}`);

  const managed = new Set(await service.managed("project"));
  const names = await ui.pickMany("Select Skills", discovery.names.map((name) => ({
    label: name,
    ...(managed.has(name) ? { description: "already managed in this scope" } : {}),
    value: name,
  })));
  if (names === undefined || names.length === 0) return CANCELLED;

  // Scope 是在 Install to 之后才问的（与 CLI 同序），所以两个作用域的事实先各取一份：
  // 目标清单用当前这一个，摘要用选中的那一个。
  const [here, away] = await Promise.all([service.facts("project"), service.facts("global")]);
  const targets = await ui.pickMany("Install to", here.targets.map((target) => ({
    label: target.label,
    description: `${target.path} · ${target.canonical ? "always installed" : "shared link"}`,
    picked: true,
    value: target.id,
  })));
  if (targets === undefined || targets.length === 0) return CANCELLED;

  const scope = await ui.pickOne("Scope", [here, away].map((facts, index) => ({
    label: facts.label,
    description: facts.root,
    picked: index === 0,
    value: facts.scope,
  })));
  if (scope === undefined) return CANCELLED;
  const facts = scope === "global" ? away : here;

  // 技能真身只写在 canonical 目标里（Claude Code 读的是它的链接），core 也总是写它们，
  // 所以那一行取消勾选并不会让它消失——勾选框表达不了这件事，摘要与落链目标就说清楚
  // 这一次真的写到哪几个目标。
  const chosen = [...new Set([...targets, ...facts.targets.filter((target) => target.canonical).map((target) => target.id)])];
  const labels = facts.targets.filter((target) => chosen.includes(target.id)).map((target) => target.label);

  const yes = await ui.confirm(`Install ${skillCount(names.length)}?`, {
    source: `${repo} @ ${discovery.revision.slice(0, 8)}`,
    skills: `${names.length} · ${summarizeNames(names)}`,
    targets: labels.join(", "),
    scope: facts.label,
    config: facts.configFile,
  });
  if (yes !== true) return CANCELLED;

  const result = await ui.progress(`Avenic · Installing ${skillCount(names.length)}`, (report) => {
    report("Installing…");
    return service.install(repo, names, scope, chosen);
  });
  if (result.alreadyInstalled === true) {
    ui.info(`Already installed: ${result.sourceId} (${skillCount(result.names.length)})`);
    return { kind: "alreadyInstalled", repo, names: result.names, sourceId: result.sourceId };
  }
  ui.info(`${skillCount(result.names.length)} installed · ${facts.label} · ${facts.configFile}`);
  return { kind: "installed", repo, names: result.names, scope, label: facts.label, configFile: facts.configFile };
}
