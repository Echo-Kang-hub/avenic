// What the three agents can tell Avenic, in Avenic's own words.
//
// This is one small vocabulary, not one integration per agent: six events say
// everything the rest of the product needs — a session began or ended, a turn
// began, finished or died, and someone has to come back to the keyboard — and
// every native mechanism is translated into those six here, once. The matrix
// below is the evidence table from `docs/agent-hooks.md`, which was read off the
// installed binaries (claude 2.1.274 · codex-cli 0.154.0 · opencode 1.18.30);
// the field and event names in it were re-checked against those binaries, and
// the names of the two events nobody has seen fire are marked as such.
//
// What a matrix must never do is claim more than was verified. A hook Avenic
// invented fires never, and a notification that never arrives does not read as
// "unsupported" — it reads as "my agent stopped telling me anything", which is
// the one failure the user cannot debug. So `absent` is a value here, with the
// reason attached, and a native event that nobody mapped normalizes to null
// rather than to the nearest event that fits.
//
// Nothing in here knows what a notification is. The vocabulary is what the
// agents say; what Avenic does about it — desktop, webhook, a command — is a
// dispatcher's business, above this file.

/** The six things an agent can report, in the order a session lives them. */
export const HOOK_EVENTS = [
  "session.started",
  "turn.started",
  "turn.completed",
  "turn.failed",
  "attention.required",
  "session.ended",
];

/**
 * The thresholds a dispatcher obeys, in one place because the CLI and the
 * extension both ask the same question: a turn that took a second is not worth
 * a notification, and a turn that failed is worth one immediately.
 *
 * `dedupeSeconds` is the window in which the same thing happening twice is one
 * notification: the native mechanisms happily fire the same event from two
 * hooks, and a user who gets the same banner three times turns the feature off.
 */
export const HOOK_POLICY = {
  completedMinSeconds: 20,
  attentionImmediate: true,
  failedImmediate: true,
  dedupeSeconds: 45,
  // 一次派发是**一条链子共用一个总预算**，不是每个动作各有一份：这个进程跑在 agent
  // 自己的钩子里，链子等多久，用户的这一轮就等多久（Claude 给钩子的上限是 60 秒）。
  // 30 秒与单个动作的上限同值 —— 一个动作可以自己调短，但谁也调不长这条链子。
  dispatchBudgetSeconds: 30,
};

// `reliable` 装上去就会响；`conditional` 响了要看条件（用户审阅、版本、被观测到与否）；
// `absent` 这个原生机制根本没有这件事 —— 那就说没有，而不是拿别的凑。
//
// `reason` 与 `detail` 指的是「这个原生载荷里哪一栏装着它们」：有的机制把理由放在自己的
// 错误分类里，有的就放在事件名本身。哪一栏是理由属于这张表，不属于读它的那段代码。
const rel = (native, reliability, extra = {}) => ({ native, reliability, note: "", ...extra });

export const HOOK_CAPABILITIES = {
  claude: {
    displayName: "Claude Code",
    mechanism: "settings-hooks",
    file: ".claude/settings.json",
    // Stop 上没有轮次时长：能对上这一轮的只有 prompt_id，所以时长是 UserPromptSubmit
    // 那一刻到 Stop 那一刻量出来的，不是载荷里抄来的。
    duration: "correlated",
    verified: "2.1.274",
    since: "2.1.0",
    reads: { event: "hook_event_name", session: "session_id", turn: "prompt_id", cwd: "cwd" },
    events: {
      "session.started": rel("SessionStart", "reliable"),
      "turn.started": rel("UserPromptSubmit", "reliable"),
      "turn.completed": rel("Stop", "reliable"),
      // 失败只看 error 这一栏：StopFailure 根本不看退出码，从退出码推出来的失败理由是编的。
      "turn.failed": rel("StopFailure", "reliable", { reason: "error", note: "the reason is the event's own error class" }),
      // Notification 是一个事件名、四种含义，而这四种里只有一部分是「需要人回来」——
      // 所以映射认的是那四种类型本身，不是一个叫 Notification 的东西。
      "attention.required": rel("Notification", "reliable", {
        reason: "notification_type",
        detail: "message",
        reasons: ["permission_prompt", "idle_prompt", "agent_needs_input", "agent_completed"],
        note: "PermissionRequest reports the same thing for a tool ask",
      }),
      "session.ended": rel("SessionEnd", "reliable"),
    },
  },
  codex: {
    displayName: "Codex",
    mechanism: "config-hooks",
    file: ".codex/config.toml",
    duration: "correlated",
    verified: "0.154.0",
    since: "0.154.0",
    reads: { event: "hook_event_name", session: "session_id", turn: "turn_id", cwd: "cwd" },
    events: {
      // 这两条的名字在装好的二进制里能读到，但没有人见过它真的响过 —— 而且新写下去的
      // 钩子在用户审阅之前是 untrusted，项目级的更是要整个项目被信任才加载。所以它们
      // 是 conditional：装了不等于会响。
      "session.started": rel("SessionStart", "conditional", { note: "not observed firing on this version" }),
      "turn.started": rel("UserPromptSubmit", "conditional", { note: "not observed firing on this version" }),
      "turn.completed": rel("Stop", "conditional", { note: "a written hook stays untrusted until the user reviews it" }),
      "turn.failed": rel(null, "absent", { note: "no hook event exists — only the app server's turn/completed with status: failed" }),
      "attention.required": rel("PermissionRequest", "conditional", { note: "untrusted until reviewed, like every Codex hook" }),
      "session.ended": rel("SessionEnd", "conditional", { note: "not observed firing on this version" }),
    },
  },
  opencode: {
    displayName: "OpenCode",
    mechanism: "plugin",
    file: ".opencode/plugins/",
    // 插件拿得到每条消息的时间戳，一轮的时长由 session.created 与 session.idle 之间量出来。
    duration: "correlated",
    verified: "1.18.30",
    since: "1.18.0",
    reads: { event: "type", session: "sessionID", turn: null, cwd: "directory" },
    events: {
      "session.started": rel("session.created", "reliable"),
      // 用户那条消息就是这一轮的开始，但插件的事件表里没有「用户提问」这一条 —— 所以这
      // 一行是推断出来的，说清楚它没有被观测过。
      "turn.started": rel("message.updated", "conditional", { note: "a user-role message starts the turn; not observed firing", role: "user" }),
      "turn.completed": rel("session.idle", "reliable"),
      "turn.failed": rel("session.error", "reliable"),
      "attention.required": rel("permission.asked", "reliable", { reason: "type", note: "1.18.30 has no permission.updated" }),
      "session.ended": rel("session.deleted", "reliable"),
    },
  },
};

