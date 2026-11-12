import { readConfigPrices } from "@tc/db";
import type { Tx } from "@tc/db";
import { isPositiveDecimal } from "../pricing/decimal";
import type { MeteredUnitPrice } from "../pricing/metering";
import { quoteInForce } from "../rates/in-force";
import type { Clock, Result } from "../types";

// WPU-M1. The price of a static IP that is not attached to a server. Amazon Lightsail does not charge
// for an attached static IP and charges USD 0.005 per hour for one that has not been attached for more
// than one hour (owner decision 2026-11-12). Like the snapshot (WPU-G9) it has no price API: the price
// is the config row `config_price.static_ip_unattached_hour`, decimal text all the way to the pricing
// engine (R4), converted with the FX rate and the rule of the family `static_ip` in force, half-up. No
// usable row, rate or rule, and nothing is priced (R16).

export const STATIC_IP_PRICE_FAMILY = "static_ip";
export const STATIC_IP_PRICE_KEY = "config_price.static_ip_unattached_hour";

export interface StaticIpPrice {
  readonly unit: "hour";
  /** The customer price of one hour, in paisa. */
  readonly perHourMinor: bigint;
  /** The same price as the engine quoted it: base and steps, adding up to `perHourMinor` (WPU-M2). */
  readonly breakdown: MeteredUnitPrice;
}

export async function staticIpHourPrice(
  tx: Tx,
  market: string,
  clock: Clock,
): Promise<Result<StaticIpPrice>> {
  const row = (await readConfigPrices(tx, market, clock.now()))[STATIC_IP_PRICE_KEY];
  // A zero or unreadable price is no price (WPU-M2, R16): nothing is charged.
  if (row === undefined || row.unit !== "hour" || !isPositiveDecimal(row.usd)) {
    return { ok: false, error: "not_found", fields: { price: "unavailable" } };
  }
  const one = await quoteInForce(
    tx,
    { market, productFamily: STATIC_IP_PRICE_FAMILY, awsPriceUsd: row.usd, quantity: "1" },
    clock,
  );
  if (!one.ok) return one;
  const quote = one.value.quote;
  return {
    ok: true,
    value: {
      unit: "hour",
      perHourMinor: quote.totalMinor,
      breakdown: { totalMinor: quote.totalMinor, baseMinor: quote.baseMinor, steps: quote.steps },
    },
  };
}
