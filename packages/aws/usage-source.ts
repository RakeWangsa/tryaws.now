import {
  GetDiskSnapshotsCommand,
  GetInstanceMetricDataCommand,
  GetInstanceSnapshotsCommand,
  GetInstancesCommand,
  GetRelationalDatabaseSnapshotsCommand,
} from "@aws-sdk/client-lightsail";
import { dhakaDay, type Clock, type UsageSample } from "@tc/core";
import type { AwsAccess } from "./access";
import { AwsError, toAwsError } from "./errors";
import {
  LIGHTSAIL_REGIONS,
  checkedAccountRef,
  type AccountRef,
  type LightsailRegion,
} from "./roles";

// WPU-X4. The usage reader behind the `usage` of the reconciler's InventoryRead (WPU-B3): snapshot GB per
// parent resource for today and data transfer GB per Dhaka hour. Everything uses TcReader (Get* only) in
// the pool account, assumed by STS (R3). The answer is the UsageSample of @tc/core; the reconciler port
// (functions/reconciler) wraps this, and only functions/ imports this package (R1).
//
// Fail closed (R16): any error, a malformed answer or a list that never ends fails the whole read. A
// partial list would under-charge a customer silently. Nothing here writes a log line (R14); the caller
// logs `toLogFields(error)`.

export interface UsageSource {
  read(account: AccountRef): Promise<UsageSample[]>;
}

const MAX_PAGES = 50;
const WINDOW_HOURS = 24;
const HOUR_MS = 3_600_000;
const DHAKA_OFFSET_MS = 6 * HOUR_MS;
// VERIFY: AWS bills data transfer in GB of 2^30 bytes; a decision is recorded in JOURNEY.md.
const BYTES_PER_GB = 2n ** 30n;
const MICRO = 1_000_000n;

type Kind = "instance" | "disk" | "database";
const NAMES: Record<Kind, RegExp> = {
  instance: /^tc-instance-[0-9a-f]{16}$/,
  disk: /^tc-disk-[0-9a-f]{16}$/,
  database: /^tc-database-[0-9a-f]{16}$/,
};

