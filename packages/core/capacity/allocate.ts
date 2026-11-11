// The pure choice of a pool account for a set of needs (section 10.2). No database, no I/O.
import {
  cellRegion,
  isCellKey,
  QUOTA_CODES,
  REGION_PATTERN,
  type QuotaCode,
  type ReservedCell,
} from "@tc/db";
import type {
  Allocation,
  AllocationFailure,
  CapacityCell,
  CapacityNeed,
  PlacedCell,
  PoolCandidate,
  ResolvedNeed,
} from "./types";

const MAX_CELLS = 20;

export type NeedsResult = { ok: true; needs: ResolvedNeed[] } | { ok: false; reason: string };

// Turns the needs of a product into cells: account-wide codes go to the Region global, equal cells
// are added, the result is sorted by quota code and then Region. Fixed texts only (R14).
export function resolveNeeds(needs: readonly CapacityNeed[], orderRegion: string): NeedsResult {
  if (!REGION_PATTERN.test(orderRegion))
    return { ok: false, reason: "the order region is not valid" };
  if (needs.length === 0) return { ok: false, reason: "there is no need" };
  const sums = new Map<string, { quotaCode: QuotaCode; region: string; amount: number }>();
  for (const need of needs) {
    if (!(QUOTA_CODES as readonly string[]).includes(need.quotaCode)) {
      return { ok: false, reason: "a need names no quota code" };
    }
    if (!Number.isInteger(need.amount) || need.amount < 1) {
      return { ok: false, reason: "a need is not a whole number of units" };
    }
    const wanted = need.region ?? orderRegion;
    if (!REGION_PATTERN.test(wanted)) return { ok: false, reason: "a need names no region" };
    const region = cellRegion(need.quotaCode, wanted);
    if (!isCellKey(need.quotaCode, region)) return { ok: false, reason: "a need is not a cell" };
    const key = `${need.quotaCode}\u0000${region}`;
    const known = sums.get(key);
    if (known) known.amount += need.amount;
    else sums.set(key, { quotaCode: need.quotaCode, region, amount: need.amount });
  }
  if (sums.size > MAX_CELLS) return { ok: false, reason: "there are too many cells" };
  const resolved = [...sums.values()].sort((a, b) =>
    a.quotaCode !== b.quotaCode
      ? a.quotaCode < b.quotaCode
        ? -1
        : 1
      : a.region < b.region
        ? -1
        : a.region > b.region
          ? 1
          : 0,
  );
  return { ok: true, needs: resolved };
}

export function freeUnits(cell: Pick<CapacityCell, "limit" | "used" | "reserve">): number {
  return Math.max(0, cell.limit - cell.reserve - cell.used);
}

// The "quota request at 70 % use" of section M and the capacity warning of 16.12. Integers only.
export function capacityWarning(cell: Pick<CapacityCell, "limit" | "used">): boolean {
  return cell.limit > 0 && cell.used * 100 >= cell.limit * 70;
}

type Verdict = "fits" | "full" | "too_large" | "missing";

function judge(need: ResolvedNeed, cell: CapacityCell | undefined): Verdict {
  if (!cell) return "missing";
  const sellable = cell.limit - cell.reserve;
  if (sellable > 0 && need.amount > sellable) return "too_large";
  if (need.amount > freeUnits(cell)) return "full";
  return "fits";
}

// The first pool account (by id, the oldest first) that holds every need. All or nothing.
export function allocate(
  needs: readonly ResolvedNeed[],
  candidates: readonly PoolCandidate[],
): Allocation {
  if (needs.length === 0) return { ok: false, reason: "not_configured" };
  const sorted = [...candidates].sort((a, b) =>
    a.poolAccountId < b.poolAccountId ? -1 : a.poolAccountId > b.poolAccountId ? 1 : 0,
  );
  let sawFull = false;
  let sawTooLarge = false;
  for (const candidate of sorted) {
    const placed: PlacedCell[] = [];
    let failure: Verdict = "fits";
    for (const need of needs) {
      const cell = candidate.cells.find(
        (c) => c.quotaCode === need.quotaCode && c.region === need.region,
      );
      failure = judge(need, cell);
      if (failure !== "fits" || !cell) break;
      const reserved: ReservedCell = need;
      placed.push({ ...reserved, rowId: cell.rowId, used: cell.used });
    }
    if (failure === "fits") {
      return { ok: true, placement: { poolAccountId: candidate.poolAccountId, cells: placed } };
    }
    if (failure === "full") sawFull = true;
    else if (failure === "too_large") sawTooLarge = true;
  }
  const reason: AllocationFailure = sawFull ? "full" : sawTooLarge ? "too_large" : "not_configured";
  return { ok: false, reason };
}
