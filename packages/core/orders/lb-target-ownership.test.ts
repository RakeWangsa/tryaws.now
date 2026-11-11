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

// Review finding (IDOR): the targets of a load balancer are the customer's own active instances in the
// Region of the load balancer. The draft and the purchase both check them through the scoped
// repository, and a refusal writes nothing. Same shape as key-ownership.test.ts.
const t = useTempDatabase();
const REGION = "ap-southeast-1";
const INVALID = { ok: false, error: "validation", fields: { targetIds: "invalid" } } as const;

async function instanceOf(customerId: string, region: string | null = REGION): Promise<string> {
  return insertRow(t.pool, "resources", {
    customer_id: customerId,
    family: "linux_instance",
    region,
    state: "active",
    config: JSON.stringify({ region: region ?? REGION }),
  });
}

/** The kit's pool gets a load balancer cell, the flag turns on, and a load balancer product exists. */
async function lbKit(): Promise<{ kit: Kit; lbProductId: string }> {
  const kit = await makeKit(t);
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
  const lbProductId = await kit.newProduct({
    family: "load_balancer",
    platform: null,
    specs: JSON.stringify({}),
    feature_flag: "load_balancer",
  });
  return { kit, lbProductId };
}

const lbInput = (productId: string, targetIds: string[]) => ({
  family: "load_balancer",
  config: { productId, region: REGION, displayName: "lb-" + uniqueSuffix(), targetIds },
});

async function tokenFor(kit: Kit, buyer: Buyer, lbProductId: string, targetIds: string[]) {
  // A draft for the buyer's own (checked) target, then the token is re-signed naming `targetIds`.
  const own = await instanceOf(buyer.customerId);
  const d = await createDraft(kit.deps, kit.session, lbInput(lbProductId, [own]));
  if (!d.ok) throw new Error("the draft was refused");
  const verdict = verifyDraft(kit.secrets, d.value.token, kit.clock.now());
  if (!verdict.ok) throw new Error("the draft does not verify");
  const claims: DraftClaims = { ...verdict.claims, cfg: { ...verdict.claims.cfg, targetIds } };
  return signDraft(kit.secrets, claims);
}

const purchase = (kit: Kit, buyer: Buyer, token: string) => {
  const verdict = verifyDraft(kit.secrets, token, kit.clock.now());
  if (!verdict.ok) throw new Error("the token does not verify");
  return kit.run((tx) =>
    runPurchase(tx, kit.deps, {
      claims: verdict.claims,
      tokenHash: draftHash(token),
      clientKey: "lb-own-" + "a".repeat(16),
      customerId: buyer.customerId,
    }),
  );
};

describe("createOrderDraft: load balancer targets must be the customer's own", () => {
  it("refuses another customer's instance and a missing id, with one answer and no row written", async () => {
    const { kit, lbProductId } = await lbKit();
    const other = await kit.newBuyer();
    const foreign = await instanceOf(other.customerId);
    const before = await snapshotRows(t);
    const a = await createDraft(kit.deps, kit.session, lbInput(lbProductId, [foreign]));
    const b = await createDraft(kit.deps, kit.session, lbInput(lbProductId, [randomUUID()]));
    expect(a).toEqual(INVALID);
    expect(b).toEqual(a);
    expect(await snapshotRows(t)).toEqual(before);
  });

  it("refuses an own instance of another Region", async () => {
    const { kit, lbProductId } = await lbKit();
    const far = await instanceOf(kit.customerId, "eu-west-1");
    const r = await createDraft(kit.deps, kit.session, lbInput(lbProductId, [far]));
    expect(r).toEqual(INVALID);
  });

  it("accepts an own active instance in the same Region", async () => {
    const { kit, lbProductId } = await lbKit();
    const own = await instanceOf(kit.customerId);
    const r = await createDraft(kit.deps, kit.session, lbInput(lbProductId, [own]));
    expect(r.ok).toBe(true);
  });
});

describe("runPurchase: the targets are checked again, before any write", () => {
  it("refuses a token naming another customer's instance and changes no row", async () => {
    const { kit, lbProductId } = await lbKit();
    const other = await kit.newBuyer();
    const foreign = await instanceOf(other.customerId);
    const token = await tokenFor(kit, kit, lbProductId, [foreign]);
    const before = await snapshotRows(t);
    expect(await purchase(kit, kit, token)).toEqual(INVALID);
    expect(await snapshotRows(t)).toEqual(before);
    expect(kit.queue.depth).toBe(0);
  });

  it("refuses the same token through placeOrder, with no resource created", async () => {
    const { kit, lbProductId } = await lbKit();
    const other = await kit.newBuyer();
    const foreign = await instanceOf(other.customerId);
    const token = await tokenFor(kit, kit, lbProductId, [foreign]);
    const before = await snapshotRows(t);
    const orders = makeOrders(kit.deps);
    const r = await orders.placeOrder(kit.session, {
      token,
      idempotencyKey: "lb-place-" + "b".repeat(16),
    });
    expect(r.ok).toBe(false);
    expect(await snapshotRows(t)).toEqual(before);
  });

  it("refuses a token naming an own instance of another Region", async () => {
    const { kit, lbProductId } = await lbKit();
    const far = await instanceOf(kit.customerId, "eu-west-1");
    const token = await tokenFor(kit, kit, lbProductId, [far]);
    expect(await purchase(kit, kit, token)).toEqual(INVALID);
  });
});
