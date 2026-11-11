import { expect, it } from "vitest";
import type { Tx } from "../client";
import { readCatalogProduct } from "../repositories/catalog";
import { runTransaction, type DatabaseRole } from "../tx";
import { insertRow } from "./sql";
import { useTempDatabase } from "./temp-db";

const t = useTempDatabase();
const as = <T>(role: DatabaseRole, fn: (tx: Tx) => Promise<T>) =>
  runTransaction(t.db, fn, { role });

async function seed(over: Record<string, unknown> = {}): Promise<string> {
  return insertRow(t.pool, "catalog_products", {
    family: "instance",
    aws_id: "small_3_0",
    platform: "linux",
    region: "ap-south-1",
    specs: JSON.stringify({ vcpus: 2 }),
    aws_price_usd: "3.5",
    billing_unit: "month",
    feature_flag: "linux_instance",
    active: true,
    synced_at: "2026-11-11T00:00:00Z",
    ...over,
  });
}

it("reads the row as web_rw with the numeric price as text", async () => {
  const id = await seed();
  const row = await as("web_rw", (tx) => readCatalogProduct(tx, id));
  expect(row).toEqual({
    id,
    family: "instance",
    awsId: "small_3_0",
    platform: "linux",
    region: "ap-south-1",
    specs: { vcpus: 2 },
    awsPriceUsd: "3.5000",
    billingUnit: "month",
    featureFlag: "linux_instance",
    active: true,
  });
});

it("gives null for an id that is not in the catalog", async () => {
  const row = await as("web_rw", (tx) =>
    readCatalogProduct(tx, "0190bbbb-0000-7000-8000-00000000ffff"),
  );
  expect(row).toBeNull();
});

it("throws a TypeError for an id that is not a UUID, before any query", async () => {
  for (const bad of ["", "nope", "0190bbbb-0000-7000-8000-00000000fff", "x'; drop table t;--"]) {
    await expect(as("web_rw", (tx) => readCatalogProduct(tx, bad))).rejects.toBeInstanceOf(
      TypeError,
    );
  }
});

it("reads an inactive product too; the caller decides what inactive means", async () => {
  const id = await seed({ aws_id: "large_3_0", active: false });
  const row = await as("web_rw", (tx) => readCatalogProduct(tx, id));
  expect(row?.active).toBe(false);
});
