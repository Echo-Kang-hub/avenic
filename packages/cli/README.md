# Avenic CLI

Avenic 用一个命令统一管理编码 Agent（Claude Code、Codex、OpenCode）在这个项目里的配置、会话历史与 Skills，支持 Windows、macOS 和 Linux。

日常只需要这几条命令：

```bash
avenic init          # Set up this project (interactive on a terminal)
avenic claude        # Start an agent's own TUI (codex / opencode likewise)
avenic status        # What this project looks like right now: configuration / history / agents / Skills
avenic skills        # Interactive Skills menu: Add / Installed / Update / Remove / Sync Hub / Import from repository
avenic sessions      # View and manage shared sessions
avenic change        # Change Authentication, Sessions or History at any time
avenic self-update   # Update from npm
```

## 安装

要求 Node.js ≥ 18.17。

```bash
npm install -g avenic
```

安装提供两个命令：`avenic` 与简写 `ave`，二者等价。

卸载：

```bash
npm uninstall -g avenic
```

## 快速开始

```bash
cd <your project>
avenic init          # Interactive setup: pick agents → each agent answers Authentication (Account / API) and its own scope → pick Sessions → pick History → confirm
avenic claude        # Start Claude Code; avenic codex / avenic opencode likewise
```

`avenic init` 只在你确认后写入。之后：

```bash
avenic change                       # Reopen the setup UI; nothing takes effect until you confirm
avenic status                       # This project's configuration, agents, history and Skills at a glance
avenic sessions                     # Interactive session management
avenic skills                       # Interactive Skills menu
avenic --version                    # Print the installed version
avenic self-update                  # Update to the latest version on npm
```

不改配置也能用：除 `init`、`change`、`<agent> auth` 之外的命令都不写配置；还没回答 Authentication 的项目，普通启动会先问一次（非终端环境按该 Agent 自己的账号启动并说明），尚未初始化的项目会提示先跑 `avenic <agent> init`。

## 交互式配置（TUI）

`avenic init`、`avenic change`、`avenic sessions`、`avenic skills` 在终端上打开同一套交互界面：

| 按键 | 作用 |
|---|---|
| ↑ / ↓ | 移动光标（`j` / `k` 同义；搜索框里它们属于过滤词） |
| Space | 多选时切换勾选 |
| Ctrl+A | 多选时全选（搜索框里字母键让给过滤词，所以全选是 Ctrl+A） |
| 直接打字 | 带搜索的列表按输入即时过滤，下拉里显示 `(命中/总数)` |
| Enter | 确认；**一项都没选时 Enter 无效**，并提示 `Select at least one item.`；`y` / `n` 在 Yes/No 确认里立即作答 |
| Esc / Ctrl+C | 安全取消：不写任何配置，退出码 0 |

流程固定为：读取当前配置 → 在内存中生成草稿 → 校验 → 打印变更摘要 → 确认 → **只在最后一步确认后原子写入**。中途取消不会留下半成品配置。

非终端环境（管道、CI、脚本）自动回退为参数模式，不会卡在提示上：

```bash
avenic init --agents claude,codex --auth account --sessions project --history shared
avenic change --agents codex --auth api --scope project --replace-agents
```

`--agents` 指定要启用的 Agent；`--auth account|api` 是 Authentication 那一问的答案，`--scope global|project` 是**这个答案自己的**作用域（默认 `global`，只能跟着 `--auth` 出现）；`--sessions` 与 `--history` 是各自独立的两问。`avenic change` 默认只改你点名的 Agent，`--replace-agents` 才会整体替换。

参数模式回答的同样是 Authentication 那一问：`--auth api` 记下「这个项目用 API」，并让 Avenic 把该 Agent 自己读的那份配置文件准备好——不在就建一个空的，已经在就一个字节都不动。**Avenic 不配置 provider、端点、模型或凭据**，那是你自己往这份文件里写的事；`init` 会告诉你这个文件在哪。换答案时的 Keep/Remove 一问只存在于交互模式；非终端环境一律按 Keep 处理，绝不删除旧配置。

## 终端外观

终端上的 Avenic 有自己的品牌图形，`avenic init` / `change` / `sessions` / `skills` 打头就是它：

