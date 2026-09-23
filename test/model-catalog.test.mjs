import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  fetchModelCatalog,
  modelCatalogCachePath,
  readModelCatalogCache,
  testProviderConnection,
  writeModelCatalogCache,
} from "../packages/core/src/runtime/model-catalog.mjs";

// Two network calls a Model Configuration Center makes on the user's behalf
// with the user's credential: asking a provider for its model list, and proving
// a base URL and a key work. Everything here is about what must *not* happen —
// the key must not reach a URL, a log, an error, or the cache file; a request
// must be one request; and it must always end, even when the far side never
// answers. The status codes are the ones docs/provider-endpoints.md lists, and
// the outcome is decided by them, never by the words a provider happens to send
// back. Every value below is a fiction.

const KEY = "sk-test-not-a-real-key";
const LIST_PATH = "/v1/models";
const MODULE_URL = new URL("../packages/core/src/runtime/model-catalog.mjs", import.meta.url).href;

async function withTemp(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "model-catalog-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// A real socket, because what these functions are is what happens over one:
// what left, what came back, and whether it ever ended.
async function withServer(handler, run) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    return await run({ baseUrl: `http://127.0.0.1:${server.address().port}` });
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

/** A server that answers every request the same way, and remembers each one. */
function answering({ status = 200, body = "", contentType = "application/json" } = {}) {
  const seen = [];
  return {
    seen,
    handler(request, response) {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        seen.push({ method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(chunks).toString("utf8") });
        response.writeHead(status, { "content-type": contentType });
        response.end(body);
      });
    },
  };
}

/** A server that accepts the connection and never answers it. */
function silent(request) {
  request.on("data", () => {});
  request.on("end", () => {});
}

