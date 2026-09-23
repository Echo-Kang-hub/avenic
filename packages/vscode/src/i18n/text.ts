// Every word the extension puts in front of a person, in both languages it puts
// them in.
//
// One table, two readers. The extension host imports it and hands a string to a
// QuickPick or a notification; the dashboard receives the same table as a script
// (`view.html` carries a `{{text}}` slot) and reads it from `globalThis`. A
// screen translated only at its edges is worse than an English screen, so there
// is no second place to write a sentence: a key that is missing here fails the
// suite rather than falling back to something nobody wrote.
//
// English is the canonical label and stays the primary one everywhere — the
// product's terms of art (Authentication, Shared Sessions, Configure) are the
// English words, in both locales. Chinese rides along as the weaker half of a
// pair: dimmed text in a host UI, a tooltip and accessible name in the webview,
// and visible secondary text only when the editor itself is in Chinese.
export type TextPair = { readonly en: string; readonly zh: string };

export const TEXT = {
  // — The shell. The sidebar is the one place with room for both halves at once:
  // `Overview` above `总览`, the way the goal describes a bilingual nav.
  "nav.overview": { en: "Overview", zh: "总览" },
  "nav.configure": { en: "Configure", zh: "配置" },
  "nav.agents": { en: "Agents", zh: "Agents 与认证" },
  "nav.sessions": { en: "Sessions", zh: "会话" },
  "nav.skills": { en: "Skills", zh: "技能" },
  "nav.quick": { en: "Quick Actions", zh: "快捷操作" },
  "nav.documentation": { en: "Documentation", zh: "文档" },
  "nav.settings": { en: "Settings", zh: "设置" },
  "nav.aria": { en: "Avenic sections", zh: "Avenic 分区" },
  "brand.tagline": { en: "AI Workflows. Yours.", zh: "AI 工作流，属于你。" },
  "shell.ready": { en: "Ready", zh: "就绪" },
  "shell.configured": { en: "Avenic Configured", zh: "Avenic 已配置" },
  "shell.refresh": { en: "Refresh", zh: "刷新" },
  "shell.reconfigure": { en: "Reconfigure", zh: "重新配置" },
  "shell.project": { en: "Project", zh: "项目" },
  "shell.project-line": { en: "Project: {name}", zh: "项目：{name}" },
  "shell.no-project": { en: "No project open", zh: "没有打开项目" },
  "shell.not-configured": { en: "Not Configured", zh: "未配置" },
  "shell.last-updated": { en: "Last updated: {at}", zh: "最后更新：{at}" },
  "shell.reading": { en: "Reading the project…", zh: "正在读取项目…" },
  "shell.read-failed": { en: "Could not read the project", zh: "读不到这个项目" },
  "shell.not-set-up": { en: "Avenic is not set up here", zh: "这里还没有配置 Avenic" },
  "shell.no-folder": { en: "No project folder is open", zh: "没有打开任何项目文件夹" },
  "shell.initialize": { en: "Initialize Avenic", zh: "初始化 Avenic" },
  "shell.open-folder": { en: "Open Folder", zh: "打开文件夹" },
  "shell.project-path-title": { en: "Reveal this project in the file manager", zh: "在文件管理器中显示这个项目" },
  "shell.noscript": { en: "The dashboard needs JavaScript to read the project.", zh: "仪表盘需要 JavaScript 才能读取项目。" },
  // 一次启动跑着没跑着：core 只有这两档（再加上不说话的那一档 idle）。
  "run.running": { en: "Running", zh: "运行中" },
  "run.interrupted": { en: "Interrupted", zh: "已中断" },
  "cli.missing": { en: "Avenic CLI not on PATH", zh: "PATH 里没有 Avenic CLI" },
  "cli.extension-version": { en: "VS Code extension {version}", zh: "VS Code 扩展 {version}" },
} as const satisfies Record<string, TextPair>;

/**
 * A sentence with a hole in it (`Project: {name}`). The hole keeps its place in
 * both languages, so the caller never assembles grammar out of fragments — the
 * full-width colon in Chinese is inside the sentence, where it belongs.
 */
export function fill(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, String(value)), template);
}

export type TextKey = keyof typeof TEXT;

/** The canonical label. Every host reads this one. */
export function en(key: TextKey): string {
  return TEXT[key].en;
}

/** The weaker half of the pair — never a label on its own. */
export function zh(key: TextKey): string {
  return TEXT[key].zh;
}

/** `Overview / 总览` — a tooltip or accessible name that holds both. */
export function both(key: TextKey): string {
  return `${TEXT[key].en} / ${TEXT[key].zh}`;
}

/**
 * The editor's own language decides how loudly Chinese speaks. In a Chinese
 * editor the second half is visible text; in any other it waits in the tooltip,
 * because the canonical English label is the one that must never be crowded out.
 */
export function chineseVisible(language: string): boolean {
  return language.toLowerCase().startsWith("zh");
}

/**
 * The script `{{text}}` becomes. `</script>` cannot appear inside a JSON string
 * literal here, and the table holds no HTML at all, but the escaping is cheap
 * and the failure it prevents is a broken page.
 */
export function textScript(language: string): string {
  const payload = JSON.stringify({ text: TEXT, zhVisible: chineseVisible(language) }).replaceAll("<", "\\u003c");
  return `globalThis.AVENIC_TEXT = ${payload};`;
}
