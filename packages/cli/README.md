# Avenic CLI

Avenic 用一个命令统一管理编码 Agent（Claude Code、Codex、OpenCode）的运行时配置、会话历史与 Skills，支持 Windows、macOS 和 Linux。

日常只需要这几条命令：

```bash
avenic init          # 配置本项目（在终端上是交互式界面）
avenic claude        # 启动某个 Agent 的原生 TUI（codex / opencode 同理）
avenic status        # 这个项目现在是什么样：配置 / 历史 / Agent / Skills
avenic skills        # 交互式 Skills 菜单：添加 / 已装 / 更新 / 移除 / 同步 Hub / 从仓库导入
avenic sessions      # 查看与管理共享会话
avenic change        # 随时改认证、会话存储或历史模式
avenic self-update   # 从 npm 更新
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
cd <你的项目>
avenic init          # 交互式配置：选 Agent → 每个 Agent 选认证方式与作用域 → 选会话存储 → 选历史模式 → 确认
avenic claude        # 进入 Claude Code；avenic codex / avenic opencode 同理
```

`avenic init` 只在你确认后写入。之后：

```bash
avenic change                       # 重开配置界面，改完确认才生效
avenic status                       # 这个项目的配置、Agent、历史、Skills 一览
avenic sessions                     # 交互式会话管理
avenic skills                       # 交互式 Skills 菜单
avenic --version                    # 打印已安装版本
avenic self-update                  # 更新到 npm 上的最新版
```

不改配置也能用：除 `init`、`change`、`<agent> auth` 之外的命令都不写认证与运行时配置；还没回答认证方式的项目，普通启动会先问一次（非终端环境按该 Agent 自己的账号启动并说明），尚未初始化的项目会提示先跑 `avenic <agent> init`。

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

`--agents` 指定要启用的 Agent；`--auth account|api` 是认证方式，`--scope global|project` 是这种方式自己的作用域（默认 `global`，只能跟着 `--auth` 出现）。`avenic change` 默认只改你点名的 Agent，`--replace-agents` 才会整体替换。

参数模式回答的是**方式**：`--auth api` 只记下"这个项目用 API"，provider、端点、模型和凭据要由交互向导收齐后写进 Agent 自己的配置文件——只带 `--auth api` 运行时不会替你写任何配置（启动时若还没有，会有一行提示让你跑 `avenic change`）。换方式时的 Keep/Remove 一问只存在于交互模式；非终端环境一律按 Keep 处理，绝不删除旧配置。

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

`avenic init` 的最后一个选择是历史模式：

- **Shared**（共享）：Avenic 的 canonical 历史是唯一持久来源，各 Agent 的原生会话是它的投影。Claude Code、Codex、OpenCode 可以继续同一条会话；原生历史会被增量导入，不会重复。
- **Isolated**（独立）：各 Agent 保留自己的原生历史，互不干扰；仍可导入、查看，并可随时用 `avenic change` 无损切换到 Shared（每条会话保留自己的身份与出处，不做拼接）。

认证与历史完全解耦：**继续一条共享会话不改变任何一个 Agent 的认证配置**——接力只把各 Agent 平时用的那套运行环境交给它，不切换 provider、不复制凭据、不要求重新登录，也不会为了会话另造一套凭据目录。

```bash
avenic sessions list                        # 列出共享会话与各 Agent 游标
avenic sessions status                      # 当前活动会话与同步状态
avenic sessions continue <id> --agent codex # 换一个 Agent 继续同一条会话
avenic sessions continue <id> --agent claude
avenic sessions continue <id> --agent opencode
avenic sessions sync                        # 把原生历史增量导入共享工作区
avenic sessions git on|off|status           # 共享会话记录是否进 Git
```

`continue` 会说明这次是新建投射还是续接，以及新补入了多少条共享事件。Claude Code 与 Codex 走 L3a 语义续接，OpenCode 走 L3 原生续接（`opencode import` + `--session`）。

OpenCode 的投射不会替用户选模型：它用你在 OpenCode 配置里指定的模型（没配就用 OpenCode 自带默认），也不会把别的 Agent 的 provider/model 写进 OpenCode 会话——否则这条会话在你没有该供应商时根本启动不了。万一投射出来的会话仍然启动失败，Avenic 会自动改用一条全新的官方会话、把共享历史增量作为开场内容交过去，而不是让共享历史整体失败。

