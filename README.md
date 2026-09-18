# Avenic

一个命令统一管理编码 Agent（Claude Code、Codex、OpenCode）的运行时配置、会话历史与 Skills，支持 Windows、macOS 和 Linux。

```bash
npm install -g avenic@latest

cd <你的项目>
avenic init          # 交互式配置：Agent、认证、会话存储、历史模式
avenic claude        # 进入 Claude Code；codex / opencode 同理
avenic sessions      # 查看与管理共享会话
avenic change        # 随时改配置
```

安装提供两个等价命令：`avenic` 与简写 `ave`。要求 Node.js ≥ 18.17。

**完整文档见 [packages/cli/README.md](packages/cli/README.md)**，也可运行 `avenic --help`。npm 页面上的文档即该文件。

## 仓库结构

| 路径 | 内容 |
|---|---|
| [packages/core](packages/core) | `@avenic/core`：运行时配置、canonical 会话存储、原生适配器、Hub 目录。全部逻辑都在这里 |
| [packages/cli](packages/cli) | `avenic`：命令行入口、交互式 TUI、看门狗进程 |
| [packages/vscode](packages/vscode) | `avenic-agent-manager`：VS Code 插件，只做界面，不重复实现 core 逻辑 |

CLI 通过 `vendor/core-src/` 内联 core 源码，因此改动 core 后必须运行 `npm run sync-core`（`npm test` 的 pretest 会自动执行）。

## 开发者

构建、测试与发布流程见 [docs/development.md](docs/development.md)。

## License

[MIT](LICENSE)
