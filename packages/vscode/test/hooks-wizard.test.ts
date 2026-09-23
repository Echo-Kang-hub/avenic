import assert from "node:assert/strict";
import test from "node:test";
import type { HookAction } from "@avenic/core";
import { addHookAction, editHookAction, removeHookAction, type HookActionStore, type HookWizardUi } from "../src/ui/hooks-wizard.ts";
import { OPENCLAW_DEFAULTS } from "../src/services/hooks.ts";

// 四种通知的编辑器。它跑在编辑器里（QuickPick / InputBox），但每一问都经过这个可注入的
// 界面，所以整条问答不需要真的开一个窗口就能测 —— 包括最要紧的那几件：令牌是密码框、
// 从不写进地址、命令类通知必须先读过警告并确认。

const TOKEN = "hook-test-not-a-real-token";

/** 一份真名单的替身：整份读、整份写（与 core 的写入口一样）。 */
function store(initial: HookAction[] = []): HookActionStore & { rows: HookAction[]; saves: number } {
  return {
    rows: [...initial],
    saves: 0,
    list() { return [...this.rows]; },
    async save(actions) { this.saves += 1; this.rows = [...actions]; return { changed: true, file: "/tmp/hook-actions.json" }; },
  };
}

/** 用户：按脚本回答，并把每一次提问记下来（好断言「令牌没有从别的地方走过」）。 */
function ui(script: { ask?: (string | null)[]; secret?: (string | null)[]; pick?: (string | boolean | null)[] }): HookWizardUi & { asked: string[]; secrets: string[]; picked: string[] } {
  const asks = [...(script.ask ?? [])];
  const secrets = [...(script.secret ?? [])];
  const picks = [...(script.pick ?? [])];
  const asked: string[] = [];
  const seen: string[] = [];
  const chose: string[] = [];
  return {
    asked,
    secrets: seen,
    picked: chose,
    async ask(title, value) { asked.push(`${title}|${value}`); return asks.length === 0 ? null : asks.shift() as string | null; },
    async askSecret(title) { seen.push(title); return secrets.length === 0 ? null : secrets.shift() as string | null; },
    async pick(title, items) {
      chose.push(`${title}|${items.map((item) => item.label).join(" / ")}`);
      const chosen = picks.length === 0 ? null : picks.shift();
      if (chosen === null) return null;
      return items.find((item) => item.value === chosen)?.value ?? null;
    },
    info() { /* 编辑器里的提示不是这一层的事 */ },
  };
}

test("a desktop notification is one answer: it has no fields, and it lands in the list", async () => {
  const rows = store([{ id: "desktop", kind: "desktop" }]);
  const result = await addHookAction(rows, ui({}), "desktop", "en");
  assert.deepEqual(result, { changed: true, file: "/tmp/hook-actions.json", id: "desktop-2" });
  assert.deepEqual(rows.rows, [{ id: "desktop", kind: "desktop" }, { id: "desktop-2", kind: "desktop" }], "第二条换一个 id，不覆盖第一条");
});

test("the gateway's own defaults prefilled, the hook token asked for separately, and never put in the address", async () => {
  const rows = store();
  // 网关与路径各答一次，令牌选「填令牌本身」，然后填进密码框。
  const answers = ui({ ask: [OPENCLAW_DEFAULTS.gateway, OPENCLAW_DEFAULTS.path], pick: ["value"], secret: [TOKEN] });
  await addHookAction(rows, answers, "openclaw", "en");
  const action = rows.rows[0];
  assert.equal(action.kind, "openclaw");
  assert.equal(action.gateway, OPENCLAW_DEFAULTS.gateway);
  assert.equal(action.path, OPENCLAW_DEFAULTS.path);
  assert.equal(action.token, TOKEN);
  // 令牌只从密码框走过：别的提问里一个字符都没有它。
  assert.equal(answers.asked.some((line) => line.includes(TOKEN)), false, "令牌不许出现在普通输入框里");
  assert.equal(JSON.stringify({ gateway: action.gateway, path: action.path }).includes(TOKEN), false, "地址里没有令牌");
  assert.equal(answers.secrets.length, 1);
});

test("a webhook's timeout is a number of milliseconds, clamped rather than trusted", async () => {
  const rows = store();
  // url、令牌选「不要」、超时。
  await addHookAction(rows, ui({ ask: ["https://example.test/hook", "1000000"], pick: ["none"] }), "webhook", "en");
  assert.deepEqual(rows.rows[0], { id: "webhook", kind: "webhook", url: "https://example.test/hook", timeoutMs: 30_000 }, "越界的超时夹回 core 的上界");
  // 不是数字：这是一句要说出来的话，不是一次静默的 NaN。
  await assert.rejects(() => addHookAction(store(), ui({ ask: ["https://example.test/hook", "soon"], pick: ["none"] }), "webhook", "en"), /milliseconds/);
  // 不是 http(s) 的地址在写之前就被拒。
  await assert.rejects(() => addHookAction(store(), ui({ ask: ["file:///etc/passwd"], pick: ["none"] }), "webhook", "en"), /http\(s\)/);
});

