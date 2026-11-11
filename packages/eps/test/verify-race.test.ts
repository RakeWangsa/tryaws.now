import { describe, expect, it } from "vitest";
import { ledgerKey } from "@tc/core";
import { waitForLockWait } from "@tc/db/testing";
import { verifyPayment } from "../verify";
import { startPayment, useEpsKit } from "./kit";

const k = useEpsKit();

describe("races on one payment", () => {
  it("eight concurrent verifies credit once and all answer credited", async () => {
    k.reset();
    const s = await startPayment(k);
    k.eps.settle(s.merchantTransactionId, { status: "Success" });
    const deps = k.deps();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => verifyPayment(deps, s.merchantTransactionId)),
    );
    for (const r of results) expect(r).toEqual({ ok: true, value: { state: "credited" } });
    expect(await k.ledgerRows(ledgerKey.topup(s.paymentId))).toBe(1);
    expect(await k.balance(s.customerId)).toBe(150000n);
    expect((await k.payment(s.paymentId)).status).toBe("credited");
  });

  it("eight concurrent verifies of a wrong amount make one discrepancy and one alert", async () => {
    k.reset();
    const s = await startPayment(k);
    k.eps.settle(s.merchantTransactionId, { status: "Success", totalAmount: "1.00" });
    const deps = k.deps();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => verifyPayment(deps, s.merchantTransactionId)),
    );
    for (const r of results) expect(r).toEqual({ ok: true, value: { state: "pending" } });
    expect(await k.discrepancies()).toHaveLength(1);
    expect(k.alerts).toHaveLength(1);
    expect(await k.balance(s.customerId)).toBe(0n);
  });

  it("a verify waits for a connection that holds the row lock, then decides from the locked row", async () => {
    k.reset();
    const s = await startPayment(k);
    k.eps.settle(s.merchantTransactionId, { status: "Success" });
    const holder = await k.pool.connect();
    let pendingCall: ReturnType<typeof verifyPayment> | undefined;
    try {
      await holder.query("begin");
      await holder.query("select id from payments where id = $1 for update", [s.paymentId]);
      pendingCall = verifyPayment(k.deps(), s.merchantTransactionId);
      await waitForLockWait(k.pool, k.databaseName);
      // While the lock is held, nothing was credited.
      expect(await k.balance(s.customerId)).toBe(0n);
      // The holder changes the row under the waiting verify: it was failed meanwhile.
      await holder.query("update payments set status = 'failed' where id = $1", [s.paymentId]);
      await holder.query("commit");
    } catch (error) {
      await holder.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      holder.release();
    }
    // The first read said "redirected"; the locked row says "failed": a success on it is review, not credit.
    expect(await pendingCall).toEqual({ ok: true, value: { state: "pending" } });
    expect((await k.payment(s.paymentId)).status).toBe("review");
    expect(await k.balance(s.customerId)).toBe(0n);
  });
});
