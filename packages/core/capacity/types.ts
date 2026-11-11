import type { QuotaCode, ReservedCell, RISK_TIERS } from "@tc/db";

export type { QuotaCode, ReservedCell } from "@tc/db";

export type RiskTier = (typeof RISK_TIERS)[number];

// What capacityNeeds(config) of a product returns; no region means the Region of the order,
// and the Region is ignored for an account-wide code.
export interface CapacityNeed {
  readonly quotaCode: QuotaCode;
  readonly amount: number;
  readonly region?: string;
}

export type ResolvedNeed = ReservedCell;

export interface CapacityCell {
  readonly rowId: string;
  readonly quotaCode: QuotaCode;
  readonly region: string;
  readonly limit: number;
  readonly used: number;
  readonly reserve: number;
}

export interface PoolCandidate {
  readonly poolAccountId: string;
  readonly cells: readonly CapacityCell[];
}

export type AllocationFailure = "full" | "too_large" | "not_configured";

// used is the value read, for the compare-and-set.
export interface PlacedCell extends ReservedCell {
  readonly rowId: string;
  readonly used: number;
}

export interface Placement {
  readonly poolAccountId: string;
  readonly cells: readonly PlacedCell[];
}

// What the purchase stores in resources.config.capacityReservation.
export interface ReservationRecord {
  readonly v: 1;
  readonly poolAccountId: string;
  readonly cells: readonly ReservedCell[];
}

export type Allocation =
  { ok: true; placement: Placement } | { ok: false; reason: AllocationFailure };
