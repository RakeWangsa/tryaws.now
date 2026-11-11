import { sql, type SQL } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Tx } from "../client";

// The atomic limiter on rate_limits (WP2-T3). One conditional upsert per rule: a returned row means
// "allowed"; the count never passes the limit and a refused call changes nothing. Time comes from the
// caller (the injected Clock), never from SQL now(). The statement is a `sql` template with exactly the
// columns that web_rw may insert (no created_at, no Drizzle insert()), and uses no .raw.

export type LimitSubjectKind = "ip" | "phone" | "email";

// `subject` is 32 lower-case hex characters made by the caller from an HMAC: the limiter never sees a
// phone number, an email address or an IP address. `email:` keys, like `ip:` and `phone:`, are system
// keys, not tenant keys.
export interface LimitRule {
  readonly kind: LimitSubjectKind;
  readonly subject: string;
  readonly action: string;
  readonly limit: number;
  readonly windowSeconds: number;
}

export type LimitDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly action: string; readonly retryAfterSeconds: number };

const HEX_SUBJECT = /^[0-9a-f]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTION = /^[a-z][a-z0-9_.]{0,47}$/;
const MAX_WINDOW_SECONDS = 86_400;
const MAX_LIMIT = 10_000;

function assertWindow(windowSeconds: number): void {
  if (!Number.isInteger(windowSeconds) || windowSeconds < 1 || windowSeconds > MAX_WINDOW_SECONDS) {
    throw new TypeError("rate limit: windowSeconds must be an integer from 1 to 86400");
  }
}

// <kind>:<subject>:<action>:<windowSeconds>. The window length is in the key so that a changed window
// never mixes counters. A customer subject is any-case UUID and comes out lower-case.
export function limitKey(
  kind: LimitSubjectKind | "customer",
  subject: string,
  action: string,
  windowSeconds: number,
): string {
  if (kind !== "customer" && kind !== "ip" && kind !== "phone" && kind !== "email") {
    throw new TypeError("rate limit: unknown subject kind");
  }
  if (typeof subject !== "string") throw new TypeError("rate limit: subject is not valid");
  let normalized: string;
  if (kind === "customer") {
    if (!UUID.test(subject)) throw new TypeError("rate limit: customer subject is not a UUID");
    normalized = subject.toLowerCase();
  } else {
    if (!HEX_SUBJECT.test(subject)) {
      throw new TypeError("rate limit: subject must be 32 lower-case hex characters");
    }
    normalized = subject;
  }
  if (typeof action !== "string" || !ACTION.test(action)) {
    throw new TypeError("rate limit: action is not valid");
  }
  assertWindow(windowSeconds);
  return `${kind}:${normalized}:${action}:${windowSeconds}`;
}

// floor(now / window) * window in epoch milliseconds.
export function windowStartOf(now: Date, windowSeconds: number): Date {
  assertWindow(windowSeconds);
  const ms = windowSeconds * 1000;
  return new Date(Math.floor(now.getTime() / ms) * ms);
}

// The whole seconds to the end of the window, rounded up, at least 1.
export function retryAfterSeconds(now: Date, windowSeconds: number): number {
  const end = windowStartOf(now, windowSeconds).getTime() + windowSeconds * 1000;
  return Math.max(1, Math.ceil((end - now.getTime()) / 1000));
}

// The counter statement. `key` is an SQL fragment (a plain string parameter, or one built in SQL from
// a bound customer id). True when a row came back, that is when the hit was counted.
export async function countHit(
  tx: Tx,
  key: SQL,
  windowStart: Date,
  limit: number,
): Promise<boolean> {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new TypeError("rate limit: limit must be an integer from 1 to 10000");
  }
  const result = await tx.execute(
    sql`insert into rate_limits as r (id, scope_key, window_start, count) values (${uuidv7()}, ${key}, ${windowStart.toISOString()}::timestamptz, 1) on conflict (scope_key, window_start) do update set count = r.count + 1 where r.count < ${limit} returning r.count as "count"`,
  );
  return result.rows.length > 0;
}

// Applies the rules in ascending key order (so two callers never lock the same two rows in opposite
// orders) and stops at the first refusal. It does not undo the increments before the refusal: the
// caller's transaction must roll back (throw) when it wants all or nothing. Only ip, phone and email rules.
export async function consumeRateLimits(
  tx: Tx,
  rules: readonly LimitRule[],
  now: Date,
): Promise<LimitDecision> {
  if (!Array.isArray(rules) || rules.length === 0) {
    throw new TypeError("rate limit: no rules");
  }
  const prepared = rules.map((rule) => {
    if (rule.kind !== "ip" && rule.kind !== "phone" && rule.kind !== "email") {
      throw new TypeError("rate limit: only ip, phone and email rules are accepted");
    }
    if (!Number.isInteger(rule.limit) || rule.limit < 1 || rule.limit > MAX_LIMIT) {
      throw new TypeError("rate limit: limit must be an integer from 1 to 10000");
    }
    return {
      rule,
      key: limitKey(rule.kind, rule.subject, rule.action, rule.windowSeconds),
    };
  });
  prepared.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const { rule, key } of prepared) {
    const counted = await countHit(
      tx,
      sql`${key}`,
      windowStartOf(now, rule.windowSeconds),
      rule.limit,
    );
    if (!counted) {
      return {
        allowed: false,
        action: rule.action,
        retryAfterSeconds: retryAfterSeconds(now, rule.windowSeconds),
      };
    }
  }
  return { allowed: true };
}

// WP5-T4: the scheduler's purge. Deletes the windows that started before `before` and returns how many
// there were. worker_rw may read window_start and delete, and nothing else on this table. The cutoff
// comes from the injected Clock; a count only grows inside a window, so a window that started before
// the cutoff is over.
export async function purgeRateLimits(tx: Tx, before: Date): Promise<number> {
  if (!(before instanceof Date) || Number.isNaN(before.getTime())) {
    throw new TypeError("rate limit purge: before is not a valid Date");
  }
  const result = await tx.execute(
    sql`delete from rate_limits where window_start < ${before.toISOString()}::timestamptz`,
  );
  return result.rowCount ?? 0;
}
