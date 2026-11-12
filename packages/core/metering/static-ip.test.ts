import type { DetachedIpRow, NewLifecycleNotification, Tx } from "@tc/db";
import { describe, expect, it } from "vitest";
import type { PostTransactionInput } from "../ledger/types";
import type { StaticIpPrice } from "../products/static-ip-price";
import type { Result } from "../types";
import {
  STATIC_IP_METRIC,
  STATIC_IP_NOTICE_PREFIX,
  dhakaHour,
  runStaticIpMetering,
  staticIpIsCharging,
  staticIpChargeableHours,
  type StaticIpOps,
} from "./index";

// WPU-M1. An unattached static IP is charged as Amazon Lightsail does: free while attached, and USD
// 0.005 an hour once it has been unattached for MORE than one hour. The charge is the existing
// metered_charge posting, one per IP and hour bucket (R7). These tests have no database.

const RES = (n: number): string => `0190a000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const CUST = (n: number): string => `0190b000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const D0 = new Date("2026-11-12T10:00:00.000Z"); // detached at 10:00Z, 16:00 in Dhaka
const at = (hhmm: string): Date => new Date(`2026-11-12T${hhmm}:00.000Z`);
const PRICE = 74n;

function world(init: {
  rows?: DetachedIpRow[];
  price?: Result<StaticIpPrice>;
  balances?: Map<string, bigint>;
  failFor?: string;
}) {
  const posted = new Map<string, PostTransactionInput>();
  const notices = new Map<string, NewLifecycleNotification>();
  const state = { priceCalls: 0, postCalls: 0 };
  const ops: StaticIpOps = {
    list: async (_tx, afterId, limit) =>
      (init.rows ?? [])
        .filter((r) => afterId === null || r.resourceId > afterId)
        .sort((a, b) => a.resourceId.localeCompare(b.resourceId))
        .slice(0, limit),
    price: async () => {
      state.priceCalls += 1;
      return init.price ?? { ok: true, value: { unit: "hour", perHourMinor: PRICE } };
    },
    hasCharge: async (_tx, key) => posted.has(key),
    post: async (_tx, input): Promise<Result<{ transactionId: string }>> => {
      state.postCalls += 1;
      if (init.failFor !== undefined && input.reference.id === init.failFor) {
        throw new Error("boom secret-value");
      }
      const wallet = input.postings.find((p) => p.account.type === "customer_wallet")!;
      const customerId = (wallet.account as { customerId: string }).customerId;
      const balance = init.balances?.get(customerId) ?? 1_000_000n;
      if (balance < wallet.amountMinor) {
        return { ok: false, error: "insufficient_balance", data: { shortfallMinor: 1n } };
      }
      init.balances?.set(customerId, balance - wallet.amountMinor);
      posted.set(input.idempotencyKey, input);
      return { ok: true, value: { transactionId: input.idempotencyKey } };
    },
    notify: async (_tx, n) => {
      if (notices.has(n.dedupeKey)) return false;
      notices.set(n.dedupeKey, n);
      return true;
    },
  };
  const logs: Record<string, unknown>[] = [];
  const run = (now: Date) =>
    runStaticIpMetering({
      runTx: (fn) => fn({} as Tx),
      clock: { now: () => now },
      log: (e) => logs.push(e as never),
      ops,
    });
  return { run, posted, notices, state, logs };
}

const row = (n: number, detachedAt: Date | null = D0, customer = 1): DetachedIpRow => ({
  resourceId: RES(n),
  customerId: CUST(customer),
  market: "BD",
  detachedAt,
});

