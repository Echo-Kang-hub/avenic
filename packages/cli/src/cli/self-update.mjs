import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseCliVersion, spawnExecutableSync } from "#core";

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
  console.log("Avenic self-update");
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
  const active = options.probeVersion ? options.probeVersion() : probeVersion(spawn);
  if (active !== latest) {
    throw new Error(`Avenic update verification failed: registry=${latest}, active=${active ?? "unknown"}. Check PATH and npm global prefix.`);
  }
  console.log(`Updated Avenic: ${current ?? "unknown"} → ${active}`);
  return { packageSpec, current, latest, active, updated: true };
}

export { probeVersion, registryVersion };
