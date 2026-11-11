import type { CustomerSession } from "@tc/auth";
import { describe, expect, it } from "vitest";
import { createDatabaseDraftCore } from "./databases-actions.ts";
import type { OrderActionDeps } from "./order-actions.ts";

const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const PRODUCT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const session = (): CustomerSession => ({
  customerId: CUSTOMER,
  kycStatus: "verified",
  riskTier: "new",
  locale: "bn",
  signedInAt: new Date(),
});

function orderDeps(over: { session?: CustomerSession | null; allowed?: boolean } = {}) {
  const seen: unknown[] = [];
  const deps: OrderActionDeps = {
    authenticate: async () => (over.session === undefined ? session() : over.session),
    rateLimit: async () => ({ allowed: over.allowed !== false }),
    orders: {
      createOrderDraft: async (_session: unknown, request: unknown) => {
        seen.push(request);
        return { ok: true, value: { token: "signed" } } as never;
      },
      placeOrder: async () => {
        throw new Error("not used");
      },
    },
  };
  return { deps, seen };
}

const form = {
  productId: PRODUCT,
  region: "ap-southeast-1",
  displayName: " Main DB ",
  // Fields the form does not have must never reach the order code (R11, U9).
  masterPassword: "hunter2",
  publiclyAccessible: "true",
  engine: "mysql",
};

describe("createDatabaseDraftCore", () => {
  it("hands the order code the three fields of a database and nothing else, for the family database", async () => {
    const { deps, seen } = orderDeps();
    expect(await createDatabaseDraftCore(deps, form)).toEqual({ ok: true, token: "signed" });
    expect(seen).toEqual([
      {
        family: "database",
        config: { productId: PRODUCT, region: "ap-southeast-1", displayName: "Main DB" },
      },
    ]);
  });

  it("refuses an unauthenticated request, a bad form and a rate limit, in that order (R9)", async () => {
    expect(await createDatabaseDraftCore(orderDeps({ session: null }).deps, form)).toEqual({
      ok: false,
      error: "unauthenticated",
    });
    const bad = await createDatabaseDraftCore(orderDeps().deps, { ...form, displayName: "<b>" });
    expect(bad).toEqual({ ok: false, error: "validation", fields: { displayName: "invalid" } });
    expect(await createDatabaseDraftCore(orderDeps({ allowed: false }).deps, form)).toEqual({
      ok: false,
      error: "rate_limited",
    });
    expect(await createDatabaseDraftCore({ ...orderDeps().deps, orders: null }, form)).toEqual({
      ok: false,
      error: "unavailable",
    });
  });

  it("maps a refusal of the order code to a public key, with the fields only for validation", async () => {
    const base = orderDeps().deps;
    const refusing: OrderActionDeps = {
      ...base,
      orders: {
        createOrderDraft: async () =>
          ({ ok: false, error: "validation", fields: { productId: "unavailable" } }) as never,
        placeOrder: async () => {
          throw new Error("not used");
        },
      },
    };
    expect(await createDatabaseDraftCore(refusing, form)).toEqual({
      ok: false,
      error: "validation",
      fields: { productId: "unavailable" },
    });
    const flag: OrderActionDeps = {
      ...base,
      orders: {
        createOrderDraft: async () => ({ ok: false, error: "flag_off" }) as never,
        placeOrder: async () => {
          throw new Error("not used");
        },
      },
    };
    expect(await createDatabaseDraftCore(flag, form)).toEqual({ ok: false, error: "flag_off" });
  });
});
