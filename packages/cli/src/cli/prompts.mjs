// clack 风格交互层（自实现，零运行时依赖）：◆ ◇ ● ○ ▸ │ ─ ✓ ✖ ╭╮╰╯ 的
// 终端提示词。参考 npx skills 的交互风格：多选 space toggle、Yes/No 确认、
// 摘要框、Done 关闭行，但保持 Avenic 自己的 catalog/pack 结构（skills 与
// agent 无关，天然可共用 —— 不做 agent 选择步骤）。
//
// 渲染：所有帧写入 stdout（终端），原始模式 + 光标保存/恢复逐键重绘 ——
// Windows 终端对相对 moveCursor 的重绘处理不一致（旧实现帧堆叠），每次重绘
// 都从「帧首光标保存点」恢复并清屏后重画（与旧 promptCatalogChoice 同策略）。
//
// 可注入 { stdin, stdout }（单测用假 TTY 流）；非 TTY 时调用方自行回退到
// 纯文本路径，本模块只在 isInteractive() 成立时渲染。每个提示返回
// Promise<value | null>（null = Esc/Ctrl+C 取消）。

import readline from "node:readline";

export function isInteractive({ stdin = process.stdin, stdout = process.stdout } = {}) {
  return stdin.isTTY === true && stdout.isTTY === true;
}

// ---- 基础输出 ----

export function banner(stdout = process.stdout) {
  stdout.write("\n  _   ___   _______ _   _______\n / | / / | / / ____/ | / /  _/\n/  |/ /  |/ / /   /  |/ // /  \n/ /|  / /|  / /___/ /|  // /   \n/_/ |_/_/ |_/_____/_/ |_/___/  AVENIC\n\n");
}

/** ◆ 标题行（帧内首个提示的顶部行；clack intro 同款）。 */
export function intro(stdout, title) {
  stdout.write(`◆  ${title}\n`);
}

/** 收尾线。调用点自带语义文本，如 Done! 2 Packs installed。 */
export function outro(stdout, text) {
  stdout.write(`✓  ${text}\n`);
}

/** 取消线：Esc 或 Ctrl+C 后由调用方打印（然后通常输出 "No change." 之类）。 */
export function cancel(stdout, text = "Cancelled") {
  stdout.write(`✖  ${text}\n`);
}

// ---- 帧重绘机制 ----
// 每次重绘：\x1b[u 回到帧首（帧开始前写入 \x1b[s 记住位置）→ \x1b[J 到屏底 →
// 写整个新帧。raw 模式在帧会话期间开启，结束/取消时恢复并暂停 stdin。

const keypressAttached = new WeakSet();

function startFrame(stdin, stdout, paint) {
  stdin.setRawMode?.(true);
  if (!keypressAttached.has(stdin)) {
    readline.emitKeypressEvents(stdin);
    keypressAttached.add(stdin);
  }
  stdin.resume?.();
  stdout.write("\x1b[s");
  const refresh = () => {
    stdout.write(`\x1b[u\x1b[J${paint().join("\n")}`);
  };
  refresh();
  const close = () => {
    stdin.setRawMode?.(false);
    stdin.pause?.();
  };
  return { refresh, close };
}

function frameSeparator() {
  return `│  ${"─".repeat(14)}`;
}

/** 落定帧：◇ 标题行 + 兼容帧结束（取消时直接回取消行）。 */
function settleFrame(stdout, title, extraLines) {
  stdout.write(`\x1b[u\x1b[J${extraLines.length === 0 ? `◇  ${title}\n` : [`◇  ${title}`, ...extraLines, ""].join("\n")}`);
}

