// Avenic 的终端层：整个产品只有这一份按键实现，颜色全部来自品牌层
// （brand.mjs）的语义色板。交互的（select / multiSelect / searchableSelect /
// confirm / text / progress）与打印的（section / field / note / success /
// warning / error / table）都从这里出。
//
// 视觉约定，所有交互面共用同一套：
//   ◆ 标题       活动分节：橙色符号 + 暖白粗体标题
//   ◇ 标题       已落定的区块（结果、status 的分节）：柔和橙
//   │  条目      区块内的行；└ 是区块的收尾行（帮助、摘要）：柔和橙收尾
//   ▸            光标所在行（亮红橙）；◉ 已选中（橙）；○ 未选中（灰）
//   橙 = 品牌/选中/活动   绿 = 成功   黄 = 警告   红 = 错误   灰 = 次要信息
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
import { colorEnabled, columns, displayWidth, palette, paletteFor, truncate } from "./brand.mjs";

// 色板与宽度助手住在品牌层（brand.mjs）：一处实现，所有面共用 —— 全仓库的
// ANSI 数字只在那一份 paletteFor 里。这里再把它们转出去，让既有的引用
// （测试、status-cli、transcript-cli）继续从一个门进来。
export { colorEnabled, columns, displayWidth, palette, paletteFor, truncate } from "./brand.mjs";

export function isInteractive({ stdin = process.stdin, stdout = process.stdout } = {}) {
  return stdin.isTTY === true && stdout.isTTY === true;
}

/** 提示自己的调色板：调用方给了 color 就照办，否则看流。 */
function colorsFor(options, stdout) {
  if (options.color === true || options.color === false) return paletteFor(options.color, options.environment ?? process.env);
  return palette(stdout, options.environment ?? process.env);
}

// ---- 一行条目 ----
// 每一个列表（单选、多选、可搜索、确认）都画同一行：│  ▸ ◉ 标签   提示

function entryRow({ colors, width, cursor = false, checked = false, label, hint }) {
  const head = `${colors.muted("│")}  ${cursor ? colors.cursor("▸") : " "} ${checked ? colors.selected("◉") : colors.muted("○")}  `;
  let tail = hint ? `   ${colors.muted(hint)}` : "";
  let room = width - displayWidth(head) - displayWidth(tail) - 1;
  if (room < 8 && tail) { // 标签比提示重要：留不下标签就丢掉提示，而不是把标签压成两个字
    tail = "";
    room = width - displayWidth(head) - 1;
  }
  const text = truncate(label, Math.max(4, room));
  const painted = checked
    ? (cursor ? colors.selectedStrong(text) : colors.selected(text))
    : cursor ? colors.strong(text) : colors.text(text);
  return `${head}${painted}${tail}`;
}

// ---- 纯文本输出 ----
//
// 这一段里的每个输出都写到一个流上，而流永远有默认值：prompts 里的打印函数是
// 产品代码直接调的（`avenic skills` 拿到的 prompts 是 `{}`），没有默认值时它们在
// 真实终端上第一行就抛 `Cannot read properties of undefined`，而测试因为总是注入
// 假流，看不到这个崩溃。交互帧（prompt 一族）一直有默认值，打印函数也必须一样。

/**
 * 把这些行收起来，最后一次性写出。分节的输出（status、每个命令的结果块）
 * 都是先攒行再落地：中途不会被别的写入插进来，也不会在交互帧收尾之后
 * 一行一行地往外挤。`columns` 跟着目标流走，窄终端下截断的判断才准。
 */
export function collectLines(io = console) {
  const lines = [];
  const sink = {
    columns: io.columns,
    write(text) {
      const parts = String(text).split("\n");
      if (parts.at(-1) === "") parts.pop();
      lines.push(...parts);
    },
  };
  return {
    sink,
    line: (text = "") => lines.push(text),
    flush: () => {
      if (lines.length > 0) io.log(lines.join("\n"));
      return lines.length;
    },
  };
}

/** ◆ 标题行：一次输出的开头，或交互帧的顶行（活动分节的符号）。 */
export function intro(stdout = process.stdout, title, options = {}) {
  const colors = options.colors ?? palette(stdout, options.environment ?? process.env);
  stdout.write(`${colors.brand("◆")}  ${colors.strong(truncate(title, columns(stdout) - 4))}\n`);
  if (options.description) {
    stdout.write(`${colors.muted("│")}  ${colors.muted(truncate(options.description, columns(stdout) - 4))}\n`);
  }
}