describe("the hour buckets of a detached IP", () => {
  it("dhakaHour reads the clock at UTC+6, down to the hour", () => {
    expect(dhakaHour(at("10:59"))).toBe("2026-11-12T16");
    expect(dhakaHour(new Date("2026-11-12T18:00:00Z"))).toBe("2026-11-13T00");
  });

  it("exactly one hour after the detach nothing is due; one minute later the current hour is", () => {
    expect(staticIpChargeableHours(D0, at("10:30"))).toEqual([]);
    expect(staticIpChargeableHours(D0, at("11:00"))).toEqual([]);
    expect(staticIpChargeableHours(D0, new Date("2026-11-12T11:00:00.001Z"))).toEqual([
      "2026-11-12T17",
    ]);
    expect(staticIpChargeableHours(D0, at("11:01"))).toEqual(["2026-11-12T17"]);
  });

  it("a run that was missed catches up two hours at most, oldest first, and never an hour before the first charge", () => {
    expect(staticIpChargeableHours(D0, at("13:30"))).toEqual([
      "2026-11-12T17",
      "2026-11-12T18",
      "2026-11-12T19",
    ]);
    expect(staticIpChargeableHours(D0, at("12:10"))).toEqual(["2026-11-12T17", "2026-11-12T18"]);
    // Detached long ago: the same three buckets, nothing older.
    expect(staticIpChargeableHours(new Date("2026-11-01T00:00:00Z"), at("13:30"))).toHaveLength(3);
  });

  it("staticIpIsCharging is true only after MORE than one hour unattached (the badge of the screens)", () => {
    expect(staticIpIsCharging(D0, at("10:59"))).toBe(false);
    expect(staticIpIsCharging(D0, at("11:00"))).toBe(false);
    expect(staticIpIsCharging(D0, at("11:01"))).toBe(true);
    expect(staticIpIsCharging(at("14:00"), at("13:30"))).toBe(false);
  });

  it("a detach in the future of the clock is not due (a bad stamp is not a charge)", () => {
    expect(staticIpChargeableHours(at("14:00"), at("13:30"))).toEqual([]);
  });
});

