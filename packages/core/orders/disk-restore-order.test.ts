// WPU-B5 item 26: a disk order whose config names a snapshot (a backup row) of the customer's own disk.
// One paid order like every purchase: the same anchor row and the same per-GB price as a new disk, the
// snapshot read through the tenant-scoped repository in the draft and again in the purchase (R8), the
// `create` operation carrying the snapshot id (R1: the web tier only writes the row), one order = one
// disk (R7).
import { insertRow, uniqueSuffix, useTempDatabase } from "@tc/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { makeKit, REGION, type Buyer, type Kit } from "../test/orders-kit";
import { createDraft } from "./draft";
import { childId } from "./ids";
import { makeOrders } from "./place";

const t = useTempDatabase();
let kit: Kit;
let anchorId = "";

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

async function disk(customerId: string, over: Record<string, unknown> = {}) {
  return insertRow(t.pool, "resources", {
    customer_id: customerId,
    family: "disk",
    state: "active",
    pool_account_id: kit.poolAccountId,
    region: REGION,
    config: JSON.stringify({ displayName: "d-" + uniqueSuffix(), sizeGb: 100 }),
    ...over,
  });
}
async function snapshot(customerId: string, parent: string, over: Record<string, unknown> = {}) {
  return insertRow(t.pool, "resources", {
    customer_id: customerId,
    family: "backup",
    state: "active",
    pool_account_id: kit.poolAccountId,
    region: REGION,
    parent_resource_id: parent,
    config: JSON.stringify({ displayName: "s-" + uniqueSuffix(), manual: true }),
    ...over,
  });
}
const input = (restoreFromBackupId: string, over: Record<string, unknown> = {}) => ({
  family: "disk",
  config: {
    productId: anchorId,
    region: REGION,
    displayName: "restored-1",
    sizeGb: 100,
    restoreFromBackupId,
    ...over,
  },
});
async function owner(): Promise<{ buyer: Buyer; snap: string; source: string }> {
  const buyer = await kit.newBuyer({ balanceMinor: 50_000_000n, riskTier: "trusted" });
  const source = await disk(buyer.customerId);
  return { buyer, source, snap: await snapshot(buyer.customerId, source) };
}
async function place(buyer: Buyer, body: ReturnType<typeof input>) {
  const drafted = await createDraft(kit.deps, buyer.session, body);
  if (!drafted.ok) throw new Error("the draft was refused: " + drafted.error);
  const placed = await makeOrders(kit.deps).placeOrder(buyer.session, {
    token: drafted.value.token,
    idempotencyKey: "k" + crypto.randomUUID().replaceAll("-", ""),
  });
  return { drafted: drafted.value, placed };
}

