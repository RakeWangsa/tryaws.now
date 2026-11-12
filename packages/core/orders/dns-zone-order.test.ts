import { runTransaction, uniqueSuffix, useTempDatabase } from "@tc/db/testing";
import { describe, expect, it } from "vitest";
import { makeKit, snapshotRows, type Buyer, type Kit } from "../test/orders-kit";
import { compensateFailedCreate } from "./compensate";
import { createDraft } from "./draft";
import { makeOrders } from "./place";

// WPU-G6: the dns_zone family in the single purchase transaction. A zone is priced from the market's
// config price, takes no capacity and no pool account, a name is held once on the platform, and a zone
// of a failed create gives the name back.
const t = useTempDatabase();

async function zoneKit(options: { flag?: boolean; price?: string | null } = {}): Promise<Kit> {
  const { flag = true, price = "0.50" } = options;
  const kit = await makeKit(t);
  await t.pool.query(
    `insert into feature_flags (id, key, market, enabled) values (gen_random_uuid(), 'dns_zone', 'BD', $1)
     on conflict (key, market) do update set enabled = excluded.enabled`,
    [flag],
  );
  await t.pool.query(
    "delete from settings where key = 'config_price.dns_zone_month' and market = 'BD'",
  );
  if (price !== null) {
    await t.pool.query(
      `insert into settings (id, key, market, scope, scope_id, value)
       values (gen_random_uuid(), 'config_price.dns_zone_month', 'BD', 'market', null, $1::jsonb)`,
      [JSON.stringify({ usd: price, unit: "month" })],
    );
  }
  return kit;
}

const zoneName = () =>
  `shop${uniqueSuffix()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")}.example`;
const input = (name: string, extra: Record<string, unknown> = {}) => ({
  family: "dns_zone",
  config: { zoneName: name, declaredControl: true, ...extra },
});
const place = (kit: Kit, buyer: Buyer, token: string, key: string) =>
  makeOrders(kit.deps).placeOrder(buyer.session, { token, idempotencyKey: key });

async function draftFor(kit: Kit, buyer: Buyer, name: string) {
  const d = await createDraft(kit.deps, buyer.session, input(name));
  if (!d.ok) throw new Error(`the draft was refused: ${d.error} ${JSON.stringify(d.fields)}`);
  return d.value.token;
}

