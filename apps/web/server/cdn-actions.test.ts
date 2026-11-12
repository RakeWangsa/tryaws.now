import type { CustomerSession } from "@tc/auth";
import type { ResourceSummary } from "@tc/db";
import { describe, expect, it } from "vitest";
import {
  createCdnDraftCore,
  destroyCdnCore,
  setCdnEnabledCore,
  type CdnActionDeps,
  type CdnRepos,
} from "./cdn-actions.ts";
import type { OrderActionDeps } from "./order-actions.ts";

const NOW = new Date("2026-11-12T10:00:00Z");
const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const CDN = "0190aaaa-0000-7000-8000-0000000000c1";
const SERVER = "0190aaaa-0000-7000-8000-0000000000a1";
const REQ = "0190aaaa-0000-7000-8000-0000000000f1";
const PRODUCT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const session = (signedInAt = new Date(NOW.getTime() - 60_000)): CustomerSession => ({
  customerId: CUSTOMER,
  kycStatus: "verified",
  riskTier: "new",
  locale: "bn",
  signedInAt,
});

const row = (over: Partial<ResourceSummary> = {}): ResourceSummary => ({
  id: CDN,
  family: "cdn",
  productId: PRODUCT,
  region: "us-east-1",
  state: "active",
  parentResourceId: null,
  config: { displayName: "site-cdn", originId: SERVER },
  createdAt: NOW,
  deletedAt: null,
  ...over,
});

function world(
  over: {
    rows?: ResourceSummary[];
    flag?: boolean;
    allowed?: boolean;
    auditOk?: boolean;
    approval?: boolean;
    destroyError?: "conflict" | "not_found";
    requestError?: "not_found" | "conflict";
    session?: CustomerSession | null;
    /** WPU-S3: the operations of the distribution, as the customer's repository lists them. */
    ops?: { kind: string; state: string }[] | "throws";
  } = {},
) {
  const calls: string[] = [];
  const rows = over.rows ?? [row()];
  const repos: CdnRepos = {
    cdnOn: async () => over.flag !== false,
    resources: {
      list: async () => rows,
      get: async (id) => rows.find((r) => r.id === id) ?? null,
      countLive: async () => 0,
      listChildren: async () => [],
      createBackupRow: async () => {
        throw new Error("not used");
      },
    },
    subscriptions: {
      get: async () => null,
      list: async () => [],
      setAutoRenew: async () => {
        throw new Error("not used");
      },
      requestDestroy: async (input: { idempotencyKey: string; withFinalSnapshot: boolean }) => {
        calls.push(`destroy:${input.idempotencyKey}:${input.withFinalSnapshot}`);
        if (over.destroyError) return { ok: false, error: over.destroyError };
        return {
          ok: true,
          replayed: false,
          value: {
            destroyOperationId: "d",
            finalSnapshotOperationId: null,
            needsApproval: over.approval !== false,
          },
        } as never;
      },
    } as never,
    operations: {
      get: async () => null,
      listForResource: async () => {
        if (over.ops === "throws") throw new Error("operations unreadable");
        return (over.ops ?? []) as never;
      },
      listRecent: async () => [],
      request: async (input) => {
        calls.push(`op:${input.kind}:${input.idempotencyKey}:${input.resourceId}`);
        if (over.requestError) return { ok: false, error: over.requestError };
        return { ok: true, replayed: false, value: { needsApproval: false } } as never;
      },
    },
    audit: {
      record: async (input: { action: string }) => {
        calls.push(`audit:${input.action}`);
        return over.auditOk === false ? { ok: false, error: "validation" } : { ok: true };
      },
    } as never,
    rateLimits: {
      consume: async () => {
        calls.push("rate");
        return { allowed: over.allowed !== false } as never;
      },
    } as never,
  };
  const deps: CdnActionDeps = {
    authenticate: async () => (over.session === undefined ? session() : over.session),
    now: () => NOW,
    store: async (customerId, fn) => {
      calls.push(`store:${customerId}`);
      return fn(repos);
    },
  };
  return { deps, calls };
}

