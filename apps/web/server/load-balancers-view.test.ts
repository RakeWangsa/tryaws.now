import { beforeEach, describe, expect, it, vi } from "vitest";
// WPU-X11: a customer who may buy has the three account setup facts; KYC is not read.
const AT = new Date("2026-11-14T00:00:00Z");

const seen = { customerIds: [] as string[] };
const state = {
  profile: {
    market: "BD",
    kycStatus: "none",
    emailVerifiedAt: AT,
    phoneVerifiedAt: AT,
    totpEnabledAt: AT,
  } as unknown,
  flags: {} as Record<string, boolean | null>,
  resources: [] as Array<Record<string, unknown>>,
  catalog: [] as Array<Record<string, unknown>>,
  priced: true,
};
vi.mock("@tc/db", () => ({
  withTx: async (fn: (tx: unknown) => unknown) => fn({}),
  customerRepos: (_tx: unknown, customerId: string) => {
    seen.customerIds.push(customerId);
    return {
      profile: { get: async () => state.profile },
      resources: {
        // The scoped repository answers null for another customer's row (R8).
        get: async (id: string) => state.resources.find((r) => r["id"] === id) ?? null,
        list: async () => state.resources,
      },
    };
  },
  readFeatureFlag: async (_tx: unknown, key: string) => state.flags[key] ?? null,
  listCatalogProducts: async () => state.catalog,
}));
vi.mock("@tc/core", async () => ({
  // WPU-X11: the real account setup predicate of the buy gate.
  missingSetupSteps: (await import("../../../packages/core/account/setup.ts")).missingSetupSteps,
  priceCatalog: async (_tx: unknown, rows: Array<Record<string, unknown>>) =>
    state.priced
      ? { ok: true, value: rows.map((r) => ({ ...r, priceBdt: { totalMinor: 180000n } })) }
      : { ok: false, error: "internal" },
}));

const {
  loadBalancerConfigOf,
  loadLoadBalancerConfigurator,
  loadLoadBalancerDetail,
  loadLoadBalancerList,
} = await import("./load-balancers-view.ts");

const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const session = { customerId: CUSTOMER } as never;
const LB = "22222222-2222-4222-8222-222222222222";
const S1 = "0190aaaa-0000-7000-8000-0000000000a1";
const S2 = "0190aaaa-0000-7000-8000-0000000000a2";
const PRODUCT = "33333333-3333-4333-8333-333333333333";

const server = (over: Record<string, unknown> = {}) => ({
  id: S1,
  family: "linux_instance",
  state: "active",
  region: "ap-southeast-1",
  productId: null,
  config: { displayName: "web-1" },
  createdAt: new Date("2026-11-09T00:00:00Z"),
  ...over,
});
const balancer = (over: Record<string, unknown> = {}) => ({
  id: LB,
  family: "load_balancer",
  state: "active",
  region: "ap-southeast-1",
  productId: PRODUCT,
  config: { displayName: "front", targetIds: [S1] },
  createdAt: new Date("2026-11-10T00:00:00Z"),
  ...over,
});

beforeEach(() => {
  seen.customerIds = [];
  state.profile = {
    market: "BD",
    kycStatus: "none",
    emailVerifiedAt: AT,
    phoneVerifiedAt: AT,
    totpEnabledAt: AT,
  };
  state.flags = { load_balancer: true };
  state.resources = [];
  state.catalog = [
    { id: PRODUCT, family: "load_balancer", region: "ap-southeast-1", awsId: "lb", specs: {} },
  ];
  state.priced = true;
});

describe("loadBalancerConfigOf", () => {
  it("reads the name and the target ids, field by field", () => {
    expect(
      loadBalancerConfigOf({
        displayName: "front",
        targetIds: [S1, "<script>", 5, S2],
        awsName: "tc-lb-0123456789abcdef",
        accountId: "123456789012",
      }),
    ).toEqual({ name: "front", targetIds: [S1, S2] });
    expect(loadBalancerConfigOf(null)).toEqual({ name: "", targetIds: [] });
    expect(loadBalancerConfigOf({ targetIds: "x" }).targetIds).toEqual([]);
  });
});

