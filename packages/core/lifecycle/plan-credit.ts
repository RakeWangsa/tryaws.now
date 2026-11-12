import { prorateMinor } from "../pricing/prorata";
import type { Result } from "../types";

// WPU-M3. The amount a customer is owed when a paid plan change was not delivered. Pure: the two
// prices are paisa totals that the pricing engine produced (quoteInForce, the same pieces the renewal
// uses); nothing is computed from a float or from text here (R4).
//
// Rules (stated in JOURNEY.md, WPU-M3):
//   complete    the whole charge is unearned: credit = charged.
//   difference  an UPGRADE was charged and not delivered (the full difference): credit = charged - delivered.
//   prorata     a DOWNGRADE was charged at the old price and applied late: credit = (charged - delivered)
//               × days left / days of the term, days left counted from the instant the smaller plan took
//               effect, a started day counting as a day, rounded half-up.
//
// The existing reversal (reverseTransaction) posts a WHOLE charge only; `expressibleByReversal` says
// whether this credit is that. A partial credit is a Needs decision (no posting rule exists for it).

const DAY_MS = 24 * 60 * 60 * 1000;

export type PlanCreditRule = "complete" | "difference" | "prorata";

export interface PlanCreditInput {
  readonly rule: PlanCreditRule;
  /** The renewal total that was charged for the period, from the ledger. */
  readonly chargedMinor: bigint | null;
  /** The renewal total of the plan the resource really had (the pricing engine); not used by `complete`. */
  readonly deliveredMinor: bigint | null;
  /** The charged period: it starts at the old period end and lasts a whole number of days. */
  readonly periodStart: Date;
  readonly periodEnd: Date;
  /** `prorata` only: when the smaller plan took effect, within the period. */
  readonly effectiveFrom?: Date;
}

export interface PlanCredit {
  readonly creditMinor: bigint;
  /** True only when the credit equals the whole charge, which the existing reversal can post. */
  readonly expressibleByReversal: boolean;
}

const isPrice = (value: unknown): value is bigint => typeof value === "bigint" && value > 0n;
const valid = (d: unknown): d is Date => d instanceof Date && !Number.isNaN(d.getTime());

export function planCreditMinor(input: PlanCreditInput): Result<PlanCredit> {
  // Read once into locals, so a getter cannot answer differently on the second read.
  const { rule, chargedMinor, deliveredMinor, periodStart, periodEnd, effectiveFrom } = input;
  if (rule !== "complete" && rule !== "difference" && rule !== "prorata") {
    return { ok: false, error: "validation", fields: { rule: "unknown" } };
  }
  // A price that is missing, zero or negative stops everything (R16): a credit is never guessed.
  if (!isPrice(chargedMinor)) {
    return { ok: false, error: "validation", fields: { chargedMinor: "missing" } };
  }
  if (rule === "complete") {
    return { ok: true, value: { creditMinor: chargedMinor, expressibleByReversal: true } };
  }
  if (!isPrice(deliveredMinor)) {
    return { ok: false, error: "validation", fields: { deliveredMinor: "missing" } };
  }
  if (deliveredMinor >= chargedMinor) {
    return { ok: false, error: "conflict", fields: { deliveredMinor: "not_cheaper" } };
  }
  const difference = chargedMinor - deliveredMinor;
  if (rule === "difference") {
    return { ok: true, value: { creditMinor: difference, expressibleByReversal: false } };
  }

  if (!valid(periodStart) || !valid(periodEnd) || !valid(effectiveFrom)) {
    return { ok: false, error: "validation", fields: { period: "invalid" } };
  }
  const termMs = periodEnd.getTime() - periodStart.getTime();
  if (termMs <= 0 || termMs % DAY_MS !== 0) {
    return { ok: false, error: "validation", fields: { period: "not_whole_days" } };
  }
  const leftMs = periodEnd.getTime() - effectiveFrom.getTime();
  if (leftMs < 0 || effectiveFrom.getTime() < periodStart.getTime()) {
    return { ok: false, error: "validation", fields: { effectiveFrom: "outside_period" } };
  }
  const termDays = termMs / DAY_MS;
  const daysLeft = Math.ceil(leftMs / DAY_MS);
  return {
    ok: true,
    value: {
      creditMinor: prorateMinor(difference, daysLeft, termDays),
      expressibleByReversal: false,
    },
  };
}
