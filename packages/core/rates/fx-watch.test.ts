import { describe, expect, it, vi } from "vitest";
import { FX_ALERT_EVENT, fxAlertWindowOpen, runFxRateWatch, type FxWatchOps } from "./fx-watch";

const DAY = 86_400_000;
// 10:00 in Dhaka (UTC+6) is 04:00 UTC.
const OPEN = new Date("2026-11-20T04:00:00.000Z");

describe("fxAlertWindowOpen", () => {
  it("is open for the first five minutes after 10:00 in Dhaka and shut otherwise", () => {
    expect(fxAlertWindowOpen(new Date("2026-11-20T03:59:59.999Z"))).toBe(false);
    expect(fxAlertWindowOpen(new Date("2026-11-20T04:00:00.000Z"))).toBe(true);
    expect(fxAlertWindowOpen(new Date("2026-11-20T04:04:59.999Z"))).toBe(true);
    expect(fxAlertWindowOpen(new Date("2026-11-20T04:05:00.000Z"))).toBe(false);
    expect(fxAlertWindowOpen(new Date("2026-11-20T16:00:00.000Z"))).toBe(false);
    expect(fxAlertWindowOpen(new Date("nope"))).toBe(false);
  });
});

function world(rateAge: number | null, markets = ["BD"]) {
  const log = vi.fn();
  const ops: FxWatchOps = {
    markets: async () => markets,
    inForce: async (_tx, _market, at) =>
      rateAge === null ? null : { effectiveFrom: new Date(at.getTime() - rateAge) },
  };
  const deps = (now: Date) => ({
    runTx: async <T>(fn: (tx: never) => Promise<T>) => fn(undefined as never),
    clock: { now: () => now },
    log,
    ops,
  });
  return { log, deps };
}

describe("runFxRateWatch", () => {
  it("a rate of 6 days or less raises nothing", async () => {
    const w = world(6 * DAY);
    const report = await runFxRateWatch(w.deps(OPEN));
    expect(report).toEqual({ checked: 1, alerted: 0, states: { BD: "fresh" } });
    expect(w.log).not.toHaveBeenCalled();
  });

  it("a rate older than 6 days raises one structured alert line, with no secret", async () => {
    const w = world(6 * DAY + 1000);
    const report = await runFxRateWatch(w.deps(OPEN));
    expect(report).toMatchObject({ alerted: 1, states: { BD: "ageing" } });
    expect(w.log).toHaveBeenCalledTimes(1);
    expect(w.log).toHaveBeenCalledWith({
      event: FX_ALERT_EVENT,
      severity: "alert",
      market: "BD",
      state: "ageing",
      ageDays: 6,
      alertAfterDays: 6,
      maxAgeDays: 7,
    });
    expect(FX_ALERT_EVENT).toBe("fx_rate_stale_warning");
  });

  it("a stale rate and a missing rate are alerts too", async () => {
    const stale = world(9 * DAY);
    await runFxRateWatch(stale.deps(OPEN));
    expect(stale.log.mock.calls[0]?.[0]).toMatchObject({ state: "stale", ageDays: 9 });
    const missing = world(null);
    await runFxRateWatch(missing.deps(OPEN));
    expect(missing.log.mock.calls[0]?.[0]).toMatchObject({ state: "missing", ageDays: null });
  });

  it("outside the daily window nothing is logged, so the alert is not repeated every minute", async () => {
    const w = world(9 * DAY);
    const report = await runFxRateWatch(w.deps(new Date("2026-11-20T04:05:00.000Z")));
    expect(report.alerted).toBe(0);
    expect(w.log).not.toHaveBeenCalled();
  });

  it("each market is checked on its own", async () => {
    const w = world(9 * DAY, ["BD", "KE"]);
    const report = await runFxRateWatch(w.deps(OPEN));
    expect(report.alerted).toBe(2);
  });

  it("a failing logger never breaks the pass", async () => {
    const w = world(9 * DAY);
    w.log.mockImplementation(() => {
      throw new Error("sink down");
    });
    await expect(runFxRateWatch(w.deps(OPEN))).resolves.toMatchObject({ checked: 1 });
  });
});