export function hookCapability(agentId) {
  return HOOK_CAPABILITIES[agentId] ?? null;
}

const parts = (version) => {
  const found = typeof version === "string" ? version.trim().match(/^(\d+)\.(\d+)\.(\d+)/) : null;
  return found === null ? null : found.slice(1).map(Number);
};

const olderThan = (installed, floor) => {
  for (let index = 0; index < 3; index += 1) {
    if (installed[index] !== floor[index]) return installed[index] < floor[index];
  }
  return false;
};

/**
 * Whether the agent on this machine is one the matrix was read off.
 *
 * A version that cannot be read is *not* a version that supports hooks: saying
 * "unsupported" costs a feature the user could have had, and saying "supported"
 * costs a feature that silently does nothing. The cheap case is the one that
 * tells the truth, and the note is the sentence a screen shows verbatim.
 */
export function hookSupport(agentId, version) {
  const capability = hookCapability(agentId);
  if (capability === null) return null;
  const installed = parts(version);
  if (installed === null) {
    return { supported: false, since: capability.since, note: `Unsupported by ${capability.displayName}: the installed version could not be read` };
  }
  if (olderThan(installed, parts(capability.since))) {
    return { supported: false, since: capability.since, note: `Unsupported by ${capability.displayName} ${String(version).trim()}` };
  }
  return { supported: true, since: capability.since, note: null };
}

const text = (value) => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);

const field = (payload, name) => (name === null || name === undefined ? null : text(payload[name]));

/**
 * One native payload in Avenic's own words, or `null` when it is not an event
 * Avenic knows how to read.
 *
 * The null matters: the agents' hook sets are wider than the six events — a
 * pre-compact, a tool call, a notification type from a newer version — and a
 * payload that falls through to "the nearest event that fits" invents a
 * notification the user never asked for. Unknown stays unknown.
 */
export function normalizeHook(agentId, payload) {
  const capability = hookCapability(agentId);
  if (capability === null || typeof payload !== "object" || payload === null) return null;
  const native = field(payload, capability.reads.event);
  if (native === null) return null;
  const found = Object.entries(capability.events).find(([, entry]) => entry.native !== null && entry.native === native);
  if (found === undefined) return null;
  const [event, entry] = found;
  const reason = entry.reason === undefined ? null : field(payload, entry.reason);
  // 有的机制里事件名比载荷粗一档：Claude 的 Notification 是「某个类型」，Codex 的失败
  // 是「某一类错误」。表里列了哪几种才算这件事的，就只有那几种算 —— 一个没见过的类型
  // 猜成 attention，就是在用户没让人回来的时候把人叫回来。
  if (entry.reasons !== undefined && (reason === null || !entry.reasons.includes(reason))) return null;
  // 有的原生事件对两种角色都发（OpenCode 的 message.updated 就是：助手流的每一次增量
  // 也叫这个名字）。表里连着角色一起写下来，就只有那个角色算数 —— 全都算的话，一轮的
  // 时刻被助手自己的增量不断重写，20 秒的下限永远量不够，该来的通知一条都不来。
  // 角色读不出来时也不放行：猜错的代价是把助手的话记成用户的开始。
  if (entry.role !== undefined && payload.info?.role !== entry.role) return null;
  return {
    agent: agentId,
    event,
    sessionId: field(payload, capability.reads.session),
    turnId: field(payload, capability.reads.turn),
    cwd: field(payload, capability.reads.cwd),
    // 有 reason 这一栏的事件，值读不出来时不能什么都不说：这一轮的失败理由丢了，读的人
    // 只会以为它没失败。unknown 是一个诚实的答案。
    reason: entry.reason === undefined ? null : reason ?? "unknown",
    detail: entry.detail === undefined ? null : field(payload, entry.detail),
  };
}

/**
 * The identity of one happening, for the dedupe window.
 *
 * What identifies it is who, in which session, at which turn, and what happened
 * — deliberately not when it happened, because the two hooks that report the
 * same Stop seconds apart have to collapse into one notification. The session is
 * in the fingerprint so that two sessions ending within the same minute are two
 * notifications, not one.
 */
export function hookFingerprint(event) {
  return [event.agent, event.event, event.sessionId ?? "", event.turnId ?? "", event.reason ?? ""].join("|");
}
