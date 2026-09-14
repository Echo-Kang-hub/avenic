# Avenic CLI

Avenic 是一个命令行工具，用于统一管理编码 Agent（Claude Code、Codex、OpenCode）的运行时配置与 Skills，支持 Windows、macOS 和 Linux。

## 安装

要求 Node.js ≥ 18.17。

```bash
npm install -g avenic@latest
```

安装提供两个命令：`avenic` 与简写 `ave`，二者等价。

卸载：

```bash
npm uninstall -g avenic
```

## 快速开始

```bash
avenic claude init                            # 初始化 Claude Code（默认全局认证 + 项目便携会话）
avenic claude init --auth project             # 项目级认证（凭据随项目，不进 Git）
avenic codex init --sessions global           # Codex 会话留在全局原生存储
avenic claude sessions import                 # 把本机会话复制进项目便携存储
avenic claude sessions writeback              # 把项目便携会话显式回写本机
avenic sessions git off                       # 会话不进 Git
avenic hub add <owner/repo>               # 导入 Hub（可导入多个，会打印 Pack 预览树）
avenic hub select                         # 上下键切换当前 Hub
avenic skills install                         # 安装默认 Pack（common）
avenic skills add <owner/repo>                # 从任意 GitHub 仓库直接安装 Skills
```

## Agent 运行时

### 命令

`<agent>` 为 `claude`、`codex`、`opencode` 之一。

| 命令 | 说明 |
|---|---|
| `avenic <agent> init [--auth global\|project] [--sessions global\|project]` | 初始化运行时 |
| `avenic <agent> deinit [--purge]` | 移除运行时；`--purge` 一并删除数据 |
| `avenic <agent> auth [global\|project\|reset]` | 设置认证作用域；不带参数时查看当前状态 |
| `avenic <agent> status` | 查看该 Agent 的配置与状态 |
| `avenic <agent> sessions import\|writeback\|status` | 管理便携会话 |
| `avenic <agent> [args...]` | 启动 Agent，其余参数透传给官方 CLI |
| `avenic status` | 三个 Agent 一览 |
| `avenic doctor` | 环境自检 |
| `avenic sessions git on\|off\|status` | 便携会话的 Git 同步开关 |

`init` 的输出会列出实际创建或修改的内容（`.agents/runtime.json`、`.agents/sessions/<agent>/`、`.agents/local/<agent>/`、`.gitignore`）及使用方法。`init` 可重复执行：结构已符合时不作修改，有缺失时只增量补齐。

### 认证作用域

- `global`（默认）：使用 Agent 的本机全局凭据（如 `~/.claude`、`~/.codex`）。
- `project`：凭据与配置保存在项目 `.agents/local/<agent>/`（自动 gitignore）。同一 Agent 在不同项目可使用不同账号。

```bash
avenic claude auth project        # 切换到项目认证
avenic claude auth global         # 切回全局
avenic claude auth reset          # 清除本项目覆盖，恢复默认
avenic claude auth                # 查看当前生效的认证作用域
```

### 会话记录

- `project`（默认）：启动前把项目内的会话记录提供给 Agent，退出后把本次会话写回 `.agents/sessions/<agent>/`（可跨设备迁移），并把本机原生存储恢复到启动前的状态。会话只更新在项目里，全局存储完全不受影响；删除项目后，会话随项目消失。
- `global`：会话直接留在 Agent 的原生全局存储，不产生项目副本。

```bash
avenic codex sessions import      # 全局会话 → 项目会话记录（复制不删除）
avenic codex sessions writeback   # 项目会话记录 → 原生存储（显式回写）
avenic codex sessions status
avenic sessions git on|off|status # 项目会话记录的 Git 同步开关
```

若同一会话在本机原生存储与项目内都有记录，`avenic <agent>` 启动时以项目内的会话记录为准（覆盖本机副本）。运行 `avenic claude` 优先使用项目内的会话记录；要用全局会话记录时，直接运行 `claude`（其他 Agent 同理直接运行官方 CLI）即可。

项目内的会话记录不会自动回写本机原生存储；需要回写时显式执行 `avenic <agent> sessions writeback`：原生存储中该项目的会话记录会被项目内记录覆盖；原生存储中没有该项目的会话记录时，则按 Agent 的原生目录结构创建后放入会话，效果与直接用官方 CLI 产生的会话一致。

