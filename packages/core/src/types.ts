export type Minor = bigint; // money in paisa (R4)
export type Locale = "bn" | "en";
export type ErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "kyc_required"
  | "limit_reached"
  | "flag_off"
  | "validation"
  | "insufficient_balance"
  | "capacity_full"
  | "price_changed"
  | "conflict"
  | "not_found"
  | "rate_limited"
  | "upstream_unavailable"
  | "internal";
export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: ErrorCode; fields?: Record<string, string>; data?: unknown; ref?: string };
export interface Clock {
  now(): Date;
} // injected everywhere time matters (Section 11)