/** A port with nothing behind it: the connection is refused, not timed out. */
async function urlWithNothingListening() {
  const server = createServer(() => {});
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}`;
}

// ── asking a provider for its model list ────────────────────────────────────

test("the model list is a GET with the key in the header, never in the URL", async () => {
  const server = answering({ body: JSON.stringify({ data: [{ id: "deepseek-v4-pro" }, { id: "deepseek-flash" }] }) });
  await withServer(server.handler, async ({ baseUrl }) => {
    const result = await fetchModelCatalog({ baseUrl: `${baseUrl}/anthropic`, listPath: "/models", header: "authorization", apiKey: KEY });
    assert.deepEqual(result, { ok: true, models: ["deepseek-v4-pro", "deepseek-flash"] });
  });
  assert.equal(server.seen.length, 1, "one request, never a retry");
  const [request] = server.seen;
  assert.equal(request.method, "GET");
  assert.equal(request.url, "/anthropic/models");
  assert.equal(request.headers.authorization, `Bearer ${KEY}`);
  assert.equal(request.url.includes(KEY), false, "the credential is not in the URL");
  assert.equal(request.url.includes("?"), false, "and it is not a query parameter");
});

test("a provider that documents its own header gets the key bare, not as a bearer", async () => {
  const server = answering({ body: JSON.stringify({ data: [{ id: "MiniMax-M2" }] }) });
  await withServer(server.handler, async ({ baseUrl }) => {
    const result = await fetchModelCatalog({ baseUrl: `${baseUrl}/anthropic`, listPath: "/v1/models", header: "x-api-key", apiKey: KEY });
    assert.deepEqual(result, { ok: true, models: ["MiniMax-M2"] });
  });
  const [request] = server.seen;
  assert.equal(request.headers["x-api-key"], KEY);
  assert.equal(request.headers.authorization, undefined, "one credential, in one place");
});

test("a public model list is asked for without a credential at all", async () => {
  const server = answering({ body: JSON.stringify({ data: [{ id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5" }] }) });
  await withServer(server.handler, async ({ baseUrl }) => {
    const result = await fetchModelCatalog({ baseUrl, listPath: "/api/v1/models", header: "authorization" });
    assert.deepEqual(result, { ok: true, models: ["anthropic/claude-sonnet-5"] }, "the id names the model, not the label");
  });
  assert.equal(server.seen[0].headers.authorization, undefined);
});

test("a base URL with a trailing slash does not grow a second one", async () => {
  const server = answering({ body: JSON.stringify({ data: [{ id: "m" }] }) });
  await withServer(server.handler, async ({ baseUrl }) => {
    await fetchModelCatalog({ baseUrl: `${baseUrl}/anthropic/`, listPath: "/v1/models", header: "authorization", apiKey: KEY });
    await fetchModelCatalog({ baseUrl: `${baseUrl}/anthropic`, listPath: "v1/models", header: "authorization", apiKey: KEY });
  });
  assert.deepEqual(server.seen.map((request) => request.url), ["/anthropic/v1/models", "/anthropic/v1/models"]);
});

test("a list that is a full URL is asked for as it stands, not joined onto a base", async () => {
  // The preset table carries the vendors' own list addresses (Moonshot's lives
  // on the host root and 404s under /anthropic), so the caller hands over the
  // whole thing — and the base URL it also has must not get in front of it.
  const server = answering({ body: JSON.stringify({ data: [{ id: "deepseek-v4-pro" }] }) });
  await withServer(server.handler, async ({ baseUrl }) => {
    const full = await fetchModelCatalog({ baseUrl: `${baseUrl}/anthropic`, listPath: `${baseUrl}/models`, header: "Authorization", apiKey: KEY });
    assert.deepEqual(full, { ok: true, models: ["deepseek-v4-pro"] });
    const root = await fetchModelCatalog({ baseUrl: `${baseUrl}/`, listPath: null, header: "Authorization", apiKey: KEY });
    assert.deepEqual(root, { ok: true, models: ["deepseek-v4-pro"] }, "a root with no path is the root, not a trailing slash");
  });
  assert.deepEqual(server.seen.map((request) => request.url), ["/models", "/"]);
});

test("the list is read from the shapes providers actually send", async () => {
  const cases = [
    [["a", "b"], ["a", "b"]],
    [{ data: [{ id: "a" }, { id: "b" }, { id: "a" }] }, ["a", "b"]],
    [{ models: [{ name: "a" }, "b", { id: "" }, 7] }, ["a", "b"]],
    [{ data: [] }, []],
  ];
  for (const [payload, models] of cases) {
    const server = answering({ body: JSON.stringify(payload) });
    await withServer(server.handler, async ({ baseUrl }) => {
      const result = await fetchModelCatalog({ baseUrl, listPath: LIST_PATH, header: "authorization", apiKey: KEY });
      assert.deepEqual(result, { ok: true, models }, JSON.stringify(payload));
    });
  }
});

test("a rejected credential is unauthorized, and the key is not carried out of it", async () => {
  const server = answering({ status: 401, body: JSON.stringify({ error: { message: `Bearer ${KEY} is invalid` } }) });
  await withServer(server.handler, async ({ baseUrl }) => {
    const result = await fetchModelCatalog({ baseUrl, listPath: LIST_PATH, header: "authorization", apiKey: KEY });
    assert.deepEqual(result, { ok: false, reason: "unauthorized", status: 401 });
    assert.equal(JSON.stringify(result).includes(KEY), false, "no field of the result holds the credential");
  });
});

test("the status code decides, not the words in the body", async () => {
  const server = answering({ status: 403, body: JSON.stringify({ error: { message: "Unauthorized: the API key is invalid" } }) });
  await withServer(server.handler, async ({ baseUrl }) => {
    const result = await fetchModelCatalog({ baseUrl, listPath: LIST_PATH, header: "authorization", apiKey: KEY });
    assert.deepEqual(result, { ok: false, reason: "http-error", status: 403 });
  });
});

test("every other failure status is http-error with the status that said so, once", async () => {
  for (const status of [402, 403, 404, 429, 500, 529]) {
    const server = answering({ status, body: "{}" });
    await withServer(server.handler, async ({ baseUrl }) => {
      const result = await fetchModelCatalog({ baseUrl, listPath: LIST_PATH, header: "authorization", apiKey: KEY });
      assert.deepEqual(result, { ok: false, reason: "http-error", status }, `${status}`);
    });
    assert.equal(server.seen.length, 1, `${status} is reported, not retried`);
  }
});

test("a body that is not a model list is unreadable, not an empty list", async () => {
  const cases = [
    ["text/html", "<html><body>sign in</body></html>"],
    ["application/json", "not json at all"],
    ["application/json", JSON.stringify({ data: "none" })],
    ["application/json", ""],
  ];
  for (const [contentType, body] of cases) {
    const server = answering({ contentType, body });
    await withServer(server.handler, async ({ baseUrl }) => {
      const result = await fetchModelCatalog({ baseUrl, listPath: LIST_PATH, header: "authorization", apiKey: KEY });
      assert.deepEqual(result, { ok: false, reason: "unreadable", status: 200 }, `${contentType} ${body}`);
    });
  }
});

test("a port with nothing listening is a network error, and it is not a timeout", async () => {
  const baseUrl = await urlWithNothingListening();
  const started = Date.now();
  const result = await fetchModelCatalog({ baseUrl, listPath: LIST_PATH, header: "authorization", apiKey: KEY, timeoutMs: 5000 });
  assert.deepEqual(result, { ok: false, reason: "network-error", status: null });
  assert.equal(Date.now() - started < 4000, true, "a refused connection reports itself rather than waiting out the bound");
});

test("a server that never answers ends at the timeout, which is not a network error", async () => {
  await withServer(silent, async ({ baseUrl }) => {
    const started = Date.now();
    const result = await fetchModelCatalog({ baseUrl, listPath: LIST_PATH, header: "authorization", apiKey: KEY, timeoutMs: 150 });
    assert.deepEqual(result, { ok: false, reason: "timeout", status: null });
    assert.equal(Date.now() - started < 3000, true, "the bound is what ends it");
  });
});

test("a fetch that rejects is a network error, and its message is not repeated", async () => {
  const result = await fetchModelCatalog({
    baseUrl: "https://api.example.invalid",
    listPath: LIST_PATH,
    header: "authorization",
    apiKey: KEY,
    fetchImpl: async () => {
      throw new Error(`failed to fetch https://api.example.invalid — Authorization: Bearer ${KEY}`);
    },
  });
  assert.deepEqual(result, { ok: false, reason: "network-error", status: null });
  assert.equal(JSON.stringify(result).includes(KEY), false);
});

