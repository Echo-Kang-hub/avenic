// Avenic 的品牌层：一个色板、一个 Logo、两种 banner。
//
// 色板是语义 token（brand / brandStrong / brandSoft / cursor / selected /
// selectedStrong / muted / text / strong / success / warning / error），全仓库
// 只有这一处 ANSI 数字；交互层（prompts.mjs）、结果页、转录视图都从这里取色。
// 主品牌是红橙：选中项、活动光标、◆/◇/▸/◉ 都用它；绿色只保留「成功/健康」
// 一条语义，不参与品牌视觉。颜色按终端能力逐级退化：TrueColor → 256 色 →
// 16 色；NO_COLOR、非 TTY、TERM=dumb 下所有 token 都是恒等函数，布局与字形
// 不变。
//
// Logo 是产品所有者固定的品牌资产：scripts/brand/avenic-logo.sh 是设计源，
// brand-logo.mjs 是它逐字节的静态常量。大字标模块是懒加载的——普通
// `avenic claude` 的快速路径（scripts/skills.mjs → launch.mjs）根本不经过这里，
// 其余命令也不会为大 Logo 付解析成本，直到真的要把它画出来。

const ANSI = /\x1b\[[0-9;]*m/g;

/** 是否给这个流上色：NO_COLOR / FORCE_COLOR 优先，其次看它是不是终端。 */
export function colorEnabled(stream = process.stdout, environment = process.env) {
  if (environment.FORCE_COLOR === "0") return false;
  if (typeof environment.NO_COLOR === "string" && environment.NO_COLOR !== "") return false; // NO_COLOR 规范：非空即关闭
  if (environment.FORCE_COLOR) return true;
  return stream?.isTTY === true && environment.TERM !== "dumb";
}

// 终端能画多少颜色：COLORTERM 是 TrueColor 的事实标准；TERM 里有 256 说明至少
// 256 色；其余按 16 色处理（亮黄/亮红组合）。
function colorDepth(environment = process.env) {
  const colorterm = String(environment.COLORTERM ?? "").toLowerCase();
  if (colorterm === "truecolor" || colorterm === "24bit") return "true";
  return /\b256(color)?\b/.test(String(environment.TERM ?? "")) ? "256" : "16";
}

// 品牌三色：同一个红橙在三种深度里的说法（#FF7A18 / #FF4D2E / #FF9E5E）。
const BRAND = { true: [38, 2, 255, 122, 24], 256: [38, 5, 208], 16: [93] };
const BRAND_STRONG = { true: [38, 2, 255, 77, 46], 256: [38, 5, 202], 16: [91] };
const BRAND_SOFT = { true: [38, 2, 255, 158, 94], 256: [38, 5, 215], 16: [93] };

/** 一套颜色函数；enabled 为 false 时每个函数都是恒等 —— 调用点不必分支。 */
export function paletteFor(enabled, environment = process.env) {
  const depth = colorDepth(environment);
  const wrap = (...codes) => (text) => (enabled ? `\x1b[${codes.join(";")}m${text}\x1b[0m` : String(text));
  const brand = (token, weight = []) => wrap(...weight, ...(token[depth] ?? token["16"]));
  return {
    enabled,
    brand: brand(BRAND),               // 品牌橙：分节、搜索、进度
    brandStrong: brand(BRAND_STRONG),  // 亮红橙：紧凑字标
    brandSoft: brand(BRAND_SOFT),      // 柔和橙：已落定的分节、收尾
    cursor: brand(BRAND_STRONG),       // ▸ 光标
    selected: brand(BRAND),            // ◉ 与选中行
    selectedStrong: brand(BRAND, [1]), // 光标处的选中行
    success: wrap(32),                 // 只有「成功/健康」用绿
    warning: wrap(33),
    error: wrap(31),
    text: (text) => String(text),      // 终端默认前景（暖白）
    strong: wrap(1),                   // 标题文本
    muted: wrap(2),                    // 次要信息、帮助、轨道
  };
}

export function palette(stream = process.stdout, environment = process.env) {
  return paletteFor(colorEnabled(stream, environment), environment);
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

// ---- 品牌 ----

/**
 * 完整 AVENIC 字标：12 行，逐字节就是设计源（scripts/brand/avenic-logo.sh）
 * 的输出——字形、字符、空格、行数与颜色都是品牌资产，一个字符都不改。颜色
 * 不经过色板：NO_COLOR 时只是把 ANSI 剥掉，字形与排版不变。终端装不下时退回
 * 紧凑品牌行——让路的该是字标，不是布局。brand-logo.mjs（约 6KB 静态常量）
 * 在这里动态加载：不画大 Logo 的命令不为它付解析成本。
 */
export async function fullLogo(stdout = process.stdout, options = {}) {
  const { LOGO_LINES } = await import("./brand-logo.mjs");
  const colour = options.color === true || (options.color !== false && colorEnabled(stdout, options.environment ?? process.env));
  const artWidth = Math.max(...LOGO_LINES.map((line) => displayWidth(line)));
  if (columns(stdout) < artWidth + 2) {
    compactBrand(stdout, options);
    return;
  }
  const lines = colour ? LOGO_LINES : LOGO_LINES.map((line) => line.replace(ANSI, ""));
  stdout.write(`${lines.join("\n")}\n\n`);
}

/**
 * 紧凑品牌行：状态页、self-update 这些不占 12 行的页面，用一行说「这是 Avenic」。
 * 字标本身永远不缩水——要么完整，要么用这行代替。
 */
export function compactBrand(stdout = process.stdout, options = {}) {
  const colors = options.colors ?? palette(stdout, options.environment ?? process.env);
  const width = columns(stdout);
  const title = options.title ? `${colors.muted(" · ")}${colors.strong(truncate(options.title, width - 12))}` : "";
  stdout.write(`${colors.brandStrong("AVENIC")}${title}\n`);
  if (options.description) {
    stdout.write(`${colors.muted("│")}  ${colors.muted(truncate(options.description, width - 4))}\n`);
  }
}
