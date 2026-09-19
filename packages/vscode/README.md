# Avenic Agent Manager

用 Avenic 在 VS Code 里管理 Claude Code、Codex 和 OpenCode。你可以初始化 Agent、管理 Skills、导入已有会话，并在三个 Agent 之间继续同一个项目会话。

## 安装

在 VS Code 的 Extensions 中搜索 **Avenic Agent Manager**。

本地安装 VSIX：

```bash
npm --prefix packages/vscode run package
code --install-extension packages/vscode/dist/avenic-agent-manager.vsix
```

安装后重新加载 VS Code，打开一个项目文件夹，再点击左侧活动栏的 **Avenic** 图标。

## 第一次使用

1. 在 **Agents** 视图找到 Claude Code、Codex 或 OpenCode。
2. 点击初始化（Init）。
3. 选择两个独立的选项：
   - **Authentication**：Global 使用电脑当前账号/配置；Project 使用当前项目配置。
   - **Sessions**：Global 使用 Agent 的全局会话；Project 使用项目 `.agents/` 会话。
4. 点击刷新，确认 Agent 显示为 Active。

认证和会话是两个不同设置。例如从“Global auth + Project sessions”切换为“Project auth + Project sessions”时，只改变认证，不会迁移或删除会话。如果项目没有 project auth，插件会提示配置，不会复制 global secret。

## Agents 视图

每一行 Agent 都会显示安装状态、版本和安装来源。右键 Agent 可以：

- **Initialize / Deinitialize**：初始化或移除 Avenic 项目配置；
- **Change Authentication**：切换 Global/Project auth；
- **Change Session Storage**：切换 Global/Project sessions；
- **Import Sessions**：导入该 Agent 已有的原生历史；
- **Writeback / Sync**：把项目 portable 会话显式写回原生存储；
- **Launch**：使用当前认证和会话设置启动 Agent；
- **Update**：按当前实际安装来源更新 Agent。

Avenic 不会改变 Claude 的 DeepSeek/API/cc-switch 配置、Codex 登录状态或 OpenCode provider。

## 共享会话

Avenic 会把共享历史保存为 canonical session。Claude、Codex、OpenCode 的原生会话只是可恢复的投影；因此删除某个原生 session 不会删除共享历史。

### 导入已有历史

在 Agents 视图右键 Agent，选择 **Import Sessions**。插件会根据原生会话中的项目路径和 cwd 匹配当前工作区，而不是只猜目录名。重复导入不会产生重复会话。

### 查看会话状态

打开 **Overview** 或 Sessions 状态，可查看：

- canonical session ID、标题和更新时间；
- Claude/Codex/OpenCode 的 native mapping；
- 每个 Agent 的同步游标；
- synced、stale、missing 或 conflict 状态；
- 当前项目 active session。

### 阅读共享对话

打开 **Avenic: Sessions**（Agents 视图标题栏的 Sessions 按钮，或命令面板），或从 Overview 里点 **Sessions**。这一页读的就是 `avenic sessions show <id>` 读的那份共享对话，字段和措辞都来自同一处：

- 每一轮一行，说话人是 **You** / **Claude** / **Codex** / **OpenCode**，带时间和模型；
- 工具调用与结果挂在跑它的那一轮下面，显示为暗色的一行；
- 顶部是会话摘要：ID、事件数、轮数，以及每个 Agent 从哪条原生会话回答、游标是 **current** 还是 **stale**；
- 左侧列表切换会话，`▸` 是正在读的，`◉` 是新启动会加入的 active session；
- 长对话默认只显示最新的一段，说明省略了多少轮，并可以一键展开全部。

这一页只读：它不会写 canonical history，也不会触发写回。

### 在 Agent 之间继续

从共享会话操作中选择：

- **Continue with Claude**
- **Continue with Codex**
- **Continue with OpenCode**

插件会先捕获其他 Agent 尚未同步的消息，再把新增 delta 交给目标 Agent。界面会显示这是 Bootstrap 还是 Resume，以及新增了多少条上下文。

如果原生 session 被删除，Avenic 会从 canonical history 自动重新创建投影；不会用旧历史覆盖新历史。即使 VS Code 或终端被直接关闭，下次启动也会执行 recovery reconciliation。

## Hub 与 Skills

### Hub

1. 打开 **Hub** 视图。
2. 点击 **Add Hub**，输入 GitHub `owner/repo`、URL 或本地路径。
3. 选择默认 Hub。
4. 需要网络同步时明确点击 **Sync**。

缓存存在时列表会立即显示；cache miss 不会偷偷联网。

### Skills

在 **Skills** 视图可以：

- 浏览 Project/Global 已安装 Skills；
- 安装或卸载 Pack；
- 添加 Direct Skill；
- Adopt 磁盘上已有但尚未登记的 Skill；
- Repair Links 修复缺失的共享链接。

项目中的 `.agents/skills/` 是 canonical 文件；Claude 等 Agent 目录通常是链接或安全回退副本。插件不会覆盖用户拥有的外部链接。

## 模型配置

从 Agents 视图打开 **Model Configuration**：

1. 创建或选择 profile；
2. 填写 endpoint、API 类型和模型；
3. 保存后点击 **Test Connection**；
4. 使用 **Use for this project** 绑定当前项目。

密钥只以掩码显示。共享会话不会替你选择模型，也不会覆盖 Agent 自己的 provider 解析。

## 常见问题

**Agent 显示未安装**：安装官方 CLI 后点击刷新，或使用 Install 操作。

**选择 Project auth 失败**：先为当前项目配置 project auth；插件不会复制 global 凭据。

**会话显示 stale/missing**：点击 Continue 或 Sync，Avenic 会从 canonical history 恢复。

**Hub 没有内容**：使用 Add Hub 或明确 Sync；没有缓存不是会话错误。

需要更详细诊断时，在终端执行 `avenic sessions status` 或 `avenic doctor`。请不要分享 API key、token 或完整真实 transcript。

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
