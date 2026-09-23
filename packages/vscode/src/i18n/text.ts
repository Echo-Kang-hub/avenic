// Every word the extension puts in front of a person, in both languages it puts
// them in.
//
// One table, two readers. The extension host imports it and hands a string to a
// QuickPick or a notification; the dashboard receives the same table as a script
// (`view.html` carries a `{{text}}` slot) and reads it from `globalThis`. A
// screen translated only at its edges is worse than an English screen, so there
// is no second place to write a sentence: a key that is missing here fails the
// suite rather than falling back to something nobody wrote.
//
// English is the canonical label and stays the primary one everywhere — the
// product's terms of art (Authentication, Shared Sessions, Configure) are the
// English words, in both locales. Chinese rides along as the weaker half of a
// pair: dimmed text in a host UI, a tooltip and accessible name in the webview,
// and visible secondary text only when the editor itself is in Chinese.
export type TextPair = { readonly en: string; readonly zh: string };

export const TEXT = {
  // — The shell. The sidebar is the one place with room for both halves at once:
  // `Overview` above `总览`, the way the goal describes a bilingual nav.
  "nav.overview": { en: "Overview", zh: "总览" },
  "nav.configure": { en: "Configure", zh: "配置" },
  "nav.agents": { en: "Agents", zh: "Agents 与认证" },
  "nav.sessions": { en: "Sessions", zh: "会话" },
  "nav.skills": { en: "Skills", zh: "技能" },
  "nav.quick": { en: "Quick Actions", zh: "快捷操作" },
  "nav.hooks": { en: "Hooks & Notifications", zh: "钩子与通知" },
  "nav.documentation": { en: "Documentation", zh: "文档" },
  "nav.settings": { en: "Settings", zh: "设置" },
  "nav.aria": { en: "Avenic sections", zh: "Avenic 分区" },
  "brand.tagline": { en: "AI Workflows. Yours.", zh: "AI 工作流，属于你。" },
  "shell.ready": { en: "Ready", zh: "就绪" },
  "shell.configured": { en: "Avenic Configured", zh: "Avenic 已配置" },
  "shell.refresh": { en: "Refresh", zh: "刷新" },
  "shell.reconfigure": { en: "Reconfigure", zh: "重新配置" },
  "shell.project": { en: "Project", zh: "项目" },
  "shell.project-line": { en: "Project: {name}", zh: "项目：{name}" },
  "shell.no-project": { en: "No project open", zh: "没有打开项目" },
  "shell.not-configured": { en: "Not Configured", zh: "未配置" },
  "shell.last-updated": { en: "Last updated: {at}", zh: "最后更新：{at}" },
  "shell.reading": { en: "Reading the project…", zh: "正在读取项目…" },
  "shell.read-failed": { en: "Could not read the project", zh: "读不到这个项目" },
  "shell.not-set-up": { en: "Avenic is not set up here", zh: "这里还没有配置 Avenic" },
  "shell.no-folder": { en: "No project folder is open", zh: "没有打开任何项目文件夹" },
  "shell.initialize": { en: "Initialize Avenic", zh: "初始化 Avenic" },
  "shell.open-folder": { en: "Open Folder", zh: "打开文件夹" },
  "shell.project-path-title": { en: "Reveal this project in the file manager", zh: "在文件管理器中显示这个项目" },
  "shell.noscript": { en: "The dashboard needs JavaScript to read the project.", zh: "仪表盘需要 JavaScript 才能读取项目。" },
  // 一次启动跑着没跑着：core 只有这两档（再加上不说话的那一档 idle）。
  "run.running": { en: "Running", zh: "运行中" },
  "run.interrupted": { en: "Interrupted", zh: "已中断" },
  "cli.missing": { en: "Avenic CLI not on PATH", zh: "PATH 里没有 Avenic CLI" },
  "cli.extension-version": { en: "VS Code extension {version}", zh: "VS Code 扩展 {version}" },

  // — 宿主自己弹的那一场面：QuickPick、进度、通知。这些地方一句话只说一半（见 rowLabel
  // 与 sentence），英文那一半是每个非中文编辑器看到的全部，所以它必须自己站得住：不能依赖
  // 旁边还有一个中文标签来补全意思。
  "ui.no-folder": { en: "No project folder is open", zh: "未选择项目文件夹" },
  "scope.project": { en: "Project scope", zh: "项目作用域" },
  "scope.global": { en: "Global scope", zh: "全局作用域" },
  "scope.project-note": { en: "This project's root", zh: "当前项目根" },
  "scope.global-note": { en: "Your user config directory", zh: "你的用户配置目录" },
  "wizard.pick-at-least-one": { en: "Choose at least one", zh: "请至少选择一项" },
  // — 一次释放（deconfigure）还回去了什么。与 CLI 的 releaseLines 说的是同一组事实：
  // 删掉的、按设计留下的（Account 的家）、以及原值 Avenic 只存过 hash 而给不回来的那些。
  "release.removed": { en: "Removed {entries}", zh: "已删除 {entries}" },
  "release.removed-entry": { en: "{file} · {count} key(s)", zh: "{file} 的 {count} 个键" },
  "release.kept": { en: "Kept {files} — nothing there was Avenic's to remove", zh: "已保留 {files}" },
  "release.unrecoverable": {
    en: "{count} original values cannot be restored — Avenic only ever held a hash of them. Fill them in again.",
    zh: "有 {count} 个键的原值 Avenic 未曾保存、无法恢复，请重新填写",
  },
  // — 启动前那几句「还差什么」。服务层抛给宿主看，所以带键不带语言。
  "agent.not-initialized": {
    en: "{agent} is not initialized for this project yet — run \"Avenic: Configure Project\".",
    zh: "{agent} 尚未初始化，请先执行「Avenic: Configure Project」",
  },
  "agent.no-executable": {
    en: "{agent}'s official CLI was not found ({executable}) — install it first.",
    zh: "未找到 {agent} 官方可执行文件（{executable}），请先安装官方 CLI",
  },
  // 释放的收场：与 `avenic <agent> deinit` 同三件事（Settings / Data / Agents）。
  "agent.deinit-removed": { en: "Removed {agent}'s settings from this project · portable sessions preserved · {remaining} agent(s) still configured", zh: "已移除 {agent} 在本项目里的配置 · 便携会话保留 · 还有 {remaining} 个 Agent 配着" },
  "agent.deinit-absent": { en: "Nothing was configured for {agent} in this project — nothing to remove.", zh: "{agent} 在这个项目里本来就没有配置，无需移除。" },
  "agent.no-auth-picked": {
    en: "{agent} has no authentication picked for this project (Account or API), so this launch uses its own account. Run \"Avenic: Configure Project\", or `avenic {agent} init` to choose.",
    zh: "{agent} 还没有为这个项目选择认证（Account 还是 API），本次按它自己的账号启动；请执行「Avenic: Configure Project」，或运行 `avenic {agent} init` 选择。",
  },
  "flow.busy": { en: "Avenic: an operation is already running, please wait.", zh: "Avenic：操作进行中，请稍候。" },
  "flow.no-options": { en: "Avenic: there is nothing here to act on.", zh: "Avenic：没有可操作的选项。" },
  "flow.done": { en: "Done", zh: "完成" },
  // — 树视图/命令面板里那些一次操作的开场与收场。
  "agents.operation": { en: "Avenic Agent operation", zh: "Avenic Agent 操作" },
  "agents.config-updated": { en: "configuration updated", zh: "配置已更新" },
  "agents.initialized": { en: "initialized", zh: "初始化完成" },
  "sessions.import-summary": {
    en: "Found {discovered} sessions, imported {imported}, unchanged {unchanged}, failed {failed}.",
    zh: "发现 {discovered} 个会话；导入 {imported} 个；未变更 {unchanged} 个；失败 {failed} 个。",
  },
  "sessions.writeback": { en: "Wrote back {count} sessions", zh: "已写回 {count} 个会话" },
  // — Hub（Catalog）。命令名保持英文：用户在命令面板里找的就是那几个字，
  //   提示里换个译名就等于指着一个不存在的入口。
  "catalog.spec-prompt": { en: "Hub spec (owner/repo, URL or local path)", zh: "Hub spec（owner/repo、URL 或本地路径）" },
  "catalog.add": { en: "Add Hub", zh: "添加 Hub" },
  "catalog.saving": { en: "Saving and previewing…", zh: "保存并预览…" },
  "catalog.preview-failed": { en: "Saved — the preview failed, which is not fatal. Run Avenic: Sync Hub to retry.", zh: "已保存；预览失败不致命，可执行 Avenic: Sync Hub 重试。" },
  "catalog.added": { en: "Hub added, {count} pack(s) previewed.", zh: "Hub 已添加并预览 {count} 个 Pack" },
  "catalog.no-hubs": { en: "No Hub is registered yet — run Avenic: Add Hub first.", zh: "暂无已注册 Hub，请先执行 Avenic: Add Hub" },
  "catalog.current-default": { en: "Current default Hub: {spec}", zh: "当前默认 Hub：{spec}" },
  "catalog.not-set": { en: "not set", zh: "未设置" },
  "catalog.change": { en: "Change", zh: "修改" },
  "catalog.no-default": { en: "No default Hub is selected", zh: "未选择默认 Hub" },
  "catalog.no-default-hint": { en: "No default Hub is selected yet — run Avenic: Add Hub first.", zh: "尚未选择默认 Hub，请先执行 Avenic: Add Hub" },
  "catalog.sync": { en: "Sync Hub", zh: "同步 Hub" },
  "catalog.syncing": { en: "Fetching and parsing…", zh: "拉取并解析…" },
  "catalog.foreign-hub": { en: "That pack belongs to a Hub that is not the default — run Avenic: Select Hub first.", zh: "该 Pack 属于非默认 Hub，请先执行 Avenic: Select Hub" },
  "catalog.no-manifest": { en: "This Hub's pack list has not been synced yet — run Avenic: Sync Hub first.", zh: "还没有同步到这个 Hub 的 Pack 清单，请先执行 Avenic: Sync Hub" },
  "catalog.installing": { en: "Installing packs", zh: "安装 Packs" },
  "catalog.installing-pack": { en: "Installing pack {pack}…", zh: "安装 Pack {pack}…" },
  "catalog.installed": { en: "Pack {pack} installed: {packs}", zh: "Pack {pack} 已安装：{packs}" },
  // — Skills（Packs 与直装 Skill）。Pack/Skill 是术语，两种语言里都照写。
  "skills.installing-packs": { en: "Installing {count} pack(s)…", zh: "安装 {count} 个 Pack…" },
  "skills.uninstalling": { en: "Uninstall packs", zh: "卸载 Packs" },
  "skills.uninstalling-packs": { en: "Uninstalling {count} pack(s)…", zh: "卸载 {count} 个 Pack…" },
  "skills.repo-prompt": { en: "owner/repo or repository URL", zh: "owner/repo 或仓库 URL" },
  "skills.add-direct": { en: "Add repository skills", zh: "添加直装 Skills" },
  "skills.discovering": { en: "Discovering skills…", zh: "发现 Skills…" },
  "skills.added-direct": { en: "Added {count} skill(s): {names}", zh: "已添加 {count} 个 Skills：{names}" },
  "skills.remove-direct": { en: "Remove repository skills", zh: "移除直装 Skills" },
  "skills.removing": { en: "Removing {count} skill(s)…", zh: "移除 {count} 个 Skill…" },
  "skills.no-direct": { en: "No repository skills are installed.", zh: "暂无直装 Skills" },
  "skills.adopt-as-pack-entry": { en: "Adopt as Pack “{pack}” and add {count} missing skill(s)", zh: "识别为 Pack「{pack}」并补齐 {count} 个缺失 Skill" },
  "skills.coverage": { en: "Coverage {matched}/{total} ({percent}%)", zh: "覆盖 {matched}/{total}（{percent}%）" },
  "skills.adopt-plain": { en: "Manage the existing skills only (no Pack)", zh: "仅托管现有 Skill（不关联 Pack）" },
  "skills.adopt-plain-note": { en: "Leave the files on disk as they are", zh: "保持磁盘内容不变" },
  "skills.adopt-detected": { en: "{count} unmanaged skill(s) found", zh: "检测到 {count} 个未托管 Skill" },
  "skills.adopt": { en: "Adopt unmanaged skills", zh: "托管磁盘 Skills" },
  "skills.adopting": { en: "Adopting {count} skill(s)…", zh: "托管 {count} 个 Skill…" },
  "skills.adopted": { en: "Adopted {count} skill(s) ({placed} link(s) added)", zh: "已托管 {count} 个 Skills（补齐 {placed} 处目标）" },
  "skills.takeover": { en: "Adopt as Pack “{pack}”", zh: "识别为 Pack「{pack}」接管" },
  "skills.takeover-installing": { en: "Installing Pack “{pack}” (adding the missing skills)…", zh: "安装 Pack「{pack}」（补齐缺失 Skill）…" },
  "skills.took-over": { en: "Recognized as Pack “{pack}” and installed {count} skill(s)", zh: "已识别为 Pack「{pack}」并安装 {count} 个 Skills" },
  "skills.took-over-short": { en: "Recognized as Pack “{pack}”: {count} skill(s)", zh: "已识别为 Pack「{pack}」：{count} 个 Skill" },
  "skills.no-adopted": { en: "No managed skill is waiting for a Pack.", zh: "没有已托管但未关联 Pack 的 Skill" },
  "skills.no-covering-pack": { en: "No Pack in the default Hub covers those {count} skill(s) (≥80% match).", zh: "默认 Hub 中未找到覆盖 {count} 个 Skill 的 Pack（≥80% 匹配）" },
  "skills.takeover-pick": { en: "Recognize {count} managed skill(s) as a Pack", zh: "识别 {count} 个已托管 Skill 为 Pack" },
  "skills.pick-installed": { en: "Select an installed Pack", zh: "选择已安装 Pack" },
  "skills.uninstall-confirm": { en: "Uninstall Pack “{pack}”? Skills only it uses go with it; ones another Pack uses stay.", zh: "卸载 Pack「{pack}」？其独占的 Skill 将一并移除（被其他 Pack 选用的保留）" },
  "skills.uninstall": { en: "Uninstall", zh: "卸载" },
  "skills.uninstall-pack": { en: "Uninstall Pack", zh: "卸载 Pack" },
  "skills.uninstalling-pack": { en: "Uninstalling Pack “{pack}”…", zh: "卸载 Pack「{pack}」…" },
  "skills.removal-suffix": { en: ", {count} skill(s) removed", zh: "，移除 {count} 个 Skill" },
  "skills.uninstalled": { en: "Uninstalled Pack “{pack}”", zh: "已卸载 Pack「{pack}」" },
  "skills.reinstall": { en: "Reinstall Pack", zh: "重装 Pack" },
  "skills.reinstalling": { en: "Reinstalling Pack “{pack}”…", zh: "重装 Pack「{pack}」…" },
  "skills.reinstalled": { en: "Reinstalled Pack “{pack}”: {count} skill(s)", zh: "已重装 Pack「{pack}」：{count} 个 Skill" },
  "skills.repair": { en: "Repair skill links", zh: "修复 Skills 链接" },
  "skills.links-ok": { en: "Skill links are already up to date", zh: "Skills 链接已是最新" },
  "skills.links-summary": { en: "Linked {linked} · Migrated {migrated} · Fallback {fallback} · Conflicts {conflicts}", zh: "链接 {linked} · 迁移 {migrated} · 降级 {fallback} · 冲突 {conflicts}" },

  // — 面板自己画的那一半（media/dashboard/main.js）。键名说的是这句话出现的那一块屏：
  // 概览上的卡片、Sessions 页、对话阅读器。同一句话只写一遍——侧栏的 `Skills` 就是
  // 那一张卡的标题，所以它用的是 nav.skills，不是一个新键。

  // 三个 Agent 的卡片（Configure 那两列是它的窄版）。
  "agents.title": { en: "Agent Configuration", zh: "Agent 配置" },
  "agents.subtitle": { en: "Authentication, configuration and sessions for each agent.", zh: "每个 Agent 的认证、配置与会话。" },
  "agents.open-terminal": { en: "Open in Terminal", zh: "在终端中打开" },
  "agents.log": { en: "Activity log", zh: "活动日志" },
  // 配置的是文件夹里的项目，所以没有文件夹时这一句就是全部答案：先打开一个。
  // 活动栏那一行和点击后的提示说的是同一件事，因此是同一个键。
  "agents.configure-nofolder": { en: "Avenic configures a project, and no folder is open. Open one, then choose the agents it uses and how they authenticate.", zh: "Avenic 配置的是一个项目，而现在没有打开文件夹。先打开一个，再选这个项目用哪些 Agent、各自怎么认证。" },
  "agent.launch": { en: "Launch", zh: "启动" },
  "agent.change": { en: "Change", zh: "更改" },
  "agent.history": { en: "History", zh: "历史" },

  // Model Configuration Center：一个 agent 自己那份 provider 配置。这一页写下去的是
  // agent 的原生文件，Avenic 只做合并 —— 所以每一句说的都是这件事，凭据那一栏尤其：
  // 留空是「别动它」，不是「清掉它」。
  "nav.model-config": { en: "Model Config", zh: "模型配置" },
  // 页头与侧栏说同一句话：`Model Configuration` 是这一轮之前那个被禁的实现词
  // （test/vocabulary.test.mjs），面板上的名字一直是 Model Config。
  "center.title": { en: "Model Config", zh: "模型配置" },
  "center.subtitle": { en: "Provider, endpoint and model for one agent — written into the agent's own file.", zh: "一个 Agent 的供应商、地址与模型 —— 写进 Agent 自己的文件里。" },
  "center.provider": { en: "Provider", zh: "供应商" },
  "center.provider-docs": { en: "Vendor documentation", zh: "供应商文档" },
  "center.endpoint": { en: "Request URL", zh: "请求地址" },
  "center.model": { en: "Default model", zh: "默认模型" },
  "center.refresh-models": { en: "Refresh Models", zh: "刷新模型" },
  "center.models-empty": { en: "No model list yet — refresh to ask the provider.", zh: "还没有模型列表 —— 刷新一次，去问供应商。" },
  "center.credential": { en: "API Key", zh: "API 密钥" },
  "center.credential-keep": { en: "Leave this blank to keep the key already in the file.", zh: "留空表示保持文件里已有的那个 key。" },
  "center.credential-set": { en: "A key is already in this file.", zh: "这个文件里已经有一个 key。" },
  "center.roles": { en: "Model roles", zh: "模型角色" },
  "center.roles-note": { en: "What the vendor recommends, and what the file says now.", zh: "供应商推荐的是什么，文件里现在是什么。" },
  "center.options": { en: "Options", zh: "选项" },
  "center.test": { en: "Test Connection", zh: "测试连接" },
  "center.diff": { en: "View Diff", zh: "查看差异" },
  "center.apply": { en: "Apply", zh: "应用" },
  "center.open-file": { en: "Open Config File", zh: "打开配置文件" },
  "center.advanced": { en: "Advanced", zh: "高级" },
  "center.simple": { en: "Simple", zh: "简单" },
  "center.written": { en: "Written to {file}", zh: "已写入 {file}" },
  "center.unchanged": { en: "{file} already matches — nothing written", zh: "{file} 已经一致 —— 没有写入" },
  "center.not-owned": { en: "{name} keeps its own provider configuration; Avenic has nothing to merge here.", zh: "{name} 自己管自己的供应商配置，Avenic 这里没有可合并的东西。" },
  // 灰按钮旁边那一句：宿主的守卫会把缺字段的问题整条丢掉，而一个点了没反应的按钮和坏掉的
  // 没有区别，所以缺什么得说出来。灰按钮不发光标事件，不能指望 tooltip。
  "center.need-provider": { en: "Choose a provider first.", zh: "先选一个供应商。" },
  "center.need-endpoint": { en: "Enter the request URL first.", zh: "先填请求地址。" },
  "center.need-model": { en: "Enter a model first.", zh: "先填模型。" },
  "center.need-credential": { en: "Enter the API key first.", zh: "先填 API Key。" },
  // 换供应商时留空留下的会是上一家的钥匙：这一句要说出为什么，不能只说「少了东西」。
  "center.credential-other-provider": { en: "The key already in this file belongs to another provider — enter the key for {provider}.", zh: "文件里已有的 key 属于另一家供应商 —— 请填 {provider} 的 key。" },
  // 这一页在 account 下不写盘（apiScope 会拒绝），所以这句话不能说「应用就会切过去」：
  // 切换这个项目是 Configure Project 的问题，因为它还要问旧的配置怎么办。
  "center.account-note": { en: "This agent signs in with your Account today. Switching this project to API is a question for Avenic: Configure Project — until then Avenic writes nothing here.", zh: "这个 Agent 现在用账号登录。把这个项目切到 API 是「Avenic: Configure Project」里的事 —— 在那之前，Avenic 在这里什么都不写。" },
  "center.connection.connected": { en: "Connected", zh: "已连接" },
  "center.connection.authentication-failed": { en: "Authentication failed", zh: "认证失败" },
  "center.connection.model-unavailable": { en: "Model unavailable", zh: "模型不可用" },
  "center.connection.network-error": { en: "Network error", zh: "网络错误" },
  "center.connection.timeout": { en: "Timed out", zh: "超时" },
  "center.connection.unreadable": { en: "The answer was not that API", zh: "回答不像那个 API" },
  "center.connection.http-error": { en: "The provider refused the request", zh: "供应商拒绝了这次请求" },
  "center.catalog-fetched": { en: "{count} models", zh: "{count} 个模型" },
  // — 中心在宿主这一侧说的话：进度条上的一句、以及服务层抛回来的那些（键 + 洞，见 LocalizedError）。
  "center.progress-preview": { en: "Avenic · {agent} configuration", zh: "Avenic · {agent} 配置" },
  "center.progress-test": { en: "Avenic · Testing {agent}", zh: "Avenic · 正在测试 {agent}" },
  "center.progress-models": { en: "Avenic · Fetching {agent} models", zh: "Avenic · 正在获取 {agent} 的模型" },
  "center.progress-apply": { en: "Avenic · Writing {agent} configuration", zh: "Avenic · 正在写入 {agent} 的配置" },
  "center.unknown-provider": { en: "Avenic does not know the provider {provider}.", zh: "Avenic 不认识这个供应商：{provider}。" },
  "center.not-api-scope": {
    en: "{agent} is not set up for an API provider in this project — run Avenic: Configure Project and choose API first, so the file Avenic writes is the one {agent} reads.",
    zh: "{agent} 在这个项目里还没有走 API —— 请先执行「Avenic: Configure Project」并选 API，Avenic 写的那个文件才是 {agent} 读的那个。",
  },
  "center.no-key-env": {
    en: "{variable} is not set in this environment — {provider} reads its credential from there, so there is nothing to send.",
    zh: "这个环境里没有 {variable} —— {provider} 的凭据从那里读，所以没有东西可发。",
  },
  "center.no-key-file-probe": {
    en: "Avenic never reads the key back out of the file — type it here to probe this endpoint.",
    zh: "Avenic 从不把 key 从文件里读回来 —— 要探测这个地址，请在这里填一次。",
  },
  "center.no-key-file-fetch": {
    en: "Avenic never reads the key back out of the file — type it here to fetch this list.",
    zh: "Avenic 从不把 key 从文件里读回来 —— 要拉取这份名单，请在这里填一次。",
  },
  "center.no-catalog-endpoint": {
    en: "{provider} documents no model list endpoint, and Avenic will not guess one.",
    zh: "{provider} 没有公开的模型表地址，Avenic 也不猜。",
  },
  "center.catalog-unauthorized": { en: "The provider rejected the credential (HTTP 401).", zh: "供应商拒绝了这份凭据（HTTP 401）。" },
  "center.catalog-http": { en: "The provider answered HTTP {status}.", zh: "供应商回了 HTTP {status}。" },
  "center.catalog-unreadable": { en: "The answer was not a model list.", zh: "回答不是一份模型名单。" },
  "center.catalog-timeout": { en: "The provider did not answer in the time Avenic allows.", zh: "供应商没有在 Avenic 允许的时间里回答。" },
  "center.catalog-network": { en: "The request could not reach the provider.", zh: "这次请求没有到达供应商。" },
  // — 中心「选项」里那几块：名字描述的是它写进文件的那几个值（core 的 CLAUDE_BLOCKS 只给
  //   id 与值，名字是宿主给页面画的那一句）。
  "center.block-signature": { en: "No co-authored-by trailer", zh: "不加 co-authored-by 尾注" },
  "center.block-teammates": { en: "Agent teams (experimental)", zh: "Agent 团队（实验性）" },
  "center.block-tool-search": { en: "Tool search", zh: "工具检索" },
  "center.block-thinking-budget": { en: "Max output tokens 31972", zh: "最大输出 token 31972" },
  "center.block-auto-upgrade": { en: "Auto-update, latest channel", zh: "自动更新（latest 通道）" },
  // — 面板「最近发生了什么」里由中心写下的那几行。
  "center.activity-connected": { en: "{agent} provider answered", zh: "{agent} 的供应商回答了" },
  "center.activity-models": { en: "{agent} model list refreshed ({count})", zh: "{agent} 的模型列表已刷新（{count} 个）" },
  "center.activity-written": { en: "{agent} configuration written", zh: "{agent} 的配置已写入" },

  // — 钩子与通知：这一页问的是「装没装」与「响了之后做什么」。
  "hooks.unsupported-version": { en: "Unsupported by {agent} {version}", zh: "不支持：{agent} {version}" },
  "hooks.unsupported-unknown": { en: "Unsupported by {agent}: the installed version could not be read", zh: "不支持：读不到 {agent} 安装的版本" },
  "hooks.unsupported-agent": { en: "Avenic has no hook mechanism recorded for {agent}.", zh: "Avenic 没有记录 {agent} 的钩子机制。" },
  "hooks.unknown-kind": { en: "Avenic does not know the notification kind {kind}.", zh: "Avenic 不认识这种通知：{kind}。" },
  "hooks.need-url": { en: "A webhook needs a URL.", zh: "Webhook 需要填一个地址。" },
  "hooks.need-gateway": { en: "OpenClaw needs a gateway address.", zh: "OpenClaw 需要填网关地址。" },
  "hooks.need-path": { en: "The path has to start with “/”.", zh: "路径要以「/」开头。" },
  "hooks.need-command": { en: "A command action needs a program to run.", zh: "命令类通知要填一个要跑的程序。" },
  "hooks.bad-url": { en: "{value} is not an http(s) address.", zh: "{value} 不是一个 http(s) 地址。" },
  "hooks.bad-gateway": { en: "{value} is not an http(s) gateway address.", zh: "{value} 不是一个 http(s) 网关地址。" },
  "hooks.token-both": { en: "Give either the token or the name of the variable that holds it, not both.", zh: "令牌本身或存放它的变量名，只能填一个。" },
  "hooks.unknown-action": { en: "Avenic has no notification called {id}.", zh: "Avenic 这里没有叫 {id} 的通知。" },
  "hooks.bad-timeout": { en: "Give the timeout in milliseconds, as a number.", zh: "超时请按毫秒填一个数字。" },
  // 命令类通知的关口：这一句是那句警告，说出去了才算过。
  "hooks.need-advanced": { en: "Command notifications run a program on this machine. Add one under Advanced.", zh: "命令类通知会在这台机器上跑一个程序。要加请在 Advanced 下加。" },
  "hooks.ask-gateway": { en: "OpenClaw gateway address", zh: "OpenClaw 网关地址" },
  "hooks.ask-path": { en: "Hook path on the gateway", zh: "网关上的钩子路径" },
  "hooks.ask-url": { en: "Webhook URL", zh: "Webhook 地址" },
  "hooks.ask-timeout": { en: "Timeout in milliseconds (empty for none)", zh: "超时毫秒数（留空则不写）" },
  "hooks.ask-command": { en: "Command to run (Avenic runs it on this machine)", zh: "要跑的命令（Avenic 会在这台机器上执行它）" },
  // 令牌那一问：填值、填变量名、或者不要 —— 值那一问永远是密码框，预填时永远不给。
  "hooks.ask-token-kind": { en: "How does the hook authenticate?", zh: "这个钩子怎么认证？" },
  "hooks.token-kind-none": { en: "No token", zh: "不用令牌" },
  "hooks.token-kind-value": { en: "A token, stored here", zh: "填一个令牌，存在这里" },
  "hooks.token-kind-env": { en: "The name of a variable that holds it", zh: "填存放它的变量名" },
  "hooks.ask-token": { en: "Hook token", zh: "钩子令牌" },
  "hooks.ask-token-env": { en: "Variable name that holds the token", zh: "存放令牌的变量名" },
  "hooks.note-token": { en: "Stored in the notification file; never sent to the page", zh: "存在通知文件里，不会送到页面上" },
  "hooks.keep-token": { en: "Empty keeps the token already in the file", zh: "留空则保留文件里已有的那个令牌" },
  // 确认：命令类那一条要说清它是什么，删一条要让用户认出这一条。
  "hooks.confirm-command": { en: "Run this program whenever a hook fires?", zh: "每次钩子响起都跑这个程序？" },
  "hooks.confirm-command-yes": { en: "Yes, run {command}", zh: "是，跑 {command}" },
  "hooks.confirm-cancel": { en: "Cancel", zh: "取消" },
  "hooks.confirm-remove": { en: "Remove this notification?", zh: "删掉这条通知？" },
  "hooks.confirm-remove-yes": { en: "Remove {target}", zh: "删掉 {target}" },
  // 两个作用域：这份名单写在项目里，还是写在这台机器上（与认证的作用域不是一回事）。
  "hooks.scope-project": { en: "Project", zh: "项目" },
  "hooks.scope-global": { en: "Global", zh: "全局" },
  // 需要读一次 agent 版本的那几条（装、卸、预览）在慢的时候显示的那句话。
  "hooks.progress-plan": { en: "Avenic · Reading {agent} hooks", zh: "Avenic · 正在读 {agent} 的钩子" },
  "hooks.progress-install": { en: "Avenic · Installing {agent} hooks", zh: "Avenic · 正在安装 {agent} 的钩子" },
  "hooks.progress-uninstall": { en: "Avenic · Removing {agent} hooks", zh: "Avenic · 正在移除 {agent} 的钩子" },
  // 活动日志：只记「谁、哪一档、动的是哪一条」——目标与凭据都不进日志。
  "hooks.activity-installed": { en: "{agent} hooks installed · {scope}", zh: "{agent} 的钩子已安装 · {scope}" },
  "hooks.activity-uninstalled": { en: "{agent} hooks removed · {scope}", zh: "{agent} 的钩子已移除 · {scope}" },
  "hooks.activity-added": { en: "Notification added · {id}", zh: "已加一条通知 · {id}" },
  "hooks.activity-edited": { en: "Notification updated · {id}", zh: "通知已更新 · {id}" },
  "hooks.activity-removed": { en: "Notification removed · {id}", zh: "通知已删除 · {id}" },
  // 这一页本身（外壳与两张卡）。
  "hooks.subtitle": { en: "What each agent can call, and what Avenic does when it fires.", zh: "每个 Agent 能挂什么钩子，以及钩子响起时 Avenic 做什么。" },
  "hooks.scope-label": { en: "Where this notification list is written", zh: "这份通知名单写在哪里" },
  "hooks.agents-title": { en: "Agent hooks", zh: "Agent 钩子" },
  "hooks.agents-subtitle": { en: "Each agent's own mechanism, read from the file it uses.", zh: "每个 Agent 自己的机制，读的是它自己那个文件。" },
  "hooks.mechanism": { en: "Mechanism", zh: "机制" },
  "hooks.installed": { en: "Installed", zh: "已安装" },
  "hooks.not-installed": { en: "Not installed", zh: "未安装" },
  "hooks.unreadable": { en: "Unreadable", zh: "读不出来" },
  "hooks.install": { en: "Install", zh: "安装" },
  "hooks.uninstall": { en: "Uninstall", zh: "卸载" },
  "hooks.view-config": { en: "View Generated Config", zh: "查看将写入的配置" },
  "hooks.actions-title": { en: "Notifications", zh: "通知" },
  "hooks.actions-subtitle": { en: "What Avenic does when a hook fires, in this scope.", zh: "这个作用域里的钩子响起时，Avenic 做什么。" },
  "hooks.actions-empty-title": { en: "No notifications yet", zh: "还没有通知" },
  "hooks.actions-empty-detail": { en: "A hook that fires with nothing here does nothing at all.", zh: "这里什么都没有时，钩子响了也等于没响。" },
  "hooks.add": { en: "Add notification", zh: "添加通知" },
  "hooks.kind-desktop": { en: "Desktop notification", zh: "桌面通知" },
  "hooks.kind-openclaw": { en: "OpenClaw gateway", zh: "OpenClaw 网关" },
  "hooks.kind-webhook": { en: "Webhook", zh: "Webhook 通知" },
  "hooks.kind-command": { en: "Command", zh: "命令" },
  "hooks.edit": { en: "Edit", zh: "编辑" },
  "hooks.remove": { en: "Remove", zh: "删除" },
  "hooks.token-set": { en: "Token set", zh: "已设令牌" },
  "hooks.token-from": { en: "Token from {name}", zh: "令牌来自 {name}" },
  "hooks.timeout-value": { en: "{ms} ms timeout", zh: "超时 {ms} 毫秒" },
  "hooks.threshold-note": { en: "A turn is complete after {seconds}s; the same hook inside {window}s fires once.", zh: "一轮对话满 {seconds} 秒才算完成；同一条钩子在 {window} 秒内只响一次。" },
  "hooks.advanced": { en: "Advanced", zh: "高级" },
  // 命令类的那句警告：它是这一档的门，永远与那个按钮一起出现。
  "hooks.command-warning": { en: "A command notification runs a program on this machine every time a hook fires. Add one only if you know what it will run.", zh: "命令类通知会在每次钩子响起时在这台机器上跑一个程序。不确定它会跑什么，就不要加。" },
  // 一次问答的结果（预览、装、卸、写名单）。
  "hooks.result-plan": { en: "What an install would change in {file}", zh: "安装会改动 {file} 里的哪几行" },
  "hooks.result-plan-empty": { en: "An install would leave {file} as it is.", zh: "安装不会改动 {file}。" },
  "hooks.result-installed": { en: "Hooks installed · {file}", zh: "钩子已安装 · {file}" },
  "hooks.result-already-installed": { en: "Already installed · {file}", zh: "本来就装着 · {file}" },
  "hooks.result-uninstalled": { en: "Hooks removed · {file}", zh: "钩子已移除 · {file}" },
  "hooks.result-not-installed": { en: "Nothing of Avenic's was in {file}", zh: "{file} 里本来就没有 Avenic 写的东西" },
  "hooks.result-saved": { en: "Notification list saved · {file}", zh: "通知名单已保存 · {file}" },
  "hooks.result-unchanged": { en: "Nothing changed · {file}", zh: "没有变化 · {file}" },

  // — 设置与关于：这一页只说这套安装是什么，一个字都不配置。
  "settings.title": { en: "Settings & About", zh: "设置与关于" },
  "settings.subtitle": { en: "What this installation is, and where this project's files are.", zh: "这套安装是什么，这个项目的文件在哪里。" },
  "settings.show": { en: "Show", zh: "显示" },
  "settings.note": { en: "Avenic core ships inside this extension; the CLI is what runs your sessions.", zh: "Avenic 核心随这个扩展一起打包；跑会话的是命令行那一份。" },

  // — 设置与关于：这一页只说事实（版本、路径），每一行左边是词，右边是那个事实。
  "about.extension": { en: "Extension", zh: "扩展" },
  "about.editor": { en: "Editor", zh: "编辑器" },
  "about.cli": { en: "Avenic CLI", zh: "Avenic 命令行" },
  "about.core": { en: "Avenic core", zh: "Avenic 核心" },
  "about.project": { en: "Project root", zh: "项目根目录" },
  "about.config": { en: "Configuration file", zh: "配置文件" },
  "about.hooks": { en: "Notification list", zh: "通知名单" },
  // 右边那个值是 core 的 historyLabel（Shared / Isolated），左边这个词就是产品给它的
  // 名字：History。写成 "Session history" 是别的产品的说法（P7 的词表禁令扫的就是它）。
  "about.history": { en: "History", zh: "历史" },
  "about.logs": { en: "Logs", zh: "日志" },
  "about.logs-value": { en: "Output panel → Avenic", zh: "输出面板 → Avenic" },
  "about.storage": { en: "Extension storage (this profile)", zh: "扩展存储（当前配置文件）" },
  "about.vscode-settings": { en: "Open VS Code Settings", zh: "打开 VS Code 设置" },
  "about.not-detected": { en: "Not detected", zh: "没有检测到" },
  "about.no-project": { en: "No project open", zh: "没有打开项目" },

  // 共享会话：概览那张卡和 Sessions 页的左边那一半说的是同一件事。
  "sessions.shared.title": { en: "Shared Sessions", zh: "共享会话" },
  "sessions.shared.subtitle": { en: "Native sessions and projections for each agent.", zh: "每个 Agent 的原生会话与它们的投影。" },
  "sessions.shared.continue": { en: "Continue in New Terminal", zh: "在新终端里继续这个 Session" },
  "sessions.shared.switch": { en: "Switch to Shared", zh: "切换到共享" },
  "sessions.shared.all": { en: "All shared sessions", zh: "全部共享会话" },
  "sessions.shared.off-title": { en: "Shared history is off", zh: "共享历史已关闭" },
  "sessions.shared.off-detail": { en: "This project keeps each agent's sessions isolated. Switch to Shared and the conversations all three can pick up appear here.", zh: "这个项目把每个 Agent 的会话彼此隔离。切换到共享之后，三个 Agent 都能接上的那些对话会出现在这里。" },
  "sessions.shared.empty-title": { en: "No shared sessions yet", zh: "还没有共享会话" },
  "sessions.shared.view-all": { en: "View All Shared Sessions ({total})", zh: "查看全部共享会话（{total}）" },
  // 某个 Agent 自己那一份原生会话。
  "sessions.agent.title": { en: "Agent Sessions", zh: "Agent 会话" },
  "sessions.agent.subtitle": { en: "Independent histories for each agent.", zh: "每个 Agent 各自独立的历史。" },
  "sessions.agent.tabs-label": { en: "Agents with sessions in this project", zh: "在这个项目里有会话的 Agent" },
  "sessions.agent.tab": { en: "{name} ({count})", zh: "{name}（{count} 条）" },
  "sessions.agent.panel": { en: "Sessions for {name}", zh: "{name} 的会话" },
  "sessions.agent.empty-title": { en: "No sessions here yet", zh: "这里还没有会话" },
  "sessions.agent.no-conversation": { en: "{name} has no conversation in this project to continue.", zh: "{name} 在这个项目里没有可以接着往下说的对话。" },
  "sessions.agent.view-all": { en: "View All Agent Sessions", zh: "查看全部 Agent 会话" },
  // Sessions 页自己：两半的开关、搜索、空列表与页脚。
  "sessions.which": { en: "Which history to list", zh: "列出哪一份历史" },
  "sessions.tab.shared": { en: "Shared", zh: "共享" },
  "sessions.tab.agent": { en: "Agent", zh: "按 Agent" },
  "sessions.search": { en: "Search sessions", zh: "搜索会话" },
  "sessions.list.shared": { en: "Shared sessions", zh: "共享会话列表" },
  "sessions.note": { en: "Shared Sessions hold the conversation every agent can pick up; Agent Sessions are the ones an agent's own CLI opens.", zh: "Shared Sessions 是三个 Agent 都能接上的那段对话；Agent Sessions 是某个 Agent 自己的 CLI 打开的那一份。" },
  // 一句解释两个产品词的话，用词必须是那两个：`Session Storage` 是自己造的第三个词。
  "sessions.no-match.title": { en: "No session matches", zh: "没有匹配的会话" },
  "sessions.no-match.detail": { en: "Nothing in this list has “{search}” in its title, its agents or its time.", zh: "这张列表里没有一条的标题、参与者或时间里带“{search}”。" },
  // 这两条在 Sessions 页上带句号，概览那张卡上不带——屏幕上是这样，键就照这样分。
  "sessions.empty.shared-title": { en: "No shared sessions yet.", zh: "还没有共享会话。" },
  "sessions.empty.agent-title": { en: "No sessions here yet.", zh: "这里还没有会话。" },
  "sessions.empty.start-detail": { en: "Start an agent session and import it — the conversation shows up here, ready to continue.", zh: "开一个 Agent Session 再把它导入进来，那段对话就会出现在这里，可以直接接着往下说。" },
  "sessions.continue": { en: "Continue", zh: "继续" },
  "sessions.chip.active": { en: "Active", zh: "当前" },
  "sessions.chip.stale": { en: "Stale", zh: "已落后" },
  "sessions.actions": { en: "Session actions", zh: "会话操作" },
  // 行尾那份菜单里的两句话。第三件（设为当前）用的是对话头那一句同一个键——同一个动作在
  // 两个地方叫两个名字，用户会以为是两件事。
  "sessions.open": { en: "Open conversation", zh: "打开这段对话" },
  "sessions.continue-in": { en: "Continue in {agent}", zh: "在 {agent} 里继续" },
  "sessions.foot.match": { en: "{shown} of {total} sessions match.", zh: "筛出 {shown} 条，共 {total} 条会话。" },
  // 清单脚注：哪一张列表都这么说它自己列了多少。
  "list.showing-newest": { en: "Showing the newest {shown} of {total}.", zh: "只显示最新的 {shown} 条，共 {total} 条。" },

  // 技能那一张卡与它的三个来源。
  "skills.subtitle": { en: "Manage and import skills for all agents.", zh: "管理并导入各个 Agent 要用的 Skill。" },
  "skills.import": { en: "Import Skill", zh: "导入 Skill" },
  "skills.actions": { en: "Skill actions", zh: "Skill 操作" },
  "skills.sources": { en: "Skill sources", zh: "Skill 来源" },
  "skills.tab.installed": { en: "Installed ({count})", zh: "已安装（{count}）" },
  "skills.tab.packs": { en: "Available Packs", zh: "可用的 Pack" },
  "skills.tab.hub": { en: "Official Registry", zh: "官方 Registry" },
  "skills.panel": { en: "Skills from the selected source", zh: "来自所选来源的 Skill" },
  "skills.packs.empty-title": { en: "No packs available", zh: "没有可用的 Pack" },
  "skills.packs.empty-detail": { en: "Sync the registry and the packs you can install show up here.", zh: "同步一次 Registry，能装的 Pack 就会出现在这里。" },
  "skills.packs.count": { en: "{count} skills", zh: "{count} 个 Skill" },
  "skills.pack.install": { en: "Install", zh: "安装" },
  "skills.pack.installed": { en: "Installed", zh: "已安装" },
  // 注册表那一行是 core 的三态，三句话各自说出来，不压成一个布尔。
  "skills.hub.none": { en: "No registry configured", zh: "没有配置 Registry" },
  "skills.hub.never": { en: "Never synced", zh: "从未同步" },
  "skills.hub.up-to-date": { en: "{revision} · up to date", zh: "{revision} · 已是最新" },
  "skills.hub.stale": { en: "{revision} · stale", zh: "{revision} · 已落后" },
  "skills.hub.sync": { en: "Sync", zh: "同步" },
  "skills.hub.sync-again": { en: "Sync again", zh: "再同步一次" },
  "skills.empty.title": { en: "No skills installed", zh: "还没有安装 Skill" },
  "skills.empty.detail": { en: "Import one from owner/repo, or install a pack from the registry.", zh: "从 owner/repo 导入一个，或者从 Registry 装一个 Pack。" },
  "skills.view-all": { en: "View All Skills", zh: "查看全部 Skill" },
  "skills.enabled": { en: "Enabled", zh: "已启用" },
  "skills.disabled": { en: "Disabled", zh: "已停用" },

  // 快捷操作与最近活动：概览最下面那一排。
  "quick.subtitle": { en: "Common tasks and workflows.", zh: "常用任务与工作流。" },
  "quick.new-session": { en: "New {agent} Session", zh: "新建 {agent} Session" },
  "quick.continue-shared": { en: "Continue Shared Session", zh: "继续共享 Session" },
  // 灰掉的那一个旁边的话：两种灰各有各的原因，说的就是这两种。
  "quick.off-isolated": { en: "This project keeps sessions isolated.", zh: "这个项目把会话隔离开了。" },
  "quick.off-empty": { en: "No shared session to continue yet.", zh: "还没有可继续的共享会话。" },
  "quick.manage-skills": { en: "Manage Skills", zh: "管理 Skill" },
  "quick.view-logs": { en: "View Logs", zh: "查看日志" },
  "activity.title": { en: "Recent Activity", zh: "最近活动" },
  "activity.subtitle": { en: "View output and status.", zh: "查看输出与状态。" },
  "activity.empty-title": { en: "No recent activity.", zh: "最近没有活动。" },
  "activity.empty-detail": { en: "What you do in this panel shows up here, newest first.", zh: "你在这个面板里做的事会出现在这里，最新的在最上面。" },
  "activity.view-all": { en: "View All Activity", zh: "查看全部活动" },

  // 读的那一页：一条对话的头、每一轮、工具行、以及 Raw / Diagnostics 两种读法。
  "transcript.empty-title": { en: "Nothing is open yet", zh: "还没有打开任何会话" },
  "transcript.empty-detail": { en: "Pick a session on the left and its conversation is read here.", zh: "在左边点一条会话，它的对话就会在这里读出来。" },
  // 一段对话算不算共享历史，是这个项目的设置说了算，不是这一页猜的。
  "transcript.sub.shared": { en: "Shared history — the same conversation every agent sees.", zh: "共享历史——三个 Agent 看到的是同一段对话。" },
  "transcript.sub.isolated": { en: "This project keeps its sessions isolated.", zh: "这个项目把每个 Agent 的会话彼此隔离。" },
  "transcript.set-active": { en: "Set as Active", zh: "设为当前会话" },
  "transcript.raw": { en: "Raw", zh: "原始" },
  "transcript.diagnostics": { en: "Diagnostics", zh: "诊断" },
  "transcript.fact.participants": { en: "Participants", zh: "参与者" },
  "transcript.fact.updated": { en: "Updated", zh: "更新时间" },
  "transcript.fact.events": { en: "Event count", zh: "事件数" },
  "transcript.fact.sync": { en: "Sync state", zh: "同步状态" },
  "transcript.events": { en: "{count} events", zh: "{count} 条事件" },
  "transcript.showing-turns": { en: "Showing the newest {shown} of {total} turns.", zh: "只显示最新的 {shown} 轮，共 {total} 轮。" },
  // 工具的两种动词：它跑过什么、它带回来什么。工具不是发言人，所以它只说这两句。
  // （detail 外面那对括号不在这张表里——那一格只有括号和宿主给的参数，中文那一半会
  // 只剩全角括号、一个汉字都没有，过不了这门词表的闸门；它是标点，不是句子。）
  "transcript.tool.ran": { en: "ran", zh: "运行" },
  "transcript.tool.returned": { en: "returned", zh: "返回" },
  "transcript.raw.note": { en: "The turns this host sent, as they arrived — nothing added, nothing rewritten.", zh: "宿主送来的就是这些轮，原样画出来——没有添，也没有改。" },
  "transcript.diagnostics.note": { en: "Projection for this conversation: {state}.", zh: "这段对话的投影状态：{state}。" },
  "transcript.diagnostics.unknown": { en: "unknown", zh: "未知" },
  "transcript.diagnostics.empty-title": { en: "Nothing to report", zh: "没有要报告的内容" },
  "transcript.diagnostics.empty-detail": { en: "No projection of this conversation has anything to say about it.", zh: "这段对话的投影没有别的话要说。" },
  "transcript.diagnostics.warning": { en: "Warning", zh: "警告" },
  "transcript.diagnostics.note-tone": { en: "Note", zh: "提示" },
  "transcript.new-messages": { en: "New messages ↓", zh: "有新消息 ↓" },

  "shell.unknown-error": { en: "Unknown error", zh: "未知错误" },
} as const satisfies Record<string, TextPair>;

