# Changelog

## 0.5.1

- The Sessions and dashboard pages now wear the product's own brand: the
  red-orange `--avenic-brand` tokens replace the old cyan, so the panel, the
  terminal and the wordmark are recognisably one product. Green is still what
  marks "active" and "current", yellow warns, red is an error, and every other
  colour still comes from the editor's own theme, so light, dark and
  high-contrast themes stay readable. The page still loads no remote content and
  sets no user data as HTML.

## 0.5.0

- Added a Sessions page: the shared conversation, read in the editor. It is the
  same transcript `avenic sessions show <id> --json` prints — one model out of
  core, so the panel and the terminal cannot show different histories — drawn
  as a timeline where every turn carries its own speaker (`You`, `Claude`,
  `Codex`), the model that answered, and the tool calls that turn ran.
- The Sessions page lists the project's shared sessions beside the
  conversation, marking which one you are reading (`▸`) and which one new
  launches would join (`◉`), and shows each agent's native session and whether
  its cursor has caught up with the shared history (`current`, `stale`,
  `none`). A long conversation opens on its newest turns and says how many
  earlier turns are not shown, with one action to load them all.
- The page speaks the CLI's language: the same `AVENIC` wordmark, the same
  `◆`/`│` rails, the same `▸`/`◉`/`○` marks, cyan for agents and green for you,
  drawn from the editor's own theme colours so light, dark and high-contrast
  themes all stay readable.
- Nothing on the page is built from HTML strings: session titles, turn text,
  tool details and error messages are set as text, and the page loads no remote
  content.

## 0.4.0

- The dashboard is now the same status model `avenic status` prints. Agent
  rows, the shared history block, the Hub revision and the Skills health all
  come from core, so the panel cannot report a different project state than
  the terminal — including the six sync words (current, stale, missing,
  running, dirty, none), which the agent rows now show as a chip.
- Added a 共享历史 card: history mode, how many shared sessions the project
  holds, and which one is active.
- Hub revision comes from the cached checkout, shortened in the panel, and
  the card no longer claims "no Hub selected" when a default Hub is
  registered but not yet fetched on this machine.

## 0.3.0

- Added project-level configuration for enabled agents, independent auth and
  native-session scopes, and Shared or Isolated session history.
- Added a single Configure Project entry point and an initialization welcome
  state; launch continues to open the official default agent TUI.
- Hub sync no longer freezes the window: git runs asynchronously, so a clone or
  fetch over a slow network leaves the editor usable. Failures are classified
  — authentication, missing repository, missing ref, missing git, network,
  cache blocked — and each kind shows the one next step that applies, instead
  of "check your authentication" for a misspelled repository.
- Launching an agent now takes the same path `avenic <agent>` takes: one
  launch group, one model injection, one recovery policy, shared with the CLI
  and the detached watchdog. A launch that dies mid-snapshot no longer writes a
  half-copied tree back over your real history, and no longer scans every
  agent's history before the terminal opens.
- Agent CLI detection and version checks come from core in one asynchronous
  probe, so refreshing the status no longer runs synchronous `--version`
  spawns on the thread that paints the window.
- Shared history is reconciled when you open Sessions, not before every
  launch.
- Unmanaged Skills are now decided against the managed set rather than against
  what the catalog displays, so a Skill you installed from the CLI is no longer
  offered for adoption.
- The active editor's workspace folder is matched by path containment, so
  Windows folders that end in a separator and filesystem roots resolve to the
  right project.
- Malformed native-history files are reported once per run, in the CLI's
  wording, and are never modified; captures report what they skipped instead of
  printing an object into the message.

## 0.2.0

- Added unified shared-session visibility and continuation commands.
- Made Skills and Hub views cache-first and coalesced duplicate refresh work.
- Added active Codex installation provenance and update guidance.

## 0.1.12

- **本机模型配置库 + 项目绑定**：新增模型配置面板与命令，profile 统一存放于本机库
  `~/.config/avenic/models.json`（库是唯一事实来源），项目只写 `.agents/model.json`
  绑定与回滚账本；绑定把 profile 投影进项目 `.claude/settings.local.json` 并逐键记账，
  解绑按账本精确还原（用户手改过的键保持不动并提示），库字段变化后启动前自动刷新投影。
  绑定时自动补齐项目 `.gitignore` 的模型规则（`.agents/model.json`、
  `.claude/settings.local.json`、`.agents/model.lock`、`.agents/tmp/`）；界面只显示
  掩码，底层仍是明文 JSON 存储。依赖 `@avenic/core` 1.2.1（配套发布 core 新版本）。
