import { describe, expect, it } from "vitest";
import { ledgerKey } from "@tc/core";
import { createEps } from "../service";
import { recheckPayment } from "../recheck";
import { freshIp, PLANTED_SECRET, startPayment, useEpsKit, type Started } from "./kit";

const k = useEpsKit();

const recheck = (s: Started, ip = freshIp()) =>
  recheckPayment(k.deps(), { customerId: s.customerId }, s.paymentId, { clientIp: ip });
const settle = (s: Started, outcome: Parameters<typeof k.eps.settle>[1]) =>
  k.eps.settle(s.merchantTransactionId, outcome);
const setStatus = (s: Started, status: string) =>
  k.pool.query("update payments set status = $2 where id = $1", [s.paymentId, status]);

describe("an open payment that EPS now reports as successful", () => {
  it("is credited once and answers credited; a second call asks EPS no more", async () => {
    k.reset();
    const s = await startPayment(k);
    settle(s, { status: "Success" });
    expect(await recheck(s)).toEqual({ ok: true, value: { state: "credited", review: false } });
    expect(await k.balance(s.customerId)).toBe(150000n);
    expect(await k.ledgerRows(ledgerKey.topup(s.paymentId))).toBe(1);
    const calls = k.eps.verifyCalls.length;
    expect(await recheck(s)).toEqual({ ok: true, value: { state: "credited", review: false } });
    expect(k.eps.verifyCalls).toHaveLength(calls);
    expect(await k.balance(s.customerId)).toBe(150000n);
    expect(await k.ledgerRows(ledgerKey.topup(s.paymentId))).toBe(1);
  });

  it("two calls in parallel credit once", async () => {
    k.reset();
    const s = await startPayment(k);
    settle(s, { status: "Success" });
    const both = await Promise.all([recheck(s), recheck(s)]);
    const credited = both.filter((r) => r.ok && r.value.state === "credited");
    expect(credited.length).toBeGreaterThanOrEqual(1);
    for (const r of both) {
      if (!r.ok) expect(r.error).toBe("rate_limited");
    }
    expect(await k.balance(s.customerId)).toBe(150000n);
    expect(await k.ledgerRows(ledgerKey.topup(s.paymentId))).toBe(1);
  });
});

describe("another customer's payment (cross-tenant, R8)", () => {
  it("answers not_found, like a payment that does not exist, with no call to EPS", async () => {
    k.reset();
    const mine = await startPayment(k);
    const other = await k.newCustomer();
    settle(mine, { status: "Success" });
    const deps = k.deps();
    const cross = await recheckPayment(deps, { customerId: other }, mine.paymentId, {
      clientIp: freshIp(),
    });
    const ghost = await recheckPayment(deps, { customerId: other }, crypto.randomUUID(), {
      clientIp: freshIp(),
    });
    expect(cross).toEqual({ ok: false, error: "not_found" });
    expect(cross).toEqual(ghost);
    expect(k.eps.verifyCalls).toEqual([]);
    expect((await k.payment(mine.paymentId)).status).toBe("redirected");
    expect(await k.balance(mine.customerId)).toBe(0n);
  });
});

describe("validation and authentication come first", () => {
  it("a customer id that is not a UUID is unauthenticated", async () => {
    k.reset();
    const s = await startPayment(k);
    const r = await recheckPayment(k.deps(), { customerId: "nope" }, s.paymentId, {
      clientIp: freshIp(),
    });
    expect(r).toEqual({ ok: false, error: "unauthenticated" });
    expect(k.eps.verifyCalls).toEqual([]);
  });

  it.each(["", "not-a-uuid", "1 or 1=1", "../x"])("a payment id %j is not_found", async (id) => {
    k.reset();
    const s = await startPayment(k);
    const r = await recheckPayment(k.deps(), { customerId: s.customerId }, id, {
      clientIp: freshIp(),
    });
    expect(r).toEqual({ ok: false, error: "not_found" });
    expect(k.eps.verifyCalls).toEqual([]);
  });

  it("an unreadable client address is refused before anything is asked", async () => {
    k.reset();
    const s = await startPayment(k);
    const r = await recheck(s, "not an address");
    expect(r).toMatchObject({ ok: false, error: "validation" });
    expect(k.eps.verifyCalls).toEqual([]);
  });
});

describe("a payment that is not open", () => {
  it.each(["credited", "failed", "cancelled", "expired"] as const)(
    "%s answers its state with no call to EPS and no limit used",
    async (state) => {
      k.reset();
      const s = await startPayment(k);
      if (state === "credited") {
        // A credited row needs its ledger link (a check constraint): credit it the real way.
        settle(s, { status: "Success" });
        expect(await recheck(s)).toEqual({ ok: true, value: { state, review: false } });
      } else {
        await setStatus(s, state);
      }
      const asked = k.eps.verifyCalls.length;
      // Far more calls than the limit of 30: none of them is counted.
      for (let i = 0; i < 40; i += 1) {
        expect(await recheck(s)).toEqual({ ok: true, value: { state, review: false } });
      }
      expect(k.eps.verifyCalls).toHaveLength(asked);
    },
  );

  it("a review payment answers pending with review true, no call to EPS", async () => {
    k.reset();
    const s = await startPayment(k);
    await setStatus(s, "review");
    expect(await recheck(s)).toEqual({ ok: true, value: { state: "pending", review: true } });
    expect(k.eps.verifyCalls).toEqual([]);
  });

  it("a payment that this call moves to review answers pending with review true", async () => {
    k.reset();
    const s = await startPayment(k);
    settle(s, { status: "Success", totalAmount: "1.00" });
    expect(await recheck(s)).toEqual({ ok: true, value: { state: "pending", review: true } });
    expect((await k.payment(s.paymentId)).status).toBe("review");
    expect(await k.balance(s.customerId)).toBe(0n);
  });
});