## 状态：`avenic status`

一个命令回答「这个项目现在是什么样」：配置了什么、历史模式与活动会话、三个 Agent 各自的初始化/认证/会话/同步状态、Skills 与 Hub。

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
│  Agent        CLI    Auth               Sessions  History  Sync
│  Claude Code  found  API · Project      project   10       current
│  Codex        found  Account · Project  project   10       stale
│  OpenCode     found  native             —         0        —
│  ·  Claude Code: Config source .claude/settings.local.json, Provider DeepSeek, Model deepseek-chat
│  !  Codex: stale — run: avenic sessions continue <id> --agent <agent> to extend it
│  ·  Codex: Auth home .agents/local/codex
│  !  Codex: Auth status Not signed in — run: avenic codex to sign in
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

`Auth` 一列写的是「认证方式 · 这种方式自己的作用域」，例如 `Account · Global`、`API · Project`；OpenCode 写 `native`（它自己管认证与 provider）。每个 Agent 的行下面跟着它这一种方式特有的几行，回答的都是「这份状态在哪」：

| 方式 | 下面的行 |
|---|---|
| Account | `Auth home`（仅 `project` 作用域）：项目里的账号家目录，如 `.agents/local/codex`。`Auth status`：`Signed in` / `Not signed in` / `Unknown`——读 Agent 自己的凭据文件得出，从不打印凭据本身；平台把凭据放在文件之外（例如 macOS 钥匙串）时就写 `Unknown`，而不是替它断言「没登录」。`avenic <agent> status` 里这三个值各占一行；`avenic status` 只在需要动作时把 `Not signed in`、`Unknown` 作为 `!` 提示打出来。 |
| API | `Config source`：装着这份配置的文件（Claude 的项目作用域是 `.claude/settings.local.json`，Codex 的项目作用域是 `.agents/api/codex.json`）。Avenic 还没写过时，`avenic <agent> status` 写 `<文件> (nothing written yet)`，`avenic status` 给一行 `!` 提示 `<文件> holds no configuration Avenic wrote (run: avenic change)`——你自己手写的 provider 键不算这个项目的答案；写过则再给出 `Provider`、`Model`，以及凭据是有（`Set`）还是没有（启动时从你自己的环境里读）。 |

`Auth` 列没有方式可报时写 `not initialized`；未初始化的 Agent 会在下面给出 `run: avenic <agent> init`，CLI 不在 PATH 上的则说明「这个 Agent 的 CLI 不在 PATH 上，Avenic 仍然管理它的历史」。

`avenic status --json` 输出同一份模型的 JSON（`schemaVersion: 1`），VS Code 插件展示的就是它。

`status` 只读本地状态：不联网、不跑 `git fetch`、不启动任何 Agent CLI。某个 Agent 没装也不影响整体输出——那一行会写 `not found`，其余照常。

## Agent 运行时

### 命令

`<agent>` 为 `claude`、`codex`、`opencode` 之一。

| 命令 | 说明 |
|---|---|
| `avenic <agent>` | 启动 Agent，其余参数透传给官方 CLI |
| `avenic <claude\|codex> init [--auth account\|api] [--scope global\|project] [--sessions global\|project]` | 初始化该 Agent 的运行时 |
| `avenic opencode init [--sessions global\|project]` | OpenCode 自己管认证与 provider，只记会话作用域 |
| `avenic <agent> deinit [--purge [--purge-credentials]]` | 移除运行时；`--purge` 一并删除数据（Agent 自己的登录默认保留）；连登录一起删要再加 `--purge-credentials` |
| `avenic <claude\|codex> auth [account\|api\|reset] [--scope global\|project]` | 改这个项目的认证方式；不带参数时打印该 Agent 的状态页 |
| `avenic <agent> status` | 查看该 Agent 的配置与状态 |
| `avenic <agent> sessions import\|writeback\|status` | 管理便携会话 |
| `avenic status [--json]` | 这个项目的一览：配置 / 历史 / Agent / Skills |
| `avenic doctor` | 环境自检（已弃用：用 `avenic status`） |

这些按 Agent 的子命令是项目配置的薄包装：它们读写的仍是 `avenic init` 建的同一份配置——项目自己的答案在 `.agents/runtime.json`，本机对这个项目的覆盖在 `.agents/local/runtime.local.json`——不会另起一套状态。

