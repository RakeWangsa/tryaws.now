import { CONFIG_PRICE_TEXT, isConfigPriceKey, type ConfigPriceKey, type Tx } from "@tc/db";
import { PricingInputError, problemFields, quoteWithBook } from "../pricing/index";
import type { Clock, Minor, Result } from "../types";
import { pricingInForce } from "./in-force";
import type { BookedFigures } from "./preview-book";

/**
 * The product family whose pricing rule and price book apply to each config price. The block storage
 * price belongs to the disk family, the snapshot price to backups; the load balancer and the hosted zone
 * have a family of their own.
 */
export const CONFIG_PRICE_FAMILY: Readonly<Record<ConfigPriceKey, string>> = Object.freeze({
  "config_price.block_storage_gb_month": "disk",
  "config_price.snapshot_gb_month": "backup",
  "config_price.load_balancer_month": "load_balancer",
  "config_price.dns_zone_month": "dns_zone",
});

export interface ConfigPricePreview {
  fxRate: string;
  /** One billing unit (a GB-month or a month) priced under the price in force; null when none is stored. */
  current: BookedFigures | null;
  /** The same unit under the candidate price. */
  candidate: BookedFigures;
  /** Candidate total minus current total; null without a current price. */
  deltaMinor: Minor | null;
}

const figures = (b: ReturnType<typeof quoteWithBook>): BookedFigures => ({
  baseMinor: b.quote.baseMinor,
  marginMinor: b.marginMinor,
  commissionMinor: b.commissionMinor,
  totalMinor: b.quote.totalMinor,
});

/**
 * The live preview of a config price (WPU-G10): one billing unit priced by the engine
 * (`quoteWithBook`, the function that prices an order) under the price in force (`current`) and under
 * the candidate, with the rate, the rule and the margin of the same instant. It computes nothing of its
 * own and writes nothing. No rate or rule in force, and nothing is priced (R16). A change reaches new
 * orders only; an order already placed keeps its stored snapshot.
 */
export async function previewConfigPrice(
  tx: Tx,
  input: { market: string; key: string; usd: string; current?: string },
  clock: Clock,
): Promise<Result<ConfigPricePreview>> {
  const { market, key, usd, current } = input;
  const fields: Record<string, string> = {};
  if (!isConfigPriceKey(key)) fields.key = "unknown";
  if (typeof usd !== "string" || !CONFIG_PRICE_TEXT.test(usd) || !/[1-9]/.test(usd)) {
    fields.usd = "invalid";
  }
  if (current !== undefined && !(typeof current === "string" && CONFIG_PRICE_TEXT.test(current))) {
    fields.current = "invalid";
  }
  if (Object.keys(fields).length > 0 || !isConfigPriceKey(key)) {
    return { ok: false, error: "validation", fields };
  }
  const found = await pricingInForce(
    tx,
    { market, productFamily: CONFIG_PRICE_FAMILY[key] },
    clock,
  );
  if (!found.ok) return found;
  const { fx, rule, book } = found.value;
  try {
    const price = (awsPriceUsd: string) =>
      figures(quoteWithBook({ awsPriceUsd, fxRate: fx.rate, rule: rule.value }, book));
    const now = current === undefined || !/[1-9]/.test(current) ? null : price(current);
    const candidate = price(usd);
    return {
      ok: true,
      value: {
        fxRate: fx.rate,
        current: now,
        candidate,
        deltaMinor: now === null ? null : candidate.totalMinor - now.totalMinor,
      },
    };
  } catch (error) {
    if (error instanceof PricingInputError) {
      return { ok: false, error: "validation", fields: problemFields(error.problems) };
    }
    throw error;
  }
}
