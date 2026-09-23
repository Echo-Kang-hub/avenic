import { readFile } from "node:fs/promises";
import path from "node:path";
import { writeFileAtomic } from "./atomic-file.mjs";

// The two network calls the Model Configuration Center can make, and the cache
// it reads when it makes neither.
//
// Both are made with a credential the user pasted in, and neither is ever made
// unasked: a model list is fetched when the user asks for one, a connection is
// tested when the user asks for that — never on a page being drawn, never on a
// module being loaded. So nothing here runs at load time, holds state, or
// starts anything, and `fetch` is read when a call is made rather than when the
// file is imported.
//
// The credential goes in a header and nowhere else: not in a URL, not in a
// query, not in a log line, not in a cache file, and not in a returned result —
// a result is a fact about the provider, and a key is not one. `header` is the
// header *name*, because the name is what a provider documents: `Authorization`
// with a `Bearer ` prefix for the providers that follow Anthropic's variable,
// MiniMax's own `x-api-key` bare. A provider with no key yet, or a public model
// list, is asked without the header at all.
//
// What each call *means* comes from `docs/provider-endpoints.md`, which was
// read off the vendors' own pages: the paths, the model lists, the one-token
// test, and the rule that an answer is classified by its status code and never
// by its text — three providers say "unauthorized" in a 500 and one says "error"
// in a 200.

const DEFAULT_TIMEOUT_MS = 8000;
const CACHE_DIRECTORY = [".agents", "cache", "models"];

const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value) => (typeof value === "string" && value.trim() !== "" ? value.trim() : null);

/**
 * One request, one outcome, always an outcome. The bound covers the whole
 * exchange — the answer headers *and* the body — because a server that sends
 * headers and then stalls has not answered; and a request that ran out of time
 * is reported apart from a socket that failed, since "your provider is slow"
 * and "your base URL does not resolve" send a user to two different places.
 *
 * A rejection is only ever reported as itself. An error thrown by the platform
 * or by a proxy can quote the request that carried the credential, so the error
 * is not read, not wrapped and not re-thrown.
 */
