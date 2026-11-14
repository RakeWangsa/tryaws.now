import type { CustomerSession } from "@tc/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";

// WPU-G5: the loaders of /snapshots, /static-ips and /billing. The repositories are a stand-in that
// returns what a database would return for the SESSION's customer; the tests check that each loader
// opens repositories only for that customer (R8), writes nothing, shows no AWS name, and answers
// every failure with a throw, not with an empty list (R16).
const state = vi.hoisted(() => ({
  opened: [] as string[],
  calls: [] as string[],
  flag: true as boolean | null,
  resources: [] as unknown[],
  subscriptions: [] as unknown[],
  operations: [] as unknown[],
  keys: [] as unknown[],
  balance: 250_000n,
  hourPrice: 74n as bigint | null,
  payments: [] as unknown[],
  // WPU-X11: a signed-in customer has a verified e-mail; no mobile, no authenticator yet.
  profile: {
    market: "BD",
    phoneVerifiedAt: null as Date | null,
    kycStatus: "none",
    emailVerifiedAt: new Date("2026-11-01T00:00:00Z") as Date | null,
    totpEnabledAt: null as Date | null,
  },
  catalog: new Map<string, unknown>(),
}));

vi.mock("@tc/db", async (original) => {
  const real = await original<typeof import("@tc/db")>();
  return {
    ...real,
    withTx: async (fn: (tx: unknown) => unknown) => fn({}),
    customerRepos: (_tx: unknown, customerId: string) => {
      state.opened.push(customerId);
      const log = (name: string) => state.calls.push(name);
      return {
        profile: { get: async () => (log("profile.get"), state.profile) },
        sshKeys: { list: async () => state.keys },
        payments: { list: async () => state.payments },
        resources: { list: async () => (log("resources.list"), state.resources) },
        subscriptions: { list: async () => (log("subscriptions.list"), state.subscriptions) },
        operations: { listRecent: async () => (log("operations.listRecent"), state.operations) },
        wallet: { view: async () => ({ balanceMinor: state.balance }) },
      };
    },
    readFeatureFlag: async () => state.flag,
    readCatalogProduct: async (_tx: unknown, id: string) => state.catalog.get(id) ?? null,
    listCatalogProducts: async () => [
      { id: "plan-small", platform: "linux", region: "ap-southeast-1", specs: { diskGb: 40 } },
      { id: "plan-big", platform: "linux", region: "ap-southeast-1", specs: { diskGb: 80 } },
      { id: "plan-other", platform: "linux", region: "ap-south-1", specs: { diskGb: 80 } },
    ],
  };
});
vi.mock("@tc/core", async (original) => {
  const real = await original<typeof import("@tc/core")>();
  return {
    ...real,
    priceCatalog: async (_tx: unknown, rows: { id: string; region: string; specs: unknown }[]) => ({
      ok: true,
      value: rows.map((r) => ({ ...r, priceBdt: { totalMinor: 99_000n } })),
    }),
    // WPU-M1: the hourly price of an unattached static IP, in paisa.
    staticIpHourPrice: async () =>
      state.hourPrice === null
        ? { ok: false, error: "not_found", fields: {} }
        : { ok: true, value: { unit: "hour", perHourMinor: state.hourPrice } },
  };
});

const { loadSnapshots, loadStaticIps, loadBilling } = await import("./account-view.ts");
const { loadDashboard } = await import("./extras-view.ts");

const MINE = "11111111-1111-4111-8111-111111111111";
const session = { customerId: MINE } as CustomerSession;
const REQ = "0190aaaa-0000-7000-8000-0000000000f1";
const NOW = new Date("2026-11-12T00:00:00.000Z");
const S1 = "0190aaaa-0000-7000-8000-000000000001";
const S2 = "0190aaaa-0000-7000-8000-000000000002";
const B1 = "0190aaaa-0000-7000-8000-0000000000b1";
const B2 = "0190aaaa-0000-7000-8000-0000000000b2";
const BF = "0190aaaa-0000-7000-8000-0000000000bf";

const server = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  family: "linux_instance",
  productId: "plan-small",
  region: "ap-southeast-1",
  state: "active",
  parentResourceId: null,
  config: { displayName: `server-${id.slice(-1)}`, publicIpv4: "203.0.113.10" },
  createdAt: new Date("2026-10-01T00:00:00.000Z"),
  deletedAt: null,
  ...over,
});
const backup = (id: string, parent: string, over: Record<string, unknown> = {}) => ({
  id,
  family: "backup",
  productId: null,
  region: "ap-southeast-1",
  state: "active",
  parentResourceId: parent,
  config: { displayName: `snap-${id.slice(-2)}`, sizeGb: 40 },
  createdAt: new Date("2026-11-01T00:00:00.000Z"),
  deletedAt: null,
  ...over,
});