/** 单选项选择（catalog select / 手动流中的任一单选）。 */
export function select(options = {}) {
  const { stdin = process.stdin, stdout = process.stdout } = options;
  const entries = options.options; // [{ value, label }]
  const title = options.title;
  const initial = options.initial ?? 0;
  const cancelLabel = options.cancelLabel ?? "cancel";
  const footer = options.footer ?? "↑↓ move · enter select · esc cancel";
  return new Promise((resolve) => {
    const count = entries.length;
    const cursorRow = count; // cancel 行在 entries 之后
    let cursor = Math.max(0, Math.min(initial, cursorRow));
    const optionRows = (mark) => {
      const rows = [];
      for (let index = 0; index < count; index += 1) {
        rows.push(`│  ${mark(index, cursorRow)}  ${entries[index].label}`);
      }
      return rows;
    };
    const paint = () => {
      const rows = [`◇  ${title}`];
      for (let index = 0; index < count; index += 1) {
        rows.push(`│  ${index === cursor ? "●" : "○"}  ${entries[index].label}`);
      }
      rows.push(frameSeparator());
      rows.push(`│  ${cursor === cursorRow ? "●" : "○"}  ${cancelLabel}`);
      rows.push(frameSeparator());
      rows.push(footer);
      return rows;
    };
    const session = startFrame(stdin, stdout, paint);
    const finish = (pickedIndex) => {
      session.close();
      stdin.removeAllListeners("keypress");
      if (pickedIndex === null) {
        settleFrame(stdout, title, []);
        stdout.write(`✖  ${cancelLabel}\n`);
        resolve(null);
        return;
      }
      settleFrame(stdout, title, [...optionRows((index) => (index === pickedIndex ? "●" : "○")), "◇  " + entries[pickedIndex].label]);
      resolve(entries[pickedIndex].value);
    };
    stdin.on("keypress", (value, key) => {
      if (key.ctrl && key.name === "c") {
        finish(null);
        return;
      }
      if (key.name === "up" || key.name === "k") {
        cursor = (cursor - 1 + count + 1) % (count + 1);
        session.refresh();
      } else if (key.name === "down" || key.name === "j") {
        cursor = (cursor + 1) % (count + 1);
        session.refresh();
      } else if (key.name === "return" || key.name === "enter") {
        finish(cursor >= count ? null : cursor);
      } else if (key.name === "escape") {
        finish(null);
      }
    });
  });
}

/** 多选项选择（space 逐项切换，a 全选，n 清空）。返回选中值数组或 null。 */
export function multiselect(options = {}) {
  const { stdin = process.stdin, stdout = process.stdout } = options;
  const entries = options.options; // [{ value, label }]
  const title = options.title;
  const checked = new Set(options.initial ?? []);
  const minSelected = Math.max(0, options.minSelected ?? 0);
  const emptyMessage = options.emptyMessage ?? "Select at least one item";
  const cancelLabel = options.cancelLabel ?? "cancel";
  const footer = options.footer ?? "↑↓ move · space toggle · a all · n none · enter confirm · esc cancel";
  return new Promise((resolve) => {
    const count = entries.length;
    const cursorRow = count;
    let cursor = 0;
    let validationMessage = "";
    const titleLine = () =>
      checked.size > 0 ? `◇  ${title} (${checked.size} checked)` : `◇  ${title}`;
    const optionRows = () => {
      const rows = [];
      for (let index = 0; index < count; index += 1) {
        rows.push(
          `│    ${checked.has(entries[index].value) ? "●" : "○"}  ${entries[index].label}`,
        );
      }
      return rows;
    };
    const paint = () => {
      const rows = [titleLine()];
      for (let index = 0; index < count; index += 1) {
        rows.push(
          `│  ${index === cursor ? "▸" : " "}  ${checked.has(entries[index].value) ? "●" : "○"}  ${entries[index].label}`,
        );
      }
      rows.push(frameSeparator());
      rows.push(`│  ${cursor === cursorRow ? "▸" : " "}  ○  ${cancelLabel}`);
      rows.push(frameSeparator());
      rows.push(footer);
      if (validationMessage) rows.push(validationMessage);
      return rows;
    };
    const session = startFrame(stdin, stdout, paint);
    const finish = (values) => {
      session.close();
      stdin.removeAllListeners("keypress");
      if (values === null) {
        settleFrame(stdout, titleLine(), []);
        stdout.write(`✖  ${cancelLabel}\n`);
        resolve(null);
        return;
      }
      settleFrame(stdout, titleLine(), [
        ...optionRows(),
        `◇  ${values.length === 1
          ? entries.find((entry) => entry.value === values[0]).label
          : `${values.length} selected`}`,
      ]);
      resolve(values);
    };
    stdin.on("keypress", (value, key) => {
      if (key.ctrl && key.name === "c") {
        finish(null);
        return;
      }
      if (key.name === "up" || key.name === "k") {
        cursor = (cursor - 1 + count + 1) % (count + 1);
        session.refresh();
      } else if (key.name === "down" || key.name === "j") {
        cursor = (cursor + 1) % (count + 1);
        session.refresh();
      } else if ((key.name === "space" || key.name === "s") && cursor < count) {
        const entry = entries[cursor];
        if (checked.has(entry.value)) checked.delete(entry.value);
        else checked.add(entry.value);
        session.refresh();
      } else if (key.name === "a") {
        for (const entry of entries) checked.add(entry.value);
        session.refresh();
      } else if (key.name === "n") {
        checked.clear();
        session.refresh();
      } else if (key.name === "return" || key.name === "enter") {
        if (cursor < count && checked.size < minSelected) {
          validationMessage = emptyMessage;
          session.refresh();
          return;
        }
        finish(cursor >= count ? null : [...checked]);
      } else if (key.name === "escape") {
        finish(null);
      }
    });
  });
}

