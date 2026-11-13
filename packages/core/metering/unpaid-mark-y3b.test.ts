import type { DetachedIpRow, Tx } from "@tc/db";
import { describe, expect, it } from "vitest";
import type { MeteredUnitPrice } from "../pricing/metering";
import { runMetering, runStaticIpMetering, type MeteringOps, type StaticIpOps } from "./index";
import { withInputs } from "../test/metered-inputs";

// WPU-Y3b findings 3 and 8. The normal passes record the failed static IP hours in the mark, and they
// stop writing the old `lifecycle_metered_unpaid` notice once the unpaid job (the single source of
// unpaid emails) is switched on.

const RES = "0190a000-0000-7000-8000-000000000001";
const CUST = "0190b000-0000-7000-8000-000000000001";
const NOW = new Date("2026-11-11T08:00:00Z");
const UNIT: MeteredUnitPrice = { totalMinor: 1000n, baseMinor: 1000n, steps: [] };

function ipWorld(enabled: boolean | undefined) {
  const marks: { id: string; hour: string | undefined }[] = [];
  const notices: string[] = [];
  const row: DetachedIpRow = {
    resourceId: RES,
    customerId: CUST,
    market: "BD",
    detachedAt: new Date("2026-11-11T05:00:00Z"),
  };
  const ops: StaticIpOps = {
    list: async (_tx, after) => (after === null ? [row] : []),
    price: async () => ({
      ok: true,
      value: {
        unit: "hour",
        perHourMinor: 77n,
        breakdown: withInputs({ totalMinor: 77n, baseMinor: 77n, steps: [] }),
      },
    }),
    hasCharge: async () => false,
    post: async () => ({ ok: false, error: "insufficient_balance" }),
    notify: async (_tx, n) => {
      notices.push(n.dedupeKey);
      return true;
    },
    markUnpaid: async (_tx, id, _at, hour) => {
      marks.push({ id, hour });
    },
    ...(enabled === undefined ? {} : { unpaidJobEnabled: async () => enabled }),
  };
  return { ops, marks, notices };
}

describe("the static IP pass records the failed hour (finding 3)", () => {
  it("passes the Dhaka hour of every failed charge to the mark", async () => {
    const w = ipWorld(undefined);
    await runStaticIpMetering({
      runTx: (fn) => fn({} as Tx),
      clock: { now: () => NOW },
      log: () => undefined,
      ops: w.ops,
    });
    // 08:00Z is 14:00 in Dhaka; the look-back is the current hour and two before
    expect(w.marks.map((m) => m.hour).sort()).toEqual([
      "2026-11-11T12",
      "2026-11-11T13",
      "2026-11-11T14",
    ]);
  });
});

describe("a single source of unpaid emails (finding 8)", () => {
  it("static IP: the old notice is still written while the unpaid job is off", async () => {
    for (const enabled of [undefined, false]) {
      const w = ipWorld(enabled);
      await runStaticIpMetering({
        runTx: (fn) => fn({} as Tx),
        clock: { now: () => NOW },
        log: () => undefined,
        ops: w.ops,
      });
      expect(w.notices.length).toBeGreaterThan(0);
    }
  });

  it("static IP: no old notice once the unpaid job is on, but the mark is still written", async () => {
    const w = ipWorld(true);
    await runStaticIpMetering({
      runTx: (fn) => fn({} as Tx),
      clock: { now: () => NOW },
      log: () => undefined,
      ops: w.ops,
    });
    expect(w.notices).toEqual([]);
    expect(w.marks.length).toBeGreaterThan(0);
  });

  const meterOps = (enabled: boolean, notices: string[]): MeteringOps => ({
    configPrice: async () => withInputs(UNIT),
    unpaidJobEnabled: async () => enabled,
    repo: () => ({
      readSettings: async () => new Map(),
      listUsage: async (metric, period, after) =>
        metric === "snapshot_gb" && period === "2026-11-10" && after === null
          ? [
              {
                id: "0190c000-0000-7000-8000-000000000001",
                resourceId: RES,
                customerId: CUST,
                market: "BD",
                quantity: "30",
              },
            ]
          : [],
      listTransfer: async () => [],
      insertNotification: async (n) => {
        notices.push(n.dedupeKey);
        return true;
      },
    }),
    hasCharge: async () => false,
    post: async () => ({ ok: false, error: "insufficient_balance" }),
    markUnpaid: async () => undefined,
  });

  it("snapshots: the old notice is written while the job is off and not once it is on", async () => {
    const off: string[] = [];
    await runMetering({
      runTx: (fn) => fn({} as Tx),
      clock: { now: () => NOW },
      log: () => undefined,
      ops: meterOps(false, off),
    });
    expect(off.length).toBe(1);
    const on: string[] = [];
    const report = await runMetering({
      runTx: (fn) => fn({} as Tx),
      clock: { now: () => NOW },
      log: () => undefined,
      ops: meterOps(true, on),
    });
    expect(on).toEqual([]);
    expect(report.unpaid).toBe(1);
  });
});