beforeEach(() => {
  state.opened.length = 0;
  state.calls.length = 0;
  state.flag = true;
  state.resources = [];
  state.subscriptions = [];
  state.operations = [];
  state.keys = [];
  state.balance = 250_000n;
  state.payments = [];
  state.profile = {
    market: "BD",
    phoneVerifiedAt: null,
    kycStatus: "none",
    emailVerifiedAt: new Date("2026-11-01T00:00:00Z"),
    totpEnabledAt: null,
  };
  state.catalog = new Map([["plan-small", { id: "plan-small", specs: { diskGb: 40 } }]]);
});

describe("loadSnapshots", () => {
  it("flag off answers flag_off and reads no resource (R12)", async () => {
    state.flag = false;
    expect(await loadSnapshots(session, REQ)).toEqual({ state: "flag_off" });
    expect(state.calls).not.toContain("resources.list");
  });

  it("a customer without servers has empty lists and nothing to create from", async () => {
    expect(await loadSnapshots(session, REQ)).toEqual({
      state: "ready",
      requestId: REQ,
      servers: [],
      groups: [],
    });
  });

  it("lists live servers for the create form and snapshots grouped under their server", async () => {
    state.resources = [
      server(S1),
      server(S2, { state: "destroyed" }),
      backup(B1, S1),
      backup(B2, S1, { createdAt: new Date("2026-11-05T00:00:00.000Z") }),
      backup(BF, S2, { config: { displayName: "", final: true, sizeGb: 40 } }),
    ];
    const view = await loadSnapshots(session, REQ);
    if (view.state !== "ready") throw new Error("not ready");
    expect(view.servers.map((s) => s.id)).toEqual([S1]);
    expect(view.groups.map((g) => g.server.id)).toEqual([S1, S2]);
    const first = view.groups[0];
    expect(first?.items.map((i) => i.id)).toEqual([B2, B1]);
    expect(first?.server).toMatchObject({ name: "server-1", live: true, canSnapshot: true });
    expect(view.groups[1]?.server).toMatchObject({ live: false, canSnapshot: false });
    expect(view.groups[1]?.items[0]).toMatchObject({ final: true });
  });

  it("offers restore plans of the snapshot's Region with a disk not smaller than the server's", async () => {
    state.resources = [server(S1), backup(B1, S1)];
    const view = await loadSnapshots(session, REQ);
    if (view.state !== "ready") throw new Error("not ready");
    expect(view.groups[0]?.plans.map((p) => p.id)).toEqual(["plan-small", "plan-big"]);
    expect(view.groups[0]?.plans[0]?.priceMinor).toBe(99_000n);
  });

  it("offers no plans when the plan of the server is unknown (fail closed)", async () => {
    state.catalog = new Map();
    state.resources = [server(S1), backup(B1, S1)];
    const view = await loadSnapshots(session, REQ);
    if (view.state !== "ready") throw new Error("not ready");
    expect(view.groups[0]?.plans).toEqual([]);
  });

  it("leaves out destroyed and failed snapshots, snapshots of disks and snapshots with no server row", async () => {
    state.resources = [
      server(S1),
      { ...server("0190aaaa-0000-7000-8000-0000000000d1"), family: "disk" },
      backup(B1, S1, { state: "destroyed" }),
      backup(B2, "0190aaaa-0000-7000-8000-0000000000d1"),
      backup(BF, "0190aaaa-0000-7000-8000-0000000000ee"),
    ];
    const view = await loadSnapshots(session, REQ);
    if (view.state !== "ready") throw new Error("not ready");
    expect(view.groups).toEqual([]);
  });

  it("shows only the config fields it reads: no AWS name, no account, no ARN (U6, R11)", async () => {
    state.resources = [
      server(S1, { config: { displayName: "web", awsName: "tc-vm-abc", poolAccountId: "1234" } }),
      backup(B1, S1, { config: { displayName: "snap", awsName: "tc-bk-abc", arn: "arn:aws:x" } }),
    ];
    const text = JSON.stringify(await loadSnapshots(session, REQ), (_k, v) =>
      typeof v === "bigint" ? v.toString() : v,
    );
    expect(text).not.toMatch(/tc-vm|tc-bk|arn:aws|1234/);
  });

  it("opens repositories only for the session's customer and writes nothing (R8)", async () => {
    state.resources = [server(S1), backup(B1, S1)];
    await loadSnapshots(session, REQ);
    expect(new Set(state.opened)).toEqual(new Set([MINE]));
    expect(
      state.calls.filter((c) => /\.(request|record|create|set|update|consume)/.test(c)),
    ).toEqual([]);
  });

  it("a database error is thrown, never an empty list (R16)", async () => {
    state.resources = null as never;
    await expect(loadSnapshots(session, REQ)).rejects.toThrow();
  });
});