```
  ▄▀▀▀▀▀▀▀▄    █▀▀▀█▌  █▀▀▀█▌ █▀▀▀▀▀▀▀▀▀█▌ █▀▀▀█▌  █▀▀▀█ █▀▀▀█▌ █▀▀▀▀▀▀▀▀▀█▌
▄▀░░░▄▀▄░░░▀▄  ░░░░░▌  ░░░░░▌ ░░░░░▀▀▀▀▀▀▌ ░░░░▒▌  ░░░░░ ░░░░░▌ ░░░░░▀▀▀▀▀▀▌
▒▒▒▒▒ ▒▒▒▒▒▒▒▌ ▒▒▒▒▒▌  ▒▒▒▒▒▌ ▒▒▒▒▒ ░░▒▒▓▌ ▒▒▒▒▀▄  ▒▒▒▒▒ ▒▒▒▒▒▌ ▒▒▒▒▒ ░░▒▒▓▌
▓▓▓▓▓▄▄▄▓▓▓▓▓▌ ▓▓▓▓▓▌  ▓▓▓▓▓▌ ▓▓▓▓▓▄▄▄▄▄▄  ▓▓▓▓▓▓▀▄▓▓▓▓▓ ▓▓▓▓▓▌ ▓▓▓▓▓▌
█████████████▌ █████▌  █████▌ ███████████▌ █████▄██▀████ █████▌ █████▌
█░░░█▀▀▀█░░░█▌ █░░░█▌  █░░░█▌ █░░░█▀▀▀▀▀▀▌ █░░░█ ▀▄░░░░█ █░░░█▌ █░░░█▌
▓▒▒▒▓▌▒▒▓▒▒▒▓▌ ▒▒▒▒▒▌  ▒▒▒▒▒▌ ▓▒▒▒▓ ░░▒▒▓▌ ▓▒▒▒▓▌░░▓▒▒▒▓ ▓▒▒▒▓▌ ▓▒▒▒▓▌
▒▓▓▓▒▌▄▄▒▓▓▓▒▌ ▄▀▓▓▓▄▄▄▓▓▓▀▄▌ ▒▓▓▓▒▄▄▄▄▄▄  ▒▓▓▓▒▌▄ ▒▓▓▓▒ ▒▓▓▓▒▌ ▒▓▓▓▒▄▄▄▄▄▄
░███░▌  ░███░▌ ▌░▀▀█████▀▀░▒▌ ░█████████░▌ ░███░▌ ▀░███░ ░███░▌ ░█████████░▌
▄▀▀▀▄▌  ▄▀▀▀▄▌ █░  ▄▀▀▀▄▌░▒▓  ▄▀▀▀▀▀▀▀▀▀▄▌ ▄▀▀▀▄▌  ▄▀▀▀▄ ▄▀▀▀▄▌ ▄▀▀▀▀▀▀▀▀▀▄▌
▌░░▒▓▌  ▌░░▒▓▌  ▀▄ ▌░░▒▓▌▄▀   ▌ ░░░░▒▒▒▓▓▌ ▌░░▒▓▌  ▌░░▒▓ ▌░░▒▓▌ ▌ ░░░░▒▒▒▓▓▌
█▄▄▄▄▌  █▄▄▄▄▌    ▀█▄▄▄▄▀     █▄▄▄▄▄▄▄▄▄▄▌ █▄▄▄▄▌  █▄▄▄▄ █▄▄▄▄▌ █▄▄▄▄▄▄▄▄▄▄▌
```

它是一份固定资源，不是运行时画出来的：`scripts/brand/avenic-logo.sh` 是设计源，`test/fixtures/brand/avenic-logo.ansi` 是它的输出，`packages/cli/src/cli/brand-logo.mjs` 把它存成常量，测试逐字节对齐这三者。渲染只做一次字符串拼接，不读文件、不起进程、不联网。

图形只在需要「这是一屏的开始」的地方出现；`avenic status` 与 `self-update` 用一行紧凑品牌代替，`avenic claude`、`avenic codex`、`avenic opencode` 直接启动 Agent，什么都不打印。

配色只有一套语义角色，全部集中在 `packages/cli/src/cli/brand.mjs`：

| 角色 | 用于 |
|---|---|
| 品牌红橙（`◆` `◇`、`▸` 光标、`◉` 选中项、已勾选的行） | 产品身份与「你在这里 / 你选了什么」 |
| 绿色 | 只表示成功与「当前」（`current`），不参与品牌 |
| 黄色 / 红色 | 警告 / 错误 |
| 暗灰 | 次要信息：`│` `└` 竖线与横线、提示、说明 |

颜色会按终端能力退化：支持真彩就真彩，否则 256 色，再否则 16 色；`NO_COLOR` 只去掉颜色，布局一个字符都不变。窄终端、非 TTY（管道、CI）同样如此——非 TTY 输出里不含任何控制序列。

## 会话历史：Shared 与 Isolated

`avenic init` 的最后一问是 History：

- **Shared**（共享）：Avenic 的 canonical 历史是唯一持久来源，各 Agent 的原生会话是它的投影。Claude Code、Codex、OpenCode 可以继续同一条会话；原生历史会被增量导入，不会重复。
- **Isolated**（独立）：各 Agent 保留自己的原生历史，互不干扰；仍可导入、查看，并可随时用 `avenic change` 无损切换到 Shared（每条会话保留自己的身份与出处，不做拼接）。

Authentication 与 History 完全解耦：**继续一条共享会话不改变任何一个 Agent 的 Authentication 答案**——接力只把各 Agent 平时用的那套运行环境交给它，不切换 provider、不复制凭据、不要求重新登录，也不会为了会话另造一套凭据目录。

```bash
avenic sessions list                        # List shared sessions and each agent's cursor
avenic sessions status                      # The current active session and its sync status
avenic sessions continue <id> --agent codex # Continue the same session with another agent
avenic sessions continue <id> --agent claude
avenic sessions continue <id> --agent opencode
avenic sessions sync                        # Incrementally import native history into the shared workspace
avenic sessions git on|off|status           # Whether project session records are committed to Git
```

`continue` 会说明这次是新建投射还是续接，以及新补入了多少条共享事件。Claude Code 与 Codex 走 L3a 语义续接，OpenCode 走 L3 原生续接（`opencode import` + `--session`）。

