// What ships is what must work. `integration/release-smoke.mjs` packs from the
// sources and proves they are installable; this proves the files prepared for a
// version — the tarballs and the VSIX under pack/ — are the same product, by
// installing them the way a user would and running them. It takes the versions
// from the manifests, so it never has to be told which release it is checking.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repo = process.argv[2] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Which `code` the VSIX is installed into, or null when this machine has none.
function resolveEditor() {
  try {
    // `where` prints its "not found" line on stderr, and execFileSync hands that
    // to this process by default: the caller says `code` is absent, so the tool
    // that looked for it does not also need to shout.
    const lines = execFileSync(process.platform === "win32" ? "where" : "which", ["code"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
    // `where` lists the POSIX script, the .cmd shim and a .ps1; only the shim is
    // executable from a shell.
    return (process.platform === "win32" ? lines.find((line) => /\.cmd$/i.test(line)) : lines[0]) ?? null;
  } catch {
    return null;
  }
}

// The editor's own outcome, as a decision with three outcomes rather than two.
// `code` refusing the VSIX and `code` not existing on this machine are different
// facts, and one branch that means both is how a package no editor will accept
// was reported as "no editor on PATH to install into" — with the version check
// skipped and the run green either way.
export function installVerdict({ editor, install, listed, expected }) {
  if (editor === null || editor === undefined) {
    return { status: "skipped", row: "", detail: `no editor on PATH — the VSIX was not installed into any editor (expected ${expected})` };
  }
  if (install === null || install === undefined || install.status !== 0) {
    const output = `${install?.stderr ?? ""}${install?.stdout ?? ""}`.trim().split(/\r?\n/).filter((line) => line.trim() !== "");
    return {
      status: "failed",
      row: "",
      detail: `${editor} --install-extension exited ${install?.status ?? "without a status"}: ${output.slice(-3).join(" / ") || "(no output)"}`,
    };
  }
  // An editor that installs the VSIX is the only proof of what was installed: the
  // publisher and the version come from the extension registry's own list, not
  // from the filename we chose.
  const row = (listed ?? "").split(/\r?\n/).map((line) => line.trim()).find((line) => /avenic/i.test(line)) ?? "";
  if (row === "") {
    return { status: "failed", row, detail: `${editor} installed, but nothing matching avenic is in its extension list (${JSON.stringify((listed ?? "").trim())})` };
  }
  if (row.toLowerCase() !== expected.toLowerCase()) {
    return { status: "failed", row, detail: `the editor installed ${row}, expected ${expected}` };
  }
  return { status: "installed", row, detail: `installed as ${row}` };
}

async function main() {
const manifest = (relative) => JSON.parse(readFileSync(path.join(repo, relative), "utf8"));
const versions = {
  cli: manifest("packages/cli/package.json").version,
  core: manifest("packages/core/package.json").version,
  extension: manifest("packages/vscode/package.json").version,
};
const artifacts = {
  cli: path.join(repo, "pack", `avenic-${versions.cli}.tgz`),
  core: path.join(repo, "pack", `avenic-core-${versions.core}.tgz`),
  extension: path.join(repo, "pack", `avenic-agent-manager-${versions.extension}.vsix`),
};
for (const [name, file] of Object.entries(artifacts)) {
  if (!existsSync(file)) throw new Error(`missing ${name} artifact: ${file} (build it first: npm run release:pack)`);
}

// The checksums beside the artifacts are the ones `release:pack` wrote for these
// exact bytes; a file that changed since then is not the file that was checked.
{
  const sumsPath = path.join(repo, "pack", "SHA256SUMS");
  if (!existsSync(sumsPath)) throw new Error("pack/SHA256SUMS is missing (build it: npm run release:pack)");
  for (const line of readFileSync(sumsPath, "utf8").trim().split(/\r?\n/)) {
    const [expected, name] = line.trim().split(/\s+/);
    const actual = createHash("sha256").update(readFileSync(path.join(repo, "pack", name))).digest("hex");
    if (actual !== expected) throw new Error(`pack/${name} is not the file SHA256SUMS describes (${actual})`);
  }
}

// What a file inside the package says about itself is checked before anything is
// installed: an icon is a file inside the package, and a manifest can name one
// that the package does not carry — the editor draws a broken image and installs
// it without failing, so no install check would notice.
const extensionManifest = manifest("packages/vscode/package.json");
{
  const entries = new Set(zipEntryNames(readFileSync(artifacts.extension)));
  const icons = {
    "media/icon.png": "the extension icon",
    "media/icon-activity.png": "the activity-bar icon",
    "media/avenic.png": "the mark the dashboard loads",
  };
  for (const [asset, what] of Object.entries(icons)) {
    if (!entries.has(`extension/${asset}`)) throw new Error(`the VSIX does not carry ${what} (${asset})`);
  }
  const declared = [["icon", extensionManifest.icon], ["viewsContainers.activitybar[0].icon", extensionManifest.contributes?.viewsContainers?.activitybar?.[0]?.icon]];
  for (const [field, asset] of declared) {
    if (typeof asset !== "string" || !entries.has(`extension/${asset}`)) {
      throw new Error(`package.json's ${field} points at ${JSON.stringify(asset)}, which is not in the VSIX`);
    }
  }
}

const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const windows = process.platform === "win32";
const root = await mkdtemp(path.join(os.tmpdir(), "avenic-artifacts-"));
const prefix = path.join(root, "prefix");
const project = path.join(root, "project");
const coreInstall = path.join(root, "core");
const home = path.join(root, "home");
for (const directory of [project, home, coreInstall]) await mkdir(directory, { recursive: true });

// 每一个「这个项目之外的家」都要点名，而不是只换 HOME 再继承环境：HOME 只挡住默认值，
// 开发机上一个 CLAUDE_CONFIG_DIR / CODEX_HOME / AVENIC_STATE_DIR（agent 自己的习惯，或
// 上一次实验留下的）会把这些命令的读写带回真实的家 —— 一次发布验证不该碰它。
const environment = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
  CODEX_HOME: path.join(home, ".codex"),
  AVENIC_STATE_DIR: path.join(home, ".avenic"),
  XDG_CONFIG_HOME: path.join(home, ".config"),
  XDG_DATA_HOME: path.join(home, ".local", "share"),
};

function run(executable, argumentsList, options = {}) {
  return spawnSync(executable, argumentsList, { encoding: "utf8", windowsHide: true, ...options });
}

// npm `.cmd` shims need a shell on Windows; every other platform runs the file.
function runLauncher(launcher, argumentsList, options = {}) {
  return windows
    ? run(`"${launcher}" ${argumentsList.map((argument) => `"${argument}"`).join(" ")}`, [], { shell: true, ...options })
    : run(launcher, argumentsList, options);
}

// The names inside a zip, read out of the central directory. A VSIX is a zip and
// nothing here needs its contents, only its table of contents — which is what
// tells a package that *names* an icon apart from one that carries it.
function zipEntryNames(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0) throw new Error("the VSIX has no zip end-of-directory record");
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const names = [];
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error(`the VSIX central directory is malformed at entry ${index}`);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    names.push(buffer.toString("utf8", offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

try {
  const installed = run(process.execPath, [npmCli, "install", "--global", artifacts.cli, "--prefix", prefix], { env: environment });
  if (installed.status !== 0) throw new Error(installed.stderr || installed.stdout);
  const binDirectory = windows ? prefix : path.join(prefix, "bin");
  const launcher = path.join(binDirectory, windows ? "avenic.cmd" : "avenic");
  const shorthand = path.join(binDirectory, windows ? "ave.cmd" : "ave");
  if (!existsSync(launcher) || !existsSync(shorthand)) throw new Error(`the install produced no launcher at ${launcher}`);

  const version = runLauncher(launcher, ["--version"], { cwd: project, env: environment });
  if (version.status !== 0 || !version.stdout.includes(versions.cli)) {
    throw new Error(`the installed CLI reports ${JSON.stringify(version.stdout.trim())}, expected ${versions.cli}`);
  }

  const init = runLauncher(launcher, ["init", "--agents", "claude,codex", "--auth", "account", "--scope", "global", "--sessions", "project", "--history", "shared"], { cwd: project, env: environment });
  if (init.status !== 0) throw new Error(init.stderr || init.stdout);
  if (!/◆ {2}Avenic project initialized/.test(init.stdout)) throw new Error(`init did not report a result page:\n${init.stdout}`);

  const status = runLauncher(launcher, ["status"], { cwd: project, env: environment });
  for (const block of ["Project", "History", "Agents", "Skills"]) {
    if (!status.stdout.includes(`◇  ${block}`)) throw new Error(`status is missing the ${block} block:\n${status.stdout}`);
  }
  if (/\x1b/.test(status.stdout)) throw new Error("piped status carried control sequences");

  const json = runLauncher(launcher, ["status", "--json"], { cwd: project, env: environment });
  const model = JSON.parse(json.stdout);
  if (model.history?.mode !== "shared") throw new Error(`status --json disagrees with the configuration: ${JSON.stringify(model.history)}`);

  // The core package is published on its own; it has to install and load
  // without the CLI's vendored copy standing in for it.
  const coreInstalled = run(process.execPath, [npmCli, "install", "--prefix", coreInstall, artifacts.core], { env: environment });
  if (coreInstalled.status !== 0) throw new Error(coreInstalled.stderr || coreInstalled.stdout);
  const probe = path.join(coreInstall, "probe.mjs");
  await writeFile(probe, `import { AGENTS, collectStatus } from "@avenic/core";\nif (typeof collectStatus !== "function" || Object.keys(AGENTS).length === 0) throw new Error("@avenic/core exported nothing usable");\nprocess.stdout.write("loaded");\n`, "utf8");
  const loaded = run(process.execPath, [probe], { cwd: coreInstall, env: environment });
  if (loaded.status !== 0 || !loaded.stdout.includes("loaded")) {
    throw new Error(`@avenic/core ${versions.core} did not load: ${loaded.stderr || loaded.stdout}`);
  }
  // The probe only proves something loaded. Which version did is a separate
  // fact, and the one an installer would get wrong by publishing a stale pack.
  const coreManifest = JSON.parse(readFileSync(path.join(coreInstall, "node_modules", "@avenic", "core", "package.json"), "utf8"));
  if (coreManifest.version !== versions.core) {
    throw new Error(`the installed core reports ${coreManifest.version}, expected ${versions.core}`);
  }

  // The extension is installed into a throwaway profile, never into the one
  // whoever runs this is using: `release:verify` is a check, and a check that
  // `--force`-installs over the editor someone works in is a side effect, not a
  // verification. Both directories live under this run's temp root, so the
  // editor that gets modified is deleted with the root — which also makes the
  // extension list below this run's, rather than whatever the real profile had.
  const editorHome = path.join(root, "vscode-profile");
  const editorDirectories = `--user-data-dir "${path.join(editorHome, "user")}" --extensions-dir "${path.join(editorHome, "extensions")}"`;
  await mkdir(path.join(editorHome, "extensions"), { recursive: true });

  // Which of the three facts a non-zero exit means — no editor here, an editor
  // that refused the package, or an editor that installed something else — is
  // decided by installVerdict before it is printed as anything.
  const editor = resolveEditor();
  const install = editor === null ? null : run(`"${editor}" --install-extension "${artifacts.extension}" --force ${editorDirectories}`, [], { shell: true });
  const listed = editor !== null && install.status === 0 ? run(`"${editor}" --list-extensions --show-versions ${editorDirectories}`, [], { shell: true }).stdout : "";
  const expectedExtension = `${extensionManifest.publisher}.${extensionManifest.name}@${versions.extension}`.toLowerCase();
  const extension = installVerdict({ editor, install, listed, expected: expectedExtension });
  if (extension.status === "failed") throw new Error(extension.detail);

  console.log(`avenic ${versions.cli}      installed, version, init, status, status --json`);
  console.log(`@avenic/core ${versions.core}   installed and loaded standalone`);
  console.log(`extension ${versions.extension}    ${extension.status === "installed"
    ? `installed as ${extension.row} into a throwaway profile, 3 icon assets carried and declared`
    : `SKIPPED — ${extension.detail}`}`);
  // A machine with no editor can still check everything else, so this stays a
  // skip rather than a failure — but it is not the same shape of line as a pass.
  // The install is the one thing this run did not do, so it is named in capitals
  // on the row that would otherwise be green, and the last word belongs to what
  // is missing: a summary read on its own cannot take this for a pass.
  if (extension.status === "skipped") {
    console.log("                   not checked: the VSIX install, so nothing above shows the package installs; its files were checked (checksums, 3 icon assets carried and declared)");
  }
} finally {
  // The throwaway editor profile is in here too, and an editor that has only
  // just exited can still hold a file on Windows for a moment; the retries are
  // for that window, not for a directory that refuses to go.
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
}

// Entry guard, not a bare call: importing this file (its install decision is
// tested without an editor) must not install anything.
const isEntry = process.argv[1] !== undefined && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isEntry) await main();
