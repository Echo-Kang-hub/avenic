import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SECTIONS, isWebviewMessage } from "../src/dashboard/protocol.ts";

// 面板的静态层守着自己的四条纪律：不请求远程资源（CSP 里没有远程来源）、用户数据
// 不经 innerHTML、发出的消息都是宿主认识的、用到的图标都有字形。这些都是「肉眼看不
// 出来但一坏就整块失灵」的东西：一个拼错的 action 在两端都写对的时候才会显形。

const media = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "media", "dashboard");
const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function read(part: string): Promise<string> {
  return readFile(path.join(media, part), "utf8");
}

test("html has no remote resources, carries CSP nonce placeholder and allows local font", async () => {
  const html = await read("view.html");
  assert.ok(!/https?:\/\//.test(html)); // 无远程
  assert.match(html, /nonce="[^"]+"/);
  assert.match(html, /content-security-policy/i);
  assert.match(html, /font-src\s+\{\{cspSource\}\}/); // 随包 codicon.ttf 需 font-src 放行
});

test("the brand mark is a placeholder the host fills in, never a path of our own", async () => {
  const html = await read("view.html");
  // 运行时不得引用开发机路径，也不得把图标塞成 data: URI：两种做法都会让 VSIX 里
  // 的副本形同虚设（前者在本机恰好能看见，后者把资源写死在页面里）。
  assert.match(html, /<img class="side-brand-mark" src="\{\{iconUri\}\}"/);
  assert.ok(!/file:\/\//.test(html));
  assert.ok(!/[A-Za-z]:[\\/]/.test(html));
  assert.ok(!/data:image\//.test(html));
  // 品牌锁定区：图标 + AVENIC + 标语，与参考图同一结构。
  assert.match(html, /side-brand-name">AVENIC</);
  assert.match(html, /side-brand-tag">AI Workflows\. Yours\.</);
});

test("the shell is static html, so the first paint does not wait for data", async () => {
  const html = await read("view.html");
  const js = await read("main.js");
  // 侧栏与内容容器都在模板里；脚本只往里填（render() 第一句就是取这两个节点）。
  assert.match(html, /<aside class="sidebar">/);
  assert.match(html, /<div class="content" id="content">/);
  assert.match(js, /getElementById\("content"\)/);
  assert.match(js, /getElementById\("nav"\)/);
});

test("the footer's version is the CLI's, and the tooltip names both versions", async () => {
  const html = await read("view.html");
  const js = await read("main.js");
  // 底部那一行是「Avenic v<CLI>」；探不到就只写 Avenic，不写一个空着的 v。
  assert.match(js, /`Avenic v\$\{data\.version\}`/);
  assert.match(js, /data\.version \? .* : "Avenic"/s);
  assert.match(html, /id="version-line"><span id="version">Avenic</);
  // 扩展自己的版本必须可查，但不占底部那一行：悬停时和 CLI 的一起说。两句话都在
  // 词表里（键在这儿，句子在 i18n/text.ts），这里只钉住它们被用上了。
  assert.match(js, /versionDetails/);
  assert.match(js, /T\("cli\.missing"\)/);
  assert.match(js, /TF\("cli\.extension-version", \{ version: details\.extension \}\)/);
});

test("render code never assigns user data via innerHTML", async () => {
  const js = await read("main.js");
  assert.ok(!/\.innerHTML\s*=/.test(js));
  assert.ok(/textContent/.test(js));
});

test("style uses vscode theme variables and bundles the codicon font locally", async () => {
  const css = await read("style.css");
  assert.ok(/--vscode-/.test(css));
  assert.match(css, /@font-face/);
  assert.match(css, /url\("\.\/codicon\.ttf"\)/); // 随包字体，不请求远程
  // 回归：不依赖 VS Code 注入 --vscode-icon-*（并非真实机制 → 图标恒不可见 → 按钮文字被挤偏）
  assert.ok(!css.includes("var(--vscode-icon-"), "不得再引用不存在的外部注入图标变量");
  await access(path.join(media, "codicon.ttf"));
});

test("the packaged media names no path of its own", async () => {
  for (const part of ["view.html", "main.js", "style.css"]) {
    const text = await read(part);
    assert.ok(!/file:\/\//.test(text), `${part} 不得引用 file:// URL`);
    assert.ok(!/[A-Za-z]:\\\\/.test(text), `${part} 不得引用开发机的绝对路径`);
  }
});

// 宿主只认识协议里列出的 action，其它一概丢弃。所以「渲染层能发的」必须是「宿主
// 会接的」——两边各写各的名单，拼错的那一个会在用户点下去时静默消失。渲染层发得出
// 动作的地方有两处：脚本里的字面量，以及模板里带 data-action 的侧栏条目。
function postedActions(js: string, html: string): string[] {
  const names = new Set([...js.matchAll(/action:\s*"([A-Za-z][A-Za-z0-9]*)"/g)].map((m) => m[1]!));
  // 「配置过了就重配、没配置过就初始化」是同一个按钮的两种答话，两个名字都要算数：
  // 分辨它们的是数据，不是哪一支代码长得像主路。少算一支，反方向那道题就会把
  // 另一个名字报成没人用的死条目。
  for (const m of js.matchAll(/action:\s*[^,;\n]*?\?\s*"([A-Za-z][A-Za-z0-9]*)"\s*:\s*"([A-Za-z][A-Za-z0-9]*)"/g)) {
    names.add(m[1]!);
    names.add(m[2]!);
  }
  for (const m of html.matchAll(/data-action="([A-Za-z][A-Za-z0-9]*)"/g)) names.add(m[1]!);
  return [...names].sort();
}

// 每个 action 需要一个形状正确的样本：协议校验的不是名字，是名字加它带的参数。
const SAMPLES: Record<string, Record<string, unknown>> = {
  launch: { agent: "claude" },
  change: { agent: "claude" },
  openConfig: { agent: "claude" },
  continueNative: { agent: "claude", id: "abc123" },
  continueShared: { id: "abc123" },
  viewSession: { id: "abc123" },
  setActive: { id: "abc123" },
  importSkill: {},
  manageSkills: {},
  installPack: { pack: "release-kit" },
  syncHub: {},
  viewLogs: {},
  switchHistory: {},
  initialize: {},
  reconfigure: {},
  openProject: {},
  revealProject: {},
  openFolder: {},
  openInTerminal: {},
  openDocs: {},
  openSettings: {},
};

test("every action the renderer posts is one the host accepts", async () => {
  const posted = postedActions(await read("main.js"), await read("view.html"));
  assert.ok(posted.length >= 10, `解析本身没跑偏：读到 ${posted.length} 个动作`);
  for (const name of posted) {
    const sample = SAMPLES[name];
    assert.ok(sample !== undefined, `渲染层发的 ${name} 不在样本表里（要么改对名字，要么补上样本）`);
    assert.ok(isWebviewMessage({ type: "action", action: name, ...sample }), `宿主会丢弃 ${name}`);
  }
});

test("every action the host accepts has a way in from the renderer", async () => {
  // 反方向：只有协议没有入口的动作是死条目——它在类型里存在，用户永远点不到，
  // 于是没人会发现它其实从没跑通过。
  const protocol = await readFile(path.join(pkgDir, "src", "dashboard", "protocol.ts"), "utf8");
  const declared = [...new Set([...protocol.matchAll(/\bcase "([A-Za-z][A-Za-z0-9]*)":/g)].map((m) => m[1]!))];
  assert.ok(declared.length >= 10, `解析本身没跑偏：协议里有 ${declared.length} 个动作`);
  const posted = new Set(postedActions(await read("main.js"), await read("view.html")));
  for (const name of declared) {
    assert.ok(posted.has(name), `协议里的 ${name} 没有任何按钮会发它`);
  }
});

test("the sections the renderer navigates to are the ones the protocol knows", async () => {
  const js = await read("main.js");
  const navigated = [...new Set([...js.matchAll(/section:\s*"([a-z]+)"/g)].map((m) => m[1]!))];
  assert.ok(navigated.length > 0);
  for (const section of navigated) {
    assert.ok((SECTIONS as readonly string[]).includes(section), `${section} 不是合法分区`);
    assert.ok(isWebviewMessage({ type: "navigate", section }), `宿主会丢弃 navigate → ${section}`);
  }
  // 模板里的导航项也必须是真分区：写错的那一个点下去只会回到默认页。
  const html = await read("view.html");
  const template = [...html.matchAll(/data-section="([a-z]+)"/g)].map((m) => m[1]!);
  assert.ok(template.length > 0);
  for (const section of template) assert.ok((SECTIONS as readonly string[]).includes(section), `侧栏的 ${section} 不是合法分区`);
});

test("every icon name used by the media has a style.css glyph mapping", async () => {
  const js = await read("main.js");
  const css = await read("style.css");
  const names = new Set<string>();
  for (const m of js.matchAll(/icon\(\s*"([a-z][a-z0-9-]*)"/g)) names.add(m[1]!);
  for (const m of js.matchAll(/iconName:\s*"([a-z][a-z0-9-]*)"/g)) names.add(m[1]!);
  // 模板里的图标是写死的 data-icon；渲染层创建的走 icon()。两边都得有字形。
  const html = await read("view.html");
  for (const m of html.matchAll(/data-icon="([a-z][a-z0-9-]*)"/g)) names.add(m[1]!);
  assert.ok(names.size > 0);
  for (const name of names) {
    assert.ok(css.includes(`.icon[data-icon="${name}"]::before`), `缺少图标字形映射：data-icon="${name}"`);
  }
});

test("compressed dashboard keeps agent identity via inline SVG marks", async () => {
  const js = await read("main.js");
  // 品牌标记：inline SVG（createElementNS），无远程资源、不经 innerHTML
  assert.match(js, /createElementNS/);
  assert.match(js, /agentMark/);
  assert.ok(js.includes('agentId === "claude"'));
  assert.ok(js.includes('agentId === "codex"'));
  assert.ok(!/\.innerHTML\s*=/.test(js)); // 品牌标记同样不经 innerHTML
  // 三个标记都是**各自品牌的真形状**：claude 是 12 道等长、每 30° 一道的光芒（参考图
  // 里用极坐标量得出来：每道到中心 17px，缝里最深只到 6px），codex 是真结（描外轮廓
  // 只剩一朵花），opencode 是两环在中间交叉成一根线的无穷号（不是两个相切的圆）。颜
  // 色随上下文变（卡片里一律白色，其他地方是各自的本色），所以都取 currentColor。
  const sunburst = js.match(/const CLAUDE_RAYS = "([^"]+)"/)?.[1];
  assert.ok(sunburst, "claude 的光芒是一条自己的路径数据");
  const rays = sunburst.split("M").filter(Boolean).map((ray) => {
    const [, x, y] = ray.match(/^8 8L([\d.]+) ([\d.]+)$/) ?? [];
    assert.ok(x && y, `这道光芒不是从中心发出的直线：M${ray}`);
    return { reach: Math.hypot(Number(x) - 8, Number(y) - 8), angle: (Math.atan2(Number(x) - 8, 8 - Number(y)) * 180) / Math.PI };
  });
  assert.equal(rays.length, 12, "参考图里的光芒是 12 道");
  for (const [index, ray] of rays.entries()) {
    assert.ok(Math.abs(ray.reach - rays[0]!.reach) < 0.01, `第 ${index + 1} 道与第一道不同长：${ray.reach} vs ${rays[0]!.reach}`);
    const step = (ray.angle + 360) % 30;
    assert.ok(step < 0.01 || step > 29.99, `第 ${index + 1} 道不在 30° 的刻度上：${ray.angle}°`);
  }
  // codex 的结是填充画出来的：这个 logo 的编织是镂空，描外轮廓只会得到一团剪影。
  assert.match(js, /const CODEX_KNOT = "M22\.2819 9\.8211/);
  // 钉的是画这个结的那次调用本身：从 CODEX_KNOT 到它的 } 之间只许有 d 和 fill。原来的
  // 写法（在 80 个字符里找 "stroke:"）永远为真——那段距离里根本没有 stroke 可给。
  const knot = js.match(/svgNode\("path", \{ d: CODEX_KNOT[^}]*\}\)/);
  assert.ok(knot, "codex 的路径是以 CODEX_KNOT 为数据画出来的");
  assert.ok(!/stroke/.test(knot[0]), `结是实心的，描边会多出一圈轮廓：${knot[0]}`);
  // opencode 的无穷号是一根在中心交叉的线：两个圆相交画出来是「两个圆」，不是 ∞。
  assert.match(js, /const OPENCODE_LOOP = "M12 12C/);
  assert.match(js, /d: OPENCODE_LOOP,\s*"stroke-width": "2\.6",\s*"stroke-linecap": "round"\s*\},\s*stroke\)/);
  assert.ok(!/for \(const cx of/.test(js), "双圆拼不出中心的交叉");
  assert.match(js, /stroke: "currentColor"/);
  assert.match(js, /fill: "none"/);
  // 连字符属性（stroke-width 等）经 setAttribute 写入
  assert.match(js, /createElementNS\(SVG_NS, tag\)[\s\S]{0,120}setAttribute\(key, value\)/);
  // 颜色在样式表里，一处例外在卡片内：agent-mark 里三个标记都是白色。
  const css = await read("style.css");
  assert.match(css, /\.mark-claude\s*\{[^}]*color:/);
  assert.match(css, /\.agent-mark \.mark\s*\{[^}]*color:\s*#ffffff/);
  // 大小也来自参考图：光芒的墨迹 34px、结 38px、无穷号 44×22px（都在 46px 的格子里）。
  assert.match(css, /\.agent-mark\.claude svg\s*\{[^}]*width:\s*36px/);
  // 结的路径画满自己的画布（墨迹 ≈ 0.99 个 viewBox），所以 46px 的 svg 会在 46px 的格子里
  // 顶到边。参考图里的结是 38×39px，比光芒大一点、不贴边，svg 要按比例收到 38.6px。
  assert.match(css, /\.agent-mark\.codex svg\s*\{[^}]*width:\s*38\.6px/);
});

test("the activity list is the reference's own two column widths", async () => {
  const css = await read("style.css");
  // 参考图里这一块不是一列通栏：两条分栏横线分别画在 image x899..1178 与 1196..1508，
  // 卡片本身是 886..1521——所以列宽是量出来的 279 与 312（内宽 609），中间 18px 空隙，
  // 两侧各让开 13px。时间靠各自那一列的右边缘对齐（实测两行时间右端同为 1166/1490，
  // 与列宽差无关），所以列宽一旦写错，时间整列就跟着错，而它是最显眼的那一列。
  assert.match(css, /\.activity-list\s*\{[^}]*grid-template-columns:\s*minmax\(0, 279fr\)\s*minmax\(0, 312fr\)/);
  assert.match(css, /\.activity-list\s*\{[^}]*column-gap:\s*18px/);
  assert.match(css, /\.activity-list\s*\{[^}]*padding:\s*0 13px/);
  // 13（列表）+4（行）= 卡片边往里 17px 才是那颗点，正是参考图的 903。
  assert.match(css, /\.activity-row\s*\{[^}]*padding:\s*0 12px 0 4px/);
});

test("the renderer reads the host's own fields rather than inventing labels", async () => {
  const js = await read("main.js");
  // 状态胶囊与「谁配置了什么」都由宿主给（statusText / fields），渲染层不自己判断
  // Ready 还是 Unavailable——那是 core 的结论，不是界面的猜测。
  assert.match(js, /agent\.statusText/);
  assert.ok(!/agent\.ready \? "Ready"/.test(js), "不得由渲染层自己拼状态文案");
  assert.match(js, /agent\.fields/);
});

test("images come from the extension's own resources and nowhere else", async () => {
  const html = await read("view.html");
  // 品牌图标经 asWebviewUri 进来，CSP 就只放行这一处来源：`data:` 一旦被放行，
  // 「图标塞成 data: URI」这条更省事的路随时会被走回去，而那样 VSIX 里的副本就成了摆设。
  assert.match(html, /img-src \{\{cspSource\}\};/);
  assert.ok(!/img-src[^;]*data:/.test(html), "img-src 不得放行 data:");
  assert.ok(!/img-src[^;]*https:/.test(html), "img-src 不得放行远程");
  assert.match(html, /<img class="side-brand-mark" src="\{\{iconUri\}\}"/);
});

test("the registry line keeps core's three answers apart", async () => {
  const js = await read("main.js");
  // 「从未同步」「落后于项目钉住的那一版」「同步过」是三种状态，两个布尔说不清；
  // 宿主把 core 的三态原样传来，渲染层就必须把三种都说出来。
  assert.match(js, /data\.hub\.state === "current"/);
  assert.match(js, /· up to date/);
  assert.match(js, /· stale/);
  assert.match(js, /Never synced/);
  // 按钮跟着状态走：已经是当前那一份时说「再同步一次」，否则说「同步」。
  assert.match(js, /data\.hub\.state === "current" \? "Sync again" : "Sync"/);
});

test("a skill's name is the card's own type, in the width the reference gives it", async () => {
  const css = await read("style.css");
  // 参考图里三行技能名的墨迹宽 75 / 56 / 60px（13 / 11 / 11 个字符）——同字数不同宽，
  // 说明它不是等宽字；墨迹里只有 40% 的像素接近纯白，而加粗的同一句话是 72%，说明它
  // 也不是粗体。此前我们用等宽粗体，13 个字符要 81px，84px 的列窗放不下 "code-reviewer"，
  // 于是参考图里完整的那一行在我们这里被截成 "code-revie…"。
  assert.match(css, /\.skill-name\s*\{[^}]*width:\s*84px/);
  assert.ok(!/\.skill-name\s*\{[^}]*font-family:\s*var\(--av-font-mono\)/.test(css), "技能名是比例字体，不是等宽");
  assert.ok(!/\.skill-name\s*\{[^}]*font-weight:\s*(700|bold)/.test(css), "技能名不加粗");
});

test("the state dots the payload can ask for all have a colour", async () => {
  const css = await read("style.css");
  const js = await read("main.js");
  // 点的颜色来自宿主给的 tone（字段行）与活动日志的 tone，所以两者能取的每一档都得
  // 有规则——少一档就是「一个不说话的空心点」，而它在参考图里是有颜色的。
  assert.match(js, /el\("span", "dot " \+ field\.tone\)/, "状态点带着宿主给的 tone 上屏");
  for (const tone of ["brand", "blue", "purple", "green", "muted"]) {
    assert.ok(css.includes(`.dot.${tone}`), `缺少 .dot.${tone}`);
  }
  for (const tone of ["brand", "blue", "purple", "muted"]) {
    assert.ok(css.includes(`.activity-dot.${tone}`), `缺少 .activity-dot.${tone}`);
  }
  // 列表卡片底部那句「列了多少、总共有多少」也要有样式，否则它会长成下一行的正文。
  assert.ok(css.includes(".foot-note"), "缺少清单页脚注样式");
});

test("the packaged brand mark is the real icon, with its transparency intact", async () => {
  const icon = await readFile(path.join(pkgDir, "media", "avenic.png"));
  // PNG 头：宽 16..19、高 20..23、颜色类型 25（6 = RGBA）。面板左上角那块深色底上，
  // 透明必须真的透明——没有 alpha 通道的图标会是一块带背景色的方片。
  assert.equal(icon.subarray(1, 4).toString("latin1"), "PNG", "品牌图标必须是 PNG");
  const width = icon.readUInt32BE(16);
  const height = icon.readUInt32BE(20);
  assert.equal(icon[25], 6, "品牌图标必须带 alpha 通道");
  assert.ok(width >= 256 && height >= 256, `高 DPI 下要够清晰，当前 ${width}×${height}`);
  // 市场页那一枚与活动栏那一枚也是真资源：package.json 指的是它们，指错就是空图标。
  const manifest = JSON.parse(await readFile(path.join(pkgDir, "package.json"), "utf8")) as { icon?: string; contributes: { viewsContainers: { activitybar: Array<{ icon: string }> } } };
  await access(path.join(pkgDir, manifest.icon ?? "media/icon.png"));
  for (const container of manifest.contributes.viewsContainers.activitybar) {
    await access(path.join(pkgDir, container.icon));
  }
  // 旧资产不再被任何地方引用：图标只有一处来源，留着的那份就是唯一的它。
  const html = await read("view.html");
  assert.ok(!/Avenic\.png/.test(html) && !/logo/i.test(html), "模板里不得再有第二个品牌标记");
});

test("the header's title and path each ellipsise in their own column", async () => {
  const css = await read("style.css");
  // 真实窗口里量出来的那一场：编辑器区窄下来、项目路径又长的时候，路径曾经画到
  // 状态块上面去（两行字叠在一起）。裁编写在真正装着字的那一层——`.proj-path`
  // 是按钮、路径在它的 span 里，只给按钮写 text-overflow 是写给一个没有直接文字的
  // 元素。这一条钉住的是那次的修法本身。
  const block = (selector: string) => {
    const at = css.indexOf(selector);
    assert.ok(at >= 0, `样式表里没有 ${selector}`);
    return css.slice(at, css.indexOf("}", at));
  };
  for (const [selector, key] of [["\n.proj-title {", "标题"], ["\n.proj-path #project-root {", "路径那一格"]] as const) {
    const rule = block(selector);
    assert.match(rule, /white-space:\s*nowrap/, `${key}不得换行`);
    assert.match(rule, /overflow:\s*hidden/, `${key}要真的裁掉超出的部分`);
    assert.match(rule, /text-overflow:\s*ellipsis/, `${key}超出时要给出省略号`);
  }
  // 路径那一格是 flex 项：默认 min-width:auto 会拒绝收窄，省略号就永远不出现。
  assert.match(block("\n.proj-path #project-root {"), /min-width:\s*0/);
  // 而且这个配方不再挂在窄窗口的媒体查询里——它曾经只在那里，宽一点的窗口就叠字。
  const narrow = css.slice(css.indexOf("@media (max-width: 1180px)"));
  assert.ok(!/\.proj-title[^{]*\{[^}]*text-overflow/.test(narrow), "裁剪不该只在窄窗口生效");
});
