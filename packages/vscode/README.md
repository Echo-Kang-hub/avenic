# Avenic Agent Manager

用 Avenic 在 VS Code 里管理 Claude Code、Codex 和 OpenCode。你可以配置这个项目里各 Agent 的 Authentication 与 Sessions、管理 Skills、导入已有会话，并让三个 Agent 共用同一份项目历史。

## 安装

在 VS Code 的 Extensions 中搜索 **Avenic Agent Manager**。

本地安装 VSIX：

```bash
npm --prefix packages/vscode run package
code --install-extension packages/vscode/dist/avenic-agent-manager.vsix
```

安装后重新加载 VS Code，打开一个项目文件夹，再点击左侧活动栏的 **Avenic** 图标。

## Dashboard

活动栏的 **Avenic** 图标打开 Dashboard——一个窗口，左侧是固定的分区导航，右侧是这个项目的实时状态。所有内容都来自 Core 对当前项目的真实读取，没有一处是写死的示例数据；读不到就显示读不到，不猜。

顶栏是这个项目本身：项目名、真实根路径、**Avenic Configured**（或 **Not Configured**）、上次更新时间，以及 **Refresh** 和 **Reconfigure** 两个按钮。**Refresh** 重新读一遍项目；读取超过半秒时内容上方出现一行「Reading the project…」，它只是告诉你还在读，不会把已经画好的内容清掉。

左侧导航的六个分区：

- **Overview**：三列 Agent 卡片、Shared Sessions 与 Agent Sessions、Skills、Quick Actions、Recent Activity——下面几节按卡片讲。
- **Configure** 和 **Agents**：三张 Agent 卡片本身——这个项目里每个 Agent 的全部字段和入口，Configure 是从配置进入，Agents 是从「这个 Agent 现在怎么样」进入。
- **Sessions**：一个两栏的浏览器，占满整个内容区。左栏顶上在 **Shared** 与 **Agent** 之间切换，下面是一个按标题和元数据过滤的搜索框与一列会话行（参与者、相对时间、正在跑或没对上的标记），右栏读你点开的那一条：标题、参与者、更新时间、事件数、同步状态，**Continue**，以及 **⋯** 里的 **Raw** 和 **Diagnostics**。读到一半来了新消息就地在下面接上；往下翻说明你不在底部，那时屏幕下沿给一条 **New messages ↓**。列表和对话各自滚动，页面本身不滚。
- **Skills**：全部 Skill 与 Skill 来源。
- **Quick Actions**：新建会话、继续共享会话、管理 Skills、查看日志。

底部两行打开编辑器里的打包 README（**Documentation**）和本插件设置（**Settings**）；再下面是 `Avenic v<版本>` 和状态灯。

### Agent 卡片

Claude Code、Codex、OpenCode 各一张卡。每张卡列出 Core 真能答出来的字段——Authentication、Config Source / Account Scope、Provider、Model、Account Status——答不出来的字段就不画。**Launch** 按这个项目当前的 Authentication 与 Sessions 设置启动，终端开在项目根目录；**Change** 打开配置向导。

卡片上的每个字段就是 `avenic status` 的同一批行，因为两边读的是 Core 的同一处：`Authentication` 那一行把答案和**它自己的**作用域写在一起（`API (Project)`、`Account (Global)`），OpenCode 写 `Native (OpenCode UI)`。provider、模型、凭据全部由 OpenCode 自己管，Avenic 不读也不写。

### 会话卡片

**Shared Sessions** 是跨 Agent 共用的 canonical 历史，**Agent Sessions** 是各 Agent 自己那份原生会话，用标签页按 Agent 切换；**Agent Sessions 是 Agent 自己的 CLI 能打开的那些会话，Session Storage 是 Avenic 在这个项目里留的副本**，两件事。标题取 Agent 自己写的摘要，其次才是首条消息或短 id——永远不是一串 UUID。**Continue** 从当前这一半续上一条会话（Shared 走共享历史，Agent 走那个 Agent 的原生会话）。

