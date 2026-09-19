// What ships is what must work. `integration/release-smoke.mjs` packs from the
// sources and proves they are installable; this proves the files prepared for a
// version — the tarballs and the VSIX under pack/ — are the same product, by
// installing them the way a user would and running them. It takes the versions
// from the manifests, so it never has to be told which release it is checking.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repo = process.argv[2] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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

const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const windows = process.platform === "win32";
const root = await mkdtemp(path.join(os.tmpdir(), "avenic-artifacts-"));
const prefix = path.join(root, "prefix");
const project = path.join(root, "project");
const coreInstall = path.join(root, "core");
const home = path.join(root, "home");
for (const directory of [project, home, coreInstall]) await mkdir(directory, { recursive: true });

const environment = { ...process.env, HOME: home, USERPROFILE: home };

function run(executable, argumentsList, options = {}) {
  return spawnSync(executable, argumentsList, { encoding: "utf8", windowsHide: true, ...options });
}

// npm `.cmd` shims need a shell on Windows; every other platform runs the file.
function runLauncher(launcher, argumentsList, options = {}) {
  return windows
    ? run(`"${launcher}" ${argumentsList.map((argument) => `"${argument}"`).join(" ")}`, [], { shell: true, ...options })
    : run(launcher, argumentsList, options);
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

  const init = runLauncher(launcher, ["init", "--agents", "claude,codex", "--auth", "global", "--sessions", "project", "--history", "shared"], { cwd: project, env: environment });
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

  // The extension is installed into the real editor when one is on PATH; when
  // it has none, the VSIX is still built and named for its version.
  const editor = run(`code --install-extension "${artifacts.extension}" --force`, [], { shell: true });
  const installedExtension = editor.status === 0
    ? run("code --list-extensions --show-versions", [], { shell: true }).stdout
        .split(/\r?\n/).find((row) => /avenic/i.test(row)) ?? ""
    : "";

  console.log(`avenic ${versions.cli}      installed, version, init, status, status --json`);
  console.log(`@avenic/core ${versions.core}   installed and loaded standalone`);
  console.log(`extension ${versions.extension}    ${installedExtension ? `installed as ${installedExtension}` : "packaged (no editor on PATH to install into)"}`);
} finally {
  await rm(root, { recursive: true, force: true });
}