- **编辑器标签页面板**：新增「Avenic: 模型配置」（`avenic.model.open`，Avenic 视图标题栏
  settings-gear 入口），以编辑器标签页打开。面板含卡片列表（「用于当前项目」「编辑」
  「测试」「删除」）、当前项目区（绑定状态、投影文件与指纹、取消绑定、打开配置库文件、
  打开项目配置文件）与顶部「+ 新建 / 粘贴导入 / 刷新」；卡片按 Claude / Codex / OpenCode
  标记兼容性（✗ 悬停给出原因），未打开项目文件夹时项目相关操作禁用。
- **模型编辑面板**：编辑区按区块铺开——6 个服务商预设磁贴（**只**预填端点与 API 类型，
  不预填模型 ID，下方标注「预设只是起点，请以服务商文档为准」）、基本信息（名称、API 类型）、
  连接（Base URL + 「将请求：`<解析后的地址>`」实时预览、API Key 密码框、认证字段下拉）、
  模型映射表（主模型 / Opus / Sonnet / Haiku / Fable / Subagent，含显示名与「同主模型」
  一键填充，「1M 上下文」只给 Opus / Sonnet）、6 个开关（每行显示实际写入的键名）、高级
  （自定义 env 键值表；Codex / OpenCode 覆盖端点与 API 类型；Codex providerId / envKey /
  reasoningEffort；OpenCode providerId / npmAdapter；Claude 顶层透传只读预览 + 「在编辑器中
  打开」），以及底部折叠的「最终将写入 .claude/settings.local.json（掩码预览）」。
  可选项与校验一律取自 core（预设、认证字段、角色、开关写入键、请求地址解析、投影与问题
  判定），插件侧不维护第二份规则；问题在出错的那一行上标红定位，未修正时不写入任何文件。
- **粘贴识别**：面板支持粘贴 JSON 或自由文本分析（`parseJson` / `parseText`），识别结果
  逐字段列出、可勾选后「填入表单」；预览永不自动保存，密钥类字段只显示掩码。识别到的
  角色各自落到对应的映射行（不再全塞进主模型）；内容里的掩码（如 `sk-…f3a2`、
  `sk-***abcd`）会被识别阶段剔除并提示，不会被当成密钥填入表单或保存。
- **修复**：密钥输入框保存后不再残留状态——不修改密钥直接保存会保留库中原密钥，输入新值
  则替换，点「清除密钥」才删除；保存 / 删除 / 复制 / 绑定 / 解绑后面板立即重新取数，
  不再停留在操作前的旧快照。
- **测试连接**：卡片「测试」发送一次真实请求并显示耗时与返回模型；失败按类别提示，
  并注明「连接失败 ≠ 密钥无效」。
- **切换命令**：「Avenic: 切换本项目模型配置」（`avenic.model.switch`）在命令面板直接
  选择 profile 绑定当前项目；启动 Agent 时同样按 core 的注入规则生效（Claude 投影 +
  env 兜底、Codex argv、OpenCode `OPENCODE_CONFIG_CONTENT`），不写 Agent 全局配置。

## 0.1.11

- **Skills 单副本共享**：同一作用域内每个 Skill 只保留一份物理文件——`.agents/skills/<name>`
  真身 + `.claude/skills/<name>` 链接（Windows 为 junction，macOS/Linux 为相对符号链接）。
  安装、更新、接管、直装与启动 Agent 前都会补齐缺失或失效的链接，反复安装不再产生第二份副本。
  链接创建失败时自动退回真实副本（可用但未共享），不阻断安装与启动。依赖 `@avenic/core`
  1.1.0（配套发布 core 新版本）。
- **Skills 状态文案**：Skills 视图按共享状态显示——共享（`shared`）、可用但未共享
  （`copies, not shared`）、链接缺失（`links missing`）、冲突（`conflict`），并汇总为
  Optimized / Degraded / Incomplete；未受管技能提示接管处理。
- **修复 Skills 链接命令**：新增 `Avenic: 修复 Skills 链接`（`avenic.skills.repairLinks`），
  只对 lock 记录的受管 Skill 补齐/迁移链接，绝不改动用户自建链接与未受管技能；启动 Agent
  前也会自动补齐。

## 0.1.10

- **扩展图标**：新增 `media/icon.png`（**256×256** PNG，带透明通道；VS Code 只要求
  ≥128×128，256 在高 DPI 下清晰一倍）并声明 `package.json` 顶层 `icon` 字段，
  Marketplace 与扩展列表不再显示默认占位图。图标裁掉源图四周白边、只保留品牌标记
  （三角 A，源图 1254² 中标记仅占 587×561），字标不放入图标（扩展列表本就在图标旁
  显示名称）；背景为白色圆形（直径 252px，圆外透明）。
  定位按**墨水重心**而非包围盒：标记的重心比几何中心低 53.9px（源图尺度），按包围盒
  居中会明显偏下；重心居中后 A 同时可以做得更大——192×183px（围绕重心的外接圆约束，
  像素级校验零切割、余量 3.9px）。
  侧边栏活动栏图标仍用 `media/icon.svg`（24px 单色，跟随主题着色，二者用途不同）。