describe("a DNS zone order", () => {
  it("makes the order, a placeless resource, a 30-day subscription, the zone row and the create operation", async () => {
    const kit = await zoneKit();
    const name = zoneName();
    const usedBefore = await kit.used();
    const placed = await place(
      kit,
      kit,
      await draftFor(kit, kit, name),
      "zone-ok-" + "a".repeat(16),
    );
    if (!placed.ok) throw new Error(`the order was refused: ${placed.error}`);

    const resource = (
      await t.pool.query(
        "select id, product_id, pool_account_id, region, state, config from resources where customer_id = $1 and family = 'dns_zone'",
        [kit.customerId],
      )
    ).rows[0] as Record<string, unknown>;
    expect(resource).toMatchObject({
      product_id: null,
      pool_account_id: null,
      region: "us-east-1",
      state: "creating",
    });
    // The name is the zone name the adapter reads; no AWS name, no capacity record, nothing else.
    expect(resource["config"]).toEqual({
      region: "us-east-1",
      displayName: name,
      zoneName: name,
      declaredControl: true,
    });
    expect(await kit.used()).toEqual(usedBefore);

    const row = (
      await t.pool.query(
        "select name, status, hosted_zone_id from dns_zones where resource_id = $1",
        [resource["id"]],
      )
    ).rows;
    expect(row).toEqual([{ name, status: "pending", hosted_zone_id: null }]);

    const sub = (
      await t.pool.query("select term_days from subscriptions where resource_id = $1", [
        resource["id"],
      ])
    ).rows[0] as { term_days: number };
    expect(sub.term_days).toBe(30);

    const op = (
      await t.pool.query("select kind, state from operations where resource_id = $1", [
        resource["id"],
      ])
    ).rows;
    expect(op).toEqual([{ kind: "create", state: "queued" }]);
  });

  it("replays the same draft as the same order and charges once (R7)", async () => {
    const kit = await zoneKit();
    const token = await draftFor(kit, kit, zoneName());
    const start = await kit.balance();
    const one = await place(kit, kit, token, "zone-rep-" + "b".repeat(15));
    const two = await place(kit, kit, token, "zone-rep-" + "c".repeat(15));
    expect(one.ok && two.ok).toBe(true);
    if (one.ok && two.ok) expect(two.value.orderId).toBe(one.value.orderId);
    const spent = start - (await kit.balance());
    expect(spent).toBeGreaterThan(0n);
    const zones = await t.pool.query(
      "select count(*)::int as n from dns_zones z join resources r on r.id = z.resource_id where r.customer_id = $1",
      [kit.customerId],
    );
    expect(zones.rows[0]).toEqual({ n: 1 });
  });

  it("lets several customers hold a pending zone for one name (a zone is harmless until delegated)", async () => {
    const kit = await zoneKit();
    const name = zoneName();
    expect(
      (await place(kit, kit, await draftFor(kit, kit, name), "zone-one-" + "d".repeat(14))).ok,
    ).toBe(true);

    const other = await kit.newBuyer();
    const third = await kit.newBuyer();
    // The first zone is still pending: the second and third customers can both buy the same name.
    expect(
      (await place(kit, other, await draftFor(kit, other, name), "zone-two-" + "e".repeat(14))).ok,
    ).toBe(true);
    expect(
      (await place(kit, third, await draftFor(kit, third, name), "zone-thr-" + "f".repeat(14))).ok,
    ).toBe(true);
    const rows = await t.pool.query(
      "select count(*)::int as n from dns_zones where name = $1 and status = 'pending'",
      [name],
    );
    expect(rows.rows[0]).toEqual({ n: 3 });
  });

  it("refuses a name that is delegated to a zone, in the draft and in the purchase, with one generic answer, and writes nothing", async () => {
    const kit = await zoneKit();
    const name = zoneName();
    expect(
      (await place(kit, kit, await draftFor(kit, kit, name), "zone-del-" + "d".repeat(14))).ok,
    ).toBe(true);
    // A token made while the zone was still pending.
    const other = await kit.newBuyer();
    const lateToken = await draftFor(kit, other, name);
    await t.pool.query("update dns_zones set status = 'delegated' where name = $1", [name]);

    const conflict = {
      ok: false,
      error: "conflict",
      fields: { zoneName: "taken" },
    } as const;
    // The holder and a stranger get the same answer; it names nobody (R8).
    expect(await createDraft(kit.deps, other.session, input(name))).toEqual(conflict);
    expect(await createDraft(kit.deps, kit.session, input(name))).toEqual(conflict);
    const mid = await snapshotRows(t);
    expect(await place(kit, other, lateToken, "zone-lat-" + "f".repeat(14))).toEqual(conflict);
    expect(await snapshotRows(t)).toEqual(mid);
  });

  async function registerDomain(kit: Kit, customerId: string, name: string) {
    const tld = name.slice(name.lastIndexOf(".") + 1);
    await t.pool.query(
      "insert into tlds (id, tld, synced_at) values (gen_random_uuid(), $1, now()) on conflict do nothing",
      [tld],
    );
    const resourceId = (
      await t.pool.query(
        "insert into resources (id, customer_id, family, region) values (gen_random_uuid(), $1, 'domain', 'us-east-1') returning id",
        [customerId],
      )
    ).rows[0] as { id: string };
    await t.pool.query(
      "insert into domains (id, customer_id, resource_id, name, tld, status) values (gen_random_uuid(), $1, $2, $3, $4, 'registered')",
      [customerId, resourceId.id, name, tld],
    );
  }
  const label = () =>
    "d" +
    uniqueSuffix()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");

  it("refuses the customer's own domain name (the automatic zone is adopted, not created)", async () => {
    const kit = await zoneKit();
    const name = `${label()}.example`;
    await registerDomain(kit, kit.customerId, name);
    expect(await createDraft(kit.deps, kit.session, input(name))).toEqual({
      ok: false,
      error: "validation",
      fields: { zoneName: "registered_here" },
    });
  });

  it("refuses a name or a subdomain of a domain another customer holds, with the generic answer", async () => {
    const kit = await zoneKit();
    const stranger = await kit.newBuyer();
    const base = `${label()}.example`;
    await registerDomain(kit, stranger.customerId, base);
    const taken = {
      ok: false,
      error: "conflict",
      fields: { zoneName: "taken" },
    } as const;
    expect(await createDraft(kit.deps, kit.session, input(base))).toEqual(taken);
    expect(await createDraft(kit.deps, kit.session, input(`www.${base}`))).toEqual(taken);
    expect(await createDraft(kit.deps, kit.session, input(`a.b.${base}`))).toEqual(taken);
    // The answer is the same as for a delegated zone: it does not say a domain holds the name.
    const delegated = zoneName();
    const holder = await kit.newBuyer();
    expect(
      (
        await place(
          kit,
          holder,
          await draftFor(kit, holder, delegated),
          "zone-sub-" + "a".repeat(14),
        )
      ).ok,
    ).toBe(true);
    await t.pool.query("update dns_zones set status = 'delegated' where name = $1", [delegated]);
    expect(await createDraft(kit.deps, kit.session, input(delegated))).toEqual(taken);
  });

  it("refuses the purchase of a token made before another customer registered the parent domain", async () => {
    const kit = await zoneKit();
    const stranger = await kit.newBuyer();
    const base = `${label()}.example`;
    const token = await draftFor(kit, kit, `shop.${base}`);
    await registerDomain(kit, stranger.customerId, base);
    const mid = await snapshotRows(t);
    expect(await place(kit, kit, token, "zone-par-" + "a".repeat(14))).toEqual({
      ok: false,
      error: "conflict",
      fields: { zoneName: "taken" },
    });
    expect(await snapshotRows(t)).toEqual(mid);
  });

  it("allows the customer's own subdomain of a domain they hold, and not a look-alike suffix", async () => {
    const kit = await zoneKit();
    const stranger = await kit.newBuyer();
    const base = `${label()}.example`;
    await registerDomain(kit, kit.customerId, base);
    expect((await createDraft(kit.deps, kit.session, input(`blog.${base}`))).ok).toBe(true);
    expect((await createDraft(kit.deps, kit.session, input(`a.b.${base}`))).ok).toBe(true);

    // The stranger holds b.<other>: a.b.<other> is under it; notb.<other>, xb.<other> and <other> are not.
    const other = `${label()}.example`;
    await registerDomain(kit, stranger.customerId, `b.${other}`);
    expect(await createDraft(kit.deps, kit.session, input(`a.b.${other}`))).toEqual({
      ok: false,
      error: "conflict",
      fields: { zoneName: "taken" },
    });
    expect((await createDraft(kit.deps, kit.session, input(`notb.${other}`))).ok).toBe(true);
    expect((await createDraft(kit.deps, kit.session, input(`xb.${other}`))).ok).toBe(true);
    expect((await createDraft(kit.deps, kit.session, input(other))).ok).toBe(true);
  });

  it("gives the name back when the create fails: the refund is exactly once and the name can be bought again", async () => {
    const kit = await zoneKit();
    const name = zoneName();
    const start = await kit.balance();
    const placed = await place(
      kit,
      kit,
      await draftFor(kit, kit, name),
      "zone-fail-" + "g".repeat(14),
    );
    if (!placed.ok) throw new Error("the order was refused");
    const resource = (
      await t.pool.query(
        "select id from resources where customer_id = $1 and family = 'dns_zone'",
        [kit.customerId],
      )
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
    expect((await createDraft(kit.deps, kit.session, input(name))).ok).toBe(true);
  });

  it("is refused while the dns_zone flag is off (R12) and while the market has no zone price (R16)", async () => {
    const off = await zoneKit({ flag: false });
    const before = await snapshotRows(t);
    expect(await createDraft(off.deps, off.session, input(zoneName()))).toEqual({
      ok: false,
      error: "flag_off",
    });
    expect(await snapshotRows(t)).toEqual(before);

    const unpriced = await zoneKit({ price: null });
    expect(await createDraft(unpriced.deps, unpriced.session, input(zoneName()))).toEqual({
      ok: false,
      error: "validation",
      fields: { price: "unavailable" },
    });
  });

  it("refuses a name that is not a zone name and a missing declaration of control", async () => {
    const kit = await zoneKit();
    expect(await createDraft(kit.deps, kit.session, input("not a name"))).toMatchObject({
      ok: false,
      error: "validation",
    });
    expect(
      await createDraft(kit.deps, kit.session, {
        family: "dns_zone",
        config: { zoneName: zoneName() },
      }),
    ).toEqual({ ok: false, error: "validation", fields: { declaredControl: "required" } });
  });

  it("quotes the price from the config price, not from a float", async () => {
    const cheap = await zoneKit({ price: "0.50" });
    const a = await createDraft(cheap.deps, cheap.session, input(zoneName()));
    const dear = await zoneKit({ price: "5.00" });
    const b = await createDraft(dear.deps, dear.session, input(zoneName()));
    if (!a.ok || !b.ok) throw new Error("a draft was refused");
    expect(b.value.quote.totalMinor).toBeGreaterThan(a.value.quote.totalMinor);
  });
});