describe("setCdnEnabledCore", () => {
  const off = { cdnId: CDN, requestId: REQ, enabled: "off" };

  it("authenticates first, then rates, executes and audits (R9); off is stop, with its own key (R7)", async () => {
    const { deps, calls } = world();
    expect(await setCdnEnabledCore(deps, off)).toEqual({ ok: true, done: "disabled" });
    expect(calls).toEqual([
      `store:${CUSTOMER}`,
      "rate",
      `op:stop:cdn-enabled:${REQ}:${CDN}`,
      "audit:cdn.disable",
    ]);
  });

  it("on is start, from stopped only", async () => {
    const stopped = world({ rows: [row({ state: "stopped" })] });
    expect(await setCdnEnabledCore(stopped.deps, { ...off, enabled: "on" })).toEqual({
      ok: true,
      done: "enabled",
    });
    expect(stopped.calls).toContain(`op:start:cdn-enabled:${REQ}:${CDN}`);
    const active = world();
    expect(await setCdnEnabledCore(active.deps, { ...off, enabled: "on" })).toEqual({
      ok: false,
      error: "not_allowed",
    });
    expect(
      await setCdnEnabledCore(world({ rows: [row({ state: "suspended" })] }).deps, off),
    ).toEqual({ ok: false, error: "not_allowed" });
  });

  it("refuses without a session before anything else", async () => {
    const { deps, calls } = world({ session: null });
    expect(await setCdnEnabledCore(deps, off)).toEqual({ ok: false, error: "unauthenticated" });
    expect(calls).toEqual([]);
  });

  it("validates ids and the switch before the store is opened", async () => {
    const { deps, calls } = world();
    const result = await setCdnEnabledCore(deps, { cdnId: "x", requestId: "y", enabled: "maybe" });
    expect(result).toEqual({
      ok: false,
      error: "validation",
      fields: { cdnId: "invalid", requestId: "invalid", enabled: "invalid" },
    });
    expect(calls).toEqual([]);
  });

  it("answers a flag that is off with flag_off and writes nothing (R12)", async () => {
    const { deps, calls } = world({ flag: false });
    expect(await setCdnEnabledCore(deps, off)).toEqual({ ok: false, error: "flag_off" });
    expect(calls).not.toContain("rate");
  });

  it("another customer's distribution, a missing one and another family give one answer (R8)", async () => {
    const answers = [
      await setCdnEnabledCore(world({ rows: [] }).deps, off),
      await setCdnEnabledCore(world({ rows: [row({ family: "bucket" })] }).deps, off),
    ];
    expect(answers[0]).toEqual({ ok: false, error: "not_found" });
    expect(answers[1]).toEqual(answers[0]);
  });

  it("is rate limited, and an audit that is refused rolls the action back with a fixed key", async () => {
    const { deps } = world({ allowed: false });
    expect(await setCdnEnabledCore(deps, off)).toEqual({ ok: false, error: "rate_limited" });
    const bad = world({ auditOk: false });
    expect(await setCdnEnabledCore(bad.deps, off)).toEqual({ ok: false, error: "unavailable" });
    const failed = world({ requestError: "conflict" });
    expect(await setCdnEnabledCore(failed.deps, off)).toEqual({
      ok: false,
      error: "unavailable",
    });
  });
});

// WPU-S3: while the apply of a pending plan is queued or running, the customer cannot turn the
// distribution off or destroy it: the apply would conflict after the renewal charged the new price.
describe("WPU-S3: no state change while a plan apply is on its way", () => {
  const apply = (state: string) => [{ kind: "change_cdn_bundle", state }];
  const off = { cdnId: CDN, requestId: REQ, enabled: "off" };
  const gone = { cdnId: CDN, requestId: REQ, confirmName: "site-cdn" };

  it("refuses disabling with busy and queues, audits and consumes nothing", async () => {
    for (const state of ["queued", "running", "waiting", "needs_approval"]) {
      const w = world({ ops: apply(state) });
      expect(await setCdnEnabledCore(w.deps, off)).toEqual({ ok: false, error: "busy" });
      expect(w.calls.filter((c) => c.startsWith("op:") || c.startsWith("audit:"))).toEqual([]);
    }
  });

  it("refuses a destroy with busy", async () => {
    const w = world({ ops: apply("queued") });
    expect(await destroyCdnCore(w.deps, gone)).toEqual({ ok: false, error: "busy" });
    expect(w.calls.filter((c) => c.startsWith("destroy:") || c.startsWith("audit:"))).toEqual([]);
  });

  it("a finished or failed apply, and another kind of operation, do not block", async () => {
    for (const ops of [
      apply("succeeded"),
      apply("needs_attention"),
      [{ kind: "rename", state: "queued" }],
    ]) {
      expect(await setCdnEnabledCore(world({ ops }).deps, off)).toEqual({
        ok: true,
        done: "disabled",
      });
    }
  });

  it("fails closed when the operations cannot be read (R16)", async () => {
    const w = world({ ops: "throws" });
    expect(await setCdnEnabledCore(w.deps, off)).toEqual({ ok: false, error: "unavailable" });
    expect(await destroyCdnCore(w.deps, gone)).toEqual({ ok: false, error: "unavailable" });
  });

  it("enabling a stopped distribution is not blocked by the check", async () => {
    const w = world({ rows: [row({ state: "stopped" })], ops: apply("queued") });
    expect(await setCdnEnabledCore(w.deps, { cdnId: CDN, requestId: REQ, enabled: "on" })).toEqual({
      ok: true,
      done: "enabled",
    });
  });
});

