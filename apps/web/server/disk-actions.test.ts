import type { CustomerSession } from "@tc/auth";
import { describe, expect, it } from "vitest";
import { addDiskDraftCore } from "./disk-actions.ts";
import type { OrderActionDeps } from "./order-actions.ts";

const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const PRODUCT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SERVER = "0190aaaa-0000-7000-8000-0000000000a1";

const session = (): CustomerSession => ({
  customerId: CUSTOMER,
  kycStatus: "verified",
  riskTier: "new",
  locale: "bn",
  signedInAt: new Date("2026-11-12T09:59:00Z"),
});

function orderDeps(over: { session?: CustomerSession | null; allowed?: boolean } = {}) {
  const seen: unknown[] = [];
  const order: string[] = [];
  const deps: OrderActionDeps = {
    authenticate: async () => {
      order.push("authenticate");
      return over.session === undefined ? session() : over.session;
    },
    rateLimit: async () => {
      order.push("rateLimit");
      return { allowed: over.allowed !== false };
    },
    orders: {
      createOrderDraft: async (_session: unknown, request: unknown) => {
        order.push("execute");
        seen.push(request);
        return { ok: true, value: { token: "signed" } } as never;
      },
      placeOrder: async () => {
        throw new Error("not used");
      },
    },
  };
  return { deps, seen, order };
}

const form = {
  productId: PRODUCT,
  region: "ap-south-1",
  displayName: " Data 1 ",
  sizeGb: "100",
  serverId: SERVER,
  customerId: "22222222-2222-4222-8222-222222222222",
  awsName: "tc-disk-evil",
};

describe("addDiskDraftCore", () => {
  it("hands the order code the five fields of the form, the size as a number, for the family disk (R11)", async () => {
    const { deps, seen } = orderDeps();
    expect(await addDiskDraftCore(deps, form)).toEqual({ ok: true, token: "signed" });
    expect(seen).toEqual([
      {
        family: "disk",
        config: {
          productId: PRODUCT,
          region: "ap-south-1",
          displayName: "Data 1",
          sizeGb: 100,
          serverId: SERVER,
        },
      },
    ]);
  });

  it("authenticates, validates, rate limits, then executes, in that order (R9)", async () => {
    const ok = orderDeps();
    await addDiskDraftCore(ok.deps, form);
    expect(ok.order).toEqual(["authenticate", "rateLimit", "execute"]);

    const anon = orderDeps({ session: null });
    expect(await addDiskDraftCore(anon.deps, form)).toEqual({
      ok: false,
      error: "unauthenticated",
    });
    expect(anon.order).toEqual(["authenticate"]);

    const bad = orderDeps();
    expect(await addDiskDraftCore(bad.deps, { ...form, sizeGb: "abc" })).toEqual({
      ok: false,
      error: "validation",
      fields: { sizeGb: "invalid" },
    });
    expect(bad.order).toEqual(["authenticate"]);

    const limited = orderDeps({ allowed: false });
    expect(await addDiskDraftCore(limited.deps, form)).toEqual({
      ok: false,
      error: "rate_limited",
    });
    expect(limited.order).toEqual(["authenticate", "rateLimit"]);
    expect(await addDiskDraftCore({ ...orderDeps().deps, orders: null }, form)).toEqual({
      ok: false,
      error: "unavailable",
    });
  });

  it("reads the size from text only: a float, an exponent, a sign and a blank are invalid", async () => {
    for (const sizeGb of ["12.5", "1e2", "-8", "+8", "", " ", "0x10", "7", "16385", undefined]) {
      const { deps, order } = orderDeps();
      const r = await addDiskDraftCore(deps, { ...form, sizeGb });
      expect(r, String(sizeGb)).toEqual({
        ok: false,
        error: "validation",
        fields: { sizeGb: "invalid" },
      });
      expect(order).toEqual(["authenticate"]);
    }
  });

  it("maps a refusal of the order code to a public key, fields only for validation", async () => {
    const { deps } = orderDeps();
    const refusing = (error: string, fields?: Record<string, string>): OrderActionDeps => ({
      ...deps,
      orders: {
        createOrderDraft: async () =>
          ({ ok: false, error, ...(fields ? { fields } : {}) }) as never,
        placeOrder: async () => {
          throw new Error("not used");
        },
      },
    });
    expect(await addDiskDraftCore(refusing("validation", { serverId: "invalid" }), form)).toEqual({
      ok: false,
      error: "validation",
      fields: { serverId: "invalid" },
    });
    expect(await addDiskDraftCore(refusing("flag_off"), form)).toEqual({
      ok: false,
      error: "flag_off",
    });
    expect(await addDiskDraftCore(refusing("limit_reached", { limit: "instances" }), form)).toEqual(
      { ok: false, error: "limit_reached" },
    );
    expect(await addDiskDraftCore(refusing("internal"), form)).toEqual({
      ok: false,
      error: "unavailable",
    });
  });

  it("another customer's server answers like a missing one: the same public answer, nothing else said (R8)", async () => {
    const { deps } = orderDeps();
    const answer: OrderActionDeps = {
      ...deps,
      orders: {
        createOrderDraft: async () =>
          ({ ok: false, error: "validation", fields: { serverId: "invalid" } }) as never,
        placeOrder: async () => {
          throw new Error("not used");
        },
      },
    };
    const theirs = await addDiskDraftCore(answer, { ...form, serverId: SERVER });
    const missing = await addDiskDraftCore(answer, {
      ...form,
      serverId: "0190aaaa-0000-7000-8000-0000000000ff",
    });
    expect(theirs).toEqual(missing);
  });
});
