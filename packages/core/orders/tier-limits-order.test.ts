import { ensureMarket, useTempDatabase } from "@tc/db/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { makeKit } from "../test/orders-kit";
import { createDraft } from "./draft";

// WPU-G10. The order path reads the tier limits from the settings row of the customer's market and
// tier. No row: the defaults of the core. A stored limit changes what the draft allows. A row that does
// not parse refuses the order (R16). The row of another tier or market does not apply.
const t = useTempDatabase();

beforeEach(async () => {
  await t.pool.query("delete from settings where key = 'tier_limits'");
});

async function setLimits(tier: string, value: unknown, market = "BD"): Promise<void> {
  await t.pool.query(
    `insert into settings (id, key, market, scope, scope_id, value)
     values (gen_random_uuid(), 'tier_limits', $1, 'tier', $2, $3::jsonb)`,
    [market, tier, JSON.stringify(value)],
  );
}
const limits = (over: Record<string, unknown> = {}) => ({
  v: 1,
  maxInstances: 50,
  maxBundleUsd: "24",
  windows: false,
  containers: false,
  maxStaticIps: 1,
  ...over,
});

describe("createOrderDraft reads the tier limits from the settings", () => {
  it("with no row the defaults apply and a first server is allowed", async () => {
    const kit = await makeKit(t);
    expect((await createDraft(kit.deps, kit.session, kit.input())).ok).toBe(true);
  });

  it("a stored price cap lower than the bundle refuses the draft as limit_reached", async () => {
    const kit = await makeKit(t, { awsPriceUsd: "5" });
    await setLimits("new", limits({ maxBundleUsd: "4" }));
    expect(await createDraft(kit.deps, kit.session, kit.input())).toEqual({
      ok: false,
      error: "limit_reached",
      fields: { limit: "bundle_price" },
    });
  });

  it("a stored price cap raised above the default admits a dearer bundle", async () => {
    const kit = await makeKit(t, { awsPriceUsd: "30" });
    expect(await createDraft(kit.deps, kit.session, kit.input())).toMatchObject({
      ok: false,
      error: "limit_reached",
    });
    await setLimits("new", limits({ maxBundleUsd: "40" }));
    expect((await createDraft(kit.deps, kit.session, kit.input())).ok).toBe(true);
  });

  it("a stored count of 1 admits the first server and refuses the second at the draft", async () => {
    const kit = await makeKit(t);
    await setLimits("new", limits({ maxInstances: 1 }));
    expect((await createDraft(kit.deps, kit.session, kit.input())).ok).toBe(true);
    await t.pool.query(
      `insert into resources (id, customer_id, family, product_id, pool_account_id, region, config)
       values (gen_random_uuid(), $1, 'linux_instance', $2, $3, 'ap-southeast-1', '{}'::jsonb)`,
      [kit.customerId, kit.productId, kit.poolAccountId],
    );
    expect(await createDraft(kit.deps, kit.session, kit.input())).toEqual({
      ok: false,
      error: "limit_reached",
      fields: { limit: "instances" },
    });
  });

  it("a row that does not parse refuses the order as forbidden and the defaults are not used (R16)", async () => {
    const kit = await makeKit(t);
    await setLimits("new", { v: 1, maxInstances: "many" });
    expect(await createDraft(kit.deps, kit.session, kit.input())).toEqual({
      ok: false,
      error: "forbidden",
    });
  });

  it("the row of the other tier or of another market does not apply to this customer", async () => {
    const kit = await makeKit(t, { awsPriceUsd: "30" });
    await setLimits("trusted", limits({ maxBundleUsd: "9999" }));
    await ensureMarket(t.pool, "KE");
    await setLimits("new", limits({ maxBundleUsd: "9999" }), "KE");
    expect(await createDraft(kit.deps, kit.session, kit.input())).toMatchObject({
      ok: false,
      error: "limit_reached",
    });
  });
});