同一项目同一 Agent 可同时启动多个 `avenic` 会话：第一个启动时保存原生存储快照，最后一个退出时回滚。每次启动还会派一个脱离终端的后台看门狗进程监视本次会话：直接关闭终端、关闭 VS Code、强杀进程都不会影响收尾——看门狗检测到 CLI 进程消失后自动把会话收进项目并恢复原生存储原状。看门狗自身被终止（断电、强制重启）且系统临时目录被清理时无法自动补救，残留会话留在原生存储里，可手动执行 `avenic <agent> sessions import` 收进项目；临时目录还在时，下次启动 `avenic` 会自动补救。

> OpenCode 例外：其会话存储由官方 CLI 自行管理，`avenic opencode` 启动后原生存储仍保留本次运行产生的会话，不受上述回滚保护。

> 项目会话可能包含提示词、源码、命令输出、路径与密钥；仅在可信仓库中提交会话。

## Models（模型配置）

Avenic 用两层结构管理模型配置：**本机配置库是唯一事实来源，项目只存绑定与回滚账本**。

- **本机配置库**：默认 `~/.config/avenic/models.json`（状态根受 `AVENIC_STATE_DIR`、`XDG_CONFIG_HOME` 影响），保存 profile——端点、API 类型、密钥、模型与开关。库是设备级的，不随项目迁移。
- **项目绑定**：`.agents/model.json`，记录当前项目用的是哪个 profile，以及 Claude 投影的账本（写入了哪些键、写入前的原值）；profile 本身只存在于库里。

```bash
avenic model                    # 查看库路径、项目绑定与投影状态
avenic model list               # 列出本机 profile（> 标记当前项目绑定）
avenic model add --name <名称> --base-url <URL> --api-key <密钥> [--model <id>]
avenic model use <id>           # 绑定到当前项目；不带 id 时在终端上选择
avenic model test <id>          # 发一次最小真实请求（失败退出码 2）
avenic model clear              # 解绑并恢复绑定前的项目设置
```

完整子命令与参数表见 [packages/cli/README.md](packages/cli/README.md)，或运行 `avenic --help`。

### 三个 Agent 的生效方式

绑定只作用于**本项目**；模型配置不写 Agent 的全局配置（如 `~/.claude/settings.json`、`~/.codex/config.toml`）：

| Agent | 生效方式 |
|---|---|
| Claude Code | 绑定与启动时把 profile 投影进项目 `.claude/settings.local.json`（逐键记账，指纹一致时零写入；解绑按账本还原，用户手改过的键保持不动）；启动时同时注入进程环境变量兜底（`ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_MODEL` 及角色模型变量）。 |
| Codex | 只注入本次启动的 argv：`-c model_provider=…`、`model_providers.<id>.*`（`wire_api=responses`）与 `-m <model>`；用户自带 `-m`/`model_provider=` 时对应项跳过。Codex 需要 Responses API 端点；profile 不具备时启动不改配置，按 Codex 全局配置继续。 |
| OpenCode | 只注入本次启动的 `OPENCODE_CONFIG_CONTENT`：Anthropic 端点覆盖内置 provider，其他端点定义自定义 provider。 |

### 密钥与 Git

- CLI 与插件面板只显示掩码（前 3 后 4 位）；**底层仍是明文 JSON 存储**——库文件与项目投影里的密钥不加密，请按凭据对待。
- 绑定时 Avenic 自动在项目 `.gitignore` 补齐以下规则（缺少 `# Agent Runtime` 分节时一并写入分节头）：`.agents/model.json`、`.claude/settings.local.json`、`.agents/model.lock`、`.agents/tmp/`。**不要提交这些文件**（绑定文件含投影账本，可能包含用户原值），本机配置库同样不要提交。
- `avenic model test` 会向配置的端点发送一次真实请求，消耗极少量额度。

## Skills

### Hub

Hub 是一个 git 仓库，公开或私有均可；私有仓库使用本机 git 认证（gh、SSH 或 credential helper），CLI 不接触 token。标准结构：

```
my-hub/
├── sources.lock.json                    # 上游源登记：id、仓库地址、锁定 commit、Skill 根目录、许可证
├── packs/
│   ├── common.json                      # Pack 定义（common 为默认 Pack，安装时自动包含）
│   └── development.json
├── skills/                              # 按源归档的 Skill 副本
│   └── <source-id>/<skill-name>/SKILL.md
└── licenses/                            # 上游许可证（登记源时自动保存）
```

Pack 定义示例（`packs/development.json`）：

