import type { NewLifecycleNotification, Tx } from "@tc/db";
import { describe, expect, it } from "vitest";
import { ledgerKey } from "../ledger/keys";
import type { PostTransactionInput } from "../ledger/types";
import type { Result } from "../types";
import {
  METERING_SETTING_KEYS,
  dhakaDay,
  dhakaMonth,
  runMetering,
  type MeteringOps,
} from "./index";

const RES = (n: number): string => `0190a000-0000-7000-8000-${String(n).padStart(12, "0")}`;
const CUST = (n: number): string => `0190b000-0000-7000-8000-${String(n).padStart(12, "0")}`;
// 2026-11-11 04:00 in Dhaka (UTC+6) is 2026-11-10 22:00Z; use a time that is the same date in both.
const NOW = new Date("2026-11-11T08:00:00Z"); // 14:00 in Dhaka, day 2026-11-11

interface Usage {
  id: string;
  resourceId: string;
  customerId: string;
  quantity: string;
  metric: string;
  period: string;
}
interface Transfer {
  resourceId: string;
  customerId: string;
  usedGb: string;
  allowanceGb: string;
  month: string;
}

function world(init: {
  price?: unknown;
  usage?: Usage[];
  transfer?: Transfer[];
  balances?: Map<string, bigint>;
  failFor?: string;
}) {
  const posted = new Map<string, PostTransactionInput>();
  const notices = new Map<string, NewLifecycleNotification>();
  const state = { postCalls: 0 };
  const settings = new Map<string, unknown>();
  if (init.price !== undefined)
    settings.set(METERING_SETTING_KEYS.snapshotGbMonthMinor, init.price);
  const ops: MeteringOps = {
    repo: () => ({
      readSettings: async (keys: readonly string[]) =>
        new Map([...settings].filter(([k]) => keys.includes(k))),
      listUsage: async (metric, period, afterId, limit) =>
        (init.usage ?? [])
          .filter(
            (u) =>
              u.metric === metric && u.period === period && (afterId === null || u.id > afterId),
          )
          .sort((a, b) => a.id.localeCompare(b.id))
          .slice(0, limit),
      listTransfer: async (month, afterId, limit) =>
        (init.transfer ?? [])
          .filter((t) => t.month === month && (afterId === null || t.resourceId > afterId))
          .sort((a, b) => a.resourceId.localeCompare(b.resourceId))
          .slice(0, limit),
      insertNotification: async (n) => {
        if (notices.has(n.dedupeKey)) return false;
        notices.set(n.dedupeKey, n);
        return true;
      },
    }),
    hasCharge: async (_tx, key) => posted.has(key),
    post: async (_tx, input): Promise<Result<{ transactionId: string }>> => {
      state.postCalls += 1;
      if (init.failFor !== undefined && input.reference.id === init.failFor)
        throw new Error("boom secret-value");
      const existing = posted.get(input.idempotencyKey);
      if (existing) return { ok: true, value: { transactionId: input.idempotencyKey } };
      const wallet = input.postings.find((p) => p.account.type === "customer_wallet");
      const customerId = (wallet?.account as { customerId: string }).customerId;
      const balance = init.balances?.get(customerId) ?? 1_000_000n;
      if (balance < wallet!.amountMinor) {
        return { ok: false, error: "insufficient_balance", data: { shortfallMinor: 1n } };
      }
      init.balances?.set(customerId, balance - wallet!.amountMinor);
      posted.set(input.idempotencyKey, input);
      return { ok: true, value: { transactionId: input.idempotencyKey } };
    },
  };
  const logs: Record<string, unknown>[] = [];
  const run = (now: Date = NOW, extra: { pageSize?: number } = {}) =>
    runMetering({
      runTx: (fn) => fn({} as Tx),
      clock: { now: () => now },
      log: (e) => logs.push(e as never),
      ops,
      ...extra,
    });
  return { run, posted, notices, state, logs };
}

const snap = (n: number, qty: string, period: string, customer = 1): Usage => ({
  id: `0190c000-0000-7000-8000-${String(n).padStart(12, "0")}`,
  resourceId: RES(n),
  customerId: CUST(customer),
  quantity: qty,
  metric: "snapshot_gb",
  period,
});

describe("days in Dhaka time", () => {
  it("dhakaDay and dhakaMonth read the clock at UTC+6", () => {
    expect(dhakaDay(new Date("2026-11-11T17:59:59Z"))).toBe("2026-11-11");
    expect(dhakaDay(new Date("2026-11-11T18:00:00Z"))).toBe("2026-11-12");
    expect(dhakaMonth(new Date("2026-11-30T18:00:00Z"))).toBe("2026-12");
  });
});