### Skills 卡片

三个来源分开列：**Installed**、**Available Packs**、**Official Registry**。**Import Skill** 用 `owner/repo` 导入，**Open Folder** 直接打开 Skill 目录。

### Quick Actions

六个按钮，和卡片里的入口是同一批动作：三个 Agent 各一个新建会话、继续最近的共享会话、管理 Skills、查看日志。Core 说不能启动的 Agent，这里同样是禁用的。

## 第一次使用

1. 打开 Dashboard（活动栏的 **Avenic** 图标）。未配置的项目会直接显示 **Initialize Avenic**。
2. 点 **Reconfigure**，或执行 **Avenic: Configure Project**。
3. 一场问答走完配置，问题与顺序和 `avenic init` / `avenic change` 完全一致：
   - **Select agents**：勾选要在这个项目里启用的 Agent；
   - 每个 Agent 的 **Authentication**：**Account** 用 Agent 自己的账号登录，**API** 让 Avenic 把该 Agent 自己读的配置文件准备好；
   - **Account** 接着选 **Account Scope**（Global 用这台机器本就有的登录，Project 用项目自己的 home）；**API** 接着选 **Configuration Scope**——Avenic 只是把那个位置准备好（不在就建一个空的），**provider、模型、凭据都由你自己填进这份文件**；
   - 每个 Agent 的 **Sessions**：会话存 Global，还是项目自己的 `.agents/sessions`；
   - **History**：Shared 还是 Isolated；
   - 换了答案、而旧答案还留在磁盘上时多问两句：**What should Avenic do?**（默认 Keep）与 **Remove old configuration? This cannot be undone.**（选了 Remove 才会出现，默认 No）；
   - **Apply configuration?** 选 Yes 才写盘。
4. 已答的步骤折叠在当前问题上方——`◇ 标题` 下面跟着 `│ 标签 值` 的行；Back 返回上一步，Esc 全程什么都不写。
5. 回到 Dashboard 点 **Refresh**，顶栏变成 **Avenic Configured**。

配过的项目再执行同一条命令就是修改：第一步变成 **Select enabled agents**，各步预选当前值。OpenCode 只被问 Sessions，它的 Authentication 是 `Native (OpenCode UI)`——认证和 provider 由它自己管。

## Avenic 视图（活动栏的列表）

活动栏里还有一个轻量列表，和 Dashboard 是同一个项目的两个视图，动作一致：

- **Configure Project**：初始化或修改这个项目的配置；
- **启动 Agent**：按项目当前的 Authentication 与 Sessions 设置启动，终端开在项目根目录；
- **导入会话**：导入该 Agent 已有的原生历史；
- **写回会话**：把项目 portable 会话显式写回原生存储；
- **安装 Agent CLI** / **升级 Agent CLI**：在集成终端里用 npm 装或升级官方 CLI；检测到手工安装或来源未知时不会去动它；
- **移除 Agent**：移除 Avenic 为这个项目写的配置。

Avenic 只在 API 答案下动配置文件，而且只在它不在时创建一份空的——**从不往里写** provider、模型或凭据，也从不在之后的 Configure 里回填或改写它；Account 下它更不写账号文件——Agent 自己的登录、Claude 的 DeepSeek/cc-switch 之类外部配置、OpenCode 的 provider，都由 Agent 自己管。

## 共享会话

Avenic 会把共享历史保存为 canonical session。Claude、Codex、OpenCode 的原生会话只是可恢复的投影；因此删除某个原生 session 不会删除共享历史。

### 导入已有历史

用命令 **Avenic: Import Sessions** 选择 Agent，导入它已有的原生历史。插件会根据原生会话中的项目路径和 cwd 匹配当前工作区，而不是只猜目录名。重复导入不会产生重复会话。

### 查看会话状态

