// 活动栏图标下那一行视图的 id，全仓唯一来源。
//
// 清单里声明它、这里注册 provider、view/title 的 when 指向它、将来任何要聚焦它的路径
// 也叫这个名字。各写一遍字面量时，它们会在原地升级那一刻分叉：工作台按新清单要
// avenic.launcher，而还在跑的旧代码注册的是 0.5.5 之前那四个视图（avenic.agents /
// avenic.catalog / avenic.skills / avenic.overview），于是扩展主机拒绝渲染，
// VS Code 把 "No view is registered with id: …" 直接画在那一行里——一句话里既没有
// 原因，也没有用户能做的动作。
//
// 常量是防分叉的那一半；另一半在 extension.ts：先挂 provider，其余全部受保护。
export const DASHBOARD_VIEW_ID = "avenic.launcher";