describe("loadLoadBalancerConfigurator", () => {
  it("is flag_off with the flag off or missing (R12, R16), and asks for the account setup (WPU-X11)", async () => {
    for (const flags of [{ load_balancer: false }, {}] as Record<string, boolean | null>[]) {
      state.flags = flags;
      expect(await loadLoadBalancerConfigurator(session, () => new Date())).toEqual({
        state: "flag_off",
      });
    }
    state.flags = { load_balancer: true };
    state.profile = {
      market: "BD",
      kycStatus: "verified",
      emailVerifiedAt: AT,
      phoneVerifiedAt: AT,
      totpEnabledAt: null,
    };
    expect(await loadLoadBalancerConfigurator(session, () => new Date())).toEqual({
      state: "account_setup_required",
      missing: ["totp"],
    });
  });

  it("offers only the customer's own active servers as targets, with their Region (R8)", async () => {
    state.resources = [
      server(),
      server({ id: S2, state: "stopped", config: { displayName: "web-2" } }),
      server({ id: "w", family: "windows_instance", config: { displayName: "win-1" } }),
      server({ id: "d", family: "database" }),
      balancer(),
    ];
    const screen = await loadLoadBalancerConfigurator(session, () => new Date());
    expect(screen).toEqual({
      state: "ready",
      plans: [{ id: PRODUCT, region: "ap-southeast-1", priceMinor: 180000n }],
      servers: [
        { id: S1, name: "web-1", region: "ap-southeast-1" },
        { id: "w", name: "win-1", region: "ap-southeast-1" },
      ],
    });
    expect(seen.customerIds).toEqual([CUSTOMER]);
  });

  it("refuses to show prices when the catalog cannot be priced (R16)", async () => {
    state.priced = false;
    await expect(loadLoadBalancerConfigurator(session, () => new Date())).rejects.toThrow();
  });
});

describe("loadLoadBalancerList", () => {
  it("lists the customer's balancers that are not destroyed, with the number of targets", async () => {
    state.resources = [balancer(), balancer({ id: "x", state: "destroyed" }), server()];
    const screen = await loadLoadBalancerList(session);
    expect(screen).toMatchObject({
      state: "ready",
      items: [{ id: LB, name: "front", targetCount: 1 }],
    });
    state.flags = { load_balancer: false };
    expect(await loadLoadBalancerList(session)).toEqual({ state: "flag_off" });
  });
});

describe("loadLoadBalancerDetail", () => {
  it("returns the balancer with its targets by name and the servers that could still be added", async () => {
    state.resources = [
      balancer(),
      server(),
      server({ id: S2, config: { displayName: "web-2" } }),
      server({ id: "o", region: "ap-south-1", config: { displayName: "other-region" } }),
    ];
    const detail = await loadLoadBalancerDetail(session, LB);
    expect(detail).toMatchObject({
      id: LB,
      name: "front",
      region: "ap-southeast-1",
      targets: [{ id: S1, name: "web-1", state: "active" }],
      candidates: [{ id: S2, name: "web-2" }],
    });
    expect(JSON.stringify(detail)).not.toMatch(/arn:aws|tc-lb-/);
  });

  it("shows a target that is gone as removed, never as another customer's server", async () => {
    state.resources = [
      balancer({ config: { displayName: "front", targetIds: [S1, S2] } }),
      server(),
    ];
    const detail = await loadLoadBalancerDetail(session, LB);
    expect(detail?.targets).toEqual([
      { id: S1, name: "web-1", state: "active" },
      { id: S2, name: "", state: null },
    ]);
  });

  it("answers null for a missing row, another customer's, another family and a flag that is off (R8, R12)", async () => {
    expect(await loadLoadBalancerDetail(session, LB)).toBeNull();
    state.resources = [balancer({ family: "database" })];
    expect(await loadLoadBalancerDetail(session, LB)).toBeNull();
    state.resources = [balancer()];
    state.flags = {};
    expect(await loadLoadBalancerDetail(session, LB)).toBeNull();
  });
});