/** Yes/No 确认（↑↓/y/n/Enter）。返回 true/false，Esc → null。 */
export function confirm(options = {}) {
  const { stdin = process.stdin, stdout = process.stdout } = options;
  const title = options.title;
  const initial = options.initial ?? true;
  const footer = "↑↓ move · y yes · n no · enter confirm · esc cancel";
  const choices = [
    { value: true, label: "Yes" },
    { value: false, label: "No" },
  ];
  return new Promise((resolve) => {
    let cursor = initial ? 0 : 1;
    const paint = () => {
      const rows = [`◇  ${title}`];
      for (let index = 0; index < choices.length; index += 1) {
        rows.push(`│  ${index === cursor ? "●" : "○"}  ${choices[index].label}`);
      }
      rows.push(footer);
      return rows;
    };
    const session = startFrame(stdin, stdout, paint);
    const finish = (value) => {
      session.close();
      stdin.removeAllListeners("keypress");
      if (value === null) {
        settleFrame(stdout, title, []);
        stdout.write(`✖  cancel\n`);
        resolve(null);
        return;
      }
      const rows = [];
      for (let index = 0; index < choices.length; index += 1) {
        rows.push(`│  ${choices[index].value === value ? "●" : "○"}  ${choices[index].label}`);
      }
      settleFrame(stdout, title, [...rows, `◇  ${value ? "Yes" : "No"}`]);
      resolve(value);
    };
    stdin.on("keypress", (value, key) => {
      if (key.ctrl && key.name === "c") {
        finish(null);
        return;
      }
      if (key.name === "up" || key.name === "k") {
        cursor = 1 - cursor;
        session.refresh();
      } else if (key.name === "down" || key.name === "j") {
        cursor = 1 - cursor;
        session.refresh();
      } else if (key.name === "y") {
        finish(true);
      } else if (key.name === "n") {
        finish(false);
      } else if (key.name === "return" || key.name === "enter") {
        finish(choices[cursor].value);
      } else if (key.name === "escape") {
        finish(null);
      }
    });
  });
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** 单行旋转指示器（安装/克隆等长操作）。update 换文案，stop/fail 落定换 ✓/✖。 */
export function spinner(options = {}) {
  const stdout = options.stdout ?? process.stdout;
  let currentText = options.text ?? "Working…";
  let index = 0;
  const paint = () => stdout.write(`\r\x1b[K${SPINNER_FRAMES[index % SPINNER_FRAMES.length]} ${currentText}`);
  const timer = setInterval(() => {
    index += 1;
    paint();
  }, 80);
  paint();
  return {
    update(nextText) {
      currentText = nextText;
      paint();
    },
    stop(doneText) {
      clearInterval(timer);
      stdout.write(`\r\x1b[K✓  ${doneText}\n`);
    },
    fail(errorText) {
      clearInterval(timer);
      stdout.write(`\r\x1b[K✖  ${errorText}\n`);
    },
  };
}

// ---- 摘要框（╭╮ 框 + ├/└ 内联列表）：结果信息在交互完成后的落定输出 ----

/** 终端显示宽度（CJK 各记 2 列，代理对记 1 字符）。 */
export function displayWidth(text) {
  let width = 0;
  for (const character of text) {
    const code = character.codePointAt(0);
    const wide =
      (code >= 0x1100 && code <= 0x115f) || // Hangul jamo
      (code >= 0x2e80 && code <= 0x9fff) || // CJK 部首/汉字/假名（含 U+3000 空白）
      (code >= 0xf900 && code <= 0xfaff) || // CJK 兼容表意
      (code >= 0xff00 && code <= 0xff60);   // 全角 ASCII
    width += wide ? 2 : 1;
  }
  return width;
}

/** 把内容行包进 ╭╮╰╯ 边框；返回成帧字符串数组（也方便单测）。 */
export function boxLines(lines) {
  const contentWidth = Math.max(0, ...lines.map((line) => displayWidth(line))) + 4;
  const frame = [
    `╭${"─".repeat(contentWidth)}╮`,
    ...lines.map((line) => {
      const pad = contentWidth - 2 - displayWidth(line); // │ + 2 左边距
      return `│  ${line}${" ".repeat(Math.max(0, pad - 2))}  │`;
    }),
    `╰${"─".repeat(contentWidth)}╯`,
  ];
  return frame;
}

export function box(stdout, lines) {
  stdout.write(`\n${boxLines(lines).join("\n")}\n`);
}
