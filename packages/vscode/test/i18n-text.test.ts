import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { TEXT, both, chineseVisible, en, textScript, zh, type TextKey } from "../src/i18n/text.ts";

// 双语不是「每个界面各写一遍中英」——那样两半会各自漂移，这一屏有中文那一屏没有，
// 而且没有人能一次回答「这个产品一共说了多少句话」。所以词表只有一份，宿主读它，
// webview 也读它，两道闸门跟着它：每个键两种语言都在，以及每一个被用到的地方都指
// 向一个存在的键（拼错的键在英文下只显示键名，在中文下整句消失）。

const here = path.dirname(fileURLToPath(import.meta.url));
const media = path.resolve(here, "..", "media", "dashboard");
const pkg = path.resolve(here, "..");
const CJK = /[㐀-鿿]/;

test("every entry carries both languages, and neither is a copy of the other", () => {
  const entries = Object.entries(TEXT) as Array<[TextKey, { en: string; zh: string }]>;
  assert.ok(entries.length > 0);
  for (const [key, pair] of entries) {
    assert.match(key, /^[a-z][a-z0-9]*(\.[a-z0-9-]+)+$/, `${key} 的键名是 命名空间.名字`);
    assert.equal(pair.en.trim(), pair.en, `${key}: 英文两边不留空白`);
    assert.equal(pair.zh.trim(), pair.zh, `${key}: 中文两边不留空白`);
    assert.ok(pair.en.length > 0, `${key}: 缺英文`);
    assert.ok(pair.zh.length > 0, `${key}: 缺中文`);
    assert.ok(CJK.test(pair.zh), `${key}: 中文那一半得是中文`);
    assert.equal(CJK.test(pair.en), false, `${key}: 英文那一半不夹中文`);
    assert.notEqual(pair.en, pair.zh, `${key}: 两半不能一模一样（那是没翻译，不是双语）`);
  }
});

test("the readers answer with the half they promise", () => {
  assert.equal(en("nav.overview"), "Overview");
  assert.equal(zh("nav.overview"), "总览");
  assert.equal(both("nav.overview"), "Overview / 总览");
  // 编辑器是中文时中文才浮出来；其它语言下它待在 tooltip 里，不动主标签。
  assert.equal(chineseVisible("zh-cn"), true);
  assert.equal(chineseVisible("zh-TW"), true);
  assert.equal(chineseVisible("en"), false);
  assert.equal(chineseVisible("ja"), false);
});

test("what the webview is handed cannot break out of its own script tag", () => {
  const script = textScript("en");
  assert.match(script, /^globalThis\.AVENIC_TEXT = \{/);
  assert.match(script, /"zhVisible":false/);
  assert.equal(script.includes("<"), false);
  assert.match(textScript("zh-cn"), /"zhVisible":true/);
  // 注入的是数据，不是代码：整段里没有别的语句。
  const parsed = JSON.parse(script.slice("globalThis.AVENIC_TEXT = ".length, -1));
  assert.equal(parsed.text["nav.sessions"].en, "Sessions");
});

test("the template marks every label with a key, and every key exists", async () => {
  const html = await readFile(path.join(media, "view.html"), "utf8");
  const used = [...html.matchAll(/data-text="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(used.length >= 10, `侧栏与页头都得挂上键，实际只有 ${used.length} 个`);
  for (const key of used) assert.ok(key in TEXT, `view.html 用了不存在的键 ${key}`);
  // 静态英文仍在模板里：首帧要在数据到达之前就有字，而且它必须和词表一致。
  for (const match of html.matchAll(/data-text="([^"]+)"[^>]*>([^<]*)</g)) {
    assert.equal(match[2].trim(), en(match[1] as TextKey), `${match[1]} 的静态英文与词表不一致`);
  }
  // 词表由宿主注入，模板里只留一个槽。
  assert.match(html, /<script nonce="\{\{nonce\}\}">\{\{text\}\}<\/script>/);
});

test("the webview reads the table instead of spelling its own", async () => {
  const js = await readFile(path.join(media, "main.js"), "utf8");
  assert.match(js, /globalThis\.AVENIC_TEXT/);
  // 模板里的静态标题按 data-text 重描一遍，脚本里写死的中文/英文句子按 T("键") 取。
  assert.match(js, /\[data-text\]/);
  // 认的不是「哪个函数被调用」，而是键**长什么样**：键名有自己的文法（命名空间.名字，
  // 见上面第一条），而这个文法在 main.js 里不属于任何别的东西。所以凡是这么长的字符串
  // 就必须是表里的键——不管它是 T 的实参、TF 的实参、还是交给 label()/emptyState()/
  // cardHead() 的那个键。只认 T() 会漏掉后三种（它们不收句子，收键名），而漏掉的那种
  // 拼错时不报错：屏幕上直接出现 nav.sesions 这样的字。
  const keys = [...js.matchAll(/"([a-z][a-z0-9]*(?:\.[a-z0-9-]+)+)"/g)].map((match) => match[1]);
  assert.ok(keys.length > 0, "脚本里一个键都没有，说明整页还在写死");
  for (const key of keys) assert.ok(key in TEXT, `main.js 用了不存在的键 ${key}`);
});

test("the host fills the slot it promised", async () => {
  const panel = await readFile(path.join(pkg, "src", "dashboard", "panel.ts"), "utf8");
  assert.match(panel, /"\{\{text\}\}"/);
  assert.match(panel, /textScript\(/);
});

/** 只留字符串字面量里的字：注释和标识符里的中文不算「界面说了中文」。 */
function stringLiterals(source: string): string {
  const noBlocks = source.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "));
  return noBlocks.split("\n").map((line) => {
    let out = "";
    let quote: string | null = null;
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (quote === null) {
        if (char === "/" && line[i + 1] === "/") break;
        if (char === '"' || char === "'" || char === "`") quote = char;
        continue;
      }
      if (char === "\\") { out += line[i + 1] ?? ""; i += 1; continue; }
      if (char === quote) quote = null;
      else out += char;
    }
    return out;
  }).join("\n");
}

// 双语只有一份才叫双语：宿主代码里不该再有中文字面量。少了这道闸门，迁移只会做一次就退回
// 原样——新写的一句中文照样能编译、能跑、能过所有别的测试，只是永远不会说英文，而且没有
// 人会发现：英文界面上出现一行中文，测试是不看的。词表本身是中文唯一该住的地方。
test("no host source outside the layer spells its own Chinese", async () => {
  const offenders: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(file); continue; }
      if (!entry.name.endsWith(".ts") || file === path.join(pkg, "src", "i18n", "text.ts")) continue;
      // 行号按原样保留：报出来的位置就是要去改的那一行。
      stringLiterals(await readFile(file, "utf8")).split("\n").forEach((line, index) => {
        if (CJK.test(line)) offenders.push(`${path.relative(pkg, file).split(path.sep).join("/")}:${index + 1}`);
      });
    }
  };
  await walk(path.join(pkg, "src"));
  assert.deepEqual(offenders, [], `这些行还在自己说中文，把它们交给 src/i18n/text.ts：\n${offenders.join("\n")}`);
});
