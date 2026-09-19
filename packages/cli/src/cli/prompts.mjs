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

/** 错误线：一次失败的原因，格式与取消线一致（✖ 在最左，理由跟其后）。 */
export function error(stdout, text) {
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

// ---- 键盘 ----
// 这一节是 Avenic 唯一的按键实现。每个提示都是一个把「意图」映射到下一个
// 状态的 reducer，而 Ctrl+C、Esc、方向键在每一帧里都表示同一件事；换一个
// 终端前端时，要改的也只有这里。

const CANCEL_LABEL = "cancel";

/** 一次按键 → 一个意图。无法识别的按键返回 null，由 reducer 决定是否忽略。 */
function keyIntent({ value, key = {} }) {
  const name = key.name ?? (typeof value === "string" ? value : "");
  if (key.ctrl && (name === "c" || name === "d")) return "cancel";
  if (key.ctrl && name === "a") return "all"; // 搜索框里也能全选：字母键让给过滤词
  if (name === "escape") return "cancel";
  if (name === "up") return "up";
  if (name === "down") return "down";
  if (name === "return" || name === "enter") return "accept";
  if (name === "backspace" || name === "delete") return "erase";
  if (name === "space") return "toggle";
  if (typeof value === "string" && value.length === 1 && value >= " " && value !== "\x7f") {
    return { text: value, name };
  }
  return null;
}

/**
 * The one place a prompt listens for a key. `reduce` receives an intent and
 * returns true (repaint), "accept" (answer now) or nothing; the returned
 * teardown detaches the listener, so a finished prompt can never consume the
 * next keystroke. Nothing else in this module — or in the CLI — attaches a
 * keypress listener of its own.
 */
function listenKeys(stdin, reduce) {
  const listener = (value, key) => reduce(keyIntent({ value, key }));
  stdin.on("keypress", listener);
  return () => stdin.removeAllListeners("keypress");
}

// 单字母快捷键只在「这一帧不是搜索框」时才生效：可搜索的列表里，所有能打出来
// 的字符都属于过滤词，否则用户永远搜不到 s/k/j/a/n 开头的名字。
const movesUp = (intent, letters) => intent === "up" || (letters && intent?.text === "k");
const movesDown = (intent, letters) => intent === "down" || (letters && intent?.text === "j");
const letter = (intent, expected) => intent?.text === expected;

/** 环绕移动光标；多一行「cancel」时把行数传成 count + 1。 */
function step(cursor, delta, rows) {
  return (cursor + delta + rows) % rows;
}

/** 长列表只画一屏：光标始终可见，两端各留一行省略标记。返回窗口与它的行号。 */
function windowFor(count, cursor, height) {
  if (count <= height) return { from: 0, to: count };
  const from = Math.max(0, Math.min(cursor - Math.floor(height / 2), count - height));
  return { from, to: from + height };
}

/** 输入即过滤：空查询保留全部，否则标签或值包含查询词（不分大小写）。 */
function filterEntries(entries, query) {
  const needle = query.toLowerCase();
  if (needle.length === 0) return entries;
  return entries.filter((entry) =>
    entry.label.toLowerCase().includes(needle) || String(entry.value).toLowerCase().includes(needle));
}

// ---- 提示 ----
// 帧、键盘、落定、取消只在这里实现一次；每个提示只回答「画什么」和「按键之后
// 状态怎么变」。因此新增一个交互面（如 Skills 菜单）是写一个 reducer，而不是
// 再写一遍终端循环。

/**
 * `model.paint()` 返回当前帧的行，`model.reduce(intent)` 返回 true（重画）、
 * "accept"（立即确认）或什么都不返回，`model.accept()` 返回 `{ result, lines,
 * summary }`、`{ cancel: true }` 或什么都不返回（保持这一帧 —— 空选择或回车行
 * 是提示，不是取消）。
 */
function prompt(options, model) {
  const { stdin = process.stdin, stdout = process.stdout } = options;
  const cancelLabel = options.cancelLabel ?? CANCEL_LABEL;
  return new Promise((resolve) => {
    let stop = () => {};
    const session = startFrame(stdin, stdout, () => model.paint());
    const settle = (result, lines, summary) => {
      session.close();
      stop();
      if (result === null) {
        settleFrame(stdout, model.titleLine(), []);
        stdout.write(`✖  ${cancelLabel}\n`);
        resolve(null);
        return;
      }
      settleFrame(stdout, model.titleLine(), [...lines, `◇  ${summary}`]);
      resolve(result);
    };
    const accept = () => {
      const outcome = model.accept();
      if (!outcome) {
        session.refresh(); // 还没有可确认的东西：重画，让提示可见
        return;
      }
      if (outcome.cancel) {
        settle(null);
        return;
      }
      settle(outcome.result, outcome.lines, outcome.summary);
    };
    stop = listenKeys(stdin, (intent) => {
      if (intent === "cancel") {
        settle(null);
        return;
      }
      if (intent === "accept") {
        accept();
        return;
      }
      if (intent === null) return;
      const changed = model.reduce(intent);
      if (changed === "accept") accept();
      else if (changed) session.refresh();
    });
  });
}

/** 单选项选择（catalog select / 手动流中的任一单选）。 */
export function select(options = {}) {
  const entries = options.options; // [{ value, label }]
  const cancelLabel = options.cancelLabel ?? CANCEL_LABEL;
  const height = Math.max(1, options.height ?? 12);
  const count = entries.length;
  const cancelRow = count; // cancel 行在 entries 之后
  const footer = options.footer ?? "↑↓ move · enter select · esc cancel";
  let cursor = Math.max(0, Math.min(options.initial ?? 0, cancelRow));
  const row = (index) =>
    `│  ${index === cursor ? "●" : "○"}  ${entries[index].label}${entries[index].hint ? `   ${entries[index].hint}` : ""}`;
  return prompt({ ...options, footer }, {
    titleLine: () => options.title,
    paint() {
      const { from, to } = windowFor(count, Math.min(cursor, Math.max(0, count - 1)), height);
      const rows = [`◇  ${options.title}`];
      if (from > 0) rows.push(`│  ↑ ${from} more`);
      for (let index = from; index < to; index += 1) rows.push(row(index));
      if (to < count) rows.push(`│  ↓ ${count - to} more`);
      rows.push(frameSeparator());
      rows.push(`│  ${cursor === cancelRow ? "●" : "○"}  ${cancelLabel}`);
      rows.push(frameSeparator());
      rows.push(footer);
      return rows;
    },
    reduce(intent) {
      if (movesUp(intent, true) || movesDown(intent, true)) {
        cursor = step(cursor, movesUp(intent, true) ? -1 : 1, count + 1);
        return true;
      }
      return false;
    },
    accept() {
      if (cursor >= count) return { cancel: true };
      return {
        result: entries[cursor].value,
        lines: entries.map((_, index) => row(index)),
        summary: entries[cursor].label,
      };
    },
  });
}

/**
 * 多选项选择（space 逐项切换，a 全选，n 清空）。可搜索时（`searchable: true`）
 * 单字符一律进入过滤词，列表随输入缩小，空格仍然切换当前项。
 */
export function multiselect(options = {}) {
  const entries = options.options; // [{ value, label, hint }]
  const title = options.title;
  const searchable = options.searchable === true;
  const fixed = new Set(options.fixed ?? []); // 不能取消的条目（如唯一存储）
  const checked = new Set(options.initial ?? []);
  const minSelected = Math.max(0, options.minSelected ?? 0);
  const emptyMessage = options.emptyMessage ?? "Select at least one item";
  const cancelLabel = options.cancelLabel ?? CANCEL_LABEL;
  const height = Math.max(1, options.height ?? 12);
  const footer = options.footer ?? (searchable
    ? "type to filter · ↑↓ move · space toggle · ^a all · enter confirm · esc cancel"
    : "↑↓ move · space toggle · a all · n none · enter confirm · esc cancel");
  let query = "";
  let cursor = 0;
  let validationMessage = "";
  let shown = entries;
  // titleLine 不带 ◇：骨架负责前缀（帧内和落定帧用的是同一行）。
  const titleLine = () => (checked.size > 0 ? `${title} (${checked.size} checked)` : title);
  const row = (entry, marked) =>
    `│  ${marked ? "▸" : " "}  ${checked.has(entry.value) ? "●" : "○"}  ${entry.label}${entry.hint ? `   ${entry.hint}` : ""}`;
  return prompt({ ...options, footer }, {
    titleLine,
    paint() {
      shown = filterEntries(entries, query);
      cursor = Math.min(cursor, shown.length); // 可能停在 cancel 行
      const { from, to } = windowFor(shown.length, Math.min(cursor, Math.max(0, shown.length - 1)), height);
      const rows = [`◇  ${titleLine()}`];
      if (from > 0) rows.push(`│  ↑ ${from} more`);
      for (let index = from; index < to; index += 1) rows.push(row(shown[index], index === cursor));
      if (to < shown.length) rows.push(`│  ↓ ${shown.length - to} more`);
      rows.push(frameSeparator());
      rows.push(`│  ${cursor >= shown.length ? "▸" : " "}  ○  ${cancelLabel}`);
      if (searchable) rows.push(`│  ⌕ ${query.length > 0 ? query : "&"}${shown.length !== entries.length ? `  (${shown.length}/${entries.length})` : ""}`);
      rows.push(frameSeparator());
      rows.push(footer);
      if (validationMessage) rows.push(validationMessage);
      return rows;
    },
    reduce(intent) {
      if (movesUp(intent, !searchable) || movesDown(intent, !searchable)) {
        if (shown.length === 0) return false;
        cursor = step(cursor, movesUp(intent, !searchable) ? -1 : 1, shown.length + 1);
        return true;
      }
      if ((intent === "toggle" || (!searchable && letter(intent, "s"))) && cursor < shown.length) {
        const { value } = shown[cursor];
        if (fixed.has(value)) return false; // 必选项：空格不改它，也不重画
        if (checked.has(value)) checked.delete(value);
        else checked.add(value);
        return true;
      }
      if (searchable) {
        if (intent === "erase") {
          query = query.slice(0, -1);
          cursor = 0;
          return true;
        }
        if (intent?.text && intent.text !== " ") {
          query += intent.text;
          cursor = 0;
          return true;
        }
        return false;
      }
      if (intent === "all" || letter(intent, "a")) {
        for (const entry of entries) checked.add(entry.value);
        return true;
      }
      if (letter(intent, "n")) {
        for (const entry of entries) {
          if (!fixed.has(entry.value)) checked.delete(entry.value);
        }
        return true;
      }
      return false;
    },
    accept() {
      // cancel 行优先于校验：用户在「取消」上回车就是要取消，哪怕一个也没选。
      if (shown.length > 0 && cursor >= shown.length) return { cancel: true };
      if (checked.size < minSelected) {
        validationMessage = emptyMessage;
        return null; // 留在这一帧，提示已经画在帧里
      }
      const values = [...checked];
      return {
        result: values,
        lines: entries.filter((entry) => checked.has(entry.value)).map((entry) => row(entry, false)),
        summary: values.length === 1
          ? (entries.find((entry) => entry.value === values[0])?.label ?? String(values[0]))
          : `${values.length} selected`,
      };
    },
  });
}

/**
 * 可搜索单选：输入即过滤，↑↓ 在结果里移动，Enter 选中。列表长度不设限，
 * 一屏放不下时只画光标周围的一段——「找到那一条」不因为多了几十条而变慢。
 */
export function searchSelect(options = {}) {
  const entries = options.options; // [{ value, label, hint }]
  const title = options.title;
  const height = Math.max(1, options.height ?? 12);
  const footer = options.footer ?? "type to filter · ↑↓ move · enter select · esc cancel";
  let query = "";
  let cursor = 0;
  let shown = entries;
  const row = (entry, marked) =>
    `│  ${marked ? "●" : "○"}  ${entry.hint ? `${entry.label}  ${entry.hint}` : entry.label}`;
  return prompt({ ...options, footer }, {
    titleLine: () => title,
    paint() {
      shown = filterEntries(entries, query);
      cursor = Math.min(cursor, Math.max(0, shown.length - 1));
      const { from, to } = windowFor(shown.length, cursor, height);
      const rows = [`◇  ${title}`];
      if (shown.length === 0) rows.push("│  (no matches)");
      if (from > 0) rows.push(`│  ↑ ${from} more`);
      for (let index = from; index < to; index += 1) rows.push(row(shown[index], index === cursor));
      if (to < shown.length) rows.push(`│  ↓ ${shown.length - to} more`);
      rows.push(frameSeparator());
      rows.push(`│  ⌕ ${query.length > 0 ? query : "&"}${shown.length !== entries.length ? `  (${shown.length}/${entries.length})` : ""}`);
      rows.push(frameSeparator());
      rows.push(footer);
      return rows;
    },
    reduce(intent) {
      if (movesUp(intent, false) || movesDown(intent, false)) {
        if (shown.length === 0) return false;
        cursor = step(cursor, movesUp(intent, false) ? -1 : 1, shown.length);
        return true;
      }
      if (intent === "erase") {
        query = query.slice(0, -1);
        cursor = 0;
        return true;
      }
      if (intent?.text && intent.text !== " ") {
        query += intent.text;
        cursor = 0;
        return true;
      }
      return false;
    },
    accept() {
      if (shown.length === 0) return null; // 没有可选项：回车不是取消，是留在原地
      return { result: shown[cursor].value, lines: [row(shown[cursor], true)], summary: shown[cursor].label };
    },
  });
}

/**
 * 单行文本输入（仓库地址之类）。空格是内容不是按键；Enter 落定，空输入时
 * Enter 什么都不做（与本模块其他提示一致：没内容不等于取消），Esc → null。
 */
export function text(options = {}) {
  const title = options.title;
  const footer = options.footer ?? "type · enter confirm · esc cancel";
  let value = options.initial ?? "";
  return prompt({ ...options, footer }, {
    titleLine: () => title,
    paint: () => [`◇  ${title}`, `│  ${value}`, frameSeparator(), footer],
    reduce(intent) {
      if (intent === "erase") {
        value = value.slice(0, -1);
        return true;
      }
      if (intent === "toggle") {
        value += " ";
        return true;
      }
      if (typeof intent?.text === "string") {
        value += intent.text;
        return true;
      }
      return false;
    },
    accept() {
      const trimmed = value.trim();
      if (trimmed.length === 0) return null; // 空输入：留在原地
      return { result: trimmed, lines: [`│  ${trimmed}`], summary: trimmed };
    },
  });
}

/** Yes/No 确认。y/n 直接作答并立即落定，↑↓ 移动后 Enter 确认。Esc → null。 */
export function confirm(options = {}) {
  const title = options.title;
  const footer = options.footer ?? "↑↓ move · y yes · n no · enter confirm · esc cancel";
  const choices = [
    { value: true, label: "Yes" },
    { value: false, label: "No" },
  ];
  let cursor = (options.initial ?? true) ? 0 : 1;
  const row = (index) => `│  ${index === cursor ? "●" : "○"}  ${choices[index].label}`;
  const settleOn = (index) => {
    cursor = index;
    return "accept";
  };
  return prompt({ ...options, footer }, {
    titleLine: () => title,
    paint: () => [`◇  ${title}`, ...choices.map((_, index) => row(index)), footer],
    reduce(intent) {
      if (movesUp(intent, true) || movesDown(intent, true)) {
        cursor = 1 - cursor;
        return true;
      }
      // y/n 直接作答：帧下沿写着 y yes / n no，这一行就是承诺，不该再要一次回车。
      if (letter(intent, "y")) return settleOn(0);
      if (letter(intent, "n")) return settleOn(1);
      return false;
    },
    accept() {
      return { result: choices[cursor].value, lines: choices.map((_, index) => row(index)), summary: choices[cursor].label };
    },
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
