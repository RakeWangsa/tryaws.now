import { adminRepos, readAdminApprover, type AdminActor, type FxRateRow, type Tx } from "@tc/db";
import { isFxRateText } from "../pricing/index";
import type { Clock, Result } from "../types";
import { isMarketText, isUuidText, marketProblem, reasonProblem, resolveStart } from "./common";

export interface SetFxRateInput {
  market: string;
  /** Plain decimal text, at most 6 digits before and 6 after the point. */
  rate: string;
  /** Defaults to the instant of the call. Never in the past, at most 90 days ahead. */
  effectiveFrom?: Date;
  reason: string;
  /** The second admin of a change of more than 5 percent (named by the caller, see open point 5). */
  requestedBy?: string;
}

export interface SavedFxRate {
  fx: FxRateRow;
  replayed: boolean;
}

// The roles that may approve a large change of a rate (spec 16.12: finance and superadmin).
const APPROVER_ROLES: readonly string[] = ["finance", "superadmin"];

const forbidden = (token: string): Result<never> => ({
  ok: false,
  error: "forbidden",
  fields: { requestedBy: token },
});

/**
 * Saves a rate for a market, with the start the caller names or now. R10: the write is audited by
 * the repository (actor, reason, IP, target). It checks no role (the action does, open point 8) and
 * cannot know that the second admin really approved (open point 5). Fails closed (R16).
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
  const start = resolveStart(effectiveFrom, at);
  if (!start.ok) fields.effectiveFrom = start.problem;
  if (!start.ok || Object.keys(fields).length > 0) {
    return { ok: false, error: "validation", fields };
  }

  const unknown = await marketProblem(tx, market);
  if (unknown !== null) return { ok: false, error: "validation", fields: { market: unknown } };

  // WPU-Y1 (owner decision 3): EVERY rate is a four-eyes change. The requester is named by the stored pending
  // change, never by a request, and the actor here is the approver: a rate without a second admin is refused.
  if (requestedBy === undefined) return forbidden("second_admin_required");
  if (requestedBy.toLowerCase() === actor.adminId.toLowerCase()) {
    return forbidden("must_differ_from_actor");
  }
  const other = await readAdminApprover(tx, requestedBy);
  if (other === null || other.status !== "active" || !APPROVER_ROLES.includes(other.role)) {
    return forbidden("not_an_approver");
  }

  const written = await adminRepos(tx, actor).fxRates.set(
    {
      market,
      rate,
      effectiveFrom: start.value,
      at,
      approvedBy: requestedBy,
      reconfirm: true,
    },
    reason,
  );
  if (written.ok) {
    const { id, market: code, rate: saved, effectiveFrom: from } = written.value;
    return {
      ok: true,
      value: {
        fx: { id, market: code, rate: saved, effectiveFrom: from },
        replayed: written.replayed,
      },
    };
  }
  if (written.error === "conflict") {
    return { ok: false, error: "conflict", fields: { effectiveFrom: "taken_by_another_rate" } };
  }
  return { ok: false, error: "validation", fields: { rate: "invalid" } };
}
