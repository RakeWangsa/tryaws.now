import type { RecheckState } from "../../../../../../server/topup-core.ts";

// The timing rules of the status page, apart from React so that they can be tested with fake timers.
// A payment is asked about every 8 s (the server allows one check per payment every 5 s), at most
// 15 times (two minutes), only while the tab is visible. A final state, or a payment that went to
// review, refreshes the route once and ends the watching. After that the sweeper settles the payment
// in the background for up to 24 hours (open point 20).

export const POLL_MS = 8000;
export const MAX_CALLS = 15;

export type WatcherPhase =
  { kind: "checking" } | { kind: "waiting"; seconds: number } | { kind: "stopped" };

export interface WatcherDeps {
  recheck(): Promise<RecheckState>;
  refresh(): void;
  visible(): boolean;
  onPhase(phase: WatcherPhase): void;
}

/** Starts watching; the returned function stops it (unmount): the timer is cleared and a late answer is dropped. */
export function startWatcher(deps: WatcherDeps): () => void {
  let stopped = false;
  let calls = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = (ms: number) => {
    timer = setTimeout(() => void tick(), ms);
  };

  const tick = async () => {
    timer = undefined;
    if (stopped) return;
    if (!deps.visible()) {
      schedule(POLL_MS);
      return;
    }
    calls += 1;
    deps.onPhase({ kind: "checking" });
    let reply: RecheckState;
    try {
      reply = await deps.recheck();
    } catch {
      reply = { state: "pending", review: false };
    }
    if (stopped) return;

    if (reply.state !== "pending" || reply.review) {
      stopped = true;
      deps.refresh();
      return;
    }
    if (calls >= MAX_CALLS) {
      stopped = true;
      deps.onPhase({ kind: "stopped" });
      return;
    }
    const seconds = reply.retryAfterSeconds;
    if (seconds !== undefined && seconds > 0) {
      deps.onPhase({ kind: "waiting", seconds });
      schedule(Math.max(POLL_MS, seconds * 1000));
    } else {
      schedule(POLL_MS);
    }
  };

  schedule(POLL_MS);
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
}
