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
  children: [] as Array<Record<string, unknown>>,
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
        listChildren: async () => state.children,
      },
    };
  },
  readFeatureFlag: async (_tx: unknown, key: string) => state.flags[key] ?? null,
  listCatalogProducts: async () => state.catalog,
  readCatalogProduct: async (_tx: unknown, id: string) =>
    state.catalog.find((c) => c["id"] === id) ?? null,
}));
vi.mock("@tc/core", async () => ({
  // WPU-X11: the real account setup predicate of the buy gate.
  missingSetupSteps: (await import("../../../packages/core/account/setup.ts")).missingSetupSteps,
  DB_BACKUP_RETENTION_DAYS: 7,
  // The parameter list of the console view (WPU-G11): these tests do not read it.
  DB_PARAMETER_RULES: { mysql: [], postgres: [] },
  dbEngineFrom: () => null,
  pointInTimeWindow: (now: Date) => ({
    from: new Date(now.getTime() - 7 * 86400000),
    to: new Date(now.getTime() - 300000),
  }),
  // The price of a snapshot comes from the engine (R4): the view only passes it on.
  snapshotPrice: async (_tx: unknown, _market: string, sizeGb: number | null) => ({
    ok: true,
    value: {
      unit: "gb_month",
      perGbMonthMinor: 700n,
      monthlyMinor: sizeGb === null ? null : BigInt(sizeGb) * 700n,
    },
  }),
  priceCatalog: async (_tx: unknown, rows: Array<Record<string, unknown>>) =>
    state.priced
      ? {
          ok: true,
          value: rows.map((r) => ({ ...r, priceBdt: { totalMinor: 250000n } })),
        }
      : { ok: false, error: "internal" },
}));

const {
  databaseConfigOf,
  databaseSpecsOf,
  loadDatabaseConfigurator,
  loadDatabaseDetail,
  loadDatabaseList,
} = await import("./databases-view.ts");

const CUSTOMER = "11111111-1111-4111-8111-111111111111";
const session = { customerId: CUSTOMER } as never;
const DB_ID = "22222222-2222-4222-8222-222222222222";
const PRODUCT = "33333333-3333-4333-8333-333333333333";
const row = (over: Record<string, unknown> = {}) => ({
  id: DB_ID,
  family: "database",
  state: "active",
  region: "ap-southeast-1",
  productId: PRODUCT,
  config: {
    displayName: "main-db",
    endpointAddress: "ls-abc123.cxyz.ap-southeast-1.rds.amazonaws.com",
    endpointPort: 3306,
  },
  createdAt: new Date("2026-11-10T00:00:00Z"),
  ...over,
});
const plan = {
  id: PRODUCT,
  family: "database",
  region: "ap-southeast-1",
  awsId: "micro_2_0",
  specs: { engine: "mysql", version: "8.0", vcpus: 2, ramGb: "1", diskGb: 40 },
};

beforeEach(() => {
  seen.customerIds = [];
  state.profile = {
    market: "BD",
    kycStatus: "none",
    emailVerifiedAt: AT,
    phoneVerifiedAt: AT,
    totpEnabledAt: AT,
  };
  state.flags = { database: true };
  state.resources = [];
  state.children = [];
  state.catalog = [plan];
  state.priced = true;
});

describe("databaseConfigOf", () => {
  it("reads the name, the endpoint and the port, field by field", () => {
    expect(
      databaseConfigOf({
        displayName: "main-db",
        endpointAddress: "ls-abc123.cxyz.ap-southeast-1.rds.amazonaws.com",
        endpointPort: 5432,
        masterPassword: "never shown",
        accountId: "123456789012",
        awsName: "tc-database-0123456789abcdef",
      }),
    ).toEqual({
      name: "main-db",
      endpoint: "ls-abc123.cxyz.ap-southeast-1.rds.amazonaws.com",
      port: 5432,
    });
  });

  it("drops an endpoint that is not a plain host name and a port that is no port", () => {
    expect(
      databaseConfigOf({ displayName: 5, endpointAddress: "<b>x</b>", endpointPort: 70000 }),
    ).toEqual({ name: "", endpoint: null, port: null });
    expect(databaseConfigOf({ endpointPort: 3.5 }).port).toBeNull();
    expect(databaseConfigOf(null)).toEqual({ name: "", endpoint: null, port: null });
  });
});