在 Dashboard 的 **Sessions** 分区（活动栏 Avenic 列表里的 **Sessions** 也直接落在这里）可以看到：

- 左栏顶上在 **Shared** 与 **Agent** 之间切换，下面的搜索框按标题和元数据过滤（在面板里过滤，不问宿主）；
- 会话行的标题、参与者、相对时间和当前状态——正在跑的、没和共享历史对上账的、以及就是 active 的那一条；
- 每条原生会话属于哪个 Agent，以及它同步到哪一步——面板上写作「已同步」「投射落后于共享历史」等；
- 当前项目的 active session，也就是不带 id 启动时会接上的那一条。

### 阅读共享对话

打开 Dashboard 的 **Sessions** 分区（命令 **Avenic: Sessions** 也直接落在这里），点左栏里的任意一条：右栏读的就是 `avenic sessions show <id>` 读的那份对话，内容和措辞都来自同一处：

- 每一轮一段，说话人是 **You** / **Claude** / **Codex** / **OpenCode**；
- Agent 跑过的工具不是一个说话人：它折在发起它的那一轮下面，写成一行 `ran Read(...)`；
- 头部四格是这条会话的参与者、更新时间、事件数和同步状态；**⋯** 里是 **Raw**（收到的轮次原样）与 **Diagnostics**（这条会话的投影说过什么）；
- 一次画最新的 100 轮，往上滚到顶再往前接；
- 不是 active 的会话上有一个 **Set as Active**（只在 Shared history 模式下），把它设成不带 id 启动时接上的那一条。

这一页只读：它不会写 canonical history，也不会触发写回。

### 在 Agent 之间继续

继续某一条共享会话由 CLI 完成：`avenic sessions continue <id> --agent <claude|codex|opencode>`（项目必须已是 Shared history）。它会先捕获其他 Agent 尚未同步的消息，再把新增 delta 交给目标 Agent，并说明这次是 `resume` 还是 `bootstrap`、给了它多少上下文。

插件里的 **启动 Agent** 是普通启动：终端开在项目根目录，用的就是项目当前的 Authentication 与 Sessions 设置。

如果原生 session 被删除，Avenic 会从 canonical history 自动重新创建投影；不会用旧历史覆盖新历史。即使 VS Code 或终端被直接关闭，下次启动也会执行 recovery reconciliation。

## Hub 与 Skills

### Hub

1. 打开 Dashboard 的 **Skills** 卡片，切到 **Official Registry**。
2. 用命令 **Avenic: Add Hub** 添加 GitHub `owner/repo`、URL 或本地路径，并选默认 Hub。
3. 需要网络同步时明确点击 **Sync**（已经同步过就是 **Sync again**）。

缓存存在时列表会立即显示；cache miss 不会偷偷联网。

### Skills

在 **Skills** 卡片（或命令面板的 **Avenic: Skills** 系列命令）可以：

- 浏览 Project/Global 已安装 Skills，分 **Installed** / **Available Packs** / **Official Registry** 三个来源；
- 用 **Import Skill** 按 `owner/repo` 导入一个 Skill，**Open Folder** 打开 Skill 目录；
- 安装或卸载 Pack；
- 添加 Direct Skill；
- Adopt 磁盘上已有但尚未登记的 Skill；
- Repair Links 修复缺失的共享链接。

项目中的 `.agents/skills/` 是 canonical 文件；Claude 等 Agent 目录通常是链接或安全回退副本。插件不会覆盖用户拥有的外部链接。

## Authentication：Account 还是 API

**Account** 用 Agent 自己的账号登录，插件不配置任何模型。`Global` 用这台机器本就有的登录；`Project` 把 Agent 自己的配置根变量（`CLAUDE_CONFIG_DIR` / `CODEX_HOME`）指向 `<项目>/.agents/local/<agent>`，登录由 Agent 自己写在那里，工作目录仍是项目根，`~/.claude` / `~/.codex` 不会被碰。