describe("snapshot storage: one charge per resource and day", () => {
  it("the daily charge is GB x price / 30 in paisa, as one metered_charge of the wallet against revenue", async () => {
    const w = world({ price: "300", usage: [snap(1, "10.000000", "2026-11-10")] });
    const report = await w.run();
    expect(report).toMatchObject({ charged: 1, replayed: 0, unpaid: 0, failed: 0 });
    const key = ledgerKey.metered(RES(1), "snapshot_gb", "2026-11-10");
    const tx = w.posted.get(key)!;
    expect(tx.kind).toBe("metered_charge");
    expect(tx.reference).toEqual({ type: "resource", id: RES(1) });
    expect(tx.actor).toEqual({ type: "system" });
    expect(tx.postings).toEqual([
      {
        account: { type: "customer_wallet", customerId: CUST(1) },
        direction: "debit",
        amountMinor: 100n,
      },
      { account: { type: "revenue_aws_base" }, direction: "credit", amountMinor: 100n },
    ]);
  });

  it("rounds half-up: 1 GB at 105 paisa a month is 4 paisa a day", async () => {
    const w = world({ price: 105, usage: [snap(1, "1.000000", "2026-11-10")] });
    await w.run();
    const tx = w.posted.get(ledgerKey.metered(RES(1), "snapshot_gb", "2026-11-10"))!;
    expect(tx.postings[0]!.amountMinor).toBe(4n);
  });

  it("charges the day that ended in Dhaka: at 00:30 Dhaka on the 12th that is the 11th", async () => {
    const w = world({
      price: "300",
      usage: [snap(1, "10", "2026-11-11"), snap(2, "10", "2026-11-12")],
    });
    await w.run(new Date("2026-11-11T18:30:00Z"));
    expect([...w.posted.keys()]).toEqual([ledgerKey.metered(RES(1), "snapshot_gb", "2026-11-11")]);
  });

  it("a second run is a replay: no second transaction, no second post call for a charged day", async () => {
    const w = world({ price: "300", usage: [snap(1, "10", "2026-11-10")] });
    await w.run();
    const calls = w.state.postCalls;
    const again = await w.run();
    expect(again).toMatchObject({ charged: 0, replayed: 1, failed: 0 });
    expect(w.state.postCalls).toBe(calls);
    expect(w.posted.size).toBe(1);
  });

  it("catches up the two days before, and no older one", async () => {
    const w = world({
      price: "300",
      usage: [
        snap(1, "10", "2026-11-10"),
        snap(2, "10", "2026-11-09"),
        snap(3, "10", "2026-11-08"),
        snap(4, "10", "2026-11-07"),
      ],
    });
    const report = await w.run();
    expect(report.charged).toBe(3);
    expect(w.posted.has(ledgerKey.metered(RES(4), "snapshot_gb", "2026-11-07"))).toBe(false);
  });

  it("skips a zero amount and writes nothing for it", async () => {
    const w = world({ price: "300", usage: [snap(1, "0.000000", "2026-11-10")] });
    expect(await w.run()).toMatchObject({ charged: 0, skipped: 1 });
    expect(w.posted.size).toBe(0);
  });

  it("goes through every page of rows", async () => {
    const usage = [1, 2, 3, 4, 5].map((n) => snap(n, "30", "2026-11-10", n));
    const w = world({ price: "100", usage });
    const report = await w.run(NOW, { pageSize: 2 });
    expect(report.charged).toBe(5);
  });

  it("a wallet that is short is unpaid: nothing posted, one notice per resource and day, run goes on", async () => {
    const balances = new Map([[CUST(1), 10n]]);
    const w = world({
      price: "300",
      balances,
      usage: [snap(1, "10", "2026-11-10", 1), snap(2, "10", "2026-11-10", 2)],
    });
    const report = await w.run();
    expect(report).toMatchObject({ charged: 1, unpaid: 1, failed: 0 });
    expect(w.posted.has(ledgerKey.metered(RES(1), "snapshot_gb", "2026-11-10"))).toBe(false);
    const unpaid = [...w.notices.values()].filter((n) => n.template === "lifecycle_metered_unpaid");
    expect(unpaid).toHaveLength(1);
    expect(unpaid[0]).toMatchObject({ customerId: CUST(1), channel: "email" });
    await w.run();
    expect(
      [...w.notices.values()].filter((n) => n.template === "lifecycle_metered_unpaid"),
    ).toHaveLength(1);
  });

  it.each([undefined, "", "abc", "-5", "1.5", 1.5, -1, null, {}, "99999999999999999999"])(
    "a missing or unreadable price (%j) charges nothing and is reported (fail closed)",
    async (price) => {
      const w = world({ price, usage: [snap(1, "10", "2026-11-10")] });
      const report = await w.run();
      expect(report).toMatchObject({ charged: 0, priceMissing: true });
      expect(report.failed).toBeGreaterThan(0);
      expect(w.state.postCalls).toBe(0);
    },
  );

  it("a failing row is counted and logged by error name only; the other rows go on", async () => {
    const w = world({
      price: "300",
      failFor: RES(1),
      usage: [snap(1, "10", "2026-11-10"), snap(2, "10", "2026-11-10")],
    });
    const report = await w.run();
    expect(report).toMatchObject({ charged: 1, failed: 1 });
    expect(JSON.stringify(w.logs)).not.toContain("secret-value");
  });

  it("a row whose resource id is not a UUID is failed, not charged", async () => {
    const bad = { ...snap(1, "10", "2026-11-10"), resourceId: "not-a-uuid" };
    const w = world({ price: "300", usage: [bad] });
    expect(await w.run()).toMatchObject({ charged: 0, failed: 1 });
  });
});

