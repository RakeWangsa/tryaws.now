import { describe, expect, it, vi } from "vitest";
import { checkLedger, ledgerKey } from "@tc/core";
import type { EpsGateway } from "../gateway";
import { readVerifyResponse } from "../status";
import { verifyPayment } from "../verify";
import { freshIp, PLANTED_SECRET, startPayment, useEpsKit, type Started } from "./kit";

// One switch for the test that makes the ledger post fail. The mock keeps the real function otherwise.
const flags = vi.hoisted(() => ({ failPost: false }));
vi.mock("@tc/core", async (importOriginal) => {
  const real = await importOriginal<typeof import("@tc/core")>();
  return {
    ...real,
    postTransaction: (...args: Parameters<typeof real.postTransaction>) => {
      if (flags.failPost) throw new Error("post failed: planted-secret-hash-key-0123456789");
      return real.postTransaction(...args);
    },
  };
});

const k = useEpsKit();
const verify = (id: string) => verifyPayment(k.deps(), id);
const settle = (s: Started, outcome: Parameters<typeof k.eps.settle>[1]) =>
  k.eps.settle(s.merchantTransactionId, outcome);
const credited = { ok: true, value: { state: "credited" } } as const;
const pending = { ok: true, value: { state: "pending" } } as const;

describe("a verified success", () => {
  it("credits once and posts one topup transaction keyed topup:<payment id>", async () => {
    k.reset();
    const s = await startPayment(k);
    settle(s, { status: "Success" });
    expect(await verify(s.merchantTransactionId)).toEqual(credited);
    expect(await k.balance(s.customerId)).toBe(150000n);
    expect(await k.ledgerRows(ledgerKey.topup(s.paymentId))).toBe(1);
    const p = await k.payment(s.paymentId);
    expect(p.status).toBe("credited");
    expect(p.ledgerTransactionId).not.toBeNull();
    expect(p.gatewayTransactionId).toBe("eps-1");
    expect((await k.run((tx) => checkLedger(tx))).ok).toBe(true);
  });

  it.each(["Success", "SUCCESS", "COMPLETED"])("accepts the alias %s", async (status) => {
    const s = await startPayment(k, 20000n);
    settle(s, { status });
    expect(await verify(s.merchantTransactionId)).toEqual(credited);
    expect(await k.balance(s.customerId)).toBe(20000n);
  });

  it("a second callback credits nothing more and calls EPS no more", async () => {
    k.reset();
    const s = await startPayment(k);
    settle(s, { status: "Success" });
    await verify(s.merchantTransactionId);
    const calls = k.eps.verifyCalls.length;
    expect(await verify(s.merchantTransactionId)).toEqual(credited);
    expect(k.eps.verifyCalls).toHaveLength(calls);
    expect(await k.balance(s.customerId)).toBe(150000n);
    expect(await k.ledgerRows(ledgerKey.topup(s.paymentId))).toBe(1);
  });

  it("stores the allowlisted payload only, never the raw body", async () => {
    const s = await startPayment(k, 30000n);
    settle(s, { status: "Success" });
    await verify(s.merchantTransactionId);
    const p = await k.payment(s.paymentId);
    expect(Object.keys(p.verifyPayload as object).sort()).toEqual([
      "epsTransactionId",
      "merchantTransactionId",
      "status",
      "totalAmount",
    ]);
    expect(p.verifyPayload).toMatchObject({ status: "success", totalAmount: "300.00" });
  });

  it("calls the onCredited hook inside the credit transaction", async () => {
    const s = await startPayment(k, 30000n);
    settle(s, { status: "Success" });
    const seen: Array<{ id: string; customerId: string; status: string }> = [];
    const deps = k.deps("web_rw", {
      onCredited: async (_tx, payment) => {
        seen.push({ id: payment.id, customerId: payment.customerId, status: payment.status });
      },
    });
    await verifyPayment(deps, s.merchantTransactionId);
    expect(seen).toEqual([{ id: s.paymentId, customerId: s.customerId, status: "credited" }]);
  });
});

describe("answers that are not a success", () => {
  it.each([
    ["Failed", "failed", "failed"],
    ["Cancelled", "cancelled", "cancelled"],
    ["Pending", "pending", "redirected"],
    ["Weird", "pending", "redirected"],
  ])("%s answers %s and leaves the row %s, balance 0", async (status, answer, rowState) => {
    const s = await startPayment(k, 20000n);
    settle(s, { status });
    expect(await verify(s.merchantTransactionId)).toEqual({ ok: true, value: { state: answer } });
    expect((await k.payment(s.paymentId)).status).toBe(rowState);
    expect(await k.balance(s.customerId)).toBe(0n);
  });

  it("EPS unavailable leaves the row redirected (R16)", async () => {
    const s = await startPayment(k, 20000n);
    k.eps.failNext("unavailable");
    expect(await verify(s.merchantTransactionId)).toEqual({
      ok: false,
      error: "upstream_unavailable",
    });
    expect((await k.payment(s.paymentId)).status).toBe("redirected");
    expect(await k.balance(s.customerId)).toBe(0n);
  });

  it("EPS throwing leaves the row redirected and leaks no secret", async () => {
    const s = await startPayment(k, 20000n);
    k.reset();
    k.eps.failNext("throw");
    const r = await verify(s.merchantTransactionId);
    expect(r).toEqual({ ok: false, error: "upstream_unavailable" });
    expect(JSON.stringify(r)).not.toContain(PLANTED_SECRET);
    expect(JSON.stringify(k.logs)).not.toContain(PLANTED_SECRET);
    expect((await k.payment(s.paymentId)).status).toBe("redirected");
  });
});

