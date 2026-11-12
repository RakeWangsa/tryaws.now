import { describe, expect, it } from "vitest";
import * as api from "../index";
import { createEps } from "../index";
import { freshIp, useEpsKit } from "./kit";

describe("the entry of @tc/eps", () => {
  it("exports exactly these runtime names, and no secret-bearing helper", () => {
    expect(Object.keys(api).sort()).toEqual(
      [
        "EPS_REDIRECT_HOSTS",
        "EPS_RETURN_PATHS",
        "EPS_TEST_REDIRECT_HOSTS",
        "InMemoryEps",
        "PAYMENT_STATES",
        "checkGatewayRedirect",
        "createEps",
        "createEpsGateway",
        "decide",
        "epsCredentials",
        "epsReturnUrls",
        "formatEpsAmount",
        "gatewayFormOrigins",
        "handleEpsReturn",
        "parseEpsAmount",
        "publicState",
        "recheckPayment",
        "startTopUp",
        "sweepPayments",
        "verifyPayment",
      ].sort(),
    );
    const names = Object.keys(api);
    expect(names).not.toContain("epsHash");
    expect(names).not.toContain("EPS_BASE_URL");
    expect(names).not.toContain("EPS_PATH");
  });
});

describe("createEps binds the services to one set of deps", () => {
  const kit = useEpsKit();

  it("has the five bound functions and nothing else", () => {
    const eps = createEps(kit.deps());
    expect(Object.keys(eps).sort()).toEqual([
      "handleReturn",
      "recheckPayment",
      "startTopUp",
      "sweep",
      "verifyPayment",
    ]);
  });

  it("starts a top-up and credits it once through the return handler", async () => {
    const eps = createEps(kit.deps());
    const customerId = await kit.newCustomer();
    const started = await eps.startTopUp(
      { customerId },
      { amountMinor: 150000n, idempotencyKey: "bound-" + crypto.randomUUID() },
      { clientIp: freshIp() },
    );
    if (!started.ok) throw new Error("start failed: " + started.error);
    const row = await kit.payment(started.value.paymentId);
    kit.eps.settle(row.merchantTransactionId, { status: "Success" });
    const back = await eps.handleReturn({
      outcome: "success",
      query: { MerchantTransactionId: row.merchantTransactionId },
      clientIp: freshIp(),
    });
    expect(back.state).toBe("credited");
    expect(await kit.balance(customerId)).toBe(150000n);
    const again = await eps.verifyPayment(row.merchantTransactionId);
    expect(again).toEqual({ ok: true, value: { state: "credited" } });
    expect(await eps.sweep()).toMatchObject({ credited: 0 });
  });
});
