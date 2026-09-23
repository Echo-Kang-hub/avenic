import { spawnExecutableChild } from "./process.mjs";
import { ITEM_ID_PREFIX, REFUSED_ITEM_ID_PREFIX } from "./projection.mjs";

// Codex exposes its own session machinery over a documented JSON-RPC protocol
// (`codex app-server --listen stdio://`). Avenic uses it for exactly one thing:
// appending already-happened turns to a thread's model-visible history, which
// is what makes a switch to Codex continuous instead of a handoff prompt. No
// rollout file, index or database is ever written here — everything below is a
// request the Codex team defined, and the schema ships with the CLI
// (`codex app-server generate-json-schema`).

export const CODEX_ITEM_PREFIX = ITEM_ID_PREFIX;
const CLIENT_INFO = { name: "avenic", title: "Avenic", version: "1" };
const DEFAULT_TIMEOUT = 20_000;
const INJECT_CHUNK = 200;

function isInjectedItem(item) {
  return typeof item === "string"
    && (item.startsWith(CODEX_ITEM_PREFIX) || item.startsWith(REFUSED_ITEM_ID_PREFIX));
}

/**
 * Did a rollout record come from Avenic's own projection rather than from a
 * real turn? Capture must skip these or the projected history would be
 * re-imported as new work on every switch. Both id shapes count: the one the
 * provider accepts, and the one written before that rule was known.
 */
export function isInjectedRecord(record) {
  const payload = record?.payload ?? record;
  if (!payload || payload.type !== "message") return false;
  return isInjectedItem(payload.id);
}

/**
 * Was this record injected with the id shape the provider refuses? Such a
 * thread cannot be sent another turn — the request is rejected before the model
 * sees it — so it is rebuilt from canonical history instead of resumed.
 */
export function isRefusedInjection(record) {
  const payload = record?.payload ?? record;
  return Boolean(payload)
    && payload.type === "message"
    && typeof payload.id === "string"
    && payload.id.startsWith(REFUSED_ITEM_ID_PREFIX);
}

/**
 * Open a conversation with the installed Codex app server. Throws when the
 * binary is missing or refuses the handshake; callers treat that as "projection
 * unavailable" and fall back, never as a fatal error.
 */
export async function openCodexAppServer({ command = "codex", cwd, environment = process.env, timeoutMs = DEFAULT_TIMEOUT, spawn } = {}) {
  const child = spawnExecutableChild(command, ["app-server", "--listen", "stdio://"], {
    cwd,
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
    spawn,
  });
  let buffer = "";
  let closed = false;
  let failure = null;
  let stderr = "";
  const pending = new Map();
  let nextId = 1;

  const settleAll = (error) => {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const entry = pending.get(message.id);
      if (!entry) continue;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(`codex app-server ${entry.method}: ${message.error.message ?? JSON.stringify(message.error)}`));
      else entry.resolve(message.result);
    }
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-2_000);
  });
  child.on("error", (error) => {
    failure = error;
    settleAll(error);
  });
  child.on("close", () => {
    closed = true;
    settleAll(failure ?? new Error(`codex app-server exited${stderr ? `: ${stderr.trim().split("\n").at(-1)}` : ""}`));
  });

  const client = {
    call(method, params, callTimeoutMs = timeoutMs) {
      if (closed || failure) {
        return Promise.reject(failure ?? new Error("codex app-server is closed"));
      }
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`codex app-server ${method}: timed out after ${callTimeoutMs}ms`));
        }, callTimeoutMs);
        pending.set(id, { resolve, reject, timer, method });
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      child.stdin.end();
      if (typeof child.terminateTree === "function") child.terminateTree();
      else child.kill();
      await new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        const timer = setTimeout(resolve, 1_000);
        child.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
    get stderr() {
      return stderr;
    },
  };

  await client.call("initialize", { clientInfo: CLIENT_INFO });
  return client;
}

export async function startCodexThread(client, cwd) {
  const result = await client.call("thread/start", cwd ? { cwd } : {});
  const threadId = result?.thread?.id ?? result?.threadId ?? result?.id;
  if (typeof threadId !== "string" || !threadId) throw new Error("codex app-server thread/start returned no thread id");
  return threadId;
}

/**
 * Append model-visible turns to an existing thread. Chunked because a first
 * materialization can carry thousands of turns and one JSON line should stay
 * small enough for the server to read in a single pass.
 */
export async function injectCodexItems(client, threadId, items) {
  let injected = 0;
  for (let index = 0; index < items.length; index += INJECT_CHUNK) {
    const chunk = items.slice(index, index + INJECT_CHUNK);
    await client.call("thread/inject_items", { threadId, items: chunk });
    injected += chunk.length;
  }
  return injected;
}
