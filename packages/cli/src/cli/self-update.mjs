import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { parseCliVersion, spawnExecutableSync } from "#core";
import { compactBrand } from "./brand.mjs";

function output(result) {
  return String(result?.stdout ?? "").trim();
}

function probeVersion(spawn, executable = "avenic") {
  const result = spawn(executable, ["--version"], { stdio: "pipe", windowsHide: true, encoding: "utf8" });
  return result?.status === 0 ? parseCliVersion(output(result)) : null;
}

function registryVersion(spawn, spec) {
  const result = spawn("npm", ["view", spec, "version", "--json"], { stdio: "pipe", windowsHide: true, encoding: "utf8" });
  if (result?.status !== 0) throw new Error(`Unable to query npm registry for ${spec}`);
  let value;
  try { value = JSON.parse(output(result)); }
  catch { throw new Error(`Unable to query npm registry for ${spec}`); }
  return typeof value === "string" ? value : null;
}

async function globalPackageVersion(spawn, packageName) {
  const result = spawn("npm", ["root", "--global"], { stdio: "pipe", windowsHide: true, encoding: "utf8" });
  if (result?.status !== 0) return null;
  try {
    const metadata = JSON.parse(await readFile(path.join(output(result), packageName, "package.json"), "utf8"));
    return typeof metadata.version === "string" ? metadata.version : null;
  } catch {
    return null;
  }
}

export async function avenicPackageSpec(packageRoot) {
  const metadata = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  return metadata.avenic?.packageSpec ?? "Echo-Kang-hub/avenic#main";
}

export async function updateAvenic(packageRoot, options = {}) {
  const packageSpec = await avenicPackageSpec(packageRoot);
  const spawn = options.spawn ?? spawnExecutableSync;
  const current = options.currentVersion ?? probeVersion(spawn);
  let latest;
  try {
    latest = options.latestVersion ?? registryVersion(spawn, packageSpec);
  } catch (error) {
    throw new Error(`${error.message}; update was not attempted`);
  }
  if (!latest) throw new Error(`Registry did not return a version for ${packageSpec}`);
  compactBrand(process.stdout, { title: "self-update" });
  console.log(`Current: ${current ?? "unknown"}`);
  console.log(`Latest:  ${latest}`);
  console.log(`Source:  ${packageSpec}`);
  if (current === latest) {
    console.log(`Avenic is already up to date (${latest}).`);
    return { packageSpec, current, latest, updated: false };
  }
  const result = spawn("npm", ["install", "--global", `${packageSpec}`], { stdio: "ignore", windowsHide: true });
  if (result.error) {
    throw new Error(`Unable to launch npm: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`npm install failed with exit code ${result.status ?? 1}`);
  }
  const installed = options.installedVersion ? await options.installedVersion() : await globalPackageVersion(spawn, "avenic");
  const pathVersion = options.probeVersion ? options.probeVersion() : probeVersion(spawn);
  if (installed !== latest) {
    throw new Error(`Avenic update verification failed: registry=${latest}, npm-global=${installed ?? "unknown"}, active=${pathVersion ?? "unknown"}. Check npm global prefix and PATH.`);
  }
  if (pathVersion !== latest) console.log("Avenic was updated. Open a new terminal to use the updated command.");
  console.log(`Updated Avenic: ${current ?? "unknown"} → ${installed}`);
  return { packageSpec, current, latest, active: installed, pathVersion, updated: true };
}

export { globalPackageVersion, probeVersion, registryVersion };