/**
 * A sentence with a hole in it (`Project: {name}`). The hole keeps its place in
 * both languages, so the caller never assembles grammar out of fragments — the
 * full-width colon in Chinese is inside the sentence, where it belongs.
 */
export function fill(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, String(value)), template);
}

export type TextKey = keyof typeof TEXT;

/** The canonical label. Every host reads this one. */
export function en(key: TextKey, values?: Record<string, string | number>): string {
  return halves(key, values).en;
}

/** The weaker half of the pair — never a label on its own. */
export function zh(key: TextKey, values?: Record<string, string | number>): string {
  return halves(key, values).zh;
}

/** `Overview / 总览` — a tooltip or accessible name that holds both. */
export function both(key: TextKey): string {
  return `${TEXT[key].en} / ${TEXT[key].zh}`;
}

/**
 * The editor's own language decides how loudly Chinese speaks. In a Chinese
 * editor the second half is visible text; in any other it waits in the tooltip,
 * because the canonical English label is the one that must never be crowded out.
 */
export function chineseVisible(language: string): boolean {
  return language.toLowerCase().startsWith("zh");
}

/**
 * The single half a one-sentence surface shows: a notification, a warning, the
 * text under a QuickPick. A tooltip or an accessible name can carry both halves
 * at once, but a notification that said everything twice would just be noise —
 * so the editor's own language picks, and English is what every other language
 * gets.
 */
