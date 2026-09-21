// The project-setup wizard, driven by whatever UI the host has.
//
// The questions themselves come from core (`projectWizardSteps`), so the
// extension and `avenic init` ask the same things and write the same
// configuration; this module is the walking — which step is open, what has
// been answered, what Back means — and it holds no `vscode` import at all.
// The command wires it to QuickPicks; a test wires it to a script.
import type { ProjectWizardStep } from "@avenic/core";

/** One answered step, as the host shows it above the active question. */
export interface AnsweredStep {
  title: string;
  summary: string;
}

/** Everything a host needs to draw one step, and nothing else. */
export interface WizardView<D = unknown> {
  step: ProjectWizardStep<D>;
  /** 0-based position of the active step, and how many there are. */
  index: number;
  total: number;
  answered: AnsweredStep[];
  draft: D;
}

/** What a host reports back: an answer, a step back, or a cancelled wizard. */
export type WizardAnswer = { value: unknown } | "back" | "cancel";

export interface WizardHost<D = unknown> {
  ask(view: WizardView<D>): Promise<WizardAnswer>;
}

export interface WizardOutcome<D, R = unknown> {
  /** False when the user cancelled or answered the last step with No. */
  applied: boolean;
  draft: D;
  /**
   * What `commit` returned, or null when it never ran. Handing it back here is
   * what keeps the caller from having to smuggle it out of the callback in a
   * variable it then has to un-narrow.
   */
  result: R | null;
}

// 一条摘要可以是一句话，也可以是 Dashboard 卡片上那一行「标签 值」，或者好几行
// （认证、配置来源、会话各占一行）。终端把每一行画成同一张两列表；QuickPick 只有
// 一行可用，于是按同一顺序连起来 —— 同一份答案，两个宿主说同样的话。
function summaryText(summary: ReturnType<NonNullable<ProjectWizardStep["summary"]>>): string {
  if (!summary) return "";
  const lines = Array.isArray(summary) ? summary : [summary];
  return lines
    .map((line) => (typeof line === "string" ? line : `${line.label} ${line.value}`))
    .filter(Boolean)
    .join(" │ ");
}

function answeredSteps<D>(steps: readonly ProjectWizardStep<D>[], draft: D, upTo: number): AnsweredStep[] {
  const answered: AnsweredStep[] = [];
  const list = steps.slice(0, upTo);
  for (let at = 0; at < list.length; at += 1) {
    const step = list[at];
    // The apply step is the confirmation itself; it has no answer to collapse.
    if (step.apply || typeof step.summary !== "function") continue;
    // Consecutive steps in one group are one answer to the user — one question
    // and its scope fold into one line, joined with " │", exactly as the
    // terminal folds them. The group's title is its first step's (or the name
    // the group itself carries, when a step is only readable as a pair).
    const group = step.group ? list.slice(at).filter((entry) => entry.group === step.group) : [step];
    if (step.group) at += group.length - 1;
    const parts = group.map((entry) => summaryText(entry.summary?.(draft))).filter((summary) => Boolean(summary));
    answered.push({ title: step.groupTitle ?? step.title, summary: parts.join(" │ ") });
  }
  return answered;
}

/**
 * Walk the steps, writing each answer into the draft in memory. Nothing
 * reaches the project until the apply step runs `commit`, so cancelling — at
 * any point, from any step — leaves the project exactly as it was.
 *
 * `stepsFor` is recomputed after every answer: turning an agent on or off
 * changes which questions follow, and a step's id is what makes going back
 * re-open the same question rather than a new one.
 */
export async function runProjectWizard<D, R = unknown>(
  draft: D,
  stepsFor: (draft: D) => ProjectWizardStep<D>[],
  host: WizardHost<D>,
  commit: (draft: D) => Promise<R>,
): Promise<WizardOutcome<D, R>> {
  let steps = stepsFor(draft);
  let index = 0;
  // A step is either being asked (◆) or already past (◇ with a summary). A
  // `note` step is only ever the second: nobody answers "your old
  // configuration is still there", so both directions step over it and it is
  // read where it belongs — among the answered lines. The terminal's wizard
  // walks its steps by this same rule (prompts.mjs).
  const skipNotes = (list: readonly ProjectWizardStep<D>[], at: number, delta: number): number => {
    let position = at;
    while (position >= 0 && position < list.length && list[position]?.kind === "note") position += delta;
    return Math.max(0, Math.min(position, Math.max(0, list.length - 1)));
  };
  while (index < steps.length) {
    const step = steps[index];
    const answer = await host.ask({
      step,
      index,
      total: steps.length,
      answered: answeredSteps(steps, draft, index),
      draft,
    });
    if (answer === "cancel") return { applied: false, draft, result: null };
    if (answer === "back") {
      // The first step has nowhere to go back to; the host hides its Back
      // button, and a stray Back is ignored rather than cancelling.
      if (index > 0) index = skipNotes(steps, index - 1, -1);
      continue;
    }
    if (step.apply) {
      if (answer.value !== true) return { applied: false, draft, result: null };
      return { applied: true, draft, result: await commit(draft) };
    }
    if (step.kind === "multi") {
      const values = answer.value as string[];
      // An empty selection is a prompt, not an answer — the host keeps the
      // frame open, so this only guards a host that answered anyway.
      if (values.length < (step.minSelected ?? 0)) continue;
      step.write?.(draft, values);
    } else if (step.kind === "text") {
      // A free-text answer is required to say something (the same rule the
      // terminal applies): an empty endpoint or model is not a configuration.
      // A step marked `optional` is the exception — the credential is never
      // filled in for the reader, so an empty field there means "keep the one
      // that is already written", and refusing it would trap the user on a
      // question they cannot answer.
      const value = String(answer.value ?? "").trim();
      if (value.length === 0 && step.optional !== true) continue;
      step.write?.(draft, value);
    } else {
      step.write?.(draft, answer.value);
    }
    steps = stepsFor(draft);
    // The answer may have removed the steps that followed (a deselected agent);
    // land on the step after the one just answered, by id. The answered step
    // itself can be the one that is gone — only a Remove gives birth to
    // `switch-confirm`, and answering No there is what takes it away again — and
    // not finding it means "it and everything after it are no longer questions",
    // so the landing is where it just was (everything before it is unchanged),
    // not the first question, which would ask the whole wizard over.
    const position = steps.findIndex((candidate) => candidate.id === step.id);
    const landed = position === -1 ? index : Math.min(position + 1, Math.max(0, steps.length - 1));
    index = skipNotes(steps, landed, 1);
  }
  return { applied: false, draft, result: null };
}
