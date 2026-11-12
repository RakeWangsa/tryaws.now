import type { CustomerSession } from "@tc/auth";
import type { ResourceSummary } from "@tc/db";
import { describe, expect, it } from "vitest";
import type { FamilyActionDeps, FamilyRepos } from "./family-actions.ts";
import { DNS_ZONE_SPEC, createDnsZoneDraftCore, destroyDnsZoneCore } from "./dns-zone-actions.ts";
import type { OrderActionDeps } from "./order-actions.ts";

// WPU-G6: the create form and the delete of a DNS zone. R9 order in each, the zone name is the one
// customer text that goes on and only after the core rule accepted it (R11), another customer's zone is
// one answer with a missing one (R8), the flag decides (R12), a delete needs a fresh sign-in, the typed
// name and the approval queue (U10, R13), and a repeat of a form is one operation (R7).

const NOW = new Date("2026-11-12T10:00:00Z");
const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const ZONE = "0190aaaa-0000-7000-8000-0000000000d1";
const REQ = "0190aaaa-0000-7000-8000-0000000000f1";

const session = (signedInAt = new Date(NOW.getTime() - 60_000)): CustomerSession => ({
  customerId: CUSTOMER,
  kycStatus: "verified",
  riskTier: "new",
  locale: "bn",
  signedInAt,
});

// ---- the create form --------------------------------------------------------------------------------

function orderWorld(
  over: {
    session?: CustomerSession | null;
    allowed?: boolean;
    orders?: "none" | "ok" | { error: string; fields?: Record<string, string> };
  } = {},
) {
  const calls: string[] = [];
  const drafted: unknown[] = [];
  const deps: OrderActionDeps = {
    authenticate: async () => {
      calls.push("authenticate");
      return over.session === undefined ? (session() as never) : over.session;
    },
    rateLimit: async () => {
      calls.push("rate");
      return { allowed: over.allowed !== false };
    },
    orders:
      over.orders === "none"
        ? null
        : ({
            createOrderDraft: async (_s: unknown, input: unknown) => {
              calls.push("draft");
              drafted.push(input);
              if (typeof over.orders === "object") return { ok: false, ...over.orders };
              return { ok: true, value: { token: "signed-token" } };
            },
            placeOrder: async () => {
              throw new Error("not used");
            },
          } as never),
  };
  return { deps, calls, drafted };
}

const valid = { zoneName: "Shop.Example.COM", declaredControl: "on" };

