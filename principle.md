# Avenic 使用与原理说明

这份文档分成两部分：命令行工具（CLI）原理，以及 VS Code 插件的用户指南和实现边界。

## 一、Avenic CLI 的核心原则

### 1. Agent 只是运行时，Avenic 保存可迁移状态

Avenic 管理 Claude Code、Codex 和 OpenCode 的运行环境、Skills 与会话，但不取代它们本身。

```text
Agent 原生会话
       ↕ adapter
Avenic canonical session（共享历史的唯一来源）
       ↕ projection / handoff
目标 Agent 原生会话
```

canonical session 位于项目的 `.agents/sessions/canonical/`，包含版本化的 `session.json`、事件记录、映射和同步游标。原生会话是可恢复的投影或缓存，不是共享历史的最终来源。

### 2. 认证和会话完全分离

Avenic 不复制、迁移或接管 Agent 凭据。继续会话时沿用用户原来的：

- Claude 官方账号、DeepSeek、兼容 API 或 cc-switch 配置；
- Codex 登录账号或现有 provider；
- OpenCode 当前配置和默认模型；
- global auth 或 project auth 作用域。

会话切换只改变上下文，不替用户选择模型、provider、endpoint 或账号。

### 3. 启动前后都要同步

统一流程是：

1. 启动前检查所有 Agent 映射，捕获上一次异常关闭留下的原生增量；
2. 合并到 canonical session；
3. 计算目标 Agent 上次同步之后的 delta；
4. resume 原生会话，或从 canonical rehydrate 新会话；
5. 启动 Agent；
6. 正常退出时立即 capture；下次启动仍会再次 reconciliation，不能依赖正常退出。

游标只有在 projection/capture 成功后才推进。原生文件丢失不会删除 canonical 历史。

### 4. 项目会话与全局会话

每个 Agent 可以独立选择：

- `auth global` / `auth project`：认证作用域；
- `sessions global` / `sessions project`：会话存储作用域。

这两个维度互不绑定，四种组合都有效。project session 不会覆盖 global session，切换作用域也不会删除另一侧数据。

### 5. 常用 CLI 命令

```bash
# 初始化 Agent
avenic claude init
avenic codex init --sessions project
avenic opencode init

# 查看运行状态
avenic status
avenic doctor
avenic claude status

# 认证作用域
avenic claude auth global|project|reset

# 原生历史导入与写回
avenic claude sessions import
avenic claude sessions writeback
avenic codex sessions import

# 统一共享会话
avenic sessions list
avenic sessions status
avenic sessions continue <canonical-id> --agent claude|codex|opencode

# Skills
avenic hub add <owner/repo>
avenic hub sync
avenic skills install
avenic skills status
avenic skills add <owner/repo>
```

`sessions status` 会显示 canonical revision、事件数量、active session，以及每个 Agent 的同步游标和 stale/missing 状态。

### 6. Skills 原理

项目范围内 `.agents/skills/` 是 canonical 文件；Claude 的 `.claude/skills/` 和其他 Agent 目录是链接或安全回退副本。安装、更新和启动前都会修复缺失链接，但不会覆盖用户拥有的外部链接或未托管文件。

Hub 使用 Git 保存 Pack、来源和锁定 revision。网络操作只在 `hub add`、`hub sync` 或明确的安装命令中发生；状态查看优先读取本地缓存。

### 7. 模型配置和安全

模型 profile 保存在 Avenic 本机配置库，项目只保存绑定和回滚账本。绑定 project profile 时，Avenic 只向当前 Agent 注入必要的运行时配置，并保留用户手工修改。

会话、终端输出和路径可能包含敏感信息：不要把真实 transcript、API key、token 或认证文件提交到 Git。Avenic 不执行导入文件中的代码，所有 native 输入都按不可信数据解析。

### 8. 安装来源

Agent 版本检测以当前 PATH 中真正执行的 binary 为准，支持 standalone、npm global/local、Homebrew、source、binary 和 unknown。更新策略跟随 active executable 的来源；unknown 安装只给提示，不会盲目覆盖。

## 二、VS Code 插件：给第一次使用者

### 1. 安装和打开

1. 安装 Avenic VSIX。
2. 用 VS Code 打开你的项目文件夹。
3. 点击左侧活动栏的 **Avenic** 图标。
4. 第一次打开时，先在 Agents 视图初始化需要的 Agent。

插件不会创建新的账号，也不会清空 Claude、Codex 或 OpenCode 的登录状态。

### 2. 第一次设置 Agent

在 **Agents** 视图中找到 Claude Code、Codex 或 OpenCode：

