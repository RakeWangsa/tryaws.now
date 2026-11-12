import { dhakaDay } from "./run";

// WPU-B3 (item 20). The reconciler reads the usage that AWS reports (snapshot GB of a server, data
// transfer GB of an hour) and writes it into usage_records through the one writer, upsertUsage. The
// metering run (run.ts) only reads those rows. This file is the pure part: which of the reported samples
// become writes. Nothing here touches AWS or the database; a sample that cannot be trusted is dropped and
// counted by reason, never written (R16), and a reason names no value (R14).

export const USAGE_METRICS = ["snapshot_gb", "transfer_gb"] as const;
export type UsageMetric = (typeof USAGE_METRICS)[number];

/**
 * One measurement as the inventory port reports it. `awsName` is the generated name of the RESOURCE the
 * usage belongs to (the server, not its snapshots): the port attributes the snapshots to their parent.
 * `period` is a Dhaka day (`YYYY-MM-DD`) for snapshot_gb and a Dhaka hour (`YYYY-MM-DDTHH`) for
 * transfer_gb. `quantityGb` is plain decimal text.
 */
export interface UsageSample {
  readonly awsName: string;
  readonly metric: UsageMetric;
  readonly period: string;
  readonly quantityGb: string;
}

export interface UsageResourceView {
  readonly id: string;
  readonly awsName: string | null;
  readonly state: string;
}

export interface UsageWrite {
  readonly resourceId: string;
  readonly metric: UsageMetric;
  readonly period: string;
  readonly quantity: string;
}

export type UsageSkipReason =
  "metric" | "period" | "quantity" | "unmatched" | "state" | "duplicate";

export interface UsagePlan {
  readonly writes: UsageWrite[];
  /** How many samples were dropped, by reason. Reasons that did not happen are absent. */
  readonly skipped: Partial<Record<UsageSkipReason, number>>;
}

/** The states in which a resource exists on AWS and can have usage. */
const USAGE_STATES: readonly string[] = ["active", "stopped", "suspended"];
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const HOUR = /^\d{4}-\d{2}-\d{2}T\d{2}$/;
// Plain decimal text with at most 6 decimals: the column is numeric(20,6) and nothing else is stored.
const PLAIN = /^(0|[1-9]\d{0,9})(\.\d{1,6})?$/;
/** A single resource does not hold or move more than this in one measurement; a unit mistake is dropped. */
const MAX_GB = 1_000_000;

function validDay(period: string): boolean {
  if (!DAY.test(period)) return false;
  const at = new Date(`${period}T00:00:00.000Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().startsWith(period);
}

function validHour(period: string): boolean {
  if (!HOUR.test(period) || !validDay(period.slice(0, 10))) return false;
  return Number(period.slice(11)) <= 23;
}

/** Dhaka is UTC+6 with no daylight saving; the current Dhaka hour as `YYYY-MM-DDTHH`. */
function dhakaHour(at: Date): string {
  const shifted = new Date(at.getTime() + 6 * 3_600_000);
  return shifted.toISOString().slice(0, 13);
}

function quantityOk(text: string): boolean {
  if (!PLAIN.test(text)) return false;
  return Number(text) <= MAX_GB;
}

export function planUsageWrites(
  samples: readonly UsageSample[],
  resources: readonly UsageResourceView[],
  now: Date,
): UsagePlan {
  const skipped: Partial<Record<UsageSkipReason, number>> = {};
  const skip = (reason: UsageSkipReason): void => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };
  const byName = new Map<string, UsageResourceView>();
  for (const r of resources) if (r.awsName !== null) byName.set(r.awsName, r);

  const today = dhakaDay(now);
  const thisHour = dhakaHour(now);

  // Every check of one sample; a key that was reported twice is dropped whole, all of its reports.
  const seen = new Map<string, { write: UsageWrite; count: number }>();
  for (const sample of samples) {
    if (!(USAGE_METRICS as readonly string[]).includes(sample.metric)) {
      skip("metric");
      continue;
    }
    const periodOk =
      sample.metric === "snapshot_gb"
        ? validDay(sample.period) && sample.period === today
        : validHour(sample.period) && sample.period <= thisHour;
    if (!periodOk) {
      skip("period");
      continue;
    }
    if (typeof sample.quantityGb !== "string" || !quantityOk(sample.quantityGb)) {
      skip("quantity");
      continue;
    }
    const resource = byName.get(sample.awsName);
    if (resource === undefined) {
      skip("unmatched");
      continue;
    }
    if (!USAGE_STATES.includes(resource.state)) {
      skip("state");
      continue;
    }
    const key = `${resource.id}|${sample.metric}|${sample.period}`;
    const known = seen.get(key);
    if (known !== undefined) {
      known.count += 1;
      continue;
    }
    seen.set(key, {
      write: {
        resourceId: resource.id,
        metric: sample.metric,
        period: sample.period,
        quantity: sample.quantityGb,
      },
      count: 1,
    });
  }

  const writes: UsageWrite[] = [];
  for (const { write, count } of seen.values()) {
    if (count === 1) writes.push(write);
    else skipped.duplicate = (skipped.duplicate ?? 0) + count;
  }
  return { writes, skipped };
}
