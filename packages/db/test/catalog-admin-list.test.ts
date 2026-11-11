import { sql } from "drizzle-orm";
import { expect, it } from "vitest";
import type { Tx } from "../client";
import { listCatalogProductsForAdmin } from "../repositories/catalog";
import { runTransaction, type DatabaseRole } from "../tx";
import { insertRow } from "./sql";
import { useTempDatabase } from "./temp-db";

// WP8-T4: the catalog screen of the admin shows every synced row, inactive ones too, read-only.
const t = useTempDatabase();
const as = <T>(role: DatabaseRole, fn: (tx: Tx) => Promise<T>) =>
  runTransaction(t.db, fn, { role });

async function seed(over: Record<string, unknown> = {}): Promise<string> {
  return insertRow(t.pool, "catalog_products", {
    family: "linux_instance",
    aws_id: "nano_3_0",
    platform: "linux",
    region: "ap-south-1",
    specs: JSON.stringify({ vcpus: 2 }),
    aws_price_usd: "5",
    billing_unit: "month",
    feature_flag: "linux_instance",
    active: true,
    synced_at: "2026-11-11T00:00:00Z",
    ...over,
  });
}

it("lists active and inactive rows with the price as text and the time of the sync, as admin_rw", async () => {
  const a = await seed({ aws_id: "nano_3_0" });
  const b = await seed({ aws_id: "old_3_0", active: false, synced_at: "2026-11-10T00:00:00Z" });
  const rows = await as("admin_rw", (tx) => listCatalogProductsForAdmin(tx, {}));
  expect(rows.map((r) => r.id).sort()).toEqual([a, b].sort());
  const old = rows.find((r) => r.id === b);
  expect(old).toMatchObject({
    active: false,
    awsPriceUsd: "5.0000",
    featureFlag: "linux_instance",
  });
  expect(old?.syncedAt).toEqual(new Date("2026-11-10T00:00:00Z"));
});

it("filters by family and orders by family, Region and price", async () => {
  await seed({ family: "linux_instance", aws_id: "large_9_0", aws_price_usd: "40" });
  await seed({ family: "linux_instance", aws_id: "micro_9_0", aws_price_usd: "6" });
  await seed({ family: "database", aws_id: "db_small", feature_flag: "database" });
  const mine = ["db_small", "micro_9_0", "large_9_0"];
  const all = await as("admin_rw", (tx) => listCatalogProductsForAdmin(tx, {}));
  expect(all.map((r) => r.awsId).filter((id) => mine.includes(id))).toEqual(mine);
  const one = await as("admin_rw", (tx) => listCatalogProductsForAdmin(tx, { family: "database" }));
  expect(one.map((r) => r.awsId)).toEqual(["db_small"]);
});

it("refuses a family that is not a family name, before any query", async () => {
  await expect(
    as("admin_rw", (tx) => listCatalogProductsForAdmin(tx, { family: "x'; drop table t;--" })),
  ).rejects.toBeInstanceOf(TypeError);
});

it("the admin role cannot change a catalog row (the sync owns the facts and `active`)", async () => {
  const id = await seed({ aws_id: "locked_9_0" });
  await expect(
    as("admin_rw", (tx) =>
      tx.execute(sql`update catalog_products set active = false where id = ${id}`),
    ),
  ).rejects.toThrow();
});
