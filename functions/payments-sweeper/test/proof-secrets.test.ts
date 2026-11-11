// R3 and R14: no EPS secret, hash, token, redirect URL or merchant transaction id reaches a log line,
// a report or an error message of the sweeper.
import { describe, expect, it } from "vitest";
import { HOUR, MIN, PLANTED, useSweeperKit } from "./kit";

const k = useSweeperKit();

describe("the sweeper leaks no secret", () => {
  it("keeps every planted secret and every merchant transaction id out of logs, reports and errors", async () => {
    const captured: unknown[] = [];
    const ids: string[] = [];

    // scenario 1: a credit
    const paid = await k.startPayment(150000n);
    // scenario 9: a review
    const wrong = await k.startPayment(150000n);
    // scenario 8: EPS unavailable
    const silent = await k.startPayment(150000n);
    ids.push(paid.merchantTransactionId, wrong.merchantTransactionId, silent.merchantTransactionId);
    await k.isolate(paid, wrong, silent);
    k.logs.length = 0;

    k.eps.settle(paid.merchantTransactionId, { status: "Success" });
    k.eps.settle(wrong.merchantTransactionId, { status: "Success", totalAmount: "1.00" });
    await k.makeOld(paid, new Date("2031-01-01T00:00:00Z"), 5 * MIN);
    await k.makeOld(wrong, new Date("2031-01-01T00:00:00Z"), 5 * MIN);
    await k.makeOld(silent, new Date("2031-01-01T00:00:00Z"), 25 * HOUR);
    // the third verify call (oldest first is the silent one) fails
    k.eps.failNext("unavailable", 1);

    captured.push(await k.sweeper().handler());

    // a handler failure: the select throws
    const failing = k.sweeper({
      runTx: async () => {
        throw new Error(`db down ${PLANTED.EpsPassword} ${PLANTED.EpsHashKey}`);
      },
    });
    const err = await failing.handler().then(
      (r) => {
        captured.push(r);
        return null;
      },
      (e: Error) => e,
    );
    if (err !== null) captured.push(err.message);

    captured.push(...k.logs);
    const text = JSON.stringify(captured, (_key, v: unknown) =>
      typeof v === "bigint" ? v.toString() : v,
    );

    for (const v of Object.values(PLANTED)) expect(text).not.toContain(v);
    for (const bad of ["x-hash", "Bearer", "redirect", "pg.eps"]) {
      expect(text.toLowerCase()).not.toContain(bad.toLowerCase());
    }
    for (const id of ids) expect(text).not.toContain(id);
    expect(k.logs.some((l) => l.event === "payments_sweep")).toBe(true);
  });
});
