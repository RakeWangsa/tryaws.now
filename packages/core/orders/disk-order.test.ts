// addDisk (16.10 Storage): a `disk` order whose config names a server of the customer's own. It is
// the same single purchase transaction as every other family: the anchor row of the Region, the size
// as the quantity, the server read through the tenant-scoped repository in the draft and again in
// the purchase, the capacity quota `disk_gb`, the create operation, the subscription.
import { insertRow, useTempDatabase } from "@tc/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { makeKit, placeOne, REGION, type Buyer, type Kit } from "../test/orders-kit";
import { createDraft } from "./draft";
import { childId } from "./ids";
import { makeOrders } from "./place";

const t = useTempDatabase();
let kit: Kit;
let anchorId: string;

beforeAll(async () => {
  kit = await makeKit(t, { riskTier: "trusted", balanceMinor: 50_000_000n });
  const found = await t.pool.query<{ id: string }>(
    "select id from catalog_products where family = 'disk' and aws_id = 'block-storage-gb' and region = $1",
    [REGION],
  );
  anchorId = found.rows[0]?.id ?? "";
  await insertRow(t.pool, "pool_capacity", {
    pool_account_id: kit.poolAccountId,
    region: REGION,
    quota_code: "disk_gb",
    quota_limit: 10_000,
    used: 0,
  });
});

interface Owner {
  buyer: Buyer;
  serverId: string;
}

// A paid Linux server of a new buyer, made active.
async function owner(
  over: { family?: string; state?: string; balanceMinor?: bigint } = {},
): Promise<Owner> {
  const buyer = await kit.newBuyer({
    balanceMinor: over.balanceMinor ?? 50_000_000n,
    riskTier: "trusted",
  });
  const placed = await placeOne(kit, buyer);
  await t.pool.query("update resources set state = $2, family = $3 where id = $1", [
    placed.resourceId,
    over.state ?? "active",
    over.family ?? "linux_instance",
  ]);
  return { buyer, serverId: placed.resourceId };
}

const diskInput = (serverId: string, over: Record<string, unknown> = {}) => ({
  family: "disk",
  config: {
    productId: anchorId,
    region: REGION,
    displayName: "data-1",
    sizeGb: 100,
    serverId,
    ...over,
  },
});

async function place(o: Owner, over: Record<string, unknown> = {}) {
  const drafted = await createDraft(kit.deps, o.buyer.session, diskInput(o.serverId, over));
  if (!drafted.ok) throw new Error("the draft was refused: " + drafted.error);
  const placed = await makeOrders(kit.deps).placeOrder(o.buyer.session, {
    token: drafted.value.token,
    idempotencyKey: "k" + crypto.randomUUID().replaceAll("-", ""),
  });
  return { drafted: drafted.value, placed, token: drafted.value.token };
}

