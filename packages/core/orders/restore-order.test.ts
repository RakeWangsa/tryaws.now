// restoreToNewServer (16.10 Backups): a Linux order whose config names a backup of the customer's own
// server. It is the same single purchase transaction; the backup is read through the tenant-scoped
// repository both in the draft and again in the purchase.
import { insertRow, uniqueSuffix, useTempDatabase } from "@tc/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { makeKit, placeOne, REGION, type Buyer, type Kit } from "../test/orders-kit";
import { createDraft } from "./draft";
import { DEFAULT_TIER_LIMITS } from "./gates";
import { childId } from "./ids";
import { makeOrders } from "./place";

const t = useTempDatabase();
let kit: Kit;

const specs = (diskGb: number) => JSON.stringify({ vcpus: 2, diskGb });

interface Source {
  buyer: Buyer;
  serverId: string;
  backupId: string;
}

// A paid server of a buyer whose plan has 40 GB, made active, and an active backup row under it.
async function source(
  over: {
    backupState?: string;
    backupFamily?: string;
    parentFamily?: string;
  } = {},
): Promise<Source> {
  const buyer = await kit.newBuyer({ balanceMinor: 50_000_000n, riskTier: "trusted" });
  const small = await kit.newProduct({ specs: specs(40) });
  const { token } = await kit.draft({ productId: small }, buyer);
  const placed = await makeOrders(kit.deps).placeOrder(buyer.session, {
    token,
    idempotencyKey: "k" + crypto.randomUUID().replaceAll("-", ""),
  });
  if (!placed.ok) throw new Error("fixture: the source order was refused");
  const serverId = childId(placed.value.orderId, "resource");
  await t.pool.query("update resources set state = 'active', family = $2 where id = $1", [
    serverId,
    over.parentFamily ?? "linux_instance",
  ]);
  const backupId = await insertRow(t.pool, "resources", {
    customer_id: buyer.customerId,
    family: over.backupFamily ?? "backup",
    state: over.backupState ?? "active",
    pool_account_id: kit.poolAccountId,
    region: REGION,
    parent_resource_id: serverId,
    config: JSON.stringify({ displayName: "b-" + uniqueSuffix(), manual: true }),
  });
  return { buyer, serverId, backupId };
}

const planOf = (diskGb: number) => kit.newProduct({ specs: specs(diskGb) });

const restoreInput = async (backupId: string, over: Record<string, unknown> = {}) => ({
  family: "linux_instance",
  config: kit.config({
    productId: await planOf(40),
    restoreFromBackupId: backupId,
    ...over,
  }),
});

beforeAll(async () => {
  kit = await makeKit(t, { riskTier: "trusted", balanceMinor: 50_000_000n });
});

