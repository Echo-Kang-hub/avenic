import { stat } from "node:fs/promises";
import { historyLabel, hookActionsPath, loadRuntime, projectConfig, runtimePaths } from "@avenic/core";
import { sentence, type TextKey } from "../i18n/text.ts";

// 设置与关于那一页的事实（无 vscode import，所以整页的判断不需要编辑器就能测）。
//
// 这一页不配置任何东西：它回答「这套安装是什么」与「这个项目的文件在哪里」。两条规矩：
//   1. 每个事实只有一个来源 —— 版本来自清单与已经探过的那一次 CLI 探测，路径来自 core，
//      历史的两个词来自 core 的 historyLabel。插件这一层一个都不编。
//   2. 一行可点的东西必须先由宿主解析出路径：页面递来的只是一个 key。所以 `reveal`
//      不写在数据里由页面自己判断 —— 它是这里算出来的（路径存在才算可点）。

export interface AboutOptions {
  /** 扩展自己的身份，直接来自它自己的清单（extension.packageJSON）。 */
  extension: { id: string; name: string; displayName: string; version: string };
  /** core 的版本：见 src/product.ts，构建时的那一个常量。 */
  coreVersion: string;
  /** 编辑器自己的版本（vscode.version）。 */
  editorVersion?: string | null;
  /** 这台机器上真正在用的那份 Avenic CLI —— 扩展已经探过一次，这一页不探第二次。 */
  cliVersion?: string | null;
  /** 这个配置文件（profile）下的扩展存储目录（context.globalStorageUri）。 */
  storagePath?: string | null;
  /** 编辑器自己的语言：这一页上的每一句话都按它说哪一半。 */
  language?: string;
}

/** One line of the page: a label, the fact, and whether the host can open what it names. */
export interface AboutRow {
  key: string;
  label: string;
  value: string;
  reveal: boolean;
}

export interface AboutFacts {
  rows: AboutRow[];
  /** The row that leaves the page: VS Code's own settings, filtered to this extension.
   *  查询字符串（@ext:…）留在宿主里，与 centerOpenDocs 的 URL 同一个道理。 */
  settings: { label: string };
}

const languageOf = (options: AboutOptions): string => options.language ?? "en";

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * 一个 key 指向什么。页面能点的那一行只递回 key；路径由这里算 —— 页面拿不到、
 * 也编不出一个要打开的文件。认不出的 key 一律 null，不做任何猜测。
 *
 * 它只收它真正用得到的那个事实（存储目录），所以宿主解析一次点击时不必先拼出整页的选项。
 */
export function aboutFileFor(projectRoot: string | null, key: string, storagePath: string | null): string | null {
  // 存储目录是「这个编辑器配置文件」的事，与打开没有项目无关。
  if (key === "storage") return storagePath;
  if (projectRoot === null) return null;
  if (key === "project") return projectRoot;
  if (key === "config") return runtimePaths(projectRoot).runtimeFile;
  if (key === "hooks") return hookActionsPath(projectRoot);
  return null;
}

export async function aboutFacts(projectRoot: string | null, options: AboutOptions): Promise<AboutFacts> {
  const language = languageOf(options);
  const rows: AboutRow[] = [];
  // 可点与否只由「宿主解析得出路径，而且那条路径真的在」决定：不存在的文件不给「显示」。
  const plain = (key: string, labelKey: TextKey, value: string) => rows.push({ key, label: sentence(language, labelKey), value, reveal: false });
  const openable = async (key: string, labelKey: TextKey, value: string) => {
    const file = aboutFileFor(projectRoot, key, options.storagePath ?? null);
    rows.push({ key, label: sentence(language, labelKey), value, reveal: file !== null && (await exists(file)) });
  };

  plain("extension", "about.extension", `${options.extension.displayName} ${options.extension.version}`);
  if (options.editorVersion) plain("editor", "about.editor", `Visual Studio Code ${options.editorVersion}`);
  plain("cli", "about.cli", options.cliVersion ?? sentence(language, "about.not-detected"));
  plain("core", "about.core", options.coreVersion);
  if (projectRoot === null) plain("project", "about.project", sentence(language, "about.no-project"));
  else await openable("project", "about.project", projectRoot);
  if (projectRoot !== null) {
    await openable("config", "about.config", runtimePaths(projectRoot).runtimeFile);
    await openable("hooks", "about.hooks", hookActionsPath(projectRoot));
    // 配置摘要只有一句话是这个项目自己的：历史是共享还是隔离。它只在配置真的写过之后
    // 才成为事实 —— 没写过的项目拿默认值当答案，就是替 core 编了一句它没说过的话。
    if (await exists(runtimePaths(projectRoot).runtimeFile)) {
      try {
        plain("history", "about.history", historyLabel(projectConfig(await loadRuntime(projectRoot)).historyMode));
      } catch { /* 读不动的配置文件不在这里报告：状态页会说它 */ }
    }
  }
  plain("logs", "about.logs", sentence(language, "about.logs-value"));
  const storage = options.storagePath ?? null;
  if (storage === null) plain("storage", "about.storage", sentence(language, "about.not-detected"));
  else await openable("storage", "about.storage", storage);
  return { rows, settings: { label: sentence(language, "about.vscode-settings") } };
}
