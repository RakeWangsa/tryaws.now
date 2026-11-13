import type { ResourceSummary, SubscriptionRow } from "@tc/db";
import { describe, expect, it, vi } from "vitest";

// WPU-Y4: /servers/disks lists every disk of the customer (any state, any Region, attached or not). Cross-tenant
// proof (R8): the loader opens the repositories of the session's customer only, and a disk's attachedInstanceId is
// shown as a server only when that server is one of the customer's own rows. Fix round 1: every disk owner sees the
// list whatever the server flag; the actions follow their own flags (R12).

const A = "0190aaaa-0000-7000-8000-0000000000c1";
const B = "0190aaaa-0000-7000-8000-0000000000c2";
const SERVER = "0190aaaa-0000-7000-8000-0000000000a1";
const SERVER_OTHER_REGION = "0190aaaa-0000-7000-8000-0000000000a2";
const FOREIGN_SERVER = "0190aaaa-0000-7000-8000-0000000000a9";
const ATTACHED = "0190aaaa-0000-7000-8000-0000000000d1";
const FREE = "0190aaaa-0000-7000-8000-0000000000d2";
const FAR = "0190aaaa-0000-7000-8000-0000000000d3";
const GONE = "0190aaaa-0000-7000-8000-0000000000d4";
const FAILED = "0190aaaa-0000-7000-8000-0000000000d5";
const ODD = "0190aaaa-0000-7000-8000-0000000000d6";
const NOW = new Date("2026-11-14T10:00:00Z");

const row = (over: Partial<ResourceSummary> & { id: string }): ResourceSummary => ({
  family: "disk",
  productId: null,
  region: "ap-southeast-1",
  state: "active",
  parentResourceId: null,
  config: {},
  createdAt: NOW,
  deletedAt: null,
  ...over,
});
const sub = (resourceId: string, over: Partial<SubscriptionRow> = {}): SubscriptionRow => ({
  id: `sub-${resourceId}`,
  resourceId,
  termDays: 30,
  priceSnapshot: {},
  periodStart: NOW,
  periodEnd: NOW,
  autoRenew: false,
  status: "active",
  ...over,
});

const state = vi.hoisted(() => ({
  owner: {} as Record<string, string>,
  rows: [] as ResourceSummary[],
  subs: [] as SubscriptionRow[],
  flags: { linux_instance: true, disk: true } as Record<string, boolean>,
  opened: [] as string[],
}));
vi.mock("@tc/db", () => ({
  withTx: async (fn: (tx: unknown) => unknown) => fn({}),
  readFeatureFlag: async (_tx: unknown, key: string) => state.flags[key] === true,
  customerRepos: (_tx: unknown, customerId: string) => {
    state.opened.push(customerId);
    const mine = (id: string) => state.owner[id] === customerId;
    return {
      profile: { get: async () => ({ market: "BD" }) },
      // like the real repositories: only the rows of this customer
      resources: { list: async () => state.rows.filter((r) => mine(r.id)) },
      subscriptions: { list: async () => state.subs.filter((s) => mine(s.resourceId)) },
    };
  },
}));

const { diskListOf, loadDiskList } = await import("./disk-list-view.ts");

function seed() {
  state.rows = [
    row({ id: SERVER, family: "linux_instance", state: "stopped", config: { displayName: "web" } }),
    row({
      id: SERVER_OTHER_REGION,
      family: "linux_instance",
      region: "ap-south-1",
      config: { displayName: "mumbai" },
    }),
    row({ id: ATTACHED, config: { displayName: "data", sizeGb: 64, attachedInstanceId: SERVER } }),
    row({ id: FREE, config: { displayName: "spare", sizeGb: 32 } }),
    row({ id: FAR, region: "eu-west-2", config: { displayName: "london", sizeGb: 8 } }),
    row({ id: GONE, state: "destroyed", config: { displayName: "old", sizeGb: 8 } }),
    row({ id: FAILED, state: "failed", config: { displayName: "never" } }),
    // B's server id in A's disk config (a forged or stale value): never shown as a server.
    row({ id: ODD, config: { displayName: "odd", attachedInstanceId: FOREIGN_SERVER } }),
    row({ id: FOREIGN_SERVER, family: "linux_instance", config: { displayName: "b-secret" } }),
  ];
  state.owner = Object.fromEntries(state.rows.map((r) => [r.id, A]));
  state.owner[FOREIGN_SERVER] = B;
  state.subs = [
    sub(ATTACHED, { autoRenew: true }),
    sub(FREE),
    sub(FAR, { status: "grace" }),
    sub(GONE, { status: "retained" }),
    sub(ODD),
  ];
  state.flags = { linux_instance: true, disk: true };
  state.opened = [];
}

