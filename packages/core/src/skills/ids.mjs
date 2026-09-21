import path from "node:path";
import { fail } from "../util/fail.mjs";

export function assertSafeId(value, label) {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(value)) {
    fail(`${label} must contain only lowercase letters, numbers, dots, underscores, or hyphens: ${value}`);
  }
}

export function assertSafeSkillName(value) {
  if (!value || value === "." || value === ".." || path.basename(value) !== value) {
    fail(`Invalid Skill name: ${value}`);
  }
}

function assertSafeRelativePath(value, label) {
  const normalized = value?.replace(/\\/g, "/");
  if (
    !normalized ||
    path.isAbsolute(normalized) ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    fail(`Invalid ${label}: ${value}`);
  }
  return normalized;
}

export function assertSafeSkillRoot(value) {
  if (value === ".") {
    return value;
  }
  return assertSafeRelativePath(value, "Skill root");
}

export function assertSafeSkillPath(value, label) {
  if (value === ".") {
    return value;
  }
  return assertSafeRelativePath(value, label);
}
