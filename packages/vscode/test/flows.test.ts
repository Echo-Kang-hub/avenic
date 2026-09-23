import assert from "node:assert/strict";
import test from "node:test";
import { assertIdle, pickManyOrNotify, pickOne, pickProjectRoot } from "../src/ui/flows.ts";
import { lastProjectRoot, rememberProjectRoot } from "../src/project.ts";
import { MutationQueue } from "../src/ui/mutation-queue.ts";

function fakeState() {
  const data = new Map<string, unknown>();
  return {
    data,
    get(key: string) { return data.get(key); },
    update(key: string, value: unknown) { data.set(key, value); return Promise.resolve(); },
  };
}

test("pickOne returns undefined when empty", async () => {
  assert.equal(await pickOne<{ label: string }>([], async () => { throw new Error("not called"); }), undefined);
});

test("pickOne forwards options to quickPick", async () => {
  const options = [{ label: "global" }, { label: "project" }];
  const chosen = await pickOne(options, async (items) => items[1]);
  assert.equal(chosen, options[1]);
});

test("remembered root in current folders skips the pick", async () => {
  const state = fakeState();
  rememberProjectRoot(state, "C:/b");
  let picked = false;
  const root = await pickProjectRoot(
    [{ uri: { fsPath: "C:/a" } }, { uri: { fsPath: "C:/b" } }],
    state,
    async () => { picked = true; return undefined; },
  );
  assert.equal(root, "C:/b");
  assert.equal(picked, false);
});

test("stale remembered root falls back to pick", async () => {
  const state = fakeState();
  rememberProjectRoot(state, "C:/gone");
  const folders = [{ uri: { fsPath: "C:/a" } }, { uri: { fsPath: "C:/b" } }];

  const declined = await pickProjectRoot(folders, state, async () => undefined);
  assert.equal(declined, null);

  const chosen = await pickProjectRoot(folders, state, async () => ({ label: "C:/b", fsPath: "C:/b" }));
  assert.equal(chosen, "C:/b");
  assert.equal(lastProjectRoot(state), "C:/b");
});

test("assertIdle returns true and does not notify when queue is idle", () => {
  const queue = new MutationQueue();
  let warned = false;
  assert.equal(assertIdle(queue, () => { warned = true; }), true);
  assert.equal(warned, false);
});

test("assertIdle notifies and returns false while a mutation is busy", async () => {
  const queue = new MutationQueue();
  const p = queue.run(async () => { await new Promise((r) => setTimeout(r, 10)); });
  let warned: string | null = null;
  assert.equal(assertIdle(queue, (key) => { warned = key; }), false);
  // 守卫给的是表里的键：说成哪种语言由有 vscode、知道编辑器语言的那一方决定
  assert.equal(warned, "flow.busy");
  await p;
  assert.equal(assertIdle(queue, () => { throw new Error("idle 后再提醒即测试失败"); }), true);
});

test("pickManyOrNotify warns on zero candidates without opening the picker", async () => {
  let opened = false;
  let warned: string | null = null;
  const chosen = await pickManyOrNotify<{ label: string }>([], async () => { opened = true; return []; }, (key) => { warned = key; });
  assert.deepEqual(chosen, []);
  assert.equal(opened, false, "零候选不得弹空 QuickPick 逼用户 Esc");
  assert.equal(warned, "flow.no-options");
});

test("pickManyOrNotify forwards options when candidates exist", async () => {
  const options = [{ label: "a" }, { label: "b" }];
  const chosen = await pickManyOrNotify(options, async (items) => items.slice(0, 1), () => { throw new Error("有候选不得警告"); });
  assert.deepEqual(chosen, [options[0]]);
});
