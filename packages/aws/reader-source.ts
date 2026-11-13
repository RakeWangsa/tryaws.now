import {
  GetInstanceMetricDataCommand,
  GetLoadBalancerCommand,
  GetRelationalDatabaseMetricDataCommand,
  type RelationalDatabaseMetricName,
  GetInstanceStateCommand,
  type InstanceMetricName,
  type MetricStatistic,
  type MetricUnit,
} from "@aws-sdk/client-lightsail";
import type { Clock } from "@tc/core";
import type { AwsAccess } from "./access";
import { AwsError, toAwsError } from "./errors";
import type { AccountRef, LightsailRegion } from "./roles";

// The live read port of the `reader` function (WP5-T3). Everything here uses the TcReader role
// (Lightsail Get* only). The shapes carry platform words, never AWS names or ARNs.

export const METRIC_RANGES = Object.freeze(["1h", "1d", "1w"] as const);
export type MetricRange = (typeof METRIC_RANGES)[number];

export type MetricName = "cpu" | "networkIn" | "networkOut" | "statusCheckFailed";

export interface MetricPoint {
  /** ISO 8601, UTC. */
  readonly at: string;
  readonly value: number;
}

export interface MetricSeries {
  readonly metric: MetricName;
  readonly unit: "percent" | "bytes" | "count";
  readonly points: readonly MetricPoint[];
}

export interface ReadTargetRef {
  readonly account: AccountRef;
  readonly region: LightsailRegion;
  /** The generated `tc-instance-<id>` name (R11). */
  readonly instanceName: string;
}

// WPU-Y8 (contract F, reader additions). Platform words only; the AWS strings never leave this file.
export type TargetHealthState =
  "healthy" | "unhealthy" | "initial" | "unused" | "draining" | "unavailable";
export type TargetHealthReason =
  | "registering"
  | "initial_checks"
  | "response_code_mismatch"
  | "timeout"
  | "failed_checks"
  | "internal_error"
  | "not_registered"
  | "not_in_use"
  | "ip_unusable"
  | "stopped"
  | "deregistering"
  | "unknown";
export interface TargetHealth {
  readonly targetResourceId: string;
  readonly health: TargetHealthState;
  readonly reason: TargetHealthReason | null;
}
export interface LoadBalancerReadRef {
  readonly account: AccountRef;
  readonly region: LightsailRegion;
  /** The generated `tc-lb-<id>` name (R11). */
  readonly loadBalancerName: string;
}
export interface TargetHealthRead {
  readonly targets: readonly TargetHealth[];
  readonly unresolved: number;
}
export type DatabaseMetricName = "cpu" | "connections" | "freeStorage" | "diskQueue";
export interface DatabaseMetricSeries {
  readonly metric: DatabaseMetricName;
  readonly unit: "percent" | "count" | "bytes";
  readonly statistic: "average" | "maximum" | "minimum";
  readonly periodSeconds: number;
  readonly points: readonly MetricPoint[];
}
export interface DatabaseReadRef {
  readonly account: AccountRef;
  readonly region: LightsailRegion;
  /** The generated `tc-database-<id>` name (R11). */
  readonly databaseName: string;
}
export const MAX_LB_TARGETS = 20;

export interface LiveReadSource {
  /**
   * Health of the servers behind a load balancer. `known` maps generated instance names to platform
   * ids (the recorded targets of this load balancer); a name not in it is only counted.
   */
  loadBalancerTargetHealth(
    target: LoadBalancerReadRef,
    known: ReadonlyMap<string, string>,
  ): Promise<TargetHealthRead>;
  databaseMetrics(
    target: DatabaseReadRef,
    range: MetricRange,
  ): Promise<readonly DatabaseMetricSeries[]>;
  /** The state name of the instance, or "missing" if AWS does not know it. */
  instanceState(target: ReadTargetRef): Promise<{ readonly state: string }>;
  instanceMetrics(target: ReadTargetRef, range: MetricRange): Promise<readonly MetricSeries[]>;
  /** NetworkIn + NetworkOut of the last `days` days, in bytes. */
  transferUsed(target: ReadTargetRef): Promise<{ readonly bytes: number; readonly days: number }>;
}