OpenCode 的投射不会替用户选模型：它用你在 OpenCode 配置里指定的模型（没配就用 OpenCode 自带默认），也不会把别的 Agent 的 provider/model 写进 OpenCode 会话——否则这条会话在你没有该供应商时根本启动不了。万一投射出来的会话仍然启动失败，Avenic 会自动改用一条全新的官方会话、把共享历史增量作为开场内容交过去，而不是让共享历史整体失败。

## 状态：`avenic status`

一个命令回答「这个项目现在是什么样」：配置了什么、History 模式与活动会话、三个 Agent 各自的 Authentication / Sessions / 同步状态、Skills 与 Hub。

```console
$ avenic status
AVENIC · Status
│  D:\FileDownload\Projects\agenthome-cli

◇  Project
│  Name      agenthome-cli
│  Agents    claude, codex

◇  History
│  Mode      shared
│  Sessions  24
│  Active    claude-bee6f9b7-…  claude bee6f9b7
│  Events    5939
│  Updated   2026-09-19 09:51

◇  Agents
│  Agent        CLI    Auth                  Sessions  History  Sync
│  Claude Code  found  API (Project)         project   10       current
│  Codex        found  Account (Project)     project   10       stale
│  OpenCode     found  Native (OpenCode UI)  —         0        —
│  ·  Claude Code: .claude/settings.local.json, Provider DeepSeek, Model deepseek-chat
│  !  Codex: stale — run: avenic sessions continue <id> --agent <agent> to extend it
│  ·  Codex: Account Scope Project (.agents/local/codex)
│  !  Codex: Account Status Not signed in — run: avenic codex to sign in
│  ·  OpenCode: run: avenic opencode init

◇  Skills
│  Project   15 installed · optimized · current
│  Global    nothing installed
│  Hub       Echo-Kang-hub/SkillsHub · current · 9122e3a
```

`Sync` 一列的含义是「项目里的投射离共享历史还有多远」，每个值都对应一个可以动手的状态：

| 值 | 含义 | 下一步 |
|---|---|---|
| `current` | 投射停在共享历史的最后一个事件上 | 无事可做 |
| `stale` | 共享历史有了新事件，投射还没跟上 | `avenic sessions continue <id> --agent <agent>` 把它接上 |
| `missing` | 有映射，但两个存储里都找不到对应会话 | 共享历史：`avenic sessions continue <id> --agent <agent>` 重建，或 `avenic sessions sync`；独立历史：`avenic sessions sync`，或 `avenic change --history shared` 后重建 |
| `running` | 这个项目里正有一个该 Agent 在跑 | 无 |
| `dirty` | 上次启动没走完退出流程 | `avenic sessions sync` 收尾 |
| `none` | 该 Agent 未初始化 | `avenic <agent> init` |

`Auth` 一列写的是 Authentication 那一问的答案，连同**这个答案自己的作用域**：`Account (Global)`、`Account (Project)`、`API (Project)`…… OpenCode 写 `Native (OpenCode UI)`（认证与 provider 都由 OpenCode 自己管）。每个 Agent 的行下面跟着它这一种答案特有的几行，回答的都是「这份东西在哪」：

| 答案 | 下面的行 |
|---|---|
| Account | `Account Scope`：`Global`，或 `Project (.agents/local/codex)`——后者是项目里那个账号家目录。`Account Status`：`Signed in` / `Not signed in` / `Unknown`——读 Agent 自己的凭据文件得出，从不打印凭据本身；平台把凭据放在文件之外（例如 macOS 钥匙串）时就写 `Unknown`，而不是替它断言「没登录」。 |
| API | `Config Source`：这个答案落在哪个文件（Claude 的项目作用域是 `.claude/settings.local.json`，Codex 的项目作用域是 `.agents/local/codex/config.toml`）。文件不在、读不出来、还没有内容，是三种不同的处境，各有一行 `!` 提示指向 `avenic change`；文件里已经有东西了，就给出 `Provider` 与 `Model`——**只有文件里真的写了才显示**。 |

**Avenic 不往这份文件里写 provider、模型或凭据**：API 那一问只把这个位置准备好（不在就建一个空的，权限 0600），`Config Source` 一行的信息全部是从你写下的内容里读回来的。项目跑在 Account 上、而 API 那份配置文件就摆在旁边时，会多一行 `Detected but inactive`——两份答案可以同时存在，这一行说明哪一份在生效。

`Auth` 一列没有答案可报时写 `Not chosen`（这个项目还没回答 Authentication），从没配置过的 Agent 写 `Not configured`；未初始化的 Agent 会在下面给出 `run: avenic <agent> init`，CLI 不在 PATH 上的则说明「这个 Agent 的 CLI 不在 PATH 上，Avenic 仍然管理它的历史」。

`avenic status --json` 输出同一份模型的 JSON（`schemaVersion: 1`），VS Code 插件展示的就是它。

`status` 只读本地状态：不联网、不跑 `git fetch`、不启动任何 Agent CLI。某个 Agent 没装也不影响整体输出——那一行会写 `not found`，其余照常。

## Agent 命令

### 命令

`<agent>` 为 `claude`、`codex`、`opencode` 之一。