/** ◇ 分节标题：status 这类只读输出的骨架，与落定帧同一个符号（已落定）。 */
export function section(stdout = process.stdout, title, options = {}) {
  const colors = options.colors ?? palette(stdout, options.environment ?? process.env);
  stdout.write(`${colors.brandSoft("◇")}  ${colors.strong(truncate(title, columns(stdout) - 4))}\n`);
  if (options.description) {
    stdout.write(`${colors.muted("│")}  ${colors.muted(truncate(options.description, columns(stdout) - 4))}\n`);
  }
}

/** 一条「标签  值」的信息行，带 │ 竖线（status 的分节内容）。 */
export function field(stdout = process.stdout, label, value, options = {}) {
  const colors = options.colors ?? palette(stdout, options.environment ?? process.env);
  const labelWidth = options.labelWidth ?? 10;
  const label_ = label.padEnd(labelWidth);
  const text = truncate(`${label_}${value}`, columns(stdout) - 4);
  stdout.write(`${colors.muted("│")}  ${colors.muted(text.slice(0, labelWidth))}${text.slice(labelWidth)}\n`);
}

/** 区块里的一条提示行：│  ! 文本（黄）或 │  · 文本（灰）。 */
export function note(stdout = process.stdout, text, options = {}) {
  const colors = options.colors ?? palette(stdout, options.environment ?? process.env);
  const mark = options.mark ?? "·";
  const paint = mark === "!" ? colors.warning : colors.muted;
  stdout.write(`${colors.muted("│")}  ${paint(mark)}  ${truncate(text, columns(stdout) - 6)}\n`);
}

export function success(stdout = process.stdout, text, options = {}) {
  const colors = options.colors ?? palette(stdout, options.environment ?? process.env);
  stdout.write(`${colors.success("✓")}  ${text}\n`);
}

export function warning(stdout = process.stdout, text, options = {}) {
  const colors = options.colors ?? palette(stdout, options.environment ?? process.env);
  stdout.write(`${colors.warning("!")}  ${text}\n`);
}

export function error(stdout = process.stdout, text, options = {}) {
  const colors = options.colors ?? palette(stdout, options.environment ?? process.env);
  stdout.write(`${colors.error("✖")}  ${text}\n`);
}

/** 落定行：一次成功收尾（与 success 同形，语义上是「这一段结束了」）。 */
export function outro(stdout = process.stdout, text, options = {}) {
  success(stdout, text, options);
}

/** 取消行：Esc / Ctrl+C 之后由调用方打印。 */
export function cancel(stdout = process.stdout, text = "Cancelled", options = {}) {
  const colors = options.colors ?? palette(stdout, options.environment ?? process.env);
  stdout.write(`${colors.error("✖")}  ${colors.muted(text)}\n`);
}

/**
 * 状态表：◇ 分节 + 竖线 + 列对齐（`avenic status` 的 Agents 一节）。
 * 列宽按内容算，整行按终端宽度截断，窄终端下不换行。
 */
export function table(stdout = process.stdout, headers, rows, options = {}) {
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
  stdout.write(`${colors.muted("│")}  ${colors.muted(truncate(line(headers), width - 4))}\n`);
  for (const row of rows) {
    const text = line(row.map((cell) => String(cell ?? "")));
    const painted = options.mark ? options.mark(row, colors) : text;
    stdout.write(`${colors.muted("│")}  ${truncate(painted, width - 4)}\n`);
  }
  if (options.footnote) {
    stdout.write(`${colors.muted("│")}  ${colors.muted(truncate(options.footnote, width - 4))}\n`);
  }
}

// ---- 帧重绘机制 ----
// 每次重绘：\x1b[u 回到帧首（帧开始前写入 \x1b[s 记住位置）→ \x1b[J 到屏底 →
// 写整个新帧。raw 模式在帧会话期间开启，结束/取消时恢复并暂停 stdin。

const keypressAttached = new WeakSet();

