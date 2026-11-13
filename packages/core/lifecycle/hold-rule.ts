// WPU-Z1. The pure rules of the lifecycle hold (WPU-Y1, WPU-Y9, WPU-Y10) that the engine applies. Dates in, a
// decision out; the engine reads and writes the markers.
import { isFxRateUnavailable } from "../rates/fx-gate";
import type { ErrorCode, Result } from "../types";
import type { SubscriptionStatus } from "./decide";

/**
 * Why a renewal is held. `fx_rate`: the USD to BDT rate is missing or older than 7 days (WPU-Y1).
 * `price_unavailable`: any other failure to price or post it that is not the customer's wallet (a stored price that
 * cannot be read, no pricing rule in force, a ledger refusal); `error` is its fixed code, never a message (R14).
 */
export type HoldReason =
  | { readonly reason: "fx_rate" }
  | { readonly reason: "price_unavailable"; readonly error: ErrorCode };

/**
 * The hold that a failed renewal, or a failed quote of one, calls for; null when nothing is held: it went through,
 * or the wallet is short (`insufficient_balance` is the customer's own reason and keeps the grace path). R16: every
 * other failure is the platform's, so it never moves the customer toward grace, suspension or retention.
 */
export function holdReasonOf(result: Result<unknown>): HoldReason | null {
  if (result.ok || result.error === "insufficient_balance") return null;
  if (isFxRateUnavailable(result)) return { reason: "fx_rate" };
  return { reason: "price_unavailable", error: result.error };
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The value to store as the hold marker (`resources.config.fxRateHold`), or null when the stored one stays. A new
 * marker is `{ since, reason }` plus `error` for `price_unavailable`. `since` is written once and never moved: a
 * later hold for another reason updates `reason` and `error` only, a repeat of the same hold writes nothing (R7). A
 * marker written before WPU-Z1 (`{ since }`) gains its reason. A stored marker that is not an object still holds; it
 * is never rewritten, because its start cannot be known (R16).
 */
export function nextHoldMarker(
  stored: unknown,
  hold: HoldReason,
  now: Date,
): Record<string, unknown> | null {
  const why: Record<string, unknown> =
    hold.reason === "fx_rate"
      ? { reason: hold.reason }
      : { reason: hold.reason, error: hold.error };
  if (stored === undefined || stored === null) return { since: now.toISOString(), ...why };
  if (!isPlainObject(stored)) return null;
  const { reason, error, ...kept } = stored;
  if (reason === why.reason && error === why.error) return null;
  return { ...kept, ...why };
}

/** The facts of the stale-marker rule: the subscription and its two markers as stored. */
export interface MarkerView {
  readonly status: SubscriptionStatus;
  readonly periodEnd: Date;
  /** `resources.config.fxRateHold` as stored. */
  readonly hold: unknown;
  /** `resources.config.graceFrom` as stored. */
  readonly graceFrom: unknown;
}

/**
 * True when the hold marker or `graceFrom` is stale: the subscription carries one of them while it is active with its
 * period end still ahead. A hold is only ever written at or after the period end, and `graceFrom` only for a grace,
 * so in that state they belong to a period that was paid in the meantime: by hand (renewNow runs as web_rw, which
 * cannot write resources.config) or by any other path that moved the period. In every other state they are live. A
 * date that cannot be read clears nothing (R16).
 */
export function staleHoldMarkers(view: MarkerView, now: Date): boolean {
  const carried = (value: unknown) => value !== undefined && value !== null;
  if (!carried(view.hold) && !carried(view.graceFrom)) return false;
  const nowMs = now.getTime();
  const endMs = view.periodEnd.getTime();
  if (Number.isNaN(nowMs) || Number.isNaN(endMs)) return false;
  return view.status === "active" && endMs > nowMs;
}