const LB_NAME = /^tc-lb-[0-9a-f]{16}$/;
const DATABASE_NAME = /^tc-database-[0-9a-f]{16}$/;
const HEALTH_STATES: readonly TargetHealthState[] = [
  "healthy",
  "unhealthy",
  "initial",
  "unused",
  "draining",
  "unavailable",
];
const HEALTH_REASONS: Readonly<Record<string, TargetHealthReason>> = Object.freeze({
  "Lb.RegistrationInProgress": "registering",
  "Lb.InitialHealthChecking": "initial_checks",
  "Instance.ResponseCodeMismatch": "response_code_mismatch",
  "Instance.Timeout": "timeout",
  "Instance.FailedHealthChecks": "failed_checks",
  "Lb.InternalError": "internal_error",
  "Instance.NotRegistered": "not_registered",
  "Instance.NotInUse": "not_in_use",
  "Instance.IpUnusable": "ip_unusable",
  "Instance.InvalidState": "stopped",
  "Instance.DeregistrationInProgress": "deregistering",
});
const INSTANCE_NAME = /^tc-instance-[0-9a-f]{16}$/;
const RANGE_SECONDS: Record<MetricRange, { window: number; period: number }> = {
  "1h": { window: 3_600, period: 300 },
  "1d": { window: 86_400, period: 900 },
  "1w": { window: 604_800, period: 3_600 },
};
// VERIFY against the Lightsail API reference: the period of GetInstanceMetricData is a multiple of
// 60 seconds, and the longest window allowed for one call.
const TRANSFER_DAYS = 30;
const TRANSFER_PERIOD = 86_400;

interface MetricSpec {
  readonly metric: MetricName;
  readonly aws: InstanceMetricName;
  readonly unit: MetricUnit;
  readonly platformUnit: MetricSeries["unit"];
  readonly statistic: MetricStatistic;
  readonly field: "average" | "sum" | "maximum";
}

const SPECS: readonly MetricSpec[] = [
  {
    metric: "cpu",
    aws: "CPUUtilization",
    unit: "Percent",
    platformUnit: "percent",
    statistic: "Average",
    field: "average",
  },
  {
    metric: "networkIn",
    aws: "NetworkIn",
    unit: "Bytes",
    platformUnit: "bytes",
    statistic: "Sum",
    field: "sum",
  },
  {
    metric: "networkOut",
    aws: "NetworkOut",
    unit: "Bytes",
    platformUnit: "bytes",
    statistic: "Sum",
    field: "sum",
  },
  {
    metric: "statusCheckFailed",
    aws: "StatusCheckFailed",
    unit: "Count",
    platformUnit: "count",
    statistic: "Maximum",
    field: "maximum",
  },
];

interface DbSpec {
  readonly metric: DatabaseMetricName;
  readonly aws: RelationalDatabaseMetricName;
  readonly unit: MetricUnit;
  readonly platformUnit: DatabaseMetricSeries["unit"];
  readonly statistic: MetricStatistic;
  readonly platformStatistic: DatabaseMetricSeries["statistic"];
  readonly field: "average" | "maximum" | "minimum";
}
const DB_SPECS: readonly DbSpec[] = [
  {
    metric: "cpu",
    aws: "CPUUtilization",
    unit: "Percent",
    platformUnit: "percent",
    statistic: "Average",
    platformStatistic: "average",
    field: "average",
  },
  {
    metric: "connections",
    aws: "DatabaseConnections",
    unit: "Count",
    platformUnit: "count",
    statistic: "Maximum",
    platformStatistic: "maximum",
    field: "maximum",
  },
  {
    metric: "freeStorage",
    aws: "FreeStorageSpace",
    unit: "Bytes",
    platformUnit: "bytes",
    statistic: "Minimum",
    platformStatistic: "minimum",
    field: "minimum",
  },
  {
    metric: "diskQueue",
    aws: "DiskQueueDepth",
    unit: "Count",
    platformUnit: "count",
    statistic: "Maximum",
    platformStatistic: "maximum",
    field: "maximum",
  },
];

function invalidAnswer(operation: string): AwsError {
  return new AwsError({
    code: "internal",
    retryable: false,
    reason: "reader_response_invalid",
    operation,
  });
}

function badName(): AwsError {
  return new AwsError({ code: "validation", retryable: false });
}

