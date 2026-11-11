import type { CustomerSession } from "@tc/auth";
import type { ResourceSummary } from "@tc/db";
import { describe, expect, it } from "vitest";
import {
  createLoadBalancerDraftCore,
  destroyLoadBalancerCore,
  setLoadBalancerTargetsCore,
  type LoadBalancerTargetsDeps,
} from "./load-balancers-actions.ts";
import type { FamilyRepos } from "./family-actions.ts";
import type { OrderActionDeps } from "./order-actions.ts";

const NOW = new Date("2026-11-12T10:00:00Z");
const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const LB = "0190aaaa-0000-7000-8000-0000000000e1";
const S1 = "0190aaaa-0000-7000-8000-0000000000a1";
const S2 = "0190aaaa-0000-7000-8000-0000000000a2";
const FOREIGN = "0190aaaa-0000-7000-8000-0000000000ff";
const REQ = "0190aaaa-0000-7000-8000-0000000000f1";
const PRODUCT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const session = (): CustomerSession => ({
  customerId: CUSTOMER,
  kycStatus: "verified",
  riskTier: "new",
  locale: "bn",
  signedInAt: new Date(NOW.getTime() - 60_000),
});

const resource = (over: Partial<ResourceSummary> = {}): ResourceSummary => ({
  id: S1,
  family: "linux_instance",
  productId: PRODUCT,
  region: "ap-southeast-1",
  state: "active",
  parentResourceId: null,
  config: { displayName: "web-1", region: "ap-southeast-1" },
  createdAt: NOW,
  deletedAt: null,
  ...over,
});
const lb = (over: Partial<ResourceSummary> = {}) =>
  resource({
    id: LB,
    family: "load_balancer",
    config: { displayName: "front", targetIds: [S1] },
    ...over,
  });

