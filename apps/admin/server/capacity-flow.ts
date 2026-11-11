import { correctedUsed, type Result } from "@tc/core";
import {
  QUOTA_CODES,
  type AdminActor,
  type AdminRepos,
  type AdminRole,
  type NotifiedEntry,
  type NotifyNextInput,
  type Tx,
} from "@tc/db";

// The actions of /capacity in the order of R9: authenticate and authorize, validate, rate limit, execute
// (one transaction, every write through `audited`), and the answer. Fixed codes only (R14, R16).

export type CapacityActionKind = "setCapacityLimit" | "notifyWaitlist";

export interface CapacityActionRequest {
  readonly kind: CapacityActionKind;
  readonly reason: unknown;
  // setCapacityLimit
  readonly poolAccountId?: unknown;
  readonly region?: unknown;
  readonly quotaCode?: unknown;
  readonly limit?: unknown;
  // notifyWaitlist
  readonly productFamily?: unknown;
  readonly waitlistReason?: unknown;
  readonly count?: unknown;
}

export type CapacityActionCode =
  "invalid" | "denied" | "not_found" | "conflict" | "rate_limited" | "unavailable";

export type CapacityActionAnswer =
  | { readonly ok: true; readonly replayed: boolean; readonly notified?: number }
  | { readonly ok: false; readonly code: CapacityActionCode };

export interface CapacityFlowDeps {
  readonly authorize: (roles: readonly AdminRole[]) => Promise<AdminActor>;
  readonly limiter: (actor: AdminActor, now: Date) => Promise<boolean>;
  readonly run: <T>(actor: AdminActor, fn: (repos: AdminRepos, tx: Tx) => Promise<T>) => Promise<T>;
  // notifyWaitlist of @tc/core with the notifier of the runtime (fails closed while none is wired).
  readonly notifyWaitlist: (
    tx: Tx,
    actor: AdminActor,
    input: NotifyNextInput & { why: string },
  ) => Promise<Result<{ notified: NotifiedEntry[] }>>;
  readonly clock: { now(): Date };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REGION = /^(?:global|[a-z]{2}(?:-[a-z]+)+-[0-9])$/;
const FAMILY = /^[a-z][a-z0-9_]{0,39}$/;
export const MAX_REASON = 500;
const LIMIT_MAX = 1_000_000;
const COUNT_MAX = 100;

export const CAPACITY_ROLES: readonly AdminRole[] = ["ops", "superadmin"];
const KINDS: readonly CapacityActionKind[] = ["setCapacityLimit", "notifyWaitlist"];

// Whole numbers from a form: digits only, no sign, no exponent, no float.
function wholeNumber(value: unknown, max: number, min: number): number | null {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || !/^[0-9]{1,9}$/.test(text.trim())) return null;
  const n = Number.parseInt(text.trim(), 10);
  return n >= min && n <= max ? n : null;
}

export interface Correction {
  readonly used: number;
  readonly corrected: number;
  readonly delta: number;
  readonly live: number;
  readonly pending: number;
}

// The recompute shown on /capacity. It writes nothing: admin_rw may not update `used` (the hourly
// inventory run of 10.2 does), so the screen shows what that run would set.
export function describeCorrection(used: number, live: number, pending: number): Correction {
  const corrected = correctedUsed(live, pending);
  return { used, corrected, delta: corrected - used, live, pending };
}

export function parseLive(value: unknown): number | null {
  return wholeNumber(value, LIMIT_MAX, 0);
}

type Outcome =
  { ok: true; replayed: boolean; notified?: number } | { ok: false; code: CapacityActionCode };

export function makeCapacityAction(
  deps: CapacityFlowDeps,
): (request: CapacityActionRequest) => Promise<CapacityActionAnswer> {
  return async (request) => {
    // Read once into locals, so a getter cannot answer differently on the second read.
    const s = {
      kind: request.kind,
      reason: request.reason,
      poolAccountId: request.poolAccountId,
      region: request.region,
      quotaCode: request.quotaCode,
      limit: request.limit,
      productFamily: request.productFamily,
      waitlistReason: request.waitlistReason,
      count: request.count,
    };
    let actor: AdminActor;
    try {
      actor = await deps.authorize(CAPACITY_ROLES);
    } catch {
      return { ok: false, code: "denied" };
    }
    try {
      if (typeof s.kind !== "string" || !KINDS.includes(s.kind)) {
        return { ok: false, code: "invalid" };
      }
      if (typeof s.reason !== "string") return { ok: false, code: "invalid" };
      const why = s.reason.trim();
      if (why === "" || why.length > MAX_REASON) return { ok: false, code: "invalid" };
      if (typeof s.region !== "string" || !REGION.test(s.region)) {
        return { ok: false, code: "invalid" };
      }
      const region = s.region;

      let work: (repos: AdminRepos, tx: Tx) => Promise<Outcome>;
      if (s.kind === "setCapacityLimit") {
        const limit = wholeNumber(s.limit, LIMIT_MAX, 0);
        if (
          typeof s.poolAccountId !== "string" ||
          !UUID.test(s.poolAccountId) ||
          typeof s.quotaCode !== "string" ||
          !(QUOTA_CODES as readonly string[]).includes(s.quotaCode) ||
          limit === null
        ) {
          return { ok: false, code: "invalid" };
        }
        const input = {
          poolAccountId: s.poolAccountId.toLowerCase(),
          region,
          quotaCode: s.quotaCode as (typeof QUOTA_CODES)[number],
          limit,
        };
        work = async (repos) => {
          const done = await repos.capacity.setLimit(input, why);
          return done.ok
            ? { ok: true, replayed: done.replayed }
            : { ok: false, code: mapRefusal(done.error) };
        };
      } else {
        const count = wholeNumber(s.count, COUNT_MAX, 1);
        if (
          typeof s.productFamily !== "string" ||
          !FAMILY.test(s.productFamily) ||
          (s.waitlistReason !== "capacity" && s.waitlistReason !== "flag_off") ||
          count === null
        ) {
          return { ok: false, code: "invalid" };
        }
        const input = {
          productFamily: s.productFamily,
          region,
          reason: s.waitlistReason,
          count,
          why,
        };
        work = async (_repos, tx) => {
          const done = await deps.notifyWaitlist(tx, actor, input);
          return done.ok
            ? {
                ok: true,
                replayed: done.value.notified.length === 0,
                notified: done.value.notified.length,
              }
            : { ok: false, code: mapRefusal(done.error) };
        };
      }

      const at = deps.clock.now();
      if (!(await deps.limiter(actor, at))) return { ok: false, code: "rate_limited" };
      const outcome = await deps.run<Outcome>(actor, work);
      if (!outcome.ok) return { ok: false, code: outcome.code };
      return outcome.notified === undefined
        ? { ok: true, replayed: outcome.replayed }
        : { ok: true, replayed: outcome.replayed, notified: outcome.notified };
    } catch {
      return { ok: false, code: "unavailable" };
    }
  };
}

function mapRefusal(error: string): CapacityActionCode {
  if (error === "forbidden") return "denied";
  if (error === "validation") return "invalid";
  if (error === "not_found" || error === "conflict") return error;
  return "unavailable";
}
