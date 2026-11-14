import { launchSeedInputFor } from "@tc/db";
import { runMigrations } from "@tc/db/migrate";
import { createTempDatabase, type TempDatabase } from "@tc/db/testing";
import { afterEach, expect, it } from "vitest";
import { seedLaunchAsOwner } from "./launch-seed";

// WPU-X6 on a real database: what the migrator does on a brand-new stage (staging deploy of 2026-11-14 found a
// database with no market): the migrations, then the launch seed of the stage, as the owner of the tables.
// Each test gets its own fresh database; the test user owns every table, as the master user does in RDS.
const AT = new Date("2026-11-14T06:00:00.000Z");
const LATER = new Date("2026-11-15T06:00:00.000Z");
let temp: TempDatabase | undefined;
afterEach(async () => {
  await temp?.drop();
  temp = undefined;
});

const fresh = async () => {
  temp = await createTempDatabase({ migrate: false });
  await runMigrations(temp.url);
  return temp;
};

const rows = async (db: TempDatabase, sql: string) => (await db.pool.query(sql)).rows;
const count = async (db: TempDatabase, table: string) =>
  Number((await rows(db, `select count(*)::int as n from ${table}`))[0].n);

// Everything the seed writes, to prove that a second run changes nothing.
const snapshot = async (db: TempDatabase) => ({
  markets: await rows(db, "select * from markets order by code"),
  fx: await rows(db, "select * from fx_rates order by id"),
  rules: await rows(db, "select * from pricing_rules order by id"),
  flags: await rows(db, "select * from feature_flags order by key"),
  settings: await rows(db, "select * from settings order by key"),
  audit: await count(db, "audit_log"),
});

const adjustmentLimit = async (db: TempDatabase) =>
  rows(
    db,
    "select value from settings where key = 'wallet.adjustment_limit_minor' and market = 'BD' and scope = 'market'",
  );

it("production: market BD with the decided limits, every flag off, no FX rate, the rule and the adjustment limit", async () => {
  const db = await fresh();
  expect(await count(db, "markets")).toBe(0); // migration 0029 found no market: it wrote nothing

  const result = await seedLaunchAsOwner(db.url, launchSeedInputFor("production", AT));
  expect(result.market).toBe(true);
  expect(result.fxRate).toBe(false);
  expect(result.pricingRule).toBe(true);
  expect(result.flagsAdded).toHaveLength(12);

  expect(
    await rows(
      db,
      "select code, currency, topup_min_minor::text as min, topup_max_minor::text as max, quick_amounts, active from markets",
    ),
  ).toEqual([
    { code: "BD", currency: "BDT", min: "10000", max: "5000000", quick_amounts: [], active: true },
  ]);
  expect(await count(db, "fx_rates")).toBe(0);
  const flags = await rows(db, "select key, enabled from feature_flags where market = 'BD'");
  expect(flags).toHaveLength(12);
  expect(flags.filter((f) => f.enabled === true)).toEqual([]);
  expect(await count(db, "pricing_rules")).toBe(1);
  expect(await adjustmentLimit(db)).toEqual([{ value: "1000000" }]);
  // the one system audit row of the adjustment limit (WPU-X5)
  expect(
    await rows(
      db,
      "select actor_type, action, target_id from audit_log where target_id = 'BD:wallet.adjustment_limit_minor'",
    ),
  ).toEqual([
    { actor_type: "system", action: "setting.set", target_id: "BD:wallet.adjustment_limit_minor" },
  ]);
});

it("staging: market BD, the test FX rate and the four staging flags on; the adjustment limit too", async () => {
  const db = await fresh();
  const result = await seedLaunchAsOwner(db.url, launchSeedInputFor("staging", AT));
  expect(result).toMatchObject({ market: true, fxRate: true, pricingRule: true });

  expect(await rows(db, "select rate::text as rate from fx_rates where market = 'BD'")).toEqual([
    { rate: expect.stringMatching(/^127(\.0+)?$/) as unknown as string },
  ]);
  const on = await rows(
    db,
    "select key from feature_flags where market = 'BD' and enabled order by key",
  );
  expect(on.map((r) => r.key)).toEqual(["backup", "disk", "linux_instance", "static_ip"]);
  expect(await count(db, "feature_flags")).toBe(12);
  expect(await adjustmentLimit(db)).toEqual([{ value: "1000000" }]);
});

it("a second deploy writes nothing (R7): every row and the audit count stay as they were", async () => {
  for (const stage of ["production", "staging"]) {
    const db = await fresh();
    await seedLaunchAsOwner(db.url, launchSeedInputFor(stage, AT));
    const before = await snapshot(db);
    const again = await seedLaunchAsOwner(db.url, launchSeedInputFor(stage, LATER));
    expect(again, stage).toEqual({
      market: false,
      fxRate: false,
      pricingRule: false,
      flagsAdded: [],
    });
    expect(await snapshot(db), stage).toEqual(before);
    await db.drop();
    temp = undefined;
  }
});
