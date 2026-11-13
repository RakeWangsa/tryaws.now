// A small kit for the tests of the reader: an in-memory "database" with two customers, a fake Lightsail
// source that records every call, and a manual clock. No AWS and no network.
import { createManualClock, type LogEvent } from "@tc/core";
import type { ReadCaller, ReadTarget } from "@tc/db";
import type {
  DatabaseMetricSeries,
  LiveReadSource,
  MetricSeries,
  ReadTargetRef,
  TargetHealth,
} from "@tc/aws";
import { awsResourceName } from "@tc/core";
import { createReader, type ReaderDeps } from "../handler";

export const NOW = new Date("2026-11-11T10:00:00.000Z");
export const CUSTOMER_A = "11111111-1111-4111-8111-111111111111";
export const CUSTOMER_B = "22222222-2222-4222-8222-222222222222";
export const ADMIN = "33333333-3333-4333-8333-333333333333";
export const RESOURCE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const RESOURCE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const GHOST = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

// Planted values that must never be in an answer or a log line.
export const POOL_ACCOUNT = "210987654321";
export const EXTERNAL_ID = "tc-ext-7f3a9c";

function target(
  id: string,
  state = "active",
  family = "linux_instance",
  config: unknown = {},
): ReadTarget {
  return {
    resource: { id, state, family, config } as unknown as ReadTarget["resource"],
    account: { awsAccountId: POOL_ACCOUNT, externalId: EXTERNAL_ID },
    region: "ap-southeast-1",
  };
}

export interface SourceCall {
  readonly op: "state" | "metrics" | "transfer" | "health" | "dbmetrics";
  readonly target: ReadTargetRef;
}

// Servers recorded behind the load balancer of the tests (platform ids).
export const SERVER_1 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
export const SERVER_2 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
export const LB_A = "aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa";
export const DB_A = "aaaaaaaa-2222-4aaa-8aaa-aaaaaaaaaaaa";
export const LB_B = "bbbbbbbb-1111-4bbb-8bbb-bbbbbbbbbbbb";
export const DB_B = "bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb";

export function fakeSource(over: Partial<LiveReadSource> = {}) {
  const calls: SourceCall[] = [];
  const series: MetricSeries[] = [
    { metric: "cpu", unit: "percent", points: [{ at: NOW.toISOString(), value: 4 }] },
  ];
  const source: LiveReadSource = {
    instanceState: async (t) => {
      calls.push({ op: "state", target: t });
      return { state: "running" };
    },
    instanceMetrics: async (t) => {
      calls.push({ op: "metrics", target: t });
      return series;
    },
    transferUsed: async (t) => {
      calls.push({ op: "transfer", target: t });
      return { bytes: 1234, days: 30 };
    },
    loadBalancerTargetHealth: async (t, known) => {
      calls.push({ op: "health", target: t as never });
      const targets: TargetHealth[] = [...known.values()]
        .sort()
        .map((id) => ({ targetResourceId: id, health: "healthy" as const, reason: null }));
      return { targets, unresolved: 1 };
    },
    databaseMetrics: async (t) => {
      calls.push({ op: "dbmetrics", target: t as never });
      const out: DatabaseMetricSeries[] = [
        {
          metric: "cpu",
          unit: "percent",
          statistic: "average",
          periodSeconds: 300,
          points: [{ at: NOW.toISOString(), value: 4 }],
        },
      ];
      return out;
    },
    ...over,
  };
  return { source, calls };
}

export interface Rows {
  readonly [resourceId: string]: { readonly owner: string; readonly target: ReadTarget };
}

export function setup(over: Partial<ReaderDeps> = {}, rows?: Rows) {
  const table: Rows = rows ?? {
    [RESOURCE_A]: { owner: CUSTOMER_A, target: target(RESOURCE_A) },
    [RESOURCE_B]: { owner: CUSTOMER_B, target: target(RESOURCE_B) },
    [LB_A]: {
      owner: CUSTOMER_A,
      target: target(LB_A, "active", "load_balancer", { targetIds: [SERVER_2, SERVER_1] }),
    },
    [DB_A]: { owner: CUSTOMER_A, target: target(DB_A, "active", "database") },
    [LB_B]: { owner: CUSTOMER_B, target: target(LB_B, "active", "load_balancer") },
    [DB_B]: { owner: CUSTOMER_B, target: target(DB_B, "active", "database") },
  };
  const loads: { caller: ReadCaller; resourceId: string }[] = [];
  const { source, calls } = fakeSource();
  const logged: LogEvent[] = [];
  const clock = createManualClock(NOW);
  const deps: ReaderDeps = {
    // The real rule lives in loadReadTarget (tested against PostgreSQL); this fake obeys the same one.
    loadTarget: async (caller, resourceId) => {
      loads.push({ caller, resourceId });
      const row = table[resourceId];
      if (row === undefined) return null;
      if ("adminId" in caller) return caller.adminId === ADMIN ? row.target : null;
      return row.owner === caller.customerId ? row.target : null;
    },
    loadRecordedTargets: async (t) => {
      const ids = (t.resource.config as { targetIds?: string[] }).targetIds ?? [];
      return [...ids].sort();
    },
    source,
    clock,
    log: (e) => logged.push(e),
    ...over,
  };
  return { reader: createReader(deps), deps, calls, loads, logged, clock };
}

export { target, awsResourceName };