describe("loadDiskList", () => {
  it("lists every disk of the session's customer: any state, any Region, attached or not; no failed create", async () => {
    seed();
    const out = await loadDiskList({ customerId: A } as never, "req-1");
    expect(state.opened).toEqual([A]);
    if (out.state !== "ready") throw new Error("ready expected");
    expect(out.requestId).toBe("req-1");
    expect(out.disks.map((d) => d.id).sort()).toEqual([ATTACHED, FAR, FREE, GONE, ODD].sort());
    expect(out.disks.at(-1)?.id).toBe(GONE);
    const byId = new Map(out.disks.map((d) => [d.id, d]));
    expect(byId.get(ATTACHED)).toMatchObject({
      attachedTo: { id: SERVER, name: "web", stopped: true },
      canDetach: true,
      canDestroy: false,
      autoRenew: { resourceId: ATTACHED, autoRenew: true, canTurnOn: true },
    });
    expect(byId.get(FREE)).toMatchObject({
      attachedTo: null,
      canDetach: false,
      canDestroy: true,
      attachTargets: [{ id: SERVER, name: "web" }],
    });
    // Another Region: listed, destroyable, but no server of its Region to attach to.
    expect(byId.get(FAR)).toMatchObject({
      region: "eu-west-2",
      canDestroy: true,
      attachTargets: [],
    });
    expect(byId.get(GONE)).toMatchObject({ canDestroy: false, canDetach: false, autoRenew: null });
  });

  it("cross-tenant (R8): another customer's server is never named, and B sees none of A's disks", async () => {
    seed();
    const out = await loadDiskList({ customerId: A } as never, "r");
    if (out.state !== "ready") throw new Error("ready expected");
    const odd = out.disks.find((d) => d.id === ODD);
    expect(odd).toMatchObject({ attachedTo: null, canDetach: false, canDestroy: false });
    expect(JSON.stringify(out)).not.toContain("b-secret");
    expect(JSON.stringify(out)).not.toContain(FOREIGN_SERVER);
    const b = await loadDiskList({ customerId: B } as never, "r");
    expect(b).toEqual({ state: "ready", disks: [], requestId: "r" });
  });

  it("fix round 1: the server flag off still lists every disk; detach, destroy and attach are not offered (R12)", async () => {
    seed();
    state.flags = { linux_instance: false, disk: true };
    const out = await loadDiskList({ customerId: A } as never, "r");
    if (out.state !== "ready") throw new Error("ready expected");
    expect(out.disks.map((d) => d.id).sort()).toEqual([ATTACHED, FAR, FREE, GONE, ODD].sort());
    for (const d of out.disks) {
      expect(d.canDetach).toBe(false);
      expect(d.canDestroy).toBe(false);
      expect(d.attachTargets).toEqual([]);
    }
    // The auto-renew switch keeps working (its own flag, the disk flag).
    expect(out.disks.find((d) => d.id === ATTACHED)?.autoRenew).toMatchObject({ autoRenew: true });
  });

  it("fix round 1: both flags off, the OFF switch of an auto-renewing disk still works (WPU-Z14)", async () => {
    seed();
    state.flags = { linux_instance: false, disk: false };
    const out = await loadDiskList({ customerId: A } as never, "r");
    if (out.state !== "ready") throw new Error("ready expected");
    expect(out.disks.find((d) => d.id === ATTACHED)?.autoRenew).toEqual({
      resourceId: ATTACHED,
      autoRenew: true,
      canTurnOn: false,
    });
  });

  it("the disk flag off keeps the list; the switch is off-only (none once off)", async () => {
    seed();
    state.flags = { linux_instance: true, disk: false };
    const out = await loadDiskList({ customerId: A } as never, "r");
    if (out.state !== "ready") throw new Error("ready expected");
    const byId = new Map(out.disks.map((d) => [d.id, d]));
    expect(byId.get(ATTACHED)?.autoRenew).toEqual({
      resourceId: ATTACHED,
      autoRenew: true,
      canTurnOn: false,
    });
    expect(byId.get(FREE)?.autoRenew).toBeNull();
  });
});

describe("diskListOf", () => {
  it("offers no detach while the server runs, and no destroy for a retained disk or one without a name", () => {
    const rows = [
      row({ id: SERVER, family: "linux_instance", state: "active" }),
      row({ id: ATTACHED, config: { displayName: "data", attachedInstanceId: SERVER } }),
      row({ id: FREE, config: { displayName: "spare" } }),
      row({ id: FAR, config: {} }),
    ];
    const out = diskListOf({
      rows,
      subscriptions: [sub(ATTACHED), sub(FREE, { status: "retained" }), sub(FAR)],
      diskFlagOn: true,
      serverActionsOn: true,
    });
    const byId = new Map(out.map((d) => [d.id, d]));
    expect(byId.get(ATTACHED)).toMatchObject({ canDetach: false, attachedTo: { stopped: false } });
    expect(byId.get(FREE)).toMatchObject({ canDestroy: false, attachTargets: [] });
    expect(byId.get(FAR)).toMatchObject({ canDestroy: false });
  });
});
