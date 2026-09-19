// Avenic 的终端层：整个产品只有这一份按键实现和这一套配色，交互的（select /
// multiSelect / searchableSelect / confirm / text / progress）与打印的
// （banner / section / summary / success / warning / error / table）都从这里出。
//
// 视觉约定，所有交互面共用同一套：
//   ◆ 标题       品牌色粗体：一帧的顶行，或一次输出的开头
//   ◇ 标题       已落定的区块（结果、status 的分节）
//   │  条目      区块内的行；└ 是区块的收尾行（帮助、摘要）
//   ▸            光标所在行；◉ 已选中（绿）；○ 未选中（灰）
//   绿 = 成功/选中   黄 = 警告   红 = 错误   灰 = 次要信息与帮助
// 取消不是列表里的一行：Esc / Ctrl+C 才是取消，列表只列可以选的东西。
//
// 颜色在 NO_COLOR、非 TTY、TERM=dumb 下自动退化成纯文本；窄终端下每行按终端
// 宽度截断（不换行、不撑破布局）；整层不含 emoji，全部是单宽度字符。
//
// 渲染：所有帧写入 stdout，raw 模式 + 光标保存/恢复逐键重绘 —— Windows 终端对
// 相对 moveCursor 的重绘处理不一致，每次重绘都从「帧首光标保存点」恢复并清屏
// 后重画。可注入 { stdin, stdout }（单测用假 TTY 流）；非 TTY 时调用方自行回退
// 到纯文本路径，本模块只在 isInteractive() 成立时渲染。每个提示返回
// Promise<value | null>（null = Esc/Ctrl+C 取消）。

import readline from "node:readline";

export function isInteractive({ stdin = process.stdin, stdout = process.stdout } = {}) {
  return stdin.isTTY === true && stdout.isTTY === true;
}

// ---- 颜色 ----

