import type { Tx } from "@tc/db";
import { describe, expect, it } from "vitest";
import type { MeteredUnitPrice } from "../pricing/metering";
import { runMetering, type MeteringOps } from "./index";
import { withInputs } from "../test/metered-inputs";

// WPU-Y3. The normal pass records the first failed charge (markUnpaid) so the unpaid job can retry from it.
const RES = "0190a000-0000-7000-8000-000000000001";
const CUST = "0190b000-0000-7000-8000-000000000001";
const NOW = new Date("2026-11-11T08:00:00Z");
const UNIT: MeteredUnitPrice = { totalMinor: 1000n, baseMinor: 1000n, steps: [] };

function ops(balance: bigint, marks: { id: string; at: Date }[]): MeteringOps {
  return {
    configPrice: async () => withInputs(UNIT),
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
      insertNotification: async () => true,
    }),
    hasCharge: async () => false,
    post: async (_tx, input) => {
      const wallet = input.postings.find((p) => p.account.type === "customer_wallet")!;
      return wallet.amountMinor > balance
        ? { ok: false, error: "insufficient_balance" }
        : { ok: true, value: { transactionId: "t" } };
    },
    markUnpaid: async (_tx, id, at) => {
      marks.push({ id, at });
    },
  };
}

describe("runMetering records the first failure", () => {
  it("marks the resource when the wallet is short", async () => {
    const marks: { id: string; at: Date }[] = [];
    const report = await runMetering({
      runTx: (fn) => fn({} as Tx),
      clock: { now: () => NOW },
      log: () => undefined,
      ops: ops(0n, marks),
    });
    expect(report.unpaid).toBe(1);
    expect(marks).toEqual([{ id: RES, at: NOW }]);
  });

  it("does not mark a resource whose charge was paid", async () => {
    const marks: { id: string; at: Date }[] = [];
    const report = await runMetering({
      runTx: (fn) => fn({} as Tx),
      clock: { now: () => NOW },
      log: () => undefined,
      ops: ops(10_000n, marks),
    });
    expect(report.charged).toBe(1);
    expect(marks).toEqual([]);
  });
});