```json
{
  "schemaVersion": 1,
  "id": "development",
  "name": "Development",
  "description": "Research, coding, and review workflows.",
  "sources": [{ "source": "example-source", "skills": ["beta", "gamma"] }]
}
```

一个 Hub 可聚合多个上游源；Pack 从这些源挑选 Skill（可跨源），`description` 是 Pack 的用途说明，会显示在 `hub add` 的预览树中。

#### 使用

```bash
avenic hub add <owner/repo>         # 导入 Hub（owner/repo[#ref]、URL 或本地路径），成功后打印 Pack 预览树
avenic skills install                   # 安装默认 Pack（common）
avenic skills install development       # 安装多个 Pack；common 自动包含
avenic skills uninstall development     # 卸载 Pack（不带参数移除全部受管理 Skills）
avenic skills -g development            # 安装到全局作用域（skills <pack> 是 install 的简写）
avenic skills tree [pack...]            # 查看 Hub 内容树
avenic skills packs                     # 列出可用 Packs
avenic skills status [-g]               # 当前安装状态
```

`hub add` 拉取失败不影响源保存，之后 `avenic hub sync` 重试。可反复 `add` 注册多个 Hub，同一时间生效一个（该 Hub 聚合的多个上游源共享所有 Pack）：

```bash
avenic hub select [name|spec]       # ↑/↓ 选择当前 Hub（无终端时打印列表）
avenic hub list                     # 列出已注册 Hub（> 标记当前）
avenic hub default                  # 查看当前 Hub
avenic hub sync                     # 拉取或更新缓存（~/.config/avenic/catalog/）
```

每次安装把 Hub commit 写入项目锁 `.avenic.lock.json`，跨设备可复现。

> 默认 Hub 为维护者提供的示例；使用前请通过 `avenic hub add <owner/repo>` 指向自己的 Hub。

#### 构造与维护 Hub

初始化骨架、登记上游、建 Pack、校验后推送：

```bash
mkdir my-hub && cd my-hub
git init
mkdir -p packs skills
echo '{"schemaVersion":1,"sources":[]}' > sources.lock.json
avenic hub pack-add common --name Common                        # 新建 Pack
avenic hub skill-add <owner/repo> --pack common                 # 登记第一个上游源并收录其全部 Skill
avenic hub pack-add development --name Development
avenic hub skill-add <owner/repo> skill-a skill-b --pack development
avenic hub doctor                                               # 校验结构
git add -A && git commit -m "hub" && git push
```

`skill-add` 自动登记未收录的上游源（锁定 commit、保存许可证）；省略 `[skill...]` 收录该源全部 Skill；可反复 `skill-add` 聚合多个上游源。

维护命令（在 Hub 克隆内运行）：

```bash
avenic hub skill-add <source-id|owner/repo> [skill...] [--pack <pack,pack>]
avenic hub remove <source-id|owner/repo> <skill...> [--pack <pack,pack>]   # 从 Pack 移除 Skill；无 Pack 引用时删除副本
avenic hub pack-add <id> [--name <name>] [--description <text>]
avenic hub pack-remove <pack...>                                          # 删除 Pack（common 不可删），无引用 Skill 一并清理
avenic hub source-add <id> <repo> [--name <name>] [--skill-root <path>] [--license <path>]
avenic hub update [source] [--check]                                      # 跟进上游更新，锁定新 commit
avenic hub doctor                                                         # 校验 Hub
```

#### 连接私有 Skills 仓库

私有仓库不需要额外配置：CLI 不接触 token，clone 与 fetch 全部由本机 git 完成。以连接私有 Hub `Echo-Kang-hub/SkillsHub` 为例：

```bash
gh auth login                                            # 1. 登录 GitHub（或改用 SSH key，二选一，只需一次）
avenic hub add Echo-Kang-hub/SkillsHub    # 2. 设置 Hub 源（换成 <你的用户名>/<你的仓库>），终端会打印 Pack 预览树
avenic hub sync                                   # 3. 验证可拉取（输出 40 位 commit 即成功）
avenic skills install                                 # 4. 安装默认 Pack（common）
```

- Windows 上 HTTPS 方式默认使用 Git Credential Manager（首次自动弹窗登录）；也可以使用 SSH 地址：`avenic hub add git@github.com:<owner>/<repo>.git`
- `avenic skills add <owner/repo>` 从单个私有仓库安装 Skill，认证方式相同

