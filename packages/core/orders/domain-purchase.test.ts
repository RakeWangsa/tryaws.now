import { insertRow, runTransaction, uniqueSuffix, useTempDatabase } from "@tc/db/testing";
import { describe, expect, it } from "vitest";
import { makeKit, snapshotRows, type Buyer, type Kit } from "../test/orders-kit";
import { compensateFailedCreate } from "./compensate";
import { createDraft } from "./draft";
import { makeOrders } from "./place";

// WP7-T4: the domain family in the single purchase transaction. A domain is priced from a `tlds` row,
// takes no capacity and no pool account, and a name is held once on the platform.
const t = useTempDatabase();
const SEALED = Buffer.from("sealed-envelope-bytes").toString("base64");

async function domainKit(flag = true): Promise<Kit> {
  const kit = await makeKit(t);
  await t.pool.query(
    `insert into feature_flags (id, key, market, enabled) values (gen_random_uuid(), 'domain', 'BD', $1)
     on conflict (key, market) do update set enabled = excluded.enabled`,
    [flag],
  );
  return kit;
}

async function newTld(over: Record<string, unknown> = {}): Promise<{ id: string; tld: string }> {
  const tld = "t" + uniqueSuffix();
  const id = await insertRow(t.pool, "tlds", {
    tld,
    registration_price_usd: "13.0000",
    renewal_price_usd: "15.0000",
    needs_extra_params: false,
    synced_at: "2026-11-11T00:00:00Z",
    ...over,
  });
  return { id, tld };
}

const input = (productId: string, name: string, extra: Record<string, unknown> = {}) => ({
  family: "domain",
  config: { productId, name, contactSealed: SEALED, ...extra },
});

const place = (kit: Kit, buyer: Buyer, token: string, key: string) =>
  makeOrders(kit.deps).placeOrder(buyer.session, { token, idempotencyKey: key });

async function draftFor(kit: Kit, buyer: Buyer, productId: string, name: string) {
  const d = await createDraft(kit.deps, buyer.session, input(productId, name));
  if (!d.ok) throw new Error(`the draft was refused: ${d.error} ${JSON.stringify(d.fields)}`);
  return d.value.token;
}

