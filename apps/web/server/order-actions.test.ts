import type { ErrorCode, OrderDraft, OrderSession, Result } from "@tc/core";
import { describe, expect, it, vi } from "vitest";
import {
  createOrderDraftCore,
  placeOrderCore,
  publicErrorOf,
  type OrderActionDeps,
} from "./order-actions.ts";

const SESSION: OrderSession = {
  customerId: "11111111-1111-4111-8111-111111111111",
  kycStatus: "verified",
  riskTier: "new",
  locale: "bn",
};
const PRODUCT = "0190aaaa-0000-7000-8000-000000000001";
const DRAFT: OrderDraft = {
  token: "tok.en",
  quote: {
    currency: "BDT",
    fxRate: "120.0000",
    ruleVersion: "v1",
    baseMinor: 100000n,
    steps: [{ code: "vat", amountMinor: 15000n }],
    totalMinor: 115000n,
  },
  expiresAt: new Date("2026-11-12T00:30:00Z"),
};

function deps(over: Partial<OrderActionDeps> = {}): { deps: OrderActionDeps; calls: string[] } {
  const calls: string[] = [];
  const base: OrderActionDeps = {
    authenticate: async () => {
      calls.push("authenticate");
      return SESSION;
    },
    rateLimit: async () => {
      calls.push("rateLimit");
      return { allowed: true };
    },
    orders: {
      createOrderDraft: async (_s, input) => {
        calls.push("createOrderDraft");
        calls.push(JSON.stringify(input));
        return { ok: true, value: DRAFT };
      },
      placeOrder: async () => {
        calls.push("placeOrder");
        return { ok: true, value: { orderId: "0190bbbb-0000-7000-8000-000000000001" } };
      },
    },
  };
  return { deps: { ...base, ...over }, calls };
}

const form = {
  productId: PRODUCT,
  region: "ap-south-1",
  displayName: "My server",
  keyPairId: "",
};

describe("createOrderDraftCore", () => {
  it("runs in the order of R9: authenticate, validate, rate limit, execute", async () => {
    const { deps: d, calls } = deps();
    const result = await createOrderDraftCore(d, form);
    expect(result).toEqual({ ok: true, token: "tok.en" });
    expect(calls.slice(0, 2)).toEqual(["authenticate", "rateLimit"]);
    expect(calls[2]).toBe("createOrderDraft");
    // Only the family and the four known fields reach the order code; an empty key becomes null.
    expect(JSON.parse(calls[3] as string)).toEqual({
      family: "linux_instance",
      config: { ...form, keyPairId: null },
    });
  });

  it("refuses without a session and runs nothing else", async () => {
    const { deps: d, calls } = deps({ authenticate: async () => null });
    expect(await createOrderDraftCore(d, form)).toEqual({ ok: false, error: "unauthenticated" });
    expect(calls).toEqual([]);
  });

  it("refuses invalid fields before the rate limit and the order code", async () => {
    const { deps: d, calls } = deps();
    const result = await createOrderDraftCore(d, {
      ...form,
      displayName: "<b>x</b>",
      productId: "x",
    });
    expect(result).toEqual({
      ok: false,
      error: "validation",
      fields: { displayName: "invalid", productId: "invalid" },
    });
    expect(calls).toEqual(["authenticate"]);
  });

  it("sends the family given by the code for a Windows plan, never one from the form", async () => {
    const { deps: d, calls } = deps();
    await createOrderDraftCore(d, { ...form, family: "database" }, "windows_instance");
    const sent = JSON.parse(calls[3] as string) as { family: string };
    expect(sent.family).toBe("windows_instance");
  });

  it("does not forward unknown form fields such as an AWS name or a customer id", async () => {
    const { deps: d, calls } = deps();
    await createOrderDraftCore(d, { ...form, awsName: "x", customerId: "y", family: "database" });
    const sent = JSON.parse(calls[3] as string) as { family: string; config: object };
    expect(sent.family).toBe("linux_instance");
    expect(Object.keys(sent.config).sort()).toEqual([
      "displayName",
      "keyPairId",
      "productId",
      "region",
    ]);
  });

  it("forwards a backup to restore from, validated as an id, and no key pair with it", async () => {
    const backup = "0190aaaa-0000-7000-8000-0000000000b1";
    const { deps: d, calls } = deps();
    await createOrderDraftCore(d, { ...form, restoreFromBackupId: backup });
    const sent = JSON.parse(calls[3] as string) as { config: Record<string, unknown> };
    expect(sent.config["restoreFromBackupId"]).toBe(backup);
    expect(sent.config["keyPairId"]).toBeNull();

    const bad = deps();
    expect(await createOrderDraftCore(bad.deps, { ...form, restoreFromBackupId: "../x" })).toEqual({
      ok: false,
      error: "validation",
      fields: { restoreFromBackupId: "invalid" },
    });
    expect(bad.calls).toEqual(["authenticate"]);

    const withKey = deps();
    expect(
      await createOrderDraftCore(withKey.deps, {
        ...form,
        restoreFromBackupId: backup,
        keyPairId: "0190aaaa-0000-7000-8000-0000000000c1",
      }),
    ).toMatchObject({ ok: false, error: "validation", fields: { keyPairId: "invalid" } });
  });

  it("answers rate_limited when the limit is spent and does not call the order code", async () => {
    const { deps: d, calls } = deps({ rateLimit: async () => ({ allowed: false }) });
    expect(await createOrderDraftCore(d, form)).toEqual({ ok: false, error: "rate_limited" });
    expect(calls).not.toContain("createOrderDraft");
  });

  it("fails closed when the order functions are not configured", async () => {
    const { deps: d } = deps({ orders: null });
    expect(await createOrderDraftCore(d, form)).toEqual({ ok: false, error: "unavailable" });
  });

  it.each<[ErrorCode, string]>([
    ["kyc_required", "kyc_required"],
    ["forbidden", "forbidden"],
    ["flag_off", "flag_off"],
    ["limit_reached", "limit_reached"],
    ["capacity_full", "capacity_full"],
    ["internal", "unavailable"],
    ["upstream_unavailable", "unavailable"],
    ["not_found", "unavailable"],
  ])("maps the error %s to the public key %s", async (code, key) => {
    const refused: Result<OrderDraft> = { ok: false, error: code, ref: "abc12345" };
    const { deps: d } = deps({
      orders: {
        createOrderDraft: async () => refused,
        placeOrder: async () => refused as never,
      },
    });
    const result = await createOrderDraftCore(d, form);
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toBe(key);
    expect(JSON.stringify(result)).not.toMatch(/arn:|\b\d{12}\b|Lightsail/);
  });
});

