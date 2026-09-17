# Avenic 开发原理

本文面向 Avenic 的维护者和贡献者，说明代码边界、数据流和不可破坏的约束。它不是用户操作手册；插件用户说明位于 [`packages/vscode/README.md`](packages/vscode/README.md)，CLI 入门说明位于根 README。

## 1. 分层原则

Avenic 的依赖方向保持单向：

```text
CLI / VS Code wrapper
        ↓
packages/core（模型、存储、路径、运行时、生命周期）
        ↓
agent adapter / runtime hook
        ↓
Claude Code / Codex / OpenCode 原生 CLI
```

- `packages/core` 是唯一业务实现位置，负责 canonical session、导入、同步、恢复、认证运行时解析和安装来源识别。
- `packages/cli` 只负责参数解析、进程启动和人类可读输出。
- `packages/vscode` 只负责命令、树视图、进度和展示；不得实现第二套路径、认证或转换逻辑。
- adapter 只隔离原生格式差异，不创建 Claude→Codex 之类的 N² direct converter。

新增能力优先复用已有 core service，而不是增加 manager/controller/framework。

## 2. Canonical Session Store

canonical session 是共享历史的唯一 durable source of truth，原生会话只是可恢复的 projection/cache。

项目 session 默认位于：

```text
.agents/sessions/canonical/<canonical-id>/
  session.json       # 版本、项目身份、标题和汇总元数据
  events.jsonl       # append-oriented canonical events
  mappings.json      # canonical 与各 agent native id/cursor 的映射
  state.json         # 可重建的 goal/completed/pending/decisions 状态
  handoff.json       # deterministic continuation context（如存在）
  attachments/       # 受路径安全检查的附件
```

旧目录 `.agents/sessions/claude`、`codex`、`opencode` 继续作为兼容的 native portable 数据或缓存使用。升级不得清空或覆盖旧数据。

canonical schema 必须带 `version`。事件保持稳定 id、顺序、role、typed content blocks、时间、parent/branch、model/provider provenance、tool call/result 和 `extensions`。目标 agent 不支持的字段进入 extensions 或 diagnostic，不能静默丢失。

所有写入采用临时文件加原子 rename；损坏的半写文件不能替换有效 canonical。native JSON/JSONL/DB 一律视为不可信输入，不执行其中的 shell 或代码。

## 3. Adapter 契约

每个 agent 实现同一组最小能力，业务层不判断 agent 类型：

- `discover(projectRoot, runtime)`：发现原生 session。
- `read/capture(nativeId)`：读取新增原生历史并解析为 canonical events。
- `toCanonical`：原生消息映射为稳定 canonical 事件。
- `project/fromCanonical`：将 handoff/delta 投影为目标 agent 可接受的输入。
- `bootstrap` / `resume`：创建或恢复真实原生 session。
- `getRevision`：返回原生 revision/hash，供恢复 reconciliation 使用。

adapter 不负责选择用户模型或复制认证配置。无法映射的原生字段保留在 extension，并产生可诊断信息。

当前能力等级：

- Claude：L3a，使用真实 session 和 `--resume`，以 semantic handoff 继续，不写私有 JSONL。
- Codex：L3a，使用官方 thread/resume 路径，不手写 rollout、SQLite 或 index。
- OpenCode：L3，使用官方 import/export/session 路径。

## 4. Identity、mapping 与 cursor

canonical id 不依赖 model、provider、endpoint 或 auth account。每个 native projection 至少记录：

```text
canonicalSessionId
nativeSessionId
lastCanonicalEventId / cursor
nativeRevision / hash
projectionHash
lastSyncedAt
dirty / incompleteExit（提示字段，不是正确性的唯一依据）
```

mapping 是 projection 状态，不是历史来源。cursor 只有在 projection 或 capture 成功后才提交；失败时保留旧 cursor，下一次可以安全重试。native id 不存在或 rollout 失效时，保留 canonical 历史并重新 bootstrap/rehydrate，更新 mapping，不删除旧 projection。

重复 import/sync 必须通过 stable event id、native revision 和 hash 做幂等合并。并发分叉不能 last-write-wins 覆盖另一边；至少保留两边事件并生成 branch/conflict diagnostic。

## 5. 唯一 continuation lifecycle

`continueCanonicalSession({ canonicalId, targetAgent, projectRoot })` 是唯一编排入口：

```text
recovery reconciliation（所有已映射 native）
  → capture native delta 并 merge canonical
  → resolve active canonical session
  → calculate target cursor 后的 delta/handoff
  → bootstrap 或 resume target projection
  → 使用原生 runtime 启动 agent
  → 正常退出后的 post-launch capture
  → merge target events
  → 成功后提交 mapping/cursor/revision
```

启动前必须检查所有与 active canonical 有 mapping/lease 的 agent，不能只检查即将启动的 target；这样终端或 VS Code 被强制关闭后，下一次启动仍能补回未 capture 的消息。SIGINT、SIGTERM 和 deactivate 只做 best-effort capture，不能作为唯一保障。

