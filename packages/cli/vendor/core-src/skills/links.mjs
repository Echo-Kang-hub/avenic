import { existsSync, lstatSync } from "node:fs";
import { cp, mkdir, readFile, readdir, readlink, realpath, rm, symlink, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { hashContent, samePath } from "../runtime/sessions.mjs";
import { fail } from "../util/fail.mjs";
import { isInside } from "../util/fs.mjs";
import { assertSafeSkillName } from "./ids.mjs";

// Windows 的 junction 经 readlink 返回带 \\?\ 前缀的绝对路径；比较前必须剥掉。
const WINDOWS_PREFIX = /^\\\\\?\\/;

export function canonicalTargets(context) {
  return context.targets.filter((target) => !target.shareFrom);
}

export function shareTargets(context) {
  return context.targets.filter((target) => Boolean(target.shareFrom));
}

export function normalizeLinkTarget(linkPath, rawTarget) {
  const stripped = rawTarget.replace(WINDOWS_PREFIX, "");
  return path.resolve(path.dirname(linkPath), stripped);
}

export async function readLinkTarget(linkPath) {
  try {
    return normalizeLinkTarget(linkPath, await readlink(linkPath));
  } catch {
    return null;
  }
}

export async function createSkillLink(canonicalPath, linkPath) {
  await mkdir(path.dirname(linkPath), { recursive: true });
  if (process.platform === "win32") {
    // junction 要求绝对路径；不需要管理员权限。
    await symlink(path.resolve(canonicalPath), linkPath, "junction");
    return;
  }
  // 相对符号链接：项目整体移动后仍然有效。
  await symlink(path.relative(path.dirname(linkPath), canonicalPath), linkPath, "dir");
}

export async function removeLinkSafely(linkPath) {
  try {
    if (!lstatSync(linkPath).isSymbolicLink()) {
      return false;
    }
    await unlink(linkPath);
    return true;
  } catch {
    // 解链失败（EACCES/EPERM/EBUSY…）不得向上抛：调用方按"没删掉"处理。
    return false;
  }
}

async function realpathOrNull(target) {
  try {
    return await realpath(target);
  } catch {
    return null;
  }
}

// spec §9.6：建链前必须确认 canonical 存在且是普通目录。lstat 不跟随链接，
// 所以指向别处的符号链接/目录链接（junction）也会被判为 false —— 拒绝。
function isRealDirectory(target) {
  try {
    const stats = lstatSync(target);
    return stats.isDirectory() && !stats.isSymbolicLink();
  } catch {
    return false;
  }
}

// 只回答一个问题：这个位置上的东西，能不能被当成"avenic 自己的布局"处理。
// 判定一律走 samePath（win32 大小写不敏感），不按文件名猜；不确定就 conflict。
export async function classifyShareEntry(canonicalPath, linkPath) {
  let stats;
  try {
    stats = lstatSync(linkPath);
  } catch (error) {
    // 只有"那里确实没有条目"才算 absent；读不到（EACCES/EPERM…）一律 conflict，
    // 否则下游会把一个未知状态当成空地创建/删除。
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      return { state: "absent" };
    }
    return { state: "conflict", reason: "unreadable-entry" };
  }
  if (!stats.isSymbolicLink()) {
    // 末级分量不是链接，但路径的中间分量可能是（用户把整个 .claude/skills 指向
    // .agents/skills 的用法）。lstat 不跟随中间分量，这里必须用 realpath 识破：
    // 否则 linkPath 就是 canonical 本身，sameTree 会自比自真，删除即数据丢失。
    const [resolvedLink, resolvedCanonical] = [await realpathOrNull(linkPath), await realpathOrNull(canonicalPath)];
    if (resolvedLink && resolvedCanonical && samePath(resolvedLink, resolvedCanonical)) {
      return { state: "conflict", reason: "aliases-canonical" };
    }
    return { state: "real-directory" };
  }
  const target = await readLinkTarget(linkPath);
  if (!target) {
    return { state: "conflict", reason: "unreadable-link" };
  }
  if (samePath(target, canonicalPath)) {
    let canonical;
    try {
      canonical = lstatSync(canonicalPath);
    } catch {
      return { state: "repair", reason: "dangling" };
    }
    if (!canonical.isDirectory() || canonical.isSymbolicLink()) {
      if (canonical.isSymbolicLink()) {
        // canonical 自身是链接：解析得到目录说明条目可用（§3.2 的 linked 行），解析不到才是失效。
        const resolved = await realpathOrNull(canonicalPath);
        if (resolved && isRealDirectory(resolved)) {
          return { state: "linked" };
        }
        return { state: "repair", reason: "dangling" };
      }
      return { state: "repair", reason: "canonical-not-directory" };
    }
    return { state: "linked" };
  }
  const [resolvedLink, resolvedCanonical] = [await realpathOrNull(linkPath), await realpathOrNull(canonicalPath)];
  if (resolvedLink && resolvedCanonical && samePath(resolvedLink, resolvedCanonical)) {
    return { state: "linked" };
  }
  return { state: "conflict", reason: "points-elsewhere", target };
}

