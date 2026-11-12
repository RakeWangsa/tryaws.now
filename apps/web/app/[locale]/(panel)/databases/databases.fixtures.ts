import type {
  DatabaseConfiguratorScreen,
  DatabaseDetail,
  DatabasePlanOption,
  DatabaseRow,
} from "../../../../server/databases-view.ts";

// Rows for the render tests of the database screens (never imported by a page).

export const DATABASE_ID = "0190aaaa-0000-7000-8000-0000000000d1";
export const PLAN_SMALL = "0190aaaa-0000-7000-8000-0000000000b1";
export const PLAN_MEDIUM = "0190aaaa-0000-7000-8000-0000000000b2";
export const REQUEST_ID = "0190aaaa-0000-7000-8000-0000000000f1";
export const ENDPOINT = "ls-abc123def.cxyz.ap-southeast-1.rds.amazonaws.com";

export const noopAction = async () => ({});

export function plan(over: Partial<DatabasePlanOption> = {}): DatabasePlanOption {
  return {
    id: PLAN_SMALL,
    region: "ap-southeast-1",
    priceMinor: 250000n,
    specs: { engine: "mysql", version: "8.0", vcpus: 2, ramGb: "1", diskGb: 40 },
    ...over,
  };
}

export function configurator(
  over: Partial<Extract<DatabaseConfiguratorScreen, { state: "ready" }>> = {},
): DatabaseConfiguratorScreen {
  return {
    state: "ready",
    regions: ["ap-southeast-1", "ap-south-1"],
    plans: [
      plan(),
      plan({
        id: PLAN_MEDIUM,
        priceMinor: 520000n,
        specs: { engine: "postgres", version: "16", vcpus: 2, ramGb: "4", diskGb: 80 },
      }),
      plan({ id: "0190aaaa-0000-7000-8000-0000000000b3", region: "ap-south-1" }),
    ],
    ...over,
  };
}

export function row(over: Partial<DatabaseRow> = {}): DatabaseRow {
  return {
    id: DATABASE_ID,
    name: "main-db",
    region: "ap-southeast-1",
    state: "active",
    engine: "mysql",
    version: "8.0",
    endpoint: ENDPOINT,
    port: 3306,
    specs: { engine: "mysql", version: "8.0", vcpus: 2, ramGb: "1", diskGb: 40 },
    ...over,
  };
}

export function detail(over: Partial<DatabaseDetail> = {}): DatabaseDetail {
  return {
    ...row(),
    createdAt: new Date("2026-11-10T08:00:00Z"),
    backups: [
      {
        id: "0190aaaa-0000-7000-8000-0000000000e1",
        name: "main-db final",
        sizeGb: 12,
        monthlyMinor: 8000n,
        createdAt: new Date("2026-11-11T08:00:00Z"),
        state: "active",
        final: true,
      },
    ],
    masterUsername: "tcadmin",
    snapshotPrice: { state: "ready", perGbMonthMinor: 700n },
    restorePlans: [],
    retentionDays: 7,
    pitrWindow: { from: new Date("2026-11-04T08:00:00Z"), to: new Date("2026-11-11T07:55:00Z") },
    ...over,
  };
}
