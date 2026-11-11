// WP3-T3 proof: a payment whose browser never returned is credited by the sweeper once; old ones expire.
// The real handler, the real EPS services, the real PostgreSQL grants (worker_rw). Only EPS is a fake.
import { describe, expect, it } from "vitest";
import { ledgerKey, openWallet } from "@tc/core";
import type { SweepCounts } from "@tc/eps";
import type { SweeperEnv } from "../deps";
import { HOUR, MIN, useSweeperKit } from "./kit";

const k = useSweeperKit();
const BASE = new Date("2030-06-01T00:00:00Z");

const zero = { checked: 0, credited: 0, expired: 0, review: 0, unavailable: 0 };
const counts = (r: SweepCounts) => ({
  checked: r.checked,
  credited: r.credited,
  expired: r.expired,
  review: r.review,
  unavailable: r.unavailable,
});

/** Leaves no failure armed in the shared fake for the next scenario. */
async function drainFailures(): Promise<void> {
  for (let i = 0; i < 10; i++) await k.eps.verify("drain-0000000000");
}

function fresh(): void {
  k.eps.verifyCalls.length = 0;
  k.logs.length = 0;
}

describe("the sweeper credits a payment whose browser never returned, once", () => {
  it("1. credits once, then not again, now or an hour later", async () => {
    const s = await k.startPayment(150000n);
    await k.isolate(s);
    fresh();
    k.eps.settle(s.merchantTransactionId, { status: "Success" });
    await k.clockAfter(s, 3 * MIN);
    const rateBefore = await k.rateLimitRows();

    const first = await k.sweeper().handler();
    expect(counts(first)).toEqual({ ...zero, checked: 1, credited: 1 });
    expect(await k.balance(s.customerId)).toBe(150000n);
    expect(await k.ledgerRows(ledgerKey.topup(s.paymentId))).toBe(1);
    expect(await k.ledgerEntries(ledgerKey.topup(s.paymentId))).toBe(2);
    const row = await k.payment(s.paymentId);
    expect(row.status).toBe("credited");
    expect(row.verifiedAt).not.toBeNull();

    const second = await k.sweeper().handler();
    expect(counts(second)).toEqual(zero);
    expect(await k.balance(s.customerId)).toBe(150000n);

    await k.clockAfter(s, 3 * MIN + HOUR);
    const third = await k.sweeper().handler();
    expect(counts(third)).toEqual(zero);
    expect(await k.balance(s.customerId)).toBe(150000n);
    expect(await k.ledgerRows(ledgerKey.topup(s.paymentId))).toBe(1);

    // 11. the sweeper has no client address, so it writes no rate limit row
    expect(await k.rateLimitRows()).toBe(rateBefore);
  });

  it("2. a payment younger than two minutes is not asked about", async () => {
    const s = await k.startPayment();
    await k.isolate(s);
    fresh();
    await k.clockAfter(s, 1 * MIN);
    expect(counts(await k.sweeper().handler())).toEqual(zero);
    expect(k.eps.verifyCalls).toEqual([]);
    expect((await k.payment(s.paymentId)).status).toBe("redirected");
  });

  it("3. a pending payment expires after 24 hours, not before; a cancelled one is cancelled", async () => {
    const old = await k.startPayment();
    const young = await k.startPayment();
    const cancelled = await k.startPayment();
    await k.isolate(old, young, cancelled);
    fresh();
    await k.makeOld(old, BASE, 25 * HOUR);
    await k.makeOld(young, BASE, 23 * HOUR);
    await k.makeOld(cancelled, BASE, 25 * HOUR);
    k.eps.settle(cancelled.merchantTransactionId, { status: "Cancelled" });

    const report = await k.sweeper().handler();
    expect(counts(report)).toEqual({ ...zero, checked: 3, expired: 1 });
    expect((await k.payment(old.paymentId)).status).toBe("expired");
    expect((await k.payment(young.paymentId)).status).toBe("redirected");
    expect((await k.payment(cancelled.paymentId)).status).toBe("cancelled");
    for (const s of [old, young, cancelled]) {
      expect(await k.ledgerRows(ledgerKey.topup(s.paymentId))).toBe(0);
      expect(await k.balance(s.customerId)).toBe(0n);
    }
  });

  it("4. a 25-hour-old payment that EPS says succeeded is credited, not expired", async () => {
    const s = await k.startPayment(70000n);
    await k.isolate(s);
    fresh();
    k.eps.settle(s.merchantTransactionId, { status: "Success" });
    await k.makeOld(s, BASE, 25 * HOUR);
    expect(counts(await k.sweeper().handler())).toEqual({ ...zero, checked: 1, credited: 1 });
    expect((await k.payment(s.paymentId)).status).toBe("credited");
    expect(await k.balance(s.customerId)).toBe(70000n);
    expect(await k.ledgerRows(ledgerKey.topup(s.paymentId))).toBe(1);
  });

  it("5. two invocations at once credit every payment once", async () => {
    const all = [];
    for (let i = 0; i < 5; i++) all.push(await k.startPayment(10000n + BigInt(i)));
    await k.isolate(...all);
    fresh();
    for (const s of all) k.eps.settle(s.merchantTransactionId, { status: "Success" });
    await k.clockAfter(all[4]!, 10 * MIN);

    const [a, b] = await Promise.all([k.sweeper().handler(), k.sweeper().handler()]);
    expect(a.credited + b.credited).toBe(5);
    for (const [i, s] of all.entries()) {
      expect(await k.ledgerRows(ledgerKey.topup(s.paymentId))).toBe(1);
      expect(await k.balance(s.customerId)).toBe(10000n + BigInt(i));
      expect((await k.payment(s.paymentId)).status).toBe("credited");
    }
  });

  it("6. a sweeper racing a browser return credits once", async () => {
    const s = await k.startPayment(55000n);
    await k.isolate(s);
    fresh();
    k.eps.settle(s.merchantTransactionId, { status: "Success" });
    await k.clockAfter(s, 5 * MIN);
    await Promise.all([
      k.web().handleReturn({
        outcome: "success",
        query: { MerchantTransactionId: s.merchantTransactionId },
        clientIp: "10.99.0.1",
      }),
      k.sweeper().handler(),
    ]);
    expect(await k.ledgerRows(ledgerKey.topup(s.paymentId))).toBe(1);
    expect(await k.balance(s.customerId)).toBe(55000n);
    expect((await k.payment(s.paymentId)).status).toBe("credited");
  });

  it("7. a run killed after EPS answered and before the commit credits nothing; the next run credits once", async () => {
    const s = await k.startPayment(42000n);
    await k.isolate(s);
    fresh();
    k.eps.settle(s.merchantTransactionId, { status: "Success" });
    await k.clockAfter(s, 5 * MIN);

    // Every transaction that starts after EPS has been asked is the settle: run it, then throw
    // before it commits (runTransaction rolls back on a throw).
    const worker = k.runAs("worker_rw");
    const killed: SweeperEnv["runTx"] = async (fn) => {
      if (k.eps.verifyCalls.length === 0) return worker(fn);
      return worker(async (tx) => {
        await fn(tx);
        throw new Error("killed before commit");
      });
    };

    const outcome = await k
      .sweeper({ runTx: killed })
      .handler()
      .then(
        (r) => r,
        () => null,
      );
    if (outcome !== null) expect(outcome.credited).toBe(0);
    expect((await k.payment(s.paymentId)).status).toBe("redirected");
    expect(await k.ledgerRows(ledgerKey.topup(s.paymentId))).toBe(0);
    expect(await k.balance(s.customerId)).toBe(0n);

    const healthy = await k.sweeper().handler();
    expect(counts(healthy)).toEqual({ ...zero, checked: 1, credited: 1 });
    expect(await k.ledgerRows(ledgerKey.topup(s.paymentId))).toBe(1);
    expect(await k.balance(s.customerId)).toBe(42000n);
  });

  it("8. EPS unreachable fails closed: nothing changes, nothing expires", async () => {
    const a = await k.startPayment();
    const b = await k.startPayment();
    await k.isolate(a, b);
    fresh();
    await k.makeOld(a, BASE, 25 * HOUR);
    await k.makeOld(b, BASE, 5 * MIN);
    k.eps.failNext("unavailable", 2);

    const report = await k.sweeper().handler();
    await drainFailures();
    expect(report.checked).toBe(2);
    expect(report.unavailable).toBe(2);
    expect(report.expired).toBe(0);
    expect(report.allUnavailable).toBe(true);
    expect((await k.payment(a.paymentId)).status).toBe("redirected");
    expect((await k.payment(b.paymentId)).status).toBe("redirected");
    for (const s of [a, b]) expect(await k.ledgerRows(ledgerKey.topup(s.paymentId))).toBe(0);
  });

  it("9. an amount mismatch goes to review with exactly one alert, and stays there", async () => {
    const s = await k.startPayment(150000n);
    await k.isolate(s);
    fresh();
    k.eps.settle(s.merchantTransactionId, { status: "Success", totalAmount: "1499.99" });
    await k.clockAfter(s, 5 * MIN);

    const first = await k.sweeper().handler();
    expect(counts(first)).toEqual({ ...zero, checked: 1, review: 1 });
    expect((await k.payment(s.paymentId)).status).toBe("review");
    expect(await k.balance(s.customerId)).toBe(0n);
    expect(await k.discrepancyCount(s.paymentId)).toBe(1);
    const alerts = k.logs.filter((l) => l.event === "payment_review");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      severity: "alert",
      paymentId: s.paymentId,
      expectedMinor: "150000",
      gotMinor: "149999",
    });
    expect(k.logs.find((l) => l.event === "payments_sweep")).toMatchObject({ review: 1 });

    k.logs.length = 0;
    const second = await k.sweeper().handler();
    expect(counts(second)).toEqual(zero);
    expect(k.logs.filter((l) => l.event === "payment_review")).toHaveLength(0);
    expect((await k.payment(s.paymentId)).status).toBe("review");
    expect(await k.ledgerRows(ledgerKey.topup(s.paymentId))).toBe(0);
  });

  it("10. a customer without a wallet stays open and is counted; it is credited once a wallet exists", async () => {
    const s = await k.startPayment(33000n, false);
    await k.isolate(s);
    fresh();
    k.eps.settle(s.merchantTransactionId, { status: "Success" });
    await k.clockAfter(s, 5 * MIN);

    const first = await k.sweeper().handler();
    expect(counts(first)).toEqual({ ...zero, checked: 1, unavailable: 1 });
    expect((await k.payment(s.paymentId)).status).toBe("redirected");
    expect(await k.ledgerRows(ledgerKey.topup(s.paymentId))).toBe(0);

    // 25 hours old with EPS success: still open, never expired
    await k.clockAfter(s, 25 * HOUR);
    const old = await k.sweeper().handler();
    expect(counts(old)).toEqual({ ...zero, checked: 1, unavailable: 1 });
    expect((await k.payment(s.paymentId)).status).toBe("redirected");

    // a wallet is opened by the role that may (worker_rw has no INSERT on wallets), then the next run credits
    const opened = await k.runAs("web_rw")((tx) => openWallet(tx, s.customerId));
    expect(opened.ok).toBe(true);
    const healed = await k.sweeper().handler();
    expect(counts(healed)).toEqual({ ...zero, checked: 1, credited: 1 });
    expect(await k.balance(s.customerId)).toBe(33000n);
    expect(await k.ledgerRows(ledgerKey.topup(s.paymentId))).toBe(1);
  });

  it("12. the limit is honoured: 30 paid payments, 25 then 5", async () => {
    const all = [];
    for (let i = 0; i < 30; i++) all.push(await k.startPayment(5000n));
    await k.isolate(...all);
    fresh();
    for (const s of all) k.eps.settle(s.merchantTransactionId, { status: "Success" });
    await k.clockAfter(all[29]!, 10 * MIN);

    const first = await k.sweeper().handler();
    expect(first.credited).toBe(25);
    expect(first.checked).toBe(25);
    expect(first.backlog).toBe(true);
    const second = await k.sweeper().handler();
    expect(second.credited).toBe(5);
    expect(second.backlog).toBe(false);
    for (const s of all) {
      expect(await k.ledgerRows(ledgerKey.topup(s.paymentId))).toBe(1);
      expect(await k.balance(s.customerId)).toBe(5000n);
    }
  });
});
