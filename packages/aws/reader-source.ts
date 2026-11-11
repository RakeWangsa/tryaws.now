import {
  GetInstanceMetricDataCommand,
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

export interface LiveReadSource {
  /** The state name of the instance, or "missing" if AWS does not know it. */
  instanceState(target: ReadTargetRef): Promise<{ readonly state: string }>;
  instanceMetrics(target: ReadTargetRef, range: MetricRange): Promise<readonly MetricSeries[]>;
  /** NetworkIn + NetworkOut of the last `days` days, in bytes. */
  transferUsed(target: ReadTargetRef): Promise<{ readonly bytes: number; readonly days: number }>;
}

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
