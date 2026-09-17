import { agentExecutableAvailable, agentStatus, listAgents } from "../services/agents.ts";
import { cachedRevision, defaultSpec } from "../services/catalog.ts";
import { readSkillsSnapshot } from "../services/skills.ts";
import type { DashboardData } from "./protocol.ts";

// 纯数据组装（无 vscode import）：所有可执行/网络/状态读取都走 services 层 + 注入的 environment，
// 使测试可以经 testEnv 隔离宿主配置；revision 只读本地缓存（cachedRevision —— 无 git fetch，
// 修复"每次打开 Overview 都加载很久"），任何读取错误降级为 "—"。

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
function skillsHealthRows(skills: { targets: Array<{ agents: string[]; complete: boolean; present: number; total: number; state: string }> }): Array<{ label: string; ok: boolean; details: string }> {
  return skills.targets.flatMap((target) => {
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
export async function buildDashboardData(projectRoot: string | null, environment: NodeJS.ProcessEnv = process.env): Promise<DashboardData> {
  if (projectRoot === null) {
    return {
      projectRoot: null,
      agents: listAgents().map((a) => ({
        id: a.id,
        label: a.displayName,
        statusText: "未打开项目",
        executableAvailable: agentExecutableAvailable(a.id),
        iconHint: "circle-outline",
      })),
      catalog: null,
      skillsHealth: [{ label: "Skills", ok: false, details: "未打开项目" }],
    };
  }
  const agents = await Promise.all(
    listAgents().map(async (a) => {
      const s = await agentStatus(projectRoot, a.id);
      return {
        id: s.agent.id,
        label: s.agent.displayName,
        statusText: s.effective ? `已初始化 · ${s.effective.auth} / ${s.effective.sessions}` : "未初始化",
        executableAvailable: s.executableAvailable,
        iconHint: s.effective ? "pass-filled" : "circle-outline",
      };
    }),
  );
  const spec = await defaultSpec(environment);
  const skillSnapshot = await readSkillsSnapshot("project", projectRoot, environment).catch(() => null);
  const skills = skillSnapshot?.status ?? null;
  // 磁盘检测（未托管内容：旧版/外部工具安装、手工拷贝）——只读，任何错误降级为空
  const detected = skillSnapshot?.detected ?? [];
  const untracked = skills === null ? detected : detected.filter((name) => !skills.names.includes(name));
  const untrackedRow = { label: "Skills", ok: false, details: `${untracked.length} 个 Skill 未托管` };
  return {
    projectRoot,
    agents,
    catalog: spec === null ? null : { spec, revision: (await cachedRevision(projectRoot, environment)) ?? "—" },
    skillsHealth: skills === null
      ? [untracked.length > 0 ? untrackedRow : { label: "Skills", ok: false, details: "尚未安装" }]
      : skillsHealthRows(skills).concat(untracked.length > 0 ? [untrackedRow] : []),
  };
}