| 命令 | 说明 |
|---|---|
| `avenic <agent>` | 启动 Agent，其余参数透传给官方 CLI |
| `avenic <claude\|codex> init [--auth account\|api] [--scope global\|project] [--sessions global\|project]` | 回答该 Agent 在这个项目里的 Authentication 与 Sessions |
| `avenic opencode init [--sessions global\|project]` | OpenCode 的 Authentication 是 `Native (OpenCode UI)`，`init` 只问 Sessions |
| `avenic <agent> deinit [--purge [--purge-credentials]]` | 移除该 Agent 在本项目里的配置；`--purge` 一并删除数据（Agent 自己的登录默认保留）；连登录一起删要再加 `--purge-credentials` |
| `avenic <claude\|codex> auth [account\|api\|reset] [--scope global\|project]` | 改这个项目的 Authentication 答案；不带参数时打印该 Agent 的状态页 |
| `avenic <agent> status` | 查看该 Agent 的配置与状态 |
| `avenic <agent> sessions import\|writeback\|status` | 管理便携会话 |
| `avenic status [--json]` | 这个项目的一览：配置 / 历史 / Agent / Skills |
| `avenic hook emit --agent <agent> [--verbose\|--json]` | Agent 自己的钩子调用它：读 stdin 上的一条原生载荷，归一化成 Avenic 的六种事件（`session.started` / `turn.started` / `turn.completed` / `turn.failed` / `attention.required` / `session.ended`），再派发通知动作；VS Code 关着照常工作 |
| `avenic hook install --agent <agent> [--scope project\|global] [--dry-run] [--json]` | 把 Avenic 的条目并入该 Agent 自己读的那份配置（Claude 的 settings 文件、Codex 的 `config.toml`、OpenCode 的插件文件），用户自己的内容一个字节不动；`--dry-run` 只打印 diff，末行是 `Nothing was written — this was --dry-run.` |
| `avenic hook uninstall --agent <agent> [--scope project\|global] [--json]` | 把自己写进去的那一条取出来，文件回到安装前的字节 |
| `avenic hook status [--agent <agent>] [--scope project\|global] [--json]` | 只读：每个 Agent 的钩子装没装、落在哪个文件 |
| `avenic hook test --agent <agent>` | 打一条合成的 `turn.completed`，让人在 VS Code 关着时看完整条通知链，并同时打印这个项目的钩子是否已装 |
| `avenic doctor` | 环境自检（已弃用：用 `avenic status`） |

这些按 Agent 的子命令是项目配置的薄包装：它们读写的仍是 `avenic init` 建的同一份配置——项目自己的答案在 `.agents/runtime.json`，本机对这个项目的覆盖在 `.agents/local/runtime.local.json`——不会另起一套状态。

钩子是另一条路：Agent 自己的钩子调用 `avenic hook emit`，把原生载荷在 stdin 上归一化成那六个事件，再按项目 `.agents/local/hook-actions.json` 里的动作发通知——VS Code 关着、扩展从没被激活过也一样。`avenic hook install` 只并入一条属于 Avenic 的条目，并认得出哪条是自己的（Claude 按命令认，Codex 按自己的 `# avenic:hooks` 标记，OpenCode 是一个由 Avenic 整份拥有的插件文件），所以用户自己的钩子与注释原样保留，`uninstall` 之后文件回到装之前的字节；Codex 的钩子在用户审阅之前是 untrusted，安装时把这句提醒一并打印。`emit` 的退出码 0 也包括「收下或有意跳过」：动作失败会被报出来，但不会让报出它的那一轮跟着失败。

`init` 的结果页用 Dashboard 的同一批字段说出每个 Agent 的答案（`Authentication`、`Account Scope` / `Config Source`、`Sessions`，最后是 `History`）：

```console
$ avenic init --agents claude,codex --auth api --scope project --sessions project --history shared
◆  Avenic project initialized
│  /Users/you/work/my-project

◇  Claude Code
│  Authentication  API (Project)
│  Config Source   .claude/settings.local.json (nothing in it yet)
│  Sessions        Project
│  History         Shared

◇  Codex
│  Authentication  API (Project)
│  Config Source   .agents/local/codex/config.toml (nothing in it yet)
│  Sessions        Project
│  History         Shared

◇  History
│  Shared
```

`Config Source` 那一行的文件是 Avenic **建出来的（空的）**，路径就是它告诉你的位置；`(nothing in it yet)` 说的是里面还没有内容——provider、模型、凭据都由你自己填。这次落到磁盘上的还有：项目自己的答案在 `.agents/runtime.json`、本机对这个项目的覆盖在 `.agents/local/runtime.local.json`、会话在 `.agents/sessions/<agent>/`、Account·Project 的账号家目录在 `.agents/local/<agent>/`。`init` 可重复执行：结构已符合时不作修改，有缺失时只增量补齐。

### Authentication：Account 与 API

每个 Agent 在这个项目里回答同一个问题：**Authentication**——`Account` 还是 `API`。两个答案各自带着**自己的**作用域，互不相干：`accountScope` 只属于 Account，`configScope` 只属于 API，两者不会同时存在。这个答案和它的作用域是一个值，界面上也这样念：`Account (Project)`、`API (Global)`。Sessions（会话存哪儿）是另一个问题，与它无关。

**Account**——Avenic 不登录、不存凭据、不发明凭据格式：

