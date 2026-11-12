import { readConfigPrices } from "@tc/db";
import type { Tx } from "@tc/db";
import { quoteInForce } from "../rates/in-force";
import type { Clock, Result } from "../types";

// WPU-G9. The price of a stored snapshot (instance, disk and database). Like the hosted zone of
// WPU-G6 it has no price API: the price is the config row `config_price.snapshot_gb_month`, Amazon
// Lightsail's USD 0.05 per GB-month of stored size by default (owner instruction 2026-11-12), text all
// the way to the pricing engine (R4). A market with no usable row sells nothing and the screen says
// "price unavailable" (R16). The price book family is `backup`.

export const SNAPSHOT_PRICE_FAMILY = "backup";

export interface SnapshotPrice {
  readonly unit: "gb_month";
  /** The customer price of one GB-month, in paisa. */
  readonly perGbMonthMinor: bigint;
  /** The customer price of `sizeGb` stored for a month, or null when the size is not known yet. */
  readonly monthlyMinor: bigint | null;
}

export async function snapshotPrice(
  tx: Tx,
  market: string,
  sizeGb: number | null,
  clock: Clock,
): Promise<Result<SnapshotPrice>> {
  if (sizeGb !== null && (!Number.isSafeInteger(sizeGb) || sizeGb < 0)) {
    return { ok: false, error: "validation", fields: { sizeGb: "invalid" } };
  }
  const row = (await readConfigPrices(tx, market))["config_price.snapshot_gb_month"];
  if (row === undefined || row.unit !== "gb_month") {
    return { ok: false, error: "not_found", fields: { price: "unavailable" } };
  }
  const one = await quoteInForce(
    tx,
    { market, productFamily: SNAPSHOT_PRICE_FAMILY, awsPriceUsd: row.usd, quantity: "1" },
    clock,
  );
  if (!one.ok) return one;
  let monthlyMinor: bigint | null = null;
  if (sizeGb !== null) {
    if (sizeGb === 0) {
      monthlyMinor = 0n;
    } else {
      const sized = await quoteInForce(
        tx,
        {
          market,
          productFamily: SNAPSHOT_PRICE_FAMILY,
          awsPriceUsd: row.usd,
          quantity: String(sizeGb),
        },
        clock,
      );
      if (!sized.ok) return sized;
      monthlyMinor = sized.value.quote.totalMinor;
    }
  }
  return {
    ok: true,
    value: { unit: "gb_month", perGbMonthMinor: one.value.quote.totalMinor, monthlyMinor },
  };
}