`init` 的输出会列出实际创建或修改的内容（`.agents/runtime.json`、`.agents/sessions/<agent>/`、Account·Project 时的 `.agents/local/<agent>/`、`.gitignore`），并以一句话说明这次选的方式落在磁盘的哪里。`init` 可重复执行：结构已符合时不作修改，有缺失时只增量补齐。

### 认证方式：Account 与 API

每个 Agent 在这个项目里回答同一个问题：**认证方式**（`authMethod: account | api`）。**认证方式与模型/provider 配置是两个不同的问题**：Account 是 Agent 自己登录，Avenic 不配置任何模型；API 是 Avenic 把 provider、端点、模型与凭据写进 Agent 自己读的那个文件。作用域只属于回答它的那一种方式——`accountScope` 只对 Account 存在，`configScope` 只对 API 存在，两者不会同时存在；`sessionScope` 与两者都无关。

**Account**——Avenic 不登录、不存凭据、不发明凭据格式：

- `global`（默认）：用这台机器本就有的登录，Avenic 什么都不改。
- `project`：把 Agent **自己的**配置根变量指向项目——Claude 是 `CLAUDE_CONFIG_DIR`，Codex 是 `CODEX_HOME`，都指向 `<项目>/.agents/local/<agent>`。Agent 自己的 `login` 在它自己的格式里往那里写自己的文件，`cwd` 仍是项目根；用户的 `~/.claude`、`~/.codex` 不会被读进这个家目录，也不会被写、被删。

**API**——Avenic 写的是该 Agent 自己读的配置文件：

| Agent | 作用域 | 写进哪个文件 | 写什么 |
|---|---|---|---|
| Claude Code | `global` | `~/.claude/settings.json` | `env.ANTHROPIC_BASE_URL`、`env.ANTHROPIC_MODEL`、`env.ANTHROPIC_AUTH_TOKEN` |
| Claude Code | `project` | `.claude/settings.local.json`（Claude 自己的项目配置文件） | 同上 |
| Codex | `global` | `~/.codex/config.toml` | `model`、`model_provider` 与 `[model_providers.<id>]` 表的 `name`/`base_url`/`env_key`/`wire_api` |
| Codex | `project` | `.agents/api/codex.json`（Avenic 自己的记录） | 同样的字段；启动时以 `-c model=…`、`-c model_provider=…`、`-c model_providers.<id>.*` 交给这一次 Codex |

provider 的 id 由 provider 名称推导（小写，非字母数字折叠成 `-`）；`wire_api` 在 OpenAI 自家端点上写 `responses`，其他端点写 `chat`。Claude 的凭据是 bearer token，写进配置文件（向导里掩码输入，之后只以「有没有」出现）；Codex 的凭据字段是**环境变量名**，Avenic 写的是这个名字，密钥本身留在你的环境里——启动时该变量没有值，会明确提示。

**再次 `avenic change` 时，这一套问题是「回填」的。** provider、端点、模型都按 Avenic 写过的值预填，凭据那一问则始终空着——密钥不回显，所以空着只能是同一个意思：**保持已经写下的那个**。于是对着一路 Enter 走完 `change` 不会改动配置，一个字节都不变；要清掉这份配置，用的是换方式时的 Keep/Remove 那一问。

**写进 Agent 自己的文件时，写入不是覆盖，而是记账。** Avenic 把创建了哪些键、写了什么、写之前是什么记进 `.agents/projection.json`；因此换方式并选择 Remove 时，它只交还自己证明得了的东西：还保持原样的键恢复原值（原本没有的删除），你后来改过的键报为冲突并原样保留。账本里不含密钥本身，只留一个哈希，所以「你改没改过」仍然可证。

**两份文件、两个作用**——别混淆：

| 文件 | 属于谁 | Avenic 会怎样 |
| --- | --- | --- |
| `.agents/local/<agent>/` | Account·Project 下 Agent 自己的账号家目录 | 只把 Agent 的配置根变量指过来；里面的一切由 Agent 自己的 `login` 写，Avenic 不写、不改；`deinit --purge` 默认也保留其中的登录文件（会点名），连它一起删要再加 `--purge-credentials` |
| `.claude/settings.local.json` | Claude Code 自己的项目配置 | 只在 API 模式下、且只对账本记为 Avenic 的键写入；切回 Account 不会删它，你自己写的键一个都不动 |