**API** 是「Avenic 把这个 Agent 自己读的配置文件准备好」，不是替你配置 provider：

- Claude 的 `Project` 作用域是项目自己的 `.claude/settings.local.json`；`Global` 是 `$CLAUDE_CONFIG_DIR` 或 `~/.claude` 下的 `settings.json`；
- Codex 的 `Project` 作用域是 `.agents/local/codex/config.toml`（启动时用 `CODEX_HOME` 指过去）；`Global` 是 `$CODEX_HOME` 或 `~/.codex` 下的 `config.toml`；
- 文件不在，Avenic 按该 Agent 自己的格式建一个最小的（JSON 是 `{}`，TOML 是空文件，权限 0600）；文件已经在，**一个字节都不动**。provider、endpoint、模型、凭据都由你自己写进这份文件，插件不写、不改、也不回填；
- 再跑一次 Configure Project 也不会改写它：里面的内容只有你自己会动。

状态行把答案和**它自己的**作用域一起说，Dashboard 与 `avenic status` 逐字相同（两边取自 Core 的同一处措辞）：

- Account：`Account Scope` 给出 home 在哪——例如 `Project (.agents/local/claude)`；`Account Status` 给出 `Signed in` / `Not signed in` / `Unknown`（macOS 上 Claude 的凭据在 keychain 里，读不到就是 `Unknown`，绝不探测，也从不打印凭据）；
- API：`Config Source` 给出哪个文件带着这份答案——例如 `.claude/settings.local.json (nothing in it yet)`（文件在、内容还是空的），还没建过则是 `(missing)`；文件里写了什么，就按 `Provider`、`Model` 读回来，没有的字段不画。

换答案时旧配置默认保留。要删就得显式选 Remove，并在第二个问题（`Remove old configuration?`，默认 No）上再答一次：删的只可能是 Avenic 在账本里记着、而且此后一个字节都没动过的那份文件——全局账号、别的项目、以及仅仅因为切到 Account 就要删 `.claude/settings.local.json`，都不会发生。

OpenCode 只被问 Sessions；它的 Authentication 是 `Native (OpenCode UI)`——启动它直接进 OpenCode 自己的流程，任何地方都没有它的认证或 provider 步骤。

## 常见问题

**Agent 显示未安装**：安装官方 CLI 后点击刷新，或使用 **安装 Agent CLI**。

**Agent 显示未初始化**：先执行 **Avenic: Configure Project**；它是配置项目的唯一入口，插件不会替你复制凭据。

**状态里写着 `nothing in it yet`**：API 那一问已经把配置文件准备好、只是里面还没有内容。打开那个文件，把 provider、模型、凭据写进去，再点 **Refresh**。

**登录状态未知**：Avenic 读的是 Agent 自己的凭据文件，读不出来就报未知、绝不探测——macOS 上 Claude 的凭据在 keychain 里，就是这样。

**会话显示 stale/missing**：`avenic sessions continue <id> --agent <agent>` 会从共享历史把它续上或重建；`missing` 也可能只是这个 Agent 还没有副本，`avenic sessions sync` 会导入原生历史。

**Hub 没有内容**：使用 Add Hub 或明确 Sync；没有缓存不是会话错误。

需要更详细诊断时，在终端执行 `avenic status` 或 `avenic sessions status`。请不要分享 API key、token 或完整真实 transcript。

## 支持级别

| Agent | 支持 |
|---|---|
| Claude Code | L3a：基于 handoff 和增量上下文继续 |
| Codex | L3a：基于官方 resume/thread 路径继续 |
| OpenCode | L3：基于官方 import/export/session 路径继续 |

## 开发与测试

```bash
npm --prefix packages/vscode run typecheck
npm --prefix packages/vscode test
npm --prefix packages/vscode run package
```

VS Code 插件只负责界面和命令转发；会话、Authentication/作用域、路径匹配和恢复逻辑全部由 Avenic Core 提供。

## License

[MIT](./LICENSE)
