// WPU-G8: a power, scale or bundle change takes effect at the NEXT renewal (ruling: no proration in a
// prepaid term). The pending plan lives in the resource config; the renewal quote reads its price
// through the pricing engine; the renewal queues the operation that applies it. Run against the temp
// database as web_rw, like renewNow, so a missing grant shows here.
import { insertRow, runTransaction, uniqueSuffix, useTempDatabase } from "@tc/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { quoteInForce } from "../rates/in-force";
import { makeKit, placeOne, START, type Kit } from "../test/orders-kit";
import { planPriceFor, readPlanChange } from "./plan-change";
import { renewalQuote } from "./renew";
import { renewNow } from "./renew-now";

const t = useTempDatabase();
const DAY = 24 * 3_600_000;
let kit: Kit;

const q = async (sql: string, params: unknown[] = []) =>
  (await t.pool.query(sql, params)).rows as Record<string, unknown>[];
const asWeb = <T>(fn: Parameters<typeof runTransaction<T>>[1]) =>
  runTransaction(t.db, fn, { role: "web_rw" });

// Each product gets a Region of its own (the catalog is unique by family, aws_id and Region, and the
// temp database is shared by the cases); the config of the resource names the same Region.
let regions = 0;
const regionOf = new Map<string, string>();
async function product(
  family: string,
  awsId: string,
  price: string,
  over: Record<string, unknown> = {},
): Promise<string> {
  const region = (over.region as string | undefined) ?? `xx-test-${++regions}`;
  const id = await insertRow(t.pool, "catalog_products", {
    family,
    aws_id: awsId,
    platform: null,
    specs: JSON.stringify(family === "container_service" ? { scale: 2 } : {}),
    aws_price_usd: price,
    billing_unit: "month",
    feature_flag: family,
    active: true,
    synced_at: START.toISOString(),
    ...over,
    region,
  });
  regionOf.set(id, region);
  return id;
}
const reg = (id: string): string => regionOf.get(id) ?? "xx-none";

interface Fresh {
  customerId: string;
  resourceId: string;
  subscriptionId: string;
  end: Date;
  snapshot: unknown;
}

/** A paid server, turned into a container service row so the family-specific price path runs. */
async function fresh(family: string, config: Record<string, unknown>): Promise<Fresh> {
  kit.clock.set(START);
  const buyer = await kit.newBuyer({ balanceMinor: 50_000_000n });
  const { resourceId } = await placeOne(kit, buyer);
  const s = (
    await q("select id, period_end, price_snapshot from subscriptions where resource_id = $1", [
      resourceId,
    ])
  )[0]!;
  await q("update resources set state = 'active', family = $2, config = $3::jsonb where id = $1", [
    resourceId,
    family,
    JSON.stringify(config),
  ]);
  await q("update operations set state = 'succeeded' where resource_id = $1", [resourceId]);
  return {
    customerId: buyer.customerId,
    resourceId,
    subscriptionId: String(s.id),
    end: s.period_end as Date,
    snapshot: s.price_snapshot,
  };
}

const rowOf = (f: Fresh, family: string, config: Record<string, unknown>) =>
  ({
    market: "BD",
    priceSnapshot: f.snapshot,
    resource: { family, state: "active", config, deletedAt: null },
  }) as never;

beforeAll(async () => {
  kit = await makeKit(t, { balanceMinor: 50_000_000n });
});

describe("readPlanChange", () => {
  const id = "0190aaaa-0000-7000-8000-0000000000a1";
  it("reads only well-formed ids and ignores everything else", () => {
    expect(
      readPlanChange({ pendingPlan: { productId: id }, appliedPlan: { productId: id } }),
    ).toEqual({ pending: id, applied: id });
    expect(readPlanChange({})).toEqual({ pending: null, applied: null });
    expect(readPlanChange({ pendingPlan: { productId: "x" }, appliedPlan: null })).toEqual({
      pending: null,
      applied: null,
    });
    expect(readPlanChange({ pendingPlan: "nope" })).toEqual({ pending: null, applied: null });
  });
});

