import type { CustomerSession } from "@tc/auth";
import { describe, expect, it } from "vitest";
import { restoreDiskDraftCore } from "./disk-actions.ts";
import type { OrderActionDeps } from "./order-actions.ts";

// WPU-B5 item 26: the core of the Server Action that starts a new disk from a snapshot. It writes no
// operation itself: it hands the order code a draft (R1) and the order code checks the snapshot through
// the customer's own repositories (R8).
const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const PRODUCT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SNAPSHOT = "0190aaaa-0000-7000-8000-0000000000b1";

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
  displayName: " Restored 1 ",
  sizeGb: "100",
  restoreFromBackupId: SNAPSHOT,
  customerId: "22222222-2222-4222-8222-222222222222",
  awsName: "tc-disk-evil",
  serverId: "0190aaaa-0000-7000-8000-0000000000a1",
};

describe("restoreDiskDraftCore", () => {
  it("hands the order code the five fields only, for the family disk, with no server id (R11)", async () => {
    const { deps, seen } = orderDeps();
    expect(await restoreDiskDraftCore(deps, form)).toEqual({ ok: true, token: "signed" });
    expect(seen).toEqual([
      {
        family: "disk",
        config: {
          productId: PRODUCT,
          region: "ap-south-1",
          displayName: "Restored 1",
          sizeGb: 100,
          restoreFromBackupId: SNAPSHOT,
        },
      },
    ]);
  });

  it("authenticates, validates, rate limits, then executes (R9)", async () => {
    const ok = orderDeps();
    await restoreDiskDraftCore(ok.deps, form);
    expect(ok.order).toEqual(["authenticate", "rateLimit", "execute"]);

    const anon = orderDeps({ session: null });
    expect(await restoreDiskDraftCore(anon.deps, form)).toEqual({
      ok: false,
      error: "unauthenticated",
    });
    expect(anon.order).toEqual(["authenticate"]);

    const bad = orderDeps();
    expect(await restoreDiskDraftCore(bad.deps, { ...form, restoreFromBackupId: "x" })).toEqual({
      ok: false,
      error: "validation",
      fields: { restoreFromBackupId: "invalid" },
    });
    expect(bad.order).toEqual(["authenticate"]);

    const limited = orderDeps({ allowed: false });
    expect(await restoreDiskDraftCore(limited.deps, form)).toEqual({
      ok: false,
      error: "rate_limited",
    });
    expect(limited.order).toEqual(["authenticate", "rateLimit"]);
  });

  it("a form without a snapshot is refused and never becomes a plain disk (R16)", async () => {
    const { deps, order } = orderDeps();
    expect(await restoreDiskDraftCore(deps, { ...form, restoreFromBackupId: undefined })).toEqual({
      ok: false,
      error: "validation",
      fields: { restoreFromBackupId: "invalid" },
    });
    expect(order).toEqual(["authenticate"]);
  });

  it("another customer's snapshot answers like a missing one: the same public answer (R8)", async () => {
    const { deps } = orderDeps();
    const answer: OrderActionDeps = {
      ...deps,
      orders: {
        createOrderDraft: async () =>
          ({
            ok: false,
            error: "validation",
            fields: { restoreFromBackupId: "invalid" },
          }) as never,
        placeOrder: async () => {
          throw new Error("not used");
        },
      },
    };
    const theirs = await restoreDiskDraftCore(answer, form);
    const missing = await restoreDiskDraftCore(answer, {
      ...form,
      restoreFromBackupId: "0190aaaa-0000-7000-8000-0000000000ff",
    });
    expect(theirs).toEqual(missing);
    expect(theirs).toEqual({
      ok: false,
      error: "validation",
      fields: { restoreFromBackupId: "invalid" },
    });
  });
});
