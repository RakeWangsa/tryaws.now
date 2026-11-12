import { describe, expect, it } from "vitest";
import { checkLedger, ledgerKey } from "@tc/core";
import { handleEpsReturn, sweepPayments, verifyPayment } from "../index";
import { freshIp, startPayment, useEpsKit } from "./kit";

// WP9-T3 (a): the same EPS payment verified 20 times at once, over several connections of the pool and
// through the three doors (the verify, the browser's return and the sweeper), credits exactly once
// (R6, R7). Fixed counts, no sleeps: the pool of the temporary database has ten connections, so the
// transactions really overlap on the lock of the payment row and on the unique ledger key.
const k = useEpsKit();
const AMOUNT = 150000n;

describe("20 parallel verifications of one payment credit once", () => {
  it("20 verifyPayment calls at once: one topup transaction, the balance is the amount once", async () => {
    const s = await startPayment(k);
    k.reset();
    k.eps.settle(s.merchantTransactionId, { status: "Success" });
    const deps = k.deps();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => verifyPayment(deps, s.merchantTransactionId)),
    );
    for (const r of results) expect(r).toEqual({ ok: true, value: { state: "credited" } });
    expect(await k.ledgerRows(ledgerKey.topup(s.paymentId))).toBe(1);
    expect(await k.balance(s.customerId)).toBe(AMOUNT);
    expect((await k.run((tx) => checkLedger(tx))).ok).toBe(true);
  });

  it("20 calls through the verify, the browser return and the sweeper at the same time: still one credit", async () => {
    const s = await startPayment(k);
    k.reset();
    k.eps.settle(s.merchantTransactionId, { status: "Success" });
    k.clock.advance(6000);
    const deps = k.deps();
    const calls: Array<Promise<unknown>> = [];
    for (let i = 0; i < 8; i++) calls.push(verifyPayment(deps, s.merchantTransactionId));
    for (let i = 0; i < 8; i++) {
      calls.push(
        handleEpsReturn(deps, {
          outcome: "success",
          query: { MerchantTransactionId: s.merchantTransactionId },
          clientIp: freshIp(),
        }),
      );
    }
    for (let i = 0; i < 4; i++) calls.push(sweepPayments(k.deps("worker_rw")));
    await Promise.all(calls);
    expect(await k.ledgerRows(ledgerKey.topup(s.paymentId))).toBe(1);
    expect(await k.balance(s.customerId)).toBe(AMOUNT);
    const sums = await k.pool.query<{ entries: string; wallet: string }>(
      `select coalesce(sum(case e.direction when 'credit' then e.amount_minor else -e.amount_minor end), 0)::text as entries,
              (select balance_minor::text from wallets where customer_id = $1) as wallet
         from ledger_entries e join ledger_accounts a on a.id = e.account_id
        where a.customer_id = $1 and a.type = 'customer_wallet'`,
      [s.customerId],
    );
    expect(sums.rows[0]?.wallet).toBe(sums.rows[0]?.entries);
    expect((await k.run((tx) => checkLedger(tx))).ok).toBe(true);
  });
});
