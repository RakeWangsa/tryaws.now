// WPU-G8: a power, scale or bundle change takes effect at the NEXT renewal (ruling: no proration in a
// prepaid term). The pending plan lives in the resource config; the renewal quote reads its price
// through the pricing engine; the renewal queues the operation that applies it. Run against the temp
// database as web_rw, like renewNow, so a missing grant shows here.
import { insertRow, runTransaction, uniqueSuffix, useTempDatabase } from "@tc/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { createMemoryQueue } from "../operations/queue";
import { sweepOperations } from "../operations/sweep";
import { quoteInForce } from "../rates/in-force";
import { makeKit, placeOne, START, type Kit } from "../test/orders-kit";
import { lifecycleHooks } from "./hooks";
import { PLAN_APPLY_STATES, planPriceFor, readPlanChange } from "./plan-change";
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

const rowOf = (f: Fresh, family: string, config: Record<string, unknown>, state = "active") =>
  ({
    market: "BD",
    priceSnapshot: f.snapshot,
    resource: { family, state, config, deletedAt: null },
  }) as never;

beforeAll(async () => {
  kit = await makeKit(t, { balanceMinor: 50_000_000n, vcpuLimit: 4000, ipLimit: 4000 });
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
// WPU-S2: the renewal may charge the pending plan only when the apply operation can run for the state
// the resource is in, and only while the pending plan has not failed.
const asWorker = <T>(fn: Parameters<typeof runTransaction<T>>[1]) =>
  runTransaction(t.db, fn, { role: "worker_rw" });
const total = async (family: string, usd: string): Promise<bigint> => {
  const r = await asWeb((tx) =>
    quoteInForce(tx, { market: "BD", productFamily: family, awsPriceUsd: usd }, kit.clock),
  );
  if (!r.ok) throw new Error("no quote");
  return BigInt(r.value.snapshot.totalMinor);
};
const renewTwoDaysBefore = async (f: Fresh) => {
  kit.clock.set(new Date(f.end.getTime() - 2 * DAY));
  const before = await kit.balance(f.customerId);
  const r = await asWeb((tx) =>
    renewNow(tx, {
      customerId: f.customerId,
      resourceId: f.resourceId,
      clock: kit.clock,
    }),
  );
  return { r, charged: before - (await kit.balance(f.customerId)) };
};
const applyOps = (resourceId: string) =>
  q(
    "select 1 from operations where resource_id = $1 and kind in ('scale_container','change_cdn_bundle')",
    [resourceId],
  );
const configOf = async (resourceId: string) =>
  (await q("select config from resources where id = $1", [resourceId]))[0]!.config as Record<
    string,
    unknown
  >;

describe("PLAN_APPLY_STATES (the states in which the adapter action accepts the apply)", () => {
  it("is active only, for both plan families; the adapters refuse every other state", () => {
    expect(PLAN_APPLY_STATES).toEqual({
      container_service: ["active"],
      cdn: ["active"],
    });
  });
});

describe("WPU-S2: the pending price is charged only when the apply can run", () => {
  it("planPriceFor ignores the pending plan while the resource is stopped, suspended or in another state", async () => {
    const big = await product("container_service", "large", "40");
    const small = await product("container_service", "small", "5", {
      region: reg(big),
    });
    const config = {
      region: reg(big),
      appliedPlan: { productId: big },
      pendingPlan: { productId: small },
    };
    const f = await fresh("container_service", config);
    for (const state of ["stopped", "suspended", "provisioning", "retained"]) {
      expect(
        await asWeb((tx) => planPriceFor(tx, rowOf(f, "container_service", config, state))),
      ).toMatchObject({ state: "applied", productId: big });
    }
    expect(
      await asWeb((tx) => planPriceFor(tx, rowOf(f, "container_service", config, "active"))),
    ).toMatchObject({ state: "pending", productId: small });
  });

  it("downgrade while stopped: charged at the CURRENT plan price, the pending plan stays, nothing is queued", async () => {
    const big = await product("container_service", "large", "40");
    const small = await product("container_service", "small", "5", {
      region: reg(big),
    });
    const config = {
      region: reg(big),
      appliedPlan: { productId: big },
      pendingPlan: { productId: small },
    };
    const f = await fresh("container_service", config);
    await q("update resources set state = 'stopped' where id = $1", [f.resourceId]);
    const { r, charged } = await renewTwoDaysBefore(f);
    expect(r.ok).toBe(true);
    expect(charged).toBe(await total("container_service", "40"));
    expect(await applyOps(f.resourceId)).toHaveLength(0);
    expect(await configOf(f.resourceId)).toMatchObject({
      pendingPlan: { productId: small },
    });
  });

  it("downgrade active: charged the CURRENT price (WPU-S4), the apply is queued once per period (R7)", async () => {
    const big = await product("container_service", "large", "40");
    const small = await product("container_service", "small", "5", {
      region: reg(big),
    });
    const config = {
      region: reg(big),
      appliedPlan: { productId: big },
      pendingPlan: { productId: small },
    };
    const f = await fresh("container_service", config);
    const { r, charged } = await renewTwoDaysBefore(f);
    expect(r.ok).toBe(true);
    expect(charged).toBe(await total("container_service", "40"));
    expect(await applyOps(f.resourceId)).toHaveLength(1);
    const again = await asWeb((tx) =>
      renewNow(tx, {
        customerId: f.customerId,
        resourceId: f.resourceId,
        clock: kit.clock,
      }),
    );
    expect(again.ok).toBe(false);
    expect(await applyOps(f.resourceId)).toHaveLength(1);
  });

  it("upgrade while stopped: not charged more than the capacity delivered", async () => {
    const small = await product("cdn", "small_1_0", "5");
    const big = await product("cdn", "large_1_0", "20", { region: reg(small) });
    const config = {
      region: reg(small),
      appliedPlan: { productId: small },
      pendingPlan: { productId: big },
    };
    const f = await fresh("cdn", config);
    await q("update resources set state = 'stopped' where id = $1", [f.resourceId]);
    const { r, charged } = await renewTwoDaysBefore(f);
    expect(r.ok).toBe(true);
    expect(charged).toBe(await total("cdn", "5"));
    expect(await applyOps(f.resourceId)).toHaveLength(0);
  });

  it("a renewal from grace of a suspended resource charges the current plan too", async () => {
    const big = await product("container_service", "large", "40");
    const small = await product("container_service", "small", "5", {
      region: reg(big),
    });
    const config = {
      region: reg(big),
      appliedPlan: { productId: big },
      pendingPlan: { productId: small },
    };
    const f = await fresh("container_service", config);
    await q("update resources set state = 'suspended' where id = $1", [f.resourceId]);
    await q("update subscriptions set status = 'grace' where id = $1", [f.subscriptionId]);
    const { r, charged } = await renewTwoDaysBefore(f);
    expect(r.ok).toBe(true);
    expect(charged).toBe(await total("container_service", "40"));
    expect(await applyOps(f.resourceId)).toHaveLength(0);
  });
});

describe("WPU-S2: an apply that ends in needs_attention clears the discount", () => {
  const failEvent = (f: Fresh, kind: string, code = "conflict") => ({
    operationId: "0190aaaa-0000-7000-8000-0000000000b1",
    resourceId: f.resourceId,
    kind,
    code,
  });

  it("marks pendingPlanFailed with the reason code and stops quoting the pending plan", async () => {
    const big = await product("container_service", "large", "40");
    const small = await product("container_service", "small", "5", {
      region: reg(big),
    });
    const config = {
      region: reg(big),
      appliedPlan: { productId: big },
      pendingPlan: { productId: small },
    };
    const f = await fresh("container_service", config);
    await asWorker((tx) =>
      lifecycleHooks({ clock: kit.clock }).needsAttention(tx, failEvent(f, "scale_container")),
    );
    expect(await configOf(f.resourceId)).toMatchObject({
      pendingPlan: { productId: small },
      pendingPlanFailed: { code: "conflict" },
    });
    const stored = await configOf(f.resourceId);
    expect(
      await asWeb((tx) => planPriceFor(tx, rowOf(f, "container_service", stored))),
    ).toMatchObject({ state: "applied", productId: big });
    const { r, charged } = await renewTwoDaysBefore(f);
    expect(r.ok).toBe(true);
    expect(charged).toBe(await total("container_service", "40"));
    expect(await applyOps(f.resourceId)).toHaveLength(0);
  });

  it("a CDN apply failure does the same, and other kinds change nothing", async () => {
    const small = await product("cdn", "small_1_0", "5");
    const big = await product("cdn", "large_1_0", "20", { region: reg(small) });
    const config = {
      region: reg(small),
      appliedPlan: { productId: small },
      pendingPlan: { productId: big },
    };
    const f = await fresh("cdn", config);
    await asWorker((tx) =>
      lifecycleHooks({ clock: kit.clock }).needsAttention(tx, failEvent(f, "reboot")),
    );
    expect(await configOf(f.resourceId)).not.toHaveProperty("pendingPlanFailed");
    await asWorker((tx) =>
      lifecycleHooks({ clock: kit.clock }).needsAttention(
        tx,
        failEvent(f, "change_cdn_bundle", "lease_expired"),
      ),
    );
    expect(await configOf(f.resourceId)).toMatchObject({
      pendingPlanFailed: { code: "lease_expired" },
    });
    const { charged } = await renewTwoDaysBefore(f);
    expect(charged).toBe(await total("cdn", "5"));
  });
});

describe("WPU-S2: the operations that renewNow inserts reach the queue through the sweeper", () => {
  it("a queued apply row without a message is sent by the sweep once it is stale (renewNow sends none)", async () => {
    const big = await product("container_service", "large", "40");
    const config = { region: reg(big), pendingPlan: { productId: big } };
    const f = await fresh("container_service", config);
    const { r } = await renewTwoDaysBefore(f);
    expect(r.ok).toBe(true);
    const [op] = await q(
      "select id, state from operations where resource_id = $1 and kind = 'scale_container'",
      [f.resourceId],
    );
    expect(op!.state).toBe("queued");
    const clock = { now: () => new Date(Date.now() + 3 * 60_000) };
    const queue = createMemoryQueue({ clock });
    const report = await sweepOperations({
      runTx: asWorker,
      clock,
      queue,
      limit: 1000,
    });
    expect(report.resent).toBeGreaterThanOrEqual(1);
    const ids = queue.messages.map(
      (m) => (JSON.parse(m.MessageBody) as { operationId: string }).operationId,
    );
    expect(ids).toContain(op!.id);
  });
});

// WPU-S3: a downgrade whose apply fails after the charge cannot be repeated for the discount.
describe("WPU-S3: the failure mark and the repeated cycle", () => {
  const dateOf = async (column: string, subscriptionId: string): Promise<Date> =>
    new Date(
      String(
        (await q(`select ${column} as d from subscriptions where id = $1`, [subscriptionId]))[0]!.d,
      ),
    );
  const failApply = (f: Fresh, kind: string) =>
    asWorker((tx) =>
      lifecycleHooks({ clock: kit.clock }).needsAttention(tx, {
        resourceId: f.resourceId,
        kind,
        code: "conflict",
      }),
    );

  it("the mark holds the code, the failed product and the period of the charge", async () => {
    const big = await product("container_service", "large", "40");
    const small = await product("container_service", "small", "5", { region: reg(big) });
    const config = {
      region: reg(big),
      appliedPlan: { productId: big },
      pendingPlan: { productId: small },
    };
    const f = await fresh("container_service", config);
    const { r } = await renewTwoDaysBefore(f);
    expect(r.ok).toBe(true);
    await failApply(f, "scale_container");
    expect((await configOf(f.resourceId)).pendingPlanFailed).toEqual({
      code: "conflict",
      productId: small,
      period: (await dateOf("period_start", f.subscriptionId)).toISOString(),
    });
  });

  it("the cycle cannot be repeated: after the failed apply the next renewal charges the applied plan", async () => {
    const big = await product("container_service", "large", "40");
    const small = await product("container_service", "small", "5", { region: reg(big) });
    const config = {
      region: reg(big),
      appliedPlan: { productId: big },
      pendingPlan: { productId: small },
    };
    const f = await fresh("container_service", config);
    const first = await renewTwoDaysBefore(f);
    // WPU-S4: the downgrade is charged at the applied (current) plan before the apply has run.
    expect(first.charged).toBe(await total("container_service", "40"));
    await failApply(f, "scale_container");
    const end2 = await dateOf("period_end", f.subscriptionId);
    const second = await renewTwoDaysBefore({ ...f, end: end2 });
    expect(second.r.ok).toBe(true);
    // The customer still has the bigger capacity: the second period costs the applied plan.
    expect(second.charged).toBe(await total("container_service", "40"));
    expect(await applyOps(f.resourceId)).toHaveLength(1);
  });

  it("a different pending product after the failure is quoted on its own (it may be scheduled)", async () => {
    const big = await product("container_service", "large", "40");
    const small = await product("container_service", "small", "5", { region: reg(big) });
    const mid = await product("container_service", "medium", "20", { region: reg(big) });
    const config = {
      region: reg(big),
      appliedPlan: { productId: big },
      pendingPlan: { productId: mid },
      pendingPlanFailed: { code: "conflict", productId: small, period: "2026-11-01T00:00:00.000Z" },
    };
    const f = await fresh("container_service", config);
    expect(
      await asWeb((tx) => planPriceFor(tx, rowOf(f, "container_service", config))),
    ).toMatchObject({ state: "pending", productId: mid });
    const same = { ...config, pendingPlan: { productId: small } };
    expect(
      await asWeb((tx) => planPriceFor(tx, rowOf(f, "container_service", same))),
    ).toMatchObject({ state: "applied", productId: big });
  });

  it("an upgrade is unaffected: charged the new plan and applied once", async () => {
    const small = await product("cdn", "small_1_0", "5");
    const big = await product("cdn", "large_1_0", "20", { region: reg(small) });
    const config = {
      region: reg(small),
      appliedPlan: { productId: small },
      pendingPlan: { productId: big },
    };
    const f = await fresh("cdn", config);
    const { r, charged } = await renewTwoDaysBefore(f);
    expect(r.ok).toBe(true);
    expect(charged).toBe(await total("cdn", "20"));
    expect(await applyOps(f.resourceId)).toHaveLength(1);
    expect(await configOf(f.resourceId)).not.toHaveProperty("pendingPlanFailed");
  });
});

// WPU-S4. Ruling: renewal never charges less than the plan the resource actually has. The quote is the
// catalog price of max(applied plan, pending plan) through the pricing engine; the applied plan is
// `config.appliedPlan`, or the stored snapshot price when none was applied yet. An upgrade is charged at
// the higher pending price (the capacity follows right after the charge); a downgrade is charged at the
// current price for that term and the next renewal quotes the lower applied plan. A failed or blocked
// apply of a downgrade therefore never gives a discount, whatever the state, the mark or the race.
describe("WPU-S4: the renewal charges the higher of the applied and the pending plan", () => {
  const plans = async () => {
    const big = await product("container_service", "large", "40");
    const small = await product("container_service", "small", "5", { region: reg(big) });
    const mid = await product("container_service", "medium", "20", { region: reg(big) });
    return { big, small, mid };
  };
  const attention = (f: Fresh, extra: Record<string, unknown> = {}) =>
    asWorker((tx) =>
      lifecycleHooks({ clock: kit.clock }).needsAttention(tx, {
        resourceId: f.resourceId,
        kind: "scale_container",
        code: "conflict",
        ...extra,
      } as never),
    );
  /** What the adapter writes after the apply succeeded (scale_container). */
  const applied = (f: Fresh, id: string) =>
    q(
      "update resources set config = (config || $2::jsonb) - 'pendingPlan' - 'pendingPlanFailed' where id = $1",
      [f.resourceId, JSON.stringify({ appliedPlan: { productId: id } })],
    );
  const nextPeriod = async (f: Fresh): Promise<Fresh> => {
    const rows = await q("select period_end as d from subscriptions where id = $1", [
      f.subscriptionId,
    ]);
    return { ...f, end: new Date(String(rows[0]!.d)) };
  };

  it("a downgrade is charged at the current price and the next period at the lower price", async () => {
    const { big, small } = await plans();
    const config = {
      region: reg(big),
      appliedPlan: { productId: big },
      pendingPlan: { productId: small },
    };
    const f = await fresh("container_service", config);
    const first = await renewTwoDaysBefore(f);
    expect(first.r.ok).toBe(true);
    expect(first.charged).toBe(await total("container_service", "40"));
    expect(await applyOps(f.resourceId)).toHaveLength(1);
    await applied(f, small); // the apply succeeded
    const second = await renewTwoDaysBefore(await nextPeriod(f));
    expect(second.r.ok).toBe(true);
    expect(second.charged).toBe(await total("container_service", "5"));
    expect(await applyOps(f.resourceId)).toHaveLength(1);
  });

  it("an upgrade is charged at the higher pending price and applied once", async () => {
    const { big, small } = await plans();
    const config = {
      region: reg(big),
      appliedPlan: { productId: small },
      pendingPlan: { productId: big },
    };
    const f = await fresh("container_service", config);
    const first = await renewTwoDaysBefore(f);
    expect(first.charged).toBe(await total("container_service", "40"));
    expect(await applyOps(f.resourceId)).toHaveLength(1);
  });

  it("the same price on both sides is charged that price and the apply is still queued", async () => {
    const { big } = await plans();
    const twin = await product("container_service", "xlarge", "40", { region: reg(big) });
    const config = {
      region: reg(big),
      appliedPlan: { productId: big },
      pendingPlan: { productId: twin },
    };
    const f = await fresh("container_service", config);
    const first = await renewTwoDaysBefore(f);
    expect(first.charged).toBe(await total("container_service", "40"));
    expect(await applyOps(f.resourceId)).toHaveLength(1);
  });

  it("stop after the charge of a downgrade gives no discount, now or when the resource is started again", async () => {
    const { big, small } = await plans();
    const config = {
      region: reg(big),
      appliedPlan: { productId: big },
      pendingPlan: { productId: small },
    };
    const f = await fresh("container_service", config);
    const first = await renewTwoDaysBefore(f);
    expect(first.charged).toBe(await total("container_service", "40"));
    // The race: the resource is stopped between the charge and the apply; the apply conflicts and
    // ends in needs_attention (the web busy check is only a secondary defence).
    await q("update resources set state = 'stopped' where id = $1", [f.resourceId]);
    await attention(f);
    const second = await renewTwoDaysBefore(await nextPeriod(f));
    expect(second.charged).toBe(await total("container_service", "40"));
    await q("update resources set state = 'active' where id = $1", [f.resourceId]);
    // Even with the failure mark gone the correctness does not depend on it.
    await q("update resources set config = config - 'pendingPlanFailed' where id = $1", [
      f.resourceId,
    ]);
    const third = await renewTwoDaysBefore(await nextPeriod(f));
    expect(third.charged).toBe(await total("container_service", "40"));
  });

  it("a downgrade whose apply failed is charged the applied price in every later period", async () => {
    const { big, small } = await plans();
    const config = {
      region: reg(big),
      appliedPlan: { productId: big },
      pendingPlan: { productId: small },
    };
    const f = await fresh("container_service", config);
    let at = f;
    for (let i = 0; i < 3; i += 1) {
      const step = await renewTwoDaysBefore(at);
      expect(step.charged).toBe(await total("container_service", "40"));
      await attention(f);
      at = await nextPeriod(f);
    }
  });

  it("without an applied plan the stored snapshot price is the floor of a pending downgrade", async () => {
    const { big } = await plans();
    const cheap = await product("container_service", "nano", "2", { region: reg(big) });
    const config = { region: reg(big), pendingPlan: { productId: cheap } };
    const f = await fresh("container_service", config);
    // The snapshot of the paid server is priced at 5 (see the first case of this file).
    const first = await renewTwoDaysBefore(f);
    expect(first.r.ok).toBe(true);
    expect(first.charged).toBe(await total("container_service", "5"));
    expect(await applyOps(f.resourceId)).toHaveLength(1);
  });

  it("an applied plan that cannot be read refuses the renewal even when a pending plan is usable (R16)", async () => {
    const { big, small } = await plans();
    const config = {
      region: reg(big),
      appliedPlan: { productId: "0190aaaa-0000-7000-8000-0000000000fe" },
      pendingPlan: { productId: small },
    };
    const f = await fresh("container_service", config);
    expect(await asWeb((tx) => planPriceFor(tx, rowOf(f, "container_service", config)))).toEqual({
      state: "unreadable",
    });
    const before = await kit.balance(f.customerId);
    kit.clock.set(new Date(f.end.getTime() - 2 * DAY));
    const r = await asWeb((tx) =>
      renewNow(tx, { customerId: f.customerId, resourceId: f.resourceId, clock: kit.clock }),
    );
    expect(r.ok).toBe(false);
    expect(await kit.balance(f.customerId)).toBe(before);
    expect(await applyOps(f.resourceId)).toHaveLength(0);
  });

  it("the quote of a pending downgrade carries the floor and is priced at the floor", async () => {
    const { big, small } = await plans();
    const config = {
      region: reg(big),
      appliedPlan: { productId: big },
      pendingPlan: { productId: small },
    };
    const f = await fresh("container_service", config);
    expect(
      await asWeb((tx) => planPriceFor(tx, rowOf(f, "container_service", config))),
    ).toMatchObject({
      state: "pending",
      productId: small,
      awsPriceUsd: "5.0000",
      floorAwsPriceUsd: "40.0000",
    });
    const quoted = await asWeb((tx) =>
      renewalQuote(tx, rowOf(f, "container_service", config), kit.clock),
    );
    expect(quoted.ok && quoted.value.awsPriceUsd).toBe("40.0000");
  });

  it("the failure mark takes the product from the failed operation, not from the live config", async () => {
    const { big, small, mid } = await plans();
    const config = {
      region: reg(big),
      appliedPlan: { productId: big },
      pendingPlan: { productId: small },
    };
    const f = await fresh("container_service", config);
    await renewTwoDaysBefore(f);
    const [op] = await q(
      "select id from operations where resource_id = $1 and kind = 'scale_container'",
      [f.resourceId],
    );
    // The customer re-schedules another plan after the charge; the live config now says mid.
    await q("update resources set config = config || $2::jsonb where id = $1", [
      f.resourceId,
      JSON.stringify({ pendingPlan: { productId: mid } }),
    ]);
    await attention(f, { operationId: String(op!.id) });
    const mark = (await configOf(f.resourceId)).pendingPlanFailed as { productId: string };
    expect(mark.productId).toBe(small);
  });
});