describe("databaseSpecsOf", () => {
  it("reads sizes, the engine word and the version, and drops the rest", () => {
    expect(databaseSpecsOf({ engine: "postgres", version: "16.4", vcpus: 2, ramGb: "1" })).toEqual({
      engine: "postgres",
      version: "16.4",
      vcpus: 2,
      ramGb: "1",
    });
    expect(databaseSpecsOf({ engine: "<script>", version: "8.0;drop", diskGb: -1 })).toEqual({});
    expect(databaseSpecsOf(null)).toEqual({});
  });
});

describe("loadDatabaseConfigurator", () => {
  it("is flag_off when the flag is off, missing or unreadable (R12, R16)", async () => {
    for (const flags of [{ database: false }, {}] as Record<string, boolean | null>[]) {
      state.flags = flags;
      expect(await loadDatabaseConfigurator(session, () => new Date())).toEqual({
        state: "flag_off",
      });
    }
  });

  it("WPU-X11: asks for the account setup (not KYC) before it offers a plan", async () => {
    state.profile = {
      market: "BD",
      kycStatus: "verified",
      emailVerifiedAt: AT,
      phoneVerifiedAt: AT,
      totpEnabledAt: null,
    };
    expect(await loadDatabaseConfigurator(session, () => new Date())).toEqual({
      state: "account_setup_required",
      missing: ["totp"],
    });
  });

  it("offers the priced plans with their engine and sizes, read for the session's customer (R8)", async () => {
    const screen = await loadDatabaseConfigurator(session, () => new Date());
    expect(screen).toEqual({
      state: "ready",
      regions: ["ap-southeast-1"],
      plans: [
        {
          id: PRODUCT,
          region: "ap-southeast-1",
          priceMinor: 250000n,
          specs: { engine: "mysql", version: "8.0", vcpus: 2, ramGb: "1", diskGb: 40 },
        },
      ],
    });
    expect(seen.customerIds).toEqual([CUSTOMER]);
  });

  it("refuses to show prices when the catalog cannot be priced (R16)", async () => {
    state.priced = false;
    await expect(loadDatabaseConfigurator(session, () => new Date())).rejects.toThrow();
  });
});

describe("loadDatabaseList", () => {
  it("lists only the customer's databases that are not destroyed, with endpoint and engine", async () => {
    state.resources = [
      row(),
      row({ id: "d", state: "destroyed" }),
      row({ id: "s", family: "linux_instance" }),
    ];
    const screen = await loadDatabaseList(session);
    expect(screen.state === "ready" && screen.items.map((i) => i.id)).toEqual([DB_ID]);
    expect(screen).toMatchObject({
      items: [
        {
          name: "main-db",
          endpoint: "ls-abc123.cxyz.ap-southeast-1.rds.amazonaws.com",
          port: 3306,
          engine: "mysql",
          version: "8.0",
        },
      ],
    });
  });

  it("is flag_off with the flag off", async () => {
    state.flags = { database: false };
    state.resources = [row()];
    expect(await loadDatabaseList(session)).toEqual({ state: "flag_off" });
  });
});

describe("loadDatabaseDetail", () => {
  it("returns the database with its backups, endpoint and sizes", async () => {
    state.resources = [row()];
    state.children = [
      {
        id: "b1",
        family: "backup",
        state: "active",
        region: "ap-southeast-1",
        config: { displayName: "final", final: true, sizeGb: 40 },
        createdAt: new Date("2026-11-11T00:00:00Z"),
      },
    ];
    const detail = await loadDatabaseDetail(session, DB_ID);
    expect(detail).toMatchObject({
      id: DB_ID,
      name: "main-db",
      region: "ap-southeast-1",
      port: 3306,
      specs: { engine: "mysql", vcpus: 2 },
      backups: [{ id: "b1", name: "final", final: true, sizeGb: 40, state: "active" }],
    });
    expect(
      JSON.stringify(detail, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    ).not.toMatch(/arn:aws|tc-database-/);
    // WPU-G9: the snapshot price, the monthly price of a snapshot and the retention come with it.
    expect(detail).toMatchObject({
      snapshotPrice: { state: "ready", perGbMonthMinor: 700n },
      retentionDays: 7,
      backups: [{ monthlyMinor: 28000n }],
      masterUsername: null,
    });
  });

  it("answers null for a missing row, another customer's row, another family and a flag that is off (R8, R12)", async () => {
    expect(await loadDatabaseDetail(session, DB_ID)).toBeNull();
    state.resources = [row({ family: "linux_instance" })];
    expect(await loadDatabaseDetail(session, DB_ID)).toBeNull();
    state.resources = [row()];
    state.flags = { database: false };
    expect(await loadDatabaseDetail(session, DB_ID)).toBeNull();
    state.flags = {};
    expect(await loadDatabaseDetail(session, DB_ID)).toBeNull();
  });
});
