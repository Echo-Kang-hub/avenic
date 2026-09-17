/** Development-only timing. Enable with AVENIC_VSCODE_PROFILE=1. */
const enabled = process.env.AVENIC_VSCODE_PROFILE === "1";

export function markPerformance(name: string, startedAt = performance.now()): void {
  if (!enabled) return;
  console.info(`[Avenic] ${name}: ${(performance.now() - startedAt).toFixed(1)}ms`);
}

export async function measurePerformance<T>(name: string, operation: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();
  try {
    return await operation();
  } finally {
    markPerformance(name, startedAt);
  }
}