async function sameEntry(left, right) {
  try {
    const [leftStats, rightStats] = [lstatSync(left), lstatSync(right)];
    if (leftStats.isSymbolicLink() || rightStats.isSymbolicLink()) {
      if (!(leftStats.isSymbolicLink() && rightStats.isSymbolicLink())) {
        return false;
      }
      const [leftTarget, rightTarget] = [await readLinkTarget(left), await readLinkTarget(right)];
      return Boolean(leftTarget && rightTarget && samePath(leftTarget, rightTarget));
    }
    if (leftStats.isDirectory() !== rightStats.isDirectory()) {
      return false;
    }
    if (leftStats.isDirectory()) {
      return sameTree(left, right);
    }
    if (!leftStats.isFile() || !rightStats.isFile()) {
      return false;
    }
    if (leftStats.size !== rightStats.size) {
      return false;
    }
    const [leftContent, rightContent] = await Promise.all([readFile(left), readFile(right)]);
    return hashContent(leftContent) === hashContent(rightContent);
  } catch {
    return false;
  }
}

// 唯一的删除依据：两棵子树逐条一致（条目名集合、条目类型、链接 target、文件 size+sha256）。
// 任何异常（EACCES/ENOENT/EIO/ELOOP）都返回 false → 调用方按 conflict 处理，绝不删。
export async function sameTree(left, right) {
  try {
    const [leftStats, rightStats] = [lstatSync(left), lstatSync(right)];
    if (!leftStats.isDirectory() || !rightStats.isDirectory()) {
      return false;
    }
    if (leftStats.isSymbolicLink() || rightStats.isSymbolicLink()) {
      return false;
    }
    const [leftEntries, rightEntries] = await Promise.all([
      readdir(left, { withFileTypes: true }),
      readdir(right, { withFileTypes: true }),
    ]);
    const leftNames = leftEntries.map((entry) => entry.name).sort();
    const rightNames = rightEntries.map((entry) => entry.name).sort();
    if (leftNames.length !== rightNames.length) {
      return false;
    }
    if (leftNames.some((name, index) => name !== rightNames[index])) {
      return false;
    }
    for (const name of leftNames) {
      if (!(await sameEntry(path.join(left, name), path.join(right, name)))) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

export function formatLinkSummary(counts) {
  return `Linked ${counts.linked} · Migrated ${counts.migrated} · Repaired ${counts.repaired} · Fallback ${counts.fallback} · Conflict ${counts.conflict}`;
}

// A repair that changed nothing is the common case, and every host says so
// instead of listing zeros. Which counters count as change is one rule, so the
// CLI launch path and the extension cannot disagree about what "no news" means.
export function linkSummaryChanged(counts) {
  return counts.linked > 0 || counts.repaired > 0 || counts.migrated > 0;
}

export function logConflicts(io, conflicts) {
  const labels = {
    "content-differs": "a copy exists and differs from the shared version",
    "points-elsewhere": "a link points somewhere else",
    "aliases-canonical": "a folder link aliases the shared copy",
    "unreadable-entry": "an entry could not be read",
    "unreadable-link": "a link could not be read",
    unremovable: "a broken link could not be removed",
    unplaceable: "neither a link nor a copy could be placed",
  };
  for (const conflict of conflicts) {
    io.log(`⚠ ${conflict.name}: ${labels[conflict.reason] ?? "it needs attention"} — left untouched`);
  }
}

function emptyCounts() {
  return { linked: 0, repaired: 0, migrated: 0, fallback: 0, conflict: 0, unchanged: 0, skipped: 0 };
}

// 把 shareFrom target 下的受管技能收敛成"指向 canonical 的链接"。
// 幂等；只处理传入的名字，绝不枚举目录（外部/未受管技能永不进入）。
// 失败绝不抛出：建链失败退回拷贝，状态里记 fallback（spec §8/§10）；`restoreCopy: false`
// （canonical 更新前的预检趟用）例外——不落拷贝、不记 fallback，留给下一趟处置。
export async function ensureSkillLinks(context, names, options = {}) {
  const io = options.io ?? console;
  const silent = options.silent === true;
  const createLink = options.createLink ?? createSkillLink;
  // restoreCopy === false：调用方在 canonical 更新前跑时用它推迟拷贝，避免把旧版本落成
  // fallback 副本；建链失败就让条目保持缺席，交给 canonical 更新后的下一趟（默认值）处置。
  const restoreCopy = options.restoreCopy !== false;
  const requested = [...new Set(names)].sort();
  const counts = emptyCounts();
  const conflicts = [];
  const perTarget = {};
  for (const targetConfig of shareTargets(context)) {
    const canonicalRoot = targetConfig.shareDestination;
    const targetCounts = emptyCounts();
    perTarget[targetConfig.id] = targetCounts;
    if (!isRealDirectory(canonicalRoot)) {
      continue; // canonical 不存在或不是普通目录：不建空目录、不建链接（spec §9.6/§10）
    }
    for (const name of requested) {
      assertSafeSkillName(name);
      const canonicalPath = path.join(canonicalRoot, name);
      const linkPath = path.join(targetConfig.destination, name);
      if (!isInside(canonicalRoot, canonicalPath) || !isInside(targetConfig.destination, linkPath)) {
        fail(`Share path escaped its target: ${linkPath}`);
      }
      const verdict = await classifyShareEntry(canonicalPath, linkPath);
      // 只读判定先结清：它们不改磁盘，也不依赖 canonical 是否可用（否则外来链接会被吞成 skipped）。
      if (verdict.state === "linked") {
        counts.unchanged += 1;
        targetCounts.unchanged += 1;
        continue;
      }
      if (verdict.state === "conflict") {
        counts.conflict += 1;
        targetCounts.conflict += 1;
        conflicts.push({ name, targetId: targetConfig.id, reason: verdict.reason });
        continue;
      }
      if (verdict.state === "repair") {
        // 失效但确属我方的条目：只解除，不重建（canonical 恢复后下一趟会建，§9.6）。
        const removed = await removeLinkSafely(linkPath); // 契约：失败也 resolve false，不抛
        if (removed) {
          counts.repaired += 1;
          targetCounts.repaired += 1;
        } else {
          // 没删掉就不能算 repaired，否则计数撒谎；交给人处理。
          counts.conflict += 1;
          targetCounts.conflict += 1;
          conflicts.push({ name, targetId: targetConfig.id, reason: "unremovable" });
        }
        continue;
      }
      // 只有"要动磁盘"的两种状态（real-directory / absent）才需要能用的 canonical（spec §9.6/§10）。
      const canonicalIsDirectory = isRealDirectory(canonicalPath);
      if (!canonicalIsDirectory) {
        counts.skipped += 1;
        targetCounts.skipped += 1;
        continue;
      }
      if (verdict.state === "real-directory") {
        if (!(await sameTree(canonicalPath, linkPath))) {
          counts.conflict += 1;
          targetCounts.conflict += 1;
          conflicts.push({ name, targetId: targetConfig.id, reason: "content-differs" });
          continue;
        }
        await rm(linkPath, { recursive: true, force: true }); // sameTree 已证明内容一致
        counts.migrated += 1;
        targetCounts.migrated += 1;
      }
      try {
        await createLink(canonicalPath, linkPath);
        counts.linked += 1;
        targetCounts.linked += 1;
      } catch (error) {
        if (!restoreCopy) {
          // 预检趟建链失败：不落拷贝（此刻 canonical 还是旧版本），条目保持缺席，也不记 fallback——
          // 让 canonical 更新后的补链趟用新内容决定建链还是降级。
          continue;
        }
        try {
          await mkdir(path.dirname(linkPath), { recursive: true });
          if (!existsSync(path.join(linkPath, "SKILL.md"))) {
            await rm(linkPath, { recursive: true, force: true });
            await cp(canonicalPath, linkPath, { recursive: true });
          }
          counts.fallback += 1;
          targetCounts.fallback += 1;
          if (!silent) {
            io.log(`⚠ Cannot create shared link for ${name} (${error.code ?? error.message}) — copied instead`);
          }
        } catch (copyError) {
          // 连拷贝也放不下（父目录不是目录、权限…）：不抛（spec §9.8），记为需要人工关注的 conflict。
          counts.conflict += 1;
          targetCounts.conflict += 1;
          conflicts.push({ name, targetId: targetConfig.id, reason: "unplaceable" });
          if (!silent) {
            io.log(`⚠ Cannot place ${name} (${copyError.code ?? copyError.message}) — left to you`);
          }
        }
      }
    }
  }
  if (!silent && conflicts.length > 0) {
    logConflicts(io, conflicts);
  }
  return { counts, conflicts, targets: perTarget };
}
