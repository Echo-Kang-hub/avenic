import { watch as fsWatchNative } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { stateStampFile } from "@avenic/core";

// 项目的变化发生在面板之外：另一个终端的 `avenic claude` 退出了，一次启动结束了，
// 一场对话长了。core 把这三件事写进同一个小 stamp（`.agents/local/state.json`），
// 这个监视器只负责说「它可能变了」——stamp 的解释权在 core，一个会解释的监视器就是
// 第二份真相。所以回调不带参数：它是一声提醒，不是一次读数。

export interface WatcherLike {
  on(event: string, listener: (eventType: string, filename: string | null) => void): unknown;
  close(): void;
}

export interface StateWatchOptions {
  projectRoot: string;
  onChange: () => void;
  /** 兜底的询问间隔；0 表示不要兜底。 */
  pollMs?: number;
  debounceMs?: number;
  fsWatch?: (target: string, options?: { persistent?: boolean }) => WatcherLike;
}

export interface StateWatch {
  stop(): void;
}

const DEFAULT_DEBOUNCE_MS = 200;
type Watch = NonNullable<StateWatchOptions["fsWatch"]>;

/**
 * stamp 的文件与它沿途的每一层目录，从最深的一层开始。core 写它时整份换文件（先写
 * 临时文件再改名），所以盯着的必须是目录而不是文件句柄：被换掉的那个句柄在 Windows
 * 上从此不再有事件。
 */
function layers(projectRoot: string) {
  const file = stateStampFile(projectRoot);
  return { file, directories: [path.dirname(file), path.dirname(path.dirname(file)), projectRoot] };
}

/** 从最深的一层开始，找一个真的在的目录去盯。新项目里前两层可能都还不存在。 */
function deepestExisting(directories: string[], fsWatch: Watch) {
  for (const directory of directories) {
    try {
      return { watcher: fsWatch(directory, { persistent: false }), directory };
    } catch {
      // 这一层还没被建出来，往上一层看。
    }
  }
  return null;
}

/** 一条事件说的文件名是不是朝 stamp 走的那一格（`local`、`.agents` 这些中间层也算）。 */
function towardsStamp(directory: string, filename: string | null, file: string) {
  if (filename === null) return true;
  const relative = path.relative(directory, file);
  if (relative.startsWith("..")) return false;
  return relative.split(path.sep)[0] === filename;
}

export function watchProjectState(options: StateWatchOptions): StateWatch {
  const { projectRoot, onChange } = options;
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const pollMs = options.pollMs ?? 0;
  const fsWatch: Watch = options.fsWatch ?? ((target, watchOptions) => fsWatchNative(target, watchOptions) as unknown as WatcherLike);
  const paths = layers(projectRoot);

  let stopped = false;
  let watcher: WatcherLike | null = null;
  let watched: string | null = null;
  let debounce: NodeJS.Timeout | null = null;
  let interval: NodeJS.Timeout | null = null;
  let signature: string | null = null;
  let baseline = false;

  const fire = () => {
    if (stopped) return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = null;
      if (!stopped) onChange();
    }, debounceMs);
  };

  // 只盯一层：stamp 自己的目录在的话就它，不然是最近的一个长辈。层与层之间不求
  // 「层层都在」——目录被建出来的那一刻会有一个 rename 事件，那时再往里挪一层。
  const target = (preferred: string[] = paths.directories) => {
    const from = preferred.length > 0 ? preferred : paths.directories;
    return deepestExisting(from, fsWatch);
  };

  const open = () => {
    const found = target(watched ? [watched, ...paths.directories] : paths.directories);
    if (stopped || found === null) return;
    watcher = found.watcher;
    watched = found.directory;
    found.watcher.on("error", () => {
      // 事件源自己坏了（目录被删、句柄失效）：换一个，别把面板留在没消息的状态里。
      close();
      open();
    });
    found.watcher.on("change", (eventType, filename) => {
      // 盯着的可能是中间层（local 还没建出来的时候），只有朝 stamp 走的那一格算数：
      // `.agents/local` 下面还有项目自己的 agent home，整目录的动静不是我们的新闻。
      if (eventType !== "change" || towardsStamp(found.directory, filename, paths.file)) fire();
      // 目录刚被建出来：往更近的一层挪一次，之后的每一格才都是准的。
      if (eventType === "rename" && found.directory !== paths.directories[0]) {
        close();
        open();
      }
    });
  };

  const close = () => {
    watcher?.close();
    watcher = null;
    watched = null;
  };

  // 兜底：有的平台上事件不来，或者文件被换掉的方式让事件迟到。这里只读一个很小的
  // stamp 的 stat，且只有它真的变了才出声——安静的项目的每一秒都不该有代价。
  if (pollMs > 0) {
    const tick = async () => {
      if (stopped) return;
      let next: string | null = null;
      try {
        const info = await stat(paths.file);
        next = `${info.mtimeMs}:${info.ctimeMs}:${info.size}:${info.ino}`;
      } catch {
        next = null;
      }
      if (stopped) return;
      if (!baseline) {
        // 第一次只是立个底：面板自己的开场读盘不归这里管。
        baseline = true;
        signature = next;
        return;
      }
      if (next !== signature) {
        signature = next;
        fire();
      }
    };
    interval = setInterval(() => { void tick(); }, pollMs);
    interval.unref?.();
  }

  open();
  return {
    stop: () => {
      stopped = true;
      if (debounce) clearTimeout(debounce);
      if (interval) clearInterval(interval);
      debounce = null;
      interval = null;
      close();
    },
  };
}
