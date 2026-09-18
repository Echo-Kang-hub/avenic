import path from "node:path";

// One definition of what the production bundle is. `build.mjs` writes it to
// dist/ for the VSIX; the tests build the same bundle to answer "does what
// ships still contain core, and does it register what the manifest declares?"
// Keeping the options here is what makes those two questions the same question.
export function extensionBuildOptions({ directory, outfile }) {
  return {
    entryPoints: [path.join(directory, "src", "extension.ts")],
    bundle: true,
    outfile,
    format: "esm",
    platform: "node",
    target: "node20",
    external: ["vscode"],
    sourcemap: false,
    minify: true, // T12 生产构建开 minify
  };
}
