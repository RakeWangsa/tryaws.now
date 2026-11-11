import { useTempDatabase } from "@tc/db/testing";
import { describe, expect, it } from "vitest";
import { makeKit, REGION, type Kit } from "../test/orders-kit";
import { childId } from "./ids";
import { createDraft } from "./draft";
import { makeOrders } from "./place";

const t = useTempDatabase();

const WINDOWS = "windows_instance";

async function windowsFlag(kit: Kit, enabled: boolean | "missing"): Promise<void> {
  if (enabled === "missing") {
    await t.pool.query("delete from feature_flags where key = $1 and market = 'BD'", [WINDOWS]);
    return;
  }
  await t.pool.query(
    `insert into feature_flags (id, key, market, enabled) values (gen_random_uuid(), $1, 'BD', $2)
     on conflict (key, market) do update set enabled = excluded.enabled`,
    [WINDOWS, enabled],
  );
}

async function windowsProduct(kit: Kit): Promise<string> {
  return kit.newProduct({ family: WINDOWS, platform: "windows", feature_flag: WINDOWS });
}

const input = (kit: Kit, productId: string) => ({
  family: WINDOWS,
  config: kit.config({ productId }),
});

describe("selling a Windows plan: the same single purchase transaction", () => {
  it("is refused while its flag is off or missing, and writes nothing (R12)", async () => {
    const kit = await makeKit(t, { riskTier: "trusted" });
    const productId = await windowsProduct(kit);
    await windowsFlag(kit, "missing");
    const missing = await createDraft(kit.deps, kit.session, input(kit, productId));
    expect(missing).toEqual({ ok: false, error: "flag_off" });
    await windowsFlag(kit, false);
    const off = await createDraft(kit.deps, kit.session, input(kit, productId));
    expect(off).toEqual({ ok: false, error: "flag_off" });
  });

  it("is refused for a tier without Windows (limits), flag on", async () => {
    const kit = await makeKit(t, { riskTier: "new" });
    const productId = await windowsProduct(kit);
    await windowsFlag(kit, true);
    const r = await createDraft(kit.deps, kit.session, input(kit, productId));
    expect(r.ok).toBe(false);
  });

  it("debits once and writes a windows_instance resource with the default key pair and a create operation", async () => {
    const kit = await makeKit(t, { riskTier: "trusted" });
    const productId = await windowsProduct(kit);
    await windowsFlag(kit, true);
    const before = await kit.balance();
    const drafted = await createDraft(kit.deps, kit.session, input(kit, productId));
    if (!drafted.ok) throw new Error("the draft was refused: " + drafted.error);
    const placed = await makeOrders(kit.deps).placeOrder(kit.session, {
      token: drafted.value.token,
      idempotencyKey: "k" + crypto.randomUUID().replaceAll("-", ""),
    });
    if (!placed.ok) throw new Error("the order was refused: " + placed.error);
    expect(await kit.balance()).toBeLessThan(before);
    const resourceId = childId(placed.value.orderId, "resource");
    const { rows } = await t.pool.query(
      "select family, state, region, config from resources where id = $1",
      [resourceId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ family: WINDOWS, state: "creating", region: REGION });
    expect((rows[0] as { config: { keyPairId: unknown } }).config.keyPairId).toBeNull();
    const ops = await t.pool.query("select kind, state from operations where resource_id = $1", [
      resourceId,
    ]);
    expect(ops.rows).toEqual([{ kind: "create", state: "queued" }]);
  });

  it("never reuses a Linux product for a Windows order (family mismatch, R16)", async () => {
    const kit = await makeKit(t, { riskTier: "trusted" });
    await windowsFlag(kit, true);
    const r = await createDraft(kit.deps, kit.session, input(kit, kit.productId));
    expect(r.ok).toBe(false);
  });
});

// The trusted tier allows 20 instances: Linux and Windows count together.
async function live(kit: Kit, family: string, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await t.pool.query(
      `insert into resources (id, customer_id, family, product_id, pool_account_id, region, config)
       values (gen_random_uuid(), $1, $2, $3, $4, $5, '{}'::jsonb)`,
      [kit.customerId, family, kit.productId, kit.poolAccountId, REGION],
    );
  }
}

describe("the instance limit counts every instance family together", () => {
  it("refuses a Windows draft at the Linux limit and a Linux draft at the Windows limit", async () => {
    const kit = await makeKit(t, { riskTier: "trusted" });
    const win = await windowsProduct(kit);
    await windowsFlag(kit, true);
    await live(kit, "linux_instance", 20);
    expect(await createDraft(kit.deps, kit.session, input(kit, win))).toMatchObject({
      ok: false,
      error: "limit_reached",
    });
    const other = await makeKit(t, { riskTier: "trusted" });
    const win2 = await windowsProduct(other);
    await live(other, "windows_instance", 20);
    expect((await createDraft(other.deps, other.session, other.input())).ok).toBe(false);
    expect((await createDraft(other.deps, other.session, input(other, win2))).ok).toBe(false);
  });

  it("counts one of each as two: 19 live plus a Windows order is allowed, 20 is not", async () => {
    const kit = await makeKit(t, { riskTier: "trusted" });
    const win = await windowsProduct(kit);
    await windowsFlag(kit, true);
    await live(kit, "linux_instance", 18);
    await live(kit, "windows_instance", 1);
    expect((await createDraft(kit.deps, kit.session, input(kit, win))).ok).toBe(true);
    await live(kit, "linux_instance", 1);
    expect((await createDraft(kit.deps, kit.session, input(kit, win))).ok).toBe(false);
  });

  it("re-checks at the purchase: a draft taken below the limit is refused once the limit is reached", async () => {
    const kit = await makeKit(t, { riskTier: "trusted" });
    const win = await windowsProduct(kit);
    await windowsFlag(kit, true);
    await live(kit, "linux_instance", 19);
    const drafted = await createDraft(kit.deps, kit.session, input(kit, win));
    if (!drafted.ok) throw new Error("the draft was refused: " + drafted.error);
    await live(kit, "linux_instance", 1);
    const before = await kit.balance();
    const placed = await makeOrders(kit.deps).placeOrder(kit.session, {
      token: drafted.value.token,
      idempotencyKey: "k" + crypto.randomUUID().replaceAll("-", ""),
    });
    expect(placed.ok).toBe(false);
    expect(await kit.balance()).toBe(before);
  });
});