describe("the renewal quote with a pending or applied plan", () => {
  it("prices the snapshot when no plan change exists (the unchanged behaviour)", async () => {
    const f = await fresh("container_service", {});
    const quoted = await asWeb((tx) =>
      renewalQuote(tx, rowOf(f, "container_service", {}), kit.clock),
    );
    const base = await asWeb((tx) =>
      quoteInForce(
        tx,
        { market: "BD", productFamily: "container_service", awsPriceUsd: "5" },
        kit.clock,
      ),
    );
    expect(quoted.ok && base.ok).toBe(true);
    if (quoted.ok && base.ok) expect(quoted.value.totalMinor).toBe(base.value.snapshot.totalMinor);
  });

  it("prices a pending plan with the pricing engine, from the catalog row (R4)", async () => {
    const big = await product("container_service", "large", "40");
    const config = {
      region: reg(big),
      productId: "x",
      pendingPlan: { productId: big },
    };
    const f = await fresh("container_service", config);
    const quoted = await asWeb((tx) =>
      renewalQuote(tx, rowOf(f, "container_service", config), kit.clock),
    );
    const engine = await asWeb((tx) =>
      quoteInForce(
        tx,
        { market: "BD", productFamily: "container_service", awsPriceUsd: "40" },
        kit.clock,
      ),
    );
    expect(quoted.ok && engine.ok).toBe(true);
    if (quoted.ok && engine.ok) {
      expect(quoted.value.totalMinor).toBe(engine.value.snapshot.totalMinor);
      expect(quoted.value.awsPriceUsd).toBe("40.0000");
    }
  });

  it("an applied plan keeps pricing the renewals after it was applied", async () => {
    const big = await product("cdn", "large_1_0", "20");
    const config = { region: reg(big), appliedPlan: { productId: big } };
    const f = await fresh("cdn", config);
    const price = await asWeb((tx) => planPriceFor(tx, rowOf(f, "cdn", config)));
    expect(price).toMatchObject({ state: "applied", productId: big, awsPriceUsd: "20.0000" });
  });

  it("a pending plan that is not usable is ignored, an applied one that is not usable refuses the quote (R16)", async () => {
    const other = await product("linux_instance", "nano", "5");
    const off = await product("cdn", "small_1_0", "5", { active: false });
    const wrongRegion = await product("cdn", "small_1_0", "5", { region: "ap-south-1" });
    const noShape = await product("cdn", "weird", "5");
    for (const bad of [other, off, wrongRegion, noShape, "0190aaaa-0000-7000-8000-0000000000ff"]) {
      // The resource lives in another Region than the wrong-Region product.
      const region = bad === wrongRegion ? "xx-resource-region" : reg(bad);
      const config = { region, pendingPlan: { productId: bad } };
      const f = await fresh("cdn", config);
      expect(await asWeb((tx) => planPriceFor(tx, rowOf(f, "cdn", config)))).toEqual({
        state: "snapshot",
      });
    }
    const applied = { region: reg(noShape), appliedPlan: { productId: noShape } };
    const f = await fresh("cdn", applied);
    expect(await asWeb((tx) => planPriceFor(tx, rowOf(f, "cdn", applied)))).toEqual({
      state: "unreadable",
    });
    const quote = await asWeb((tx) => renewalQuote(tx, rowOf(f, "cdn", applied), kit.clock));
    expect(quote.ok).toBe(false);
  });

  it("other families never read a plan, whatever the config holds", async () => {
    const big = await product("cdn", "large_1_0", "20");
    const config = { region: reg(big), pendingPlan: { productId: big } };
    const f = await fresh("linux_instance", config);
    expect(await asWeb((tx) => planPriceFor(tx, rowOf(f, "linux_instance", config)))).toEqual({
      state: "snapshot",
    });
  });
});

describe("renewNow with a pending plan", () => {
  it("charges the pending plan price and queues the apply operation once (R7)", async () => {
    const big = await product("container_service", "large", "40");
    const config = {
      region: reg(big),
      displayName: "svc-" + uniqueSuffix(),
      pendingPlan: { productId: big },
    };
    const f = await fresh("container_service", config);
    kit.clock.set(new Date(f.end.getTime() - 2 * DAY));
    const before = await kit.balance(f.customerId);
    const engine = await asWeb((tx) =>
      quoteInForce(
        tx,
        { market: "BD", productFamily: "container_service", awsPriceUsd: "40" },
        kit.clock,
      ),
    );
    const r = await asWeb((tx) =>
      renewNow(tx, { customerId: f.customerId, resourceId: f.resourceId, clock: kit.clock }),
    );
    expect(r.ok).toBe(true);
    if (engine.ok)
      expect(before - (await kit.balance(f.customerId))).toBe(
        BigInt(engine.value.snapshot.totalMinor),
      );
    const ops = await q(
      "select kind, payload from operations where resource_id = $1 and kind = 'scale_container'",
      [f.resourceId],
    );
    expect(ops).toHaveLength(1);
    expect(ops[0]!.payload).toMatchObject({ productId: big, subscriptionId: f.subscriptionId });
    // A second click is refused and queues nothing more.
    const again = await asWeb((tx) =>
      renewNow(tx, { customerId: f.customerId, resourceId: f.resourceId, clock: kit.clock }),
    );
    expect(again.ok).toBe(false);
    expect(
      await q("select 1 from operations where resource_id = $1 and kind = 'scale_container'", [
        f.resourceId,
      ]),
    ).toHaveLength(1);
  });

  it("a CDN queues change_cdn_bundle, and a resource without a pending plan queues nothing", async () => {
    const big = await product("cdn", "large_1_0", "20");
    const config = { region: reg(big), pendingPlan: { productId: big } };
    const f = await fresh("cdn", config);
    kit.clock.set(new Date(f.end.getTime() - 2 * DAY));
    expect(
      (
        await asWeb((tx) =>
          renewNow(tx, { customerId: f.customerId, resourceId: f.resourceId, clock: kit.clock }),
        )
      ).ok,
    ).toBe(true);
    expect(
      await q("select 1 from operations where resource_id = $1 and kind = 'change_cdn_bundle'", [
        f.resourceId,
      ]),
    ).toHaveLength(1);

    const plain = await fresh("cdn", { region: "xx-test-plain" });
    kit.clock.set(new Date(plain.end.getTime() - 2 * DAY));
    expect(
      (
        await asWeb((tx) =>
          renewNow(tx, {
            customerId: plain.customerId,
            resourceId: plain.resourceId,
            clock: kit.clock,
          }),
        )
      ).ok,
    ).toBe(true);
    expect(
      await q("select 1 from operations where resource_id = $1 and kind = 'change_cdn_bundle'", [
        plain.resourceId,
      ]),
    ).toHaveLength(0);
  });
});
