-- WPU-Z19 (verify review 2026-11-13, packages/aws/adapters/disk.ts:42): the largest Lightsail block storage disk is
-- 16,000 GB, not 16,384. The Lightsail quotas page (https://docs.aws.amazon.com/general/latest/gr/lightsail.html,
-- read 2026-11-14) gives "Maximum block storage disk space ... 16,000 Gigabytes" per disk and a minimum of 8 GB, in
-- each supported Region. Migrations 0008 and 0009 seeded maxGb 16384 in the `disk` anchor rows; they are not edited
-- (forward-only). Only a value above 16000 is lowered, so a row an admin set lower stays as it is. Idempotent.
UPDATE catalog_products
SET specs = jsonb_set(specs, '{maxGb}', '16000'::jsonb)
WHERE family = 'disk'
  AND aws_id = 'block-storage-gb'
  AND jsonb_typeof(specs->'maxGb') = 'number'
  AND (specs->>'maxGb')::numeric > 16000;