describe("placeOrderCore", () => {
  const input = { token: "tok.en", idempotencyKey: "0190bbbb-0000-7000-8000-00000000aaaa" };

  it("authenticates, rate limits nowhere itself (the order code does), and returns the order id", async () => {
    const { deps: d, calls } = deps();
    expect(await placeOrderCore(d, input)).toEqual({
      ok: true,
      orderId: "0190bbbb-0000-7000-8000-000000000001",
    });
    expect(calls).toEqual(["authenticate", "placeOrder"]);
  });

  it("refuses a malformed idempotency key as validation before any call", async () => {
    const { deps: d, calls } = deps();
    const result = await placeOrderCore(d, { ...input, idempotencyKey: "short" });
    expect(result).toEqual({
      ok: false,
      error: "validation",
      fields: { idempotencyKey: "invalid" },
    });
    expect(calls).toEqual(["authenticate"]);
  });

  it("returns the new draft on price_changed, with money as decimal text", async () => {
    const changed: OrderDraft = {
      ...DRAFT,
      token: "new.tok",
      quote: { ...DRAFT.quote, totalMinor: 120000n },
    };
    const { deps: d } = deps({
      orders: {
        createOrderDraft: async () => ({ ok: true, value: DRAFT }),
        placeOrder: async () => ({ ok: false, error: "price_changed", data: changed }),
      },
    });
    const result = await placeOrderCore(d, input);
    expect(result).toEqual({
      ok: false,
      error: "price_changed",
      draft: { token: "new.tok", totalMinor: "120000", expiresAt: "2026-11-12T00:30:00.000Z" },
    });
  });

  it("keeps a price_changed with data of an unknown shape as unavailable (fail closed)", async () => {
    const { deps: d } = deps({
      orders: {
        createOrderDraft: async () => ({ ok: true, value: DRAFT }),
        placeOrder: async () => ({ ok: false, error: "price_changed", data: { nope: 1 } }),
      },
    });
    expect(await placeOrderCore(d, input)).toEqual({ ok: false, error: "unavailable" });
  });

  it("maps insufficient_balance and an expired token", async () => {
    const spy = vi.fn();
    const mk = (error: ErrorCode, fields?: Record<string, string>) =>
      deps({
        orders: {
          createOrderDraft: async () => ({ ok: true, value: DRAFT }),
          placeOrder: async () => {
            spy();
            return { ok: false, error, ...(fields ? { fields } : {}) };
          },
        },
      }).deps;
    expect(await placeOrderCore(mk("insufficient_balance"), input)).toEqual({
      ok: false,
      error: "insufficient_balance",
    });
    expect(await placeOrderCore(mk("validation", { token: "expired" }), input)).toEqual({
      ok: false,
      error: "draft_expired",
    });
  });
});

describe("publicErrorOf", () => {
  it("never returns a code outside the fixed list", () => {
    for (const code of ["conflict", "unauthenticated", "internal", "rate_limited"] as ErrorCode[]) {
      expect(typeof publicErrorOf(code)).toBe("string");
    }
  });
});
