import { observeSharedNativeSessions } from "./session-interop.mjs";

// The default interval between durability passes while an agent is running.
// Every pass is a stat-only check unless native history actually moved, so the
// cost of being wrong here is small; the cost of a late pass is a session that
// only exists in a process that is about to disappear.
export const WATCH_INTERVAL_MS = 3000;

// One durability pass. It is deliberately the same primitive as the exit
// capture and startup recovery, with two changes that make it safe to run
// while another process owns the terminal: it never selects the active session
// (a background pass must not move the user's cursor) and it only re-reads the
// native roots this project already matched.
export async function flushNativeSessions(projectRoot, agentId, options = {}) {
  return observeSharedNativeSessions(projectRoot, agentId, {
    ...options,
    knownOnly: true,
    setActive: false,
  });
}

/**
 * Poll for new native history until stopped. Returns a controller; the caller
 * owns process lifetime. `onError` receives a failure instead of throwing, so
 * a broken pass can never kill the agent the watch exists to protect.
 */
export function startNativeWatch(projectRoot, agentId, options = {}) {
  const intervalMs = options.intervalMs ?? WATCH_INTERVAL_MS;
  const environment = options.environment ?? process.env;
  const onError = options.onError ?? (() => {});
  let stopped = false;
  let running = null;
  let timer = null;

  const pass = async () => {
    try {
      await flushNativeSessions(projectRoot, agentId, { environment });
    } catch (error) {
      onError(error);
    }
  };

  const tick = () => {
    if (stopped || running) return;
    running = pass().finally(() => { running = null; });
  };

  timer = setInterval(tick, intervalMs);
  // A background durability pass must not be a reason for the process to stay
  // alive on its own.
  timer.unref?.();

  return {
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
    /** Wait for an in-flight pass, so callers can stop without racing it. */
    async drain() {
      this.stop();
      await running;
    },
  };
}
