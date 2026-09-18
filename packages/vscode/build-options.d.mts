import type { BuildOptions } from "esbuild";

export function extensionBuildOptions(input: { directory: string; outfile: string }): BuildOptions;
