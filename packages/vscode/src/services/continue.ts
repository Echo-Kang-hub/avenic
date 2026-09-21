import {
  effectiveAgentEnvironment,
  continuationLaunchArguments,
  continueCanonicalSession,
  getAgent,
  getSessionAdapter,
  readCanonicalSession,
  reconcileCanonicalSession,
  type ProcessEnvLike,
} from "@avenic/core";
import { prepareAgentLaunch, type AgentLaunchDefinition } from "./agents.ts";

// 「继续这条会话」＝ 把共享历史里的一条对话交给某个 agent 自己的 CLI 打开，并把
// 它这一轮说的话收回来。`avenic <agent> resume` 走的是同一条链路，所以语义只有
// 一处定义（core 的 continueCanonicalSession）：插件只提供 core 拿不到的两件事——
// 在哪儿跑（宿主给的集成终端）和跑了多久算完（终端关闭）。
//
// 「映射指向的原生会话已经不在」由 core 在准备阶段处理：它按共享历史把会话重新
// 造出来（同一个 id，因此映射始终稳定），失败的启动不会走到这里。所以插件不做
// 重试阶梯——那会变成第二处「会话该以什么方式打开」的判断。

export interface ContinueDeps {
  /** 在集成终端里跑这次启动，返回退出码（拿不到时为 null）。 */
  run: (definition: AgentLaunchDefinition) => Promise<number | null>;
  log?: (line: string) => void;
}

export interface ContinueResult {
  canonicalId: string;
  agentId: string;
  nativeSessionId: string;
}

export async function continueSession(
  projectRoot: string,
  canonicalId: string,
  agentId: string,
  deps: ContinueDeps,
): Promise<ContinueResult> {
  const displayName = getAgent(agentId).displayName;
  const adapter = getSessionAdapter(agentId);
  // 这次继续会投影、启动、再读回：三件事读写的必须是 agent 真正运行的那个 home
  //（Account · Project 下就是项目自己的）。环境只在这里解析一次，由 core 回答。
  const environment = (await effectiveAgentEnvironment(projectRoot, agentId)) as ProcessEnvLike;

  const result = await continueCanonicalSession({
    projectRoot,
    canonicalId,
    targetAgent: agentId,
    environment,
    // 上一次运行若没走完退出流程（终端被关、编辑器被杀），它的会话还没有进共享
    // 历史。继续之前补上，接续的才是完整的这段对话。
    captureKnown: async () => {
      await reconcileCanonicalSession(projectRoot, canonicalId);
    },
    capture: async (stage, context = {}) => {
      const { launched, continuation } = context;
      // 启动时已经读过一次了（那条路径上正好有会话 id 在手），不重复读盘。
      if (stage === "after" && launched?.capturedDuringLaunch) return launched.capturedDuringLaunch;
      const nativeSessionId = launched?.nativeSessionId
        ?? continuation?.nativeSessionId
        ?? (await readCanonicalSession(projectRoot, canonicalId)).mappings.projections[agentId]?.nativeSessionId;
      // 没有原生侧就没什么可捕获的：这条会话还没在这个 agent 里存在过，投影会
      // 在启动时把它造出来，之后的捕获由 launch 负责。
      if (!nativeSessionId) return null;
      return adapter.readCanonical(projectRoot, nativeSessionId, { environment });
    },
    launch: async (raw) => {
      const continuation = raw as { nativeSessionId?: string };
      const args = continuationLaunchArguments(raw as Record<string, unknown>);
      const startedAt = Date.now() - 1_000;
      const prepared = await prepareAgentLaunch(projectRoot, agentId, { argumentsList: args.argumentsList });
      const code = await deps.run(prepared.definition);
      await prepared.finishRun();
      // 拿到会话之前不动映射：一次没跑成的继续不该留下「已经接上了」的记录。
      if (code !== null && code !== 0) {
        throw new Error(`${displayName} exited with status ${code}; the session was not continued.`);
      }
      // 投影知道自己造的是哪条会话；只有「新开一条」那种启动要事后去认领。
      const nativeSessionId = continuation.nativeSessionId
        ?? await adapter.discoverNativeSession(projectRoot, { environment, notBefore: startedAt });
      const captured = await adapter.readCanonical(projectRoot, nativeSessionId, { environment });
      return { nativeSessionId, capturedDuringLaunch: captured };
    },
  });

  return { canonicalId, agentId, nativeSessionId: result.mapping.nativeSessionId };
}
