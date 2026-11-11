import { describe, expect, it } from "vitest";
import { ledgerKey } from "@tc/core";
import { handleEpsReturn } from "../returns";
import { sweepPayments } from "../sweep";
import { verifyPayment } from "../verify";
import { freshIp, startPayment, useEpsKit, type Started } from "./kit";

const k = useEpsKit();
const MIN = 60_000;
const HOUR = 60 * MIN;
const sweep = (limit?: number) =>
  sweepPayments(k.deps("worker_rw"), limit === undefined ? undefined : { limit });

/** Puts the clock `ms` after the payment was created. */
async function clockAfter(s: Started, ms: number): Promise<void> {
  const r = await k.pool.query<{ created_at: Date }>(
    "select created_at from payments where id = $1",
    [s.paymentId],
  );
  k.clock.set(new Date((r.rows[0]?.created_at.getTime() ?? 0) + ms));
}

/** Closes every other open payment of the file's database so a sweep sees only the test's own rows. */
async function isolate(...keep: Started[]): Promise<void> {
  await k.pool.query(
    "update payments set status = 'cancelled' where status in ('initiated','redirected') and id <> all($1::uuid[])",
    [keep.map((s) => s.paymentId)],
  );
}

const zero = { checked: 0, credited: 0, expired: 0, review: 0, unavailable: 0 };

describe("sweepPayments", () => {
  it("expires a 25-hour-old payment for which EPS says pending", async () => {
    const s = await startPayment(k);
    await isolate(s);
    k.reset();
    await clockAfter(s, 25 * HOUR);
    expect(await sweep()).toEqual({ ...zero, checked: 1, expired: 1 });
    expect((await k.payment(s.paymentId)).status).toBe("expired");
    expect(await k.balance(s.customerId)).toBe(0n);
    expect(k.eps.verifyCalls).toEqual([s.merchantTransactionId]);
  });

  it("credits a 25-hour-old payment for which EPS says success (not expired)", async () => {
    const s = await startPayment(k);
    await isolate(s);
    k.eps.settle(s.merchantTransactionId, { status: "Success" });
    await clockAfter(s, 25 * HOUR);
    expect(await sweep()).toEqual({ ...zero, checked: 1, credited: 1 });
    expect((await k.payment(s.paymentId)).status).toBe("credited");
    expect(await k.balance(s.customerId)).toBe(150000n);
  });

  it("does not touch a payment younger than 2 minutes and does not call EPS for it", async () => {
    const s = await startPayment(k);
    await isolate(s);
    k.reset();
    await clockAfter(s, 1 * MIN);
    expect(await sweep()).toEqual(zero);
    expect(k.eps.verifyCalls).toHaveLength(0);
    expect((await k.payment(s.paymentId)).status).toBe("redirected");
  });

  it("asks EPS about a payment between 2 minutes and 24 hours and leaves it open if pending", async () => {
    const s = await startPayment(k);
    await isolate(s);
    k.reset();
    await clockAfter(s, 3 * HOUR);
    expect(await sweep()).toEqual({ ...zero, checked: 1 });
    expect(k.eps.verifyCalls).toHaveLength(1);
    expect((await k.payment(s.paymentId)).status).toBe("redirected");
  });

  it("leaves a 25-hour-old payment as it is when EPS is unavailable, and retries next run", async () => {
    const s = await startPayment(k);
    await isolate(s);
    await clockAfter(s, 25 * HOUR);
    k.eps.failNext("unavailable");
    expect(await sweep()).toEqual({ ...zero, checked: 1, unavailable: 1 });
    expect((await k.payment(s.paymentId)).status).toBe("redirected");
    expect(await sweep()).toEqual({ ...zero, checked: 1, expired: 1 });
  });

  it("settles a payment that stayed initiated because InitializeEPS was unavailable", async () => {
    const customerId = await k.newCustomer();
    const { startTopUp } = await import("../topup");
    k.eps.failNext("unavailable");
    const r = await startTopUp(
      k.deps(),
      { customerId },
      { amountMinor: 20000n, idempotencyKey: "key-" + crypto.randomUUID() },
      { clientIp: freshIp() },
    );
    expect(r).toEqual({ ok: false, error: "upstream_unavailable" });
    const row = await k.pool.query<{ id: string; merchant_transaction_id: string }>(
      "select id, merchant_transaction_id from payments where customer_id = $1",
      [customerId],
    );
    const s: Started = {
      customerId,
      paymentId: row.rows[0]?.id ?? "",
      merchantTransactionId: row.rows[0]?.merchant_transaction_id ?? "",
    };
    await isolate(s);
    await clockAfter(s, 25 * HOUR);
    expect(await sweep()).toEqual({ ...zero, checked: 1, expired: 1 });
    expect((await k.payment(s.paymentId)).status).toBe("expired");
  });

  it("a success with a wrong amount is counted as review, with one alert", async () => {
    const s = await startPayment(k);
    await isolate(s);
    k.reset();
    k.eps.settle(s.merchantTransactionId, { status: "Success", totalAmount: "2.00" });
    await clockAfter(s, 5 * MIN);
    expect(await sweep()).toEqual({ ...zero, checked: 1, review: 1 });
    expect(k.alerts).toHaveLength(1);
    expect(await k.balance(s.customerId)).toBe(0n);
  });

  it("honours the limit and goes oldest first", async () => {
    const a = await startPayment(k);
    const b = await startPayment(k);
    await isolate(a, b);
    k.reset();
    await clockAfter(b, 3 * HOUR);
    expect(await sweep(1)).toEqual({ ...zero, checked: 1 });
    expect(k.eps.verifyCalls).toEqual([a.merchantTransactionId]);
  });

  it("a failing call for one payment does not stop the others", async () => {
    const a = await startPayment(k);
    const b = await startPayment(k);
    await isolate(a, b);
    k.reset();
    k.eps.settle(b.merchantTransactionId, { status: "Success" });
    await clockAfter(b, 3 * HOUR);
    k.eps.failNext("throw");
    const r = await sweep();
    expect(r.checked).toBe(2);
    expect(r.credited).toBe(1);
    expect(r.unavailable).toBe(1);
    expect(await k.balance(b.customerId)).toBe(150000n);
  });

  it("a bad limit falls back to the default instead of throwing", async () => {
    await isolate();
    for (const limit of [0, -1, 1.5, 501, Number.NaN]) {
      expect(await sweep(limit)).toEqual(zero);
    }
  });

  it("logs counts only", async () => {
    const s = await startPayment(k);
    await isolate(s);
    k.reset();
    await clockAfter(s, 3 * HOUR);
    await sweep();
    const text = JSON.stringify(k.logs);
    expect(text).not.toContain(s.merchantTransactionId);
    expect(text).not.toContain(s.paymentId);
  });
});

