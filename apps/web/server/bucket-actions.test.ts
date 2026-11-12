import type { CustomerSession } from "@tc/auth";
import type { ResourceSummary } from "@tc/db";
import { describe, expect, it, vi } from "vitest";
import type { FamilyActionDeps, FamilyRepos } from "./bucket-frame.ts";
import {
  PUBLIC_CONFIRMATION,
  createBucketDraftCore,
  deleteAccessKeyCore,
  destroyBucketCore,
  setBucketAccessCore,
} from "./bucket-actions.ts";
import type { OrderActionDeps } from "./order-actions.ts";

// The lifecycle guard is the real one, except in the one test that shows what the core does when the
// guard lets a bucket destroy pass (the owner decision is open: JOURNEY, WP6-T4s).
const guard = vi.hoisted(() => ({ open: false }));
vi.mock("@tc/core", async (original) => {
  const real = await original<typeof import("@tc/core")>();
  return {
    ...real,
    decideDestructive: (...args: Parameters<typeof real.decideDestructive>) =>
      guard.open ? true : real.decideDestructive(...args),
  };
});

const NOW = new Date("2026-11-12T10:00:00Z");
const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const BUCKET = "0190aaaa-0000-7000-8000-0000000000b1";
const REQ = "0190aaaa-0000-7000-8000-0000000000f1";
const PRODUCT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const KEY = "AKIAEXAMPLEKEY123456";

const session = (signedInAt = new Date(NOW.getTime() - 60_000)): CustomerSession => ({
  customerId: CUSTOMER,
  kycStatus: "verified",
  riskTier: "new",
  locale: "bn",
  signedInAt,
});

