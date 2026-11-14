import { and, eq, isNull, sql } from "drizzle-orm";
import type { Tx } from "../client";
import { FEATURE_FLAG_KEYS, type FeatureFlagKey } from "../repositories/config/feature-flags";
import { requireInstant } from "../repositories/config/args";
import { priceBookValueOf } from "../repositories/config/price-book";
import { seedConfigPrices } from "./config-prices";
import type { MARKET_NUMERALS } from "../schema/index";
import { featureFlags, fxRates, markets, pricingRules, settings } from "../schema/index";

export type SeedEnvironment = "staging" | "production";

// The part of a market row that the owner has not decided: section 17 leaves the EPS limits to the
// owner, and what `active` gates is for WP3-T4 and WP9 to define.
export interface MarketLimits {
  topupMinMinor: bigint;
  topupMaxMinor: bigint;
  quickAmounts: readonly number[];
  active: boolean;
}

export interface MarketSeed extends MarketLimits {
  code: string;
  currency: string;
  gateway: string;
  locales: readonly string[];
  numerals: (typeof MARKET_NUMERALS)[number];
}

// The limits are the test values of the fixtures; the staging seed uses them, production never
// guesses them (R16).
export const LAUNCH_MARKET: MarketSeed = Object.freeze({
  code: "BD",
  currency: "BDT",
  gateway: "eps",
  locales: Object.freeze(["bn", "en"]),
  numerals: "beng",
  topupMinMinor: 10_000n,
  topupMaxMinor: 5_000_000n,
  quickAmounts: Object.freeze([] as number[]),
  active: true,
});

// Section B.4, the test value; only the staging seed writes it.
export const LAUNCH_FX_RATE = "127";

export const LAUNCH_PRICING_STEPS: readonly {
  readonly code: string;
  readonly rate: string;
  readonly base: "aws";
  readonly label: { readonly bn: string; readonly en: string };
}[] = Object.freeze(
  [
    { code: "korea_vat", rate: "0.10", label: { bn: "কোরিয়ার VAT", en: "Korea VAT" } },
    { code: "bd_vat", rate: "0.05", label: { bn: "বাংলাদেশের VAT", en: "Bangladesh VAT" } },
    { code: "processing_fee", rate: "0.02", label: { bn: "প্রসেসিং ফি", en: "Processing fee" } },
    { code: "markup", rate: "0", label: { bn: "সার্ভিস চার্জ", en: "Service charge" } },
  ].map((s) =>
    Object.freeze({
      code: s.code,
      rate: s.rate,
      base: "aws" as const,
      label: Object.freeze(s.label),
    }),
  ),
);

// WPU-X5 (owner decision 2026-11-14): what one finance or superadmin may adjust per wallet per 24 hours
// without a second admin, in paisa as JSON text (the shape limitOf of repositories/admin/wallets.ts reads).
export const ADJUSTMENT_LIMIT_SEED = Object.freeze({
  key: "wallet.adjustment_limit_minor",
  valueMinor: "1000000",
  reason: "owner decision 2026-11-14: single-admin adjustment limit 10,000 BDT",
});

// The core of section 1.
export const STAGING_FLAGS_ON: readonly FeatureFlagKey[] = Object.freeze([
  "linux_instance",
  "static_ip",
  "backup",
  "disk",
] as const);

export interface SeedResult {
  market: boolean;
  fxRate: boolean;
  pricingRule: boolean;
  flagsAdded: string[];
}

// A stage is staging only when it is exactly on the list; every other name, a mis-spelt production
// stage included, is production (fail closed).
export function seedEnvironmentFor(
  stage: string,
  nonProductionStages: readonly string[],
): SeedEnvironment {
  return nonProductionStages.includes(stage) ? "staging" : "production";
}

const EMPTY = (): SeedResult => ({
  market: false,
  fxRate: false,
  pricingRule: false,
  flagsAdded: [],
});

