// WPU-G8: a power, scale or bundle change takes effect at the NEXT renewal (ruling: no proration in a
// prepaid term). The pending plan lives in the resource config; the renewal quote reads its price
// through the pricing engine; the renewal queues the operation that applies it. Run against the temp
// database as web_rw, like renewNow, so a missing grant shows here.
import { lifecycleRepo } from "@tc/db";
import { insertRow, runTransaction, uniqueSuffix, useTempDatabase } from "@tc/db/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { createMemoryQueue } from "../operations/queue";
import { sweepOperations } from "../operations/sweep";
import { quoteInForce } from "../rates/in-force";
import { makeKit, placeOne, START, type Kit } from "../test/orders-kit";
import { runLifecycle } from "./engine";
import { lifecycleHooks } from "./hooks";
import {
  PLAN_APPLY_LEAD_HOURS,
  PLAN_APPLY_STATES,
  PLAN_APPLY_WAIT_HOURS,
  planApplyStale,
  planPriceFor,
  queuePlanApply,
  readPlanApplyPayload,
  readPlanChange,
} from "./plan-change";
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
async function fresh(
  family: string,
  config: Record<string, unknown>,
  autoRenew = true,
): Promise<Fresh> {
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
  // WPU-S7: an UPGRADE is applied only when autoRenew is on (and the wallet covers it); the fixtures
  // of the earlier tests are renewing customers with a full wallet.
  await q("update subscriptions set auto_renew = $2 where id = $1", [String(s.id), autoRenew]);
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
  kit = await makeKit(t, {
    balanceMinor: 50_000_000n,
    vcpuLimit: 4000,
    ipLimit: 4000,
    keepFxFresh: true,
  });
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

  it("never prices a pending plan: the quote is the snapshot price, whatever is pending (WPU-S5)", async () => {
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
        { market: "BD", productFamily: "container_service", awsPriceUsd: "5" },
        kit.clock,
      ),
    );
    expect(quoted.ok && engine.ok).toBe(true);
    if (quoted.ok && engine.ok) {
      expect(quoted.value.totalMinor).toBe(engine.value.snapshot.totalMinor);
      expect(quoted.value.awsPriceUsd).toBe("5.0000");
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
  it("charges the plan the resource has and queues no apply operation (WPU-S5)", async () => {
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
        { market: "BD", productFamily: "container_service", awsPriceUsd: "5" },
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
    expect(
      await q("select 1 from operations where resource_id = $1 and kind = 'scale_container'", [
        f.resourceId,
      ]),
    ).toHaveLength(0);
    expect(await configOf(f.resourceId)).toMatchObject({ pendingPlan: { productId: big } });
  });

  it("a CDN renewal queues no change_cdn_bundle either, with or without a pending plan", async () => {
    const big = await product("cdn", "large_1_0", "20");
    for (const config of [
      { region: reg(big), pendingPlan: { productId: big } },
      { region: "xx" },
    ]) {
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
      ).toHaveLength(0);
    }
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

/** What the scheduler does in the lead window: queue the apply of the pending plan (WPU-S5). */
const leadQueue = (f: Fresh, hoursBefore = 12) => {
  kit.clock.set(new Date(f.end.getTime() - hoursBefore * 3_600_000));
  return asWorker(async (tx) => {
    const row = await lifecycleRepo(tx).lock(f.subscriptionId);
    if (row === null) throw new Error("no subscription");
    return queuePlanApply(tx, row, kit.clock.now());
  });
};

describe("PLAN_APPLY_STATES (the states in which the adapter action accepts the apply)", () => {
  it("is active only, for both plan families; the adapters refuse every other state", () => {
    expect(PLAN_APPLY_STATES).toEqual({
      container_service: ["active"],
      cdn: ["active"],
    });
  });
});

describe("WPU-S2: the pending price is charged only when the apply can run", () => {
  it("planPriceFor never returns the pending plan (WPU-S5); the apply is queued only in an apply state", async () => {
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
    for (const state of ["stopped", "suspended", "provisioning", "retained", "active"]) {
      expect(
        await asWeb((tx) => planPriceFor(tx, rowOf(f, "container_service", config, state))),
      ).toMatchObject({ state: "applied", productId: big });
    }
    for (const state of ["stopped", "suspended", "creating", "failed"]) {
      await q("update resources set state = $2 where id = $1", [f.resourceId, state]);
      kit.clock.set(new Date(f.end.getTime() - 12 * 3_600_000));
      expect(await leadQueue(f)).toBeNull();
    }
    expect(await applyOps(f.resourceId)).toHaveLength(0);
    await q("update resources set state = 'active' where id = $1", [f.resourceId]);
    expect(await leadQueue(f)).not.toBeNull();
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

  it("downgrade active renewed by renewNow with the apply not done: charged the CURRENT price, nothing is queued by the renewal (WPU-S5)", async () => {
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
    expect(await applyOps(f.resourceId)).toHaveLength(0);
    const again = await asWeb((tx) =>
      renewNow(tx, {
        customerId: f.customerId,
        resourceId: f.resourceId,
        clock: kit.clock,
      }),
    );
    expect(again.ok).toBe(false);
    expect(await applyOps(f.resourceId)).toHaveLength(0);
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

describe("WPU-S2: the apply operation that the scheduler inserts reaches the queue through the sweeper", () => {
  it("a queued apply row without a message is sent by the sweep once it is stale", async () => {
    const big = await product("container_service", "large", "40");
    const config = { region: reg(big), pendingPlan: { productId: big } };
    const f = await fresh("container_service", config);
    expect(await leadQueue(f)).not.toBeNull();
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
  const failApply = async (f: Fresh, kind: string) => {
    // WPU-S7: a failed apply is over (needs_attention), so it no longer makes the renewal wait.
    await q(
      "update operations set state = 'needs_attention' where resource_id = $1 and kind = $2 and state in ('queued','running')",
      [f.resourceId, kind],
    );
    await asWorker((tx) =>
      lifecycleHooks({ clock: kit.clock }).needsAttention(tx, {
        resourceId: f.resourceId,
        kind,
        code: "conflict",
      }),
    );
  };

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
    // WPU-S5: the apply is queued in the lead window and fails; the renewal charges the applied plan.
    expect(await leadQueue(f)).not.toBeNull();
    await failApply(f, "scale_container");
    const first = await renewTwoDaysBefore(f);
    expect(first.charged).toBe(await total("container_service", "40"));
    const end2 = await dateOf("period_end", f.subscriptionId);
    const second = await renewTwoDaysBefore({ ...f, end: end2 });
    expect(second.r.ok).toBe(true);
    // The customer still has the bigger capacity: the second period costs the applied plan.
    expect(second.charged).toBe(await total("container_service", "40"));
    // The mark stops a second apply: one operation in all.
    expect(await leadQueue({ ...f, end: end2 })).toBeNull();
    expect(await applyOps(f.resourceId)).toHaveLength(1);
  });

  it("a different pending product after the failure may be applied; the failed one is not queued again", async () => {
    const big = await product("container_service", "large", "40");
    const small = await product("container_service", "small", "5", { region: reg(big) });
    const mid = await product("container_service", "medium", "20", { region: reg(big) });
    const config = {
      region: reg(big),
      appliedPlan: { productId: big },
      pendingPlan: { productId: small },
      pendingPlanFailed: { code: "conflict", productId: small, period: "2026-11-01T00:00:00.000Z" },
    };
    const f = await fresh("container_service", config);
    expect(
      await asWeb((tx) => planPriceFor(tx, rowOf(f, "container_service", config))),
    ).toMatchObject({ state: "applied", productId: big });
    expect(await leadQueue(f)).toBeNull();
    await q("update resources set config = config || $2::jsonb where id = $1", [
      f.resourceId,
      JSON.stringify({ pendingPlan: { productId: mid } }),
    ]);
    expect(await leadQueue(f)).not.toBeNull();
    const [op] = await q(
      "select payload from operations where resource_id = $1 and kind = 'scale_container'",
      [f.resourceId],
    );
    expect(op!.payload).toMatchObject({ productId: mid });
  });

  it("an upgrade whose apply has not run is charged the applied plan and applied once (WPU-S5)", async () => {
    const small = await product("cdn", "small_1_0", "5");
    const big = await product("cdn", "large_1_0", "20", { region: reg(small) });
    const config = {
      region: reg(small),
      appliedPlan: { productId: small },
      pendingPlan: { productId: big },
    };
    const f = await fresh("cdn", config);
    expect(await leadQueue(f)).not.toBeNull();
    // WPU-S7: while the apply is queued the renewal is refused (busy); after the bounded wait it
    // charges the applied plan and the late apply is skipped by its period.
    const busy = await renewTwoDaysBefore(f);
    expect(busy.r).toMatchObject({ ok: false, error: "conflict" });
    expect(busy.charged).toBe(0n);
    kit.clock.set(new Date(f.end.getTime() + (PLAN_APPLY_WAIT_HOURS + 1) * 3_600_000));
    const before = await kit.balance(f.customerId);
    const r = await asWeb((tx) =>
      renewNow(tx, { customerId: f.customerId, resourceId: f.resourceId, clock: kit.clock }),
    );
    expect(r.ok).toBe(true);
    expect(before - (await kit.balance(f.customerId))).toBe(await total("cdn", "5"));
    expect(await applyOps(f.resourceId)).toHaveLength(1);
    expect(await configOf(f.resourceId)).not.toHaveProperty("pendingPlanFailed");
  });
});

// WPU-S5. Ruling: the charge follows the delivered capacity (replaces the WPU-S4 max() rule, which the
// money review showed overcharging a downgrade; S4 was NOT owner-approved) — closes both overcharge
// paths and needs no refund — a plan change lands shortly before the renewal, or one term later if the
// apply is late. The scheduler queues the apply a fixed lead time before the renewal is due; the
// renewal prices exactly the applied plan (config.appliedPlan, else the snapshot) and never the pending.
describe("WPU-S5: the charge follows the delivered capacity", () => {
  const plans = async () => {
    const big = await product("container_service", "large", "40");
    const small = await product("container_service", "small", "5", {
      region: reg(big),
    });
    const mid = await product("container_service", "medium", "20", {
      region: reg(big),
    });
    return { big, small, mid };
  };
  const attention = async (f: Fresh, extra: Record<string, unknown> = {}) => {
    // WPU-S7: a failed apply is over (needs_attention), so it no longer makes the renewal wait.
    await q(
      "update operations set state = 'needs_attention' where resource_id = $1 and kind = 'scale_container' and state in ('queued','running')",
      [f.resourceId],
    );
    await asWorker((tx) =>
      lifecycleHooks({ clock: kit.clock }).needsAttention(tx, {
        resourceId: f.resourceId,
        kind: "scale_container",
        code: "conflict",
        ...extra,
      } as never),
    );
  };
  /** What the adapter writes after the apply succeeded (scale_container). */
  const applied = async (f: Fresh, id: string) => {
    await q(
      "update resources set config = (config || $2::jsonb) - 'pendingPlan' - 'pendingPlanFailed' where id = $1",
      [f.resourceId, JSON.stringify({ appliedPlan: { productId: id } })],
    );
    await q("update operations set state = 'succeeded' where resource_id = $1", [f.resourceId]);
  };
  const downgrade = async () => {
    const { big, small } = await plans();
    const f = await fresh("container_service", {
      region: reg(big),
      appliedPlan: { productId: big },
      pendingPlan: { productId: small },
    });
    return { f, big, small };
  };
  const upgrade = async () => {
    const { big, small } = await plans();
    const f = await fresh("container_service", {
      region: reg(big),
      appliedPlan: { productId: small },
      pendingPlan: { productId: big },
    });
    return { f, big, small };
  };
  const run = () => runLifecycle({ runTx: asWorker, clock: kit.clock, log: () => undefined });
  const lockedApply = (f: Fresh) =>
    asWorker(async (tx) => {
      const row = await lifecycleRepo(tx).lock(f.subscriptionId);
      if (row === null) throw new Error("no subscription");
      return queuePlanApply(tx, row, kit.clock.now());
    });

  it("names the lead time: 24 hours before the renewal is due", () => {
    expect(PLAN_APPLY_LEAD_HOURS).toBe(24);
  });

  it("an upgrade applied before the renewal is charged the new price", async () => {
    const { f, big } = await upgrade();
    expect(await leadQueue(f)).not.toBeNull();
    await applied(f, big); // the apply succeeded before the renewal
    const step = await renewTwoDaysBefore(f);
    expect(step.r.ok).toBe(true);
    expect(step.charged).toBe(await total("container_service", "40"));
    expect(await applyOps(f.resourceId)).toHaveLength(1);
  });

  it("a downgrade applied before the renewal is charged the lower price", async () => {
    const { f, small } = await downgrade();
    expect(await leadQueue(f)).not.toBeNull();
    await applied(f, small);
    const step = await renewTwoDaysBefore(f);
    expect(step.r.ok).toBe(true);
    expect(step.charged).toBe(await total("container_service", "5"));
    expect(await applyOps(f.resourceId)).toHaveLength(1);
  });

  it("an apply that failed leaves the old plan at the old price, for an upgrade and for a downgrade", async () => {
    for (const make of [downgrade, upgrade]) {
      const { f, big, small } = await make();
      const isDowngrade = make === downgrade;
      expect(await leadQueue(f)).not.toBeNull();
      const [op] = await q("select id from operations where resource_id = $1", [f.resourceId]);
      await attention(f, { operationId: String(op!.id) });
      const step = await renewTwoDaysBefore(f);
      expect(step.r.ok).toBe(true);
      expect(step.charged).toBe(await total("container_service", isDowngrade ? "40" : "5"));
      expect(await configOf(f.resourceId)).toMatchObject({
        appliedPlan: { productId: isDowngrade ? big : small },
        pendingPlan: { productId: isDowngrade ? small : big },
      });
    }
  });

  it("an apply still queued at the renewal: the renewal waits (WPU-S7), then charges the old price and keeps the pending plan", async () => {
    for (const make of [downgrade, upgrade]) {
      const { f } = await make();
      expect(await leadQueue(f)).not.toBeNull();
      const busy = await renewTwoDaysBefore(f); // the apply operation has not run
      expect(busy.r).toMatchObject({ ok: false, error: "conflict" });
      expect(busy.charged).toBe(0n);
      kit.clock.set(new Date(f.end.getTime() + (PLAN_APPLY_WAIT_HOURS + 1) * 3_600_000));
      const before = await kit.balance(f.customerId);
      const r = await asWeb((tx) =>
        renewNow(tx, { customerId: f.customerId, resourceId: f.resourceId, clock: kit.clock }),
      );
      expect(r.ok).toBe(true);
      expect(before - (await kit.balance(f.customerId))).toBe(
        await total("container_service", make === downgrade ? "40" : "5"),
      );
      expect(await configOf(f.resourceId)).toHaveProperty("pendingPlan");
      expect(await applyOps(f.resourceId)).toHaveLength(1);
    }
  });

  it("the plan applies once in a period: repeated passes and scheduler runs queue one operation (R7)", async () => {
    const { f } = await downgrade();
    expect((await leadQueue(f))?.operationId).toBeTruthy();
    expect(await leadQueue(f, 6)).toBeNull();
    expect(await leadQueue(f, 1)).toBeNull();
    kit.clock.set(new Date(f.end.getTime() - 2 * 3_600_000));
    await run();
    await run();
    expect(await applyOps(f.resourceId)).toHaveLength(1);
  });

  it("the scheduler queues the apply only inside the lead window, never at or after the period end", async () => {
    const { f } = await downgrade();
    kit.clock.set(new Date(f.end.getTime() - 2 * DAY));
    await run();
    expect(await applyOps(f.resourceId)).toHaveLength(0);
    kit.clock.set(new Date(f.end.getTime() - PLAN_APPLY_LEAD_HOURS * 3_600_000 - 60_000));
    await run();
    expect(await applyOps(f.resourceId)).toHaveLength(0);
    kit.clock.set(new Date(f.end.getTime() - PLAN_APPLY_LEAD_HOURS * 3_600_000 + 60_000));
    await run();
    const ops = await q("select kind from operations where resource_id = $1 and kind <> 'create'", [
      f.resourceId,
    ]);
    expect(ops).toEqual([{ kind: "scale_container" }]);
    const late = await downgrade();
    kit.clock.set(new Date(late.f.end.getTime() + 60_000));
    expect(await lockedApply(late.f)).toBeNull();
  });

  it("a resource stopped or suspended before the window gets no apply; one stopped after it conflicts and is charged the old price", async () => {
    const { f } = await downgrade();
    for (const state of ["stopped", "suspended"]) {
      await q("update resources set state = $2 where id = $1", [f.resourceId, state]);
      expect(await leadQueue(f)).toBeNull();
    }
    await q("update resources set state = 'active' where id = $1", [f.resourceId]);
    expect(await leadQueue(f)).not.toBeNull();
    // The race: stopped after the apply was queued; the adapter answers conflict, needs_attention.
    await q("update resources set state = 'stopped' where id = $1", [f.resourceId]);
    await attention(f);
    await q("update resources set state = 'active' where id = $1", [f.resourceId]);
    const step = await renewTwoDaysBefore(f);
    expect(step.charged).toBe(await total("container_service", "40"));
  });

  it("no apply is queued for a subscription in grace, nor for a plan that is off sale", async () => {
    const { f, small } = await downgrade();
    await q("update subscriptions set status = 'grace' where id = $1", [f.subscriptionId]);
    expect(await leadQueue(f)).toBeNull();
    await q("update subscriptions set status = 'active' where id = $1", [f.subscriptionId]);
    await q("update catalog_products set active = false where id = $1", [small]);
    expect(await leadQueue(f)).toBeNull();
    expect(await applyOps(f.resourceId)).toHaveLength(0);
    await q("update catalog_products set active = true where id = $1", [small]);
    expect(await leadQueue(f)).not.toBeNull();
  });

  it("without an applied plan the stored snapshot price is charged whatever is pending", async () => {
    const { big } = await plans();
    const cheap = await product("container_service", "nano", "2", {
      region: reg(big),
    });
    const f = await fresh("container_service", {
      region: reg(big),
      pendingPlan: { productId: cheap },
    });
    const first = await renewTwoDaysBefore(f);
    expect(first.r.ok).toBe(true);
    expect(first.charged).toBe(await total("container_service", "5"));
  });

  it("an applied plan that cannot be read refuses the renewal and queues no apply (R16)", async () => {
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
    expect(await leadQueue(f)).toBeNull();
    const before = await kit.balance(f.customerId);
    kit.clock.set(new Date(f.end.getTime() - 2 * DAY));
    const r = await asWeb((tx) =>
      renewNow(tx, {
        customerId: f.customerId,
        resourceId: f.resourceId,
        clock: kit.clock,
      }),
    );
    expect(r.ok).toBe(false);
    expect(await kit.balance(f.customerId)).toBe(before);
    expect(await applyOps(f.resourceId)).toHaveLength(0);
  });

  it("the scheduler's own renewal at the period end charges the applied plan (the engine path)", async () => {
    const { f, small } = await downgrade();
    await q("update subscriptions set auto_renew = true where id = $1", [f.subscriptionId]);
    kit.clock.set(new Date(f.end.getTime() - 12 * 3_600_000));
    await run();
    expect(await applyOps(f.resourceId)).toHaveLength(1);
    await applied(f, small);
    kit.clock.set(new Date(f.end.getTime() + 60_000));
    const before = await kit.balance(f.customerId);
    await run();
    expect(before - (await kit.balance(f.customerId))).toBe(await total("container_service", "5"));
    expect(await applyOps(f.resourceId)).toHaveLength(1);
  });

  it("the failure mark takes the product from the failed operation, not from the live config", async () => {
    const { big, small, mid } = await plans();
    const config = {
      region: reg(big),
      appliedPlan: { productId: big },
      pendingPlan: { productId: small },
    };
    const f = await fresh("container_service", config);
    expect(await leadQueue(f)).not.toBeNull();
    const [op] = await q(
      "select id from operations where resource_id = $1 and kind = 'scale_container'",
      [f.resourceId],
    );
    // The customer re-schedules another plan after the apply was queued; the live config now says mid.
    await q("update resources set config = config || $2::jsonb where id = $1", [
      f.resourceId,
      JSON.stringify({ pendingPlan: { productId: mid } }),
    ]);
    await attention(f, { operationId: String(op!.id) });
    const mark = (await configOf(f.resourceId)).pendingPlanFailed as {
      productId: string;
    };
    expect(mark.productId).toBe(small);
  });
});
// WPU-S7. Ruling: the apply is bound to its period and to the money — an apply that finishes after the
// renewal charged the old plan is refused (period end in the payload, checked by both adapters); the
// renewal waits (bounded) for an apply of the current period; an UPGRADE is queued only when the
// renewal can be paid (autoRenew on, wallet covers the pending plan's price, a guard that is never
// posted), a DOWNGRADE always — closes the late-apply and unpaid-capacity holes, no refund is needed —
// if wrong, a renewal is delayed by at most PLAN_APPLY_WAIT_HOURS or an upgrade waits one more term.
describe("WPU-S7: the apply is bound to its period and to the money", () => {
  const plans = async () => {
    const big = await product("container_service", "large", "40");
    const small = await product("container_service", "small", "5", {
      region: reg(big),
    });
    return { big, small };
  };
  const make = async (kind: "downgrade" | "upgrade", autoRenew = true) => {
    const { big, small } = await plans();
    const f = await fresh(
      "container_service",
      {
        region: reg(big),
        appliedPlan: { productId: kind === "downgrade" ? big : small },
        pendingPlan: { productId: kind === "downgrade" ? small : big },
      },
      autoRenew,
    );
    return { f, big, small };
  };
  const logs: Record<string, unknown>[] = [];
  const run = () =>
    runLifecycle({
      runTx: asWorker,
      clock: kit.clock,
      log: (e) => void logs.push({ ...e }),
    });
  const at = (f: Fresh, ms: number) => kit.clock.set(new Date(f.end.getTime() + ms));
  const HOUR = 3_600_000;
  const finishApply = async (f: Fresh, id: string) => {
    await q(
      "update resources set config = (config || $2::jsonb) - 'pendingPlan' - 'pendingPlanFailed' where id = $1",
      [f.resourceId, JSON.stringify({ appliedPlan: { productId: id } })],
    );
    await q("update operations set state = 'succeeded' where resource_id = $1", [f.resourceId]);
  };
  const setWallet = (f: Fresh, minor: bigint) =>
    q("update wallets set balance_minor = $2 where customer_id = $1", [
      f.customerId,
      minor.toString(),
    ]);
  const periodEnd = async (f: Fresh) =>
    new Date(
      String(
        (await q("select period_end as d from subscriptions where id = $1", [f.subscriptionId]))[0]!
          .d,
      ),
    );
  const charge = async (f: Fresh, action: () => Promise<unknown>) => {
    const before = await kit.balance(f.customerId);
    await action();
    return before - (await kit.balance(f.customerId));
  };

  it("names the wait: 6 hours past the due time", () => {
    expect(PLAN_APPLY_WAIT_HOURS).toBe(6);
  });

  it("the apply payload names the subscription, the product and the period end it was queued for", async () => {
    const { f, small } = await make("downgrade");
    const queued = await leadQueue(f);
    expect(queued).not.toBeNull();
    const [op] = await q("select payload, idempotency_key from operations where id = $1", [
      queued!.operationId,
    ]);
    expect(op!.payload).toEqual({
      subscriptionId: f.subscriptionId,
      productId: small,
      periodEnd: f.end.toISOString(),
    });
    expect(op!.idempotency_key).toBe(
      `lifecycle:plan-change:${f.subscriptionId}:${f.end.toISOString()}`,
    );
    const read = readPlanApplyPayload(op!.payload);
    expect(read.periodEnd?.getTime()).toBe(f.end.getTime());
    expect(planApplyStale(read.periodEnd, f.end)).toBe(false);
  });

  it("an apply that would finish after the renewal is refused: the payload period is no longer the subscription's", async () => {
    const { f, big } = await make("downgrade");
    expect(await leadQueue(f)).not.toBeNull();
    const [op] = await q(
      "select id, payload from operations where resource_id = $1 and kind = 'scale_container'",
      [f.resourceId],
    );
    // The apply is stuck; after the wait the renewal charges the applied plan and moves the period.
    at(f, (PLAN_APPLY_WAIT_HOURS + 1) * HOUR);
    const paid = await charge(f, run);
    expect(paid).toBe(await total("container_service", "40"));
    const now = await periodEnd(f);
    expect(now.getTime()).toBeGreaterThan(f.end.getTime());
    const queuedFor = readPlanApplyPayload(op!.payload).periodEnd;
    expect(planApplyStale(queuedFor, now)).toBe(true);
    // Ops are told once, in the config and in the log, with ids only (R14).
    expect((await configOf(f.resourceId)).planApplyLate).toEqual({
      operationId: String(op!.id),
      periodEnd: f.end.toISOString(),
    });
    expect(
      logs.filter((l) => l.action === "plan_apply_late" && l.subscriptionId === f.subscriptionId),
    ).toEqual([
      expect.objectContaining({
        subscriptionId: f.subscriptionId,
        operationId: String(op!.id),
      }),
    ]);
    expect(await configOf(f.resourceId)).toMatchObject({
      appliedPlan: { productId: big },
    });
  });

  it("the success hook of an apply that ran for a moved period leaves a notice; a skipped or timely apply leaves none", async () => {
    const { f, small } = await make("downgrade");
    const queued = await leadQueue(f);
    const id = queued!.operationId;
    const succeeded = () =>
      asWorker((tx) =>
        lifecycleHooks({ clock: kit.clock }).succeeded(tx, {
          operationId: id,
          resourceId: f.resourceId,
          customerId: f.customerId,
          kind: "scale_container",
        }),
      );
    await succeeded(); // the period has not moved: no notice
    expect(await configOf(f.resourceId)).not.toHaveProperty("planApplyLate");
    at(f, (PLAN_APPLY_WAIT_HOURS + 1) * HOUR);
    await run(); // the renewal moved the period (the log and the notice come from the wait)
    await q("update resources set config = config - 'planApplyLate' where id = $1", [f.resourceId]);
    await q("update resources set config = config || $2::jsonb where id = $1", [
      f.resourceId,
      JSON.stringify({
        planApplySkipped: { operationId: id, reason: "period_moved" },
      }),
    ]);
    await succeeded(); // skipped by the adapter: no notice
    expect(await configOf(f.resourceId)).not.toHaveProperty("planApplyLate");
    await q("update resources set config = config - 'planApplySkipped' where id = $1", [
      f.resourceId,
    ]);
    await succeeded(); // it really ran after the renewal: a notice
    expect((await configOf(f.resourceId)).planApplyLate).toMatchObject({
      operationId: id,
    });
    expect(small).toBeTruthy();
  });

  it("the renewal is deferred while the apply of this period is queued or running: no charge, no grace, no failure", async () => {
    for (const kind of ["downgrade", "upgrade"] as const) {
      const { f } = await make(kind);
      expect(await leadQueue(f)).not.toBeNull();
      for (const state of ["queued", "running"]) {
        await q("update operations set state = $2 where resource_id = $1", [f.resourceId, state]);
        for (const ms of [60_000, 3 * HOUR, (PLAN_APPLY_WAIT_HOURS - 1) * HOUR]) {
          at(f, ms);
          const before = await kit.balance(f.customerId);
          await run();
          expect(await kit.balance(f.customerId)).toBe(before);
          expect((await periodEnd(f)).getTime()).toBe(f.end.getTime());
          const [sub] = await q("select status from subscriptions where id = $1", [
            f.subscriptionId,
          ]);
          expect(sub!.status).toBe("active");
        }
      }
    }
  });

  it("after the bounded wait the renewal charges the applied plan once, however often the sweep runs", async () => {
    for (const kind of ["downgrade", "upgrade"] as const) {
      const { f } = await make(kind);
      expect(await leadQueue(f)).not.toBeNull();
      at(f, PLAN_APPLY_WAIT_HOURS * HOUR + 60_000);
      const paid = await charge(f, async () => {
        await run();
        await run();
        await run();
      });
      expect(paid).toBe(await total("container_service", kind === "downgrade" ? "40" : "5"));
      expect(await configOf(f.resourceId)).toHaveProperty("pendingPlan");
      expect(await applyOps(f.resourceId)).toHaveLength(1); // no second apply, no double charge
    }
  });

  it("an apply that finished before the due time does not make the renewal wait: it charges the new plan at once", async () => {
    const { f, small } = await make("downgrade");
    expect(await leadQueue(f)).not.toBeNull();
    await finishApply(f, small);
    at(f, 60_000);
    const paid = await charge(f, run);
    expect(paid).toBe(await total("container_service", "5"));
  });

  it("an apply that failed (needs_attention) does not make the renewal wait", async () => {
    const { f } = await make("downgrade");
    expect(await leadQueue(f)).not.toBeNull();
    await q("update operations set state = 'needs_attention' where resource_id = $1", [
      f.resourceId,
    ]);
    at(f, 60_000);
    expect(await charge(f, run)).toBe(await total("container_service", "40"));
  });

  it("renewNow follows the same rule: busy while the apply of this period runs, the applied plan after the wait", async () => {
    const { f } = await make("upgrade");
    expect(await leadQueue(f)).not.toBeNull();
    at(f, -2 * HOUR);
    const busy = await asWeb((tx) =>
      renewNow(tx, {
        customerId: f.customerId,
        resourceId: f.resourceId,
        clock: kit.clock,
      }),
    );
    expect(busy).toMatchObject({
      ok: false,
      error: "conflict",
      fields: { subscription: "busy" },
    });
    at(f, PLAN_APPLY_WAIT_HOURS * HOUR + 1);
    const paid = await charge(f, async () => {
      const r = await asWeb((tx) =>
        renewNow(tx, {
          customerId: f.customerId,
          resourceId: f.resourceId,
          clock: kit.clock,
        }),
      );
      expect(r.ok).toBe(true);
    });
    expect(paid).toBe(await total("container_service", "5"));
  });

  it("a renewal that cannot be paid still goes to grace as before: at once without an apply, after the wait with a stuck one", async () => {
    const { f } = await make("downgrade");
    await setWallet(f, 0n);
    at(f, 60_000);
    await run();
    const [free] = await q("select status from subscriptions where id = $1", [f.subscriptionId]);
    expect(free!.status).toBe("grace");

    const other = await make("downgrade");
    await setWallet(other.f, 0n);
    expect(await leadQueue(other.f)).not.toBeNull(); // a downgrade is queued whatever the wallet
    at(other.f, 60_000);
    await run();
    const [held] = await q("select status from subscriptions where id = $1", [
      other.f.subscriptionId,
    ]);
    expect(held!.status).toBe("active"); // deferred, not failed
    at(other.f, (PLAN_APPLY_WAIT_HOURS + 1) * HOUR);
    await run();
    const [late] = await q("select status from subscriptions where id = $1", [
      other.f.subscriptionId,
    ]);
    expect(late!.status).toBe("grace");
  });

  it("an upgrade is not applied with an empty wallet, with autoRenew off, or one paisa short; the pending plan stays", async () => {
    const cost = await total("container_service", "40");
    const empty = await make("upgrade");
    await setWallet(empty.f, 0n);
    expect(await leadQueue(empty.f)).toBeNull();
    expect(await applyOps(empty.f.resourceId)).toHaveLength(0);
    expect(await configOf(empty.f.resourceId)).toMatchObject({
      pendingPlan: { productId: empty.big },
      appliedPlan: { productId: empty.small },
    });

    const off = await make("upgrade", false);
    expect(await leadQueue(off.f)).toBeNull();
    expect(await applyOps(off.f.resourceId)).toHaveLength(0);

    const short = await make("upgrade");
    await setWallet(short.f, cost - 1n);
    expect(await leadQueue(short.f)).toBeNull();

    // The scheduler path asks the same: nothing is queued by a run in the lead window either.
    kit.clock.set(new Date(short.f.end.getTime() - 12 * HOUR));
    await run();
    expect(await applyOps(short.f.resourceId)).toHaveLength(0);
  });

  it("an upgrade is applied when autoRenew is on and the wallet covers the new price exactly; the guard posts nothing", async () => {
    const cost = await total("container_service", "40");
    const { f } = await make("upgrade");
    await setWallet(f, cost);
    const before = await q("select count(*)::int as n from ledger_transactions", []);
    expect(await leadQueue(f)).not.toBeNull();
    const after = await q("select count(*)::int as n from ledger_transactions", []);
    expect(after[0]!.n).toBe(before[0]!.n);
    expect(await kit.balance(f.customerId)).toBe(cost);
  });

  it("a downgrade is always applied: autoRenew off and an empty wallet do not stop it", async () => {
    const { f } = await make("downgrade", false);
    await setWallet(f, 0n);
    expect(await leadQueue(f)).not.toBeNull();
    expect(await applyOps(f.resourceId)).toHaveLength(1);
  });

  it("a pending plan that costs the same is applied like a downgrade (no extra capacity charge)", async () => {
    const big = await product("container_service", "large", "40");
    const twin = await product("container_service", "medium", "40", {
      region: reg(big),
    });
    const f = await fresh(
      "container_service",
      {
        region: reg(big),
        appliedPlan: { productId: big },
        pendingPlan: { productId: twin },
      },
      false,
    );
    await setWallet(f, 0n);
    expect(await leadQueue(f)).not.toBeNull();
  });

  it("the period the adapters read is the subscription's own, for this resource and this customer only", async () => {
    const { f } = await make("downgrade");
    const other = await make("downgrade");
    const read = (customerId: string, resourceId: string, subscriptionId: string) =>
      asWorker((tx) => lifecycleRepo(tx).periodEndOf({ customerId, resourceId, subscriptionId }));
    expect((await read(f.customerId, f.resourceId, f.subscriptionId))?.getTime()).toBe(
      f.end.getTime(),
    );
    expect(await read(other.f.customerId, f.resourceId, f.subscriptionId)).toBeNull();
    expect(await read(f.customerId, other.f.resourceId, f.subscriptionId)).toBeNull();
    expect(await read(f.customerId, f.resourceId, other.f.subscriptionId)).toBeNull();
  });

  it("is idempotent per period: one apply, then a new period gets its own", async () => {
    const { f, small } = await make("downgrade");
    expect(await leadQueue(f)).not.toBeNull();
    expect(await leadQueue(f, 6)).toBeNull();
    await run();
    await run();
    expect(await applyOps(f.resourceId)).toHaveLength(1);
    await finishApply(f, small);
    at(f, 60_000);
    await run(); // renewed
    // the plan is applied; nothing is pending, so the next period queues nothing
    const end2 = await periodEnd(f);
    kit.clock.set(new Date(end2.getTime() - 12 * HOUR));
    await run();
    expect(await applyOps(f.resourceId)).toHaveLength(1);
  });
});
