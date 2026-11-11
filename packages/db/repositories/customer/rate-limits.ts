import { sql } from "drizzle-orm";
import {
  countHit,
  limitKey,
  retryAfterSeconds,
  windowStartOf,
  type LimitDecision,
} from "../rate-limit";
import type { TenantScope } from "../scope";

export interface CustomerLimit {
  readonly action: string;
  readonly limit: number;
  readonly windowSeconds: number;
}

export interface RateLimitsRepo {
  // Counts one hit against every limit, in ascending key order, and stops at the first refusal. It
  // does not undo the limits before the refusal: the caller's transaction rolls back (throws) when it
  // wants all or nothing. It is not idempotent by design: a counter must count every call, so a
  // caller makes its own action idempotent before it reaches the counter. An empty list or an invalid
  // field is a TypeError.
  consume(limits: readonly CustomerLimit[], now: Date): Promise<LimitDecision>;
}

export function rateLimitsRepo(scope: TenantScope): RateLimitsRepo {
  return {
    async consume(limits, now) {
      if (!Array.isArray(limits) || limits.length === 0) {
        throw new TypeError("rate limit: no limits");
      }
      // limitKey validates action and window; the key used in SQL is built from the bound customer id
      // of the scope, never from a string that a caller made.
      const ordered = limits
        .map((l) => ({
          l,
          sortKey: limitKey("customer", scope.customerId, l.action, l.windowSeconds),
        }))
        .sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
      for (const { l } of ordered) {
        const key = sql`'customer:' || ${scope.customerId}::uuid::text || ':' || ${l.action} || ':' || ${String(l.windowSeconds)}`;
        const counted = await countHit(scope.tx, key, windowStartOf(now, l.windowSeconds), l.limit);
        if (!counted) {
          return {
            allowed: false,
            action: l.action,
            retryAfterSeconds: retryAfterSeconds(now, l.windowSeconds),
          };
        }
      }
      return { allowed: true };
    },
  };
}
