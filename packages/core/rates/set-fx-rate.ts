import {
  adminRepos,
  lockFxRateWrites,
  readAdminApprover,
  readFxRateInForce,
  readFxRates,
  type AdminActor,
  type FxRateRow,
  type Tx,
} from "@tc/db";
import {
  FX_RATE_MAX_AGE_DAYS,
  FX_SINGLE_ADMIN_WINDOW_HOURS,
  fxSingleAdminApproval,
  fxWithinSingleAdminWindow,
  isFxRateText,
  type FxSingleAdminApproval,
} from "../pricing/index";
import type { Clock, Result } from "../types";
import { isMarketText, isUuidText, marketProblem, reasonProblem, resolveStart } from "./common";

export interface SetFxRateInput {
  market: string;
  /** Plain decimal text, at most 6 digits before and 6 after the point. */
  rate: string;
  /** Defaults to the instant of the call. Never in the past, at most 7 days ahead (WPU-Y9). */
  effectiveFrom?: Date;
  reason: string;
  /**
   * The other admin of a four-eyes change: the admin who asked, read by the caller from the stored pending change
   * (WPU-Y1). Absent: the actor sets the rate alone, allowed only for the first rate of a market or a change of at
   * most 3 percent (WPU-X9, owner decision 2026-11-14); otherwise refused with second_admin_required.
   */
  requestedBy?: string;
}

export interface SavedFxRate {
  fx: FxRateRow;
  replayed: boolean;
}

// The roles that may approve a large change of a rate (spec 16.12: finance and superadmin).
const APPROVER_ROLES: readonly string[] = ["finance", "superadmin"];

/**
 * WPU-X9. The ground on which one admin may set `rate` for `market` starting at `start`, or null. Holds the write
 * lock of the market first (the same lock the repository takes; advisory locks nest in one transaction), so two
 * single-admin changes in a row are each compared with the rate the other one left. The first rate of a market is one
 * with no row at all, scheduled ones included. Any later change alone (round 1, owner decision 2026-11-14 "3% per 24
 * hours"): no row may be scheduled after it (after now, or after its start), and it must be within 3 percent of every
 * rate in force during the 24 hours before now and, for a scheduled change, before its start.
 */
async function singleAdminGround(
  tx: Tx,
  market: string,
  rate: string,
  at: Date,
  start: Date,
): Promise<FxSingleAdminApproval | null> {
  await lockFxRateWrites(tx, market);
  const now = await readFxRateInForce(tx, market, at);
  const newest = await readFxRates(tx, market, 1);
  const ground = fxSingleAdminApproval(now?.rate ?? null, rate, newest.length > 0);
  if (ground !== "single_admin_within_limit") return ground;
  // The compared times: now, and the start of a scheduled change.
  const compared = start.getTime() > at.getTime() ? [at, start] : [at];
  const last = compared[compared.length - 1] as Date;
  // Round 1 (security review): no change alone before a rate that is already scheduled after it.
  const latest = newest[0];
  if (latest === undefined || latest.effectiveFrom.getTime() > last.getTime()) return null;
  // Round 1 (owner decision 2026-11-14, "3% per 24 hours"): within 3 percent of every rate in force during the
  // 24 hours before each compared time, so chained small steps cannot add up.
  for (const time of compared) {
    if (!fxWithinSingleAdminWindow(await ratesInWindow(tx, market, time), rate)) return null;
  }
  return ground;
}

/**
 * The rates in force during the FX_SINGLE_ADMIN_WINDOW_HOURS before `time`: the one in force at the window's start and
 * every row that started inside the window (up to `time`). A history longer than the read limit gives an unreadable
 * entry (null), which fxWithinSingleAdminWindow refuses (R16).
 */
async function ratesInWindow(tx: Tx, market: string, time: Date): Promise<(string | null)[]> {
  const from = time.getTime() - FX_SINGLE_ADMIN_WINDOW_HOURS * HOUR_MS;
  const rows = await readFxRates(tx, market, WINDOW_READ_LIMIT, time);
  const rates: (string | null)[] = [];
  for (const row of rows) {
    rates.push(row.rate);
    if (row.effectiveFrom.getTime() <= from) return rates; // the rate in force at the window's start
  }
  // Every row read started inside the window: complete only when the read was not cut at its limit.
  if (rows.length >= WINDOW_READ_LIMIT) rates.push(null);
  return rates;
}

