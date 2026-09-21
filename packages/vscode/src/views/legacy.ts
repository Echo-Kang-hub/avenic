// 0.5.5 之前的发行版贡献过、现在已经没有实现的入口。
//
// 用户自己的 keybindings.json 里可能还按着它们：一条别名让它落在同一场问答上，
// 而不是 "command not found"。这张表是 O(1) 的常量——不探测旧状态、不读盘、
// 不起进程（P22）；目标必须是当前清单里真有的命令，由测试从清单反查，所以它不会
// 悄悄指向一个不存在的东西。注册端在 extension.ts（一行 registerCommand）。
//
// 只收「意图还在、只是改了名字」的三条：老的三步（初始化 / 选认证 / 选会话）在最终
// 模型里是同一场问答的不同步，configureProject 就是那场问答。avenic.model.* 那一族
// （profile 库，0.5.4 之前一处已删除）不在这里：把一个按「删除 profile」的键绑悄悄
// 改成打开配置问答，比一条直白的 command not found 更坏——它做了别的事，还用着旧名字。
//
// 视图 id 没有别名可给：活动栏那一行由 VS Code 自己按清单画，旧清单留下的 id 在
// 新清单里不存在时工作台会忽略它（见 view-ids.ts 里那段升级窗口的说明）。这里能做的
// 只有让新 id 永远被注册。
export const LEGACY_COMMAND_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  "avenic.agents.init": "avenic.agents.configureProject",
  "avenic.agents.switchAuth": "avenic.agents.configureProject",
  "avenic.agents.switchSessions": "avenic.agents.configureProject",
});
