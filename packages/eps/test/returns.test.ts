import { describe, expect, it } from "vitest";
import { ledgerKey } from "@tc/core";
import { handleEpsReturn } from "../returns";
import { freshIp, startPayment, useEpsKit } from "./kit";

const k = useEpsKit();
const REDIRECTS = /^\/wallet\?topup=(credited|pending|failed|cancelled|expired|unknown)$/;

describe("handleEpsReturn: the route decides nothing", () => {
  it("the success route with a verified success credits once", async () => {
    k.reset();
    const s = await startPayment(k);
    k.eps.settle(s.merchantTransactionId, { status: "Success" });
    const input = {
      outcome: "success" as const,
      query: { MerchantTransactionId: s.merchantTransactionId },
      clientIp: freshIp(),
    };
    expect(await handleEpsReturn(k.deps(), input)).toEqual({
      redirectTo: "/wallet?topup=credited",
      state: "credited",
    });
    expect(await k.balance(s.customerId)).toBe(150000n);
    // the browser reloads the page after the 5 seconds of the per-payment limit: still credited once
    k.clock.advance(6000);
    expect(await handleEpsReturn(k.deps(), { ...input, clientIp: freshIp() })).toMatchObject({
      state: "credited",
    });
    expect(await k.ledgerRows(ledgerKey.topup(s.paymentId))).toBe(1);
    expect(await k.balance(s.customerId)).toBe(150000n);
  });

  it("the fail route with a verified success credits once (verify wins)", async () => {
    const s = await startPayment(k);
    k.eps.settle(s.merchantTransactionId, { status: "Success" });
    const r = await handleEpsReturn(k.deps(), {
      outcome: "fail",
      query: { merchantTransactionId: s.merchantTransactionId },
      clientIp: freshIp(),
    });
    expect(r).toEqual({ redirectTo: "/wallet?topup=credited", state: "credited" });
    expect(await k.balance(s.customerId)).toBe(150000n);
  });

  it("the cancel route is read the same way", async () => {
    const s = await startPayment(k);
    k.eps.settle(s.merchantTransactionId, { status: "Cancelled" });
    const r = await handleEpsReturn(k.deps(), {
      outcome: "cancel",
      query: { merchant_transaction_id: s.merchantTransactionId },
      clientIp: freshIp(),
    });
    expect(r).toEqual({ redirectTo: "/wallet?topup=cancelled", state: "cancelled" });
  });

  it("the success route with EPS Failed credits nothing and shows failed", async () => {
    const s = await startPayment(k);
    k.eps.settle(s.merchantTransactionId, { status: "Failed" });
    const r = await handleEpsReturn(k.deps(), {
      outcome: "success",
      query: { MerchantTransactionId: s.merchantTransactionId },
      clientIp: freshIp(),
    });
    expect(r).toEqual({ redirectTo: "/wallet?topup=failed", state: "failed" });
    expect(await k.balance(s.customerId)).toBe(0n);
  });

  it("a forged status, amount and redirect in the query change nothing", async () => {
    k.reset();
    const s = await startPayment(k);
    k.eps.settle(s.merchantTransactionId, { status: "Pending" });
    const r = await handleEpsReturn(k.deps(), {
      outcome: "success",
      query: {
        MerchantTransactionId: s.merchantTransactionId,
        status: "Success",
        amount: "1",
        redirect: "https://evil.test",
        next: "//evil.test",
      },
      clientIp: freshIp(),
    });
    expect(r).toEqual({ redirectTo: "/wallet?topup=pending", state: "pending" });
    expect(r.redirectTo).not.toContain("evil");
    expect(await k.balance(s.customerId)).toBe(0n);
    expect((await k.payment(s.paymentId)).status).toBe("redirected");
  });

  it("two ids (repeated, or under two names) are unknown with no EPS call", async () => {
    k.reset();
    const s = await startPayment(k);
    const other = await startPayment(k);
    k.reset();
    const repeated = await handleEpsReturn(k.deps(), {
      outcome: "success",
      query: { MerchantTransactionId: [s.merchantTransactionId, other.merchantTransactionId] },
      clientIp: freshIp(),
    });
    const twoNames = await handleEpsReturn(k.deps(), {
      outcome: "success",
      query: {
        MerchantTransactionId: s.merchantTransactionId,
        merchantTransactionId: other.merchantTransactionId,
      },
      clientIp: freshIp(),
    });
    for (const r of [repeated, twoNames]) {
      expect(r).toEqual({ redirectTo: "/wallet?topup=unknown", state: "unknown" });
    }
    expect(k.eps.verifyCalls).toHaveLength(0);
  });

  it("an absent, empty or malformed id is unknown with no EPS call", async () => {
    k.reset();
    for (const query of [
      {},
      { MerchantTransactionId: "" },
      { MerchantTransactionId: "TCP123" },
      { MerchantTransactionId: "x".repeat(5000) },
      { other: "TCP" + "a".repeat(32) },
    ]) {
      const r = await handleEpsReturn(k.deps(), {
        outcome: "success",
        query,
        clientIp: freshIp(),
      });
      expect(r).toEqual({ redirectTo: "/wallet?topup=unknown", state: "unknown" });
    }
    expect(k.eps.verifyCalls).toHaveLength(0);
  });

  it("a forged id of the right shape that is not stored is unknown with no EPS call", async () => {
    k.reset();
    const r = await handleEpsReturn(k.deps(), {
      outcome: "success",
      query: { MerchantTransactionId: "TCP" + "e".repeat(32) },
      clientIp: freshIp(),
    });
    expect(r).toEqual({ redirectTo: "/wallet?topup=unknown", state: "unknown" });
    expect(k.eps.verifyCalls).toHaveLength(0);
  });

  it("the 61st request in a minute from one address is pending with no EPS call", async () => {
    k.reset();
    const ip = freshIp();
    for (let i = 0; i < 60; i++) {
      const r = await handleEpsReturn(k.deps(), {
        outcome: "success",
        query: { MerchantTransactionId: "TCP" + i.toString(16).padStart(32, "0") },
        clientIp: ip,
      });
      expect(r.state).toBe("unknown");
    }
    const s = await startPayment(k);
    k.reset();
    k.eps.settle(s.merchantTransactionId, { status: "Success" });
    const r = await handleEpsReturn(k.deps(), {
      outcome: "success",
      query: { MerchantTransactionId: s.merchantTransactionId },
      clientIp: ip,
    });
    expect(r).toEqual({ redirectTo: "/wallet?topup=pending", state: "pending" });
    expect(k.eps.verifyCalls).toHaveLength(0);
    expect(await k.balance(s.customerId)).toBe(0n);
  });

  it("EPS unavailable shows pending, never failed", async () => {
    const s = await startPayment(k);
    k.eps.failNext("unavailable");
    const r = await handleEpsReturn(k.deps(), {
      outcome: "fail",
      query: { MerchantTransactionId: s.merchantTransactionId },
      clientIp: freshIp(),
    });
    expect(r).toEqual({ redirectTo: "/wallet?topup=pending", state: "pending" });
    expect((await k.payment(s.paymentId)).status).toBe("redirected");
  });

  it("an address that is not an address is pending and nothing is asked", async () => {
    k.reset();
    const s = await startPayment(k);
    k.reset();
    const r = await handleEpsReturn(k.deps(), {
      outcome: "success",
      query: { MerchantTransactionId: s.merchantTransactionId },
      clientIp: "not an address",
    });
    expect(r.state).toBe("pending");
    expect(k.eps.verifyCalls).toHaveLength(0);
  });

  it("every redirect target is from the fixed list and the logs hold no id", async () => {
    k.reset();
    const s = await startPayment(k);
    k.eps.settle(s.merchantTransactionId, { status: "Success", totalAmount: "1.00" });
    const r = await handleEpsReturn(k.deps(), {
      outcome: "success",
      query: { MerchantTransactionId: s.merchantTransactionId },
      clientIp: freshIp(),
    });
    expect(r.redirectTo).toMatch(REDIRECTS);
    expect(JSON.stringify(k.logs)).not.toContain(s.merchantTransactionId);
  });
});
