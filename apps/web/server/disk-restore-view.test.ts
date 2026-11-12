import type { CustomerSession } from "@tc/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";

// WPU-X2: the loader behind /servers/disk-restore. R12 (flag off lists nothing), R8 (only the session's
// customer is opened, so a snapshot of another customer is never listed), R4 (bigint paisa).
const state = vi.hoisted(() => ({
  flag: true as boolean | undefined,
  opened: [] as string[],
  listed: 0,
  rows: [] as unknown[],
}));

vi.mock("@tc/db", () => ({
  withTx: async (fn: (tx: unknown) => Promise<unknown>) => fn({}),
  customerRepos: (_tx: unknown, customerId: string) => {
    state.opened.push(customerId);
    return {
      profile: { get: async () => ({ market: "BD" }) },
      resources: {
        list: async () => {
          state.listed += 1;
          return state.rows;
        },
      },
    };
  },
  readFeatureFlag: async () => state.flag,
  listCatalogProducts: async () => [
    {
      id: "0190bbbb-0000-7000-8000-000000000001",
      family: "disk",
      awsId: "block-storage-gb",
      platform: null,
      region: "ap-south-1",
      specs: {},
      awsPriceUsd: "0.1000",
      billingUnit: "gb_month",
      featureFlag: "disk",
      active: true,
    },
  ],
  readConfigPrices: async () => ({}),
}));
vi.mock("@tc/core", async (original) => {
  const real = await original<typeof import("@tc/core")>();
  return {
    ...real,
    priceCatalog: async (_tx: unknown, rows: { id: string; region: string }[]) => ({
      ok: true,
      value: rows.map((r) => ({ id: r.id, region: r.region, priceBdt: { totalMinor: 1250n } })),
    }),
  };
});

const { diskRestoreOptionsOf, loadDiskRestore } = await import("./disk-restore-view.ts");

const MINE = "11111111-1111-4111-8111-111111111111";
const session = { customerId: MINE } as CustomerSession;
const DISK = "0190aaaa-0000-7000-8000-0000000000d1";
const SNAP = "0190aaaa-0000-7000-8000-0000000000b1";
const row = (over: Record<string, unknown>) => ({
  id: "x",
  family: "disk",
  productId: null,
  region: "ap-south-1",
  state: "active",
  parentResourceId: null,
  config: {},
  createdAt: new Date("2026-11-01T00:00:00Z"),
  deletedAt: null,
  ...over,
});
const disk = (over: Record<string, unknown> = {}) =>
  row({ id: DISK, config: { displayName: "data", sizeGb: 100 }, ...over });
const snap = (over: Record<string, unknown> = {}) =>
  row({
    id: SNAP,
    family: "backup",
    parentResourceId: DISK,
    config: { displayName: "snap1" },
    ...over,
  });
const anchors = new Map([["ap-south-1", { productId: "p1", perGbMinor: 1250n }]]);

beforeEach(() => {
  state.flag = true;
  state.opened.length = 0;
  state.listed = 0;
  state.rows = [];
});

describe("diskRestoreOptionsOf", () => {
  it("offers an active snapshot of a disk, with the minimum size and the bigint price", () => {
    const out = diskRestoreOptionsOf({ rows: [disk(), snap()] as never, anchors });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      snapshotId: SNAP,
      name: "snap1",
      minGb: 100,
      productId: "p1",
      perGbMinor: 1250n,
      sourceDestroyed: false,
    });
  });

  it("keeps the final snapshot of a destroyed disk", () => {
    const out = diskRestoreOptionsOf({
      rows: [disk({ state: "destroyed" }), snap()] as never,
      anchors,
    });
    expect(out[0]?.sourceDestroyed).toBe(true);
  });

  it("leaves out what the order code would refuse (R16)", () => {
    const cases = [
      [disk(), snap({ state: "creating" })],
      [disk(), snap({ parentResourceId: null })],
      [snap()], // the parent is not among the customer's disks
      [disk(), snap({ region: "eu-west-1" })], // no anchor there
      [disk({ config: {} }), snap()], // size unknown
      [disk({ region: "eu-west-1" }), snap()], // regions differ
      [disk({ family: "linux_instance" }), snap()], // the parent is not a disk
    ];
    for (const rows of cases) {
      expect(diskRestoreOptionsOf({ rows: rows as never, anchors })).toEqual([]);
    }
  });
});

describe("loadDiskRestore", () => {
  it("flag off: the flag-off state and no resource is listed (R12)", async () => {
    state.flag = false;
    state.rows = [disk(), snap()];
    expect(await loadDiskRestore(session)).toEqual({ state: "flag_off" });
    expect(state.listed).toBe(0);
  });

  it("an unreadable flag is off (R16)", async () => {
    state.flag = undefined;
    expect(await loadDiskRestore(session)).toEqual({ state: "flag_off" });
  });

  it("opens the repositories of the session's customer only, so another customer's snapshot is not listed (R8)", async () => {
    // The repositories answer rows of the session's customer; another customer's rows never reach them.
    state.rows = [];
    expect(await loadDiskRestore(session)).toEqual({ state: "ready", options: [] });
    expect(state.opened).toEqual([MINE]);
  });

  it("prices the options from the engine", async () => {
    state.rows = [disk(), snap()];
    const screen = await loadDiskRestore(session);
    expect(screen.state === "ready" && screen.options[0]?.perGbMinor).toBe(1250n);
  });
});
