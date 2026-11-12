-- WPU-M1: the default price of a static IP that is not attached to a server. Amazon Lightsail does not
-- charge for a static IP while it is attached; it charges USD 0.005 per hour for one that is not attached
-- for more than one hour (owner decision 2026-11-12, matches the AWS documentation). The row is
-- `config_price.static_ip_unattached_hour`, edited in /pricing/config like the other config prices, so a
-- value an admin edited is never changed (DO NOTHING). Where the market row does not exist yet (a fresh
-- database: the launch seed runs after the migrations) the launch seed adds the same row. Forward-only.
INSERT INTO settings (id, key, market, scope, scope_id, value, created_at)
SELECT gen_random_uuid(), 'config_price.static_ip_unattached_hour', m.code, 'market', NULL, '{"usd":"0.005","unit":"hour"}'::jsonb, now()
FROM markets m
WHERE m.code = 'BD'
ON CONFLICT ON CONSTRAINT settings_key_market_scope_scope_id_unique DO NOTHING;