describe("createDnsZoneDraftCore", () => {
  it("authenticates, validates, rate limits and drafts, in that order (R9), with the parsed name only", async () => {
    const { deps, calls, drafted } = orderWorld();
    expect(await createDnsZoneDraftCore(deps, valid)).toEqual({ ok: true, token: "signed-token" });
    expect(calls).toEqual(["authenticate", "rate", "draft"]);
    // The family is an argument of the code; only the validated name and the declaration go on (R11).
    expect(drafted).toEqual([
      { family: "dns_zone", config: { zoneName: "shop.example.com", declaredControl: true } },
    ]);
  });

  it("refuses an unauthenticated request before anything else", async () => {
    const { deps, calls } = orderWorld({ session: null });
    expect(await createDnsZoneDraftCore(deps, valid)).toEqual({
      ok: false,
      error: "unauthenticated",
    });
    expect(calls).toEqual(["authenticate"]);
  });

  it("refuses a name that is not a zone name, text that is not text, and a missing declaration, with field codes and no draft", async () => {
    for (const bad of [
      { ...valid, zoneName: "not a name" },
      { ...valid, zoneName: "https://example.com/" },
      { ...valid, zoneName: "com" },
      { ...valid, zoneName: "ex\u0000ample.com" },
      { ...valid, zoneName: ["a.example"] },
      { ...valid, zoneName: "a".repeat(300) + ".com" },
      { zoneName: valid.zoneName },
      { ...valid, declaredControl: "yes" },
      { ...valid, declaredControl: true },
      null,
      "x",
    ]) {
      const { deps, calls } = orderWorld();
      const out = await createDnsZoneDraftCore(deps, bad);
      expect(out).toMatchObject({ ok: false, error: "validation" });
      expect(calls).toEqual(["authenticate"]);
    }
    const { deps } = orderWorld();
    expect(await createDnsZoneDraftCore(deps, { zoneName: valid.zoneName })).toEqual({
      ok: false,
      error: "validation",
      fields: { declaredControl: "required" },
    });
    expect(await createDnsZoneDraftCore(deps, { ...valid, zoneName: "no" })).toEqual({
      ok: false,
      error: "validation",
      fields: { zoneName: "invalid_name" },
    });
  });

  it("is rate limited and refused when the order functions are not configured (R16)", async () => {
    const limited = orderWorld({ allowed: false });
    expect(await createDnsZoneDraftCore(limited.deps, valid)).toEqual({
      ok: false,
      error: "rate_limited",
    });
    expect(limited.calls).not.toContain("draft");
    const off = orderWorld({ orders: "none" });
    expect(await createDnsZoneDraftCore(off.deps, valid)).toEqual({
      ok: false,
      error: "unavailable",
    });
  });

  it("tells the customer a name is taken or registered with us, a flag that is off, and a missing price, and nothing else", async () => {
    const taken = orderWorld({ orders: { error: "conflict", fields: { zoneName: "taken" } } });
    expect(await createDnsZoneDraftCore(taken.deps, valid)).toEqual({
      ok: false,
      error: "unavailable",
      fields: { zoneName: "taken" },
    });
    const here = orderWorld({
      orders: { error: "validation", fields: { zoneName: "registered_here" } },
    });
    expect(await createDnsZoneDraftCore(here.deps, valid)).toEqual({
      ok: false,
      error: "validation",
      fields: { zoneName: "registered_here" },
    });
    const off = orderWorld({ orders: { error: "flag_off" } });
    expect(await createDnsZoneDraftCore(off.deps, valid)).toEqual({
      ok: false,
      error: "flag_off",
    });
    const unpriced = orderWorld({
      orders: { error: "validation", fields: { price: "unavailable" } },
    });
    expect(await createDnsZoneDraftCore(unpriced.deps, valid)).toEqual({
      ok: false,
      error: "validation",
      fields: { price: "unavailable" },
    });
    const internal = orderWorld({ orders: { error: "internal" } });
    expect(await createDnsZoneDraftCore(internal.deps, valid)).toEqual({
      ok: false,
      error: "unavailable",
    });
  });
});

// ---- the delete ------------------------------------------------------------------------------------

const zoneRow = (over: Partial<ResourceSummary> = {}): ResourceSummary => ({
  id: ZONE,
  family: "dns_zone",
  productId: null,
  region: "us-east-1",
  state: "active",
  parentResourceId: null,
  config: { zoneName: "shop.example.com", displayName: "shop.example.com" },
  createdAt: NOW,
  deletedAt: null,
  ...over,
});

function destroyWorld(
  over: {
    rows?: ResourceSummary[];
    flag?: boolean;
    allowed?: boolean;
    auditOk?: boolean;
    session?: CustomerSession | null;
    destroyError?: "conflict" | "not_found";
  } = {},
) {
  const calls: string[] = [];
  const rows = over.rows ?? [zoneRow()];
  const repos: FamilyRepos = {
    flagOn: async () => over.flag !== false,
    resources: {
      list: async () => rows,
      get: async (id: string) => rows.find((r) => r.id === id) ?? null,
    } as never,
    subscriptions: {
      requestDestroy: async (input: { idempotencyKey: string; withFinalSnapshot: boolean }) => {
        calls.push(`destroy:${input.idempotencyKey}:${input.withFinalSnapshot}`);
        if (over.destroyError) return { ok: false, error: over.destroyError };
        return {
          ok: true,
          replayed: false,
          value: { destroyOperationId: "d", finalSnapshotOperationId: null, needsApproval: true },
        } as never;
      },
    } as never,
    operations: {} as never,
    audit: {
      record: async (input: { action: string; targetId: string }) => {
        calls.push(`audit:${input.action}:${input.targetId}`);
        return over.auditOk === false ? { ok: false, error: "validation" } : { ok: true };
      },
    } as never,
    rateLimits: {
      consume: async (limits: { action: string }[]) => {
        calls.push(`rate:${limits[0]?.action}`);
        return { allowed: over.allowed !== false } as never;
      },
    } as never,
  };
  const deps: FamilyActionDeps = {
    authenticate: async () => (over.session === undefined ? session() : over.session),
    now: () => NOW,
    store: async (customerId, fn) => {
      calls.push(`store:${customerId}`);
      return fn(repos);
    },
  };
  return { deps, calls };
}

