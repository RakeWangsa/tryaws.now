-- WPU-G9: the default price of a stored snapshot. Amazon Lightsail bills manual and automatic snapshots
-- (instance, disk and database) at USD 0.05 per GB-month of stored size. Owner instruction 2026-11-12;
-- it matches the AWS documentation. The row is the same `config_price.snapshot_gb_month` that the
-- staging seed uses, so a value an admin edited is never changed (DO NOTHING). Where the market row
-- does not exist yet (a fresh database: the launch seed runs after the migrations) the launch seed adds
-- the same row. Forward-only; the number 0013 belongs to another task.
INSERT INTO settings (id, key, market, scope, scope_id, value, created_at)
SELECT gen_random_uuid(), 'config_price.snapshot_gb_month', m.code, 'market', NULL, '{"usd":"0.05","unit":"gb_month"}'::jsonb, now()
FROM markets m
WHERE m.code = 'BD'
ON CONFLICT ON CONSTRAINT settings_key_market_scope_scope_id_unique DO NOTHING;
