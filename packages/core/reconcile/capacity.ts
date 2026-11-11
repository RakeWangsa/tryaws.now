import { isCellKey, ROLLING_WINDOW_CODES, type QuotaCode } from "@tc/db";

// Which cells of a pool account the hourly or nightly run may correct (spec 10.2). The correction
// itself is recomputeUsed (capacity/inventory.ts), which never sets `used` below live plus pending.
// A cell with no live count is skipped and reported, not read as zero (R16).

export interface CapacityRow {
  readonly rowId: string;
  readonly region: string;
  readonly quotaCode: string;
  readonly used: number;
  readonly quotaLimit: number;
}

export interface LiveCount {
  readonly region: string;
  readonly quotaCode: string;
  readonly live: number;
}

export interface CapacityCheck {
  readonly region: string;
  readonly quotaCode: string;
  readonly live: number;
}

export interface CapacityPlan {
  readonly checks: CapacityCheck[];
  readonly skipped: { region: string; quotaCode: string }[];
}

const cellId = (region: string, quotaCode: string) => `${region}\u0000${quotaCode}`;

export function planCapacityChecks(
  rows: readonly CapacityRow[],
  live: readonly LiveCount[],
): CapacityPlan {
  const counts = new Map<string, number>();
  for (const l of live) {
    if (!Number.isInteger(l.live) || l.live < 0) {
      throw new RangeError("reconcile: a live count is a whole number of units, 0 or more");
    }
    counts.set(cellId(l.region, l.quotaCode), l.live);
  }
  const plan: CapacityPlan = { checks: [], skipped: [] };
  for (const row of rows) {
    if (!isCellKey(row.quotaCode, row.region)) continue;
    if (ROLLING_WINDOW_CODES.includes(row.quotaCode as QuotaCode)) {
      // Counted from the platform's own records; the value passed is ignored.
      plan.checks.push({ region: row.region, quotaCode: row.quotaCode, live: 0 });
      continue;
    }
    const count = counts.get(cellId(row.region, row.quotaCode));
    if (count === undefined) plan.skipped.push({ region: row.region, quotaCode: row.quotaCode });
    else plan.checks.push({ region: row.region, quotaCode: row.quotaCode, live: count });
  }
  return plan;
}
