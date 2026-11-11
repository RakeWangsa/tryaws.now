import { seedLaunchData } from "@tc/db";
import { ensureMarket, useTempDatabase } from "@tc/db/testing";
import { beforeAll, expect, it } from "vitest";
import { asOwner, asRole, clockAt } from "../test/rates-support";
import { priceCatalog, type CatalogRowForPricing } from "./catalog-prices";

// Needs the local PostgreSQL (pnpm db:up), like rates/in-force.test.ts.
const t = useTempDatabase();
const T0 = "2026-11-11T06:00:00.000Z";
const row = (over: Partial<CatalogRowForPricing> = {}): CatalogRowForPricing => ({
  id: "00000000-0000-4000-8000-000000000001",
  family: "linux_instance",
  awsId: "nano_3_0",
  platform: "linux",
  region: "ap-southeast-1",
  specs: { vcpus: 2 },
  awsPriceUsd: "5.0000",
  billingUnit: "month",
  featureFlag: "linux_instance",
  active: true,
  ...over,
});

beforeAll(async () => {
  await asOwner(t, (tx) => seedLaunchData(tx, { environment: "staging", at: new Date(T0) }));
  await ensureMarket(t.pool, "KE");
});

it("prices rows of two families with one instant and the seeded rate", async () => {
  const r = await asRole(t, "web_rw", (tx) =>
    priceCatalog(
      tx,
      [row(), row({ id: "00000000-0000-4000-8000-000000000002", family: "windows_instance" })],
      { market: "BD" },
      clockAt(T0),
    ),
  );
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.value.map((x) => x.priceBdt.totalMinor)).toEqual([74295n, 74295n]);
  expect(r.value[0]!.priceBdt.fxRate).toBe("127");
});

it("reads the clock once for the whole call", async () => {
  let reads = 0;
  const counting = {
    now: () => {
      reads += 1;
      return new Date(T0);
    },
  };
  await asRole(t, "web_rw", (tx) =>
    priceCatalog(
      tx,
      [row(), row({ family: "windows_instance", id: "00000000-0000-4000-8000-000000000003" })],
      { market: "BD" },
      counting,
    ),
  );
  expect(reads).toBe(1);
});

it("a market with no rate in force answers not_found and prices nothing", async () => {
  const r = await asRole(t, "web_rw", (tx) =>
    priceCatalog(tx, [row()], { market: "KE" }, clockAt(T0)),
  );
  expect(r).toMatchObject({ ok: false, error: "not_found" });
});

it("leaves inactive rows out by default", async () => {
  const rows = [row(), row({ id: "00000000-0000-4000-8000-000000000002", active: false })];
  const r = await asRole(t, "web_rw", (tx) =>
    priceCatalog(tx, rows, { market: "BD" }, clockAt(T0)),
  );
  expect(r.ok && r.value).toHaveLength(1);
  const all = await asRole(t, "web_rw", (tx) =>
    priceCatalog(tx, rows, { market: "BD", includeInactive: true }, clockAt(T0)),
  );
  expect(all.ok && all.value).toHaveLength(2);
});
