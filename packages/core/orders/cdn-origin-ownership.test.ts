import { randomUUID } from "node:crypto";
import { insertRow, uniqueSuffix, useTempDatabase } from "@tc/db/testing";
import { describe, expect, it } from "vitest";
import { makeKit, snapshotRows, type Buyer, type Kit } from "../test/orders-kit";
import { createDraft } from "./draft";
import { draftHash } from "./ids";
import { makeOrders } from "./place";
import { runPurchase } from "./purchase";
import { signDraft, verifyDraft } from "./token";
import type { DraftClaims } from "./types";

// WP7-T2 (R8, R12): the origin of a distribution is the customer's own active server, load balancer
// or bucket. The draft and the purchase both check it through the scoped repository, in the one
// purchase transaction, and a refusal writes nothing. Same shape as lb-target-ownership.test.ts.
const t = useTempDatabase();
const CDN_REGION = "us-east-1";
const ORIGIN_REGION = "ap-southeast-1";
const INVALID = { ok: false, error: "validation", fields: { originId: "invalid" } } as const;

async function originOf(
  customerId: string,
  over: { family?: string; state?: string } = {},
): Promise<string> {
  return insertRow(t.pool, "resources", {
    customer_id: customerId,
    family: over.family ?? "linux_instance",
    region: ORIGIN_REGION,
    state: over.state ?? "active",
    config: JSON.stringify({ region: ORIGIN_REGION }),
  });
}

/** The kit's pool gets a distribution cell, the flag turns on, and a CDN product exists. */
async function cdnKit(flag = true): Promise<{ kit: Kit; cdnProductId: string }> {
  const kit = await makeKit(t);
  await t.pool.query(
    `insert into feature_flags (id, key, market, enabled) values (gen_random_uuid(), 'cdn', 'BD', $1)
     on conflict (key, market) do update set enabled = excluded.enabled`,
    [flag],
  );
  // A distribution counts per pool account, not per Region (ACCOUNT_WIDE_CODES): its cell is "global".
  await t.pool.query(
    `insert into pool_capacity (id, pool_account_id, region, quota_code, quota_limit, used)
     values (gen_random_uuid(), $1, 'global', 'distribution', 20, 0)
     on conflict (pool_account_id, region, quota_code) do update set quota_limit = 20, used = 0`,
    [kit.poolAccountId],
  );
  // The aws_id must be a real CDN bundle and (family, aws_id, region) is unique in the table, which
  // is shared by every test of this file: the product is created once and found again.
  const found = await t.pool.query<{ id: string }>(
    "select id from catalog_products where family = 'cdn' and aws_id = 'small_1_0' and region = $1",
    [CDN_REGION],
  );
  const cdnProductId =
    found.rows[0]?.id ??
    (await kit.newProduct({
      family: "cdn",
      aws_id: "small_1_0",
      platform: null,
      region: CDN_REGION,
      specs: JSON.stringify({}),
      feature_flag: "cdn",
    }));
  return { kit, cdnProductId };
}

const cdnInput = (productId: string, originId: string, extra: Record<string, unknown> = {}) => ({
  family: "cdn",
  config: {
    productId,
    region: CDN_REGION,
    displayName: "cdn-" + uniqueSuffix(),
    originId,
    ...extra,
  },
});

async function tokenFor(kit: Kit, buyer: Buyer, cdnProductId: string, originId: string) {
  // A draft for the buyer's own origin, then the token is re-signed naming `originId`.
  const own = await originOf(buyer.customerId);
  const d = await createDraft(kit.deps, kit.session, cdnInput(cdnProductId, own));
  if (!d.ok) throw new Error("the draft was refused");
  const verdict = verifyDraft(kit.secrets, d.value.token, kit.clock.now());
  if (!verdict.ok) throw new Error("the draft does not verify");
  const claims: DraftClaims = { ...verdict.claims, cfg: { ...verdict.claims.cfg, originId } };
  return signDraft(kit.secrets, claims);
}

const purchase = (kit: Kit, buyer: Buyer, token: string) => {
  const verdict = verifyDraft(kit.secrets, token, kit.clock.now());
  if (!verdict.ok) throw new Error("the token does not verify");
  return kit.run((tx) =>
    runPurchase(tx, kit.deps, {
      claims: verdict.claims,
      tokenHash: draftHash(token),
      clientKey: "cdn-own-" + "a".repeat(16),
      customerId: buyer.customerId,
    }),
  );
};

