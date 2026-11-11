import {
  AwsError,
  METRIC_RANGES,
  type LiveReadSource,
  type MetricRange,
  type MetricSeries,
} from "@tc/aws";
import { awsResourceName, type Clock, type ErrorCode, type Logger } from "@tc/core";
import type { ReadCaller, ReadTarget } from "@tc/db";

// The live read contract of Section F: `describe(resourceId, caller)` and
// `metrics(resourceId, caller, range)`. The caller is `{ customerId }` or `{ adminId }`, taken by the
// web or admin tier from its verified session and passed in the invocation; this function checks the
// ownership itself and trusts nothing else in the event (R8).

export interface RateLimit {
  readonly max: number;
  readonly windowMs: number;
}

export const DEFAULT_RATE_LIMIT: RateLimit = Object.freeze({ max: 120, windowMs: 60_000 });

export interface ReaderDeps {
  /** The tenant check: the resource only if `caller` may read it, else null (see loadReadTarget). */
  readonly loadTarget: (caller: ReadCaller, resourceId: string) => Promise<ReadTarget | null>;
  readonly source: LiveReadSource;
  readonly clock: Clock;
  readonly log: Logger;
  readonly rateLimit?: RateLimit;
}

export type ReaderCode = Extract<
  ErrorCode,
  | "unauthenticated"
  | "not_found"
  | "validation"
  | "rate_limited"
  | "upstream_unavailable"
  | "internal"
>;
export type ReaderResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: ReaderCode };

export interface Described {
  readonly resourceId: string;
  /** The live state from Lightsail, or the recorded state for a resource that is not live. */
  readonly state: string;
  /** null when the resource is not live: nothing to measure. */
  readonly transfer: { readonly bytes: number; readonly days: number } | null;
}

export interface Measured {
  readonly resourceId: string;
  readonly range: MetricRange;
  readonly series: readonly MetricSeries[];
}

export interface Reader {
  describe(resourceId: string, caller: ReadCaller): Promise<ReaderResult<Described>>;
  metrics(
    resourceId: string,
    caller: ReadCaller,
    range: MetricRange,
  ): Promise<ReaderResult<Measured>>;
}

// The states in which an instance may exist in Lightsail. A resource that is still being created or
// is gone is answered from the database: AWS is not asked about a name that may not exist.
const LIVE_STATES: readonly string[] = ["active", "stopped", "suspended"];
// The adapter families the reader can read today (the instance adapter of WP4-T5).
const READABLE_FAMILIES: readonly string[] = ["linux_instance"];

class Refused extends Error {
  constructor(readonly code: ReaderCode) {
    super(code);
  }
}

function callerKey(caller: unknown): { kind: "customer" | "admin"; key: string } | null {
  if (typeof caller !== "object" || caller === null) return null;
  const c = caller as { customerId?: unknown; adminId?: unknown };
  const hasCustomer = c.customerId !== undefined;
  const hasAdmin = c.adminId !== undefined;
  if (hasCustomer === hasAdmin) return null;
  const id = hasCustomer ? c.customerId : c.adminId;
  if (typeof id !== "string" || id.length === 0 || id.length > 64) return null;
  return hasCustomer ? { kind: "customer", key: `c:${id}` } : { kind: "admin", key: `a:${id}` };
}

// An AWS failure becomes a platform code. A role or credential problem is ours, not the customer's.
function codeOf(error: unknown): ReaderCode {
  if (error instanceof Refused) return error.code;
  if (error instanceof AwsError) {
    switch (error.code) {
      case "rate_limited":
        return "rate_limited";
      case "not_found":
        return "not_found";
      case "upstream_unavailable":
      case "forbidden":
      case "unauthenticated":
        return "upstream_unavailable";
      default:
        return "internal";
    }
  }
  return "internal";
}

export function createReader(deps: ReaderDeps): Reader {
  const limit = deps.rateLimit ?? DEFAULT_RATE_LIMIT;
  const windows = new Map<string, { start: number; count: number }>();

  function takeSlot(key: string): void {
    const now = deps.clock.now().getTime();
    if (windows.size > 1000) {
      for (const [k, w] of windows) if (now - w.start >= limit.windowMs) windows.delete(k);
    }
    const w = windows.get(key);
    if (w === undefined || now - w.start >= limit.windowMs) {
      windows.set(key, { start: now, count: 1 });
      return;
    }
    if (w.count >= limit.max) throw new Refused("rate_limited");
    w.count += 1;
  }

  // The order of R9 for every read: authenticate, authorize, validate, rate limit, execute, audit.
  async function run<T>(
    action: "describe" | "metrics",
    resourceId: string,
    caller: ReadCaller,
    validate: () => void,
    execute: (
      target: ReadTarget,
      ref: Parameters<LiveReadSource["instanceState"]>[0],
    ) => Promise<T>,
  ): Promise<ReaderResult<T>> {
    const who = callerKey(caller);
    let outcome: "ok" | ReaderCode;
    let result: ReaderResult<T>;
    try {
      if (who === null) throw new Refused("unauthenticated");
      const target = await deps.loadTarget(caller, resourceId);
      if (target === null) throw new Refused("not_found");
      validate();
      if (!READABLE_FAMILIES.includes(target.resource.family)) throw new Refused("validation");
      takeSlot(who.key);
      const ref = {
        account: target.account,
        region: target.region as never,
        instanceName: awsResourceName("instance", target.resource.id),
      };
      result = { ok: true, value: await execute(target, ref) };
      outcome = "ok";
    } catch (error) {
      const code = codeOf(error);
      result = { ok: false, error: code };
      outcome = code;
    }
    // Fixed words only: no id of the caller, no AWS text (R14).
    deps.log({
      event: "reader_read",
      action,
      callerKind: who?.kind ?? "unknown",
      outcome,
    });
    return result;
  }

  return {
    describe: (resourceId, caller) =>
      run(
        "describe",
        resourceId,
        caller,
        () => undefined,
        async (target, ref) => {
          if (!LIVE_STATES.includes(target.resource.state)) {
            return { resourceId, state: target.resource.state, transfer: null };
          }
          const live = await deps.source.instanceState(ref);
          const transfer = await deps.source.transferUsed(ref);
          return { resourceId, state: live.state, transfer };
        },
      ),

    metrics: (resourceId, caller, range) =>
      run(
        "metrics",
        resourceId,
        caller,
        () => {
          if (typeof range !== "string" || !(METRIC_RANGES as readonly string[]).includes(range)) {
            throw new Refused("validation");
          }
        },
        async (_target, ref) => ({
          resourceId,
          range,
          series: await deps.source.instanceMetrics(ref, range),
        }),
      ),
  };
}