const HOUR_MS = 3_600_000;
// The most rows readFxRates returns (HISTORY_LIMIT_MAX of @tc/db).
const WINDOW_READ_LIMIT = 200;

const forbidden = (token: string): Result<never> => ({
  ok: false,
  error: "forbidden",
  fields: { requestedBy: token },
});

/**
 * Saves a rate for a market, with the start the caller names or now. R10: the write is audited by
 * the repository (actor, reason, IP, target; a single-admin change also its ground, `approval`). The action checks
 * the role of the session (open point 8); this checks that the approver of the change is an active finance or
 * superadmin admin. It cannot know that the second admin really approved (open point 5). Fails closed (R16).
 */
export async function setFxRate(
  tx: Tx,
  actor: AdminActor,
  input: SetFxRateInput,
  clock: Clock,
): Promise<Result<SavedFxRate>> {
  const at = clock.now();
  const { market, rate, effectiveFrom, reason, requestedBy } = input;
  const fields: Record<string, string> = {};
  if (!isMarketText(market)) fields.market = "invalid";
  if (!isFxRateText(rate)) fields.rate = "invalid";
  const why = reasonProblem(reason);
  if (why !== null) fields.reason = why;
  if (requestedBy !== undefined && !isUuidText(requestedBy)) fields.requestedBy = "invalid";
  // WPU-Y9: a rate starts at most FX_RATE_MAX_AGE_DAYS after it is entered, so it is never entered long before use.
  const start = resolveStart(effectiveFrom, at, FX_RATE_MAX_AGE_DAYS);
  if (!start.ok) fields.effectiveFrom = start.problem;
  if (!start.ok || Object.keys(fields).length > 0) {
    return { ok: false, error: "validation", fields };
  }

  const unknown = await marketProblem(tx, market);
  if (unknown !== null) return { ok: false, error: "validation", fields: { market: unknown } };

  let approval: FxSingleAdminApproval | undefined;
  if (requestedBy === undefined) {
    // WPU-X9 (owner decision 2026-11-14, "alone, within ±3%"; replaces "every rate is four-eyes" of WPU-Y1 for
    // these cases): ONE admin may set the first rate of a market, or a rate at most 3 percent from the rate in force.
    // The actor must be an active admin who could approve (finance or superadmin). Anything else is refused as
    // second_admin_required, so the caller files a pending change for a different admin (R16: fail closed).
    const self = await readAdminApprover(tx, actor.adminId);
    if (self === null || self.status !== "active" || !APPROVER_ROLES.includes(self.role)) {
      return forbidden("not_an_approver");
    }
    const ground = await singleAdminGround(tx, market, rate, at, start.value);
    if (ground === null) return forbidden("second_admin_required");
    approval = ground;
  } else {
    // WPU-Y1 (owner decision 3): a four-eyes change. The requester is named by the stored pending change, never by a
    // request, and the actor here is the approver.
    if (requestedBy.toLowerCase() === actor.adminId.toLowerCase()) {
      return forbidden("must_differ_from_actor");
    }
    const other = await readAdminApprover(tx, requestedBy);
    if (other === null || other.status !== "active" || !APPROVER_ROLES.includes(other.role)) {
      return forbidden("not_an_approver");
    }
  }

  const written = await adminRepos(tx, actor).fxRates.set(
    {
      market,
      rate,
      effectiveFrom: start.value,
      at,
      ...(approval === undefined ? { approvedBy: requestedBy } : { approval }),
      reconfirm: true,
    },
    reason,
  );
  if (written.ok) {
    const { id, market: code, rate: saved, effectiveFrom: from, createdAt } = written.value;
    return {
      ok: true,
      value: {
        fx: { id, market: code, rate: saved, effectiveFrom: from, createdAt },
        replayed: written.replayed,
      },
    };
  }
  if (written.error === "conflict") {
    return { ok: false, error: "conflict", fields: { effectiveFrom: "taken_by_another_rate" } };
  }
  return { ok: false, error: "validation", fields: { rate: "invalid" } };
}