// Inserts what is missing and changes nothing that exists. Run it as the table owner: no
// application role may write markets, and a Drizzle insert() names created_at.
export async function seedLaunchData(
  tx: Tx,
  input: { environment: SeedEnvironment; at: Date; market?: MarketLimits },
): Promise<SeedResult> {
  const { environment, at } = input;
  if (environment !== "staging" && environment !== "production") {
    throw new TypeError("seedLaunchData: environment must be staging or production");
  }
  requireInstant(at, "seedLaunchData: at");
  const staging = environment === "staging";
  const code = LAUNCH_MARKET.code;
  const result = EMPTY();

  const limits: MarketLimits | undefined = input.market ?? (staging ? LAUNCH_MARKET : undefined);
  if (limits) {
    const inserted = await tx
      .insert(markets)
      .values({
        code,
        currency: LAUNCH_MARKET.currency,
        gateway: LAUNCH_MARKET.gateway,
        locales: [...LAUNCH_MARKET.locales],
        numerals: LAUNCH_MARKET.numerals,
        topupMinMinor: limits.topupMinMinor,
        topupMaxMinor: limits.topupMaxMinor,
        quickAmounts: [...limits.quickAmounts],
        active: limits.active,
      })
      .onConflictDoNothing({ target: markets.code })
      .returning({ code: markets.code });
    result.market = inserted.length > 0;
  } else {
    // Production without the limits: the market row must already exist, else nothing is written.
    const existing = await tx
      .select({ code: markets.code })
      .from(markets)
      .where(eq(markets.code, code));
    if (existing.length === 0) return result;
  }

  if (staging) {
    const rates = await tx
      .select({ id: fxRates.id })
      .from(fxRates)
      .where(eq(fxRates.market, code))
      .limit(1);
    if (rates.length === 0) {
      await tx
        .insert(fxRates)
        .values({ market: code, rate: LAUNCH_FX_RATE, effectiveFrom: at, createdAt: at });
      result.fxRate = true;
    }
  }

  const rules = await tx
    .select({ id: pricingRules.id })
    .from(pricingRules)
    .where(and(eq(pricingRules.market, code), isNull(pricingRules.productFamily)))
    .limit(1);
  if (rules.length === 0) {
    await tx.insert(pricingRules).values({
      market: code,
      productFamily: null,
      steps: LAUNCH_PRICING_STEPS.map((s) => ({ ...s, label: { ...s.label } })),
      effectiveFrom: at,
    });
    result.pricingRule = true;
  }

  // WPU-G9: the default snapshot price, Amazon Lightsail's USD 0.05 per GB-month (owner instruction
  // 2026-11-12). Inserted only where missing, so an edited value stays.
  await seedConfigPrices(tx, {
    market: code,
    at,
    prices: [{ key: "config_price.snapshot_gb_month", usd: "0.05", unit: "gb_month" }],
  });
  // WPU-M1: Amazon Lightsail charges USD 0.005 per hour for a static IP that is not attached for more
  // than one hour (owner decision 2026-11-12). Same rule: only where missing.
  await seedConfigPrices(tx, {
    market: code,
    at,
    prices: [{ key: "config_price.static_ip_unattached_hour", usd: "0.005", unit: "hour" }],
  });

  // WPU-D3: the DNS zone. Base = AWS cost, USD 0.50 per hosted zone per month (Route 53 pricing), and the
  // owner's default margin of 15 percent on top (owner instruction 2026-11-12) as a normal dated entry of
  // the price book `price_book.dns_zone`, so /pricing/book shows it and an admin can change it (audited).
  // Both are inserted only where missing: an edited price or book is never overwritten.
  await seedConfigPrices(tx, {
    market: code,
    at,
    prices: [{ key: "config_price.dns_zone_month", usd: "0.50", unit: "month" }],
  });
  await tx
    .insert(settings)
    .values({
      key: "price_book.dns_zone",
      market: code,
      scope: "market",
      scopeId: null,
      value: priceBookValueOf([
        { from: at, margin: { kind: "percent", value: "0.15" }, commission: null, by: null },
      ]),
      setBy: null,
      createdAt: at,
    })
    .onConflictDoNothing();

  // WPU-X5: the single-admin adjustment limit, 10,000 BDT = 1,000,000 paisa per wallet per 24 hours (owner
  // decision 2026-11-14), the same row and system audit row as migration 0029 for a market created after the
  // migrations. Only where missing: a value an admin or a later process set is never overwritten.
  await tx.execute(
    sql`with inserted as (
          insert into settings (id, key, market, scope, scope_id, value, set_by, created_at)
          values (gen_random_uuid(), ${ADJUSTMENT_LIMIT_SEED.key}, ${code}, 'market', null,
                  ${JSON.stringify(ADJUSTMENT_LIMIT_SEED.valueMinor)}::jsonb, null, ${at.toISOString()}::timestamptz)
          on conflict on constraint settings_key_market_scope_scope_id_unique do nothing
          returning market, key, value
        )
        insert into audit_log (id, actor_type, actor_id, action, target_type, target_id, ip, user_agent, metadata)
        select gen_random_uuid(), 'system', null, 'setting.set', 'setting', i.market || ':' || i.key, null, null,
               jsonb_build_object('reason', ${ADJUSTMENT_LIMIT_SEED.reason}::text, 'before', null,
                                  'after', jsonb_build_object('value', i.value), 'source', 'launch seed')
        from inserted i`,
  );

  // R12: in production every flag is off.
  for (const key of FEATURE_FLAG_KEYS) {
    const added = await tx
      .insert(featureFlags)
      .values({ key, market: code, enabled: staging && STAGING_FLAGS_ON.includes(key) })
      .onConflictDoNothing({ target: [featureFlags.key, featureFlags.market] })
      .returning({ key: featureFlags.key });
    if (added.length > 0) result.flagsAdded.push(key);
  }
  return result;
}