启动只读配置：方式与作用域决定这次运行的环境与参数，配置文件的写入只发生在 `init`、`change` 与 `<agent> auth`（以及启动时你选择 Remember 的那一次）。

### 密钥与 Git

Avenic 把下列路径写进项目 `.gitignore` 的 `# Agent Runtime` 分节：`.claude/skills/`、`.claude/settings.local.json`、`.agents/skills/`、`.agents/local/`、`.agents/tmp/`、`.agents/direct/`、`.agents/licenses/`、`.agents/api/`、`.agents/projection.json`；`.agents/sessions/` 另由 `avenic sessions git on|off` 控制（默认进 Git）。

规则只跟着它所保护的东西同进退：`deinit` 只会移除守护对象已经不存在的规则（`.agents/local/` 在目录还在时就保留——Agent 自己的登录在里面），不会出现「凭据文件还在、却已经能被 `git add`」的窗口。

### 换一种方式

`avenic change` 在收齐新答案之后、写入之前，若发现某个 Agent 换了方式，会先问一次：

```text
◆  Existing Account/API configuration detected. Keep previous configuration?
│  ▸ ◉  Keep   the previous configuration stays where it is
│    ○  Remove   delete only what Avenic wrote for the previous answer
```

默认 **Keep**：新答案照常写入，旧配置留在原地不动。选 **Remove** 会再确认一次（`Delete the previous API configuration? This cannot be undone.`），然后只删除 Avenic 能证明是自己为**这个项目**写下的东西：账本登记的键按原值归还，你后来改过的键保留并报告。旧的 Account 家目录只被点名、不会被删——里面的登录是 Agent 自己做的，证明不了是 Avenic 的；`~/.claude`、`~/.codex`、别的项目一律不碰，`.claude/settings.local.json` 也不会因为你切回 Account 就被删掉。

`avenic <agent> auth` 走同一条路口：先问旧答案，再写新答案，然后打印这个 Agent 的状态页，外加一句说明这次的方式落在磁盘的哪里。

```bash
avenic claude auth api --scope project   # 这个项目改用 API 配置，写进 .claude/settings.local.json
avenic claude auth account               # 改回由 Claude 自己登录
avenic claude auth reset                 # 清掉本机覆盖，回到项目自己的答案
avenic claude auth                       # 查看当前生效的方式与作用域
```

`auth reset` 清掉的是**本机覆盖**（`.agents/local/runtime.local.json`），项目在 `.agents/runtime.json` 里的答案随即重新生效。

### 项目还没回答方式时

还没回答方式的 Agent，普通启动会先问一次：Account（用它自己的账号登录）还是 API（用 provider/model/API 配置），再问一次可选的 `Remember for this project?`（默认 No）。Esc 取消这次启动。非终端环境（管道、CI）不问，按该 Agent 自己的账号启动并把这件事说出来。全程只读本地状态：不联网、不发起登录、不调用模型。

回答只影响**这一次启动**，除非你选了 Remember——那时它作为本机覆盖记进 `.agents/local/runtime.local.json`，不替换项目在 `.agents/runtime.json` 里的答案；`avenic <agent> status` 的 `Method source` 一行会说明这份答案来自项目配置还是本机覆盖。

认证方式与历史模式是独立的两个维度，四种组合都成立：Account + 共享历史、API + 独立历史等。

### 会话记录

- `project`（默认）：启动前把项目内的会话记录提供给 Agent，退出后把本次会话写回项目，并把本机原生存储恢复到启动前的状态。会话只更新在项目里，全局存储完全不受影响；删除项目后，会话随项目消失。
- `global`：会话直接留在 Agent 的原生全局存储，不产生项目副本。

```bash
avenic codex sessions import      # 全局会话 → 项目会话记录（复制不删除）
avenic codex sessions writeback   # 项目会话记录 → 原生存储（显式回写）
avenic codex sessions status
```

若同一会话在本机原生存储与项目内都有记录，`avenic <agent>` 启动时以项目内的会话记录为准（覆盖本机副本）。要用全局会话记录时，直接运行 `claude`（其他 Agent 同理直接运行官方 CLI）即可。

项目内的会话记录不会自动回写本机原生存储；需要回写时显式执行 `avenic <agent> sessions writeback`：原生存储中该项目的会话记录会被项目内记录覆盖；原生存储中没有该项目的会话记录时，则按 Agent 的原生目录结构创建后放入会话，效果与直接用官方 CLI 产生的会话一致。

