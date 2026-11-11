import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_CALLS, POLL_MS, startWatcher } from "./watcher-core.ts";
import type { WatcherDeps } from "./watcher-core.ts";

// The timing rules of the status page, with fake timers: first call after 8 s and never more often,
// at most 15 calls, stop at the first final state, pause while the tab is hidden, clean up.

type Reply = { state: string; review: boolean; retryAfterSeconds?: number };

function make(replies: Reply[] | (() => Reply) = () => ({ state: "pending", review: false })) {
  let visible = true;
  const calls: number[] = [];
  const phases: string[] = [];
  const refresh = vi.fn();
  let index = 0;
  const deps: WatcherDeps = {
    recheck: async () => {
      calls.push(Date.now());
      const reply =
        typeof replies === "function" ? replies() : (replies[index++] ?? replies.at(-1));
      return reply as never;
    },
    refresh,
    visible: () => visible,
    onPhase: (phase) =>
      phases.push(phase.kind === "waiting" ? `waiting:${phase.seconds}` : phase.kind),
  };
  return {
    deps,
    calls,
    phases,
    refresh,
    hide: () => (visible = false),
    show: () => (visible = true),
  };
}

beforeEach(() => vi.useFakeTimers({ now: 0 }));
afterEach(() => vi.useRealTimers());

describe("startWatcher", () => {
  it("makes no call before 8 s, then one call", async () => {
    const m = make();
    startWatcher(m.deps);
    await vi.advanceTimersByTimeAsync(POLL_MS - 1);
    expect(m.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(m.calls).toEqual([POLL_MS]);
  });

  it("never calls more often than every 8 s and stops after 15 calls with the 'stopped' phase", async () => {
    const m = make();
    startWatcher(m.deps);
    await vi.advanceTimersByTimeAsync(POLL_MS * 40);
    expect(m.calls).toHaveLength(MAX_CALLS);
    for (let i = 1; i < m.calls.length; i++) {
      expect((m.calls[i] as number) - (m.calls[i - 1] as number)).toBeGreaterThanOrEqual(POLL_MS);
    }
    expect(m.phases.at(-1)).toBe("stopped");
    expect(m.refresh).not.toHaveBeenCalled();
  });

  it("stops at the first final state and refreshes the route exactly once", async () => {
    const m = make([
      { state: "pending", review: false },
      { state: "credited", review: false },
    ]);
    startWatcher(m.deps);
    await vi.advanceTimersByTimeAsync(POLL_MS * 10);
    expect(m.calls).toHaveLength(2);
    expect(m.refresh).toHaveBeenCalledTimes(1);
  });

  it("failed, cancelled, expired and unknown are final too; so is a payment that went to review", async () => {
    for (const reply of [
      { state: "failed", review: false },
      { state: "cancelled", review: false },
      { state: "expired", review: false },
      { state: "unknown", review: false },
      { state: "pending", review: true },
    ]) {
      const m = make([reply]);
      startWatcher(m.deps);
      await vi.advanceTimersByTimeAsync(POLL_MS * 5);
      expect(m.calls, reply.state).toHaveLength(1);
      expect(m.refresh, reply.state).toHaveBeenCalledTimes(1);
    }
  });

  it("pauses while the tab is hidden (no call, not counted) and goes on when it is visible again", async () => {
    const m = make();
    m.hide();
    startWatcher(m.deps);
    await vi.advanceTimersByTimeAsync(POLL_MS * 5);
    expect(m.calls).toEqual([]);
    m.show();
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(m.calls).toHaveLength(1);
  });

  it("a rate_limited answer (retryAfterSeconds) waits that long, then reads again", async () => {
    const m = make([
      { state: "pending", review: false, retryAfterSeconds: 20 },
      { state: "credited", review: false },
    ]);
    startWatcher(m.deps);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(m.calls).toHaveLength(1);
    expect(m.phases).toContain("waiting:20");
    await vi.advanceTimersByTimeAsync(19_999);
    expect(m.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(m.calls).toHaveLength(2);
    expect(m.refresh).toHaveBeenCalledTimes(1);
  });

  it("a call that throws counts as pending and the watcher goes on", async () => {
    const m = make();
    let n = 0;
    m.deps.recheck = async () => {
      n++;
      throw new Error("network");
    };
    startWatcher(m.deps);
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(n).toBe(3);
    expect(m.refresh).not.toHaveBeenCalled();
  });

  it("the stop function clears the timer: no call, and an answer in flight does not refresh", async () => {
    const early = make();
    const stop = startWatcher(early.deps);
    stop();
    await vi.advanceTimersByTimeAsync(POLL_MS * 5);
    expect(early.calls).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);

    let release: (reply: Reply) => void = () => {};
    const late = make();
    late.deps.recheck = () => new Promise<never>((resolve) => (release = resolve as never));
    const stopLate = startWatcher(late.deps);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    stopLate();
    release({ state: "credited", review: false });
    await vi.advanceTimersByTimeAsync(POLL_MS * 5);
    expect(late.refresh).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
