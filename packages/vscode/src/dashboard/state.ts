import { collectStatus, unmanagedSkillNames, type StatusModel } from "@avenic/core";
import { agentInstalled, listAgents } from "../services/agents.ts";
import { readSkillsSnapshot } from "../services/skills.ts";
import type { DashboardData } from "./protocol.ts";

// 纯数据组装（无 vscode import）：可执行/网络/状态读取都走 core 的 collectStatus 或
// services 层 + 注入的 environment，使测试可以经 testEnv 隔离宿主配置。
//
// 面板展示的就是 `avenic status` 的那份模型：Agent 行、Skills 目标、Hub 修订都取自
// collectStatus，插件只负责排版。宿主侧因此没有第二份「这个项目现在是什么样」的判断，
// 也就不会出现 CLI 说 current、面板说未初始化的分歧。

// 安装目标里的 agent id → 面板标签（target 按运行时分组，面板按代理一一平等分行）。
// 注意 AGENTS 注册表只有 claude/codex/opencode，而安装目标使用 "claude-code"/"universal"。
const AGENT_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  universal: "universal agents",
};

// 每个安装目标含多个 agent（如 Codex / OpenCode / universal agents 共用一个目标、
// 共用一套安装目录），拆成四条平等独立行：label 按 agent 名，ok/details 取自目标。
// details 按 target.state 文案：canonical 报 copies 数，share 目标报共享/降级/缺失/冲突
// （"1/1" 对 share 目标没有意义——它数的是链接，不是拷贝）。
//
// "none" 不在这里出一行：没有锁文件时这一屏该说的话要么是「尚未安装」（磁盘上也真没有），
// 要么是「N 个 Skill 未托管」（磁盘上有、Avenic 没管）——由调用方在两者里挑一句，而不是
// 同时挂两行同名的 Skills 行。
function skillsHealthRows(scope: StatusModel["skills"]["project"]): Array<{ label: string; ok: boolean; details: string }> {
  if (scope.state === "unreadable") return [{ label: "Skills", ok: false, details: "锁文件无法读取" }];
  if (scope.state === "none") return [];
  return scope.targets.flatMap((target) => {
    const details = target.state === "canonical"
      ? `${target.present}/${target.total}`
      : target.state === "linked"
        ? "shared"
        : target.state === "fallback"
          ? "copies, not shared"
          : target.state === "missing"
            ? "links missing"
            : "conflict";
    return target.agents.map((agentId) => ({
      label: AGENT_LABELS[agentId] ?? agentId,
      ok: target.complete,
      details,
    }));
  });
}

// Agent 行的第二行：把 core 的 sync 词汇直接写出来，与 `avenic status` 一字不差。
const SYNC_TEXT: Record<string, string> = {
  current: "已同步",
  stale: "投射落后于共享历史",
  missing: "项目里没有这条会话",
  running: "正在运行",
  dirty: "上次启动未收尾",
  none: "未初始化",
};

export async function buildDashboardData(projectRoot: string | null, environment: NodeJS.ProcessEnv = process.env): Promise<DashboardData> {
  if (projectRoot === null) {
    return {
      projectRoot: null,
      history: null,
      agents: listAgents().map((a) => ({
        id: a.id,
        label: a.displayName,
        statusText: "未打开项目",
        executableAvailable: agentInstalled(a.id),
        iconHint: "circle-outline",
        sync: "none",
      })),
      catalog: null,
      skillsHealth: [{ label: "Skills", ok: false, details: "未打开项目" }],
    };
  }
  const status = await collectStatus(projectRoot, { environment });
  const agents = status.agents.map((agent) => ({
    id: agent.id,
    label: agent.displayName,
    statusText: agent.initialized
      ? `${agent.auth} 认证 / ${agent.sessions} 会话 · ${SYNC_TEXT[agent.history.sync] ?? agent.history.sync}`
      : "未初始化",
    executableAvailable: agent.available,
    iconHint: agent.initialized ? "pass-filled" : "circle-outline",
    sync: agent.history.sync,
  }));
  // 磁盘检测（未托管内容：旧版/外部工具安装、手工拷贝）——只读，任何错误降级为空。
  // 这一条不在 status 模型里：它数的是 Avenic 没管的东西，模型描述的是 Avenic 的状态。
  const skillSnapshot = await readSkillsSnapshot("project", projectRoot, environment).catch(() => null);
  const detected = skillSnapshot?.detected ?? [];
  const untracked = unmanagedSkillNames(skillSnapshot?.status ?? null, detected);
  const rows = skillsHealthRows(status.skills.project);
  const untrackedRow = untracked.length > 0 ? { label: "Skills", ok: false, details: `${untracked.length} 个 Skill 未托管` } : null;
  return {
    projectRoot,
    history: {
      mode: status.history.mode,
      sessions: status.history.sessions,
      activeTitle: status.history.activeTitle,
    },
    agents,
    // revision 原样透传（截短是排版，在 webview 里做）：这里少切一刀，就少一个
    // 「面板显示的版本和 core 报的不是同一个值」的机会。
    catalog: status.skills.hub.configured
      ? { spec: status.skills.hub.spec, revision: status.skills.hub.revision ?? "—" }
      : null,
    skillsHealth: rows.length === 0 && untrackedRow === null
      ? [{ label: "Skills", ok: false, details: "尚未安装" }]
      : rows.concat(untrackedRow === null ? [] : [untrackedRow]),
  };
}
