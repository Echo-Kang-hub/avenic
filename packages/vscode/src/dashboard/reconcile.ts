// 项目的变化来到面板时，要回答的不是「变了没有」，而是「变了多少」：一场会话长长了
// （列表上多一行、换了时间、换了当前会话）要重列，而一次启动的开始与结束只动状态那一
// 行——后者重画整页，正在读的人会看见自己那一页跳一下。
//
// 这道判断与 VS Code 无关，所以它长在这里，由一条条用例钉住；留一个 `seen` 是为了
// 「同一份 stamp 说第二遍不再动面板」，那也是一条要能验的规矩。

export interface ReconcileSeen {
  count: number | null;
  active: string | null;
  /** 对话内容的增长：count 与 active 都站着不动的那一类变化（见 core 的 stamp）。 */
  revision: number | null;
  launches: string;
}

export interface ReconcileStamp {
  count: number;
  active: string | null;
  revision: number;
  runsKey: string;
}

export interface ReconcileOutcome {
  /** 面板这一趟要做的事：重画整页、只推一次状态，还是什么都不动。 */
  panel: "refresh" | "status" | "none";
  /** 启动状态变了：agent 卡片那边的缓存与入口行要重新问一次。 */
  runsMoved: boolean;
}

export function reconcileOutcome(seen: ReconcileSeen, stamp: ReconcileStamp): ReconcileOutcome {
  const sessionsMoved = seen.count !== stamp.count || seen.active !== stamp.active || seen.revision !== stamp.revision;
  const runsMoved = seen.launches !== stamp.runsKey;
  seen.count = stamp.count;
  seen.active = stamp.active;
  seen.revision = stamp.revision;
  seen.launches = stamp.runsKey;
  // 两件事一起变的时候只重画一次：那一页本来就带着新的状态。
  if (sessionsMoved) return { panel: "refresh", runsMoved };
  return { panel: runsMoved ? "status" : "none", runsMoved };
}
