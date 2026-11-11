// The shared keys of capacity (WP4-T3, section 10.2): which cell a unit lives in, and the
// shape of the reservation record that a purchase stores in resources.config.
import { QUOTA_CODES } from "./schema/provisioning";

export type QuotaCode = (typeof QUOTA_CODES)[number];

// AWS counts these two per account, not per Region: one row per pool account on this Region value.
export const ACCOUNT_REGION = "global";
export const ACCOUNT_WIDE_CODES: readonly QuotaCode[] = ["bucket", "distribution"];
// A certificate counts for 365 days after its resource is gone, so a release never gives it back.
export const ROLLING_WINDOW_CODES: readonly QuotaCode[] = ["certificate_365d"];

// The shape of a Region; the closed list of the three Regions lives in @tc/aws and the catalog.
export const REGION_PATTERN = /^[a-z]{2}(?:-[a-z]+)+-[0-9]$/;

// Only an active pool account takes a reservation or a new home.
export const POOL_ACCOUNT_STATUSES = ["active", "disabled"] as const;

export const RESERVE_KEY_PREFIX = "capacity.reserve.";
export const RESERVATION_CONFIG_KEY = "capacityReservation";
export const RESERVATION_AMOUNT_MAX = 1_000_000;

function isQuotaCode(value: string): value is QuotaCode {
  return (QUOTA_CODES as readonly string[]).includes(value);
}

export function cellRegion(quotaCode: QuotaCode, region: string): string {
  return ACCOUNT_WIDE_CODES.includes(quotaCode) ? ACCOUNT_REGION : region;
}

export function isCellKey(quotaCode: string, region: string): boolean {
  if (!isQuotaCode(quotaCode)) return false;
  if (ACCOUNT_WIDE_CODES.includes(quotaCode)) return region === ACCOUNT_REGION;
  return REGION_PATTERN.test(region);
}

export function reserveKey(quotaCode: QuotaCode): string {
  return RESERVE_KEY_PREFIX + quotaCode;
}

export interface ReservedCell {
  readonly quotaCode: QuotaCode;
  readonly region: string;
  readonly amount: number;
}

export function isReservedCell(value: unknown): value is ReservedCell {
  if (typeof value !== "object" || value === null) return false;
  const { quotaCode, region, amount } = value as Record<string, unknown>;
  if (typeof quotaCode !== "string" || typeof region !== "string") return false;
  if (!isCellKey(quotaCode, region)) return false;
  return (
    typeof amount === "number" &&
    Number.isInteger(amount) &&
    amount >= 1 &&
    amount <= RESERVATION_AMOUNT_MAX
  );
}
