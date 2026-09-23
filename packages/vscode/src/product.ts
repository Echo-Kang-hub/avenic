// 这套产品里属于「扩展之外、但扩展要说得出」的两个常量。
//
// core 是被 esbuild 打进扩展里的：运行时没有第二份 core 可读，也没有哪一次探测能问出
// 它的版本，所以它只能是一个常量——test/about.test.ts 拿 packages/core/package.json
// 对住它，core 发版而这里忘了改会红，而不是显示一个假的版本。
//
// 文档那一行同理：它必须是真正存在的地址。随包 README 是 VSIX 里的东西，页面上的
// 「文档」指着它就是把一条关于产品的路标指向开发机的目录；这里给的是仓库自己的地址，
// 同一个测试拿 package.json 的 repository 对住它。

export const CORE_VERSION = "1.6.6";

export const DOCS_URL = "https://github.com/Echo-Kang-hub/avenic";
