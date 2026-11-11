import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryEps } from "../fake";
import type { InitializeRequest } from "../gateway";

const ID = "TCP" + "a".repeat(32);

function req(over: Partial<InitializeRequest> = {}): InitializeRequest {
  return {
    merchantTransactionId: ID,
    customerOrderId: "order-1",
    totalAmountMinor: 150000n,
    ipAddress: "203.0.113.7",
    productName: "Wallet top-up",
    successUrl: "https://example.test/pay/eps/success",
    failUrl: "https://example.test/pay/eps/fail",
    cancelUrl: "https://example.test/pay/eps/cancel",
    ...over,
  };
}

afterEach(() => vi.unstubAllEnvs());

describe("initialize", () => {
  it("records the request and answers with a numbered redirect", async () => {
    const eps = new InMemoryEps();
    const a = await eps.initialize(req());
    const b = await eps.initialize(req({ merchantTransactionId: "TCP" + "b".repeat(32) }));
    expect(a).toEqual({
      ok: true,
      redirectUrl: "https://pg.eps.test/PG?data=1",
      gatewayTransactionId: "eps-1",
    });
    expect(b).toEqual({
      ok: true,
      redirectUrl: "https://pg.eps.test/PG?data=2",
      gatewayTransactionId: "eps-2",
    });
    expect(eps.initialized.map((r) => r.merchantTransactionId)).toEqual([
      ID,
      "TCP" + "b".repeat(32),
    ]);
  });

  it("rejects a repeated id, a short id and a non-positive amount, as EPS does", async () => {
    const eps = new InMemoryEps();
    await eps.initialize(req());
    expect(await eps.initialize(req())).toEqual({ ok: false, reason: "rejected" });
    expect(await eps.initialize(req({ merchantTransactionId: "short" }))).toEqual({
      ok: false,
      reason: "rejected",
    });
    expect(
      await eps.initialize(
        req({ merchantTransactionId: "TCP" + "c".repeat(32), totalAmountMinor: 0n }),
      ),
    ).toEqual({
      ok: false,
      reason: "rejected",
    });
  });
});

describe("settle and verify", () => {
  it("answers success with the recorded amount by default and the real parser", async () => {
    const eps = new InMemoryEps();
    await eps.initialize(req());
    eps.settle(ID, { status: "Success" });
    const r = await eps.verify(ID);
    expect(r).toEqual({
      ok: true,
      reading: {
        status: "success",
        merchantTransactionId: ID,
        epsTransactionId: "eps-1",
        totalAmountMinor: 150000n,
        errorCode: null,
      },
    });
    expect(eps.verifyCalls).toEqual([ID]);
  });

  it("sends raw status text through the aliases", async () => {
    const eps = new InMemoryEps();
    await eps.initialize(req());
    eps.settle(ID, { status: "COMPLETED" });
    expect(await eps.verify(ID)).toMatchObject({ reading: { status: "success" } });
    eps.settle(ID, { status: "CANCELED" });
    expect(await eps.verify(ID)).toMatchObject({ reading: { status: "cancelled" } });
  });

  it("can send a wrong amount text, an amount that does not parse, and another id", async () => {
    const eps = new InMemoryEps();
    await eps.initialize(req());
    eps.settle(ID, { status: "Success", totalAmount: "15.00" });
    expect(await eps.verify(ID)).toMatchObject({ reading: { totalAmountMinor: 1500n } });
    eps.settle(ID, { status: "Success", totalAmount: "1500.001" });
    expect(await eps.verify(ID)).toMatchObject({
      reading: { status: "success", totalAmountMinor: null },
    });
    eps.settle(ID, {
      status: "Success",
      merchantTransactionId: "TCP" + "d".repeat(32),
      epsTransactionId: "x-9",
    });
    expect(await eps.verify(ID)).toMatchObject({
      reading: { merchantTransactionId: "TCP" + "d".repeat(32), epsTransactionId: "x-9" },
    });
  });

  it("verifies an id that was never initialized as pending with nulls", async () => {
    const eps = new InMemoryEps();
    expect(await eps.verify("TCP" + "e".repeat(32))).toEqual({
      ok: true,
      reading: {
        status: "pending",
        merchantTransactionId: null,
        epsTransactionId: null,
        totalAmountMinor: null,
        errorCode: null,
      },
    });
  });

  it("verifies an initialized but unsettled id as pending", async () => {
    const eps = new InMemoryEps();
    await eps.initialize(req());
    expect(await eps.verify(ID)).toMatchObject({ ok: true, reading: { status: "pending" } });
  });
});

describe("failNext", () => {
  it("returns unavailable the given number of times, for initialize and verify alike", async () => {
    const eps = new InMemoryEps();
    eps.failNext("unavailable", 2);
    expect(await eps.initialize(req())).toEqual({ ok: false, reason: "unavailable" });
    expect(await eps.verify(ID)).toEqual({ ok: false, reason: "unavailable" });
    expect(await eps.initialize(req())).toMatchObject({ ok: true });
  });

  it("defaults to one failure", async () => {
    const eps = new InMemoryEps();
    eps.failNext("unavailable");
    expect(await eps.verify(ID)).toEqual({ ok: false, reason: "unavailable" });
    expect(await eps.verify(ID)).toMatchObject({ ok: true });
  });

  it("throws an error that carries a planted secret", async () => {
    const eps = new InMemoryEps();
    eps.failNext("throw");
    await expect(eps.verify(ID)).rejects.toThrow(/gateway failed: .+/);
  });

  it("hangs without settling", async () => {
    const eps = new InMemoryEps();
    eps.failNext("hang");
    let settled = false;
    void eps.verify(ID).then(
      () => (settled = true),
      () => (settled = true),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
  });

  it("a failed initialize does not use up the id", async () => {
    const eps = new InMemoryEps();
    eps.failNext("unavailable");
    await eps.initialize(req());
    expect(await eps.initialize(req())).toMatchObject({ ok: true });
  });
});

describe("reset and guard", () => {
  it("reset clears records, outcomes and failures", async () => {
    const eps = new InMemoryEps();
    await eps.initialize(req());
    eps.settle(ID, { status: "Success" });
    eps.failNext("unavailable", 3);
    eps.reset();
    expect(eps.initialized).toEqual([]);
    expect(eps.verifyCalls).toEqual([]);
    expect(await eps.initialize(req())).toMatchObject({ ok: true, gatewayTransactionId: "eps-1" });
  });

  it("refuses to be built outside test and development (fail closed)", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(() => new InMemoryEps()).toThrow();
    vi.stubEnv("NODE_ENV", "");
    expect(() => new InMemoryEps()).toThrow();
    vi.stubEnv("NODE_ENV", "development");
    expect(() => new InMemoryEps()).not.toThrow();
  });
});
