import * as vscode from "vscode";
import { sentence } from "../i18n/text.ts";
import type { WizardAnswer, WizardHost, WizardView } from "./project-wizard.ts";

// 渐进式 QuickPick：疑问句在标题栏，已答步骤折叠成顶部的一行 ◇（同一组的连续步骤折成
// 一行，与终端一致），当前步骤是唯一展开的问题。同一个 picker 实例贯穿整轮 —— 每步各建
// 一个会闪，返回箭头也会跟着重建。自由文本步骤用同一个 picker 的输入行，凭据用编辑器
// 自己的密码框：QuickPick 没有掩码，把 API key 打进一张列表就是把它摆在了屏幕上。
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
  const detach = () => {
    for (const listener of listeners) listener.dispose();
    listeners = [];
  };
  return {
    dispose() {
      detach();
      picker?.dispose();
      picker = undefined;
    },
    async ask(view) {
      detach();
      // 掩码字段（API 凭据）走编辑器的密码框：它不回声、不进历史，也不画成列表项。
      // 这一问因此看不到上面的 ◇ 轨道——代价是明确的，而把密钥显示在 picker 里不是。
      if (view.step.kind === "text" && view.step.mask) {
        picker?.hide();
        const entered = await vscode.window.showInputBox({
          title: view.step.title,
          prompt: view.step.description ?? "",
          placeHolder: view.step.placeholder ?? "",
          password: true,
          ignoreFocusOut: true,
          value: String(view.step.value?.(view.draft) ?? ""),
        });
        return entered === undefined ? "cancel" : { value: entered };
      }
      picker ??= vscode.window.createQuickPick<WizardItem>();
      const heading = `${view.step.title} · ${view.index + 1}/${view.total}`;
      picker.title = heading;
      picker.placeholder = view.step.description ?? "";
      setMultiSelect(picker, view.step.kind === "multi");
      // 点开别的窗口不该把整轮配置丢掉：退出只走 esc 与返回箭头（与 CLI 一致）。
      picker.ignoreFocusOut = true;

      const input = view.step.kind === "text";
      const current: unknown[] = view.step.kind === "multi" ? (view.step.values?.(view.draft) ?? []) : [view.step.value?.(view.draft)];
      const items: WizardItem[] = (view.step.options ?? []).map((option) => ({ label: option.label, value: option.value }));
      // 分隔行不可选中，所以已答摘要既不会被误选，也不占键盘移动的位置。
      const trail: WizardItem[] = view.answered.map((answered) => ({
        label: `◇ ${answered.title}${answered.summary ? ` — ${answered.summary}` : ""}`,
        kind: vscode.QuickPickItemKind.Separator,
      }));
      // 文本步骤的“选项”就是输入行本身：留下轨道当上下文，不画任何可选项。
      picker.items = input
        ? trail
        : trail.length === 0 ? items : [...trail, { label: "", kind: vscode.QuickPickItemKind.Separator }, ...items];
      picker.value = input ? String(current[0] ?? "") : "";

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
          if (input) {
            settle({ value: picker!.value });
            return;
          }
          const selected = picker!.selectedItems;
          if (view.step.kind === "multi") {
            if (selected.length < (view.step.minSelected ?? 0)) {
              // 空选择不是答案：留着面板，把要求写回标题（回车因此是 no-op）。
              // validationMessage 在 1.136 的 QuickPick 上已经不存在，标题是两代都在的出口。
              picker!.title = view.step.emptyMessage ?? sentence(vscode.env.language, "wizard.pick-at-least-one");
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
        else if (!input) {
          const active = items.find((item) => item.value === current[0]);
          if (active !== undefined) picker!.activeItems = [active];
        }
      });
    },
  };
}