describe("a late success after the sweeper expired the payment", () => {
  it("goes to review through the callback and credits nothing (open point 2)", async () => {
    const s = await startPayment(k);
    await isolate(s);
    await clockAfter(s, 25 * HOUR);
    await sweep();
    expect((await k.payment(s.paymentId)).status).toBe("expired");
    k.eps.settle(s.merchantTransactionId, { status: "Success" });
    const r = await handleEpsReturn(k.deps(), {
      outcome: "success",
      query: { MerchantTransactionId: s.merchantTransactionId },
      clientIp: freshIp(),
    });
    expect(r).toEqual({ redirectTo: "/wallet?topup=pending", state: "pending" });
    expect((await k.payment(s.paymentId)).status).toBe("review");
    expect(await k.balance(s.customerId)).toBe(0n);
    expect((await k.discrepancies()).at(-1)?.details).toMatchObject({ reason: "late_success" });
  });
});

describe("races", () => {
  it("two sweepers at once credit once", async () => {
    const s = await startPayment(k);
    await isolate(s);
    k.eps.settle(s.merchantTransactionId, { status: "Success" });
    await clockAfter(s, 3 * HOUR);
    const [a, b] = await Promise.all([sweep(), sweep()]);
    expect(a.credited + b.credited).toBe(1);
    expect(await k.ledgerRows(ledgerKey.topup(s.paymentId))).toBe(1);
    expect(await k.balance(s.customerId)).toBe(150000n);
  });

  it("a sweeper racing eight callbacks credits once and nobody fails", async () => {
    const s = await startPayment(k);
    await isolate(s);
    k.eps.settle(s.merchantTransactionId, { status: "Success" });
    await clockAfter(s, 3 * HOUR);
    const callbacks = Array.from({ length: 8 }, () =>
      verifyPayment(k.deps(), s.merchantTransactionId),
    );
    const [swept, ...answers] = await Promise.all([sweep(), ...callbacks]);
    expect(swept.checked).toBeLessThanOrEqual(1);
    for (const a of answers) expect(a).toEqual({ ok: true, value: { state: "credited" } });
    expect(await k.ledgerRows(ledgerKey.topup(s.paymentId))).toBe(1);
    expect(await k.balance(s.customerId)).toBe(150000n);
  });
});
