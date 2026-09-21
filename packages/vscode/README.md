# Avenic Agent Manager

用 Avenic 在 VS Code 里管理 Claude Code、Codex 和 OpenCode。你可以配置这个项目里各 Agent 的认证与会话、管理 Skills、导入已有会话，并让三个 Agent 共用同一份项目历史。

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

- **Overview**：三列 Agent 卡片、Shared Sessions 与 Project Sessions、Skills、Quick Actions、Recent Activity——下面几节按卡片讲。
- **Configure** 和 **Agents**：三张 Agent 卡片本身——这个项目里每个 Agent 的全部字段和入口，Configure 是从配置进入，Agents 是从「这个 Agent 现在怎么样」进入。
- **Sessions**：共享会话与各 Agent 原生会话的完整列表。
- **Skills**：全部 Skill 与 Skill 来源。
- **Quick Actions**：新建会话、继续共享会话、管理 Skills、查看日志。

底部两行打开编辑器里的打包 README（**Documentation**）和本插件设置（**Settings**）；再下面是 `Avenic v<版本>` 和状态灯。

### Agent 卡片

Claude Code、Codex、OpenCode 各一张卡。每张卡列出 Core 真能答出来的字段——认证方法、配置来源、provider、模型、账号状态——答不出来的字段就不画。**Launch** 按这个项目当前的认证和会话设置启动，终端开在项目根目录；**Change** 打开配置向导。字段上的徽章就是 `avenic status` 的措辞：认证同时说出方法和作用域。

OpenCode 的卡片只写它的认证：provider、模型、凭据全部由 OpenCode 自己管，Avenic 不读也不写。

### 会话卡片

**Shared Sessions** 是跨 Agent 共用的 canonical 历史，**Project Sessions** 是这个项目里各 Agent 的原生会话，用标签页按 Agent 切换。标题取 Agent 自己写的摘要，其次才是首条消息或短 id——永远不是一串 UUID。**Continue** 从共享历史续上一条会话。

### Skills 卡片

三个来源分开列：**Installed**、**Available Packs**、**Official Registry**。**Import Skill** 用 `owner/repo` 导入，**Open Folder** 直接打开 Skill 目录。

### Quick Actions

六个按钮，和卡片里的入口是同一批动作：三个 Agent 各一个新建会话、继续最近的共享会话、管理 Skills、查看日志。Core 说不能启动的 Agent，这里同样是禁用的。

## 第一次使用

1. 打开 Dashboard（活动栏的 **Avenic** 图标）。未配置的项目会直接显示 **Initialize Avenic**。
2. 点 **Reconfigure**，或执行 **Avenic: Configure Project**。
3. 一场问答走完配置，问题与顺序和 `avenic init` / `avenic change` 完全一致：
   - **Select agents**：勾选要在这个项目里启用的 Agent；
   - 每个 Agent 的 **Authentication**：**Account** 用 Agent 自己的账号登录，**API** 用 provider/model/API 配置；
   - **Account** 接着选作用域（Global 用本机账号，Project 用项目自己的 home）；**API** 接着填 provider、Base URL、模型、凭据，并选这份配置写在哪；
   - 每个 Agent 的 **Sessions**：会话存 Global，还是项目自己的 `.agents/sessions`；
   - **Session history**：Shared 还是 Isolated；
   - 方法改过时多问一句 **Keep previous configuration?**（默认 Keep）；
   - **Apply configuration?** 选 Yes 才写盘。
4. 已答的步骤折叠在当前问题上方（`◇ 标题 — 答案`），Back 返回上一步，Esc 全程什么都不写。
5. 回到 Dashboard 点 **Refresh**，顶栏变成 **Avenic Configured**。

配过的项目再执行同一条命令就是修改：第一步变成 **Select enabled agents**，各步预选当前值。OpenCode 只被问会话，认证和 provider 由它自己管。

## Avenic 视图（活动栏的列表）

活动栏里还有一个轻量列表，和 Dashboard 是同一个项目的两个视图，动作一致：

- **Configure Project**：初始化或修改这个项目的配置；
- **启动 Agent**：按项目当前的认证和会话设置启动，终端开在项目根目录；
- **导入会话**：导入该 Agent 已有的原生历史；
- **写回会话**：把项目 portable 会话显式写回原生存储；
- **安装 Agent CLI** / **升级 Agent CLI**：在集成终端里用 npm 装或升级官方 CLI；检测到手工安装或来源未知时不会去动它；
- **移除 Agent**：移除 Avenic 为这个项目写的配置。

Avenic 只在 API 方法下写配置，而且只写它自己写过的键；Account 下它不写账号文件——Agent 自己的登录、Claude 的 DeepSeek/cc-switch 之类外部配置、OpenCode 的 provider，都由 Agent 自己管。

