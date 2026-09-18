import { readFileSync } from "node:fs";
import process from "node:process";
import { takeOption } from "./options.mjs";
import { isInteractive, select } from "./prompts.mjs";
import {
  bindProject,
  clearProjectBinding,
  fail,
  getProfile,
  listProfiles,
  maskSecret,
  modelsFile,
  normalizeProfile,
  parseConfigJson,
  parseConfigText,
  PRESETS,
  projectModelFile,
  projectModelStatus,
  removeProfile,
  resolveProjectProfile,
  testConnection,
  upsertProfile,
} from "#core";

// normalizeProfile 是「白名单化」：没传的字段不留原值、而是取默认值。所以凡是 flags
// 表达不了的字段都必须从 existing 逐项带过（语义＝不修改）——否则 `model edit <id> --name X`
// 会顺手清掉 overrides/codex/opencode/env/toggles/claude，并把 endpoint.authField 悄悄换回默认。
// 新增 field 时同步加到这里：漏一个就是又一次静默丢失（vscode 侧 services/model.ts 同理）。
function profileInputFrom(flags, existing = null) {
  return normalizeProfile(
    {
      id: flags.id ?? existing?.id,
      name: flags.name ?? existing?.name,
      endpoint: {
        baseUrl: flags.baseUrl ?? existing?.endpoint.baseUrl,
        api: flags.api ?? existing?.endpoint.api,
        authField: existing?.endpoint.authField,
        apiKey: flags.apiKey ?? existing?.endpoint.apiKey,
      },
      overrides: existing?.overrides,
      models: flags.model ? { ...(existing?.models ?? {}), main: { id: flags.model } } : existing?.models,
      toggles: existing?.toggles,
      env: existing?.env,
      claude: existing?.claude,
      codex: existing?.codex,
      opencode: existing?.opencode,
    },
    { existing },
  );
}

function summarize(profile) {
  return [
    `Profile    ${profile.name} (${profile.id})`,
    `Endpoint   ${profile.endpoint.baseUrl} (${profile.endpoint.api})`,
    `API key    ${maskSecret(profile.endpoint.apiKey)}`,
    `Main model ${profile.models?.main?.id ?? "—"}`,
  ].join("\n");
}

function slugify(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 32);
}