const del = { zoneId: ZONE, requestId: REQ, confirmName: "shop.example.com" };

describe("destroyDnsZoneCore", () => {
  it("describes a zone: no final snapshot, its records are kept in the config (R13)", () => {
    expect(DNS_ZONE_SPEC).toMatchObject({
      family: "dns_zone",
      idField: "zoneId",
      withFinalSnapshot: false,
    });
  });

  it("needs a fresh sign-in (U10), the exact zone name, then queues the destroy for approval (R13), in R9 order", async () => {
    const stale = destroyWorld({ session: session(new Date(NOW.getTime() - 3 * 3600_000)) });
    expect(await destroyDnsZoneCore(stale.deps, del)).toEqual({
      ok: false,
      error: "fresh_sign_in_required",
    });
    expect(stale.calls).toEqual([]);

    const wrongName = destroyWorld();
    expect(
      await destroyDnsZoneCore(wrongName.deps, { ...del, confirmName: "other.example.com" }),
    ).toEqual({
      ok: false,
      error: "name_mismatch",
    });
    expect(wrongName.calls.some((c) => c.startsWith("destroy:"))).toBe(false);

    const { deps, calls } = destroyWorld();
    expect(await destroyDnsZoneCore(deps, del)).toEqual({
      ok: true,
      done: "destroyQueued",
      approval: true,
    });
    expect(calls).toEqual([
      `store:${CUSTOMER}`,
      "rate:dns.destroy",
      `destroy:destroy:${REQ}:false`,
      `audit:dns.destroy:${ZONE}`,
    ]);
  });

  it("another customer's zone, a missing one and another family are one answer, and nothing is written (R8)", async () => {
    // The scoped repository answers null for another customer's row, so the store has no row.
    for (const rows of [[], [zoneRow({ family: "load_balancer" })]]) {
      const { deps, calls } = destroyWorld({ rows });
      expect(await destroyDnsZoneCore(deps, del)).toEqual({ ok: false, error: "not_found" });
      expect(calls.some((c) => c.startsWith("destroy:") || c.startsWith("audit:"))).toBe(false);
    }
  });

  it("refuses a flag that is off (R12), a zone that is not live, a rate limit, bad input and a conflict", async () => {
    const off = destroyWorld({ flag: false });
    expect(await destroyDnsZoneCore(off.deps, del)).toEqual({ ok: false, error: "flag_off" });
    for (const state of ["creating", "failed", "destroyed"] as const) {
      const w = destroyWorld({ rows: [zoneRow({ state })] });
      expect(await destroyDnsZoneCore(w.deps, del)).toEqual({ ok: false, error: "not_allowed" });
    }
    const limited = destroyWorld({ allowed: false });
    expect(await destroyDnsZoneCore(limited.deps, del)).toEqual({
      ok: false,
      error: "rate_limited",
    });
    for (const bad of [{ ...del, zoneId: "x" }, { ...del, requestId: "x" }, null]) {
      const w = destroyWorld();
      expect(await destroyDnsZoneCore(w.deps, bad)).toMatchObject({
        ok: false,
        error: "validation",
      });
      expect(w.calls).toEqual([]);
    }
    const conflict = destroyWorld({ destroyError: "conflict" });
    expect(await destroyDnsZoneCore(conflict.deps, del)).toEqual({
      ok: false,
      error: "not_allowed",
    });
  });

  it("refuses without a session, and a refused audit rolls back with a fixed key (R16)", async () => {
    const anon = destroyWorld({ session: null });
    expect(await destroyDnsZoneCore(anon.deps, del)).toEqual({
      ok: false,
      error: "unauthenticated",
    });
    const noAudit = destroyWorld({ auditOk: false });
    expect(await destroyDnsZoneCore(noAudit.deps, del)).toEqual({
      ok: false,
      error: "unavailable",
    });
  });

  it("a repeat of the same form is one operation: the key is the request id (R7)", async () => {
    const a = destroyWorld();
    const b = destroyWorld();
    await destroyDnsZoneCore(a.deps, del);
    await destroyDnsZoneCore(b.deps, del);
    expect(a.calls.filter((c) => c.startsWith("destroy:"))).toEqual(
      b.calls.filter((c) => c.startsWith("destroy:")),
    );
  });
});
