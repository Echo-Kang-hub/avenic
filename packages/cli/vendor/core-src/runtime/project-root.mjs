import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { LEGACY_PROJECT_CONFIG_FILE, PROJECT_CONFIG_FILE } from "../skills/paths.mjs";

function ancestors(startDirectory) {
  const start = path.resolve(startDirectory);
  const chain = [];
  for (let current = start; ; current = path.dirname(current)) {
    chain.push(current);
    if (path.dirname(current) === current) return chain;
  }
}

function findMarker(startDirectory, relativeMarker) {
  for (const directory of ancestors(startDirectory)) {
    if (existsSync(path.join(directory, relativeMarker))) {
      return directory;
    }
  }
  return null;
}

function findGitRoot(startDirectory) {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: startDirectory,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    return null;
  }
  const root = result.stdout.trim();
  return root ? path.resolve(root) : null;
}

// The repository top level, without starting git to ask. Every clone, worktree
// and submodule carries a `.git` entry (a directory, or a file pointing at the
// real git directory) in exactly the directory `git rev-parse --show-toplevel`
// names, so walking up for it answers the same question for the cost of a few
// stats instead of a subprocess — which every command pays for, and a launch
// cannot afford.
function findGitRootFromAncestors(startDirectory) {
  for (const directory of ancestors(startDirectory)) {
    if (existsSync(path.join(directory, ".git"))) {
      return directory;
    }
  }
  return null;
}

// A `GIT_DIR`/`GIT_WORK_TREE`/ceiling override puts the answer somewhere the
// filesystem does not show, so only then is git itself asked.
function gitRoot(startDirectory) {
  return process.env.GIT_DIR || process.env.GIT_WORK_TREE || process.env.GIT_CEILING_DIRECTORIES
    ? findGitRoot(startDirectory)
    : findGitRootFromAncestors(startDirectory);
}

export function locateProjectRoot(startDirectory = process.cwd()) {
  const start = path.resolve(startDirectory);
  return (
    gitRoot(start) ??
    findMarker(start, path.join(".agents", "runtime.json")) ??
    findMarker(start, PROJECT_CONFIG_FILE) ??
    findMarker(start, LEGACY_PROJECT_CONFIG_FILE) ??
    start
  );
}
