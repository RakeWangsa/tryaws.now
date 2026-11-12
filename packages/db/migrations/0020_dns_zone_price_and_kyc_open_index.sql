-- WPU-D3. Forward-only.
--
-- (1) The base price of a DNS zone. Amazon Route 53 bills USD 0.50 per hosted zone per month
-- (VERIFY: AWS Route 53 pricing page; owner ruling 2026-11-12). The row is the config price
-- `config_price.dns_zone_month` of market BD, the legacy shape of the snapshot price of 0014
-- ({"usd","unit"}), decimal text. A value an admin edited is never changed (DO NOTHING). Where the market
-- row does not exist yet (a fresh database: the launch seed runs after the migrations) the launch seed
-- adds the same row. The dns_zone flag stays off by default (R12).
INSERT INTO settings (id, key, market, scope, scope_id, value, created_at)
SELECT gen_random_uuid(), 'config_price.dns_zone_month', m.code, 'market', NULL, '{"usd":"0.50","unit":"month"}'::jsonb, now()
FROM markets m
WHERE m.code = 'BD'
ON CONFLICT ON CONSTRAINT settings_key_market_scope_scope_id_unique DO NOTHING;
--> statement-breakpoint
-- (2) The default margin of the family dns_zone: 15 percent of the AWS cost (owner instruction
-- 2026-11-12; if wrong, only this price book row changes). A normal dated entry of the price book
-- (WPA-P1): it starts now, /pricing/book shows it and an admin can change it later, audited. Written only
-- when the market has no book for dns_zone, so an edited book is never overwritten. "0.15" is the
-- fraction of the percent kind.
INSERT INTO settings (id, key, market, scope, scope_id, value, created_at)
SELECT gen_random_uuid(), 'price_book.dns_zone', m.code, 'market', NULL,
  jsonb_build_object('v', 1, 'entries', jsonb_build_array(jsonb_build_object(
    'from', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'margin', jsonb_build_object('kind', 'percent', 'value', '0.15'),
    'commission', NULL,
    'by', NULL))),
  now()
FROM markets m
WHERE m.code = 'BD'
ON CONFLICT ON CONSTRAINT settings_key_market_scope_scope_id_unique DO NOTHING;
--> statement-breakpoint
-- (3) One open KYC submission per customer, enforced by the database. The advisory lock of the
-- repository is replaced by this index; a second pending submit hits it and the repository reads that
-- as a conflict or, for the same id, as a replay (R7).
CREATE UNIQUE INDEX "kyc_submissions_one_pending_idx" ON "kyc_submissions" USING btree ("customer_id") WHERE "kyc_submissions"."status" = 'pending';
