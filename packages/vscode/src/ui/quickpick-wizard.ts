import * as vscode from "vscode";
import type { WizardAnswer, WizardHost, WizardView } from "./project-wizard.ts";

// 渐进式 QuickPick：疑问句在标题栏，已答步骤折叠成顶部的一行 ◇，当前步骤是唯一展开的问题。
// 同一个 picker 实例贯穿整轮 —— 每步各建一个会闪，返回箭头也会跟着重建。
interface WizardItem extends vscode.QuickPickItem {
  value?: unknown;
}

export interface QuickPickWizard<D = unknown> extends WizardHost<D> {
  dispose(): void;
}

// 多选开关在 @types/vscode 1.136 里由 canPickMany 改名为 canSelectMany，而本扩展的
// engines 下限仍是 1.90 —— 两个名字都写，运行时哪个存在哪个生效（写一个不存在的属性
// 对宿主对象没有别的副作用）。只写新名字，1.90 上的多选会静默降级成单选。
function setMultiSelect(picker: vscode.QuickPick<WizardItem>, enabled: boolean): void {
  const multi = picker as unknown as { canPickMany?: boolean; canSelectMany?: boolean };
  multi.canPickMany = enabled;
  multi.canSelectMany = enabled;
}

// D 只出现在类型上：画法不取决于草稿长什么样，调用方按自己那份草稿要类型。
export function quickPickHost<D = unknown>(): QuickPickWizard<D> {
  let picker: vscode.QuickPick<WizardItem> | undefined;
  let listeners: vscode.Disposable[] = [];
  return {
    dispose() {
      for (const listener of listeners) listener.dispose();
      listeners = [];
      picker?.dispose();
      picker = undefined;
    },
    ask(view) {
      for (const listener of listeners) listener.dispose();
      listeners = [];
      picker ??= vscode.window.createQuickPick<WizardItem>();
      const heading = `${view.step.title} · ${view.index + 1}/${view.total}`;
      picker.title = heading;
      picker.placeholder = view.step.description ?? "";
      setMultiSelect(picker, view.step.kind === "multi");
      // 点开别的窗口不该把整轮配置丢掉：退出只走 esc 与返回箭头（与 CLI 一致）。
      picker.ignoreFocusOut = true;

      const current: unknown[] = view.step.kind === "multi" ? (view.step.values?.(view.draft) ?? []) : [view.step.value?.(view.draft)];
      const items: WizardItem[] = view.step.options.map((option) => ({ label: option.label, value: option.value }));
      picker.items = view.answered.length === 0 ? items : [
        // 分隔行不可选中，所以已答摘要既不会被误选，也不占键盘移动的位置。
        ...view.answered.map((answered) => ({ label: `◇ ${answered.title} — ${answered.summary}`, kind: vscode.QuickPickItemKind.Separator })),
        { label: "", kind: vscode.QuickPickItemKind.Separator },
        ...items,
      ];

      return new Promise<WizardAnswer>((resolve) => {
        let settled = false;
        const settle = (answer: WizardAnswer) => {
          if (settled) return;
          settled = true;
          resolve(answer);
        };
        // 第一步没有可退回的地方：不挂返回箭头，而不是挂着再做空操作。
        picker!.buttons = view.index > 0 ? [vscode.QuickInputButtons.Back] : [];
        listeners.push(picker!.onDidTriggerButton((button) => {
          if (button === vscode.QuickInputButtons.Back) settle("back");
        }));
        listeners.push(picker!.onDidChangeSelection(() => { picker!.title = heading; }));
        listeners.push(picker!.onDidAccept(() => {
          const selected = picker!.selectedItems;
          if (view.step.kind === "multi") {
            if (selected.length < (view.step.minSelected ?? 0)) {
              // 空选择不是答案：留着面板，把要求写回标题（回车因此是 no-op）。
              // validationMessage 在 1.136 的 QuickPick 上已经不存在，标题是两代都在的出口。
              picker!.title = view.step.emptyMessage ?? "请至少选择一项";
              return;
            }
            settle({ value: selected.map((item) => item.value) });
            return;
          }
          const item = selected[0] ?? picker!.activeItems[0];
          if (item === undefined) return;
          settle({ value: item.value });
        }));
        listeners.push(picker!.onDidHide(() => settle("cancel")));
        picker!.show();
        // 预选必须写在 show() 之后：createQuickPick 不认 item.picked，只认 selectedItems；
        // activeItems 同理——当前值就是默认高亮的那一项。
        if (view.step.kind === "multi") picker!.selectedItems = items.filter((item) => current.includes(item.value));
        else {
          const active = items.find((item) => item.value === current[0]);
          if (active !== undefined) picker!.activeItems = [active];
        }
      });
    },
  };
}