describe("EPS cannot be reached", () => {
  it("answers upstream_unavailable and leaves the row as it was", async () => {
    k.reset();
    const s = await startPayment(k);
    settle(s, { status: "Success" });
    k.eps.failNext("unavailable");
    expect(await recheck(s)).toEqual({ ok: false, error: "upstream_unavailable" });
    const row = await k.payment(s.paymentId);
    expect(row.status).toBe("redirected");
    expect(row.ledgerTransactionId).toBeNull();
    expect(await k.balance(s.customerId)).toBe(0n);
    // The next call, after the per-payment pause, settles it.
    k.clock.advance(6000);
    expect(await recheck(s)).toEqual({ ok: true, value: { state: "credited", review: false } });
  });

  it("a gateway that throws leaks nothing of its error", async () => {
    k.reset();
    const s = await startPayment(k);
    k.eps.failNext("throw");
    const r = await recheck(s);
    expect(r).toEqual({ ok: false, error: "upstream_unavailable" });
    expect(JSON.stringify(r)).not.toContain(PLANTED_SECRET);
    expect(JSON.stringify(k.logs)).not.toContain(PLANTED_SECRET);
  });

  it("a database that throws is internal and nothing is promised", async () => {
    const s = await startPayment(k);
    const deps = k.deps("web_rw", {
      run: () => Promise.reject(new Error("db down " + PLANTED_SECRET)),
    });
    const r = await recheckPayment(deps, { customerId: s.customerId }, s.paymentId, {
      clientIp: freshIp(),
    });
    expect(r).toEqual({ ok: false, error: "internal" });
    expect(JSON.stringify(r)).not.toContain(PLANTED_SECRET);
  });
});

describe("the rate limit of a customer", () => {
  it("allows 30 calls in 10 minutes and refuses the 31st with retryAfterSeconds", async () => {
    k.reset();
    const s = await startPayment(k);
    for (let i = 0; i < 30; i += 1) {
      k.clock.advance(6000); // the per-payment pause of verifyPayment is 5 s
      expect(await recheck(s)).toEqual({ ok: true, value: { state: "pending", review: false } });
    }
    k.clock.advance(6000);
    const r = await recheck(s);
    expect(r).toMatchObject({ ok: false, error: "rate_limited" });
    if (!r.ok) {
      const data = r.data as { retryAfterSeconds: number };
      expect(Number.isInteger(data.retryAfterSeconds)).toBe(true);
      expect(data.retryAfterSeconds).toBeGreaterThan(0);
    }
    expect(k.eps.verifyCalls).toHaveLength(30);
    expect((await k.payment(s.paymentId)).status).toBe("redirected");
  });

  it("the per-payment pause of verifyPayment still applies to an immediate second call", async () => {
    k.reset();
    const s = await startPayment(k);
    expect(await recheck(s)).toMatchObject({ ok: true });
    expect(await recheck(s)).toMatchObject({ ok: false, error: "rate_limited" });
  });
});

describe("the record", () => {
  it("writes an audit row payment.recheck with the payment id and the state, never the transaction id", async () => {
    k.reset();
    const s = await startPayment(k);
    settle(s, { status: "Success" });
    await recheck(s);
    const { rows } = await k.pool.query(
      `select actor_type, action, target_type, target_id, metadata
         from audit_log where actor_id = $1 and action = 'payment.recheck'`,
      [s.customerId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_type: "customer",
      target_type: "payment",
      target_id: s.paymentId,
    });
    expect(rows[0].metadata).toMatchObject({ state: "credited" });
    expect(JSON.stringify(rows[0])).not.toContain(s.merchantTransactionId);
  });

  it("logs and results hold no merchant transaction id", async () => {
    k.reset();
    const s = await startPayment(k);
    settle(s, { status: "Success" });
    const r = await recheck(s);
    expect(JSON.stringify(r)).not.toContain(s.merchantTransactionId);
    expect(JSON.stringify(k.logs)).not.toContain(s.merchantTransactionId);
  });
});

describe("the bound service", () => {
  it("Eps.recheckPayment is the same call with the deps bound", async () => {
    k.reset();
    const eps = createEps(k.deps());
    const s = await startPayment(k);
    settle(s, { status: "Success" });
    expect(
      await eps.recheckPayment({ customerId: s.customerId }, s.paymentId, { clientIp: freshIp() }),
    ).toEqual({ ok: true, value: { state: "credited", review: false } });
  });
});
