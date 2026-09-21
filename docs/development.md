# Avenic CLI 开发指南

面向贡献者：仓库结构、开发、测试、打包与发布。

## 结构

```text
packages/core/                 平台无关核心库（runtime、sessions、skills、catalog、direct）；npm 包 @avenic/core
packages/cli/                  命令行层（dispatcher、skills-cli、self-update）；npm 包 avenic
packages/cli/vendor/core-src/  packages/core/src 的同步副本（提交进 git，发布时随包）
integration/                   全局安装集成测试（registry 包 + GitHub 根包双模式）
test/                          单元与 fixture 测试（catalog 用例全部本地 git fixture，不联网）
docs/superpowers/              设计 spec 与实施 plan
```

根 package.json 内部名 `avenic-repo`（GitHub 根安装模式的直接安装物）。测试只有根一套：`packages/core` 与 `packages/cli` 自身没有 `test` 脚本（在包目录里直接 `npm test` 会报 missing script），在仓库根跑 `npm test` 即可，它同时覆盖这两个包。

## 开发

```bash
npm install
npm test               # node --test；pretest 自动同步 vendor core
npm run test:install   # 双模式全局安装集成测试
npm run pack:cli       # npm pack --dry-run
npm run sync-core      # 手动同步 packages/core/src → packages/cli/vendor/core-src
npm run perf           # 两条真实等待路径的端到端 + 分步计时
npm run test:visual    # 看板视觉回归（headless Edge + 参考图对比），仅 Windows
npm run test:host      # 真实 VS Code 扩展宿主检查（会打开窗口），仅 Windows 桌面会话
```

## 性能

`npm run perf` 在临时目录里造fixture（默认 40 个 Claude 会话 × 400 条记录、120 个 Codex rollout，外加 60 个其它 workspace 的历史），依次跑真实 CLI 并分步计时；`--json` 输出机器可读结果，`--keep` 保留 fixture 便于复测。规模用环境变量缩放：`CLAUDE_SESSIONS`、`CLAUDE_RECORDS`、`CODEX_ROLLOUTS`。

它衡量的是用户真正等待的两条路径，而不是"有缓存所以应该很快"：

- **启动**（`avenic claude|codex|opencode`）：用户按下回车到官方 TUI 出现。此路径不读 canonical、不扫历史、不联网。
- **退出与恢复**：agent 退出后的捕获/导入，以及 `recoverSharedNativeSessions` 与各 adapter 的分步耗时。

failing 预算由测试持有，不放在这个工具里：`test/launch-latency.test.mjs` 守着启动路径（预算宽松，防的是整段历史工作回到启动路径），`test/incremental-capture.test.mjs` 与 `test/session-adapter-contract.test.mjs` 守着"重复比较同一对路径不再访问文件系统"这条契约。分步耗时随机器规模变化的只有 discovery：它要读本机每个 Claude 会话的开头来判定归属，因此 `observeSharedNativeSessions` 的首次调用在大机器上比后续调用贵，运行中的 watchdog 用 `knownOnly` 跳过重扫。

## 打包约束（重要）

根 package.json **不带 `workspaces` 字段，也没有任何 install 生命周期脚本**（postinstall/build/preinstall/install/prepack/prepare）：npm 11 对 git 简写安装会把 node_modules 链接到 pacote 解包临时目录，`workspaces` 或这些脚本会让 pacote 在该目录里再跑一次嵌套 `npm install`（pacote git.js `#prepareDir`），Windows 上嵌套 reify 与全局安装竞争会把解包目录改残（bin 报 MODULE_NOT_FOUND）。本包零运行时依赖，不需要嵌套安装；`test/packaging.test.mjs` 守护此约束。

CLI 通过 package.json `imports`（`#core` → `./vendor/core-src/index.mjs`）引用 core——相对 vendor 路径在「GitHub 根安装」与「registry tarball 安装」两种模式下都成立。改 core 后必须 `npm run sync-core`（pretest/prepack 会自动执行，测试 `test/sync.test.mjs` 守护一致性）。

## 发布

```bash
npm login   # 已登录则跳过
# 提升 packages/cli/package.json（及 packages/core/package.json、根 package.json）的 version
cd packages/cli && npm publish
```

- `avenic.packageSpec` 保持 `avenic@latest`（`avenic self-update` 自更新源）。
- registry 包 `private` 保持 `false`。
- 发布物是 `packages/cli`（包名 `avenic`）与 `packages/core`（包名 `@avenic/core`）。
- 发布顺序：core 变更 → bump 并发布 core → `npm run sync-core` → bump 并发布 CLI。提交与 tag 里的 `vendor/core-src` 必须与 core 同步（`test/sync.test.mjs` 守护一致性）；pack/publish 时 `prepack` 会自动执行 `sync-core`，所以 tarball 里的镜像总是新的。
- 顺序约束：core 变更后必须先 `npm run sync-core` 再发布 CLI。

### VS Code 插件

插件把 core 打包进 `dist/extension.js`：`devDependencies` 里 `@avenic/core` 指向 `file:../core`，esbuild 在构建时内联，因此 VSIX 里的 core 与 CLI 同源同版本，不需要等 core 先发到 registry。

```bash
npm --prefix packages/vscode run typecheck
npm --prefix packages/vscode test                 # typecheck + 构建测试
npm --prefix packages/vscode run package          # → packages/vscode/dist/avenic-agent-manager.vsix
```

`vsce package` 产出的 VSIX 需人工上传 Marketplace（VSCE_PAT 由维护者持有，不进入仓库）。上传前先在真实 VS Code 里安装该 VSIX，走一遍 Initialize、Configure、Launch、Sessions、Hub Sync 以及 Shared/Isolated 两种模式。

### 看板的视觉与主机回归（仅 Windows）

看板有两条发布闸门，都不在 CI 里——它们跑不了 ubuntu runner：

- `npm run test:visual`（`packages/vscode/test/visual/`）：用真实媒体文件在 headless Edge 里渲染，做 overview 截图、与参考图的几何边对比，以及 22 个场景矩阵。Edge 从 Windows 安装路径解析（`shot.mjs` 的 `EDGE_CANDIDATES`）。
- `npm run test:host`（`packages/vscode/test/host/run.mjs`）：把 VSIX 装进干净 profile，在真实 VS Code 扩展宿主里打开仪表盘，并用 PowerShell `CopyFromScreen` 读屏取证。它会打开一个 topmost、不抢键盘焦点的窗口，需要桌面会话。

```bash
npm run release:gate   # release:pack → release:verify → test:vscode → test:visual → test:host
```

`release:gate` 的最后一步会打开窗口，所以它只在 Windows 桌面会话里手动执行，不放进 `npm test`，也不加进 CI；只要无窗口的部分，就按同样的顺序逐条跑到 `test:visual` 为止。

## core 发布纪律

core 变更 → bump `packages/core/package.json` 版本 → `cd packages/core && npm publish`（由维护者执行）→ CLI `npm run sync-core` 照旧（**发布 CLI 前必须先同步**）。插件（`packages/vscode`）依赖**已发布**的 `@avenic/core`，故插件改动排在 core 发布之后。

## Hub 仓库

私有 Hub 仓库是纯数据仓库：`skills/`、`packs/`、`sources.lock.json`、`licenses/`，加每日 CI（auto-update-skills.yml，从 registry 安装 CLI 后运行 `avenic hub update` + `avenic hub doctor` 并提交）。不得再分发的第三方 Skills 只允许存在于该私有仓库，不进入本公开仓库。