describe("restoreToNewServer", () => {
  it("is one paid order with a create operation that names the backup", async () => {
    const s = await source();
    const before = await kit.balance(s.buyer.customerId);
    const drafted = await createDraft(kit.deps, s.buyer.session, await restoreInput(s.backupId));
    if (!drafted.ok) throw new Error("the draft was refused: " + drafted.error);
    const placed = await makeOrders(kit.deps).placeOrder(s.buyer.session, {
      token: drafted.value.token,
      idempotencyKey: "k" + crypto.randomUUID().replaceAll("-", ""),
    });
    if (!placed.ok) throw new Error("the order was refused: " + placed.error);
    expect(await kit.balance(s.buyer.customerId)).toBeLessThan(before);

    const resourceId = childId(placed.value.orderId, "resource");
    const res = await t.pool.query("select family, state, config from resources where id = $1", [
      resourceId,
    ]);
    expect(res.rows[0]).toMatchObject({ family: "linux_instance", state: "creating" });
    expect((res.rows[0] as { config: Record<string, unknown> }).config).toMatchObject({
      restoreFromBackupId: s.backupId,
      keyPairId: null,
    });
    const ops = await t.pool.query(
      "select kind, state, payload from operations where resource_id = $1",
      [resourceId],
    );
    expect(ops.rows).toHaveLength(1);
    expect(ops.rows[0]).toMatchObject({
      kind: "create",
      payload: { orderId: placed.value.orderId, restoreFromBackupId: s.backupId },
    });
    const subs = await t.pool.query("select status from subscriptions where resource_id = $1", [
      resourceId,
    ]);
    expect(subs.rows).toEqual([{ status: "active" }]);
  });

  it("a second placement of the same token does not charge again (R7)", async () => {
    const s = await source();
    const drafted = await createDraft(kit.deps, s.buyer.session, await restoreInput(s.backupId));
    if (!drafted.ok) throw new Error("the draft was refused");
    const place = (key: string) =>
      makeOrders(kit.deps).placeOrder(s.buyer.session, {
        token: drafted.value.token,
        idempotencyKey: key,
      });
    const first = await place("k" + crypto.randomUUID().replaceAll("-", ""));
    const balance = await kit.balance(s.buyer.customerId);
    const second = await place("k" + crypto.randomUUID().replaceAll("-", ""));
    expect(first.ok && second.ok).toBe(true);
    expect(await kit.balance(s.buyer.customerId)).toBe(balance);
  });

  it("another customer's backup answers like a missing one (R8)", async () => {
    const mine = await source();
    const theirs = await source();
    const stolen = await createDraft(
      kit.deps,
      mine.buyer.session,
      await restoreInput(theirs.backupId),
    );
    const missing = await createDraft(
      kit.deps,
      mine.buyer.session,
      await restoreInput(crypto.randomUUID()),
    );
    expect(stolen).toEqual(missing);
    expect(stolen).toMatchObject({
      ok: false,
      error: "validation",
      fields: { restoreFromBackupId: "invalid" },
    });
  });

  it("refuses a backup that is not active, not a backup, or not under a Linux server", async () => {
    const creating = await source({ backupState: "creating" });
    const notBackup = await source({ backupFamily: "disk" });
    const windowsParent = await source({ parentFamily: "windows_instance" });
    for (const s of [creating, notBackup, windowsParent]) {
      const r = await createDraft(kit.deps, s.buyer.session, await restoreInput(s.backupId));
      expect(r).toMatchObject({ ok: false, error: "validation" });
    }
  });

  it("refuses a plan with a smaller disk than the server of the backup", async () => {
    const s = await source();
    const r = await createDraft(
      kit.deps,
      s.buyer.session,
      await restoreInput(s.backupId, { productId: await planOf(20) }),
    );
    expect(r).toMatchObject({ ok: false, error: "validation", fields: { productId: "too_small" } });
  });

  it("refuses a plan whose disk size is unknown (fails closed, R16)", async () => {
    const s = await source();
    const noDisk = await kit.newProduct({ specs: JSON.stringify({ vcpus: 2 }) });
    const r = await createDraft(
      kit.deps,
      s.buyer.session,
      await restoreInput(s.backupId, { productId: noDisk }),
    );
    expect(r).toMatchObject({ ok: false, error: "validation" });
  });

  it("refuses a Region other than the one of the backup", async () => {
    const s = await source();
    const other = await kit.newProduct({ specs: specs(40), region: "eu-west-1" });
    const r = await createDraft(
      kit.deps,
      s.buyer.session,
      await restoreInput(s.backupId, { productId: other, region: "eu-west-1" }),
    );
    expect(r).toMatchObject({ ok: false, error: "validation" });
  });

  it("refuses a key pair: the restored server keeps the keys of the image", async () => {
    const s = await source();
    const r = await createDraft(
      kit.deps,
      s.buyer.session,
      await restoreInput(s.backupId, { keyPairId: crypto.randomUUID() }),
    );
    expect(r).toMatchObject({ ok: false, error: "validation" });
  });

  it("a backup deleted between the draft and the purchase refuses the purchase and charges nothing", async () => {
    const s = await source();
    const drafted = await createDraft(kit.deps, s.buyer.session, await restoreInput(s.backupId));
    if (!drafted.ok) throw new Error("the draft was refused");
    await t.pool.query(
      "update resources set state = 'destroyed', deleted_at = now() where id = $1",
      [s.backupId],
    );
    const before = await kit.balance(s.buyer.customerId);
    const placed = await makeOrders(kit.deps).placeOrder(s.buyer.session, {
      token: drafted.value.token,
      idempotencyKey: "k" + crypto.randomUUID().replaceAll("-", ""),
    });
    expect(placed).toMatchObject({ ok: false, error: "validation" });
    expect(await kit.balance(s.buyer.customerId)).toBe(before);
  });

  it("counts toward the instance limit: the limit is checked before the restore is drafted", async () => {
    const s = await source();
    await placeOne(kit, s.buyer);
    // Live instances up to the limit of the tier "new".
    const limit = DEFAULT_TIER_LIMITS.new.maxInstances;
    await t.pool.query(
      `insert into resources (id, customer_id, family, product_id, pool_account_id, region, config)
       select gen_random_uuid(), $1, 'linux_instance', $2, $3, $4, '{}'::jsonb from generate_series(1, $5::int)`,
      [s.buyer.customerId, kit.productId, kit.poolAccountId, REGION, limit],
    );
    await kit.setCustomer(s.buyer.customerId, { risk_tier: "new" });
    const r = await createDraft(kit.deps, s.buyer.session, await restoreInput(s.backupId));
    expect(r).toMatchObject({ ok: false, error: "limit_reached" });
  });
});