test("the timeout has a default, and a missing value is the default rather than no bound", async () => {
  const realSetTimeout = globalThis.setTimeout;
  const delays = [];
  globalThis.setTimeout = (callback, delay, ...rest) => {
    delays.push(delay);
    return realSetTimeout(callback, delay, ...rest);
  };
  try {
    const answer = { fetchImpl: async () => new Response(JSON.stringify({ data: [] })) };
    assert.deepEqual(await fetchModelCatalog({ baseUrl: "https://api.example.invalid", listPath: LIST_PATH, ...answer }), { ok: true, models: [] });
    assert.deepEqual(await fetchModelCatalog({ baseUrl: "https://api.example.invalid", listPath: LIST_PATH, ...answer, timeoutMs: 0 }), { ok: true, models: [] });
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
  assert.equal(delays.includes(8000), true, "an absent or unusable timeout is 8 seconds");
});

// ── proving a base URL and a credential ─────────────────────────────────────

test("the connection test is the documented one-token request to the messages endpoint", async () => {
  const server = answering({ body: JSON.stringify({ id: "msg_01ABC", type: "message" }) });
  await withServer(server.handler, async ({ baseUrl }) => {
    const result = await testProviderConnection({ baseUrl: `${baseUrl}/anthropic`, header: "authorization", apiKey: KEY, model: "deepseek-v4-pro" });
    assert.deepEqual(result, { state: "connected", status: 200 });
  });
  assert.equal(server.seen.length, 1, "one request");
  const [request] = server.seen;
  assert.equal(request.method, "POST");
  assert.equal(request.url, "/anthropic/v1/messages");
  assert.equal(request.headers.authorization, `Bearer ${KEY}`);
  assert.equal(request.url.includes(KEY), false);
  assert.deepEqual(JSON.parse(request.body), {
    model: "deepseek-v4-pro",
    max_tokens: 1,
    messages: [{ role: "user", content: "ping" }],
  });
});

// A provider whose agent speaks its own format documents its models at an
// address of its own, and that address is what proves it: docs/provider-endpoints.md
// records one per vendor — Moonshot's lives on the host root and 404s under
// `/anthropic` — so the probe asks the vendor's own route rather than inventing
// one from a base URL (the route Codex itself joins to `base_url` is not
// verified anywhere, and a guessed one only moves the false alarm). The address
// also decides what a failure means: a 404 here is the list address being wrong,
// and can never be a model name to change.
test("a provider with a documented list is proved by that list, not by a second invented route", async () => {
  const server = answering({ body: JSON.stringify({ data: [{ id: "deepseek-v4-pro" }] }) });
  await withServer(server.handler, async ({ baseUrl }) => {
    const result = await testProviderConnection({ baseUrl: `${baseUrl}/anthropic`, listUrl: `${baseUrl}/models`, header: "Authorization", apiKey: KEY, model: "deepseek-v4-pro" });
    assert.deepEqual(result, { state: "connected", status: 200 });
  });
  assert.equal(server.seen.length, 1, "one request");
  const [request] = server.seen;
  assert.equal(request.method, "GET");
  assert.equal(request.url, "/models", "the vendor's own address, not the Anthropic base with a route guessed onto it");
  assert.equal(request.headers.authorization, `Bearer ${KEY}`);
  assert.equal(request.headers["content-type"], undefined, "a list is a GET: there is no body to describe");
  assert.equal(request.body, "");
  assert.equal(request.url.includes(KEY), false);
});

test("a list address under a root the user runs is joined to that root", async () => {
  const server = answering({ body: JSON.stringify({ data: [{ id: "m" }] }) });
  await withServer(server.handler, async ({ baseUrl }) => {
    const result = await testProviderConnection({ baseUrl: `${baseUrl}/proxy`, listUrl: "/v1/models", header: "authorization", apiKey: KEY, model: "m" });
    assert.deepEqual(result, { state: "connected", status: 200 });
  });
  assert.equal(server.seen[0].url, "/proxy/v1/models");
});

test("a list that does not carry the model is the one answer that is about the model", async () => {
  const server = answering({ body: JSON.stringify({ data: [{ id: "deepseek-flash" }] }) });
  await withServer(server.handler, async ({ baseUrl }) => {
    const result = await testProviderConnection({ baseUrl, listUrl: `${baseUrl}/models`, header: "authorization", apiKey: KEY, model: "deepseek-v4-pro" });
    assert.deepEqual(result, { state: "model-unavailable", status: 200 });
  });
});

test("a list address that answers 404 is a wrong address, never a model to change", async () => {
  for (const status of [404, 403, 429, 500]) {
    const server = answering({ status, body: "{}" });
    await withServer(server.handler, async ({ baseUrl }) => {
      const result = await testProviderConnection({ baseUrl, listUrl: `${baseUrl}/models`, header: "authorization", apiKey: KEY, model: "deepseek-v4-pro" });
      assert.deepEqual(result, { state: "http-error", status }, `${status}`);
      assert.notEqual(result.state, "model-unavailable", "nothing a 404 says is about the model name");
    });
  }
});

test("a rejected credential on the list is authentication-failed, and the key is not carried out of it", async () => {
  const server = answering({ status: 401, body: JSON.stringify({ error: { message: `Bearer ${KEY} is invalid` } }) });
  await withServer(server.handler, async ({ baseUrl }) => {
    const result = await testProviderConnection({ baseUrl, listUrl: `${baseUrl}/models`, header: "x-api-key", apiKey: KEY, model: "m" });
    assert.deepEqual(result, { state: "authentication-failed", status: 401 });
    assert.equal(JSON.stringify(result).includes(KEY), false);
  });
  assert.equal(server.seen[0].headers["x-api-key"], KEY);
  assert.deepEqual([server.seen[0].method, server.seen[0].url], ["GET", "/models"], "the rejected credential was sent to the list address");
});

test("an empty list proves the address and the key, and nothing about the model", async () => {
  const server = answering({ body: JSON.stringify({ data: [] }) });
  await withServer(server.handler, async ({ baseUrl }) => {
    const result = await testProviderConnection({ baseUrl, listUrl: `${baseUrl}/models`, header: "authorization", apiKey: KEY, model: "anything" });
    assert.deepEqual(result, { state: "connected", status: 200 });
  });
  assert.deepEqual([server.seen[0].method, server.seen[0].url], ["GET", "/models"], "the empty list is what answered, not the messages route");
});

test("a list address that answers something other than a list is unreadable", async () => {
  const server = answering({ contentType: "text/html", body: "<html><body>sign in to the wifi</body></html>" });
  await withServer(server.handler, async ({ baseUrl }) => {
    const result = await testProviderConnection({ baseUrl, listUrl: `${baseUrl}/models`, header: "authorization", apiKey: KEY, model: "m" });
    assert.deepEqual(result, { state: "unreadable", status: 200 });
  });
  assert.deepEqual([server.seen[0].method, server.seen[0].url], ["GET", "/models"], "the sign-in page was the list address's answer");
});

test("a gateway that authenticated before rejecting the model is model-unavailable", async () => {
  const server = answering({ status: 404, body: JSON.stringify({ type: "error", error: { type: "not_found_error", message: "model: nope" } }) });
  await withServer(server.handler, async ({ baseUrl }) => {
    const result = await testProviderConnection({ baseUrl, header: "authorization", apiKey: KEY, model: "nope" });
    assert.deepEqual(result, { state: "model-unavailable", status: 404 });
  });
});

test("a rejected credential is authentication-failed, and the key is not carried out of it", async () => {
  for (const header of ["authorization", "x-api-key"]) {
    const server = answering({ status: 401, body: JSON.stringify({ error: { message: `Bearer ${KEY} is invalid` } }) });
    await withServer(server.handler, async ({ baseUrl }) => {
      const result = await testProviderConnection({ baseUrl, header, apiKey: KEY, model: "m" });
      assert.deepEqual(result, { state: "authentication-failed", status: 401 });
      assert.equal(JSON.stringify(result).includes(KEY), false);
    });
    assert.equal(server.seen[0].headers[header], header === "authorization" ? `Bearer ${KEY}` : KEY);
  }
});

test("server trouble is http-error with its status, and it is not retried", async () => {
  for (const status of [403, 429, 500, 529]) {
    const server = answering({ status, body: JSON.stringify({ error: { message: "the key is invalid" } }) });
    await withServer(server.handler, async ({ baseUrl }) => {
      const result = await testProviderConnection({ baseUrl, header: "authorization", apiKey: KEY, model: "m" });
      assert.deepEqual(result, { state: "http-error", status }, `${status}`);
    });
    assert.equal(server.seen.length, 1, `${status} is reported, not retried`);
  }
});

test("an answer that is not the messages API is unreadable, because a captive portal is not a connection", async () => {
  const server = answering({ contentType: "text/html", body: "<html><body>sign in to the wifi</body></html>" });
  await withServer(server.handler, async ({ baseUrl }) => {
    const result = await testProviderConnection({ baseUrl, header: "authorization", apiKey: KEY, model: "m" });
    assert.deepEqual(result, { state: "unreadable", status: 200 });
  });
});

test("a local gateway with no credential is asked without a header", async () => {
  const server = answering({ body: JSON.stringify({ id: "msg_01ABC" }) });
  await withServer(server.handler, async ({ baseUrl }) => {
    const result = await testProviderConnection({ baseUrl, header: "authorization", model: "m" });
    assert.deepEqual(result, { state: "connected", status: 200 });
  });
  assert.equal(server.seen[0].headers.authorization, undefined);
});

test("a refused connection and a silent server are told apart here too", async () => {
  const refused = await testProviderConnection({ baseUrl: await urlWithNothingListening(), header: "authorization", apiKey: KEY, model: "m", timeoutMs: 5000 });
  assert.deepEqual(refused, { state: "network-error", status: null });
  const refusedList = await testProviderConnection({ baseUrl: await urlWithNothingListening(), listUrl: "/v1/models", header: "authorization", apiKey: KEY, model: "m", timeoutMs: 5000 });
  assert.deepEqual(refusedList, { state: "network-error", status: null });

  await withServer(silent, async ({ baseUrl }) => {
    const result = await testProviderConnection({ baseUrl, header: "authorization", apiKey: KEY, model: "m", timeoutMs: 150 });
    assert.deepEqual(result, { state: "timeout", status: null });
    const listed = await testProviderConnection({ baseUrl, listUrl: "/v1/models", header: "authorization", apiKey: KEY, model: "m", timeoutMs: 150 });
    assert.deepEqual(listed, { state: "timeout", status: null }, "the bound is on the exchange, not on the kind of request it is");
  });

  const thrown = await testProviderConnection({
    baseUrl: "https://api.example.invalid",
    header: "authorization",
    apiKey: KEY,
    model: "m",
    fetchImpl: async () => {
      throw new Error(`socket hang up — Authorization: Bearer ${KEY}`);
    },
  });
  assert.deepEqual(thrown, { state: "network-error", status: null });
  assert.equal(JSON.stringify(thrown).includes(KEY), false);
});

// ── the cache the Center reads without a network call ───────────────────────

test("the cache lives under the project, one file per provider", async () => {
  await withTemp(async (root) => {
    assert.equal(modelCatalogCachePath(root, "deepseek"), path.join(root, ".agents", "cache", "models", "deepseek.json"));
    assert.equal(modelCatalogCachePath(root, "Minimax-CN"), path.join(root, ".agents", "cache", "models", "minimax-cn.json"));
  });
});

test("what was fetched is what is read back", async () => {
  await withTemp(async (root) => {
    const before = Date.now();
    const written = await writeModelCatalogCache(root, "deepseek", { baseUrl: "https://api.deepseek.com/anthropic", models: ["deepseek-v4-pro", "deepseek-flash"] });
    const read = await readModelCatalogCache(root, "deepseek");
    assert.deepEqual(read, written);
    assert.equal(read.providerId, "deepseek");
    assert.equal(read.baseUrl, "https://api.deepseek.com/anthropic");
    assert.deepEqual(read.models, ["deepseek-v4-pro", "deepseek-flash"], "the provider's order is kept");
    const fetchedAt = Date.parse(read.fetchedAt);
    assert.equal(fetchedAt >= before && fetchedAt <= Date.now(), true, "the moment it was fetched is on the record");
  });
});

test("a later fetch replaces the earlier one and leaves nothing beside it", async () => {
  await withTemp(async (root) => {
    await writeModelCatalogCache(root, "deepseek", { baseUrl: "https://old.example", models: ["old"] });
    await writeModelCatalogCache(root, "deepseek", { baseUrl: "https://new.example", models: ["new"] });
    assert.deepEqual((await readModelCatalogCache(root, "deepseek")).models, ["new"]);
    assert.deepEqual(await readdir(path.dirname(modelCatalogCachePath(root, "deepseek"))), ["deepseek.json"], "one whole file, never a half-written one beside it");
  });
});

test("a cache that is missing, unreadable or not a cache is null rather than an error", async () => {
  await withTemp(async (root) => {
    assert.equal(await readModelCatalogCache(root, "deepseek"), null, "no directory yet");
    const file = modelCatalogCachePath(root, "deepseek");
    await writeModelCatalogCache(root, "deepseek", { baseUrl: "https://api.deepseek.com/anthropic", models: ["m"] });
    for (const content of ["", "{ truncated", "[]", "null", JSON.stringify({ models: "m" }), JSON.stringify({ baseUrl: "https://x", models: "m" }), JSON.stringify({ providerId: "deepseek", baseUrl: "  ", models: ["m"] })]) {
      await writeFile(file, content);
      assert.equal(await readModelCatalogCache(root, "deepseek"), null, JSON.stringify(content));
    }
    // A provider that answered with nothing is a fetch that succeeded, so the
    // record it left is a record — an empty list, not a broken file.
    await writeFile(file, JSON.stringify({ providerId: "deepseek", baseUrl: "https://api.deepseek.com/anthropic", fetchedAt: "2026-09-24T00:00:00.000Z", models: [] }));
    assert.deepEqual((await readModelCatalogCache(root, "deepseek")).models, []);
    await rm(file, { force: true });
    await mkdir(file);
    assert.equal(await readModelCatalogCache(root, "deepseek"), null, "a directory where the file should be is still not a cache");
  });
});

test("names that are not names are dropped rather than surfaced as models", async () => {
  await withTemp(async (root) => {
    const file = modelCatalogCachePath(root, "p");
    await writeModelCatalogCache(root, "p", { baseUrl: "https://x", models: ["a", "", "  ", 7, null, "b"] });
    assert.deepEqual((await readModelCatalogCache(root, "p")).models, ["a", "b"]);
    await writeFile(file, JSON.stringify({ providerId: "p", baseUrl: "https://x", fetchedAt: "2026-09-24T00:00:00.000Z", models: ["a", 7, "b"] }));
    assert.deepEqual((await readModelCatalogCache(root, "p")).models, ["a", "b"]);
  });
});

test("a provider id from a card cannot name a file outside the cache", async () => {
  await withTemp(async (root) => {
    const models = path.join(root, ".agents", "cache", "models");
    for (const providerId of ["../../escape", "..", "a/b", "", null]) {
      const file = modelCatalogCachePath(root, providerId);
      assert.equal(path.dirname(file), models, `${providerId} stays in the models directory`);
    }
    await writeModelCatalogCache(root, "../../escape", { baseUrl: "https://x", models: ["m"] });
    assert.deepEqual((await readModelCatalogCache(root, "../../escape")).models, ["m"], "and it is still readable as what it is");
    assert.deepEqual(await readdir(path.join(root, ".agents", "cache")), ["models"], "nothing was written beside the cache");
  });
});

test("a cache is never written from something that is not a fetch result", async () => {
  await withTemp(async (root) => {
    for (const fields of [{ models: ["m"] }, { baseUrl: "https://x", models: "m" }, { baseUrl: "", models: [] }]) {
      await assert.rejects(writeModelCatalogCache(root, "p", fields), TypeError, JSON.stringify(fields));
    }
    assert.equal(await readModelCatalogCache(root, "p"), null);
  });
});

// ── the credential, everywhere it must not be ───────────────────────────────

test("the key is nowhere but the request header: not in a log, not in the cache, not in a result", async () => {
  const captured = [];
  const realConsole = {};
  for (const method of ["log", "info", "warn", "error", "debug"]) {
    realConsole[method] = console[method];
    console[method] = (...args) => captured.push(args.map(String).join(" "));
  }
  const realStdoutWrite = process.stdout.write;
  const realStderrWrite = process.stderr.write;
  process.stdout.write = (chunk) => { captured.push(String(chunk)); return true; };
  process.stderr.write = (chunk) => { captured.push(String(chunk)); return true; };
  try {
    await withTemp(async (root) => {
      const server = answering({ status: 401, body: JSON.stringify({ error: { message: `the key ${KEY} was rejected` } }) });
      await withServer(server.handler, async ({ baseUrl }) => {
        const refused = await fetchModelCatalog({ baseUrl, listPath: LIST_PATH, header: "authorization", apiKey: KEY });
        assert.equal(JSON.stringify(refused).includes(KEY), false, "the result is not a place a credential travels");
      });

      const list = answering({ body: JSON.stringify({ data: [{ id: "deepseek-v4-pro" }] }) });
      await withServer(list.handler, async ({ baseUrl }) => {
        const fetched = await fetchModelCatalog({ baseUrl, listPath: LIST_PATH, header: "authorization", apiKey: KEY });
        assert.deepEqual(fetched, { ok: true, models: ["deepseek-v4-pro"] }, "the result is a model list and nothing else — not a place a key could ride along");
        await writeModelCatalogCache(root, "deepseek", { baseUrl, models: fetched.models });
      });

      const onDisk = await readFile(modelCatalogCachePath(root, "deepseek"), "utf8");
      assert.equal(onDisk.includes(KEY), false, "the cache is a model list, not a place a credential is kept");
      assert.equal(onDisk.includes("apiKey"), false, "there is no field to put one in");
      await testProviderConnection({ baseUrl: "https://api.example.invalid", header: "authorization", apiKey: KEY, model: "m", fetchImpl: async () => { throw new Error(KEY); } });
      // A scan proves nothing unless it can fail: this is the one line that
      // writes the credential down, and it is the only one the capture may hold.
      console.log(`self-check ${KEY}`);
    });
  } finally {
    for (const method of Object.keys(realConsole)) console[method] = realConsole[method];
    process.stdout.write = realStdoutWrite;
    process.stderr.write = realStderrWrite;
  }
  assert.deepEqual(captured.filter((line) => line.includes(KEY)), [`self-check ${KEY}`], "nothing but the self-check wrote the credential down — and the capture holds what it is written");
});

// ── what the module does when it is loaded ──────────────────────────────────

test("loading the module makes no request, and the fetch it uses is read at call time", async () => {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ data: [{ id: "m" }] }));
  };
  try {
    const fresh = await import(`${MODULE_URL}?fresh=${Date.now()}`);
    assert.equal(calls.length, 0, "importing is not using the network");
    assert.deepEqual(await fresh.fetchModelCatalog({ baseUrl: "https://api.example.invalid", listPath: LIST_PATH, header: "authorization", apiKey: KEY }), { ok: true, models: ["m"] });
    assert.equal(calls.length, 1, "the global fetch is what a call without fetchImpl uses");
    const connection = await fresh.testProviderConnection({ baseUrl: "https://api.example.invalid", header: "authorization", apiKey: KEY, model: "m" });
    assert.deepEqual(connection, { state: "connected", status: 200 });
    assert.equal(calls.length, 2);
    await withTemp(async (root) => {
      assert.equal(await fresh.readModelCatalogCache(root, "p"), null);
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});