describe("loadStaticIps", () => {
  it("flag off answers flag_off", async () => {
    state.flag = false;
    expect(await loadStaticIps(session, REQ)).toEqual({ state: "flag_off" });
  });

  it("lists the servers' static IPs with the attached state and the Region", async () => {
    state.resources = [
      server(S1),
      server(S2, { config: { displayName: "db-host", staticIpAttached: false } }),
      { ...server("0190aaaa-0000-7000-8000-0000000000d1"), family: "disk" },
    ];
    const view = await loadStaticIps(session, REQ);
    if (view.state !== "ready") throw new Error("not ready");
    expect(view.items).toEqual([
      expect.objectContaining({
        serverId: S1,
        name: "server-1",
        address: "203.0.113.10",
        attached: true,
        region: "ap-southeast-1",
        busy: false,
      }),
      expect.objectContaining({ serverId: S2, name: "db-host", address: null, attached: false }),
    ]);
  });

  it("WPU-M1: says what an unattached IP costs and whether the charge is running", async () => {
    state.resources = [
      server(S1),
      server(S2, {
        config: {
          displayName: "db-host",
          staticIpAttached: false,
          detachedAt: "2026-11-01T00:00:00.000Z",
        },
      }),
      server("0190aaaa-0000-7000-8000-000000000003", {
        config: { displayName: "x", staticIpAttached: false, detachedAt: new Date().toISOString() },
      }),
    ];
    const view = await loadStaticIps(session, REQ);
    if (view.state !== "ready") throw new Error("not ready");
    expect(view.items.map((i) => i.fee)).toEqual([
      { hourMinor: "74", charging: false },
      { hourMinor: "74", charging: true },
      { hourMinor: "74", charging: false },
    ]);
    state.hourPrice = null;
    const noPrice = await loadStaticIps(session, REQ);
    if (noPrice.state !== "ready") throw new Error("not ready");
    expect(noPrice.items.every((i) => i.fee.hourMinor === null)).toBe(true);
    state.hourPrice = 74n;
  });

  it("leaves out destroyed and failed servers and servers that are still being created", async () => {
    state.resources = [
      server(S1, { state: "destroyed" }),
      server(S2, { state: "failed" }),
      server("0190aaaa-0000-7000-8000-000000000003", { state: "creating" }),
    ];
    const view = await loadStaticIps(session, REQ);
    if (view.state !== "ready") throw new Error("not ready");
    expect(view.items).toEqual([]);
  });

  it("marks a server busy while a power, firewall or static IP operation is on its way", async () => {
    state.resources = [server(S1), server(S2)];
    state.operations = [
      { id: "o1", resourceId: S1, kind: "attach_static_ip", state: "queued" },
      { id: "o2", resourceId: S2, kind: "create_backup", state: "running" },
    ];
    const view = await loadStaticIps(session, REQ);
    if (view.state !== "ready") throw new Error("not ready");
    expect(view.items.map((i) => [i.serverId, i.busy])).toEqual([
      [S1, true],
      [S2, false],
    ]);
  });

  it("only the session's customer opens repositories (R8)", async () => {
    state.resources = [server(S1)];
    await loadStaticIps(session, REQ);
    expect(new Set(state.opened)).toEqual(new Set([MINE]));
  });
});

const sub = (resourceId: string, over: Record<string, unknown> = {}) => ({
  id: `sub-${resourceId.slice(-2)}`,
  resourceId,
  termDays: 30,
  priceSnapshot: {
    baseMinor: "60000",
    steps: [{ code: "bd_vat", amountMinor: "9000" }],
    totalMinor: "69000",
  },
  periodStart: new Date("2026-11-01T00:00:00.000Z"),
  periodEnd: new Date("2026-12-01T00:00:00.000Z"),
  autoRenew: true,
  status: "active",
  ...over,
});

