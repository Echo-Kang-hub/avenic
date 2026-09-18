import { rm } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { extensionBuildOptions } from "./build-options.mjs";

const directory = import.meta.dirname;
// 清理旧产物：esbuild 不会删除过期输出（如曾开启 sourcemap 时遗留的 .map），避免其随 VSIX 发布
await rm(path.join(directory, "dist"), { recursive: true, force: true });
await build(extensionBuildOptions({ directory, outfile: path.join(directory, "dist", "extension.js") }));
console.log("built dist/extension.js");
