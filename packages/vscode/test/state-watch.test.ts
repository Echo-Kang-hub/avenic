import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { watchProjectState } from "../src/services/state-watch.ts";

// 仪表盘要跟着项目走，而项目的变化发生在别处：另一个终端的 `avenic claude` 退出了，
// 一次启动结束了，一场对话长了。以前面板只在「自己动过手」和「终端被关掉」时重读，
// 所以别处发生的一切都要等到手点一下刷新——实时状态的答案不在轮询的密度里，在
// 「谁变了就说一声」上。core 写的那个小 stamp 就是这句话，这里守着它。

const stamp = (revision: number) => JSON.stringify({ schemaVersion: 1, revision, updatedAt: new Date().toISOString(), launches: { claude: "idle" }, sessions: { count: revision, active: null } });

async function project() {
  const root = await mkdtemp(path.join(os.tmpdir(), "avenic-state-watch-"));
  return { root, file: path.join(root, ".agents", "local", "state.json") };
}

// 一次变化的到达方式可能是一条事件，也可能是兜底那次询问。用例按「多久之内被通知」
// 断言，不按「因为哪条路被通知」断言：机制是实现，通知是契约。
async function notified(seen: { count: number }, withinMs: number) {
  const deadline = Date.now() + withinMs;
  while (Date.now() < deadline) {
    if (seen.count > 0) return true;
    await delay(10);
  }
  return seen.count > 0;
}

test("a stamp written by someone else arrives without anyone asking", async () => {
  const { root, file } = await project();
  const seen = { count: 0 };
  const watcher = watchProjectState({ projectRoot: root, onChange: () => { seen.count += 1; }, pollMs: 0, debounceMs: 5 });
  try {
    // 面板可能就是第一个到这里的人，目录还不存在：写入要能凭空把它带出来。
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${stamp(1)}\n`);
    assert.equal(await notified(seen, 2000), true, "一次启动或一次退出必须自己走到面板上");
  } finally {
    watcher.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("a stamp replaced by rename still arrives", async () => {
  const { root, file } = await mkdirReady(await project());
  const seen = { count: 0 };
  const watcher = watchProjectState({ projectRoot: root, onChange: () => { seen.count += 1; }, pollMs: 0, debounceMs: 5 });
  try {
    for (const revision of [1, 2]) {
      await writeFile(`${file}.tmp`, stamp(revision));
      await rename(`${file}.tmp`, file);
      await delay(80);
    }
    // core 每次都整份换掉这个文件（先写临时文件再改名），文件本身被换了一个；盯着
    // 文件句柄的监视器在这里会瞎，盯着它所在目录的不会。
    assert.ok(seen.count >= 1, `a rename-replaced file is a change (saw ${seen.count})`);
  } finally {
    watcher.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("a burst of writes is one wake-up, not eight", async () => {
  const { root, file } = await mkdirReady(await project());
  const seen = { count: 0 };
  const watcher = watchProjectState({ projectRoot: root, onChange: () => { seen.count += 1; }, pollMs: 0, debounceMs: 60 });
  try {
    for (const revision of [1, 2, 3, 4, 5, 6, 7, 8]) {
      await writeFile(file, stamp(revision));
    }
    await delay(400);
    assert.ok(seen.count >= 1, "the change is reported");
    assert.ok(seen.count <= 2, `eight writes inside one window are one piece of news, saw ${seen.count}`);
  } finally {
    watcher.stop();
    await rm(root, { recursive: true, force: true });
  }
});

// 兜底存在的理由不是「以防万一」：有的平台上事件就是不来。注入一个不发事件的监视器
// 说的正是那种平台，而询问必须自己把变化带回来。
test("when no event ever comes, the fallback brings the change", async () => {
  const { root, file } = await mkdirReady(await project());
  const seen = { count: 0 };
  const silent = () => ({ on: () => {}, close: () => {} });
  const watcher = watchProjectState({ projectRoot: root, onChange: () => { seen.count += 1; }, pollMs: 40, debounceMs: 5, fsWatch: silent });
  try {
    await delay(60);
    seen.count = 0;
    await writeFile(file, `${stamp(9)}\n`);
    assert.equal(await notified(seen, 2000), true, "the询问 is the mechanism on a platform without events");
  } finally {
    watcher.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("the fallback is quiet while nothing has changed", async () => {
  const { root, file } = await mkdirReady(await project());
  const seen = { count: 0 };
  const silent = () => ({ on: () => {}, close: () => {} });
  const watcher = watchProjectState({ projectRoot: root, onChange: () => { seen.count += 1; }, pollMs: 30, debounceMs: 5, fsWatch: silent });
  try {
    await delay(100);
    seen.count = 0;
    await delay(200);
    assert.equal(seen.count, 0, "an idle project must not make the panel re-read anything");
  } finally {
    watcher.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test("stop() ends both the watch and the fallback", async () => {
  const { root, file } = await mkdirReady(await project());
  const seen = { count: 0 };
  const watcher = watchProjectState({ projectRoot: root, onChange: () => { seen.count += 1; }, pollMs: 20, debounceMs: 5 });
  watcher.stop();
  await delay(60);
  seen.count = 0;
  await writeFile(file, `${stamp(3)}\n`);
  await delay(200);
  assert.equal(seen.count, 0, "a stopped watcher reports nothing");
  await rm(root, { recursive: true, force: true });
});

async function mkdirReady({ root, file }: { root: string; file: string }) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${stamp(0)}\n`);
  return { root, file };
}
