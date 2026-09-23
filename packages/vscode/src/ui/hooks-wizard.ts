import type { HookAction } from "@avenic/core";
import { LocalizedError, sentence } from "../i18n/text.ts";
import { HOOK_TIMEOUT_MS, OPENCLAW_DEFAULTS, draftAction, httpUrl, nextActionId, type ActionDraft, type HookActionKind } from "../services/hooks.ts";

// 四种通知的编辑器：加一条、改一条、删一条。整个问答跑在编辑器里，但它问的每一句都经过
// 下面这个可注入的界面，所以「谁答了什么、令牌有没有从别的地方走过」这两件事不需要开一个
// 真窗口就能测。
//
// 三条规矩写在这一层而不是页面上，因为页面是可以被绕过的那一层：
//   1. 令牌只走密码框（askSecret）：它不进普通输入框的历史，也不回显；预填时从来不给它。
//   2. 令牌永远不进地址：地址与令牌是两个字段，地址里的令牌在这里就被拒。
//   3. 命令类通知要先读过那句警告、再明确确认一次，两件都做到了才写；确认不过就当没问过。
//      服务层的 draftAction 只认「已经过过这一关」的调用（advanced: true），漏掉这一关的
//      调用会抛，而不是静默写下去。

export interface HookActionStore {
  /** 这一档的整份名单（向导要拿真值预填，令牌也在里面；页面拿不到这一份）。 */
  list(): HookAction[];
  /** 写的是整份：加一条、改一条、删一条都是「这份名单现在是这些」。 */
  save(actions: HookAction[]): Promise<{ changed: boolean; file: string }>;
}

export interface HookWizardUi {
  /** 一行字：返回 null 就是用户按了 Esc（任何一步取消＝这一条不成立）。 */
  ask(title: string, value: string, placeholder?: string): Promise<string | null>;
  /** 凭据那一问走宿主自己的密码输入：不在下拉历史里，也不回显。 */
  askSecret(title: string, placeholder: string): Promise<string | null>;
  pick<T>(title: string, items: Array<{ label: string; value: T }>): Promise<T | null>;
  info(message: string): void;
}

/** 名单被写成了什么样：写进哪个文件、core 说变没变，以及动的是哪一条（好让宿主说得出来）。 */
export type HookActionResult = { changed: boolean; file: string; id: string };

const TOKEN_KINDS = ["none", "value", "env"] as const;
type TokenKind = (typeof TOKEN_KINDS)[number];

/** 编辑时什么都不填的那一半：文件里原来是哪一半就留哪一半（core 的写入口保证只有一个）。 */
function keptToken(existing: HookAction): Pick<ActionDraft, "token" | "tokenEnv"> {
  if (existing.token !== undefined) return { token: existing.token };
  if (existing.tokenEnv !== undefined) return { tokenEnv: existing.tokenEnv };
  return {};
}

/**
 * 令牌那一问：填令牌本身、填存放它的变量名、或者不要。它总是与地址分开问 —— 地址那一行
 * 会被写进文件、也会被别人读到，凭据不该有任何机会溜进去。
 */
async function askToken(ui: HookWizardUi, language: string, existing: HookAction | null): Promise<Pick<ActionDraft, "token" | "tokenEnv"> | null> {
  const kind = await ui.pick<TokenKind>(sentence(language, "hooks.ask-token-kind"), [
    { label: sentence(language, "hooks.token-kind-none"), value: "none" },
    { label: sentence(language, "hooks.token-kind-value"), value: "value" },
    { label: sentence(language, "hooks.token-kind-env"), value: "env" },
  ]);
  if (kind === null) return null;
  if (kind === "none") return { token: null, tokenEnv: null };
  if (kind === "env") {
    // 变量名不是秘密：它会印在文件里，也会印在这一页上，所以它走普通输入框。
    const name = await ui.ask(sentence(language, "hooks.ask-token-env"), existing?.tokenEnv ?? "", "OPENCLAW_HOOK_TOKEN");
    return name === null ? null : { token: null, tokenEnv: name };
  }
  // 值那一问永远是空的：文件里那个令牌不回显，留空就是「保留原来那个」。
  const value = await ui.askSecret(sentence(language, "hooks.ask-token"), existing === null ? sentence(language, "hooks.note-token") : sentence(language, "hooks.keep-token"));
  if (value === null) return null;
  return value === "" ? (existing === null ? null : keptToken(existing)) : { token: value, tokenEnv: null };
}

/** 超时那一问：空就是「不写这一条」，不是数字就说出来，越界交给 core 的边界去夹。 */
function timeoutOf(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) throw new LocalizedError("hooks.bad-timeout");
  return value;
}

