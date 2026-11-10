import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { adminUsers } from "./admins";
import { createdAt, id, money } from "./common";

export const markets = pgTable(
  "markets",
  {
    id: id(),
    code: text("code").notNull(),
    currency: text("currency").notNull(),
    gateway: text("gateway").notNull(),
    locales: text("locales").array().notNull(),
    numerals: text("numerals").notNull(),
    topupMinMinor: money("topup_min_minor").notNull(),
    topupMaxMinor: money("topup_max_minor").notNull(),
    quickAmounts: jsonb("quick_amounts").$type<number[]>().notNull().default([]),
    active: boolean("active").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    unique("markets_code_unique").on(t.code),
    check("markets_code_check", sql`${t.code} ~ '^[A-Z]{2}$'`),
    check("markets_currency_check", sql`${t.currency} ~ '^[A-Z]{3}$'`),
    check("markets_locales_check", sql`cardinality(${t.locales}) >= 1`),
    check("markets_numerals_check", sql`${t.numerals} in ('beng', 'latn')`),
    check("markets_topup_min_minor_check", sql`${t.topupMinMinor} > 0`),
    check("markets_topup_range_check", sql`${t.topupMaxMinor} >= ${t.topupMinMinor}`),
    check("markets_quick_amounts_check", sql`jsonb_typeof(${t.quickAmounts}) = 'array'`),
  ],
);

// (A) append-only
export const fxRates = pgTable(
  "fx_rates",
  {
    id: id(),
    market: text("market")
      .notNull()
      .references(() => markets.code),
    rate: numeric("rate", { precision: 12, scale: 6 }).notNull(),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
    setBy: uuid("set_by").references(() => adminUsers.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique("fx_rates_market_effective_from_unique").on(t.market, t.effectiveFrom),
    check("fx_rates_rate_check", sql`${t.rate} > 0`),
  ],
);

// (A) append-only. The rule version of PriceQuote.ruleVersion is the row id.
export const pricingRules = pgTable(
  "pricing_rules",
  {
    id: id(),
    market: text("market")
      .notNull()
      .references(() => markets.code),
    productFamily: text("product_family"),
    steps: jsonb("steps").$type<unknown[]>().notNull(),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
    setBy: uuid("set_by").references(() => adminUsers.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique("pricing_rules_market_product_family_effective_from_unique")
      .on(t.market, t.productFamily, t.effectiveFrom)
      .nullsNotDistinct(),
    check("pricing_rules_steps_check", sql`jsonb_typeof(${t.steps}) = 'array'`),
  ],
);

export const catalogProducts = pgTable(
  "catalog_products",
  {
    id: id(),
    family: text("family").notNull(),
    awsId: text("aws_id").notNull(),
    platform: text("platform"),
    region: text("region").notNull(),
    specs: jsonb("specs").$type<unknown>().notNull().default({}),
    awsPriceUsd: numeric("aws_price_usd", { precision: 12, scale: 4 }).notNull(),
    billingUnit: text("billing_unit").notNull(),
    featureFlag: text("feature_flag").notNull(),
    active: boolean("active").notNull().default(false),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("catalog_products_family_aws_id_region_unique").on(t.family, t.awsId, t.region),
    check("catalog_products_aws_price_usd_check", sql`${t.awsPriceUsd} >= 0`),
  ],
);

export const tlds = pgTable(
  "tlds",
  {
    id: id(),
    tld: text("tld").notNull(),
    registrationPriceUsd: numeric("registration_price_usd", { precision: 12, scale: 4 }),
    renewalPriceUsd: numeric("renewal_price_usd", { precision: 12, scale: 4 }),
    transferPriceUsd: numeric("transfer_price_usd", { precision: 12, scale: 4 }),
    needsExtraParams: boolean("needs_extra_params").notNull().default(false),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("tlds_tld_unique").on(t.tld),
    check("tlds_tld_check", sql`${t.tld} ~ '^[a-z0-9-]+(\\.[a-z0-9-]+)*$'`),
  ],
);

export const featureFlags = pgTable(
  "feature_flags",
  {
    id: id(),
    key: text("key").notNull(),
    market: text("market")
      .notNull()
      .references(() => markets.code),
    enabled: boolean("enabled").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [unique("feature_flags_key_market_unique").on(t.key, t.market)],
);

export const settings = pgTable(
  "settings",
  {
    id: id(),
    key: text("key").notNull(),
    market: text("market")
      .notNull()
      .references(() => markets.code),
    scope: text("scope").notNull(),
    scopeId: text("scope_id"),
    value: jsonb("value").$type<unknown>().notNull(),
    setBy: uuid("set_by").references(() => adminUsers.id),
    createdAt: createdAt(),
  },
  (t) => [
    unique("settings_key_market_scope_scope_id_unique")
      .on(t.key, t.market, t.scope, t.scopeId)
      .nullsNotDistinct(),
    check("settings_scope_check", sql`${t.scope} in ('market', 'tier', 'customer')`),
    check("settings_scope_id_check", sql`(${t.scope} = 'market') = (${t.scopeId} is null)`),
  ],
);