describe("a success that does not match goes to review, never to the wallet", () => {
  it.each([
    ["a smaller amount", "15.00"],
    ["three decimals", "1500.001"],
    ["a thousands separator", "1,500.00"],
    ["zero", "0"],
    ["text", "abc"],
  ])("%s", async (_name, totalAmount) => {
    k.reset();
    const s = await startPayment(k);
    settle(s, { status: "Success", totalAmount });
    expect(await verify(s.merchantTransactionId)).toEqual(pending);
    expect((await k.payment(s.paymentId)).status).toBe("review");
    expect(await k.balance(s.customerId)).toBe(0n);
    expect(await k.ledgerRows(ledgerKey.topup(s.paymentId))).toBe(0);
    const d = await k.discrepancies();
    expect(d).toHaveLength(1);
    expect(d[0]?.details).toMatchObject({
      paymentId: s.paymentId,
      reason: "amount_mismatch",
      expectedMinor: "150000",
    });
    expect(k.alerts).toHaveLength(1);
    expect(k.alerts[0]).toMatchObject({ paymentId: s.paymentId, expectedMinor: 150000n });
    // a second callback changes nothing and raises nothing
    expect(await verify(s.merchantTransactionId)).toEqual(pending);
    expect(await k.discrepancies()).toHaveLength(1);
    expect(k.alerts).toHaveLength(1);
  });

  it("an absent amount is a mismatch", async () => {
    k.reset();
    const s = await startPayment(k);
    const stub: EpsGateway = {
      initialize: (r) => k.eps.initialize(r),
      verify: async (id) => ({
        ok: true,
        reading: readVerifyResponse({ Status: "Success", MerchantTransactionId: id }),
      }),
    };
    const r = await verifyPayment(k.deps("web_rw", { gateway: stub }), s.merchantTransactionId);
    expect(r).toEqual(pending);
    expect((await k.payment(s.paymentId)).status).toBe("review");
    expect(await k.balance(s.customerId)).toBe(0n);
  });

  it("an answer for another merchant transaction id", async () => {
    const s = await startPayment(k);
    settle(s, { status: "Success", merchantTransactionId: "TCP" + "f".repeat(32) });
    expect(await verify(s.merchantTransactionId)).toEqual(pending);
    expect((await k.payment(s.paymentId)).status).toBe("review");
    expect(await k.balance(s.customerId)).toBe(0n);
  });

  it("an EPS transaction id that another payment already holds", async () => {
    const first = await startPayment(k);
    settle(first, { status: "Success", epsTransactionId: "dup-eps-1" });
    await verify(first.merchantTransactionId);
    const second = await startPayment(k);
    settle(second, { status: "Success", epsTransactionId: "dup-eps-1" });
    expect(await verify(second.merchantTransactionId)).toEqual(pending);
    expect((await k.payment(second.paymentId)).status).toBe("review");
    expect(await k.balance(second.customerId)).toBe(0n);
  });

  it("an EPS transaction id longer than the column is credited without it, not stuck", async () => {
    const s = await startPayment(k, 20000n);
    settle(s, { status: "Success", epsTransactionId: "x".repeat(200) });
    expect(await verify(s.merchantTransactionId)).toEqual(credited);
    expect(await k.balance(s.customerId)).toBe(20000n);
  });

  it("a success after the payment expired goes to review (open point 2)", async () => {
    const s = await startPayment(k);
    await k.pool.query("update payments set status = 'expired' where id = $1", [s.paymentId]);
    settle(s, { status: "Success" });
    expect(await verify(s.merchantTransactionId)).toEqual(pending);
    expect((await k.payment(s.paymentId)).status).toBe("review");
    expect(await k.balance(s.customerId)).toBe(0n);
    expect((await k.discrepancies()).at(-1)?.details).toMatchObject({ reason: "late_success" });
  });

  it("a failed answer for an expired row leaves it expired", async () => {
    const s = await startPayment(k);
    await k.pool.query("update payments set status = 'expired' where id = $1", [s.paymentId]);
    settle(s, { status: "Failed" });
    expect(await verify(s.merchantTransactionId)).toEqual({
      ok: true,
      value: { state: "expired" },
    });
    expect((await k.payment(s.paymentId)).status).toBe("expired");
  });
});