- `global`（默认）：用这台机器本就有的登录，Avenic 什么都不改。
- `project`：把 Agent **自己的**配置根变量指向项目——Claude 是 `CLAUDE_CONFIG_DIR`，Codex 是 `CODEX_HOME`，都指向 `<项目>/.agents/local/<agent>`。Agent 自己的 `login` 在它自己的格式里往那里写自己的文件，`cwd` 仍是项目根；用户的 `~/.claude`、`~/.codex` 不会被读进这个家目录，也不会被写、被删。

**API**——Avenic 准备该 Agent 自己读的那个位置，然后就不碰它了：

| Agent | 作用域 | 这一问落在哪个文件 |
|---|---|---|
| Claude Code | `global` | `$CLAUDE_CONFIG_DIR` 或 `~/.claude` 下的 `settings.json` |
| Claude Code | `project` | `.claude/settings.local.json`（Claude 自己的项目配置文件） |
| Codex | `global` | `$CODEX_HOME` 或 `~/.codex` 下的 `config.toml` |
| Codex | `project` | `.agents/local/codex/config.toml`（启动时用 `CODEX_HOME` 指过去） |

文件不在，就按该 Agent 自己的格式建一个最小的（JSON 是 `{}\n`，TOML 是空文件，权限 0600），并把路径告诉你；文件已经在，**就一个字节都不动**。Avenic 不往里面写 provider、端点、模型或凭据——那是你自己的事——也不会在之后的 `init` / `change` 里回填或改写它。`avenic status` 只是把那份文件里已经写着的东西读回来看。

**Avenic 只在账本里记一条「这是我建的」。** `.agents/local/ownership.json` 记下路径、是不是 Avenic 建的、以及建的时候内容的哈希；**账本里没有密钥，也没有文件内容**。换答案时选 Remove，它只交还账本能证明是自己建的那一份，三种结果都如实报出：原样未动的删除（`Removed … — Avenic created it and nothing had changed it since.`）、你改过的保留（`Configuration in … was modified outside Avenic and will be preserved.`）、账本里没有的保留（`Kept … — Avenic did not create it, so it is not Avenic's to delete.`）。

**两份文件、两个作用**——别混淆：

| 文件 | 属于谁 | Avenic 会怎样 |
| --- | --- | --- |
| `.agents/local/<agent>/` | Account·Project 下 Agent 自己的账号家目录 | 只把 Agent 的配置根变量指过来；里面的一切由 Agent 自己的 `login` 写，Avenic 不写、不改；`deinit --purge` 默认也保留其中的登录文件（会点名），连它一起删要再加 `--purge-credentials` |
| `.claude/settings.local.json` | Claude Code 自己的项目配置 | 只在 API 模式下、而且只在这个文件不在时创建一个空的；里面的内容是你的，切回 Account 不会删它 |

启动只读配置：Authentication 的答案与作用域决定这次运行的环境与参数，磁盘上的写入只发生在 `init`、`change` 与 `<agent> auth`（以及启动时你选择 Remember 的那一次）。

### 密钥与 Git

Avenic 把下列路径写进项目 `.gitignore` 的 `# Agent Runtime` 分节：`.claude/skills/`、`.claude/settings.local.json`、`.agents/skills/`、`.agents/local/`、`.agents/tmp/`、`.agents/direct/`、`.agents/licenses/`、`.agents/api/`、`.agents/projection.json`；`.agents/sessions/` 另由 `avenic sessions git on|off` 控制（默认进 Git）。账本 `.agents/local/ownership.json` 与 API 那一问准备的配置文件都在这张表里（前者随 `.agents/local/`，后者本身就在 `.agents/local/` 或 `.claude/settings.local.json`），所以凭据不会被 `git add` 进去。

规则只跟着它所保护的东西同进退：`deinit` 只会移除守护对象已经不存在的规则（`.agents/local/` 在目录还在时就保留——Agent 自己的登录在里面），不会出现「凭据文件还在、却已经能被 `git add`」的窗口。

### 换一个 Authentication 答案

`avenic change` 在收齐新答案之后、写入之前，若发现某个 Agent 换了答案、而旧答案还在磁盘上，会先把它指名道姓地摆出来，再问一次：

```text
◇  Existing Claude Code configuration
│  .claude/settings.local.json is still present.
◆  What should Avenic do?
│  Claude Code API (Project) → Account (Global) · Keep — nothing is deleted · …
│
│  ▸ ◉  Keep
│    ○  Remove
```

（终端窄时那一行说明会截断；它完整说的是 Keep 什么都不删、Remove 只删 Avenic 建的那份文件。）

默认 **Keep**：新答案照常写入，旧配置留在原地不动。选 **Remove** 会再确认一次——`Remove old configuration? This cannot be undone.`，光标开在 `No` 上，答 No 就直接走到 Apply——然后只删除 Avenic 能证明是**自己为这个项目**建的那份文件。旧的 Account 家目录只被点名、不会被删：里面的登录是 Agent 自己做的，证明不了是 Avenic 的；`~/.claude`、`~/.codex`、别的项目一律不碰，`.claude/settings.local.json` 也不会因为你切回 Account 就被删掉。