### 运行时持久化与恢复

会话在三个层面保持持久，任何一层失效都不会丢：

1. **运行中**：后台看门狗按固定间隔增量读取当前项目的原生会话文件，只读新增的字节，随时把新内容并入共享历史。
2. **退出后**：Agent 正常退出时立即完成一次捕获。
3. **下次启动 / 再次查看**：启动或 `avenic sessions` 时补齐上一次没来得及收尾的部分。

同一项目同一 Agent 可同时启动多个 `avenic` 会话：第一个启动时保存原生存储快照，最后一个退出时回滚。看门狗是脱离终端的独立进程：直接关闭终端、关闭 VS Code、强杀 CLI 都不会影响收尾。断电或强制重启导致看门狗也没能收尾时，残留会话留在原生存储里，可手动 `avenic <agent> sessions import`，或在下次启动 `avenic` 时自动补齐。

看门狗只监视当前项目已知的原生目录，不递归扫描整个 HOME；空闲时几乎不占 CPU、不发起网络请求、不调用模型，也从不修改 Agent 的原生文件。轮询间隔可用环境变量调整：

```bash
AVENIC_WATCH_INTERVAL_MS=1000 avenic claude   # 默认 3000
```

> OpenCode 例外：其会话存储由官方 CLI 自行管理，`avenic opencode` 启动后原生存储仍保留本次运行产生的会话，不受上述回滚保护。

> 项目会话可能包含提示词、源码、命令输出、路径与密钥；仅在可信仓库中提交会话。

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
avenic skills add <owner/repo>          # 点名仓库：终端里进发现→多选，管道里装它的全部 Skill
avenic skills add <owner/repo> a b      # 点名 Skill：直接安装，不询问
avenic skills remove <skill...>         # 移除直装 Skill
```

Hub 这边则是 Pack 为单位：

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

非终端环境（管道、CI、脚本）不会卡在提示上：裸 `avenic skills` 回退为安装默认 Pack（common），`avenic skills install` 同理。

`hub add` 拉取失败不影响源保存，之后 `avenic hub sync` 重试。可反复 `add` 注册多个 Hub，同一时间生效一个（该 Hub 聚合的多个上游源共享所有 Pack）：

```bash
avenic hub select [name|spec]       # ↑/↓ 选择当前 Hub（无终端时打印列表）
avenic hub list                     # 列出已注册 Hub（> 标记当前）
avenic hub default                  # 查看当前 Hub
avenic hub sync                     # 拉取或更新缓存（~/.config/avenic/catalog/）
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
avenic hub sync                                   # 3. 验证可拉取（成功后打印 Synced · <short sha> · <时间>）
avenic skills install                                 # 4. 安装默认 Pack（common）
```

- Windows 上 HTTPS 方式默认使用 Git Credential Manager（首次自动弹窗登录）；也可以使用 SSH 地址：`avenic hub add git@github.com:<owner>/<repo>.git`
- `avenic skills add <owner/repo>` 从单个私有仓库安装 Skill，认证方式相同

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

从任意 GitHub 仓库直接安装 Skill（递归发现），锁定 commit 并保存许可证。公开仓库直接可用；私有仓库使用本机 git 认证（`gh auth login` 或 SSH）。与 Pack 管理的 Skill 重名会被拒绝。在终端里不点名 Skill 时，这条命令进入 `avenic skills` 的「发现 → 多选」流程。

## 撤回操作

| 操作 | 撤回 |
|---|---|
| `avenic init` / `avenic change` | 再跑一次 `avenic change` 改回原值；对话框里 Ctrl+C 取消则什么都没写 |
| `avenic sessions continue <id> --agent <x>` | 在 `avenic sessions` 界面里选 “Set active session” 换回原会话；或不再调用它 |
| `avenic <agent> init` | `avenic <agent> deinit`（加 `--purge` 连会话数据一起删除；Agent 自己的登录默认保留，连它一起删要再加 `--purge-credentials`） |
| `avenic <agent> auth account` / `auth api` | 执行相反设置（切换时先问 Keep/Remove，默认保留旧配置），或 `auth reset` 清掉本机覆盖 |
| `avenic <agent> auth api` 写下的配置 | `avenic change` 或 `<agent> auth` 切换时选 Remove：只交还账本登记的键，你改过的键保留 |
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