describe("addDisk", () => {
  it("the anchor row is seeded once per launch Region (three) and is priced per GB-month", async () => {
    const rows = await t.pool.query(
      "select region, aws_price_usd::text as price, billing_unit, feature_flag, active from catalog_products where family = 'disk' order by region",
    );
    expect(rows.rows).toEqual([
      {
        region: "ap-south-1",
        price: "0.1000",
        billing_unit: "gb_month",
        feature_flag: "disk",
        active: true,
      },
      {
        region: "ap-southeast-1",
        price: "0.1000",
        billing_unit: "gb_month",
        feature_flag: "disk",
        active: true,
      },
      // WPU-G1 (P9): migration 0009
      {
        region: "us-east-1",
        price: "0.1000",
        billing_unit: "gb_month",
        feature_flag: "disk",
        active: true,
      },
    ]);
  });

  it("is one paid order: the price is the engine's quote of the per-GB price times the size (R4)", async () => {
    const o = await owner();
    const before = await kit.balance(o.buyer.customerId);
    const { drafted, placed } = await place(o);
    if (!placed.ok) throw new Error("the order was refused: " + placed.error);
    // 100 GB at 0.10 USD, rate 127, staging rule: 118872 paisa for 80 GB in quote.test.ts, so for
    // 100 GB the quote is the engine's own answer; compare with the draft and the wallet.
    expect(drafted.quote.totalMinor).toBeGreaterThan(0n);
    expect(await kit.balance(o.buyer.customerId)).toBe(before - drafted.quote.totalMinor);

    const resourceId = childId(placed.value.orderId, "resource");
    const res = await t.pool.query(
      "select family, state, product_id, region, config from resources where id = $1",
      [resourceId],
    );
    expect(res.rows[0]).toMatchObject({
      family: "disk",
      state: "creating",
      product_id: anchorId,
      region: REGION,
      config: { sizeGb: 100, displayName: "data-1", serverId: o.serverId },
    });
    const ops = await t.pool.query("select kind, state from operations where resource_id = $1", [
      resourceId,
    ]);
    expect(ops.rows).toEqual([{ kind: "create", state: "queued" }]);
    const subs = await t.pool.query("select status from subscriptions where resource_id = $1", [
      resourceId,
    ]);
    expect(subs.rows).toEqual([{ status: "active" }]);
  });

  it("twice the size costs twice the GB: the quantity is the size", async () => {
    const o = await owner();
    const small = await createDraft(kit.deps, o.buyer.session, diskInput(o.serverId));
    const large = await createDraft(
      kit.deps,
      o.buyer.session,
      diskInput(o.serverId, { sizeGb: 200 }),
    );
    if (!small.ok || !large.ok) throw new Error("fixture");
    expect(large.value.quote.baseMinor).toBeGreaterThan(small.value.quote.baseMinor);
    // the engine rounds half up once, after the multiplication (R4): 200 GB is not 2 x the rounded 100 GB
    expect(large.value.quote.baseMinor).toBeGreaterThanOrEqual(
      small.value.quote.baseMinor * 2n - 1n,
    );
    expect(large.value.quote.baseMinor).toBeLessThanOrEqual(small.value.quote.baseMinor * 2n + 1n);
  });

  it("takes the size in GB from the quota disk_gb of the pool", async () => {
    const o = await owner();
    const before = (await kit.used())[`${REGION}/disk_gb`] ?? 0;
    const { placed } = await place(o, { sizeGb: 50 });
    expect(placed.ok).toBe(true);
    expect((await kit.used())[`${REGION}/disk_gb`]).toBe(before + 50);
  });

  it("a second placement of the same token does not charge again (R7)", async () => {
    const o = await owner();
    const first = await place(o);
    const balance = await kit.balance(o.buyer.customerId);
    const second = await makeOrders(kit.deps).placeOrder(o.buyer.session, {
      token: first.token,
      idempotencyKey: "k" + crypto.randomUUID().replaceAll("-", ""),
    });
    expect(first.placed.ok && second.ok).toBe(true);
    expect(await kit.balance(o.buyer.customerId)).toBe(balance);
    const n = await t.pool.query(
      "select count(*)::int as n from resources where customer_id = $1 and family = 'disk'",
      [o.buyer.customerId],
    );
    expect(n.rows[0]).toEqual({ n: 1 });
  });

  it("another customer's server answers like a missing one (R8)", async () => {
    const mine = await owner();
    const theirs = await owner();
    const stolen = await createDraft(kit.deps, mine.buyer.session, diskInput(theirs.serverId));
    const missing = await createDraft(kit.deps, mine.buyer.session, diskInput(crypto.randomUUID()));
    expect(stolen).toEqual(missing);
    expect(stolen).toMatchObject({
      ok: false,
      error: "validation",
      fields: { serverId: "invalid" },
    });
  });

  it("refuses a server that is not Linux, not live or in another Region", async () => {
    const windows = await owner({ family: "windows_instance" });
    const creating = await owner({ state: "creating" });
    for (const o of [windows, creating]) {
      const r = await createDraft(kit.deps, o.buyer.session, diskInput(o.serverId));
      expect(r).toMatchObject({ ok: false, error: "validation", fields: { serverId: "invalid" } });
    }
    const here = await owner();
    const other = await createDraft(
      kit.deps,
      here.buyer.session,
      diskInput(here.serverId, { region: "ap-south-1" }),
    );
    expect(other).toMatchObject({ ok: false, error: "validation" });
  });

  it("refuses a product that is not the disk anchor, and a size outside the limits", async () => {
    const o = await owner();
    const notAnchor = await createDraft(
      kit.deps,
      o.buyer.session,
      diskInput(o.serverId, { productId: kit.productId }),
    );
    expect(notAnchor).toMatchObject({
      ok: false,
      error: "validation",
      fields: { productId: "unavailable" },
    });
    for (const sizeGb of [7, 16_385, 12.5]) {
      const r = await createDraft(kit.deps, o.buyer.session, diskInput(o.serverId, { sizeGb }));
      expect(r).toMatchObject({ ok: false, error: "validation", fields: { sizeGb: "invalid" } });
    }
  });

  it("is refused when the feature flag disk is off (R12) and charges nothing", async () => {
    const o = await owner();
    await t.pool.query("update feature_flags set enabled = false where key = 'disk'");
    try {
      const r = await createDraft(kit.deps, o.buyer.session, diskInput(o.serverId));
      expect(r).toMatchObject({ ok: false, error: "flag_off" });
    } finally {
      await t.pool.query("update feature_flags set enabled = true where key = 'disk'");
    }
  });

  it("is refused for a wallet that cannot pay, and writes nothing", async () => {
    // enough for the server (74295 paisa), not for 100 GB
    const o = await owner({ balanceMinor: 80_000n });
    const before = await kit.balance(o.buyer.customerId);
    const drafted = await createDraft(kit.deps, o.buyer.session, diskInput(o.serverId));
    if (!drafted.ok) throw new Error("the draft was refused");
    const placed = await makeOrders(kit.deps).placeOrder(o.buyer.session, {
      token: drafted.value.token,
      idempotencyKey: "k" + crypto.randomUUID().replaceAll("-", ""),
    });
    expect(placed).toMatchObject({ ok: false, error: "insufficient_balance" });
    expect(await kit.balance(o.buyer.customerId)).toBe(before);
    const n = await t.pool.query(
      "select count(*)::int as n from resources where customer_id = $1 and family = 'disk'",
      [o.buyer.customerId],
    );
    expect(n.rows[0]).toEqual({ n: 0 });
  });

  it("a server deleted between the draft and the purchase refuses the purchase and charges nothing", async () => {
    const o = await owner();
    const drafted = await createDraft(kit.deps, o.buyer.session, diskInput(o.serverId));
    if (!drafted.ok) throw new Error("the draft was refused");
    await t.pool.query(
      "update resources set state = 'destroyed', deleted_at = now() where id = $1",
      [o.serverId],
    );
    const before = await kit.balance(o.buyer.customerId);
    const placed = await makeOrders(kit.deps).placeOrder(o.buyer.session, {
      token: drafted.value.token,
      idempotencyKey: "k" + crypto.randomUUID().replaceAll("-", ""),
    });
    expect(placed).toMatchObject({ ok: false, error: "validation" });
    expect(await kit.balance(o.buyer.customerId)).toBe(before);
  });
});
