// A user's API configuration, written the way a user writes it.
//
// Avenic prepares the file the agent reads and nothing else: the provider, the
// endpoint, the model and the credential in it are the user's, put there by
// their own hand or by whatever tool they already configure agents with. A test
// that needs "this project has a filled-in API configuration" therefore writes
// the file itself, in the agent's native shape — the same shape the agent
// reads. Nothing here ships, and no value in it is real.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { modelConfigTarget } from "../../packages/core/src/index.mjs";

/** A Claude settings file naming an endpoint, a model and a bearer token. */
export function claudeConfiguration({ baseUrl, model, credential, extra = {} } = {}) {
  const env = {};
  if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl;
  if (model) env.ANTHROPIC_MODEL = model;
  if (credential) env.ANTHROPIC_AUTH_TOKEN = credential;
  return `${JSON.stringify({ env, ...extra }, null, 2)}\n`;
}

/** A Codex config.toml naming a provider table, a model and a key variable. */
export function codexConfiguration({ provider, baseUrl, model, credential } = {}) {
  const id = String(provider ?? "custom").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "custom";
  const lines = [];
  if (model) lines.push(`model = "${model}"`);
  if (provider) lines.push(`model_provider = "${id}"`);
  if (provider || baseUrl) {
    lines.push("", `[model_providers.${id}]`);
    if (provider) lines.push(`name = "${provider}"`);
    if (baseUrl) lines.push(`base_url = "${baseUrl}"`);
    if (credential) lines.push(`env_key = "${credential}"`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Write one agent's configuration where that agent reads it, per scope. The
 * target comes from core so a fixture cannot drift from the product, and the
 * file it writes is the user's: created from nothing, never announced to the
 * ownership ledger, so every reader sees it for what it is — not Avenic's.
 */
export async function fillApiConfiguration(projectRoot, agentId, scope, fields = {}, options = {}) {
  const target = modelConfigTarget(projectRoot, agentId, scope, options);
  await mkdir(path.dirname(target.file), { recursive: true });
  await writeFile(target.file, agentId === "claude" ? claudeConfiguration(fields) : codexConfiguration(fields), "utf8");
  return { relative: target.relative, file: target.file };
}