const ANSI = /\x1b\[[0-9;]*m/g;

/** 是否给这个流上色：NO_COLOR / FORCE_COLOR 优先，其次看它是不是终端。 */
export function colorEnabled(stream = process.stdout, environment = process.env) {
  if (environment.FORCE_COLOR === "0") return false;
  if (typeof environment.NO_COLOR === "string" && environment.NO_COLOR !== "") return false; // NO_COLOR 规范：非空即关闭
  if (environment.FORCE_COLOR) return true;
  return stream?.isTTY === true && environment.TERM !== "dumb";
}

/** 一套颜色函数；enabled 为 false 时每个函数都是恒等 —— 调用点不必分支。 */
export function paletteFor(enabled) {
  const wrap = (...codes) => (text) => (enabled ? `\x1b[${codes.join(";")}m${text}\x1b[0m` : String(text));
  return {
    enabled,
    brand: wrap(36),        // 品牌色（青）：标记、光标、标题符号
    title: wrap(1, 36),     // 标题行：品牌色 + 粗体
    ok: wrap(32),           // 成功 / 已选中
    okStrong: wrap(1, 32),
    warn: wrap(33),         // 警告
    bad: wrap(31),          // 错误
    dim: wrap(2),           // 次要信息、帮助
    strong: wrap(1),
  };
}

export function palette(stream = process.stdout, environment = process.env) {
  return paletteFor(colorEnabled(stream, environment));
}

/** 提示自己的调色板：调用方给了 color 就照办，否则看流。 */
function colorsFor(options, stdout) {
  if (options.color === true || options.color === false) return paletteFor(options.color);
  return palette(stdout, options.environment ?? process.env);
}

// ---- 宽度 ----
// 终端宽度决定每一行能画多长：窄终端截断，宽终端也不铺满整屏。

export function columns(stream = process.stdout) {
  const width = Number(stream?.columns);
  return Math.max(40, Math.min(Number.isFinite(width) && width > 0 ? width : 80, 120));
}

/** 终端显示宽度（CJK 各记 2 列，代理对记 1 字符，ANSI 序列不计）。 */
export function displayWidth(text) {
  let width = 0;
  for (const character of String(text).replace(ANSI, "")) {
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

/** 按显示宽度截断到 width 列，末尾一个 …。 */
export function truncate(text, width) {
  const plain = String(text);
  if (width <= 0) return "";
  if (displayWidth(plain) <= width) return plain;
  let out = "";
  let used = 0;
  for (const character of plain) {
    const size = displayWidth(character);
    if (used + size > width - 1) break;
    out += character;
    used += size;
  }
  return `${out}…`;
}

// ---- 一行条目 ----
// 每一个列表（单选、多选、可搜索、确认）都画同一行：│  ▸ ◉ 标签   提示

function entryRow({ colors, width, cursor = false, checked = false, label, hint }) {
  const head = `│  ${cursor ? colors.brand("▸") : " "} ${checked ? colors.ok("◉") : colors.dim("○")}  `;
  let tail = hint ? `   ${colors.dim(hint)}` : "";
  let room = width - displayWidth(head) - displayWidth(tail) - 1;
  if (room < 8 && tail) { // 标签比提示重要：留不下标签就丢掉提示，而不是把标签压成两个字
    tail = "";
    room = width - displayWidth(head) - 1;
  }
  const text = truncate(label, Math.max(4, room));
  const painted = checked ? (cursor ? colors.okStrong(text) : colors.ok(text)) : cursor ? colors.strong(text) : text;
  return `${head}${painted}${tail}`;
}

// ---- 纯文本输出 ----

/** 品牌 banner：三行块状 AVENIC + 一行副标题（窄终端下自动省略副标题）。 */
export function banner(stdout = process.stdout, options = {}) {
  const colors = options.colors ?? palette(stdout, options.environment ?? process.env);
  const art = [
    "█▀▀█ █   █ █▀▀▀ █  █ ███ █▀▀▀",
    "█▄▄█  █ █  █▀▀  █▄ █  █  █   ",
    "▀  ▀   ▀   ▀▀▀▀ █ ▀█ ▀▀▀ ▀▀▀▀",
  ].map((line) => `   ${colors.brand(line)}`);
  const subtitle = options.subtitle ?? "shared history · skills · sessions";
  const width = columns(stdout);
  const lines = [...art];
  if (displayWidth(subtitle) + 4 <= width) lines.push(`   ${colors.dim(subtitle)}`);
  stdout.write(`${lines.join("\n")}\n\n`);
}

/** ◆ 标题行：一次输出的开头，或交互帧的顶行。 */
export function intro(stdout, title, options = {}) {
  const colors = options.colors ?? palette(stdout, options.environment ?? process.env);
  stdout.write(`${colors.title(`◆  ${title}`)}\n`);
  if (options.description) stdout.write(`│  ${colors.dim(truncate(options.description, columns(stdout) - 4))}\n`);
}

/** ◇ 分节标题：status 这类只读输出的骨架，与落定帧同一个符号。 */
export function section(stdout, title, options = {}) {
  const colors = options.colors ?? palette(stdout, options.environment ?? process.env);
  stdout.write(`${colors.brand(`◇  ${title}`)}\n`);
  if (options.description) stdout.write(`│  ${colors.dim(truncate(options.description, columns(stdout) - 4))}\n`);
}

/** 一条「标签  值」的信息行，带 │ 竖线（status 的分节内容）。 */
export function field(stdout, label, value, options = {}) {
  const colors = options.colors ?? palette(stdout, options.environment ?? process.env);
  const labelWidth = options.labelWidth ?? 9;
  const label_ = label.padEnd(labelWidth);
  const text = truncate(`${label_}${value}`, columns(stdout) - 4);
  stdout.write(`│  ${colors.dim(text.slice(0, labelWidth))}${text.slice(labelWidth)}\n`);
}

export function success(stdout, text, options = {}) {
  const colors = options.colors ?? palette(stdout, options.environment ?? process.env);
  stdout.write(`${colors.ok("✓")}  ${text}\n`);
}

export function warning(stdout, text, options = {}) {
  const colors = options.colors ?? palette(stdout, options.environment ?? process.env);
  stdout.write(`${colors.warn("!")}  ${text}\n`);
}

export function error(stdout, text, options = {}) {
  const colors = options.colors ?? palette(stdout, options.environment ?? process.env);
  stdout.write(`${colors.bad("✖")}  ${text}\n`);
}

/** 落定行：一次成功收尾（与 success 同形，语义上是「这一段结束了」）。 */
export function outro(stdout, text, options = {}) {
  success(stdout, text, options);
}

/** 取消行：Esc / Ctrl+C 之后由调用方打印。 */
export function cancel(stdout, text = "Cancelled", options = {}) {
  const colors = options.colors ?? palette(stdout, options.environment ?? process.env);
  stdout.write(`${colors.bad("✖")}  ${colors.dim(text)}\n`);
}

/**
 * 状态表：◇ 分节 + 竖线 + 列对齐（`avenic status` 的 Agents 一节）。
 * 列宽按内容算，整行按终端宽度截断，窄终端下不换行。
 */
export function table(stdout, headers, rows, options = {}) {
  const colors = options.colors ?? palette(stdout, options.environment ?? process.env);
  const widths = headers.map((header, column) =>
    Math.max(displayWidth(header), ...rows.map((row) => displayWidth(row[column] ?? ""))));
  const width = columns(stdout);
  const line = (cells, paint) => cells
    .map((cell, column) => {
      const pad = " ".repeat(Math.max(0, widths[column] - displayWidth(cell)));
      return paint ? paint(`${cell}${pad}`) : `${cell}${pad}`;
    })
    .join("  ")
    .trimEnd();
  stdout.write(`│  ${colors.dim(truncate(line(headers), width - 4))}\n`);
  for (const row of rows) {
    const text = line(row.map((cell) => String(cell ?? "")));
    const painted = options.mark ? options.mark(row, colors) : text;
    stdout.write(`│  ${truncate(painted, width - 4)}\n`);
  }
  if (options.footnote) stdout.write(`│  ${colors.dim(truncate(options.footnote, width - 4))}\n`);
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

/** 落定帧：◇ 标题行 + 区块内容 + └ 摘要行（取消时直接回取消行）。 */
function settleFrame(stdout, colors, heading, lines, summary) {
  const width = columns(stdout);
  const body = [
    colors.brand(`◇  ${truncate(heading, width - 4)}`),
    ...lines,
    ...(summary === undefined ? [] : [`${colors.brand("└")}  ${colors.ok(truncate(summary, width - 4))}`]),
  ];
  stdout.write(`\x1b[u\x1b[J${body.join("\n")}\n`);
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

/** 环绕移动光标。 */
function step(cursor, delta, rows) {
  return (cursor + delta + rows) % rows;
}

/** 长列表只画一屏：光标始终可见，两端各留一行省略标记。 */
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

const moreUp = (count) => `│  ↑ ${count} more`;
const moreDown = (count) => `│  ↓ ${count} more`;

// ---- 提示 ----
// 帧、键盘、落定、取消只在这里实现一次；每个提示只回答「画什么」和「按键之后
// 状态怎么变」。因此新增一个交互面是写一个 reducer，而不是再写一遍终端循环。

/**
 * `model.paint()` 返回当前帧的行，`model.reduce(intent)` 返回 true（重画）、
 * "accept"（立即确认）或什么都不返回，`model.accept()` 返回 `{ result, lines,
 * summary }`、`{ cancel: true }` 或什么都不返回（保持这一帧 —— 空选择是提示，
 * 不是取消）。
 */
function prompt(options, model) {
  const { stdin = process.stdin, stdout = process.stdout } = options;
  const colors = colorsFor(options, stdout);
  const cancelLabel = options.cancelLabel ?? CANCEL_LABEL;
  return new Promise((resolve) => {
    let stop = () => {};
    const session = startFrame(stdin, stdout, () => model.paint());
    const settle = (result, lines, summary) => {
      session.close();
      stop();
      if (result === null) {
        settleFrame(stdout, colors, model.heading(), []);
        cancel(stdout, cancelLabel, { colors });
        resolve(null);
        return;
      }
      settleFrame(stdout, colors, model.heading(), lines, summary);
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

/** 帧头：◆ 标题（+ 灰色说明）→ 空 │ → 条目。所有列表共用。 */
function frameHead({ colors, title, description, width }) {
  const rows = [colors.title(`◆  ${truncate(title, width - 4)}`)];
  if (description) rows.push(`│  ${colors.dim(truncate(description, width - 4))}`);
  rows.push("│");
  return rows;
}

/** 帧尾：校验提示（黄）→ 空 │ → └ 帮助（灰）。 */
function frameFoot({ colors, footer, message, width }) {
  const rows = [];
  if (message) rows.push(`│  ${colors.warn(truncate(message, width - 4))}`);
  rows.push("│");
  rows.push(`${colors.brand("└")}  ${colors.dim(truncate(footer, width - 4))}`);
  return rows;
}

/** 单选项选择（catalog select / 手动流中的任一单选）。 */
export function singleSelect(options = {}) {
  const entries = options.options; // [{ value, label, hint }]
  const height = Math.max(1, options.height ?? 12);
  const values = entries.map((entry) => entry.value);
  const count = entries.length;
  let cursor = Math.max(0, Math.min(options.initial ?? 0, Math.max(0, count - 1)));
  const width = columns(options.stdout ?? process.stdout);
  const colors = colorsFor(options, options.stdout ?? process.stdout);
  const footer = options.footer ?? "↑↓ move · enter select · esc cancel";
  const row = (index, flagged) => entryRow({
    colors, width, label: entries[index].label, hint: entries[index].hint, checked: flagged, cursor: index === cursor,
  });
  return prompt({ ...options, footer }, {
    heading: () => options.title,
    paint() {
      const { from, to } = windowFor(count, cursor, height);
      const rows = frameHead({ colors, title: options.title, description: options.description, width });
      if (from > 0) rows.push(moreUp(from));
      for (let index = from; index < to; index += 1) rows.push(row(index, index === cursor));
      if (to < count) rows.push(moreDown(count - to));
      rows.push(...frameFoot({ colors, footer, message: count === 0 ? "Nothing to choose from" : "", width }));
      return rows;
    },
    reduce(intent) {
      if (count === 0) return false;
      if (movesUp(intent, true) || movesDown(intent, true)) {
        cursor = step(cursor, movesUp(intent, true) ? -1 : 1, count);
        return true;
      }
      return false;
    },
    accept() {
      if (count === 0) return null; // 没有可选项：回车留在原地，不是取消
      return {
        result: values[cursor],
        lines: entries.map((_, index) => row(index, index === cursor)),
        summary: entries[cursor].label,
      };
    },
  });
}

/**
 * 多选项选择（space 逐项切换，Ctrl+A 全选，a/n 清空/全选）。可搜索时
 * （`searchable: true`）单字符一律进入过滤词，列表随输入缩小，空格仍然切换
 * 当前项。回车只有在选中数达到 minSelected 时才落定 —— 一个都没选时回车是
 * 提示，不是「就这样吧」，也不是取消。
 */
export function multiSelect(options = {}) {
  const entries = options.options; // [{ value, label, hint }]
  const title = options.title;
  const searchable = options.searchable === true;
  const fixed = new Set(options.fixed ?? []); // 不能取消的条目（如唯一存储）
  const checked = new Set(options.initial ?? []);
  const minSelected = Math.max(0, options.minSelected ?? 0);
  const emptyMessage = options.emptyMessage ?? "Select at least one item";
  const height = Math.max(1, options.height ?? 12);
  const width = columns(options.stdout ?? process.stdout);
  const colors = colorsFor(options, options.stdout ?? process.stdout);
  const footer = options.footer ?? (searchable
    ? "type to filter · ↑↓ move · space toggle · ^a all · enter confirm · esc cancel"
    : "↑↓ move · space toggle · ^a all · enter confirm · esc cancel");
  let query = "";
  let cursor = 0;
  let validationMessage = "";
  let shown = entries;
  // heading 帧内和落定帧用的是同一行，所以它不带 ◇：符号由骨架加。
  const heading = () => (checked.size > 0 ? `${title} (${checked.size} selected)` : title);
  const row = (entry, marked) => entryRow({
    colors, width, label: entry.label, hint: entry.hint, checked: checked.has(entry.value), cursor: marked,
  });
  return prompt({ ...options, footer }, {
    heading,
    paint() {
      shown = filterEntries(entries, query);
      cursor = Math.min(cursor, shown.length);
      const { from, to } = windowFor(shown.length, Math.min(cursor, Math.max(0, shown.length - 1)), height);
      const rows = frameHead({ colors, title: heading(), description: options.description, width });
      if (from > 0) rows.push(moreUp(from));
      for (let index = from; index < to; index += 1) rows.push(row(shown[index], index === cursor));
      if (to < shown.length) rows.push(moreDown(shown.length - to));
      if (searchable) {
        const counter = shown.length !== entries.length ? `  (${shown.length}/${entries.length})` : "";
        rows.push(truncate(`│  ${colors.brand("⌕")} ${query.length > 0 ? query : colors.dim("type to filter")}${colors.dim(counter)}`, width));
      }
      rows.push(...frameFoot({ colors, footer, message: validationMessage, width }));
      return rows;
    },
    reduce(intent) {
      if (movesUp(intent, !searchable) || movesDown(intent, !searchable)) {
        if (shown.length === 0) return false;
        cursor = step(cursor, movesUp(intent, !searchable) ? -1 : 1, shown.length);
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
export function searchableSelect(options = {}) {
  const entries = options.options; // [{ value, label, hint }]
  const title = options.title;
  const height = Math.max(1, options.height ?? 12);
  const width = columns(options.stdout ?? process.stdout);
  const colors = colorsFor(options, options.stdout ?? process.stdout);
  const footer = options.footer ?? "type to filter · ↑↓ move · enter select · esc cancel";
  let query = "";
  let cursor = 0;
  let shown = entries;
  const row = (entry, marked) => entryRow({ colors, width, label: entry.label, hint: entry.hint, checked: marked, cursor: marked });
  return prompt({ ...options, footer }, {
    heading: () => title,
    paint() {
      shown = filterEntries(entries, query);
      cursor = Math.min(cursor, Math.max(0, shown.length - 1));
      const { from, to } = windowFor(shown.length, cursor, height);
      const rows = frameHead({ colors, title, description: options.description, width });
      if (shown.length === 0) rows.push(`│  ${colors.dim("no matches")}`);
      if (from > 0) rows.push(moreUp(from));
      for (let index = from; index < to; index += 1) rows.push(row(shown[index], index === cursor));
      if (to < shown.length) rows.push(moreDown(shown.length - to));
      const counter = shown.length !== entries.length ? `  (${shown.length}/${entries.length})` : "";
      rows.push(truncate(`│  ${colors.brand("⌕")} ${query.length > 0 ? query : colors.dim("type to filter")}${colors.dim(counter)}`, width));
      rows.push(...frameFoot({ colors, footer, message: "", width }));
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
  const width = columns(options.stdout ?? process.stdout);
  const colors = colorsFor(options, options.stdout ?? process.stdout);
  const footer = options.footer ?? "type · enter confirm · esc cancel";
  let value = options.initial ?? "";
  const cursorLine = () => `│  ${colors.brand("▸")} ${value}${colors.brand("▏")}`;
  return prompt({ ...options, footer }, {
    heading: () => title,
    paint: () => [...frameHead({ colors, title, description: options.description, width }), cursorLine(),
      ...frameFoot({ colors, footer, message: "", width })],
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
  const width = columns(options.stdout ?? process.stdout);
  const colors = colorsFor(options, options.stdout ?? process.stdout);
  const footer = options.footer ?? "y yes · n no · enter confirm · esc cancel";
  const choices = [
    { value: true, label: options.yesLabel ?? "Yes" },
    { value: false, label: options.noLabel ?? "No" },
  ];
  let cursor = (options.initial ?? true) ? 0 : 1;
  const row = (index) => entryRow({ colors, width, label: choices[index].label, checked: index === cursor, cursor: index === cursor });
  const settleOn = (index) => {
    cursor = index;
    return "accept";
  };
  return prompt({ ...options, footer }, {
    heading: () => title,
    paint: () => [
      ...frameHead({ colors, title, description: options.description, width }),
      ...choices.map((_, index) => row(index)),
      ...frameFoot({ colors, footer, message: "", width }),
    ],
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

/** 单行进度指示器（安装/克隆/同步等长操作）。update 换文案，stop/fail 落定换 ✓/✖。 */
export function progress(options = {}) {
  const stdout = options.stdout ?? process.stdout;
  const colors = colorsFor(options, stdout);
  let currentText = options.text ?? "Working…";
  let index = 0;
  const paint = () => stdout.write(`\r\x1b[K${colors.brand(SPINNER_FRAMES[index % SPINNER_FRAMES.length])} ${currentText}`);
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
      stdout.write(`\r\x1b[K${colors.ok("✓")}  ${doneText}\n`);
    },
    fail(errorText) {
      clearInterval(timer);
      stdout.write(`\r\x1b[K${colors.bad("✖")}  ${errorText}\n`);
    },
  };
}

// ---- 摘要框（╭╮ 框 + ├/└ 内联列表）：结果信息在交互完成后的落定输出 ----

/** 把内容行包进 ╭╮╰╯ 边框；返回成帧字符串数组（也方便单测）。 */
export function boxLines(lines) {
  const width = Math.max(0, ...lines.map((line) => displayWidth(line))) + 4;
  return [
    `╭${"─".repeat(width)}╮`,
    ...lines.map((line) => {
      const pad = width - 2 - displayWidth(line); // │ + 2 左边距
      return `│  ${line}${" ".repeat(Math.max(0, pad - 2))}  │`;
    }),
    `╰${"─".repeat(width)}╯`,
  ];
}

/**
 * 结果摘要框。框里的行自带层级（└ 是区块收尾），框本身只是把它们和终端上
 * 其他输出分开。交互完成后才用，所以它永远是纯文本、不参与帧重绘。
 */
export function summary(stdout, lines) {
  stdout.write(`\n${boxLines(lines).join("\n")}\n`);
}
