import type { CustomerSession } from "@tc/auth";
import type { ResourceSummary } from "@tc/db";
import { describe, expect, it } from "vitest";
import {
  BUCKET_VERSIONING,
  CDN_RESET_CACHE,
  DB_OPTIONS,
  LB_ATTRIBUTES,
  LB_REFRESH_CERTIFICATE,
  LB_REQUEST_CERTIFICATE,
  consoleCore,
  type ConsoleSpec,
} from "./console-actions.ts";
import type { FamilyActionDeps, FamilyRepos } from "./family-actions.ts";

// WPU-G7: the cores of the console actions (load balancer settings and certificate, database options,
// bucket versioning, CDN cache flush). One generic core, one table of cases; every spec gets the same
// cross-tenant, state, flag, rate limit and order proofs (R7, R8, R9, R16).

const NOW = new Date("2026-11-12T10:00:00Z");
const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const ID = "0190aaaa-0000-7000-8000-0000000000e1";
const FOREIGN = "0190aaaa-0000-7000-8000-0000000000ff";
const REQ = "0190aaaa-0000-7000-8000-0000000000f1";

const session = (): CustomerSession => ({
  customerId: CUSTOMER,
  kycStatus: "verified",
  riskTier: "new",
  locale: "bn",
  signedInAt: new Date(NOW.getTime() - 60_000),
});

interface Case {
  spec: ConsoleSpec;
  family: string;
  idField: string;
  good: Record<string, unknown>;
  payload: Record<string, unknown>;
  bad: Record<string, unknown>[];
  state: string;
  wrongState: string;
}

const CASES: Case[] = [
  {
    spec: LB_ATTRIBUTES,
    family: "load_balancer",
    idField: "loadBalancerId",
    good: { healthCheckPath: "/health.html", httpsRedirect: "on" },
    payload: { healthCheckPath: "/health.html", httpsRedirect: true },
    bad: [{}, { healthCheckPath: "health" }, { healthCheckPath: "/a b" }, { httpsRedirect: "yes" }],
    state: "active",
    wrongState: "suspended",
  },
  {
    spec: LB_REQUEST_CERTIFICATE,
    family: "load_balancer",
    idField: "loadBalancerId",
    good: { domain: "Shop.Example.com" },
    payload: { domain: "shop.example.com" },
    bad: [{}, { domain: "localhost" }, { domain: "*.example.com" }, { domain: "a b.com" }],
    state: "active",
    wrongState: "creating",
  },
  {
    spec: LB_REFRESH_CERTIFICATE,
    family: "load_balancer",
    idField: "loadBalancerId",
    good: {},
    payload: {},
    bad: [],
    state: "active",
    wrongState: "failed",
  },
  {
    spec: DB_OPTIONS,
    family: "database",
    idField: "databaseId",
    good: { backupWindow: "16:00-16:30", publicMode: "on", acknowledge: "yes" },
    payload: { backupWindow: "16:00-16:30", publiclyAccessible: true },
    bad: [
      {},
      { backupWindow: "16:00-16:10" },
      { publicMode: "maybe" },
      // public mode needs the warning to be acknowledged
      { publicMode: "on" },
      { publicMode: "on", acknowledge: "no" },
    ],
    state: "active",
    wrongState: "stopped",
  },
  {
    spec: BUCKET_VERSIONING,
    family: "bucket",
    idField: "bucketId",
    good: { versioning: "Enabled" },
    payload: { versioning: "Enabled" },
    bad: [{}, { versioning: "enabled" }, { versioning: "Off" }],
    state: "active",
    wrongState: "suspended",
  },
  {
    spec: CDN_RESET_CACHE,
    family: "cdn",
    idField: "cdnId",
    good: {},
    payload: {},
    bad: [],
    state: "active",
    wrongState: "stopped",
  },
];