- 显示“初始化”时，点击初始化；
- 选择 **Authentication**：Global 使用电脑当前账号/配置，Project 使用当前项目自己的配置；
- 选择 **Sessions**：Project 将会话保存到项目的 `.agents/`，Global 保持 Agent 原生全局存储；
- 初始化完成后，点击刷新确认状态变成 Active。

Authentication 和 Sessions 是两个独立下拉项。比如要从“Global auth + Project sessions”切换到“Project auth + Project sessions”，只改变 Authentication，不会搬动或删除会话。

如果项目还没有 project auth，插件会提示先配置，不会偷偷复制 global secret。

### 3. 导入已有会话

在 Agent 行的菜单选择 **Import Sessions**：

1. 插件扫描该 Agent 的真实原生历史；
2. 依据 native metadata、项目 cwd 和规范化路径匹配项目；
3. 写入项目 portable session 和 canonical mapping；
4. 再次点击导入是幂等的，不会复制消息。

如果没有结果，提示会区分：原生目录不存在、存在历史但不属于当前项目、解析失败、权限不足和确实没有历史。

### 4. 查看共享会话

在 **Sessions / Dashboard** 中可以看到：

- 会话标题和 ID；
- 最近更新时间；
- Claude、Codex、OpenCode 的 native mapping；
- 哪个 Agent 最近写入；
- synced、stale、missing 或 conflict 状态；
- 当前项目的 active canonical session。

canonical 历史较新时，插件会显示落后事件数量，而不是把旧 native 会话误认为最新记录。

### 5. 在不同 Agent 之间继续

从共享会话菜单选择：

- **Continue with Claude**
- **Continue with Codex**
- **Continue with OpenCode**

插件会先捕获其他 Agent 的未保存增量，再把新的 delta/handoff 交给目标 Agent。界面会告诉你这是 Bootstrap 还是 Resume，以及提供了多少条新增上下文；不会显示完整内部 handoff。

正常关闭 VS Code 或终端不是必要条件：下次启动时 Avenic 会检查所有映射和 lease，自动补回上一次异常关闭留下的消息。

如果原生 session 被用户删除，插件会保留 canonical 历史并自动创建新的原生投影。旧 mapping 不会覆盖新历史。

### 6. Skills / Hub 使用流程

在 **Hub** 视图：

1. 点击 **Add Hub**，输入 GitHub `owner/repo`、URL 或本地路径；
2. 选择默认 Hub；
3. 点击 **Sync** 才执行网络同步；
4. 展开 Pack 查看其中的 Skills；
5. 在 Pack 行点击安装。

在 **Skills** 视图：

- 查看 Project 或 Global 已安装内容；
- 安装/卸载 Pack；
- 添加直接来源 Skill；
- Adopt 托管磁盘上已有但未登记的 Skill；
- Repair Links 修复缺失链接。

缓存可用时列表会立即显示；缓存缺失不会偷偷发起网络请求，界面会给出明确的 Add/Sync 操作。

### 7. 模型配置

在 Agents 视图打开 **Model Configuration**：

1. 新建或选择一个 profile；
2. 填写 endpoint、API 类型、模型和必要凭据；
3. 保存后使用 **Test Connection** 做最小请求；
4. 点击 **Use for this project** 绑定项目。

界面只显示掩码后的密钥。继续共享会话不会强制使用 profile 中的模型；Agent 原本的 provider/model 解析仍然有效。

### 8. 版本、安装与更新

Agents 视图显示当前实际 binary、版本和安装来源。点击 Update 时，Avenic 会按 standalone、npm、brew 等来源选择对应更新方式；无法确认来源时只给出命令建议，不覆盖未知安装。

### 9. 遇到问题怎么办

- **Agent 未安装**：点击 Install，或在终端安装官方 CLI 后刷新。
- **没有 project auth**：切回 Global，或先完成项目认证配置。
- **会话 stale/missing**：点击 Continue 或 Sync，Avenic 会从 canonical 历史恢复。
- **Hub 无缓存**：点击 Add Hub 或 Sync；这不是会话错误。
- **需要诊断**：执行 `avenic sessions status` 和 `avenic doctor`，把状态信息提供给维护者，不要上传 token 或真实 transcript。

## 三、支持级别

| Agent | 支持级别 | 含义 |
|---|---|---|
| Claude Code | L3a | 通过 handoff 和增量上下文真实继续 |
| Codex | L3a | 通过 handoff 和官方 resume/thread 路径真实继续 |
| OpenCode | L3 | 使用官方 native import/export/session 真实继续 |

Codex 和 Claude 不伪造对方私有 JSONL/SQLite；native-specific 字段保留在 canonical 扩展中，无法映射的能力会给出诊断。