// 裁决 2：core 只导出 maskSecret（任何值都掩成 ••••），而 clear 的冲突提示恰恰要告诉用户
// "你的哪个值没被动"——掩掉就失去了信息。这里定义局部格式化：非字符串 → String()；
// 超过 60 字符 → 截断加 …；空 → —。不改 core 的导出面（T1 已冻结）。
function maskValue(value) {
  const text = typeof value === "string" ? value : String(value);
  if (text.length === 0) return "—";
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

const SECRET_FIELD = /(key|token|secret)/i;

// 粘贴预览的值一律先过这里：密钥类字段先 maskSecret（裁决 3：绝不回显 apiKey 明文），
// 再统一走 maskValue 的截断/空值语义。
function previewValue(field, value) {
  const text = String(value);
  return SECRET_FIELD.test(field) ? maskValue(maskSecret(text)) : maskValue(text);
}

function readPaste(spec) {
  try {
    return readFileSync(spec === "-" ? 0 : spec, "utf8");
  } catch (error) {
    return fail(`Cannot read the pasted configuration (${spec}): ${error.message}`);
  }
}

// 裁决 3：`--json <file|->` 只做预览——读文件或 stdin、解析、回显识别结果，
// 绝不落盘、绝不触碰库（"粘贴永不自动保存"，spec §10）。
function previewPaste(spec, io) {
  const text = readPaste(spec);
  let parsed;
  let form;
  try {
    parsed = parseConfigJson(text);
    form = parsed.form;
  } catch {
    parsed = parseConfigText(text);
    form = "text";
  }
  // 两条分支都会给出 warnings（如"这个值看起来是掩码，已忽略"）：只打印文本分支的会
  // 让 JSON 粘贴的说明静默丢失。
  const warnings = parsed.warnings ?? [];
  io.log("Pasted configuration (preview — nothing was saved)\n");
  io.log(`Form  ${form}`);
  io.log("\nRecognized");
  if (parsed.recognized.length === 0) io.log("  —");
  for (const entry of parsed.recognized) {
    io.log(`  ${entry.field.padEnd(12)} ${previewValue(entry.field, entry.value)}`);
  }
  io.log("\nCandidates");
  for (const [field, values] of Object.entries(parsed.candidates)) {
    const list = Array.isArray(values) ? values : [values];
    io.log(`  ${field.padEnd(12)} ${list.map((value) => previewValue(field, value)).join(", ")}`);
  }
  for (const warning of warnings) io.log(`\n⚠ ${warning}`);
  io.log("\nPaste recognition never saves automatically — run avenic model add with explicit flags to store a profile.");
  return 0;
}

// `--json <file|->` 时读文件或 stdin 后走 parseConfigJson/parseConfigText 只回显识别结果（不写库）
function parseProfileFlags(argumentsList) {
  const flags = {};
  const rest = [...argumentsList];
  flags.name = takeOption(rest, "--name");
  flags.id = takeOption(rest, "--id");
  flags.baseUrl = takeOption(rest, "--base-url");
  flags.apiKey = takeOption(rest, "--api-key");
  flags.api = takeOption(rest, "--api");
  flags.model = takeOption(rest, "--model");
  flags.json = takeOption(rest, "--json");
  if (rest.length > 0) fail(`Unknown option: ${rest[0]}`);
  return flags;
}

export async function dispatchModel(argumentsList, options = {}) {
  const io = options.io ?? console;
  const environment = options.environment ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const [command = "show", ...rest] = argumentsList;

  if (command === "show") {
    if (rest.length > 0) fail("Usage: avenic model show");
    const resolved = await resolveProjectProfile(cwd, environment, io);
    if (resolved.message) io.log(resolved.message);
    io.log(`\nModel configuration\n`);
    io.log(`Library          ${modelsFile(environment)}`);
    io.log(`Project          ${projectModelFile(cwd)}`);
    io.log(`Current profile  ${resolved.profile ? `${resolved.profile.name} (${resolved.profile.id})` : "Not bound"}`);
    if (resolved.profile) {
      io.log(summarize(resolved.profile));
      const status = await projectModelStatus(cwd, environment);
      io.log(`Projection  ${status.projection ? `${status.projection.file} (${status.projection.keys} keys, fingerprint ${status.projection.fingerprintMatches ? "match" : "stale"})` : "—"}`);
      io.log("Codex       startup injection (-c model_provider=… / -m)");
      io.log("OpenCode    startup injection (OPENCODE_CONFIG_CONTENT)");
    }
    return 0;
  }

  if (command === "list") {
    const profiles = await listProfiles(environment);
    const status = await projectModelStatus(cwd, environment);
    io.log("\nLocal profiles\n");
    for (const profile of profiles) {
      const marker = profile.id === status.binding.activeProfileId ? ">" : " ";
      io.log(`${marker} ${profile.name} (${profile.id})   ${profile.endpoint.baseUrl}   ${maskSecret(profile.endpoint.apiKey)}`);
    }
    io.log("\n> = current project");
    return 0;
  }

  if (command === "add" || command === "set") {
    const flags = parseProfileFlags(rest);
    if (flags.json) return previewPaste(flags.json, io);
    // 计划原稿在这里还有一次未使用的 `listProfiles` 读取（返回值从不使用）；
    // add/set 之后的 getProfile/upsertProfile 都会读库，失败语义完全一致，故删除。
    const boundId = (await projectModelStatus(cwd, environment)).binding.activeProfileId;
    const id = flags.id ?? boundId ?? (flags.name ? slugify(flags.name) : null);
    if (!id) fail("A profile name is required: avenic model add --name <name> --base-url <url> --api-key <key> [--id <id>]");
    const existing = await getProfile(environment, id);
    if (command === "set" && !existing) fail(`Unknown profile: ${id}`);
    await upsertProfile(environment, profileInputFrom({ ...flags, id }, existing), io);
    io.log(`${command === "add" && !existing ? "Added" : "Updated"} profile\n\n${summarize(await getProfile(environment, id))}`);
    return 0;
  }

  if (command === "edit") {
    const [id, ...rest2] = rest;
    if (!id) fail("Usage: avenic model edit <id> [--name … --base-url … --api-key … --api … --model …]");
    const flags = parseProfileFlags(rest2);
    if (flags.json) return previewPaste(flags.json, io);
    const existing = await getProfile(environment, id);
    if (!existing) fail(`Unknown profile: ${id}`);
    await upsertProfile(environment, profileInputFrom({ ...flags, id }, existing), io);
    io.log(`Updated profile\n\n${summarize(await getProfile(environment, id))}`);
    return 0;
  }

  if (command === "use") {
    const [id] = rest;
    if (rest.length > 1) fail("Usage: avenic model use [id]");
    let targetId = id;
    if (!targetId) {
      const profiles = await listProfiles(environment);
      if (profiles.length === 0) fail("The local library is empty: avenic model add --name … --base-url … --api-key …");
      if (!isInteractive()) fail("Usage: avenic model use <id>");
      targetId = await select({ title: "Choose a profile", options: profiles.map((profile) => ({ value: profile.id, label: profile.name })), initial: 0 });
      if (targetId === null) { io.log("No change."); return 0; }
    }
    const result = await bindProject(cwd, environment, targetId, io);
    io.log(`Current profile  ${result.binding.activeProfileId}`);
    io.log(`Projection       ${result.projection.file} (${result.projection.keys} keys, ${result.changed ? "updated" : "unchanged"})`);
    return 0;
  }

  if (command === "clear") {
    if (rest.length > 0) fail("Usage: avenic model clear");
    const result = await clearProjectBinding(cwd, environment, io);
    io.log(result.changed ? "Project binding cleared" : "No project binding");
    for (const conflict of result.conflicts) {
      io.log(`⚠ ${conflict.path.join(".")} was edited by hand — left untouched: ${maskValue(conflict.current)}`);
    }
    return 0;
  }

  if (command === "remove") {
    const [id] = rest;
    if (!id || rest.length > 1) fail("Usage: avenic model remove <id>");
    const result = await removeProfile(environment, id, io);
    io.log(result.changed ? `Removed ${id} from the local library` : `Unknown profile: ${id}`);
    // 库是设备级的：无法枚举哪些项目绑定了它；绑定它的项目在下次触达时按 §7 清理。
    io.log("Projects bound to this profile will fall back to their Agent defaults on their next launch.");
    return 0;
  }

  if (command === "test") {
    const [id] = rest;
    if (rest.length > 1) fail("Usage: avenic model test [id]");
    const profile = id ? await getProfile(environment, id) : (await resolveProjectProfile(cwd, environment, io)).profile;
    if (!profile) fail(id ? `Unknown profile: ${id}` : "No profile bound to this project");
    io.log(`Testing ${profile.name} — a real request will be sent to ${profile.endpoint.baseUrl}（消耗极少量额度；avenic 没有服务端）`);
    // 裁决 5：唯一偏离——探针可注入，测试用假的 testConnection 覆盖退出码 2/0 两条路径，
    // 绝不发真实请求。生产路径不传 options.testConnection，行为与逐字实现一致。
    const probe = options.testConnection ?? testConnection;
    const result = await probe(profile);
    io.log(`${result.ok ? "✓" : "✗"} ${result.message}`);
    if (result.url) io.log(`Request  POST ${result.url}`);
    if (result.model) io.log(`Model    ${result.model}`);
    return result.ok ? 0 : 2;
  }

  if (command === "presets") {
    for (const preset of PRESETS) io.log(`${preset.id.padEnd(16)} ${preset.label.padEnd(14)} ${preset.baseUrl} (${preset.api})`);
    io.log("\nPresets are a starting point only — check your provider's documentation.");
    return 0;
  }

  fail("Usage: avenic model <show|list|add|set|edit|use|clear|remove|test|presets>");
}
