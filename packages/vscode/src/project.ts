import { isInside } from "@avenic/core";

export const PROJECT_ROOT_STATE_KEY = "avenic.projectRoot";

export interface WorkspaceFolderLike {
  uri: { fsPath: string };
}

export interface StateLike {
  get(key: string): unknown;
  update(key: string, value: unknown): Thenable<unknown>;
}

export function resolveProjectRoot(folders: readonly WorkspaceFolderLike[]): string | null {
  if (folders.length === 1) return folders[0].uri.fsPath;
  // 0 个或多根：交给调用方（多根走 QuickPick；无根时命令提示打开文件夹）
  return null;
}

export function rememberProjectRoot(state: StateLike, root: string): void {
  void state.update(PROJECT_ROOT_STATE_KEY, root);
}

export function lastProjectRoot(state: StateLike): string | null {
  const value = state.get(PROJECT_ROOT_STATE_KEY);
  return typeof value === "string" && value.length > 0 ? value : null;
}

// win32 大小写不敏感的比较（已记忆的根与工作区列表仅大小写差异时仍命中快路径，避免强迫重选）
export function sameRootPath(a: string, b: string, platform: NodeJS.Platform): boolean {
  if (platform === "win32") return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

// 记忆根经当前工作区文件夹列表校验后才算有效（stale/移除的文件夹不返回）
export function rememberedProjectRoot(folders: readonly WorkspaceFolderLike[], state: StateLike, platform: NodeJS.Platform = process.platform): string | null {
  const last = lastProjectRoot(state);
  if (last !== null && folders.some((f) => sameRootPath(f.uri.fsPath, last, platform))) return last;
  return null;
}

// 多根时优先用 active editor 所属的 workspace folder（用户当下正在编辑哪个项目，就用哪个）。
// 绝不静默取 folders[0]；匹配不到返回 null，由调用方继续走"记忆根 → QuickPick"。
//
// 归属判定交给 core 的 isInside，不再手写前缀比较：手写的版本在尾分隔符根（/work/b/）
// 与文件系统根（/ 与 C:\）上都会漏判——它取根后面的第一个字符做分隔符判断，而那里的
// 字符属于下一级路径名。大小写由宿主路径语义决定（win32 不敏感），因此不再注入 platform。
export function projectRootForActiveEditor(
  folders: readonly WorkspaceFolderLike[],
  activeUri: string | undefined,
): string | null {
  if (activeUri === undefined || folders.length === 0) return null;
  let best: string | null = null;
  for (const folder of folders) {
    const root = folder.uri.fsPath;
    const owns = sameRootPath(root, activeUri, process.platform) || isInside(root, activeUri);
    if (owns && (best === null || root.length > best.length)) best = root;
  }
  return best;
}