export function createLightsailReadSource(
  access: AwsAccess<"reader">,
  clock: Clock,
): LiveReadSource {
  function client(target: ReadTargetRef) {
    if (typeof target.instanceName !== "string" || !INSTANCE_NAME.test(target.instanceName)) {
      throw badName();
    }
    return access.lightsail(target.account, target.region, "TcReader");
  }

  async function points(
    target: ReadTargetRef,
    spec: MetricSpec,
    window: number,
    period: number,
  ): Promise<MetricPoint[]> {
    const end = clock.now();
    const out = await client(target).send(
      new GetInstanceMetricDataCommand({
        instanceName: target.instanceName,
        metricName: spec.aws,
        period,
        startTime: new Date(end.getTime() - window * 1000),
        endTime: end,
        unit: spec.unit,
        statistics: [spec.statistic],
      }),
    );
    const list: MetricPoint[] = [];
    for (const d of out.metricData ?? []) {
      const value = d[spec.field];
      if (!(d.timestamp instanceof Date) || typeof value !== "number" || !Number.isFinite(value)) {
        continue;
      }
      list.push({ at: d.timestamp.toISOString(), value });
    }
    return list.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  }

  return {
    async loadBalancerTargetHealth(target, known) {
      if (typeof target.loadBalancerName !== "string" || !LB_NAME.test(target.loadBalancerName)) {
        throw badName();
      }
      let out;
      try {
        out = await access
          .lightsail(target.account, target.region, "TcReader")
          .send(new GetLoadBalancerCommand({ loadBalancerName: target.loadBalancerName }));
      } catch (error) {
        throw toAwsError(error, "GetLoadBalancer");
      }
      const lb = out.loadBalancer;
      const summary = lb?.instanceHealthSummary ?? [];
      // An answer for another name, or more targets than the product allows, is refused (R16).
      if (lb?.name !== target.loadBalancerName || summary.length > MAX_LB_TARGETS) {
        throw invalidAnswer("GetLoadBalancer");
      }
      const seen = new Set<string>();
      const targets: TargetHealth[] = [];
      let unresolved = 0;
      for (const item of summary) {
        const name = item.instanceName;
        if (typeof name !== "string" || seen.has(name)) throw invalidAnswer("GetLoadBalancer");
        seen.add(name);
        const id = known.get(name);
        if (id === undefined) {
          unresolved += 1;
          continue;
        }
        const raw = item.instanceHealth as string | undefined;
        const health = (HEALTH_STATES as readonly string[]).includes(raw ?? "")
          ? (raw as TargetHealthState)
          : "unavailable";
        const rawReason = item.instanceHealthReason as string | undefined;
        const reason =
          health === "healthy" || rawReason === undefined
            ? null
            : Object.hasOwn(HEALTH_REASONS, rawReason)
              ? HEALTH_REASONS[rawReason]!
              : "unknown";
        targets.push({ targetResourceId: id, health, reason });
      }
      targets.sort((a, b) =>
        a.targetResourceId < b.targetResourceId
          ? -1
          : a.targetResourceId > b.targetResourceId
            ? 1
            : 0,
      );
      return { targets, unresolved };
    },

    async databaseMetrics(target, range) {
      if (typeof target.databaseName !== "string" || !DATABASE_NAME.test(target.databaseName)) {
        throw badName();
      }
      const shape = Object.hasOwn(RANGE_SECONDS, range) ? RANGE_SECONDS[range] : undefined;
      if (shape === undefined) throw badName();
      const lightsail = access.lightsail(target.account, target.region, "TcReader");
      const series: DatabaseMetricSeries[] = [];
      for (const spec of DB_SPECS) {
        let out;
        const end = clock.now();
        try {
          out = await lightsail.send(
            new GetRelationalDatabaseMetricDataCommand({
              relationalDatabaseName: target.databaseName,
              metricName: spec.aws,
              period: shape.period,
              startTime: new Date(end.getTime() - shape.window * 1000),
              endTime: end,
              unit: spec.unit,
              statistics: [spec.statistic],
            }),
          );
        } catch (error) {
          throw toAwsError(error, "GetRelationalDatabaseMetricData");
        }
        if (out.metricName !== undefined && out.metricName !== spec.aws) {
          throw invalidAnswer("GetRelationalDatabaseMetricData");
        }
        const list: MetricPoint[] = [];
        for (const d of out.metricData ?? []) {
          const value = d[spec.field];
          if (value === undefined || value === null) continue; // a missing period is a missing point
          if (!(d.timestamp instanceof Date) || !Number.isFinite(value) || value < 0) {
            throw invalidAnswer("GetRelationalDatabaseMetricData");
          }
          list.push({ at: d.timestamp.toISOString(), value });
        }
        list.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
        series.push({
          metric: spec.metric,
          unit: spec.platformUnit,
          statistic: spec.platformStatistic,
          periodSeconds: shape.period,
          points: list,
        });
      }
      return series;
    },

    async instanceState(target) {
      try {
        const out = await client(target).send(
          new GetInstanceStateCommand({ instanceName: target.instanceName }),
        );
        const name = out.state?.name;
        return { state: typeof name === "string" && name.length > 0 ? name : "unknown" };
      } catch (error) {
        const e = toAwsError(error, "GetInstanceState");
        if (e.code === "not_found") return { state: "missing" };
        throw e;
      }
    },

    async instanceMetrics(target, range) {
      const shape = Object.hasOwn(RANGE_SECONDS, range) ? RANGE_SECONDS[range] : undefined;
      if (shape === undefined) throw badName();
      const series: MetricSeries[] = [];
      for (const spec of SPECS) {
        try {
          series.push({
            metric: spec.metric,
            unit: spec.platformUnit,
            points: await points(target, spec, shape.window, shape.period),
          });
        } catch (error) {
          throw toAwsError(error, "GetInstanceMetricData");
        }
      }
      return series;
    },

    async transferUsed(target) {
      let bytes = 0;
      for (const spec of SPECS.filter(
        (s) => s.metric === "networkIn" || s.metric === "networkOut",
      )) {
        try {
          for (const p of await points(target, spec, TRANSFER_DAYS * 86_400, TRANSFER_PERIOD)) {
            bytes += p.value;
          }
        } catch (error) {
          throw toAwsError(error, "GetInstanceMetricData");
        }
      }
      return { bytes: Math.round(bytes), days: TRANSFER_DAYS };
    },
  };
}