describe("a disk from a snapshot", () => {
  it("is one paid order at the price of a new disk of that size, and the create operation names the snapshot", async () => {
    const o = await owner();
    const before = await kit.balance(o.buyer.customerId);
    const { drafted, placed } = await place(o.buyer, input(o.snap));
    if (!placed.ok) throw new Error("the order was refused: " + placed.error);
    // The same price source as a new disk: the quote of the per-GB anchor times the size (R4).
    expect(drafted.quote.totalMinor).toBeGreaterThan(0n);
    expect(await kit.balance(o.buyer.customerId)).toBe(before - drafted.quote.totalMinor);

    const resourceId = childId(placed.value.orderId, "resource");
    const res = await t.pool.query(
      "select family, state, product_id, config from resources where id = $1",
      [resourceId],
    );
    expect(res.rows[0]).toMatchObject({
      family: "disk",
      state: "creating",
      product_id: anchorId,
      config: { sizeGb: 100, displayName: "restored-1" },
    });
    expect(res.rows[0].config).not.toHaveProperty("serverId");
    const ops = await t.pool.query(
      "select kind, state, payload from operations where resource_id = $1",
      [resourceId],
    );
    expect(ops.rows).toHaveLength(1);
    expect(ops.rows[0]).toMatchObject({
      kind: "create",
      state: "queued",
      payload: { restoreFromBackupId: o.snap },
    });
  });

  it("a larger disk costs more GB and the quota disk_gb counts the new size", async () => {
    const o = await owner();
    const before = (await kit.used())[`${REGION}/disk_gb`] ?? 0;
    const small = await createDraft(kit.deps, o.buyer.session, input(o.snap));
    const large = await createDraft(kit.deps, o.buyer.session, input(o.snap, { sizeGb: 200 }));
    if (!small.ok || !large.ok) throw new Error("fixture");
    expect(large.value.quote.baseMinor).toBeGreaterThan(small.value.quote.baseMinor);
    const { placed } = await place(o.buyer, input(o.snap, { sizeGb: 150 }));
    expect(placed.ok).toBe(true);
    expect((await kit.used())[`${REGION}/disk_gb`]).toBe(before + 150);
  });

  it("a second placement of the same token does not charge or create again (R7)", async () => {
    const o = await owner();
    const first = await place(o.buyer, input(o.snap));
    const balance = await kit.balance(o.buyer.customerId);
    const second = await makeOrders(kit.deps).placeOrder(o.buyer.session, {
      token: first.drafted.token,
      idempotencyKey: "k" + crypto.randomUUID().replaceAll("-", ""),
    });
    expect(first.placed.ok && second.ok).toBe(true);
    expect(await kit.balance(o.buyer.customerId)).toBe(balance);
    const n = await t.pool.query(
      "select count(*)::int as n from resources where customer_id = $1 and family = 'disk' and state = 'creating'",
      [o.buyer.customerId],
    );
    expect(n.rows[0]).toEqual({ n: 1 });
  });

  it("another customer's snapshot answers like a missing one and writes nothing (R8)", async () => {
    const mine = await owner();
    const theirs = await owner();
    const stolen = await createDraft(kit.deps, mine.buyer.session, input(theirs.snap));
    const missing = await createDraft(kit.deps, mine.buyer.session, input(crypto.randomUUID()));
    expect(stolen).toEqual(missing);
    expect(stolen).toMatchObject({
      ok: false,
      error: "validation",
      fields: { restoreFromBackupId: "invalid" },
    });
    // A snapshot of the other customer's disk, whose parent is mine, is not mine either.
    const crossParent = await snapshot(theirs.buyer.customerId, mine.source);
    expect(await createDraft(kit.deps, mine.buyer.session, input(crossParent))).toEqual(missing);
  });

  it("refuses a smaller disk, another Region, a snapshot of a server, one not active, and a server id with it", async () => {
    const o = await owner();
    expect(
      await createDraft(kit.deps, o.buyer.session, input(o.snap, { sizeGb: 50 })),
    ).toMatchObject({ ok: false, fields: { sizeGb: "too_small" } });
    expect(
      await createDraft(kit.deps, o.buyer.session, input(o.snap, { region: "ap-south-1" })),
    ).toMatchObject({ ok: false, error: "validation" });
    const server = await disk(o.buyer.customerId, { family: "linux_instance" });
    expect(
      await createDraft(
        kit.deps,
        o.buyer.session,
        input(await snapshot(o.buyer.customerId, server)),
      ),
    ).toMatchObject({ ok: false, fields: { restoreFromBackupId: "invalid" } });
    const creating = await snapshot(o.buyer.customerId, o.source, { state: "creating" });
    expect(await createDraft(kit.deps, o.buyer.session, input(creating))).toMatchObject({
      ok: false,
      fields: { restoreFromBackupId: "invalid" },
    });
    expect(
      await createDraft(
        kit.deps,
        o.buyer.session,
        input(o.snap, { serverId: crypto.randomUUID() }),
      ),
    ).toMatchObject({ ok: false, fields: { serverId: "invalid" } });
  });

  it("the final snapshot of a destroyed disk can be restored", async () => {
    const o = await owner();
    await t.pool.query(
      "update resources set state = 'destroyed', deleted_at = now() where id = $1",
      [o.source],
    );
    const r = await createDraft(kit.deps, o.buyer.session, input(o.snap));
    expect(r.ok).toBe(true);
  });

  it("is refused when the feature flag disk is off (R12)", async () => {
    const o = await owner();
    await t.pool.query("update feature_flags set enabled = false where key = 'disk'");
    try {
      expect(await createDraft(kit.deps, o.buyer.session, input(o.snap))).toMatchObject({
        ok: false,
        error: "flag_off",
      });
    } finally {
      await t.pool.query("update feature_flags set enabled = true where key = 'disk'");
    }
  });
});
