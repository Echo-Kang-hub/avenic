// A user's API configuration, written the way a user writes it.
//
// Avenic prepares the file its agent reads and nothing else: the provider, the
// endpoint, the model and the credential in it are the user's, put there by
// their own hand or by whatever tool they already configure agents with. A
// harness that needs "this project has a filled-in API configuration" therefore
// writes that file itself, in the agent's native shape — the same shape the
// agent reads. The path comes from core (`modelConfigTarget`), so a fixture
// cannot drift from the product. Nothing here ships, and no value in it is
// real.
//
// The root suite has the same helper for its own tests
// (test/helpers/api-fixture.mjs); this one is TypeScript so the extension's
// bundle can carry it into the visual and Extension-Host harnesses.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { modelConfigTarget } from "@avenic/core";

export interface FixtureConfiguration {
  baseUrl?: string;
  model?: string;
  /** A secret for Claude, an environment-variable *name* for Codex. */
  credential?: string;
  /** A Codex provider table's display name; Claude's Provider row is the endpoint's host. */
  provider?: string;
}

export async function fillApiConfiguration(
  projectRoot: string,
  agentId: string,
  scope: "global" | "project",
  fields: FixtureConfiguration = {},
  options: { homeDir?: string; environment?: Record<string, string | undefined> } = {},
): Promise<{ relative: string; file: string }> {
  const target = modelConfigTarget(projectRoot, agentId, scope, options);
  if (target === null) throw new Error(`${agentId} keeps its own provider configuration`);
  await mkdir(path.dirname(target.file), { recursive: true });
  await writeFile(target.file, agentId === "claude" ? claudeConfiguration(fields) : codexConfiguration(fields), "utf8");
  return { relative: target.relative, file: target.file };
}

/** A Claude settings file naming an endpoint, a model and a bearer token. */
export function claudeConfiguration({ baseUrl, model, credential }: FixtureConfiguration = {}): string {
  const env: Record<string, string> = {};
  if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl;
  if (model) env.ANTHROPIC_MODEL = model;
  if (credential) env.ANTHROPIC_AUTH_TOKEN = credential;
  return `${JSON.stringify({ env }, null, 2)}\n`;
}

/** A Codex config.toml naming a provider table, a model and a key variable. */
export function codexConfiguration({ provider, baseUrl, model, credential }: FixtureConfiguration = {}): string {
  const id = provider ? provider.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "custom" : null;
  const lines: string[] = [];
  if (model) lines.push(`model = "${model}"`);
  if (id) lines.push(`model_provider = "${id}"`);
  if (id || baseUrl) {
    lines.push("", `[model_providers.${id ?? "custom"}]`);
    if (provider) lines.push(`name = "${provider}"`);
    if (baseUrl) lines.push(`base_url = "${baseUrl}"`);
    if (credential) lines.push(`env_key = "${credential}"`);
  }
  return `${lines.join("\n")}\n`;
}