function world(c: Case, over: { state?: string; flag?: boolean; allowed?: boolean } = {}) {
  const calls: string[] = [];
  const requests: unknown[] = [];
  const row: ResourceSummary = {
    id: ID,
    family: c.family,
    productId: null,
    region: "ap-southeast-1",
    state: (over.state ?? c.state) as ResourceSummary["state"],
    parentResourceId: null,
    config: { displayName: "mine" },
    createdAt: NOW,
    deletedAt: null,
  };
  const repos: FamilyRepos = {
    flagOn: async () => {
      calls.push("flag");
      return over.flag !== false;
    },
    resources: {
      // The scoped repository: only the customer's own row exists (R8).
      get: async (id: string) => {
        calls.push("get");
        return id === ID ? row : null;
      },
    } as never,
    subscriptions: {} as never,
    operations: {
      request: async (input: unknown) => {
        calls.push("request");
        requests.push(input);
        return { ok: true, value: {} };
      },
    } as never,
    audit: {
      record: async (input: { action: string }) => {
        calls.push(`audit:${input.action}`);
        return { ok: true };
      },
    } as never,
    rateLimits: {
      consume: async () => {
        calls.push("rate");
        return { allowed: over.allowed !== false };
      },
    } as never,
  };
  const deps: FamilyActionDeps = {
    authenticate: async () => session(),
    now: () => NOW,
    store: async (_customerId, fn) => {
      calls.push("store");
      return fn(repos);
    },
  };
  return { deps, calls, requests };
}

describe.each(CASES)("console action $spec.kind", (c) => {
  const run = consoleCore(c.spec);
  const form = (extra: Record<string, unknown> = c.good) => ({
    [c.idField]: ID,
    requestId: REQ,
    ...extra,
  });

  it("queues one operation with the checked payload and an idempotency key, then audits (R7, R9)", async () => {
    const w = world(c);
    const result = await run(w.deps, form());
    expect(result).toEqual({ ok: true, done: c.spec.done });
    expect(w.requests).toEqual([
      {
        resourceId: ID,
        kind: c.spec.kind,
        idempotencyKey: `${c.spec.keyPrefix}:${REQ}`,
        payload: c.payload,
      },
    ]);
    // R9: the store opens, the flag is read, the ownership of the row is checked (authorize), the rate
    // limit is counted, then the operation is written and the audit entry follows (WPU-S6).
    expect(w.calls).toEqual(["store", "flag", "get", "rate", "request", `audit:${c.spec.audit}`]);
  });

  it("another customer's row and a missing one give one answer, and nothing is queued (R8)", async () => {
    const foreign = world(c);
    const a = await run(foreign.deps, form({ ...c.good, [c.idField]: FOREIGN }));
    const b = await run(world(c).deps, form({ ...c.good, [c.idField]: ID.replace("e1", "e2") }));
    expect(a).toEqual({ ok: false, error: "not_found" });
    expect(b).toEqual(a);
    expect(foreign.requests).toEqual([]);
    // WPU-S6 (R9): the ownership is checked before the limit, so a foreign id consumes nothing.
    expect(foreign.calls).not.toContain("rate");
  });

  it("refuses a row of another family as a missing one (R8)", async () => {
    const w = world({ ...c, family: "linux_instance" });
    // the world serves the row with a different family than the spec expects
    const mismatched = await run({ ...w.deps }, form());
    expect(mismatched).toEqual({ ok: false, error: "not_found" });
    expect(w.requests).toEqual([]);
  });

  it("refuses a resource in the wrong state, a flag that is off and a used limit (R16)", async () => {
    const wrong = world(c, { state: c.wrongState });
    expect(await run(wrong.deps, form())).toEqual({ ok: false, error: "not_allowed" });
    expect(wrong.requests).toEqual([]);
    expect(await run(world(c, { flag: false }).deps, form())).toEqual({
      ok: false,
      error: "flag_off",
    });
    const limited = world(c, { allowed: false });
    expect(await run(limited.deps, form())).toEqual({ ok: false, error: "rate_limited" });
    expect(limited.requests).toEqual([]);
  });

  it("validates before the store opens: a bad id, a bad request id and every bad field", async () => {
    const w = world(c);
    expect(await run(w.deps, { [c.idField]: "x", requestId: "y", ...c.good })).toMatchObject({
      ok: false,
      error: "validation",
      fields: { [c.idField]: "invalid", requestId: "invalid" },
    });
    for (const bad of c.bad) {
      expect(await run(w.deps, form(bad)), JSON.stringify(bad)).toMatchObject({
        ok: false,
        error: "validation",
      });
    }
    expect(w.calls).toEqual([]);
  });

  it("refuses an unauthenticated request first (R9)", async () => {
    const w = world(c);
    const result = await run({ ...w.deps, authenticate: async () => null }, form());
    expect(result).toEqual({ ok: false, error: "unauthenticated" });
    expect(w.calls).toEqual([]);
  });
});