`avenic <agent> auth` 走同一条路口：先问旧答案，再写新答案，然后打印这个 Agent 的状态页，外加一句说明这次的答案落在磁盘的哪里。

```bash
avenic claude auth api --scope project   # Switch this project to API; prepare .claude/settings.local.json
avenic claude auth account               # Switch back to Claude signing in itself
avenic claude auth reset                 # Clear the local override and return to the project's own answer
avenic claude auth                       # Show the answer and scope currently in effect
```

`auth reset` 清掉的是**本机覆盖**（`.agents/local/runtime.local.json`），项目在 `.agents/runtime.json` 里的答案随即重新生效。

### 项目还没回答 Authentication 时

还没回答的 Agent，普通启动会先问一次：`Account`（用 Agent 自己的账号登录）还是 `API`（你自己准备的 provider/model 配置），再问一次可选的 `Remember for this project?`（默认 No）。Esc 取消这次启动。非终端环境（管道、CI）不问，按该 Agent 自己的账号启动并把这件事说出来。全程只读本地状态：不联网、不发起登录、不调用模型。

回答只影响**这一次启动**，除非你选了 Remember——那时它作为本机覆盖记进 `.agents/local/runtime.local.json`，不替换项目在 `.agents/runtime.json` 里的答案；`avenic <agent> status` 在这种情况下会多一行 `This checkout runs on a local override (.agents/local/runtime.local.json), not on the project's own answer.`。

Authentication 与 History 是独立的两个维度，四种组合都成立：Account + 共享历史、API + 独立历史等。

### 会话记录

- `Project`（默认）：启动前把项目内的会话记录提供给 Agent，退出后把本次会话写回项目，并把本机原生存储恢复到启动前的状态。会话只更新在项目里，全局存储完全不受影响；删除项目后，会话随项目消失。
- `Global`：会话直接留在 Agent 的原生全局存储，不产生项目副本。

```bash
avenic codex sessions import      # Global sessions → project session records (copied, not deleted)
avenic codex sessions writeback   # Project session records → native storage (explicit write-back)
avenic codex sessions status
```

若同一会话在本机原生存储与项目内都有记录，`avenic <agent>` 启动时以项目内的会话记录为准（覆盖本机副本）。要用全局会话记录时，直接运行 `claude`（其他 Agent 同理直接运行官方 CLI）即可。

项目内的会话记录不会自动回写本机原生存储；需要回写时显式执行 `avenic <agent> sessions writeback`：原生存储中该项目的会话记录会被项目内记录覆盖；原生存储中没有该项目的会话记录时，则按 Agent 的原生目录结构创建后放入会话，效果与直接用官方 CLI 产生的会话一致。

### 会话的持久化与恢复

会话在三个层面保持持久，任何一层失效都不会丢：

1. **运行中**：后台看门狗按固定间隔增量读取当前项目的原生会话文件，只读新增的字节，随时把新内容并入共享历史。
2. **退出后**：Agent 正常退出时立即完成一次捕获。
3. **下次启动 / 再次查看**：启动或 `avenic sessions` 时补齐上一次没来得及收尾的部分。

同一项目同一 Agent 可同时启动多个 `avenic` 会话：第一个启动时保存原生存储快照，最后一个退出时回滚。看门狗是脱离终端的独立进程：直接关闭终端、关闭 VS Code、强杀 CLI 都不会影响收尾。断电或强制重启导致看门狗也没能收尾时，残留会话留在原生存储里，可手动 `avenic <agent> sessions import`，或在下次启动 `avenic` 时自动补齐。

看门狗只监视当前项目已知的原生目录，不递归扫描整个 HOME；空闲时几乎不占 CPU、不发起网络请求、不调用模型，也从不修改 Agent 的原生文件。轮询间隔可用环境变量调整：

```bash
AVENIC_WATCH_INTERVAL_MS=1000 avenic claude   # default 3000
```

> OpenCode 例外：其会话存储由官方 CLI 自行管理，`avenic opencode` 启动后原生存储仍保留本次运行产生的会话，不受上述回滚保护。

> 项目会话可能包含提示词、源码、命令输出、路径与密钥；仅在可信仓库中提交会话。

## Skills

### Hub

Hub 是一个 git 仓库，公开或私有均可；私有仓库使用本机 git 认证（gh、SSH 或 credential helper），CLI 不接触 token。标准结构：