function world(
  over: {
    rows?: ResourceSummary[];
    flag?: boolean;
    allowed?: boolean;
    port?: LoadBalancerTargetsDeps["changeTargets"];
  } = {},
) {
  const calls: string[] = [];
  // The scoped repository: the rows of the customer only. FOREIGN is not among them (R8).
  const rows = over.rows ?? [
    lb(),
    resource(),
    resource({ id: S2, config: { displayName: "web-2" } }),
  ];
  const repos: FamilyRepos = {
    flagOn: async () => over.flag !== false,
    resources: {
      get: async (id: string) => {
        calls.push(`get:${id}`);
        return rows.find((r) => r.id === id) ?? null;
      },
    } as never,
    subscriptions: {} as never,
    operations: {} as never,
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
  const deps: LoadBalancerTargetsDeps = {
    authenticate: async () => session(),
    now: () => NOW,
    store: async (customerId, fn) => {
      calls.push(`store:${customerId}`);
      return fn(repos);
    },
    changeTargets:
      over.port === undefined
        ? async (_repos, input) => {
            calls.push(
              `change:${input.loadBalancerId}:${input.targets.join(",")}:${input.requestId}`,
            );
            return "queued";
          }
        : over.port,
  };
  return { deps, calls };
}

describe("setLoadBalancerTargetsCore", () => {
  const input = { loadBalancerId: LB, requestId: REQ, targetIds: [S1, S2] };

  it("re-checks every target through the scoped repository, then hands the checked ids to the port and audits (R8, R9)", async () => {
    const { deps, calls } = world();
    expect(await setLoadBalancerTargetsCore(deps, input)).toEqual({
      ok: true,
      done: "targetsQueued",
    });
    expect(calls).toEqual([
      `store:${CUSTOMER}`,
      "rate",
      `get:${LB}`,
      `get:${S1}`,
      `get:${S2}`,
      `change:${LB}:${S1},${S2}:${REQ}`,
      "audit:lb.set_targets",
    ]);
  });

  it("another customer's server and a missing one give the same answer, and the port is never called", async () => {
    const foreign = world();
    const missing = world();
    const a = await setLoadBalancerTargetsCore(foreign.deps, {
      ...input,
      targetIds: [S1, FOREIGN],
    });
    const b = await setLoadBalancerTargetsCore(missing.deps, {
      ...input,
      targetIds: [S1, "0190aaaa-0000-7000-8000-0000000000ee"],
    });
    expect(a).toEqual({ ok: false, error: "validation", fields: { targetIds: "invalid" } });
    expect(b).toEqual(a);
    expect(foreign.calls.some((c) => c.startsWith("change"))).toBe(false);
  });

  it("refuses a target of another Region, one that is not active, one that is not a server, and a duplicate", async () => {
    const bad = async (rows: ResourceSummary[], ids = [S1]) =>
      setLoadBalancerTargetsCore(world({ rows: [lb(), ...rows] }).deps, {
        ...input,
        targetIds: ids,
      });
    const invalid = { ok: false, error: "validation", fields: { targetIds: "invalid" } };
    expect(await bad([resource({ region: "ap-south-1" })])).toEqual(invalid);
    expect(await bad([resource({ state: "stopped" })])).toEqual(invalid);
    expect(await bad([resource({ family: "database" })])).toEqual(invalid);
    expect(await bad([resource()], [S1, S1])).toEqual(invalid);
  });

  it("accepts a Windows server as a target (an instance of the customer)", async () => {
    const rows = [lb(), resource({ family: "windows_instance" })];
    expect(
      await setLoadBalancerTargetsCore(world({ rows }).deps, { ...input, targetIds: [S1] }),
    ).toEqual({
      ok: true,
      done: "targetsQueued",
    });
  });

  it("validates the shape before the store opens: ids, 1 to 20 targets", async () => {
    const { deps, calls } = world();
    expect(
      await setLoadBalancerTargetsCore(deps, {
        loadBalancerId: "x",
        requestId: "y",
        targetIds: [],
      }),
    ).toEqual({
      ok: false,
      error: "validation",
      fields: { loadBalancerId: "invalid", requestId: "invalid", targetIds: "invalid" },
    });
    expect(
      await setLoadBalancerTargetsCore(deps, { ...input, targetIds: Array(21).fill(S1) }),
    ).toMatchObject({ ok: false, error: "validation" });
    expect(
      await setLoadBalancerTargetsCore(deps, { ...input, targetIds: "not a list" }),
    ).toMatchObject({
      ok: false,
      error: "validation",
    });
    expect(calls).toEqual([]);
  });

  it("refuses when the flag is off, the balancer is not the customer's or not active, or the limit is used", async () => {
    expect(await setLoadBalancerTargetsCore(world({ flag: false }).deps, input)).toEqual({
      ok: false,
      error: "flag_off",
    });
    expect(await setLoadBalancerTargetsCore(world({ rows: [resource()] }).deps, input)).toEqual({
      ok: false,
      error: "not_found",
    });
    expect(
      await setLoadBalancerTargetsCore(
        world({ rows: [lb({ state: "suspended" }), resource()] }).deps,
        input,
      ),
    ).toEqual({ ok: false, error: "not_allowed" });
    expect(await setLoadBalancerTargetsCore(world({ allowed: false }).deps, input)).toEqual({
      ok: false,
      error: "rate_limited",
    });
  });

  it("is honest when the change cannot be made yet: the port is not wired, so nothing is queued (R16)", async () => {
    const { deps, calls } = world({ port: null });
    expect(await setLoadBalancerTargetsCore(deps, input)).toEqual({
      ok: false,
      error: "unavailable",
    });
    expect(calls.some((c) => c.startsWith("audit"))).toBe(false);
    const conflict = world({ port: async () => "conflict" });
    expect(await setLoadBalancerTargetsCore(conflict.deps, input)).toEqual({
      ok: false,
      error: "not_allowed",
    });
  });
});

describe("destroyLoadBalancerCore", () => {
  it("destroys without a snapshot after the exact name (R13, U10)", async () => {
    const calls: string[] = [];
    const repos: FamilyRepos = {
      flagOn: async () => true,
      resources: { get: async () => lb() } as never,
      subscriptions: {
        requestDestroy: async (i: { withFinalSnapshot: boolean }) => {
          calls.push(`destroy:${i.withFinalSnapshot}`);
          return { ok: true, value: { needsApproval: true } };
        },
      } as never,
      operations: {} as never,
      audit: { record: async () => ({ ok: true }) } as never,
      rateLimits: { consume: async () => ({ allowed: true }) } as never,
    };
    const deps = {
      authenticate: async () => session(),
      now: () => NOW,
      store: async (_c: string, fn: (r: FamilyRepos) => Promise<unknown>) => fn(repos),
    } as never;
    const ok = await destroyLoadBalancerCore(deps, {
      loadBalancerId: LB,
      requestId: REQ,
      confirmName: "front",
    });
    expect(ok).toEqual({ ok: true, done: "destroyQueued", approval: true });
    expect(calls).toEqual(["destroy:false"]);
    expect(
      await destroyLoadBalancerCore(deps, {
        loadBalancerId: LB,
        requestId: REQ,
        confirmName: "Front",
      }),
    ).toEqual({ ok: false, error: "name_mismatch" });
  });
});

describe("createLoadBalancerDraftCore", () => {
  function orderDeps(over: { allowed?: boolean; session?: CustomerSession | null } = {}) {
    const seen: unknown[] = [];
    const deps: OrderActionDeps = {
      authenticate: async () => (over.session === undefined ? session() : over.session),
      rateLimit: async () => ({ allowed: over.allowed !== false }),
      orders: {
        createOrderDraft: async (_s: unknown, request: unknown) => {
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
    displayName: " Front ",
    targetIds: [S1, S2],
    awsName: "tc-lb-0123456789abcdef",
    certificate: "mine",
  };

  it("hands the order code the four fields of a load balancer and nothing else, for the family load_balancer (R11)", async () => {
    const { deps, seen } = orderDeps();
    expect(await createLoadBalancerDraftCore(deps, form)).toEqual({ ok: true, token: "signed" });
    expect(seen).toEqual([
      {
        family: "load_balancer",
        config: {
          productId: PRODUCT,
          region: "ap-southeast-1",
          displayName: "Front",
          targetIds: [S1, S2],
        },
      },
    ]);
  });

  it("asks for at least one target, refuses a bad id, an unauthenticated request and a rate limit (R9)", async () => {
    expect(await createLoadBalancerDraftCore(orderDeps().deps, { ...form, targetIds: [] })).toEqual(
      {
        ok: false,
        error: "validation",
        fields: { targetIds: "invalid" },
      },
    );
    expect(
      await createLoadBalancerDraftCore(orderDeps().deps, { ...form, targetIds: ["x"] }),
    ).toEqual({ ok: false, error: "validation", fields: { targetIds: "invalid" } });
    expect(await createLoadBalancerDraftCore(orderDeps({ session: null }).deps, form)).toEqual({
      ok: false,
      error: "unauthenticated",
    });
    expect(await createLoadBalancerDraftCore(orderDeps({ allowed: false }).deps, form)).toEqual({
      ok: false,
      error: "rate_limited",
    });
    expect(await createLoadBalancerDraftCore({ ...orderDeps().deps, orders: null }, form)).toEqual({
      ok: false,
      error: "unavailable",
    });
  });
});
