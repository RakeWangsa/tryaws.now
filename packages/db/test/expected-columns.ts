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
  customers: [
    "cognito_sub text NOT NULL",
    "sessions_valid_after timestamptz NULL",
    "email text NOT NULL",
    "phone text NULL",
    "phone_verified_at timestamptz NULL",
    "name text NULL",
    "type text NULL",
    "kyc_status text NOT NULL",
    "risk_tier text NOT NULL",
    "market text NOT NULL",
    "locale text NOT NULL",
    "status text NOT NULL",
  ],
  kyc_submissions: [
    "customer_id uuid NOT NULL",
    "document_type text NOT NULL",
    "document_number_encrypted bytea NOT NULL",
    "s3_keys _text NOT NULL",
    "status text NOT NULL",
    "reviewer_id uuid NULL",
    "reviewed_at timestamptz NULL",
    "note text NULL",
  ],
  ssh_keys: [
    "customer_id uuid NOT NULL",
    "name text NOT NULL",
    "public_key text NOT NULL",
    "fingerprint text NOT NULL",
  ],
  otp_challenges: [
    "customer_id uuid NOT NULL",
    "phone text NOT NULL",
    "code_hash text NOT NULL",
    "expires_at timestamptz NOT NULL",
    "attempts int4 NOT NULL",
    "consumed_at timestamptz NULL",
  ],
  rate_limits: [
    "scope_key text NOT NULL",
    "window_start timestamptz NOT NULL",
    "count int4 NOT NULL",
  ],
  legal_acceptances: [
    "customer_id uuid NOT NULL",
    "document text NOT NULL",
    "version text NOT NULL",
    "accepted_at timestamptz NOT NULL",
    "ip inet NOT NULL",
  ],
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
