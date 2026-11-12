-- WP5-T6c: the `disk` anchor of the catalog, one row per launch Region (ap-southeast-1, ap-south-1).
-- A disk is sold by the GB (16.10 Storage, addDisk): the row carries the AWS price of one GB-month of
-- Lightsail block storage and the order's size is the quantity, priced by the pricing engine. The row
-- is seeded here and the catalog sync never writes the family `disk`. It is on sale only behind the
-- feature flag `disk`, which is off in production (R12). VERIFY the price against the AWS pricing page
-- before the production seed; a later migration changes it.
INSERT INTO catalog_products (id, family, aws_id, platform, region, specs, aws_price_usd, billing_unit, feature_flag, active, synced_at)
VALUES
  (gen_random_uuid(), 'disk', 'block-storage-gb', NULL, 'ap-southeast-1', '{"unit":"gb","minGb":8,"maxGb":16384}'::jsonb, 0.1000, 'gb_month', 'disk', true, now()),
  (gen_random_uuid(), 'disk', 'block-storage-gb', NULL, 'ap-south-1', '{"unit":"gb","minGb":8,"maxGb":16384}'::jsonb, 0.1000, 'gb_month', 'disk', true, now())
ON CONFLICT (family, aws_id, region) DO NOTHING;