/** 一种通知要问的每一句。返回的 advanced 是命令类那一关的凭证：过了关才可能为 true。 */
async function askFields(ui: HookWizardUi, language: string, kind: HookActionKind, existing: HookAction | null): Promise<{ draft: ActionDraft; advanced: true } | null> {
  if (kind === "desktop") return { draft: {}, advanced: true };
  if (kind === "openclaw") {
    const gateway = await ui.ask(sentence(language, "hooks.ask-gateway"), existing?.gateway ?? OPENCLAW_DEFAULTS.gateway, OPENCLAW_DEFAULTS.gateway);
    if (gateway === null) return null;
    // 每一问答完当场检查：地址不对，就不该让他把后面几问答完才被告知。
    const checked = httpUrl(gateway, "hooks.bad-gateway");
    const path = await ui.ask(sentence(language, "hooks.ask-path"), existing?.path ?? OPENCLAW_DEFAULTS.path, OPENCLAW_DEFAULTS.path);
    if (path === null) return null;
    const token = await askToken(ui, language, existing);
    if (token === null) return null;
    // 网关那一页不问上限（本机地址，没什么可等的），但一条手写过上限的动作在被编辑时
    // 还是要带着它走：core 分发时读的是这个字段，编辑器不该替用户丢掉一个它没问的字段。
    return { draft: { gateway: checked, path, ...token, timeoutMs: existing?.timeoutMs ?? null }, advanced: true };
  }
  if (kind === "webhook") {
    const url = await ui.ask(sentence(language, "hooks.ask-url"), existing?.url ?? "", "https://example.com/hook");
    if (url === null) return null;
    const checked = httpUrl(url);
    const token = await askToken(ui, language, existing);
    if (token === null) return null;
    const timeout = await ui.ask(sentence(language, "hooks.ask-timeout"), String(existing?.timeoutMs ?? HOOK_TIMEOUT_MS.default), String(HOOK_TIMEOUT_MS.default));
    if (timeout === null) return null;
    return { draft: { url: checked, timeoutMs: timeoutOf(timeout), ...token }, advanced: true };
  }
  // 命令类：标题就是那句警告（用户一边打字一边读到的就是它），然后是明确的确认。没有确认
  // 就没有 advanced，于是 draftAction 拒收 —— 这条路只有两条出路：确认了，或者什么都没发生。
  const command = await ui.ask(sentence(language, "hooks.ask-command"), existing?.command ?? "", "");
  if (command === null) return null;
  const confirmed = await ui.pick<boolean>(sentence(language, "hooks.confirm-command"), [
    { label: sentence(language, "hooks.confirm-command-yes", { command }), value: true },
    { label: sentence(language, "hooks.confirm-cancel"), value: false },
  ]);
  if (confirmed !== true) return null;
  return { draft: { command }, advanced: true };
}

/** 加一条：整份名单加上新的那一条，id 与别的行不撞。 */
export async function addHookAction(store: HookActionStore, ui: HookWizardUi, kind: string, language: string): Promise<HookActionResult | null> {
  if (!isKind(kind)) throw new LocalizedError("hooks.unknown-kind", { kind });
  const asked = await askFields(ui, language, kind, null);
  if (asked === null) return null;
  const list = store.list();
  const action = draftAction(kind, { ...asked.draft, id: nextActionId(kind, list) }, list, { advanced: asked.advanced });
  return { ...(await store.save([...list, action])), id: action.id };
}

/** 改一条：预填的是文件里的真值，写的是整份，id 不变。 */
export async function editHookAction(store: HookActionStore, ui: HookWizardUi, id: string, language: string): Promise<HookActionResult | null> {
  const list = store.list();
  const existing = list.find((action) => action.id === id);
  if (existing === undefined) throw new LocalizedError("hooks.unknown-action", { id });
  if (!isKind(existing.kind)) throw new LocalizedError("hooks.unknown-kind", { kind: existing.kind });
  const asked = await askFields(ui, language, existing.kind, existing);
  if (asked === null) return null;
  const action = draftAction(existing.kind, { ...asked.draft, id: existing.id }, list, { advanced: asked.advanced });
  return { ...(await store.save(list.map((entry) => (entry.id === existing.id ? action : entry)))), id: action.id };
}

/** 删一条：先让用户认出这一条（地址、网关加路径、程序名），确认了才写。 */
export async function removeHookAction(store: HookActionStore, ui: HookWizardUi, id: string, language: string): Promise<HookActionResult | null> {
  const list = store.list();
  const existing = list.find((action) => action.id === id);
  if (existing === undefined) throw new LocalizedError("hooks.unknown-action", { id });
  const confirmed = await ui.pick<boolean>(sentence(language, "hooks.confirm-remove"), [
    { label: sentence(language, "hooks.confirm-remove-yes", { target: describe(existing) }), value: true },
    { label: sentence(language, "hooks.confirm-cancel"), value: false },
  ]);
  if (confirmed !== true) return null;
  return { ...(await store.save(list.filter((entry) => entry.id !== id))), id: existing.id };
}

function isKind(kind: string): kind is HookActionKind {
  return kind === "desktop" || kind === "openclaw" || kind === "webhook" || kind === "command";
}

/** 一行的说法，与页面上的 actionFacts.target 同一句话：认得出是哪一条，但不带凭据与参数。 */
function describe(action: HookAction): string {
  if (action.kind === "openclaw") return `${action.gateway ?? OPENCLAW_DEFAULTS.gateway}${action.path ?? OPENCLAW_DEFAULTS.path}`;
  if (action.kind === "webhook") return action.url ?? action.id;
  if (action.kind === "command") return (action.command ?? "").trim().split(/\s+/)[0] || action.id;
  return action.id;
}