test("cancelling any single question leaves the list exactly as it was", async () => {
  const rows = store([{ id: "webhook", kind: "webhook", url: "https://example.test/keep" }]);
  // 地址那一问按 Esc。
  assert.equal(await addHookAction(rows, ui({ ask: [null] }), "webhook", "en"), null);
  assert.equal(rows.saves, 0);
  assert.deepEqual(rows.rows, [{ id: "webhook", kind: "webhook", url: "https://example.test/keep" }]);
});

test("a command notification needs the warning read and a confirmation, and the gate is not the page's to open", async () => {
  const rows = store();
  // 读了警告、填了程序，但没确认：什么都不写。
  assert.equal(await addHookAction(rows, ui({ ask: ["/usr/bin/notify"], pick: [false] }), "command", "en"), null);
  assert.equal(rows.saves, 0);
  // 确认了才写，而且写下去的是程序本身（参数不经过任何一行状态）。
  await addHookAction(rows, ui({ ask: ["/usr/bin/notify --token " + TOKEN], pick: [true] }), "command", "en");
  assert.deepEqual(rows.rows, [{ id: "command", kind: "command", command: `/usr/bin/notify --token ${TOKEN}` }]);

  // 服务层的把门人：没有那一关，任何人都不能在命令类里加一条。
  await assert.rejects(async () => {
    const { draftAction } = await import("../src/services/hooks.ts");
    return draftAction("command", { command: "/usr/bin/notify" }, []);
  }, /Advanced/);
});

test("editing prefills what is in the file, and an empty secret keeps the one that is already there", async () => {
  const rows = store([{ id: "webhook", kind: "webhook", url: "https://old.test/hook", token: TOKEN, timeoutMs: 900 }]);
  // 地址改成新的；令牌那一问选「填令牌」，但密码框留空 = 保留原来那个；超时留空 = 不写超时。
  const answers = ui({ ask: ["https://new.test/hook", ""], pick: ["value"], secret: [""] });
  await editHookAction(rows, answers, "webhook", "en");
  assert.deepEqual(rows.rows[0], { id: "webhook", kind: "webhook", url: "https://new.test/hook", token: TOKEN });
  // 提问时预填的是文件里的真值（地址、超时），令牌从来不是。
  assert.ok(answers.asked.some((line) => line.includes("https://old.test/hook")), "地址按文件里的预填");
  assert.equal(JSON.stringify(answers.asked).includes(TOKEN), false, "令牌连预填都不给");
  // 换成「填变量名」：令牌本身被移除，变量名留下（变量名不是秘密，所以走普通输入框）。
  await editHookAction(rows, ui({ ask: ["https://new.test/hook", "OPENCLAW_HOOK_TOKEN", ""], pick: ["env"] }), "webhook", "en");
  assert.deepEqual(rows.rows[0], { id: "webhook", kind: "webhook", url: "https://new.test/hook", tokenEnv: "OPENCLAW_HOOK_TOKEN" });
  // 认不出的 id 是一句要说出来的话。
  await assert.rejects(() => editHookAction(rows, ui({}), "nope", "en"), /nope/);
});

test("removing asks about the one thing the user can recognise, and cancelling keeps it", async () => {
  const rows = store([{ id: "openclaw", kind: "openclaw", gateway: OPENCLAW_DEFAULTS.gateway, path: OPENCLAW_DEFAULTS.path }]);
  assert.equal(await removeHookAction(rows, ui({ pick: [false] }), "openclaw", "en"), null);
  assert.equal(rows.rows.length, 1);
  const target = `${OPENCLAW_DEFAULTS.gateway}${OPENCLAW_DEFAULTS.path}`;
  const confirm = ui({ pick: [true] });
  await removeHookAction(rows, confirm, "openclaw", "en");
  assert.deepEqual(rows.rows, [], "写的是整份：删掉一个就是少一个");
  await assert.rejects(() => removeHookAction(rows, ui({ pick: [true] }), "openclaw", "en"), /openclaw/);
  // 确认那一问说的是这一条本身（网关加路径），不是它的编号。
  assert.equal(confirm.asked.length === 0, true, "确认走的是选择，不是输入框");
  assert.ok(confirm.picked.some((line) => line.includes(target)), "确认里认得出是哪一条通知");
});
