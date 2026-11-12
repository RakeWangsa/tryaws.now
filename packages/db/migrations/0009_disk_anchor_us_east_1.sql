-- WPU-G1 (P9): the `disk` anchor of the catalog for the third launch Region, us-east-1. Migration 0008
-- seeded ap-southeast-1 and ap-south-1 only, so a disk order in us-east-1 found no anchor row and was
-- refused. Same shape and price as 0008, same feature flag `disk` (off in production, R12). The
-- catalog sync never writes the family `disk`. Forward-only: 0008 is not edited. Idempotent.
-- VERIFY the price of one GB-month of Lightsail block storage in us-east-1 against the AWS pricing
-- page before the production seed; a later migration changes it.
INSERT INTO catalog_products (id, family, aws_id, platform, region, specs, aws_price_usd, billing_unit, feature_flag, active, synced_at)
VALUES
  (gen_random_uuid(), 'disk', 'block-storage-gb', NULL, 'us-east-1', '{"unit":"gb","minGb":8,"maxGb":16384}'::jsonb, 0.1000, 'gb_month', 'disk', true, now())
ON CONFLICT (family, aws_id, region) DO NOTHING;
