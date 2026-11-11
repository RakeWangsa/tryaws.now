import type { InitializeRequest } from "@tc/eps";
import { beforeEach, describe, expect, it } from "vitest";
import { getDevEps } from "./eps-bridge.ts";
import { devVerifier } from "./dev-auth.ts";

const request: InitializeRequest = {
  merchantTransactionId: "0123456789abcdef0123456789abcdef",
  customerOrderId: "order-1",
  totalAmountMinor: 50_000n,
  ipAddress: "127.0.0.1",
  productName: "Wallet top-up",
  successUrl: "http://localhost:3000/pay/eps/success",
  failUrl: "http://localhost:3000/pay/eps/fail",
  cancelUrl: "http://localhost:3000/pay/eps/cancel",
};

beforeEach(() => {
  const dev = getDevEps();
  dev.fake.reset();
  dev.byData.clear();
});

describe("the dev EPS bridge", () => {
  it("initialize answers a path of the dev checkout and keeps data -> merchant transaction id", async () => {
    const dev = getDevEps();
    const answer = await dev.gateway.initialize(request);
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(answer.redirectUrl).toMatch(/^\/dev\/eps\/checkout\?data=\d+$/);
    expect(answer.gatewayTransactionId).toMatch(/^eps-\d+$/);
    const data = new URL(answer.redirectUrl, "http://localhost").searchParams.get("data");
    expect(dev.byData.get(data ?? "")).toBe(request.merchantTransactionId);
  });

  it("is one object per process, kept on globalThis for the dev checkout route", () => {
    expect(getDevEps()).toBe(getDevEps());
    expect((globalThis as Record<string, unknown>)["__tcDevEps"]).toBe(getDevEps());
  });

  it("a refused initialize adds no mapping", async () => {
    const dev = getDevEps();
    const answer = await dev.gateway.initialize({ ...request, totalAmountMinor: 0n });
    expect(answer.ok).toBe(false);
    expect(dev.byData.size).toBe(0);
  });

  it("verify is the one of the in-memory EPS: pending until settled, then the settled amount", async () => {
    const dev = getDevEps();
    await dev.gateway.initialize(request);
    const pending = await dev.gateway.verify(request.merchantTransactionId);
    expect(pending.ok).toBe(true);
    dev.fake.settle(request.merchantTransactionId, { status: "Success" });
    const settled = await dev.gateway.verify(request.merchantTransactionId);
    expect(settled.ok).toBe(true);
    expect(dev.fake.verifyCalls).toHaveLength(2);
  });
});

describe("the dev sign-in verifier", () => {
  it("accepts dev.<sub> and gives the sub", async () => {
    const out = await devVerifier.verify("dev.smoke-user_1");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.token.sub).toBe("smoke-user_1");
    expect(out.token.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(out.token.authTime.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("refuses anything else", async () => {
    for (const token of [
      undefined,
      "",
      "dev.",
      "dev",
      "eyJhbGciOi.x.y",
      "dev.a b",
      "dev.a/b",
      `dev.${"a".repeat(80)}`,
    ]) {
      const out = await devVerifier.verify(token);
      expect(out.ok, String(token)).toBe(false);
    }
  });
});