project sessions 模式下，普通 `avenic claude|codex|opencode` 必须先解析项目的 active canonical session，再走同一 pipeline；`avenic sessions continue` 不能有另一套恢复语义。global sessions 模式保持全局行为，不绑定其他项目的 canonical。

项目 active pointer 应明确记录 `projectRoot → activeCanonicalSessionId`。禁止按最近 mtime、最近 rollout 或最近 native thread 猜测 active session。

## 6. Auth 与 session 完全解耦

`resolveEffectiveAgentRuntime(agentId, projectRoot)` 是普通启动和 continuation 共用的运行时解析。它继承用户当前 executable、provider、endpoint、model（如果用户明确配置）、auth scope 及环境/参数覆盖，但不返回或写出 secret。

continuation 只增加 session/handoff 参数，不能硬编码 `deepseek-flash`、`claude-*` 或任何 agent 模型，也不能改动 DeepSeek、API-compatible provider、cc-switch、project/global auth。Auth mode 与 Session mode 是两个独立维度，必须支持 G/G、G/P、P/G、P/P 的可逆切换。

## 7. Import、路径与兼容性

原生项目匹配以 native metadata/cwd 和 `normalizeProjectIdentity()` 为准，而不是把 Claude 编码目录名当作唯一真相。匹配必须处理 Windows drive letter 大小写、slash/backslash、尾部斜杠、file URI、realpath、junction/symlink 和 custom config root。

发现结果要区分：native root 不存在、存在 session 但 workspace 不匹配、解析失败、权限拒绝和确实没有历史。导入必须幂等，并同时服务 CLI 和 VS Code。

snapshot/restore/lease/watchdog 不能 blind overwrite。只能把较新的 revision merge 到较旧 projection；旧 portable snapshot 不得覆盖较新的 canonical 或 native 状态。native 删除、stale mapping、非零退出和网络离线都不能损坏 canonical。

## 8. Runtime、Skills 与 Catalog

安装来源统一通过 `detectAgentInstallation(agentId)` 返回 executable、realpath、version、installMethod 和 updateStrategy；更新跟随当前 active executable 的来源，不能只看 npm global list。

Skills/Catalog 使用最多两层缓存：memory + persistent。缓存优先、显式网络操作、同一 refresh cycle 共享 snapshot 并合并重复 refresh；cache miss 不隐式 clone/fetch。激活阶段不等待网络，耗时操作必须尽早显示 loading/progress。

## 9. CLI 与 VS Code 边界

CLI 公开 `sessions list/status/import/sync/continue` 等入口，负责参数校验和稳定输出；VS Code 调用相同 core API，负责 tree/webview、按钮、进度和错误呈现。状态查询、四种 auth/session mode、import、writeback、stale recovery 和 agent detection 不得在插件中复制。

普通用户看到“bootstrap/resume、target、delta 数量、恢复提示”等摘要即可；handoff、credential、完整 transcript 和 stack trace 只在 debug/profile 模式输出。

## 10. 安全约束

- canonical 不保存 API key、auth header、token 或完整环境变量。
- session 内容可能含路径、源码、终端输出，项目 session 是否进入 Git 必须遵循既有 gitignore 策略。
- attachment 和 native path 必须阻止 traversal、绝对路径逃逸和 symlink 越界。
- import parser 只解析数据，绝不执行命令。
- 测试只能使用虚构 transcript 和明确拥有的临时 native state；不得清理用户 HOME 下无法确认归属的 session。

## 11. 测试与发布要求

核心测试应覆盖 adapter round-trip、六方向 canonical projection、A/B/C/D continuation、idempotency、stale mapping rehydrate、abrupt-exit recovery、unknown extension、malformed input、path traversal、secret filtering、Auth×Sessions 矩阵和 project/global isolation。

真实模型 smoke 必须显式执行，默认 `npm test` 不得访问用户认证或调用模型。发布前同时验证 root、VS Code typecheck/build/test/package、CLI tarball、VSIX 和 Linux/Windows 路径用例。

修改 `packages/core` 后运行 `node scripts/sync-core.mjs`，使 CLI vendor copy 与 core 一致；提交前运行 `git diff --check`、secret pattern scan 和 `npm pack --dry-run`。不得提交 token、`.npmrc`、真实 session transcript、生成的用户状态或临时调试日志。

## 12. 重要代码位置

| 区域 | 责任 |
| --- | --- |
| `packages/core/src/sessions` | canonical schema/store、mapping、import、sync、handoff |
| `packages/core/src/agents` | Claude/Codex/OpenCode adapter 和 runtime hook |
| `packages/core/src/runtime` | project/global state、lease、active session、auth/runtime resolution |
| `packages/cli` | CLI 命令和进程 wrapper |
| `packages/vscode/src` | VS Code command/tree/webview wrapper |
| `integration/`、`test/` | 真实路径、恢复、跨 agent 和安全回归 |
| `docs/` | 面向维护者的设计约束与格式说明 |

维护原则只有一句话：**canonical 保存事实，native 提供继续工作的投影，所有入口共享同一条可恢复、可幂等、与认证解耦的生命周期。**
