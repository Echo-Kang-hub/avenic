// Produce the files a version is published from: the CLI tarball, the core
// tarball and the extension's VSIX, all into pack/, all named after the
// versions their manifests declare. The versions are read, never passed in —
// bumping a package.json is the only place a release number changes.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, rm, copyFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(repo, "pack");
const npmCli = process.env.npm_execpath ?? path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");

function run(executable, argumentsList, options = {}) {
  const result = spawnSync(executable, argumentsList, { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", ...options });
  if (result.status !== 0) throw new Error(`${executable} ${argumentsList.join(" ")} failed`);
  return result.stdout ?? "";
}

function version(relative) {
  return JSON.parse(readFileSync(path.join(repo, relative), "utf8")).version;
}

const versions = {
  cli: version("packages/cli/package.json"),
  core: version("packages/core/package.json"),
  extension: version("packages/vscode/package.json"),
};

// The CLI ships a generated copy of core; it must be current before it packs.
run(process.execPath, [path.join(repo, "scripts", "sync-core.mjs")]);
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });

for (const directory of ["packages/cli", "packages/core"]) {
  const packed = run(process.execPath, [npmCli, "pack", path.join(repo, directory), "--pack-destination", output]);
  console.log(`  ${packed.trim().split(/\r?\n/).pop()}`);
}

// The extension is built and packaged by its own toolchain, then named for the
// version it declares rather than the generic name vsce writes.
run(process.execPath, [npmCli, "run", "package"], { cwd: path.join(repo, "packages", "vscode") });
const vsix = `avenic-agent-manager-${versions.extension}.vsix`;
await copyFile(path.join(repo, "packages", "vscode", "dist", "avenic-agent-manager.vsix"), path.join(output, vsix));

console.log(`\navenic ${versions.cli} · @avenic/core ${versions.core} · extension ${versions.extension} → pack/`);
console.log("next: npm run release:verify");