## 共享会话

Avenic 会把共享历史保存为 canonical session。Claude、Codex、OpenCode 的原生会话只是可恢复的投影；因此删除某个原生 session 不会删除共享历史。

### 导入已有历史

用命令 **Avenic: Import Sessions** 选择 Agent，导入它已有的原生历史。插件会根据原生会话中的项目路径和 cwd 匹配当前工作区，而不是只猜目录名。重复导入不会产生重复会话。

### 查看会话状态

在 Dashboard 的 **Sessions** 分区（活动栏 Avenic 列表里的 **Sessions** 也直接落在这里）可以看到：

- 共享会话与各 Agent 原生会话的标题、时间和当前状态；
- 每条原生会话属于哪个 Agent，以及它同步到哪一步——面板上写作「已同步」「投射落后于共享历史」等；
- 当前项目的 active session，也就是不带 id 启动时会接上的那一条。

### 阅读共享对话

打开 Dashboard 的 **Sessions** 分区（命令 **Avenic: Sessions** 也直接落在这里）。最上面的卡片读的就是 `avenic sessions show <id>` 读的那份共享对话，内容和措辞都来自同一处：

- 每一轮一段，说话人是 **You** / **Claude** / **Codex** / **OpenCode**；
- 卡片标题是这条会话的标题，副标题说明它是一份所有 Agent 都看得见的共享历史；
- 不是 active 的会话上有一个 **Set as Active**，把它设成不带 id 启动时接上的那一条。

这一页只读：它不会写 canonical history，也不会触发写回。

### 在 Agent 之间继续

继续某一条共享会话由 CLI 完成：`avenic sessions continue <id> --agent <claude|codex|opencode>`（项目必须已是 Shared history）。它会先捕获其他 Agent 尚未同步的消息，再把新增 delta 交给目标 Agent，并说明这次是 `resume` 还是 `bootstrap`、给了它多少上下文。

插件里的 **启动 Agent** 是普通启动：终端开在项目根目录，运行时用的就是项目当前的认证和会话设置。

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

## 认证：Account 还是 API

**Account** 用 Agent 自己的账号登录，插件不配置任何模型。Global 用电脑当前的账号；Project 把 Agent 自己的配置根变量（`CLAUDE_CONFIG_DIR` / `CODEX_HOME`）指向 `<项目>/.agents/local/<agent>`，登录由 Agent 自己写在那里，工作目录仍是项目根，`~/.claude` / `~/.codex` 不会被碰。

**API** 由项目拥有 provider、endpoint、模型和凭据：

- Claude 的项目作用域写项目自己的 `.claude/settings.local.json`，逐键写入，用户原有的键照旧保留；
- Codex 没有自己的项目配置文件，项目答案存在 `.agents/api/codex.json`，启动那一次作为 `-c` 参数交给它；
- 凭据只以掩码或「已设置 / 未设置」出现，从不打印；Codex 那一问填的是它要读的环境变量名，Avenic 不存 key 本身；
- 再跑一次 Configure Project 时问题是回填的：provider、endpoint、模型按已经写下的值预填，凭据框留空，而空着就是「保持原来那个」——一路确认不改动任何东西。

状态行把方法和作用域一起说：

- Account：home 在哪、有没有登录过——例如 `认证 Account · 项目（.agents/local/claude）`，没登录过缀 `· 未登录`；只有确实读不出来时才报 `· 登录状态未知`（macOS 上 Claude 的凭据在 keychain 里，正是这种情况），绝不探测；
- API：哪个文件带着这份配置、选了哪个 provider 和模型——例如 `认证 API · 项目（.claude/settings.local.json · provider / model）`；Avenic 还没写过就是 `尚未写入`。

Dashboard 和 `avenic status` 说同一句话，因为两边取自 core 的同一处措辞。

切换方法时旧配置默认保留。要删就得显式选 Remove：新配置写完之后再确认一次，删的只可能是 Avenic 能证明是自己为这个项目写下的键——全局账号、别的项目、以及仅仅因为切到 Account 就要删 `.claude/settings.local.json`，都不会发生。

OpenCode 只被问会话；启动它直接进 OpenCode 自己的流程，任何地方都没有它的认证或 provider 步骤。

## 常见问题

**Agent 显示未安装**：安装官方 CLI 后点击刷新，或使用 **安装 Agent CLI**。

**Agent 显示未初始化**：先执行 **Avenic: Configure Project**；它是配置项目的唯一入口，插件不会替你复制凭据。

**状态里写着「尚未写入」**：API 方法下 Avenic 还没有写过这份配置，重跑一次 Configure Project 填好即可。

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

VS Code 插件只负责界面和命令转发；会话、认证作用域、路径匹配和恢复逻辑全部由 Avenic Core 提供。

## License

[MIT](./LICENSE)