```
my-hub/
├── sources.lock.json                    # Upstream source registry: id, repo URL, locked commit, Skill root, license
├── packs/
│   ├── common.json                      # Pack definition (common is the default Pack, included automatically when installing)
│   └── development.json
├── skills/                              # Skill copies filed by source
│   └── <source-id>/<skill-name>/SKILL.md
└── licenses/                            # Upstream licenses (saved automatically when a source is registered)
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

裸 `avenic skills` 在终端里打开菜单：

```
◇  Skills
│  ▸ ◉  Add skills   SkillsHub Packs or a Git repository
│    ○  Installed skills   what this scope holds now
│    ○  Update skills   re-install from the latest Hub revision
│    ○  Remove skills   Packs, direct Skills, or everything
│    ○  Sync SkillsHub   fetch the Hub with your git credentials
│    ○  Import from repository   clone, then pick Skills
```

`▸` 是光标，`◉`/`○` 是选中状态；箭头或 `j`/`k` 移动，回车确认，`Esc` 退出——菜单里没有 Back 行，退出菜单永远只有 Esc 一个说法。

`Add skills` 与 `Import from repository` 是同一个流程的两个来源，步骤固定为：来源 → 发现（`✓  Found 14 skills`）→ 多选 → `Install to` → `Scope` → 摘要 → 确认。带搜索的多选对长清单按输入即时过滤，`Ctrl+A` 全选。

`Install to` 列出的是技能实际会落到的目录：真身写在 `.agents/skills`（Codex / OpenCode / 通用 Agent 读的那个，固定勾选），`Claude Code` 读的是它指向真身的链接（`.claude/skills`，可取消）。这个选择会记进锁文件——之后 `uninstall`、`update` 重装剩余 Pack 时沿用，不会把技能重新链接到一个你明确没勾的目标上。

同一条流程也能直接走命令行（脚本里同样可用，不需要终端）：

```bash
avenic skills add <owner/repo>          # Name a repo: on a terminal it opens discover → multi-select; in a pipe it installs all of its Skills
avenic skills add <owner/repo> a b      # Name Skills: install directly, no prompting
avenic skills remove <skill...>         # Remove directly installed Skills
```

Hub 这边则是 Pack 为单位：

```bash
avenic hub add <owner/repo>         # Add a Hub (owner/repo[#ref], URL or local path); on success prints the Pack preview tree
avenic skills install                   # Install the default Pack (common)
avenic skills install development       # Install several Packs; common is included automatically
avenic skills uninstall development     # Uninstall a Pack (no arguments removes all managed Skills)
avenic skills -g development            # Install to the global scope (skills <pack> is shorthand for install)
avenic skills tree [pack...]            # Show the Hub content tree
avenic skills packs                     # List available Packs
avenic skills status [-g]               # Current install status
```

非终端环境（管道、CI、脚本）不会卡在提示上：裸 `avenic skills` 回退为安装默认 Pack（common），`avenic skills install` 同理。

`hub add` 拉取失败不影响源保存，之后 `avenic hub sync` 重试。可反复 `add` 注册多个 Hub，同一时间生效一个（该 Hub 聚合的多个上游源共享所有 Pack）：

```bash
avenic hub select [name|spec]       # ↑/↓ pick the current Hub (prints the list when there is no terminal)
avenic hub list                     # List registered Hubs (> marks the current one)
avenic hub default                  # Show the current Hub
avenic hub sync                     # Fetch or update the cache (~/.config/avenic/catalog/)
```

每次安装把 Hub commit 写入项目锁 `.avenic.lock.json`，跨设备可复现。

Hub 内容树是**缓存优先**的：展开、浏览、`avenic skills tree` 都只读本地缓存，不会自动联网；缓存还没同步过时它会直接告诉你先运行 `avenic hub sync`，而不是替你去联网。只有显式执行 `avenic hub add` 或 `avenic hub sync` 才会访问网络——缓存未命中时 `git clone`，已缓存时 `git fetch` 后更新，成功后打印 `Synced · <short sha> · <时间>`。安装同样先看缓存：锁文件钉住的修订如果已经在本机，就不再去拉一次（同一份内容，跨设备可复现）。认证完全交给本机 git（SSH、credential helper、`gh`、git config 里的 PAT）；Avenic 不建立自己的 GitHub token 体系。

> 默认 Hub 为维护者提供的示例；使用前请通过 `avenic hub add <owner/repo>` 指向自己的 Hub。

#### 构造与维护 Hub

初始化骨架、登记上游、建 Pack、校验后推送：

```bash
mkdir my-hub && cd my-hub
git init
mkdir -p packs skills
echo '{"schemaVersion":1,"sources":[]}' > sources.lock.json
avenic hub pack-add common --name Common                        # Create a Pack
avenic hub skill-add <owner/repo> --pack common                 # Register the first upstream source and take in all of its Skills
avenic hub pack-add development --name Development
avenic hub skill-add <owner/repo> skill-a skill-b --pack development
avenic hub doctor                                               # Validate the structure
git add -A && git commit -m "hub" && git push
```

`skill-add` 自动登记未收录的上游源（锁定 commit、保存许可证）；省略 `[skill...]` 收录该源全部 Skill；可反复 `skill-add` 聚合多个上游源。

维护命令（在 Hub 克隆内运行）：

```bash
avenic hub skill-add <source-id|owner/repo> [skill...] [--pack <pack,pack>]
avenic hub remove <source-id|owner/repo> <skill...> [--pack <pack,pack>]   # Remove Skills from Packs; deletes the copy once no Pack references it
avenic hub pack-add <id> [--name <name>] [--description <text>]
avenic hub pack-remove <pack...>                                          # Delete Packs (common cannot be deleted); unreferenced Skills are cleaned up too
avenic hub source-add <id> <repo> [--name <name>] [--skill-root <path>] [--license <path>]
avenic hub update [source] [--check]                                      # Follow upstream updates and lock the new commit
avenic hub doctor                                                         # Validate the Hub
```

#### 连接私有 Skills 仓库

私有仓库不需要额外配置：CLI 不接触 token，clone 与 fetch 全部由本机 git 完成。以连接私有 Hub `Echo-Kang-hub/SkillsHub` 为例：

```bash
gh auth login                                            # 1. Sign in to GitHub (or use an SSH key instead — either one, only once)
avenic hub add Echo-Kang-hub/SkillsHub    # 2. Set the Hub source (replace with <your-user>/<your-repo>); a terminal prints the Pack preview tree
avenic hub sync                                   # 3. Verify it can be fetched (on success prints Synced · <short sha> · <time>)
avenic skills install                                 # 4. Install the default Pack (common)
```

- Windows 上 HTTPS 方式默认使用 Git Credential Manager（首次自动弹窗登录）；也可以使用 SSH 地址：`avenic hub add git@github.com:<owner>/<repo>.git`
- `avenic skills add <owner/repo>` 从单个私有仓库安装 Skill，git 认证方式相同

同步失败时，Avenic 会判断 git 报出的原因并只给出对应的下一步；六类互不混淆：

| 类别 | 含义与处理 |
|---|---|
| `authentication` | 本机 git 被拒（含 403、`terminal prompts disabled`）。先运行 `gh auth status`、`ssh -T git@github.com`，或检查 credential helper |
| `repo-missing` | 仓库不存在或你的账号看不到。核对 `owner/repo` 拼写与权限 |
| `ref-missing` | `#` 后面的分支/引用不存在。核对 Hub spec 里的 ref |
| `network` | DNS、连接超时、TLS（含 `schannel`、`SSL certificate problem`）。检查网络、代理或 VPN |
| `git-missing` | PATH 上找不到 git。安装 git 后重试 |
| `cache-filesystem` | 本机缓存目录不可用（权限、被同名文件占用、磁盘满）。错误里会带上具体路径 |

