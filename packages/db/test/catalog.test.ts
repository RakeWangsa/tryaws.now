import { expect, it } from "vitest";
import { markets } from "../schema/index";
import { useTempDatabase } from "./temp-db";
import { expectSqlError, insertRow } from "./sql";
import { ensureMarket, newAdmin } from "./fixtures";
import { columnTests } from "./expected-columns";

const t = useTempDatabase();
columnTests(
  () => t.pool,
  [
    "markets",
    "fx_rates",
    "pricing_rules",
    "catalog_products",
    "tlds",
    "feature_flags",
    "settings",
    "admin_users",
  ],
);

it("Drizzle inserts get a UUID v7 id, the defaults and bigint money", async () => {
  const [m] = await t.db
    .insert(markets)
    .values({
      code: "NP",
      currency: "NPR",
      gateway: "eps",
      locales: ["en"],
      numerals: "latn",
      topupMinMinor: 10000n,
      topupMaxMinor: 5000000n,
    })
    .returning();
  expect(m!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(m!.active).toBe(false);
  expect(m!.quickAmounts).toEqual([]);
  expect(m!.topupMinMinor).toBe(10000n);
  expect(m!.createdAt).toBeInstanceOf(Date);
});

const market = (over: Record<string, unknown>) => ({
  code: "IN",
  currency: "INR",
  gateway: "eps",
  locales: "{en}",
  numerals: "latn",
  topup_min_minor: 100,
  topup_max_minor: 1000,
  ...over,
});
it.each<[string, Record<string, unknown>, string]>([
  ["a lowercase code", { code: "bd" }, "markets_code_check"],
  ["a maximum below the minimum", { topup_max_minor: 99 }, "markets_topup_range_check"],
  ["a minimum of 0", { topup_min_minor: 0 }, "markets_topup_min_minor_check"],
  ["unknown numerals", { numerals: "arab" }, "markets_numerals_check"],
  [
    "quick amounts that are not a list",
    { quick_amounts: '{"a":1}' },
    "markets_quick_amounts_check",
  ],
])("markets refuses %s", async (_, over, constraint) => {
  await expectSqlError(insertRow(t.pool, "markets", market(over)), "23514", { constraint });
});

it("fx_rates keeps the rate exactly and refuses 0", async () => {
  await ensureMarket(t.pool);
  const id = await insertRow(t.pool, "fx_rates", {
    market: "BD",
    rate: "124.77",
    effective_from: "2026-11-11T00:00:00Z",
  });
  const { rows } = await t.pool.query("select rate, set_by from fx_rates where id = $1", [id]);
  expect(rows[0]).toEqual({ rate: "124.770000", set_by: null });
  await expectSqlError(
    insertRow(t.pool, "fx_rates", {
      market: "BD",
      rate: "0",
      effective_from: "2026-11-12T00:00:00Z",
    }),
    "23514",
    { constraint: "fx_rates_rate_check" },
  );
  await expectSqlError(
    insertRow(t.pool, "fx_rates", {
      market: "XX",
      rate: "1",
      effective_from: "2026-11-12T00:00:00Z",
    }),
    "23503",
  );
});

it("pricing_rules wants a list of steps and one rule per market, family and start", async () => {
  await ensureMarket(t.pool);
  const at = "2026-11-11T00:00:00Z";
  await insertRow(t.pool, "pricing_rules", { market: "BD", steps: "[]", effective_from: at });
  await expectSqlError(
    insertRow(t.pool, "pricing_rules", { market: "BD", steps: "[]", effective_from: at }),
    "23505",
    { constraint: "pricing_rules_market_product_family_effective_from_unique" },
  );
  await expectSqlError(
    insertRow(t.pool, "pricing_rules", {
      market: "BD",
      steps: "{}",
      effective_from: "2026-11-13T00:00:00Z",
    }),
    "23514",
    { constraint: "pricing_rules_steps_check" },
  );
});

it("catalog_products keeps 4 decimals and is unique per family, AWS id and Region", async () => {
  const row = {
    family: "linux_instance",
    aws_id: "nano_3_0",
    region: "ap-southeast-1",
    aws_price_usd: "9.5",
    billing_unit: "month",
    feature_flag: "linux_instance",
    synced_at: "2026-11-11T00:00:00Z",
  };
  const id = await insertRow(t.pool, "catalog_products", row);
  const { rows } = await t.pool.query(
    "select aws_price_usd, active, specs from catalog_products where id = $1",
    [id],
  );
  expect(rows[0]).toEqual({ aws_price_usd: "9.5000", active: false, specs: {} });
  await expectSqlError(insertRow(t.pool, "catalog_products", row), "23505", {
    constraint: "catalog_products_family_aws_id_region_unique",
  });
});

it("tlds is unique per TLD and refuses a leading dot or a character in place of the dot", async () => {
  await insertRow(t.pool, "tlds", { tld: "com.bd", synced_at: "2026-11-11T00:00:00Z" });
  await expectSqlError(
    insertRow(t.pool, "tlds", { tld: "com.bd", synced_at: "2026-11-11T00:00:00Z" }),
    "23505",
    { constraint: "tlds_tld_unique" },
  );
  await expectSqlError(
    insertRow(t.pool, "tlds", { tld: ".com", synced_at: "2026-11-11T00:00:00Z" }),
    "23514",
    { constraint: "tlds_tld_check" },
  );
  // passes only if the database got `\.` (a literal dot), not `.` (any character)
  await expectSqlError(
    insertRow(t.pool, "tlds", { tld: "com_bd", synced_at: "2026-11-11T00:00:00Z" }),
    "23514",
    { constraint: "tlds_tld_check" },
  );
});

it("feature_flags default to off and are unique per key and market", async () => {
  await ensureMarket(t.pool);
  const id = await insertRow(t.pool, "feature_flags", { key: "windows_instance", market: "BD" });
  const { rows } = await t.pool.query("select enabled from feature_flags where id = $1", [id]);
  expect(rows[0].enabled).toBe(false);
  await expectSqlError(
    insertRow(t.pool, "feature_flags", { key: "windows_instance", market: "BD" }),
    "23505",
    { constraint: "feature_flags_key_market_unique" },
  );
});

it("settings are unique per key, market, scope and scope id, NULL included", async () => {
  await ensureMarket(t.pool);
  const base = {
    key: "adjustment_approval_limit_minor",
    market: "BD",
    scope: "market",
    value: "500000",
  };
  await insertRow(t.pool, "settings", base);
  await expectSqlError(insertRow(t.pool, "settings", base), "23505", {
    constraint: "settings_key_market_scope_scope_id_unique",
  });
  await expectSqlError(insertRow(t.pool, "settings", { ...base, scope_id: "x" }), "23514", {
    constraint: "settings_scope_id_check",
  });
  await expectSqlError(insertRow(t.pool, "settings", { ...base, scope: "tier" }), "23514", {
    constraint: "settings_scope_id_check",
  });
  await expectSqlError(
    insertRow(t.pool, "settings", { ...base, scope: "region", scope_id: "x" }),
    "23514",
    { constraint: "settings_scope_check" },
  );
  await insertRow(t.pool, "settings", { ...base, scope: "tier", scope_id: "new" });
  await insertRow(t.pool, "settings", { ...base, scope: "tier", scope_id: "trusted" });
});

it("admin_users take the four roles of 6.2 and start active", async () => {
  const id = await newAdmin(t.pool, "superadmin");
  const { rows } = await t.pool.query("select status from admin_users where id = $1", [id]);
  expect(rows[0].status).toBe("active");
  await expectSqlError(newAdmin(t.pool, "root"), "23514", {
    constraint: "admin_users_role_check",
  });
});
