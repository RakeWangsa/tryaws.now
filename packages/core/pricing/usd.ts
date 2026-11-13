import type { Minor } from "../types";
import { D, isPlainDecimal, isPositiveDecimal, toMinor } from "./decimal";
import { PricingInputError } from "./errors";

// WPU-Y4. The customer sees a price in US dollars; the wallet is charged in BDT paisa. The BDT amount
// is the engine's total (quote / quoteWithBook, markup, taxes and fees included, per-step half-up
// rounding, ledger split unchanged). The USD amount is that same total written in dollars, in whole
// micro-USD (1 USD = 1,000,000), with as few decimals (2 to 6) as give the BDT amount back exactly.
// So the USD shown and the BDT charged cannot disagree: usdToBdtMinor(customerUsd(q).micro, fx)
// equals q.totalMinor. All arithmetic is the engine's decimal library, half-up (R4).

/** The rate must stay below this so that one paisa is wider than one micro-USD and the round trip is exact. */
const MAX_INVERTIBLE_RATE = "10000";

function checkRate(fxRate: string): void {
  if (!isPositiveDecimal(fxRate)) {
    const message = "fxRate must be plain decimal text above 0";
    throw new PricingInputError(message, [{ path: "fxRate", message }]);
  }
}

/** Paisa for an amount of micro-USD: round_half_up(micro * fx / 10^4). */
export function usdToBdtMinor(usdMicro: bigint, fxRate: string): Minor {
  if (typeof usdMicro !== "bigint") {
    throw new TypeError("usdToBdtMinor: usdMicro must be a bigint of micro-USD, never a number");
  }
  if (usdMicro < 0n) {
    const message = "usdMicro must not be negative";
    throw new PricingInputError(message, [{ path: "usdMicro", message }]);
  }
  checkRate(fxRate);
  return toMinor(new D(usdMicro.toString()).times(new D(fxRate)).div(10000));
}

/** Plain decimal text of micro-USD: at least 2 decimals, at most 6, no further trailing zeros. */
export function usdMicroText(usdMicro: bigint): string {
  if (typeof usdMicro !== "bigint") {
    throw new TypeError("usdMicroText: usdMicro must be a bigint of micro-USD, never a number");
  }
  if (usdMicro < 0n) throw new RangeError("usdMicroText: a negative amount has no price text");
  const whole = usdMicro / 1_000_000n;
  let fraction = (usdMicro % 1_000_000n).toString().padStart(6, "0");
  while (fraction.length > 2 && fraction.endsWith("0")) fraction = fraction.slice(0, -1);
  return `${whole}.${fraction}`;
}

export interface CustomerUsd {
  /** Whole micro-USD. */
  micro: bigint;
  /** The same amount as plain decimal text, 2 to 6 decimals. */
  text: string;
}

/**
 * The customer price in dollars for an engine total in paisa at the rate that priced it. Tries 2, 3 ... 6
 * decimals (half-up) and keeps the first that converts back to exactly `totalMinor`. A rate of 10000 or
 * more (far outside any market policy) is refused: fail closed (R16).
 */
export function customerUsd(quote: { totalMinor: bigint; fxRate: string }): CustomerUsd {
  const { totalMinor, fxRate } = quote;
  if (typeof totalMinor !== "bigint") {
    throw new TypeError("customerUsd: totalMinor must be a bigint of paisa, never a number");
  }
  if (totalMinor < 0n) {
    const message = "totalMinor must not be negative";
    throw new PricingInputError(message, [{ path: "totalMinor", message }]);
  }
  checkRate(fxRate);
  if (!isPlainDecimal(MAX_INVERTIBLE_RATE) || new D(fxRate).gte(new D(MAX_INVERTIBLE_RATE))) {
    const message = "fxRate is too large to be inverted exactly";
    throw new PricingInputError(message, [{ path: "fxRate", message }]);
  }
  const total = new D(totalMinor.toString());
  const rate = new D(fxRate);
  for (let places = 2; places <= 6; places += 1) {
    // dollars at `places` decimals, as a whole count of 10^-places: total / (100 * fx) * 10^places
    const units = BigInt(
      total
        .times(new D(10).pow(places - 2))
        .div(rate)
        .round(0, D.roundHalfUp)
        .toFixed(0),
    );
    const micro = units * 10n ** BigInt(6 - places);
    if (usdToBdtMinor(micro, fxRate) === totalMinor) return { micro, text: usdMicroText(micro) };
  }
  // Not reachable for a rate below 10000 (one paisa is wider than one micro-USD); never guess.
  throw new PricingInputError("no exact dollar amount", [
    { path: "totalMinor", message: "no exact dollar amount" },
  ]);
}
