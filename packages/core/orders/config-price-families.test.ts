import { insertRow, uniqueSuffix, useTempDatabase } from "@tc/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { makeKit, placeOne, REGION, type Kit } from "../test/orders-kit";
import { quoteInForce } from "../rates/in-force";
import { createDraft } from "./draft";

// WPA-P2. The disk and the load balancer are priced from their catalog row, unless the market has a
// usable config price for the family (`config_price.block_storage_gb_month`, `config_price.load_balancer_month`):
// then the config row prices NEW orders. A row that is not in force yet or does not parse leaves the
// catalog price (it is not a price); a row that parses but cannot be a price sells nothing (R16). The
// quote is the engine's, with the FX in force (R4).
const t = useTempDatabase();
let kit: Kit;
let anchorId: string;
let serverId: string;

const dated = (unit: string, ...entries: [string, string][]) => ({
  v: 1,
  unit,
  entries: entries.map((e) => ({ from: e[0], usd: e[1], by: null })),
});

async function setConfig(key: string, value: unknown | null): Promise<void> {
  await t.pool.query("delete from settings where key = $1 and market = 'BD'", [key]);
  if (value === null) return;
  await t.pool.query(
    `insert into settings (id, key, market, scope, scope_id, value)
     values (gen_random_uuid(), $1, 'BD', 'market', null, $2::jsonb)`,
    [key, JSON.stringify(value)],
  );
}

beforeAll(async () => {
  kit = await makeKit(t, { riskTier: "trusted", balanceMinor: 50_000_000n });
  anchorId =
    (
      await t.pool.query<{ id: string }>(
        "select id from catalog_products where family = 'disk' and aws_id = 'block-storage-gb' and region = $1",
        [REGION],
      )
    ).rows[0]?.id ?? "";
  await insertRow(t.pool, "pool_capacity", {
    pool_account_id: kit.poolAccountId,
    region: REGION,
    quota_code: "disk_gb",
    quota_limit: 10_000,
    used: 0,
  });
  const placed = await placeOne(kit, kit);
  serverId = placed.resourceId;
  await t.pool.query("update resources set state = 'active' where id = $1", [serverId]);
});

const expected = async (usd: string, quantity: string | undefined, family: string) => {
  const q = await kit.run((tx) =>
    quoteInForce(
      tx,
      {
        market: "BD",
        productFamily: family,
        awsPriceUsd: usd,
        ...(quantity === undefined ? {} : { quantity }),
      },
      kit.clock,
    ),
  );
  if (!q.ok) throw new Error("quote refused");
  return q.value.quote.totalMinor;
};

const askDisk = () =>
  createDraft(kit.deps, kit.session, {
    family: "disk",
    config: { productId: anchorId, region: REGION, displayName: "data-1", sizeGb: 100, serverId },
  });

describe("disk: the block storage config price", () => {
  const KEY = "config_price.block_storage_gb_month";

  it("no row: the catalog anchor price (0.10) prices the order", async () => {
    await setConfig(KEY, null);
    const d = await askDisk();
    if (!d.ok) throw new Error(`refused: ${d.error}`);
    expect(d.value.quote.totalMinor).toBe(await expected("0.1000", "100", "disk"));
  });

  it("a row in force wins for a new order, with the legacy value shape too", async () => {
    await setConfig(KEY, { usd: "0.20", unit: "gb_month" });
    const d = await askDisk();
    if (!d.ok) throw new Error(`refused: ${d.error}`);
    expect(d.value.quote.totalMinor).toBe(await expected("0.20", "100", "disk"));
    expect(d.value.quote.totalMinor).toBeGreaterThan(await expected("0.1000", "100", "disk"));
  });

  it("a dated entry that has not started is not used; one that has started replaces the earlier", async () => {
    await setConfig(
      KEY,
      dated("gb_month", ["2026-01-01T00:00:00.000Z", "0.15"], ["2999-01-01T00:00:00.000Z", "9"]),
    );
    const d = await askDisk();
    if (!d.ok) throw new Error(`refused: ${d.error}`);
    expect(d.value.quote.totalMinor).toBe(await expected("0.15", "100", "disk"));
  });

  it("no entry has started: there is no row in force, so the catalog price stays", async () => {
    await setConfig(KEY, dated("gb_month", ["2999-01-01T00:00:00.000Z", "9"]));
    const d = await askDisk();
    if (!d.ok) throw new Error(`refused: ${d.error}`);
    expect(d.value.quote.totalMinor).toBe(await expected("0.1000", "100", "disk"));
  });

  it("a stored value that does not parse is not a price: the catalog price stays", async () => {
    await setConfig(KEY, { v: 7, entries: "x" });
    const d = await askDisk();
    if (!d.ok) throw new Error(`refused: ${d.error}`);
    expect(d.value.quote.totalMinor).toBe(await expected("0.1000", "100", "disk"));
  });

  it("a row of zero sells nothing (R16)", async () => {
    await setConfig(KEY, { usd: "0", unit: "gb_month" });
    expect(await askDisk()).toMatchObject({
      ok: false,
      error: "validation",
      fields: { price: "unavailable" },
    });
  });
});

describe("load balancer: the load balancer config price", () => {
  const KEY = "config_price.load_balancer_month";
  let lbProductId: string;

  beforeAll(async () => {
    await t.pool.query(
      `insert into feature_flags (id, key, market, enabled) values (gen_random_uuid(), 'load_balancer', 'BD', true)
       on conflict (key, market) do update set enabled = true`,
    );
    await t.pool.query(
      `insert into pool_capacity (id, pool_account_id, region, quota_code, quota_limit, used)
       values (gen_random_uuid(), $1, $2, 'load_balancer', 50, 0)
       on conflict (pool_account_id, region, quota_code) do update set quota_limit = 50, used = 0`,
      [kit.poolAccountId, REGION],
    );
    lbProductId = await kit.newProduct({
      family: "load_balancer",
      platform: null,
      specs: JSON.stringify({}),
      feature_flag: "load_balancer",
      aws_price_usd: "18",
    });
  });

  const askLb = () =>
    createDraft(kit.deps, kit.session, {
      family: "load_balancer",
      config: {
        productId: lbProductId,
        region: REGION,
        displayName: "lb-" + uniqueSuffix(),
        targetIds: [serverId],
      },
    });

  it("no row: the catalog price prices the order", async () => {
    await setConfig(KEY, null);
    const d = await askLb();
    if (!d.ok) throw new Error(`refused: ${d.error}`);
    expect(d.value.quote.totalMinor).toBe(await expected("18", undefined, "load_balancer"));
  });

  it("a row in force wins for a new order", async () => {
    await setConfig(KEY, dated("month", ["2026-01-01T00:00:00.000Z", "25"]));
    const d = await askLb();
    if (!d.ok) throw new Error(`refused: ${d.error}`);
    expect(d.value.quote.totalMinor).toBe(await expected("25", undefined, "load_balancer"));
  });

  it("a row of the wrong unit is not a price: the catalog price stays", async () => {
    await setConfig(KEY, { usd: "25", unit: "gb_month" });
    const d = await askLb();
    if (!d.ok) throw new Error(`refused: ${d.error}`);
    expect(d.value.quote.totalMinor).toBe(await expected("18", undefined, "load_balancer"));
  });

  it("a row of zero sells nothing (R16)", async () => {
    await setConfig(KEY, { usd: "0", unit: "month" });
    expect(await askLb()).toMatchObject({ ok: false, fields: { price: "unavailable" } });
  });
});
