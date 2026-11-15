import { describe, expect, it } from "vitest";
import { reviewFromToken, topUpHref } from "./review-view.ts";
import type { Claims } from "./review-view.ts";

const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const claims: Claims = {
  v: 1,
  c: CUSTOMER,
  fam: "linux_instance",
  pid: "0190aaaa-0000-7000-8000-000000000001",
  region: "ap-south-1",
  cfg: { displayName: "web 1", keyPairId: null, productId: "x", region: "ap-south-1" },
  snap: {
    v: 1,
    currency: "BDT",
    pricedAt: "2026-11-12T00:00:00.000Z",
    awsPriceUsd: "5.0000",
    quantity: "1",
    fxRate: "120.0000",
    ruleVersion: "v1",
    baseMinor: "60000",
    steps: [{ code: "bd_vat", amountMinor: "9000" }],
    totalMinor: "69000",
  },
  iat: 1,
  exp: 2,
};
const ok = { ok: true as const, claims };

describe("reviewFromToken", () => {
  it("builds the lines from the signed snapshot, with money as bigint", () => {
    const r = reviewFromToken(() => ok, "tok", CUSTOMER, 100000n);
    expect(r.state).toBe("ready");
    if (r.state !== "ready") return;
    expect(r.totalMinor).toBe(69000n);
    expect(r.baseMinor).toBe(60000n);
    expect(r.steps).toEqual([{ code: "bd_vat", amountMinor: 9000n }]);
    expect(r.name).toBe("web 1");
    expect(r.shortfallTaka).toBeNull();
    expect(r.balanceAfterMinor).toBe(31000n);
  });

  it("WPU-X16: carries the BDT total only: no dollar price, no exchange rate (the draft is serialized to the browser)", () => {
    const withRate: Claims = {
      ...claims,
      fx: { id: "0190bbbb-0000-7000-8000-000000000002", at: "2026-11-10T04:00:00.000Z" },
    };
    const r = reviewFromToken(() => ({ ok: true, claims: withRate }), "tok", CUSTOMER, 100000n);
    if (r.state !== "ready") throw new Error("expected ready");
    expect(r.totalMinor).toBe(69000n);
    expect(Object.keys(r).filter((k) => /usd|fx|rate/i.test(k))).toEqual([]);
  });

  it("shows the shortfall rounded up to whole taka and a top-up amount", () => {
    const r = reviewFromToken(() => ok, "tok", CUSTOMER, 50001n);
    if (r.state !== "ready") throw new Error("expected ready");
    expect(r.shortfallTaka).toBe(190n);
    expect(r.balanceAfterMinor).toBeNull();
  });

  it("is invalid for a token of another customer, whatever the signature says", () => {
    expect(reviewFromToken(() => ok, "tok", "22222222-2222-4222-8222-222222222222", 0n).state).toBe(
      "invalid",
    );
  });

  it("maps the verdicts: expired and every other failure", () => {
    expect(reviewFromToken(() => ({ ok: false, reason: "expired" }), "t", CUSTOMER, 0n).state).toBe(
      "expired",
    );
    expect(
      reviewFromToken(() => ({ ok: false, reason: "signature" }), "t", CUSTOMER, 0n).state,
    ).toBe("invalid");
    expect(reviewFromToken(() => ok, undefined, CUSTOMER, 0n).state).toBe("invalid");
    // WPU-X10 review: the limit is that of an envelope of the largest draft (MAX_ENVELOPED_TOKEN, 5600).
    expect(reviewFromToken(() => ok, "x".repeat(5601), CUSTOMER, 0n).state).toBe("invalid");
  });

  it("is invalid when the snapshot cannot be read (fail closed)", () => {
    const bad = { ...claims, snap: { ...claims.snap, totalMinor: "not money" } };
    expect(reviewFromToken(() => ({ ok: true, claims: bad }), "t", CUSTOMER, 0n).state).toBe(
      "invalid",
    );
  });
});

describe("topUpHref", () => {
  it("pre-fills the amount and names the review page as next (U12, 16.11 step 4)", () => {
    const href = topUpHref("bn", 190n, "abc.def");
    expect(href).toBe(
      `/en/wallet/topup?amount=190&next=${encodeURIComponent("/orders/review?d=abc.def")}`,
    );
    expect(topUpHref("en", 190n, "abc.def").startsWith("/en/wallet/topup?")).toBe(true);
  });
});
