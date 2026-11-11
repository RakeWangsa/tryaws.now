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