describe("a domain order", () => {
  it("makes the order, a placeless resource, a one-year subscription, the domain row and the create operation", async () => {
    const kit = await domainKit();
    const { id, tld } = await newTld();
    const name = `shop${uniqueSuffix()}.${tld}`;
    const usedBefore = await kit.used();
    const token = await draftFor(kit, kit, id, name);
    const placed = await place(kit, kit, token, "dom-ok-" + "a".repeat(16));
    if (!placed.ok) throw new Error(`the order was refused: ${placed.error}`);

    const resource = (
      await t.pool.query(
        "select id, product_id, pool_account_id, region, state, config from resources where customer_id = $1 and family = 'domain'",
        [kit.customerId],
      )
    ).rows[0] as Record<string, unknown>;
    expect(resource).toMatchObject({ product_id: null, pool_account_id: null, state: "creating" });
    expect(resource["config"]).toMatchObject({ name, tld, review: false, contactSealed: SEALED });
    expect(JSON.stringify(resource["config"])).not.toContain("capacityReservation");
    // No capacity cell moved.
    expect(await kit.used()).toEqual(usedBefore);

    const domain = (
      await t.pool.query(
        "select name, tld, status, registrant_contact_encrypted as c from domains where resource_id = $1",
        [resource["id"]],
      )
    ).rows[0] as { name: string; status: string; c: Buffer };
    expect(domain).toMatchObject({ name, status: "pending" });
    expect(domain.c.toString("utf8")).toBe("sealed-envelope-bytes");

    const sub = (
      await t.pool.query(
        "select term_days, period_end - period_start as span from subscriptions where resource_id = $1",
        [resource["id"]],
      )
    ).rows[0] as { term_days: number };
    expect(sub.term_days).toBe(365);

    const op = (
      await t.pool.query("select kind, state from operations where resource_id = $1", [
        resource["id"],
      ])
    ).rows;
    expect(op).toEqual([{ kind: "create", state: "queued" }]);
  });

  it("sends a TLD with extra parameters to admin review: the operation waits for approval", async () => {
    const kit = await domainKit();
    const { id, tld } = await newTld({ needs_extra_params: true });
    const name = `law${uniqueSuffix()}.${tld}`;
    const placed = await place(
      kit,
      kit,
      await draftFor(kit, kit, id, name),
      "dom-rev-" + "b".repeat(16),
    );
    expect(placed.ok).toBe(true);
    const op = (
      await t.pool.query(
        `select o.state from operations o join resources r on r.id = o.resource_id
          where r.customer_id = $1 and r.family = 'domain'`,
        [kit.customerId],
      )
    ).rows;
    expect(op).toEqual([{ state: "needs_approval" }]);
    const d = await t.pool.query("select status from domains where name = $1", [name]);
    expect(d.rows).toEqual([{ status: "review" }]);
  });

  it("refuses a second order for a name that is held, in the draft and in the purchase, and writes nothing", async () => {
    const kit = await domainKit();
    const { id, tld } = await newTld();
    const name = `dup${uniqueSuffix()}.${tld}`;
    const first = await place(
      kit,
      kit,
      await draftFor(kit, kit, id, name),
      "dom-one-" + "c".repeat(16),
    );
    expect(first.ok).toBe(true);

    const other = await kit.newBuyer();
    const conflict = { ok: false, error: "conflict", fields: { name: "taken" } } as const;
    const before = await snapshotRows(t);
    expect(await createDraft(kit.deps, other.session, input(id, name))).toEqual(conflict);
    expect(await createDraft(kit.deps, kit.session, input(id, name))).toEqual(conflict);

    // A token made before the first order was placed is refused by the purchase itself.
    const free = `late${uniqueSuffix()}.${tld}`;
    const lateToken = await draftFor(kit, other, id, free);
    const winner = await draftFor(kit, kit, id, free);
    expect((await place(kit, kit, winner, "dom-two-" + "d".repeat(16))).ok).toBe(true);
    const mid = await snapshotRows(t);
    expect(await place(kit, other, lateToken, "dom-thr-" + "e".repeat(16))).toEqual(conflict);
    expect(await snapshotRows(t)).toEqual(mid);
    expect(before).not.toEqual(mid);
  });

  it("gives the name back when the create fails: the refund is exactly once and the name can be bought again", async () => {
    const kit = await domainKit();
    const { id, tld } = await newTld();
    const name = `fail${uniqueSuffix()}.${tld}`;
    const start = await kit.balance();
    const placed = await place(
      kit,
      kit,
      await draftFor(kit, kit, id, name),
      "dom-fail-" + "f".repeat(15),
    );
    if (!placed.ok) throw new Error("the order was refused");
    const resource = (
      await t.pool.query("select id from resources where customer_id = $1 and family = 'domain'", [
        kit.customerId,
      ])
    ).rows[0] as { id: string };
    expect(await kit.balance()).toBeLessThan(start);

    const compensate = () =>
      runTransaction(
        t.db,
        (tx) =>
          compensateFailedCreate(tx, kit.deps, {
            resourceId: resource.id,
            customerId: kit.customerId,
            code: "conflict",
          }),
        { role: "worker_rw" },
      );
    expect(await compensate()).toMatchObject({ reversed: true, replayed: false });
    expect(await kit.balance()).toBe(start);
    expect(await compensate()).toMatchObject({ reversed: true, replayed: true });
    expect(await kit.balance()).toBe(start);

    // The resource failed, so the name is free again.
    const again = await createDraft(kit.deps, kit.session, input(id, name));
    expect(again.ok).toBe(true);
  });

  it("is refused while the domain flag is off (R12) and for a TLD without a price (R16)", async () => {
    const off = await domainKit(false);
    const { id, tld } = await newTld();
    const before = await snapshotRows(t);
    expect(
      await createDraft(off.deps, off.session, input(id, `x${uniqueSuffix()}.${tld}`)),
    ).toEqual({ ok: false, error: "flag_off" });
    expect(await snapshotRows(t)).toEqual(before);

    const on = await domainKit(true);
    const unpriced = await newTld({ registration_price_usd: null });
    expect(
      await createDraft(
        on.deps,
        on.session,
        input(unpriced.id, `x${uniqueSuffix()}.${unpriced.tld}`),
      ),
    ).toEqual({ ok: false, error: "validation", fields: { productId: "unavailable" } });
  });

  it("quotes the price per year from the TLD row", async () => {
    const kit = await domainKit();
    const cheap = await newTld({ registration_price_usd: "1.0000" });
    const dear = await newTld({ registration_price_usd: "20.0000" });
    const a = await createDraft(
      kit.deps,
      kit.session,
      input(cheap.id, `p${uniqueSuffix()}.${cheap.tld}`),
    );
    const b = await createDraft(
      kit.deps,
      kit.session,
      input(dear.id, `p${uniqueSuffix()}.${dear.tld}`),
    );
    if (!a.ok || !b.ok) throw new Error("a draft was refused");
    expect(b.value.quote.totalMinor).toBeGreaterThan(a.value.quote.totalMinor);
  });
});
