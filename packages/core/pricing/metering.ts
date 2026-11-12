import type { Minor } from "../types";
import { D, isPositiveDecimal, parseDecimal, toMinor } from "./decimal";
import { PricingInputError } from "./errors";

// Spec 11 (metered items). The decimal arithmetic of metering lives here, inside the pricing engine
// (R4); the metering code outside only handles the bigint paisa and the level that come back.

const DAYS_PER_MONTH = 30;

/**
 * The charge of one day of a metered quantity: `gb x price per GB-month / 30`, half-up, in paisa.
 * `gb` is plain decimal text (a usage record's quantity); the price is a bigint of paisa.
 */
export function dailyMeteredChargeMinor(gb: string, pricePerGbMonthMinor: Minor): Minor {
  const quantity = parseDecimal(gb, "gb");
  if (typeof pricePerGbMonthMinor !== "bigint" || pricePerGbMonthMinor < 0n) {
    const message = "pricePerGbMonthMinor must be a bigint of 0 or more";
    throw new PricingInputError(message, [{ path: "pricePerGbMonthMinor", message }]);
  }
  return toMinor(quantity.times(new D(pricePerGbMonthMinor.toString())).div(DAYS_PER_MONTH));
}

export type AllowanceLevel = 0 | 80 | 100;

/**
 * Where the use stands against the bundle allowance: 100 at or above it, 80 from 80% of it, else 0.
 * An allowance of 0 or an unreadable number is refused: there is nothing to measure against (R16).
 */
export function allowanceLevel(usedGb: string, allowanceGb: string): AllowanceLevel {
  const used = parseDecimal(usedGb, "usedGb");
  const allowance = parseDecimal(allowanceGb, "allowanceGb");
  if (!isPositiveDecimal(allowanceGb)) {
    const message = "allowanceGb must be above zero";
    throw new PricingInputError(message, [{ path: "allowanceGb", message }]);
  }
  if (used.gte(allowance)) return 100;
  if (used.times(100).gte(allowance.times(80))) return 80;
  return 0;
}

/** The price of one unit of a metered item as the engine quoted it: the base and the steps add up to the total. */
export interface MeteredUnitPrice {
  readonly totalMinor: Minor;
  readonly baseMinor: Minor;
  readonly steps: readonly { readonly code: string; readonly amountMinor: Minor }[];
}

/**
 * WPU-M2 (spec 9.1: a metered charge has "the same split as a purchase"). Shares `chargeMinor` between
 * the base and the steps of the unit price in their proportions: each step is
 * `charge x step / unit total`, half-up, and the base takes what is left, so the lines add up to the
 * charge exactly. A charge of one whole unit gets the unit price itself. A unit whose lines do not add
 * up to its total, a unit of 0 or a negative charge is refused (R16).
 */
export function splitMeteredChargeMinor(
  chargeMinor: Minor,
  unit: MeteredUnitPrice,
): { baseMinor: Minor; steps: { code: string; amountMinor: Minor }[] } {
  const fail = (path: string, message: string): never => {
    throw new PricingInputError(message, [{ path, message }]);
  };
  if (typeof chargeMinor !== "bigint" || chargeMinor < 0n) {
    fail("chargeMinor", "chargeMinor must be a bigint of 0 or more");
  }
  if (unit.totalMinor <= 0n) fail("unit", "the unit price must be above zero");
  const parts = unit.steps.reduce((sum, s) => sum + s.amountMinor, unit.baseMinor);
  if (
    parts !== unit.totalMinor ||
    unit.baseMinor < 0n ||
    unit.steps.some((s) => s.amountMinor < 0n)
  ) {
    fail("unit", "the base and the steps of the unit price do not add up to its total");
  }
  if (chargeMinor === unit.totalMinor) {
    return { baseMinor: unit.baseMinor, steps: unit.steps.map((s) => ({ ...s })) };
  }
  const steps = unit.steps.map((s) => ({
    code: s.code,
    amountMinor: toMinor(
      new D(chargeMinor.toString()).times(s.amountMinor.toString()).div(unit.totalMinor.toString()),
    ),
  }));
  const baseMinor = steps.reduce((left, s) => left - s.amountMinor, chargeMinor);
  if (baseMinor < 0n) fail("unit", "the steps are more than the charge");
  return { baseMinor, steps };
}