describe("createOrderDraft: the origin of a distribution must be the customer's own", () => {
  it("refuses another customer's resource and a missing id, with one answer and no row written", async () => {
    const { kit, cdnProductId } = await cdnKit();
    const other = await kit.newBuyer();
    const foreign = await originOf(other.customerId);
    const before = await snapshotRows(t);
    const a = await createDraft(kit.deps, kit.session, cdnInput(cdnProductId, foreign));
    const b = await createDraft(kit.deps, kit.session, cdnInput(cdnProductId, randomUUID()));
    expect(a).toEqual(INVALID);
    expect(b).toEqual(a);
    expect(await snapshotRows(t)).toEqual(before);
  });

  it("refuses an own resource that is no origin or is not active", async () => {
    const { kit, cdnProductId } = await cdnKit();
    const database = await originOf(kit.customerId, { family: "database" });
    const stopped = await originOf(kit.customerId, { state: "suspended" });
    for (const id of [database, stopped]) {
      expect(await createDraft(kit.deps, kit.session, cdnInput(cdnProductId, id))).toEqual(INVALID);
    }
  });

  it("accepts an own active server, load balancer or bucket", async () => {
    const { kit, cdnProductId } = await cdnKit();
    for (const family of ["linux_instance", "load_balancer", "bucket"]) {
      const own = await originOf(kit.customerId, { family });
      const r = await createDraft(kit.deps, kit.session, cdnInput(cdnProductId, own));
      expect(r.ok, family).toBe(true);
    }
  });

  it("drops a customer-supplied domain: it is no part of the config (R11)", async () => {
    const { kit, cdnProductId } = await cdnKit();
    const own = await originOf(kit.customerId);
    const d = await createDraft(
      kit.deps,
      kit.session,
      cdnInput(cdnProductId, own, { domain: "shop.example.com", certificateName: "x" }),
    );
    if (!d.ok) throw new Error("the draft was refused");
    const verdict = verifyDraft(kit.secrets, d.value.token, kit.clock.now());
    if (!verdict.ok) throw new Error("the draft does not verify");
    expect(JSON.stringify(verdict.claims.cfg)).not.toMatch(/example\.com|certificateName/);
  });

  it("is refused while the cdn flag is off (R12)", async () => {
    const { kit, cdnProductId } = await cdnKit(false);
    const own = await originOf(kit.customerId);
    const before = await snapshotRows(t);
    expect(await createDraft(kit.deps, kit.session, cdnInput(cdnProductId, own))).toEqual({
      ok: false,
      error: "flag_off",
    });
    expect(await snapshotRows(t)).toEqual(before);
  });
});

describe("runPurchase: the origin is checked again, before any write", () => {
  it("refuses a token naming another customer's resource and changes no row", async () => {
    const { kit, cdnProductId } = await cdnKit();
    const other = await kit.newBuyer();
    const foreign = await originOf(other.customerId);
    const token = await tokenFor(kit, kit, cdnProductId, foreign);
    const before = await snapshotRows(t);
    expect(await purchase(kit, kit, token)).toEqual(INVALID);
    expect(await snapshotRows(t)).toEqual(before);
    expect(kit.queue.depth).toBe(0);
  });

  it("refuses the same token through placeOrder, with no resource created", async () => {
    const { kit, cdnProductId } = await cdnKit();
    const other = await kit.newBuyer();
    const foreign = await originOf(other.customerId);
    const token = await tokenFor(kit, kit, cdnProductId, foreign);
    const before = await snapshotRows(t);
    const r = await makeOrders(kit.deps).placeOrder(kit.session, {
      token,
      idempotencyKey: "cdn-place-" + "b".repeat(16),
    });
    expect(r.ok).toBe(false);
    expect(await snapshotRows(t)).toEqual(before);
  });

  it("one transaction makes the order, the cdn resource, the subscription and the create operation", async () => {
    const { kit, cdnProductId } = await cdnKit();
    const own = await originOf(kit.customerId);
    const d = await createDraft(kit.deps, kit.session, cdnInput(cdnProductId, own));
    if (!d.ok) throw new Error("the draft was refused");
    const placed = await makeOrders(kit.deps).placeOrder(kit.session, {
      token: d.value.token,
      idempotencyKey: "cdn-ok-" + "c".repeat(16),
    });
    if (!placed.ok) throw new Error("the order was refused");
    const rows = await t.pool.query<{ id: string; family: string; state: string; config: unknown }>(
      "select id, family, state, config from resources where customer_id = $1 and family = 'cdn'",
      [kit.customerId],
    );
    expect(rows.rows).toHaveLength(1);
    const resource = rows.rows[0] as { id: string; config: Record<string, unknown> };
    expect(resource.config).toMatchObject({
      productId: cdnProductId,
      region: CDN_REGION,
      originId: own,
      cacheBehavior: "cache",
    });
    const ops = await t.pool.query<{ kind: string }>(
      "select kind from operations where resource_id = $1",
      [resource.id],
    );
    expect(ops.rows.map((r) => r.kind)).toEqual(["create"]);
    expect((await kit.used())["global/distribution"]).toBe(1);
  });
});
