export const HISTORY_LIMIT_DEFAULT = 50;
export const HISTORY_LIMIT_MAX = 200;

// The messages below hold no input (R14).
export function isMarketCode(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z]{2}$/.test(value);
}

export function isFlagKeyText(value: unknown): value is string {
  return typeof value === "string" && /^[a-z][a-z0-9_]{0,39}$/.test(value);
}

export function requireInstant(value: unknown, what: string): asserts value is Date {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError(`${what}: not a valid date`);
  }
}

export function historyLimit(limit: number | undefined): number {
  if (limit === undefined) return HISTORY_LIMIT_DEFAULT;
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new TypeError("limit: not a whole number above 0");
  }
  return Math.min(limit, HISTORY_LIMIT_MAX);
}
