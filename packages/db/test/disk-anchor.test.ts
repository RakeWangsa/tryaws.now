import { expect, it } from "vitest";
import { useTempDatabase } from "./temp-db";

// WP5-T6c seeded the `disk` anchor for two Regions; WPU-G1 (P9) adds us-east-1 (migration 0009).
const t = useTempDatabase();

it("has one active `disk` anchor row for each of the three launch Regions", async () => {
  const { rows } = await t.pool.query(
    `select region, aws_id, billing_unit, feature_flag, active, aws_price_usd::text as price, specs
       from catalog_products where family = 'disk' order by region`,
  );
  expect(rows.map((r: { region: string }) => r.region)).toEqual([
    "ap-south-1",
    "ap-southeast-1",
    "us-east-1",
  ]);
  for (const row of rows) {
    expect(row).toMatchObject({
      aws_id: "block-storage-gb",
      billing_unit: "gb_month",
      feature_flag: "disk",
      active: true,
    });
    expect(row.specs).toEqual({ unit: "gb", minGb: 8, maxGb: 16384 });
  }
});

it("the us-east-1 row has the same price as the other two (VERIFY against the AWS pricing page before production)", async () => {
  const { rows } = await t.pool.query(
    `select distinct aws_price_usd::text as price from catalog_products where family = 'disk'`,
  );
  expect(rows).toHaveLength(1);
});