function invalid(operation: string): AwsError {
  return new AwsError({
    code: "internal",
    retryable: true,
    reason: "usage_response_invalid",
    operation,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Whole GB as text; a size that is not a whole, non-negative number fails the read. */
function wholeGb(value: unknown, operation: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw invalid(operation);
  return value;
}

function dhakaHour(at: Date): string {
  return new Date(at.getTime() + DHAKA_OFFSET_MS).toISOString().slice(0, 13);
}

/** Bytes to GB text with at most 6 decimals, truncated. "0" when the hour moved nothing. */
export function bytesToGbText(bytes: number): string {
  const micro = (BigInt(Math.round(bytes)) * MICRO) / BYTES_PER_GB;
  const whole = micro / MICRO;
  const fraction = (micro % MICRO).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction === "" ? whole.toString() : `${whole}.${fraction}`;
}

export function createLightsailUsageSource(
  access: AwsAccess<"reconciler">,
  clock: Clock,
): UsageSource {
  async function pages<T>(
    operation: string,
    list: string,
    send: (pageToken: string | undefined) => Promise<unknown>,
  ): Promise<T[]> {
    const out: T[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = await send(pageToken);
      if (!isRecord(response) || !Array.isArray(response[list])) throw invalid(operation);
      out.push(...(response[list] as T[]));
      const next = response["nextPageToken"];
      if (next === undefined || next === null || next === "") return out;
      if (typeof next !== "string") throw invalid(operation);
      pageToken = next;
    }
    throw new AwsError({
      code: "internal",
      retryable: true,
      reason: "usage_pages_exceeded",
      operation,
    });
  }

  async function readRegion(
    account: AccountRef,
    region: LightsailRegion,
    now: Date,
    out: UsageSample[],
  ): Promise<void> {
    const client = access.lightsail(account, region, "TcReader");
    const token = (t: string | undefined) => (t === undefined ? {} : { pageToken: t });

    // Snapshot GB: the finished snapshots of one parent, added up, for today. WPU-Z19: a finished disk snapshot is
    // "completed" (DiskSnapshot.state: pending, completed, error, unknown); an instance or database snapshot is
    // "available". Any other state has no size to charge yet.
    const totals = new Map<string, number>();
    const add = (kind: Kind, parent: unknown, size: unknown, state: unknown, op: string) => {
      if (state !== (kind === "disk" ? "completed" : "available")) return;
      const gb = wholeGb(size, op);
      if (typeof parent !== "string" || !NAMES[kind].test(parent)) return; // not ours
      totals.set(parent, (totals.get(parent) ?? 0) + gb);
    };
    const reads: [string, string, Kind, string, (t: string | undefined) => Promise<unknown>][] = [
      [
        "GetInstanceSnapshots",
        "instanceSnapshots",
        "instance",
        "fromInstanceName",
        (t) => client.send(new GetInstanceSnapshotsCommand(token(t))),
      ],
      [
        "GetDiskSnapshots",
        "diskSnapshots",
        "disk",
        "fromDiskName",
        (t) => client.send(new GetDiskSnapshotsCommand(token(t))),
      ],
      [
        "GetRelationalDatabaseSnapshots",
        "relationalDatabaseSnapshots",
        "database",
        "fromRelationalDatabaseName",
        (t) => client.send(new GetRelationalDatabaseSnapshotsCommand(token(t))),
      ],
    ];
    for (const [op, list, kind, parentField, send] of reads) {
      for (const item of await pages<unknown>(op, list, send)) {
        if (!isRecord(item)) throw invalid(op);
        add(kind, item[parentField], item["sizeInGb"], item["state"], op);
      }
    }
    const period = dhakaDay(now);
    for (const [awsName, gb] of totals) {
      out.push({ awsName, metric: "snapshot_gb", period, quantityGb: String(gb) });
    }

    // Transfer GB: NetworkOut (bytes sent out) per whole hour of the last 24, per server.
    const end = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS;
    const start = end - WINDOW_HOURS * HOUR_MS;
    const instances = await pages<unknown>("GetInstances", "instances", (t) =>
      client.send(new GetInstancesCommand(token(t))),
    );
    for (const instance of instances) {
      if (!isRecord(instance)) throw invalid("GetInstances");
      const name = instance["name"];
      if (typeof name !== "string" || !NAMES.instance.test(name)) continue;
      const metric = await client.send(
        new GetInstanceMetricDataCommand({
          instanceName: name,
          metricName: "NetworkOut",
          period: 3600,
          startTime: new Date(start),
          endTime: new Date(end),
          unit: "Bytes",
          statistics: ["Sum"],
        }),
      );
      const data: unknown = metric.metricData;
      if (!Array.isArray(data)) throw invalid("GetInstanceMetricData");
      const perHour = new Map<string, number>();
      for (const point of data as unknown[]) {
        if (!isRecord(point)) throw invalid("GetInstanceMetricData");
        const at = point["timestamp"];
        const sum = point["sum"];
        if (!(at instanceof Date) || Number.isNaN(at.getTime()))
          throw invalid("GetInstanceMetricData");
        if (typeof sum !== "number" || !Number.isFinite(sum) || sum < 0) {
          throw invalid("GetInstanceMetricData");
        }
        if (at.getTime() < start || at.getTime() >= end) continue; // not a whole hour of the window
        const hour = dhakaHour(at);
        perHour.set(hour, (perHour.get(hour) ?? 0) + sum);
      }
      for (const [hour, bytes] of perHour) {
        const quantityGb = bytesToGbText(bytes);
        if (quantityGb !== "0") {
          out.push({ awsName: name, metric: "transfer_gb", period: hour, quantityGb });
        }
      }
    }
  }

  return {
    async read(account) {
      const checked = checkedAccountRef(account); // before any call
      const now = clock.now();
      const out: UsageSample[] = [];
      try {
        // One Region after the other: a failed Region fails the account (R16).
        for (const region of LIGHTSAIL_REGIONS) await readRegion(checked, region, now, out);
      } catch (error) {
        throw toAwsError(error, null);
      }
      return out;
    },
  };
}