describe("loadBilling", () => {
  it("is empty with no subscriptions, with the wallet balance", async () => {
    const view = await loadBilling(session, NOW);
    expect(view).toMatchObject({
      state: "ready",
      balanceMinor: 250_000n,
      usage: { running: 0, totalMinor: 0n },
      items: [],
      lowBalance: false,
    });
  });

  it("totals the price of one term per resource and per family, as bigint paisa", async () => {
    state.resources = [
      server(S1),
      server(S2, { family: "database", config: { displayName: "db" } }),
    ];
    state.subscriptions = [sub(S1), sub(S2)];
    const view = await loadBilling(session, NOW);
    expect(view.usage.totalMinor).toBe(138_000n);
    expect(view.usage.families).toEqual([
      { family: "database", count: 1, totalMinor: 69_000n },
      { family: "linux_instance", count: 1, totalMinor: 69_000n },
    ]);
    expect(view.items.map((i) => [i.resourceId, i.name, i.amountMinor, i.termDays])).toEqual([
      [S1, "server-1", 69_000n, 30],
      [S2, "db", 69_000n, 30],
    ]);
  });

  it("a price snapshot that does not add up is unpriced, not shown as a number (R16)", async () => {
    state.resources = [server(S1)];
    state.subscriptions = [
      sub(S1, { priceSnapshot: { baseMinor: "1", steps: [], totalMinor: "2" } }),
    ];
    const view = await loadBilling(session, NOW);
    expect(view.usage.unpriced).toBe(1);
    expect(view.items[0]?.amountMinor).toBeNull();
  });

  it("warns when the renewals of the next 7 days cost more than the balance", async () => {
    state.resources = [server(S1)];
    state.subscriptions = [
      sub(S1, {
        periodEnd: new Date("2026-11-15T00:00:00.000Z"),
        priceSnapshot: { baseMinor: "300000", steps: [], totalMinor: "300000" },
      }),
    ];
    expect((await loadBilling(session, NOW)).lowBalance).toBe(true);
  });

  it("only the session's customer opens repositories and nothing is written (R8)", async () => {
    await loadBilling(session, NOW);
    expect(new Set(state.opened)).toEqual(new Set([MINE]));
    expect(
      state.calls.filter((c) => /\.(request|record|create|set|update|consume)/.test(c)),
    ).toEqual([]);
  });
});

describe("loadDashboard: the first-use guide", () => {
  const stepOf = async (key: string) =>
    (await loadDashboard(session, NOW)).onboarding.steps.find((s) => s.key === key);

  it("a brand-new customer is at the phone step, only the e-mail done, the server steps locked", async () => {
    state.balance = 0n;
    const view = await loadDashboard(session, NOW);
    expect(view.onboarding).toMatchObject({ next: "phone", started: false, complete: false });
    expect(view.onboarding.steps.filter((s) => s.done).map((s) => s.key)).toEqual(["email"]);
    expect(view.alerts.setupMissing).toEqual(["phone", "totp"]);
    expect(view.guideServerId).toBeNull();
  });

  it("WPU-X11: after the mobile is verified the guide leads to the authenticator, then the alert is gone", async () => {
    state.profile = { ...state.profile, phoneVerifiedAt: new Date("2026-11-02T00:00:00Z") };
    const before = await loadDashboard(session, NOW);
    expect(before.onboarding.next).toBe("totp");
    expect(before.alerts.setupMissing).toEqual(["totp"]);
    state.profile = { ...state.profile, totpEnabledAt: new Date("2026-11-03T00:00:00Z") };
    const after = await loadDashboard(session, NOW);
    expect(after.alerts.setupMissing).toEqual([]);
    expect(after.onboarding.steps.find((s) => s.key === "totp")).toMatchObject({ done: true });
  });

  it("WPU-X11: a fact that is not a time counts as not done (R16)", async () => {
    state.profile = { ...state.profile, emailVerifiedAt: "yes" as unknown as Date };
    expect((await loadDashboard(session, NOW)).alerts.setupMissing).toContain("email");
  });

  it("the key step is done by a saved key, the top-up step by a payment or a balance", async () => {
    state.keys = [{ id: "k1" }];
    expect(await stepOf("sshKey")).toMatchObject({ done: true });
    expect(await stepOf("topUp")).toMatchObject({ done: true }); // the wallet holds 2500 taka
  });

  it("a live server opens the firewall and snapshot steps and is the server they point to", async () => {
    state.resources = [server(S2), server(S1)];
    const view = await loadDashboard(session, NOW);
    expect(view.onboarding.started).toBe(true);
    expect(view.onboarding.steps.filter((s) => s.locked)).toEqual([]);
    // list() is newest first: the last row is the oldest server.
    expect(view.guideServerId).toBe(S1);
  });

  it("the firewall step is done only by a list the customer saved", async () => {
    state.resources = [server(S1)];
    expect(await stepOf("firewall")).toMatchObject({ done: false });
    state.resources = [server(S1, { config: { displayName: "w", firewallRules: [] } })];
    expect(await stepOf("firewall")).toMatchObject({ done: true });
  });

  it("the snapshot step is done by a manual snapshot, not by the final one of a deleted server", async () => {
    state.resources = [server(S1), backup(BF, S1, { config: { final: true } })];
    expect(await stepOf("snapshot")).toMatchObject({ done: false });
    state.resources = [server(S1), backup(B1, S1)];
    expect(await stepOf("snapshot")).toMatchObject({ done: true });
  });

  it("a destroyed server does not count as a first server", async () => {
    state.resources = [server(S1, { state: "destroyed" })];
    expect(await stepOf("server")).toMatchObject({ done: false });
  });
});