export function sentence(language: string, key: TextKey, values?: Record<string, string | number>): string {
  const half = halves(key, values);
  return chineseVisible(language) ? half.zh : half.en;
}

/** Both halves of one entry, holes filled where the caller brought values. */
function halves(key: TextKey, values?: Record<string, string | number>): TextPair {
  return values === undefined ? TEXT[key] : { en: fill(TEXT[key].en, values), zh: fill(TEXT[key].zh, values) };
}

/**
 * 一句还没被说出来的话：带着键和洞，不带语言。服务层没有 vscode，不知道编辑器现在是哪种
 * 语言——它抛这个；说这句话的地方（宿主命令层）把它翻出来。message 用词表里的英文：它是
 * 产品的主语言，也是日志、堆栈和测试看到的那个。
 */
export class LocalizedError extends Error {
  readonly key: TextKey;
  readonly values?: Record<string, string | number>;
  // 字段显式声明而不是构造参数属性：Node 的 strip-only 模式（本仓库的单测跑法）不认后者。
  constructor(key: TextKey, values?: Record<string, string | number>) {
    super(en(key, values));
    this.name = "LocalizedError";
    this.key = key;
    this.values = values;
  }
}

/**
 * The one line a host list row (a QuickPick item, a tree row) carries: the
 * canonical English label, with the Chinese half beside it only when the editor
 * itself is Chinese. Anywhere else the row says one thing — a list that printed
 * both halves in every locale would be noise, and the English term of art is the
 * one this product means.
 */
export function rowLabel(language: string, key: TextKey, values?: Record<string, string | number>): string {
  const half = halves(key, values);
  return chineseVisible(language) ? `${half.en} · ${half.zh}` : half.en;
}

/**
 * The script `{{text}}` becomes. `</script>` cannot appear inside a JSON string
 * literal here, and the table holds no HTML at all, but the escaping is cheap
 * and the failure it prevents is a broken page.
 */
export function textScript(language: string): string {
  const payload = JSON.stringify({ text: TEXT, zhVisible: chineseVisible(language) }).replaceAll("<", "\\u003c");
  return `globalThis.AVENIC_TEXT = ${payload};`;
}