async function request(doFetch, url, init, timeoutMs) {
  const bound = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, bound);
  try {
    const response = await doFetch(url, { ...init, signal: controller.signal });
    return { response, body: await response.text() };
  } catch {
    return { failure: expired ? "timeout" : "network-error" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `{baseUrl}{path}`, and the three ways that is not one string added to another.
 *
 * A list that is already a full URL is used as it stands: the preset table
 * carries the vendors' own list addresses, and the research is explicit that a
 * model list hangs off the *host* — Moonshot's answers at `/v1/models` on the
 * root and 404s under `/anthropic` — so joining one onto the other is how a
 * working provider becomes a 404. Only a proxy the user runs gets a path joined
 * onto a root, because that root is theirs to name; and a root with no path is
 * the root, not the root with a slash on the end of it.
 */
function endpoint(baseUrl, suffix) {
  const root = String(baseUrl ?? "").trim().replace(/\/+$/, "");
  const path = String(suffix ?? "").trim();
  if (/^https?:\/\//i.test(path)) return path;
  const tail = path.replace(/^\/+/, "");
  return tail === "" ? root : `${root}/${tail}`;
}

/** The credential header: the one place the key is ever put, and only if there is one. */
function credentialHeader(name, apiKey) {
  const key = text(apiKey);
  const field = text(name)?.toLowerCase();
  if (key === null || field === null) return {};
  return { [field]: field === "authorization" ? `Bearer ${key}` : key };
}

function parseBody(source) {
  try {
    return JSON.parse(source);
  } catch {
    return null;
  }
}

/** The model one entry names: a bare string, or the id/name/model field it carries. */
function entryName(entry) {
  if (typeof entry === "string") return text(entry);
  if (!isPlainObject(entry)) return null;
  return text(entry.id) ?? text(entry.name) ?? text(entry.model);
}

/** The provider's own order, without repeats and without entries that name nothing. */
function modelNames(entries) {
  const names = [];
  const seen = new Set();
  for (const entry of entries ?? []) {
    const name = entryName(entry);
    if (name !== null && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

/**
 * The list a model endpoint's body carries, or `null` when the body is not one.
 * The shapes are the ones the providers actually send — a bare array, OpenAI's
 * and Anthropic's `data`, and a `models` key. An empty list is a list: "this
 * provider offers nothing" and "this is not a model endpoint" are different
 * answers, and only the second is unreadable.
 */
function listedModels(payload) {
  if (Array.isArray(payload)) return modelNames(payload);
  if (!isPlainObject(payload)) return null;
  const entries = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : null;
  return entries === null ? null : modelNames(entries);
}

/**
 * Ask one provider for its model list. A failure is reported as what it was —
 * a refused credential, a status the provider chose, a socket that never
 * answered, the bound running out, or a body that is not a list — and never as
 * an empty list, which would read as "this provider has no models" and leave
 * the user looking in the wrong place.
 */
export async function fetchModelCatalog({ baseUrl, listPath, header, apiKey, timeoutMs, fetchImpl } = {}) {
  const doFetch = typeof fetchImpl === "function" ? fetchImpl : globalThis.fetch;
  const init = { method: "GET", headers: { accept: "application/json", ...credentialHeader(header, apiKey) } };
  // The two failures share their names with the reasons on purpose: there is
  // one vocabulary for "the socket failed" and one for "the bound ran out",
  // and a caller above this reads the same words either way.
  const outcome = await request(doFetch, endpoint(baseUrl, listPath), init, timeoutMs);
  if (outcome.failure) return { ok: false, reason: outcome.failure, status: null };
  const { status } = outcome.response;
  if (status === 401) return { ok: false, reason: "unauthorized", status };
  if (!outcome.response.ok) return { ok: false, reason: "http-error", status };
  const models = listedModels(parseBody(outcome.body));
  return models === null ? { ok: false, reason: "unreadable", status } : { ok: true, models };
}

/**
 * The cheapest request that proves a base URL and a credential — two of them,
 * because the two families document two different things.
 *
 * A provider with a model list is asked for the list, at the address the
 * research records for that vendor. That is the vendor's own route, so it is not
 * a route guessed from a base URL: which route Codex itself joins to `base_url`
 * appears in no page that could be verified, and a guessed one only moves the
 * wrong answer somewhere else. The address also decides what a failure means —
 * a 404 here is the list address being wrong, and can never be a model name to
 * change, because no model was named in the request.
 *
 * A provider without one is asked in the Anthropic format, with the documented
 * one-token call to the messages endpoint. A 404 *there* is not a failed test:
 * the gateway authenticated before it rejected the model, so the URL and the key
 * are good and the model name is the thing to change.
 *
 * A success whose body is not JSON is not a connection in either case: a captive
 * portal, a proxy's sign-in page and a base URL missing its `/anthropic` all
 * answer 200 with something that is not the API, and calling that "connected"
 * sends the user to look for the fault in their key.
 */
export async function testProviderConnection({ baseUrl, header, apiKey, model, listUrl, timeoutMs, fetchImpl } = {}) {
  const doFetch = typeof fetchImpl === "function" ? fetchImpl : globalThis.fetch;
  const credential = credentialHeader(header, apiKey);
  const address = text(listUrl);
  if (address !== null) {
    // A full address is the vendor's own; a path is what a proxy the user runs
    // serves under a root of their own, and goes through the same join the
    // catalog fetch uses.
    const outcome = await request(doFetch, endpoint(baseUrl, address), { method: "GET", headers: { accept: "application/json", ...credential } }, timeoutMs);
    if (outcome.failure) return { state: outcome.failure, status: null };
    const { status } = outcome.response;
    if (status === 401) return { state: "authentication-failed", status };
    if (!outcome.response.ok) return { state: "http-error", status };
    const models = listedModels(parseBody(outcome.body));
    if (models === null) return { state: "unreadable", status };
    // An empty list proves the address and the key and says nothing at all about
    // the model, so it is no reason to send anyone looking for another name. A
    // list that names models, and not this one, is the only answer that is about
    // the model — and then it is the vendor's own list saying so.
    const wanted = text(model);
    if (models.length === 0 || wanted === null || models.includes(wanted)) return { state: "connected", status };
    return { state: "model-unavailable", status };
  }
  const body = JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] });
  const headers = { accept: "application/json", "content-type": "application/json", ...credential };
  const outcome = await request(doFetch, endpoint(baseUrl, "/v1/messages"), { method: "POST", headers, body }, timeoutMs);
  if (outcome.failure) return { state: outcome.failure, status: null };
  const { status } = outcome.response;
  if (status === 401) return { state: "authentication-failed", status };
  if (status === 404) return { state: "model-unavailable", status };
  if (!outcome.response.ok) return { state: "http-error", status };
  return parseBody(outcome.body) === null ? { state: "unreadable", status } : { state: "connected", status };
}

/**
 * A provider id as a file name. The ids come from the preset table, but an id
 * that arrived with a card or a hand-edited file must not be able to name a
 * path: everything that is not a letter or a digit becomes a dash, so no
 * separator, no dot and no `..` survives, and an unusable id still gets a file
 * of its own rather than the directory itself.
 */
function providerSlug(providerId) {
  const slug = String(providerId ?? "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug === "" ? "provider" : slug;
}

/** The file one provider's list is kept in, so a page can be drawn without a request. */
export function modelCatalogCachePath(projectRoot, providerId) {
  return path.join(projectRoot ?? ".", ...CACHE_DIRECTORY, `${providerSlug(providerId)}.json`);
}

/**
 * The list a previous fetch left behind, read without a network call. Anything
 * that is not one — absent, half-written, hand-edited, a directory in its place
 * — is `null`, because a cache is a convenience: a caller that gets a record
 * can draw it, and a caller that gets `null` fetches, or asks the user to.
 */
export async function readModelCatalogCache(projectRoot, providerId) {
  try {
    const record = JSON.parse((await readFile(modelCatalogCachePath(projectRoot, providerId), "utf8")).replace(/^\uFEFF/, ""));
    if (!isPlainObject(record) || !Array.isArray(record.models)) return null;
    const baseUrl = text(record.baseUrl);
    if (baseUrl === null) return null;
    return {
      providerId: text(record.providerId) ?? providerSlug(providerId),
      baseUrl,
      fetchedAt: text(record.fetchedAt),
      models: modelNames(record.models),
    };
  } catch {
    return null;
  }
}

/**
 * Keep a fetched list where the Center can read it without asking again. The
 * write goes through the one atomic writer the product uses, so a reader — a
 * dashboard, a watcher — never sees half a file. What is written is a model
 * list and the URL it came from: a fetch result carries no credential, and
 * there is no field here that could hold one.
 */
export async function writeModelCatalogCache(projectRoot, providerId, { baseUrl, models } = {}) {
  const url = text(baseUrl);
  if (url === null) throw new TypeError("a model catalog cache names the base URL its models were fetched from");
  if (!Array.isArray(models)) throw new TypeError("a model catalog cache holds a list of model names");
  const record = {
    providerId: text(providerId) ?? providerSlug(providerId),
    baseUrl: url,
    fetchedAt: new Date().toISOString(),
    models: modelNames(models),
  };
  await writeFileAtomic(modelCatalogCachePath(projectRoot, providerId), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}