| 现象 | 处理 |
|---|---|
| 换回其他 Hub | 已注册的直接 `avenic hub select` 切换；未注册的再次 `avenic hub add <spec>` |

### 共享与链接

同一作用域内每个 Skill 只保留一份物理文件：`.agents/skills/<name>` 是真身，`.claude/skills/<name>` 是指向它的链接（Windows 为 junction，macOS/Linux 为相对符号链接）。安装、更新、接管、直装以及 `avenic <agent>` 启动时都会补齐缺失的链接、清理已失效的链接，反复安装不会产生第二份副本。

```text
<project>/.agents/skills/<name>     the real copy (canonical)
<project>/.claude/skills/<name>     link → .agents/skills/<name>
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
avenic skills remove <skill...>   # Retract: remove Skills installed through add
```

从任意 GitHub 仓库直接安装 Skill（递归发现），锁定 commit 并保存许可证。公开仓库直接可用；私有仓库使用本机 git 认证（`gh auth login` 或 SSH）。与 Pack 管理的 Skill 重名会被拒绝。在终端里不点名 Skill 时，这条命令进入 `avenic skills` 的「发现 → 多选」流程。

## 撤回操作

| 操作 | 撤回 |
|---|---|
| `avenic init` / `avenic change` | 再跑一次 `avenic change` 改回原值；对话框里 Ctrl+C 取消则什么都没写 |
| `avenic sessions continue <id> --agent <x>` | 在 `avenic sessions` 界面里选 “Set active session” 换回原会话；或不再调用它 |
| `avenic <agent> init` | `avenic <agent> deinit`（加 `--purge` 连会话数据一起删除；Agent 自己的登录默认保留，连它一起删要再加 `--purge-credentials`） |
| `avenic <agent> auth account` / `auth api` | 执行相反设置（切换时先问 Keep/Remove，默认保留旧配置），或 `auth reset` 清掉本机覆盖 |
| `avenic <agent> auth api` 建出来的配置文件 | `avenic change` 或 `<agent> auth` 换答案时选 Remove：只有账本记着「Avenic 建的」、而且此后一个字节都没动过的那份文件会被删除，其余的保留并报出来 |
| `avenic <agent> sessions import` | 只复制不删除；清除项目副本：`avenic <agent> deinit --purge` 后重新 `init` |
| `avenic sessions git off` | `avenic sessions git on` |
| `avenic skills install [pack...]`（简写 `avenic skills [pack...]`） | `avenic skills uninstall`（全部）或 `avenic skills uninstall <pack>` |
| `avenic skills add <owner/repo>` | `avenic skills remove <skill...>` |
| `avenic skills` 菜单里的 Add / Import | 菜单里的 Remove skills；或 `avenic skills uninstall`、`avenic skills remove` |
| `avenic hub add <spec>` | `avenic hub select` 选回已注册 Hub，或再次 `avenic hub add <原 spec>` |
| `avenic self-update` | `npm install -g avenic@<旧版本>` |

## 自更新

```bash
avenic self-update
```

从 npm 安装最新版本，并打印当前版本、registry 上的版本与安装来源：

```text
AVENIC · self-update
Current: 1.5.1
Latest:  1.5.2
Source:  Echo-Kang-hub/avenic#main
Updated Avenic: 1.5.1 → 1.5.2
```

安装完成后会重新探测当前可执行文件。如果 npm 退出码为 0 但 PATH 上的仍是旧版本，命令会**报错失败**并指出 registry 版本与实际生效版本的差异，而不会假装成功——通常意味着 npm 全局前缀不在 PATH 上。

## License

[MIT](LICENSE)