function startFrame(stdin, stdout, paint) {
  stdin.setRawMode?.(true);
  if (!keypressAttached.has(stdin)) {
    // Esc 要立刻算作 Esc。node 的按键解码器会把它扣住 escapeCodeTimeout（默认
    // 500ms）等一个转义序列的后半截；而终端是把整串一次性写出来的，于是这 500ms
    // 全成了用户按下 Esc 到界面离场之间的死时间 —— 本产品的每个提示都走这一个解码器。
    // 50ms 远大于真实序列内部两段之间的间隔，又短到人感觉不出。
    readline.emitKeypressEvents(stdin, { escapeCodeTimeout: 50 });
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
    `${colors.brandSoft("◇")}  ${colors.strong(truncate(heading, width - 4))}`,
    ...lines,
    ...(summary === undefined ? [] : [`${colors.brandSoft("└")}  ${colors.strong(truncate(summary, width - 4))}`]),
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
  // Ctrl+C / Ctrl+D 和 Esc 不是同一个意图：这一帧空闲时两者都是「取消」，但写盘
  // 在飞的时候 Esc 只是一个太晚的取消键，而 Ctrl+C 是「现在停下」，是那时唯一的
  // 出口。所以它们在源头就分开。
  if (key.ctrl && (name === "c" || name === "d")) return "interrupt";
  if (key.ctrl && name === "a") return "all"; // 搜索框里也能全选：字母键让给过滤词
  if (name === "escape") return "cancel";
  // Shift+Tab 是「上一步」：向导里唯一的回退键，也是终端里通行的那个。
  if (name === "tab" && key.shift) return "back";
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

const moreUp = (count, colors) => colors.muted(`│  ↑ ${count} more`);
const moreDown = (count, colors) => colors.muted(`│  ↓ ${count} more`);

// ---- 提示 ----
// 帧、键盘、落定、取消只在这里实现一次；每个提示只回答「画什么」和「按键之后
// 状态怎么变」。因此新增一个交互面是写一个 reducer，而不是再写一遍终端循环。

/**
 * `model.paint()` 返回当前帧的行，`model.reduce(intent)` 返回 true（重画）、
 * "accept"（立即确认）或什么都不返回，`model.accept()` 返回 `{ result, lines,
 * summary }`、`{ cancel: true }`、`{ repaint: true }`（状态变了，重画同一帧 ——
 * 向导就是这样推进到下一步的），一个 Promise（异步确认，落定由它决定），或什么
 * 都不返回（保持这一帧 —— 空选择是提示，不是取消）。返回 Promise 之后键盘就交给
 * 它：写盘撤不回来，所以在那期间再按确认不是第二次写盘，按取消也不会变成取消。
 * 唯一的例外是 Ctrl+C / Ctrl+D —— 它不回答这一帧，它结束这一帧，并以失败收场。
 */
function prompt(options, model) {
  const { stdin = process.stdin, stdout = process.stdout } = options;
  const colors = colorsFor(options, stdout);
  const cancelLabel = options.cancelLabel ?? CANCEL_LABEL;
  return new Promise((resolve, reject) => {
    let stop = () => {};
    // 异步确认一旦开始（向导的 Apply 要写盘），键盘就不再改变结果：写盘撤不回来，
    // 所以既不能按第二次（那就是第二次写盘），也不能按键取消（那会把已经落盘的
    // 配置报成取消）。落定由那次写盘自己决定。
    let busy = false;
    // 已经收场的帧（落定、失败或被打断）不再接受第二次落定：迟到的写盘结果既不
    // 能再画一遍，也不能再 resolve 一次。
    let done = false;
    const session = startFrame(stdin, stdout, () => model.paint());
    const abandon = (failure) => {
      if (done) return;
      done = true;
      session.close();
      stop();
      reject(failure);
    };
    const settle = (result, lines, summary) => {
      if (done) return;
      done = true;
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
    const settleOutcome = (outcome) => {
      if (done) return;
      if (!outcome || outcome.repaint) {
        // 异步确认若只是要求重画（或者什么都没返回），那就没有写盘在飞：键盘
        // 得还回来，否则这一帧从此不再响应任何键，连 Esc 也按不动。
        busy = false;
        session.refresh(); // 还没有可确认的东西，或者状态刚变了：重画
        return;
      }
      if (outcome.cancel) {
        settle(null);
        return;
      }
      settle(outcome.result, outcome.lines, outcome.summary);
    };
    const accept = () => {
      if (busy) return;
      const outcome = model.accept();
      if (outcome && typeof outcome.then === "function") {
        // 异步确认（向导的 Apply 要写盘）：落定或失败由它决定。
        busy = true;
        outcome.then(settleOutcome, abandon);
        return;
      }
      settleOutcome(outcome);
    };
    stop = listenKeys(stdin, (intent) => {
      if (busy) {
        // 写盘期间的键盘：Esc 什么都不做（取消已经太晚），Ctrl+C 结束这一帧 ——
        // 一次卡住的写盘不该把用户永远锁在 raw mode 里，对着一帧没有反馈的画面。
        // 它不当成功，也不当取消：写盘撤不回来，结果只有那次写盘自己知道。
        if (intent === "interrupt") {
          abandon(new Error("Interrupted while the answer was being written"));
        }
        return;
      }
      if (intent === "cancel" || intent === "interrupt") {
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
  const rows = [`${colors.brand("◆")}  ${colors.strong(truncate(title, width - 4))}`];
  if (description) rows.push(`${colors.muted("│")}  ${colors.muted(truncate(description, width - 4))}`);
  rows.push(colors.muted("│"));
  return rows;
}

/** 帧尾：校验提示（黄）→ 空 │ → └ 帮助（灰）。 */
function frameFoot({ colors, footer, message, width }) {
  const rows = [];
  if (message) rows.push(`${colors.muted("│")}  ${colors.warning(truncate(message, width - 4))}`);
  rows.push(colors.muted("│"));
  rows.push(`${colors.brandSoft("└")}  ${colors.muted(truncate(footer, width - 4))}`);
  return rows;
}

// ---- 列表模型 ----
// 一个列表提示的「状态 + 按键 → 新状态」在这里，帧骨架（head/foot）和落定在
// prompt() 里。向导要把同一套条目画进自己的轨道，所以两者分开：向导复用这两个
// 模型，而不是再写一遍光标、窗口和校验。

/** 单选项的状态机。`rows()` 只画条目，`settleRows()` 画落定帧里的完整清单。 */
function singleSelectModel(options, view) {
  const { width, colors } = view;
  const entries = options.options; // [{ value, label, hint }]
  const height = Math.max(1, options.height ?? 12);
  const values = entries.map((entry) => entry.value);
  const count = entries.length;
  let cursor = Math.max(0, Math.min(options.initial ?? 0, Math.max(0, count - 1)));
  const row = (index, flagged) => entryRow({
    colors, width, label: entries[index].label, hint: entries[index].hint, checked: flagged, cursor: index === cursor,
  });
  return {
    heading: () => options.title,
    message: () => (count === 0 ? "Nothing to choose from" : ""),
    rows() {
      const { from, to } = windowFor(count, cursor, height);
      const rows = [];
      if (from > 0) rows.push(moreUp(from, colors));
      for (let index = from; index < to; index += 1) rows.push(row(index, index === cursor));
      if (to < count) rows.push(moreDown(count - to, colors));
      return rows;
    },
    settleRows: () => entries.map((_, index) => row(index, index === cursor)),
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
      return { value: values[cursor], summary: entries[cursor].label };
    },
  };
}

/**
 * 多选项的状态机（space 逐项切换，Ctrl+A 全选，a/n 清空/全选）。可搜索时
 * （`searchable: true`）单字符一律进入过滤词，列表随输入缩小，空格仍然切换
 * 当前项。回车只有在选中数达到 minSelected 时才落定 —— 一个都没选时回车是
 * 提示，不是「就这样吧」，也不是取消。
 */
function multiSelectModel(options, view) {
  const { width, colors } = view;
  const entries = options.options; // [{ value, label, hint }]
  const title = options.title;
  const searchable = options.searchable === true;
  const fixed = new Set(options.fixed ?? []); // 不能取消的条目（如唯一存储）
  const checked = new Set(options.initial ?? []);
  const minSelected = Math.max(0, options.minSelected ?? 0);
  const emptyMessage = options.emptyMessage ?? "Select at least one item";
  const height = Math.max(1, options.height ?? 12);
  let query = "";
  let cursor = 0;
  let validationMessage = "";
  let shown = entries;
  // heading 帧内和落定帧用的是同一行，所以它不带 ◇：符号由骨架加。
  const heading = () => (checked.size > 0 ? `${title} (${checked.size} selected)` : title);
  const row = (entry, marked) => entryRow({
    colors, width, label: entry.label, hint: entry.hint, checked: checked.has(entry.value), cursor: marked,
  });
  return {
    heading,
    message: () => validationMessage,
    rows() {
      shown = filterEntries(entries, query);
      cursor = Math.min(cursor, shown.length);
      const { from, to } = windowFor(shown.length, Math.min(cursor, Math.max(0, shown.length - 1)), height);
      const rows = [];
      if (from > 0) rows.push(moreUp(from, colors));
      for (let index = from; index < to; index += 1) rows.push(row(shown[index], index === cursor));
      if (to < shown.length) rows.push(moreDown(shown.length - to, colors));
      if (searchable) {
        const counter = shown.length !== entries.length ? `  (${shown.length}/${entries.length})` : "";
        rows.push(truncate(`${colors.muted("│")}  ${colors.brand("⌕")} ${query.length > 0 ? query : colors.muted("type to filter")}${colors.muted(counter)}`, width));
      }
      return rows;
    },
    settleRows: () => entries.filter((entry) => checked.has(entry.value)).map((entry) => row(entry, false)),
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
        value: values,
        summary: values.length === 1
          ? (entries.find((entry) => entry.value === values[0])?.label ?? String(values[0]))
          : `${values.length} selected`,
      };
    },
  };
}

/** 单选项选择（catalog select / 手动流中的任一单选）。 */
export function singleSelect(options = {}) {
  const width = columns(options.stdout ?? process.stdout);
  const colors = colorsFor(options, options.stdout ?? process.stdout);
  const footer = options.footer ?? "↑↓ move · enter select · esc cancel";
  const model = singleSelectModel(options, { width, colors });
  return prompt({ ...options, footer }, {
    heading: model.heading,
    paint() {
      return [
        ...frameHead({ colors, title: options.title, description: options.description, width }),
        ...model.rows(),
        ...frameFoot({ colors, footer, message: model.message(), width }),
      ];
    },
    reduce: model.reduce,
    accept() {
      const answer = model.accept();
      if (!answer) return null; // 没有可选项：回车留在原地，不是取消
      return { result: answer.value, lines: model.settleRows(), summary: answer.summary };
    },
  });
}

/** 多选项选择。同 singleSelect，模型见 multiSelectModel。 */
export function multiSelect(options = {}) {
  const searchable = options.searchable === true;
  const width = columns(options.stdout ?? process.stdout);
  const colors = colorsFor(options, options.stdout ?? process.stdout);
  const footer = options.footer ?? (searchable
    ? "type to filter · ↑↓ move · space toggle · ^a all · enter confirm · esc cancel"
    : "↑↓ move · space toggle · ^a all · enter confirm · esc cancel");
  const model = multiSelectModel(options, { width, colors });
  return prompt({ ...options, footer }, {
    heading: model.heading,
    paint() {
      return [
        ...frameHead({ colors, title: model.heading(), description: options.description, width }),
        ...model.rows(),
        ...frameFoot({ colors, footer, message: model.message(), width }),
      ];
    },
    reduce: model.reduce,
    accept() {
      const answer = model.accept();
      if (!answer) return null; // 留在这一帧，提示已经画在帧里
      return { result: answer.value, lines: model.settleRows(), summary: answer.summary };
    },
  });
}

// 向导的帧尾：一步之内只有移动和确认，回退键在每一帧里都写着。
const WIZARD_FOOTERS = {
  multi: "↑↓ move · space select · enter confirm · shift+tab back · esc cancel",
  single: "↑↓ move · enter confirm · shift+tab back · esc cancel",
};

/**
 * 向导：一串问题，一屏答完。
 *
 * 已经答过的步骤折叠成一行 ◇ 标题加一行灰色摘要，连续的轨道把整场问答画成
 * 一份可以回看的记录；当前步骤是唯一的展开项（◆ 标题 + 选项 + 帧尾）。Shift+Tab
 * 回到上一步并带着原来的答案重新打开，Esc / Ctrl+C 取消整场 —— 在按下 Apply
 * 里的 Yes 之前，什么都不写盘。
 *
 * 步骤由 `stepsFor(draft)` 现算：答完「哪些 agent」之后，后面的步骤就是这些
 * agent 的认证和存储。每条步骤：
 *   { id, kind: "multi"|"single", title, description, options,
 *     value(draft) / values(draft) —— 上一次的答案（回来时预选中）
 *     write(draft, value) —— 把答案记进草稿（只改内存）
 *     summary(draft) —— 折叠时那一行摘要
 *     footer, minSelected, emptyMessage, searchable, apply: true }
 * 被标了 `apply: true` 的那一步是终点：Yes 调用 `apply(draft)` 并落定，
 * No 取消（什么都不写）。它的答案不画成轨道条目，而是由落定帧的标题和 └ 行
 * 表示：标题 `appliedTitle`，└ 行是 `apply()` 返回的 `summary`。
 */
export function wizard(options = {}) {
  const { stdout = process.stdout } = options;
  const width = columns(stdout);
  const colors = colorsFor(options, stdout);
  const draft = options.draft ?? {};
  const stepsFor = options.stepsFor ?? (() => options.steps ?? []);
  const apply = options.apply ?? (async () => ({}));
  let steps = stepsFor(draft);
  let index = 0;
  let applied = false;
  const editors = new Map();
  const activeStep = () => steps[Math.min(index, Math.max(0, steps.length - 1))];
  const editorFor = (step) => {
    let model = editors.get(step.id);
    if (!model) {
      if (step.kind === "multi") {
        model = multiSelectModel(
          { ...step, initial: step.values?.(draft) ?? [] },
          { width, colors },
        );
      } else {
        const previous = step.value?.(draft);
        model = singleSelectModel(
          { ...step, initial: Math.max(0, step.options.findIndex((entry) => entry.value === previous)) },
          { width, colors },
        );
      }
      editors.set(step.id, model);
    }
    return model;
  };
  // 已答过的步骤：◇ 标题 + 一行摘要。传进来的是「已经答完的那一段」——画当前帧
  // 时是 steps[index] 之前的，落定时是全部（Apply 那一步由落定帧自己的标题和
  // └ 行表示，不重复成条目）。
  const completedRows = (list) => {
    const rows = [];
    for (const step of list) {
      if (step.apply) continue;
      rows.push(`${colors.brandSoft("◇")}  ${colors.strong(truncate(step.title, width - 4))}`);
      const summary = step.summary?.(draft);
      if (summary) rows.push(`${colors.muted("│")}  ${colors.muted(truncate(summary, width - 4))}`);
    }
    return rows;
  };
  return prompt({ ...options }, {
    heading: () => (applied ? (activeStep().appliedTitle ?? "Configuration applied") : activeStep().title),
    paint() {
      const active = activeStep();
      const model = editorFor(active);
      return [
        ...completedRows(steps.slice(0, index)),
        ...frameHead({ colors, title: active.title, description: active.description, width }),
        ...model.rows(),
        ...frameFoot({
          colors,
          footer: active.footer ?? WIZARD_FOOTERS[active.kind] ?? WIZARD_FOOTERS.single,
          message: model.message(),
          width,
        }),
      ];
    },
    reduce(intent) {
      if (intent === "back") {
        if (index === 0) return false; // 第一步没有上一步：不重画，也不动状态
        index -= 1;
        return true;
      }
      return editorFor(activeStep()).reduce(intent);
    },
    accept() {
      const active = activeStep();
      const model = editorFor(active);
      const answer = model.accept();
      if (!answer) return undefined; // 校验提示已经画在帧里：留在原地
      if (!active.apply) {
        active.write?.(draft, answer.value);
        steps = stepsFor(draft);
        const position = steps.findIndex((step) => step.id === active.id);
        index = Math.min(position + 1, Math.max(0, steps.length - 1));
        return { repaint: true };
      }
      if (answer.value !== true) return { cancel: true };
      applied = true;
      return apply(draft).then((outcome) => ({
        result: outcome?.result ?? draft,
        lines: completedRows(steps),
        summary: outcome?.summary,
      }));
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
      if (shown.length === 0) rows.push(`${colors.muted("│")}  ${colors.muted("no matches")}`);
      if (from > 0) rows.push(moreUp(from, colors));
      for (let index = from; index < to; index += 1) rows.push(row(shown[index], index === cursor));
      if (to < shown.length) rows.push(moreDown(shown.length - to, colors));
      const counter = shown.length !== entries.length ? `  (${shown.length}/${entries.length})` : "";
      rows.push(truncate(`${colors.muted("│")}  ${colors.brand("⌕")} ${query.length > 0 ? query : colors.muted("type to filter")}${colors.muted(counter)}`, width));
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
  const cursorLine = () => `${colors.muted("│")}  ${colors.cursor("▸")} ${value}${colors.brand("▏")}`;
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
      stdout.write(`\r\x1b[K${colors.success("✓")}  ${doneText}\n`);
    },
    fail(errorText) {
      clearInterval(timer);
      stdout.write(`\r\x1b[K${colors.error("✖")}  ${errorText}\n`);
    },
  };
}