describe("what is refused before EPS is called", () => {
  it("a malformed id is not_found with no EPS call", async () => {
    k.reset();
    for (const id of ["", "TCP123", "tcp" + "a".repeat(32), "TCP" + "A".repeat(32), "x'; drop"]) {
      expect(await verify(id)).toEqual({ ok: false, error: "not_found" });
    }
    expect(await verifyPayment(k.deps(), 5 as unknown as string)).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(k.eps.verifyCalls).toHaveLength(0);
  });

  it("a well-formed id that is not stored is not_found with no EPS call", async () => {
    k.reset();
    expect(await verify("TCP" + "0".repeat(32))).toEqual({ ok: false, error: "not_found" });
    expect(k.eps.verifyCalls).toHaveLength(0);
  });

  it("a review row is pending with no EPS call", async () => {
    const s = await startPayment(k);
    await k.pool.query("update payments set status = 'review' where id = $1", [s.paymentId]);
    k.reset();
    expect(await verify(s.merchantTransactionId)).toEqual(pending);
    expect(k.eps.verifyCalls).toHaveLength(0);
  });

  it("with a client address the per-payment limit allows one EPS call in 5 seconds", async () => {
    k.reset();
    const s = await startPayment(k);
    settle(s, { status: "Pending" });
    const deps = k.deps();
    const ip = freshIp();
    expect(await verifyPayment(deps, s.merchantTransactionId, { clientIp: ip })).toEqual(pending);
    expect(await verifyPayment(deps, s.merchantTransactionId, { clientIp: ip })).toMatchObject({
      ok: false,
      error: "rate_limited",
    });
    expect(k.eps.verifyCalls).toHaveLength(1);
  });

  it("the 61st call from one address in a minute is rate_limited", async () => {
    k.reset();
    const deps = k.deps();
    const ip = freshIp();
    for (let i = 0; i < 60; i++) {
      const id = "TCP" + i.toString(16).padStart(32, "0");
      expect(await verifyPayment(deps, id, { clientIp: ip })).toEqual({
        ok: false,
        error: "not_found",
      });
    }
    expect(await verifyPayment(deps, "TCP" + "1".repeat(32), { clientIp: ip })).toMatchObject({
      ok: false,
      error: "rate_limited",
    });
  });

  it("a client address that is not an address is refused", async () => {
    const s = await startPayment(k);
    expect(await verifyPayment(k.deps(), s.merchantTransactionId, { clientIp: "x" })).toMatchObject(
      { ok: false, error: "validation" },
    );
  });
});

describe("the credit is one transaction", () => {
  it("a failing ledger post leaves the row redirected and posts nothing", async () => {
    k.reset();
    const s = await startPayment(k);
    settle(s, { status: "Success" });
    flags.failPost = true;
    try {
      const r = await verify(s.merchantTransactionId);
      expect(r).toEqual({ ok: false, error: "internal" });
      expect(JSON.stringify(r)).not.toContain(PLANTED_SECRET);
      expect(JSON.stringify(k.logs)).not.toContain(PLANTED_SECRET);
    } finally {
      flags.failPost = false;
    }
    expect((await k.payment(s.paymentId)).status).toBe("redirected");
    expect(await k.ledgerRows(ledgerKey.topup(s.paymentId))).toBe(0);
    expect(await k.balance(s.customerId)).toBe(0n);
    // and the next callback succeeds
    expect(await verify(s.merchantTransactionId)).toEqual(credited);
    expect(await k.balance(s.customerId)).toBe(150000n);
  });

  it("an error after the post (the hook) rolls back the post and the row update together", async () => {
    const s = await startPayment(k);
    settle(s, { status: "Success" });
    const deps = k.deps("web_rw", {
      onCredited: async () => {
        throw new Error("hook failed");
      },
    });
    expect(await verifyPayment(deps, s.merchantTransactionId)).toEqual({
      ok: false,
      error: "internal",
    });
    expect((await k.payment(s.paymentId)).status).toBe("redirected");
    expect(await k.ledgerRows(ledgerKey.topup(s.paymentId))).toBe(0);
    expect(await k.balance(s.customerId)).toBe(0n);
  });

  it("logs hold only the allowed keys and no id of the payment at EPS", async () => {
    k.reset();
    const s = await startPayment(k);
    settle(s, { status: "Success" });
    await verify(s.merchantTransactionId);
    const text = JSON.stringify(k.logs);
    expect(text).not.toContain(s.merchantTransactionId);
    expect(text).not.toContain("eps-");
    for (const l of k.logs) {
      for (const key of Object.keys(l.fields)) {
        expect(["paymentId", "state", "reason", "count", "ok"]).toContain(key);
      }
    }
  });
});