describe("data transfer notices at 80% and 100%", () => {
  const tr = (n: number, used: string, allowance = "1000", month = "2026-11"): Transfer => ({
    resourceId: RES(n),
    customerId: CUST(n),
    usedGb: used,
    allowanceGb: allowance,
    month,
  });

  it("writes nothing below 80%", async () => {
    const w = world({ price: "300", transfer: [tr(1, "799.99")] });
    expect(await w.run()).toMatchObject({ notified80: 0, notified100: 0 });
    expect(w.notices.size).toBe(0);
  });

  it("writes one 80% notice at 80% and none again on the next run", async () => {
    const w = world({ price: "300", transfer: [tr(1, "800")] });
    expect(await w.run()).toMatchObject({ notified80: 1, notified100: 0 });
    expect(await w.run()).toMatchObject({ notified80: 0, notified100: 0 });
    const [n] = [...w.notices.values()];
    expect(n).toMatchObject({
      customerId: CUST(1),
      channel: "email",
      template: "lifecycle_transfer_80",
    });
    expect(n!.dedupeKey).toBe(`lifecycle:lifecycle_transfer_80:${RES(1)}:2026-11:email`);
    expect(n!.payload).toEqual({
      resourceId: RES(1),
      period: "2026-11",
      level: 80,
      usedGb: "800",
      allowanceGb: "1000",
    });
  });

  it("writes the 100% notice when the use reaches the allowance, once (only the highest level reached is written)", async () => {
    const w = world({ price: "300", transfer: [tr(1, "1000")] });
    expect(await w.run()).toMatchObject({ notified80: 0, notified100: 1 });
    expect(await w.run()).toMatchObject({ notified100: 0 });
    expect([...w.notices.values()].map((n) => n.template)).toEqual(["lifecycle_transfer_100"]);
  });

  it("a new month starts new notices", async () => {
    const w = world({
      price: "300",
      transfer: [tr(1, "900", "1000", "2026-11"), tr(1, "900", "1000", "2026-12")],
    });
    await w.run();
    await w.run(new Date("2026-12-05T08:00:00Z"));
    expect(w.notices.size).toBe(2);
  });

  it("holds no email, phone or name in the payload (R14)", async () => {
    const w = world({ price: "300", transfer: [tr(1, "1200")] });
    await w.run();
    const text = JSON.stringify([...w.notices.values()].map((n) => n.payload));
    expect(text).not.toMatch(/@|\+880|name/i);
  });

  it("an allowance that is not above zero is skipped and counted as failed, not as a notice", async () => {
    const w = world({ price: "300", transfer: [tr(1, "5", "0")] });
    expect(await w.run()).toMatchObject({ notified80: 0, notified100: 0, failed: 1 });
  });

  it("runs the notices even when the price is missing", async () => {
    const w = world({ transfer: [tr(1, "1000")] });
    const report = await w.run();
    expect(report.notified100).toBe(1);
    expect(report.priceMissing).toBe(true);
  });
});
