import { expect, it } from "vitest";
import { columnsOf, type Queryable } from "./sql";

export const EXPECTED_COLUMNS: Record<string, string[]> = {
  markets: [
    "code text NOT NULL",
    "currency text NOT NULL",
    "gateway text NOT NULL",
    "locales _text NOT NULL",
    "numerals text NOT NULL",
    "topup_min_minor int8 NOT NULL",
    "topup_max_minor int8 NOT NULL",
    "quick_amounts jsonb NOT NULL",
    "active bool NOT NULL",
  ],
  fx_rates: [
    "market text NOT NULL",
    "rate numeric(12,6) NOT NULL",
    "effective_from timestamptz NOT NULL",
    "set_by uuid NULL",
  ],
  pricing_rules: [
    "market text NOT NULL",
    "product_family text NULL",
    "steps jsonb NOT NULL",
    "effective_from timestamptz NOT NULL",
    "set_by uuid NULL",
  ],
  catalog_products: [
    "family text NOT NULL",
    "aws_id text NOT NULL",
    "platform text NULL",
    "region text NOT NULL",
    "specs jsonb NOT NULL",
    "aws_price_usd numeric(12,4) NOT NULL",
    "billing_unit text NOT NULL",
    "feature_flag text NOT NULL",
    "active bool NOT NULL",
    "synced_at timestamptz NOT NULL",
  ],
  tlds: [
    "tld text NOT NULL",
    "registration_price_usd numeric(12,4) NULL",
    "renewal_price_usd numeric(12,4) NULL",
    "transfer_price_usd numeric(12,4) NULL",
    "needs_extra_params bool NOT NULL",
    "synced_at timestamptz NOT NULL",
  ],
  feature_flags: ["key text NOT NULL", "market text NOT NULL", "enabled bool NOT NULL"],
  settings: [
    "key text NOT NULL",
    "market text NOT NULL",
    "scope text NOT NULL",
    "scope_id text NULL",
    "value jsonb NOT NULL",
    "set_by uuid NULL",
  ],
  admin_users: ["cognito_sub text NOT NULL", "role text NOT NULL", "status text NOT NULL"],
};

export function expectedFor(table: string): string[] {
  const own = EXPECTED_COLUMNS[table];
  if (own === undefined) throw new Error(`no expected columns for ${table}`);
  return [...own, "created_at timestamptz NOT NULL", "id uuid NOT NULL"].sort();
}

export function columnTests(getPool: () => Queryable, tables: readonly string[]): void {
  it.each(tables)("%s has exactly the columns of the plan", async (table) => {
    expect(await columnsOf(getPool(), table)).toEqual(expectedFor(table));
  });
}