describe("charging an unattached static IP", () => {
  it("at exactly 1 hour there is no charge; at 1 hour 1 minute it begins with one metered_charge", async () => {
    const w = world({ rows: [row(1)] });
    expect(await w.run(at("11:00"))).toMatchObject({ charged: 0, notDue: 1, failed: 0 });
    expect(w.posted.size).toBe(0);
    expect(w.state.priceCalls).toBe(0); // nothing due, nothing priced

    const report = await w.run(at("11:01"));
    expect(report).toMatchObject({ charged: 1, replayed: 0, failed: 0, priceMissing: false });
    const key = `meter:${RES(1)}:${STATIC_IP_METRIC}:2026-11-12T17`;
    expect([...w.posted.keys()]).toEqual([key]);
    const input = w.posted.get(key)!;
    expect(input.kind).toBe("metered_charge");
    expect(input.reference).toEqual({ type: "resource", id: RES(1) });
    expect(input.actor).toEqual({ type: "system" });
    expect(input.memo).toBe("static_ip_unattached");
    expect(input.postings).toEqual([
      {
        account: { type: "customer_wallet", customerId: CUST(1) },
        direction: "debit",
        amountMinor: PRICE,
      },
      { account: { type: "revenue_aws_base" }, direction: "credit", amountMinor: PRICE },
    ]);
  });

  it("a repeat run in the same hour charges nothing more (R7)", async () => {
    const w = world({ rows: [row(1)] });
    await w.run(at("11:01"));
    for (const t of ["11:02", "11:30", "11:59"]) {
      expect(await w.run(at(t))).toMatchObject({ charged: 0, replayed: 1, failed: 0 });
    }
    expect(w.posted.size).toBe(1);
    expect(w.state.postCalls).toBe(1);
  });

  it("the next hour is one more charge and the earlier hours stay replays", async () => {
    const w = world({ rows: [row(1)] });
    await w.run(at("11:01"));
    expect(await w.run(at("12:05"))).toMatchObject({ charged: 1, replayed: 1 });
    expect(w.posted.size).toBe(2);
  });

  it("a missed run is made good for two hours and no further", async () => {
    const w = world({ rows: [row(1)] });
    expect(await w.run(at("13:30"))).toMatchObject({ charged: 3 });
    expect([...w.posted.keys()].sort()).toEqual([
      `meter:${RES(1)}:static_ip_hour:2026-11-12T17`,
      `meter:${RES(1)}:static_ip_hour:2026-11-12T18`,
      `meter:${RES(1)}:static_ip_hour:2026-11-12T19`,
    ]);
  });

  it("an attached IP is not in the list, so a charge stops at the attach", async () => {
    const rows = [row(1)];
    const w = world({ rows });
    await w.run(at("11:01"));
    rows.length = 0; // the attach clears detachedAt: the repository no longer lists it
    expect(await w.run(at("12:30"))).toMatchObject({ charged: 0, replayed: 0, notDue: 0 });
    expect(w.posted.size).toBe(1);
  });

  it("a detached IP without a time is not charged and is counted (fail closed)", async () => {
    const w = world({ rows: [row(1, null)] });
    expect(await w.run(at("15:00"))).toMatchObject({ charged: 0, noTimestamp: 1, failed: 0 });
    expect(w.posted.size).toBe(0);
    expect(w.logs.some((l) => l["event"] === "static_ip_no_timestamp")).toBe(true);
  });

  it("an empty wallet posts nothing, sends one notice a day and tries again the next run", async () => {
    const balances = new Map([[CUST(1), 10n]]);
    const w = world({ rows: [row(1)], balances });
    expect(await w.run(at("11:01"))).toMatchObject({ charged: 0, unpaid: 1, failed: 0 });
    expect(w.posted.size).toBe(0);
    expect(balances.get(CUST(1))).toBe(10n); // never below zero
    expect([...w.notices.keys()]).toEqual([
      `lifecycle:lifecycle_metered_unpaid:${RES(1)}:${STATIC_IP_NOTICE_PREFIX}:2026-11-12:email`,
    ]);
    const notice = [...w.notices.values()][0]!;
    expect(notice).toMatchObject({ customerId: CUST(1), template: "lifecycle_metered_unpaid" });
    expect(notice.payload).toMatchObject({ resourceId: RES(1), metric: STATIC_IP_METRIC });
    // The same day again: still unpaid, no second notice.
    await w.run(at("11:30"));
    expect(w.notices.size).toBe(1);
    // After a top-up the next run posts the charge.
    balances.set(CUST(1), 1_000n);
    expect(await w.run(at("11:45"))).toMatchObject({ charged: 1, unpaid: 0 });
    expect(balances.get(CUST(1))).toBe(1_000n - PRICE);
  });

  it("no price in force: nothing is charged, nothing throws, the run says so (R16)", async () => {
    const w = world({ rows: [row(1)], price: { ok: false, error: "not_found", fields: {} } });
    expect(await w.run(at("12:00"))).toMatchObject({ charged: 0, priceMissing: true, failed: 0 });
    expect(w.posted.size).toBe(0);
  });

  it("a price that rounds to zero paisa charges nothing", async () => {
    const w = world({
      rows: [row(1)],
      price: { ok: true, value: { unit: "hour", perHourMinor: 0n } },
    });
    expect(await w.run(at("12:00"))).toMatchObject({ charged: 0, skipped: 1 });
  });

  it("the price is read once for each market in a run", async () => {
    const w = world({ rows: [row(1), row(2), row(3, D0, 2)] });
    await w.run(at("12:00"));
    expect(w.state.priceCalls).toBe(1);
  });

  it("one IP that fails does not stop the others and leaves no secret in the log", async () => {
    const w = world({ rows: [row(1), row(2)], failFor: RES(1) });
    const report = await w.run(at("12:00"));
    expect(report.failed).toBeGreaterThan(0);
    expect(report.charged).toBeGreaterThan(0);
    expect(JSON.stringify(w.logs)).not.toContain("secret");
  });
});