## 0.1.9

- **Catalog → Hub 更名**：插件面向用户的标题/文案统一改为 Hub（视图「Catalog」→「Hub」、
  Overview 项目卡片、快捷动作「同步 Hub」、命令标题「添加/选择/默认/同步 Hub」、
  树标签「Hub Packs」及各提示/错误消息），与 SkillsHub 品牌一致。
  命令 ID（`avenic.catalog.*`）、视图 ID、`AVENIC_CATALOG_SPEC` 环境变量与 CLI（`avenic catalog`）
  保持不变；纯标识符（CatalogViewProvider 等）与源码注释中的技术命名未动。
- **Overview Agent 行降级改容器查询**：文字压缩改为按卡片自身宽度（`@container`）逐级降级——
  第一级（≤430px）只隐「已初始化 · global/project」状态行与元信息行，名称「Claude Code」保留显示；
  第二级（≤180px）名称也隐，只剩品牌图标 + 状态点。之前的视口断点（600px/430px）会在文字
  仍可容纳时提前隐藏（文字放得下也显示图标），已废弃；视口 @media 只保留非 agent 内容的降级
  （提示行、技能细节、卡片元信息/提示、字号缩放）。
- **修正 Codex / OpenCode 官方标记**：codex 从「六边形+圆点」改为官方六边形环结+水平短杠
  （路径数据取自 LobeHub 官方静态图标库 codex.svg，单 path fill-rule=evenodd）；
  opencode 从「圆环+圆点」改为官方方形回字框 O（外框镂空 + 偏下半透明内块）。

## 0.1.8

- **CLI 交互（clack 风格）**：`avenic skills install`（无参 + 终端）→ 多选 Packs
  （space 切换 / a 全选 / n 清空，common 预选）→ Yes/No 确认 → 旋转安装指示 →
  ╭╮ 摘要框 + ✓ Done；`avenic skills uninstall`（无参 + 终端）→ Yes/No 确认后清空
  并给摘要；`avenic catalog select` 换 clack 风格单选 picker（◇ ◆ ● ○ ▸ │ ✖ 字符帧）。
  交互仅在 TTY 生效，管道/脚本路径维持原行为（install 默认 common、uninstall 直接执行）。
  配套发布 `avenic@1.0.1`（CLI，仍为零依赖）。
- **Overview 响应式**：面板横向压缩分两级降级——≤600px 隐藏非关键元信息；
  ≤430px 最终态 agent 行只留「品牌图标 + 状态点」（claude 星芒 / codex 六边形 /
  opencode 环形，inline SVG 单色 currentColor，无远程资产），完整信息移入悬停 tooltip。
- **跨平台**：CLI 交互层与新增路径无平台特定假设（win32 的 .cmd/.ps1 shim 由
  core 1.0.4 解析器覆盖；ANSI 帧代码为 VT100 通用集，macOS/Windows/Linux 一致）。

## 0.1.7

- **启动 Agent**：已初始化行新增「启动」键位，插件直接在集成终端运行官方 CLI，
  无需安装 @avenic/cli npm 包；项目会话快照/回收与 `avenic claude` 同机制。
- **初始化只选一次作用域**：四象限作用域组合合并为一次 QuickPick，去掉重复提问。
- **安装 / 升级 Agent CLI（图标键）**：未安装 → cloud-download 键一键执行
  `npm install --global <pkg>@latest`；本机 `--version` 与 npm registry 对比出现
  「可升级」状态（arrow-up 键），探测结果 10 分钟缓存。Windows 下 npm 生成
  `.cmd` shim（如 opencode.cmd）由 core 1.0.4 修正为可探测，不再误报「可执行文件缺失」。
- **SkillsHub**：Catalog 默认源更名为 `Echo-Kang-hub/SkillsHub`。

## 0.1.0

首版发布。功能一览：

- **Agents**：初始化 / 移除 Agent，切换认证模式与会话存储（global / project 双作用域），
  会话导入与写回。
- **Catalog**：添加 / 选择 / 设置默认 / 同步 Catalog。
- **Skills**：浏览 Packs 并一键安装 / 卸载，添加与移除直装 Skill。
- **Overview**：项目级的 Agents / Catalog / Skills 状态汇总面板。