| 现象 | 处理 |
|---|---|
| `schannel: failed to receive handshake / SSL/TLS connection failed` | 网络或代理阻断了到 github.com 的 TLS 连接，与认证无关；检查代理/VPN，或改用 SSH 地址 |
| `Unable to fetch Hub` + `Check your GitHub authentication` | git 没有该私有仓库的访问权限；先运行 `gh auth status` 或 `ssh -T git@github.com` |
| 换回其他 Hub | 已注册的直接 `avenic hub select` 切换；未注册的再次 `avenic hub add <spec>` |

### 共享与链接

同一作用域内每个 Skill 只保留一份物理文件：`.agents/skills/<name>` 是真身，`.claude/skills/<name>` 是指向它的链接（Windows 为 junction，macOS/Linux 为相对符号链接）。安装、更新、接管、直装以及 `avenic <agent>` 启动时都会补齐缺失的链接、清理已失效的链接，反复安装不会产生第二份副本。

```text
<项目>/.agents/skills/<name>     真身（canonical）
<项目>/.claude/skills/<name>     链接 → .agents/skills/<name>
```

链接创建失败时（例如文件系统不支持链接），该 Skill 自动退回真实副本：功能不受影响，`avenic skills status` 标记为「可用但未共享」，下一次安装会再尝试迁移为链接。

`avenic skills uninstall` 会解除 Avenic 建立的链接并删除真身；指向其他位置的链接（用户自建）从不改动，`avenic skills status` 会报告冲突并保留原样。手工放进 `.agents/skills` 或 `.claude/skills` 的技能不属于受管集合，既不会被自动建链，也不会被删除；其中出现在分享位置 `.claude/skills` 的未受管条目，状态里会提示用 `avenic skills adopt` 接管。

`avenic skills status` 输出示例（链接健康时）：

```text
Current Project Skills
  Packs: Common + Development

Skills · 3 unique
└── Test Source · 3
    ├── alpha
    ├── beta
    └── gamma

✓ Claude Code: shared via .agents/skills (3 links)
✓ Codex / OpenCode / universal agents: 3/3
Optimized
```

以下三例为节选（省略技能树与 canonical 目标行），所列字符串与真实输出逐字一致：

降级（存在未共享的真实副本，仍可用）：

```text
⚠ Claude Code: available — copies, not shared (1) · run: avenic skills install
Degraded
```

链接缺失时：

```text
⚠ Claude Code: links missing — run: avenic skills install
Incomplete
```

链接指向别处时（用户自建链接，保持原样）：

```text
⚠ Claude Code: 1 conflicting entry — left untouched, resolve manually
⚠ alpha: a link points somewhere else — left untouched
Incomplete
```

末行汇总整体状态：`Optimized` 表示全部共享（磁盘上只有一份），`Degraded` 表示可用但存在未共享的副本，`Incomplete` 表示有链接缺失或冲突。

### 直接源

```bash
avenic skills add <owner/repo> [skill...] [-g]
avenic skills remove <skill...>   # 撤回：移除通过 add 安装的 Skills
```

从任意 GitHub 仓库直接安装 Skill（递归发现），锁定 commit 并保存许可证。公开仓库直接可用；私有仓库使用本机 git 认证（`gh auth login` 或 SSH）。与 Pack 管理的 Skill 重名会被拒绝。

## 撤回操作

| 操作 | 撤回 |
|---|---|
| `avenic <agent> init` | `avenic <agent> deinit`（加 `--purge` 连会话数据一起删除） |
| `avenic <agent> auth project` / `auth global` | 执行相反设置，或 `auth reset` 恢复默认 |
| `avenic <agent> sessions import` | 只复制不删除；清除项目副本：`avenic <agent> deinit --purge` 后重新 `init` |
| `avenic sessions git off` | `avenic sessions git on` |
| `avenic skills install [pack...]`（简写 `avenic skills [pack...]`） | `avenic skills uninstall`（全部）或 `avenic skills uninstall <pack>` |
| `avenic skills add <owner/repo>` | `avenic skills remove <skill...>` |
| `avenic hub add <spec>` | `avenic hub select` 选回已注册 Hub，或再次 `avenic hub add <原 spec>` |
| `avenic self-update` | `npm install -g avenic@<旧版本>` |

## 自更新

```bash
avenic self-update
```

从 npm 更新 Avenic 到最新版本。

## 开发者

构建、测试与发布流程见 [docs/development.md](docs/development.md)。

## License

[MIT](LICENSE)