describe("destroyCdnCore", () => {
  const input = { cdnId: CDN, requestId: REQ, confirmName: "site-cdn" };

  it("needs a fresh sign-in (U10), then the exact name, then queues a destroy without a snapshot (R13)", async () => {
    const stale = world({ session: session(new Date(NOW.getTime() - 3 * 3_600_000)) });
    expect(await destroyCdnCore(stale.deps, input)).toEqual({
      ok: false,
      error: "fresh_sign_in_required",
    });
    expect(stale.calls).toEqual([]);

    const wrong = world();
    expect(await destroyCdnCore(wrong.deps, { ...input, confirmName: "site-CDN" })).toEqual({
      ok: false,
      error: "name_mismatch",
    });

    const { deps, calls } = world();
    expect(await destroyCdnCore(deps, input)).toEqual({
      ok: true,
      done: "destroyQueued",
      approval: true,
    });
    expect(calls).toEqual([
      `store:${CUSTOMER}`,
      "rate",
      `destroy:destroy:${REQ}:false`,
      "audit:cdn.destroy",
    ]);
  });

  it("refuses a distribution that is not live, another customer's, and a flag that is off", async () => {
    expect(await destroyCdnCore(world({ rows: [row({ state: "creating" })] }).deps, input)).toEqual(
      {
        ok: false,
        error: "not_allowed",
      },
    );
    expect(await destroyCdnCore(world({ rows: [] }).deps, input)).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(await destroyCdnCore(world({ flag: false }).deps, input)).toEqual({
      ok: false,
      error: "flag_off",
    });
    expect(await destroyCdnCore(world({ destroyError: "conflict" }).deps, input)).toEqual({
      ok: false,
      error: "not_allowed",
    });
  });
});

describe("createCdnDraftCore", () => {
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
    region: "us-east-1",
    displayName: " Site CDN ",
    originId: SERVER,
    cacheBehavior: "cache",
    domain: "shop.example.com",
  };

  it("hands the order code the five fields of the form and nothing else, for the family cdn (R11)", async () => {
    const { deps, seen } = orderDeps();
    expect(await createCdnDraftCore(deps, form)).toEqual({ ok: true, token: "signed" });
    expect(seen).toEqual([
      {
        family: "cdn",
        config: {
          productId: PRODUCT,
          region: "us-east-1",
          displayName: "Site CDN",
          originId: SERVER,
          cacheBehavior: "cache",
        },
      },
    ]);
  });

  it("refuses an unauthenticated request, a bad form and a rate limit, in that order (R9)", async () => {
    expect(await createCdnDraftCore(orderDeps({ session: null }).deps, form)).toEqual({
      ok: false,
      error: "unauthenticated",
    });
    const bad = await createCdnDraftCore(orderDeps().deps, { ...form, originId: "x" });
    expect(bad).toEqual({ ok: false, error: "validation", fields: { originId: "invalid" } });
    expect(await createCdnDraftCore(orderDeps({ allowed: false }).deps, form)).toEqual({
      ok: false,
      error: "rate_limited",
    });
    expect(await createCdnDraftCore({ ...orderDeps().deps, orders: null }, form)).toEqual({
      ok: false,
      error: "unavailable",
    });
  });

  it("maps a refusal of the order code to a public key with the fields only for validation", async () => {
    const { deps } = orderDeps();
    const refusing: OrderActionDeps = {
      ...deps,
      orders: {
        createOrderDraft: async () =>
          ({ ok: false, error: "validation", fields: { originId: "invalid" } }) as never,
        placeOrder: async () => {
          throw new Error("not used");
        },
      },
    };
    expect(await createCdnDraftCore(refusing, form)).toEqual({
      ok: false,
      error: "validation",
      fields: { originId: "invalid" },
    });
    const internal: OrderActionDeps = {
      ...refusing,
      orders: {
        createOrderDraft: async () => ({ ok: false, error: "internal" }) as never,
        placeOrder: async () => {
          throw new Error("not used");
        },
      },
    };
    expect(await createCdnDraftCore(internal, form)).toEqual({
      ok: false,
      error: "unavailable",
    });
  });
});