const row = (over: Partial<ResourceSummary> = {}): ResourceSummary => ({
  id: BUCKET,
  family: "bucket",
  productId: PRODUCT,
  region: "ap-southeast-1",
  state: "active",
  parentResourceId: null,
  config: { displayName: "Site assets" },
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
    session?: CustomerSession | null;
    requestError?: "not_found" | "conflict";
  } = {},
) {
  const calls: string[] = [];
  const payloads: unknown[] = [];
  const rows = over.rows ?? [row()];
  const repos: FamilyRepos = {
    flagOn: async () => over.flag !== false,
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
      requestDestroy: async (input: { idempotencyKey: string; withFinalSnapshot: boolean }) => {
        calls.push(`destroy:${input.idempotencyKey}:${input.withFinalSnapshot}`);
        return {
          ok: true,
          replayed: false,
          value: { destroyOperationId: "d", finalSnapshotOperationId: null, needsApproval: true },
        } as never;
      },
    } as never,
    operations: {
      get: async () => null,
      listForResource: async () => [],
      listRecent: async () => [],
      request: async (input) => {
        calls.push(`op:${input.kind}:${input.idempotencyKey}:${input.resourceId}`);
        payloads.push(input.payload);
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
  const deps: FamilyActionDeps = {
    authenticate: async () => (over.session === undefined ? session() : over.session),
    now: () => NOW,
    store: async (customerId, fn) => {
      calls.push(`store:${customerId}`);
      return fn(repos);
    },
  };
  return { deps, calls, payloads };
}

describe("setBucketAccessCore", () => {
  const priv = { bucketId: BUCKET, requestId: REQ, mode: "private" };

  it("authenticates, rates, writes the operation with a stable key and audits, in that order (R9, R7)", async () => {
    const { deps, calls, payloads } = world();
    expect(await setBucketAccessCore(deps, priv)).toEqual({ ok: true, done: "accessPrivate" });
    expect(calls).toEqual([
      `store:${CUSTOMER}`,
      "rate",
      `op:set_bucket_access:bucket-access:${REQ}:${BUCKET}`,
      "audit:bucket.access",
    ]);
    // The payload is the access mode and nothing else the form could carry.
    expect(payloads).toEqual([{ mode: "private" }]);
  });

  it("public needs the exact confirmation text; without it nothing is written", async () => {
    for (const confirm of [undefined, "", "public", "yes", ` ${PUBLIC_CONFIRMATION}x`]) {
      const { deps, calls } = world();
      const r = await setBucketAccessCore(deps, {
        ...priv,
        mode: "public",
        ...(confirm === undefined ? {} : { confirmText: confirm }),
      });
      expect(r).toEqual({ ok: false, error: "confirm_required" });
      expect(calls.some((c) => c.startsWith("op:"))).toBe(false);
    }
    const { deps, payloads } = world();
    expect(
      await setBucketAccessCore(deps, {
        ...priv,
        mode: "public",
        confirmText: PUBLIC_CONFIRMATION,
      }),
    ).toEqual({ ok: true, done: "accessPublic" });
    expect(payloads).toEqual([{ mode: "public" }]);
  });

  it("refuses a mode that is not one of the two, and ids that are not UUIDs, before any store", async () => {
    const { deps, calls } = world();
    for (const raw of [
      { ...priv, mode: "public-read-write" },
      { ...priv, mode: undefined },
      { ...priv, bucketId: "../x" },
      { ...priv, requestId: "r" },
      null,
    ]) {
      expect(await setBucketAccessCore(deps, raw)).toMatchObject({
        ok: false,
        error: "validation",
      });
    }
    expect(calls).toEqual([]);
  });

  it("refuses without a session, with the flag off, and when the rate limit is used up", async () => {
    expect(await setBucketAccessCore(world({ session: null }).deps, priv)).toEqual({
      ok: false,
      error: "unauthenticated",
    });
    expect(await setBucketAccessCore(world({ flag: false }).deps, priv)).toEqual({
      ok: false,
      error: "flag_off",
    });
    const limited = world({ allowed: false });
    expect(await setBucketAccessCore(limited.deps, priv)).toEqual({
      ok: false,
      error: "rate_limited",
    });
    expect(limited.calls.some((c) => c.startsWith("op:"))).toBe(false);
  });

  it("another customer's bucket, a missing one and another family answer the same: not_found (R8)", async () => {
    for (const rows of [[], [row({ family: "container_service" })]]) {
      expect(await setBucketAccessCore(world({ rows }).deps, priv)).toEqual({
        ok: false,
        error: "not_found",
      });
    }
  });

  it("only an active bucket is changed; a suspended one stays closed", async () => {
    for (const state of ["creating", "suspended", "stopped", "destroyed", "failed"] as const) {
      const { deps, calls } = world({ rows: [row({ state })] });
      expect(await setBucketAccessCore(deps, priv)).toEqual({ ok: false, error: "not_allowed" });
      expect(calls.some((c) => c.startsWith("op:"))).toBe(false);
    }
  });

  it("rolls back when the audit entry is refused (R16)", async () => {
    expect(await setBucketAccessCore(world({ auditOk: false }).deps, priv)).toEqual({
      ok: false,
      error: "unavailable",
    });
  });
});

describe("deleteAccessKeyCore", () => {
  const input = { bucketId: BUCKET, requestId: REQ, accessKeyId: KEY, confirmName: "Site assets" };

  it("needs a fresh sign-in and the typed bucket name before anything is queued (WPU-N2)", async () => {
    const stale = world({ session: session(new Date(NOW.getTime() - 3_600_000)) });
    expect(await deleteAccessKeyCore(stale.deps, input)).toEqual({
      ok: false,
      error: "fresh_sign_in_required",
    });
    expect(stale.calls).toEqual([]);
    for (const confirmName of ["", "site assets", "Other"]) {
      const w = world();
      expect(await deleteAccessKeyCore(w.deps, { ...input, confirmName })).toEqual({
        ok: false,
        error: "name_mismatch",
      });
      expect(w.calls.some((c) => c.startsWith("op:") || c.startsWith("audit:"))).toBe(false);
    }
  });

  it("queues delete_access_key with the key id as payload and audits without it", async () => {
    const { deps, calls, payloads } = world();
    expect(await deleteAccessKeyCore(deps, input)).toEqual({ ok: true, done: "keyDeleted" });
    expect(calls).toEqual([
      `store:${CUSTOMER}`,
      "rate",
      `op:delete_access_key:bucket-key:${REQ}:${BUCKET}`,
      "audit:bucket.key_delete",
    ]);
    expect(payloads).toEqual([{ accessKeyId: KEY }]);
    expect(calls.join(" ")).not.toContain(KEY);
  });

  it("refuses a key id that is not the shape of a key, and a bucket that is not active", async () => {
    for (const accessKeyId of ["", "short", "a b c d e f g h", "x".repeat(129), "../../etc", 5]) {
      expect(await deleteAccessKeyCore(world().deps, { ...input, accessKeyId })).toMatchObject({
        ok: false,
        error: "validation",
      });
    }
    expect(
      await deleteAccessKeyCore(world({ rows: [row({ state: "suspended" })] }).deps, input),
    ).toEqual({ ok: false, error: "not_allowed" });
  });

  it("is cross-tenant safe (R8) and respects the flag (R12)", async () => {
    expect(await deleteAccessKeyCore(world({ rows: [] }).deps, input)).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(await deleteAccessKeyCore(world({ flag: false }).deps, input)).toEqual({
      ok: false,
      error: "flag_off",
    });
  });
});

describe("destroyBucketCore (U10, R13)", () => {
  const input = { bucketId: BUCKET, requestId: REQ, confirmName: "Site assets" };

  it("needs a fresh sign-in before anything else", async () => {
    const stale = world({ session: session(new Date(NOW.getTime() - 3_600_000)) });
    expect(await destroyBucketCore(stale.deps, input)).toEqual({
      ok: false,
      error: "fresh_sign_in_required",
    });
    expect(stale.calls).toEqual([]);
  });

  it("follows the lifecycle guard as it is today: `bucket` is on neither list, so the destroy is refused and nothing is queued", async () => {
    guard.open = false;
    const { deps, calls } = world();
    expect(await destroyBucketCore(deps, input)).toEqual({ ok: false, error: "not_allowed" });
    expect(calls.some((c) => c.startsWith("destroy:") || c.startsWith("audit:"))).toBe(false);
  });

  describe("when the guard lets the family pass", () => {
    it("checks the typed name, then queues the destroy without a snapshot and audits", async () => {
      guard.open = true;
      try {
        const bad = world();
        expect(await destroyBucketCore(bad.deps, { ...input, confirmName: "site assets" })).toEqual(
          {
            ok: false,
            error: "name_mismatch",
          },
        );
        const { deps, calls } = world();
        expect(await destroyBucketCore(deps, input)).toEqual({
          ok: true,
          done: "destroyQueued",
          approval: true,
        });
        expect(calls).toEqual([
          `store:${CUSTOMER}`,
          "rate",
          `destroy:destroy:${REQ}:false`,
          "audit:bucket.destroy",
        ]);
      } finally {
        guard.open = false;
      }
    });
  });

  it("is cross-tenant safe and refuses a bucket that is already gone", async () => {
    guard.open = true;
    try {
      expect(await destroyBucketCore(world({ rows: [] }).deps, input)).toEqual({
        ok: false,
        error: "not_found",
      });
      expect(
        await destroyBucketCore(world({ rows: [row({ state: "destroyed" })] }).deps, input),
      ).toEqual({ ok: false, error: "not_allowed" });
    } finally {
      guard.open = false;
    }
  });
});

describe("createBucketDraftCore", () => {
  function orders(over: { allowed?: boolean; orders?: null } = {}) {
    const drafted: unknown[] = [];
    const deps = {
      authenticate: async () => session(),
      rateLimit: async () => ({ allowed: over.allowed !== false }),
      orders:
        over.orders === null
          ? null
          : {
              createOrderDraft: async (_s: unknown, input: unknown) => {
                drafted.push(input);
                return { ok: true, value: { token: "signed.token" } };
              },
            },
    } as unknown as OrderActionDeps;
    return { deps, drafted };
  }
  const form = { productId: PRODUCT, region: "ap-southeast-1", displayName: "Site assets" };

  it("passes only the three fields of a bucket to the order flow, as the family `bucket`", async () => {
    const { deps, drafted } = orders();
    expect(
      await createBucketDraftCore(deps, { ...form, awsName: "tc-bucket-x", access: "public" }),
    ).toEqual({ ok: true, token: "signed.token" });
    expect(drafted).toEqual([{ family: "bucket", config: form }]);
  });

  it("refuses without a session before the validation, the limit and the order code (R9, WP9-T2 sweep)", async () => {
    const touched: string[] = [];
    const deps = {
      authenticate: async () => null,
      rateLimit: async () => {
        touched.push("rateLimit");
        return { allowed: true };
      },
      orders: {
        createOrderDraft: async () => {
          touched.push("createOrderDraft");
          return { ok: true, value: { token: "t" } };
        },
      },
    } as unknown as OrderActionDeps;
    expect(await createBucketDraftCore(deps, form)).toEqual({
      ok: false,
      error: "unauthenticated",
    });
    expect(touched).toEqual([]);
  });

  it("refuses a bad name, rate limits, and fails closed without an order port", async () => {
    expect(
      await createBucketDraftCore(orders().deps, { ...form, displayName: "a;b" }),
    ).toMatchObject({
      ok: false,
      error: "validation",
      fields: { displayName: "invalid" },
    });
    expect(await createBucketDraftCore(orders({ allowed: false }).deps, form)).toEqual({
      ok: false,
      error: "rate_limited",
    });
    expect(await createBucketDraftCore(orders({ orders: null }).deps, form)).toEqual({
      ok: false,
      error: "unavailable",
    });
  });
});
