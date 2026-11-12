import { v7 as uuidv7 } from "uuid";
import { describe, expect, it } from "vitest";
import type { CustomerRepos } from "../repositories/customer/index";
import { dnsZoneNameHolder, zoneNameDomainHold } from "../repositories/domain-names";
import { markDnsZone, recordDnsZoneCreated } from "../repositories/dns-zone-sync";
import { withCustomerRepos } from "../testing/repos";
import { newCustomer, newResource, uniqueSuffix } from "./fixtures";
import { insertRow } from "./sql";
import { useTempDatabase } from "./temp-db";

// WPU-G6: the dns_zones repository (tenant-scoped), who holds a zone name, the unique live name of
// migration 0011, and what the provisioner writes on the row. The cross-tenant cases of the repository
// methods are in cross-tenant-cases/dns-zones.ts.

const t = useTempDatabase();
const as = <T>(c: string, fn: (r: CustomerRepos) => Promise<T>) => withCustomerRepos(t.db, c, fn);
const name = (prefix = "z") =>
  prefix +
  uniqueSuffix()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "") +
  ".example";

async function zone(
  customerId: string,
  over: Record<string, unknown> = {},
  resourceState = "creating",
) {
  const resourceId = await newResource(t.pool, customerId, {
    family: "dns_zone",
    region: "us-east-1",
    state: resourceState,
  });
  const zoneName = name();
  const id = await insertRow(t.pool, "dns_zones", {
    customer_id: customerId,
    resource_id: resourceId,
    name: zoneName,
    status: "pending",
    ...over,
  });
  return { id, resourceId, zoneName };
}

describe("dnsZones repository", () => {
  it("lists only the customer's zones, by name, and reads one by id or resource", async () => {
    const a = await newCustomer(t.pool);
    const b = await newCustomer(t.pool);
    const one = await zone(a);
    const two = await zone(a);
    const other = await zone(b);
    const listed = await as(a, (r) => r.dnsZones.list());
    expect(listed.map((z) => z.id).sort()).toEqual([one.id, two.id].sort());
    expect(listed.every((z) => z.nameServers.length === 0 && z.delegatedAt === null)).toBe(true);
    expect((await as(a, (r) => r.dnsZones.get(one.id)))?.name).toBe(one.zoneName);
    expect((await as(a, (r) => r.dnsZones.getByResource(two.resourceId)))?.id).toBe(two.id);
    // Another customer's row, a missing one and a malformed id are one answer (R8).
    expect(await as(a, (r) => r.dnsZones.get(other.id))).toBeNull();
    expect(await as(a, (r) => r.dnsZones.getByResource(other.resourceId))).toBeNull();
    expect(await as(a, (r) => r.dnsZones.get(uuidv7()))).toBeNull();
    expect(await as(a, (r) => r.dnsZones.get("not-a-uuid"))).toBeNull();
  });

  it("creates the row for the customer's own resource only", async () => {
    const a = await newCustomer(t.pool);
    const b = await newCustomer(t.pool);
    const mine = await newResource(t.pool, a, { family: "dns_zone", region: "us-east-1" });
    const bs = await newResource(t.pool, b, { family: "dns_zone", region: "us-east-1" });
    const id = uuidv7();
    const zoneName = name();
    expect(
      await as(a, (r) =>
        r.dnsZones.create({ id, resourceId: mine, name: zoneName, status: "pending" }),
      ),
    ).toMatchObject({ ok: true });
    expect(
      await as(a, (r) =>
        r.dnsZones.create({ id: uuidv7(), resourceId: bs, name: name(), status: "pending" }),
      ),
    ).toMatchObject({ ok: false, error: "not_found" });
    const row = await t.pool.query("select customer_id from dns_zones where id = $1", [id]);
    expect(row.rows[0]?.customer_id).toBe(a);
  });

  it("refuses a name that is not a zone name and a status that is not a word", async () => {
    const a = await newCustomer(t.pool);
    const res = await newResource(t.pool, a, { family: "dns_zone", region: "us-east-1" });
    for (const bad of ["", "com", "A.example", "a b.example", "a..example", "x".repeat(300)]) {
      expect(
        await as(a, (r) =>
          r.dnsZones.create({ id: uuidv7(), resourceId: res, name: bad, status: "pending" }),
        ),
      ).toMatchObject({ ok: false, error: "validation" });
    }
    expect(
      await as(a, (r) =>
        r.dnsZones.create({ id: uuidv7(), resourceId: res, name: name(), status: "bogus" }),
      ),
    ).toMatchObject({ ok: false, error: "validation" });
  });
});

describe("one delegated zone for a name (migration 0012)", () => {
  it("lets several customers hold a pending zone for one name", async () => {
    const a = await newCustomer(t.pool);
    const b = await newCustomer(t.pool);
    const first = await zone(a);
    await zone(b, { name: first.zoneName });
    await zone(b, { name: first.zoneName, status: "pending_delegation" });
  });

  it("rejects a second delegated zone with the same name, from any customer", async () => {
    const a = await newCustomer(t.pool);
    const b = await newCustomer(t.pool);
    const first = await zone(a, { status: "delegated" });
    const resourceId = await newResource(t.pool, b, { family: "dns_zone", region: "us-east-1" });
    await expect(
      insertRow(t.pool, "dns_zones", {
        customer_id: b,
        resource_id: resourceId,
        name: first.zoneName,
        status: "delegated",
      }),
    ).rejects.toMatchObject({ code: "23505" });
    // A pending zone is not blocked by it, and cannot become delegated beside it.
    const pending = await zone(b, { name: first.zoneName });
    await expect(
      t.pool.query("update dns_zones set status = 'delegated' where id = $1", [pending.id]),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("gives the name back when the delegated zone is removed or failed", async () => {
    const a = await newCustomer(t.pool);
    const first = await zone(a, { status: "delegated" });
    await t.pool.query("update dns_zones set status = 'removed' where id = $1", [first.id]);
    const again = await zone(a, { name: first.zoneName, status: "delegated" });
    await t.pool.query("update dns_zones set status = 'failed' where id = $1", [again.id]);
    await zone(a, { name: first.zoneName, status: "delegated" });
  });

  it("allows only the status words of the list", async () => {
    const a = await newCustomer(t.pool);
    const resourceId = await newResource(t.pool, a, { family: "dns_zone", region: "us-east-1" });
    await expect(
      insertRow(t.pool, "dns_zones", {
        customer_id: a,
        resource_id: resourceId,
        name: name(),
        status: "weird",
      }),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

describe("dnsZoneNameHolder", () => {
  it("answers the resource of the delegated zone, nothing for a pending, failed or removed one or a free name", async () => {
    const a = await newCustomer(t.pool);
    const live = await zone(a, { status: "delegated" });
    expect(await t.db.transaction((tx) => dnsZoneNameHolder(tx, live.zoneName))).toBe(
      live.resourceId,
    );
    expect(await t.db.transaction((tx) => dnsZoneNameHolder(tx, name()))).toBeNull();
    const pending = await zone(a);
    expect(await t.db.transaction((tx) => dnsZoneNameHolder(tx, pending.zoneName))).toBeNull();
    const failed = await zone(a, { status: "delegated" }, "failed");
    expect(await t.db.transaction((tx) => dnsZoneNameHolder(tx, failed.zoneName))).toBeNull();
    const removed = await zone(a, { status: "removed" });
    expect(await t.db.transaction((tx) => dnsZoneNameHolder(tx, removed.zoneName))).toBeNull();
  });

  it("refuses a value that is no zone name", async () => {
    await expect(t.db.transaction((tx) => dnsZoneNameHolder(tx, "NOT A NAME"))).rejects.toThrow(
      TypeError,
    );
  });
});

describe("zoneNameDomainHold", () => {
  const label = (p: string) =>
    p +
    uniqueSuffix()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
  async function domain(customerId: string, domainName: string, state = "active") {
    const tld = domainName.slice(domainName.lastIndexOf(".") + 1);
    await t.pool.query(
      "insert into tlds (id, tld, synced_at) values (gen_random_uuid(), $1, now()) on conflict do nothing",
      [tld],
    );
    const resourceId = await newResource(t.pool, customerId, {
      family: "domain",
      region: "us-east-1",
      state,
    });
    await insertRow(t.pool, "domains", {
      customer_id: customerId,
      resource_id: resourceId,
      name: domainName,
      tld,
      status: "registered",
    });
  }
  const hold = (zoneName: string, customerId: string) =>
    t.db.transaction((tx) => zoneNameDomainHold(tx, zoneName, customerId));

  it("tells the same name and every subdomain of another customer's domain from the owner's own", async () => {
    const a = await newCustomer(t.pool);
    const b = await newCustomer(t.pool);
    const base = `${label("b")}.example`;
    await domain(a, base);
    expect(await hold(base, b)).toBe("other");
    expect(await hold(`www.${base}`, b)).toBe("other");
    expect(await hold(`a.www.${base}`, b)).toBe("other");
    expect(await hold(base, a)).toBe("own");
    expect(await hold(`www.${base}`, a)).toBeNull();
    expect(await hold(`a.www.${base}`, a)).toBeNull();
  });

  it("matches whole labels only: a look-alike suffix and a parent of the domain are no match", async () => {
    const a = await newCustomer(t.pool);
    const b = await newCustomer(t.pool);
    const base = `${label("c")}.example`;
    await domain(a, `b.${base}`);
    expect(await hold(`a.b.${base}`, b)).toBe("other");
    expect(await hold(`notb.${base}`, b)).toBeNull();
    expect(await hold(`xb.${base}`, b)).toBeNull();
    expect(await hold(`b.${base}.example`, b)).toBeNull();
    expect(await hold(base, b)).toBeNull();
  });

  it("another customer's domain wins over the owner's parent, and a failed create holds nothing", async () => {
    const a = await newCustomer(t.pool);
    const b = await newCustomer(t.pool);
    const base = `${label("d")}.example`;
    await domain(a, base);
    await domain(b, `sub.${base}`);
    expect(await hold(`x.sub.${base}`, a)).toBe("other");
    const failedBase = `${label("e")}.example`;
    await domain(a, failedBase, "failed");
    expect(await hold(failedBase, b)).toBeNull();
    await expect(hold("NOT A NAME", b)).rejects.toThrow(TypeError);
  });
});

describe("what the provisioner writes on the row", () => {
  const config = {
    zoneName: "x.example",
    hostedZoneId: "Z0123ABC",
    nameServers: ["ns-1.awsdns-01.org.", "ns-2.awsdns-02.com"],
  };

  it("moves the hosted zone and the name servers from the config and waits for delegation", async () => {
    const a = await newCustomer(t.pool);
    const z = await zone(a);
    await t.pool.query("update resources set config = $2::jsonb where id = $1", [
      z.resourceId,
      JSON.stringify(config),
    ]);
    expect(await t.db.transaction((tx) => recordDnsZoneCreated(tx, z.resourceId))).toBe(true);
    const row = await t.pool.query(
      "select hosted_zone_id, name_servers, status from dns_zones where id = $1",
      [z.id],
    );
    expect(row.rows[0]).toEqual({
      hosted_zone_id: "Z0123ABC",
      name_servers: ["ns-1.awsdns-01.org", "ns-2.awsdns-02.com"],
      status: "pending_delegation",
    });
  });

  it("changes nothing when the config has no well-formed zone id or name servers (R16)", async () => {
    const a = await newCustomer(t.pool);
    for (const bad of [
      {},
      { ...config, hostedZoneId: "z-lower" },
      { ...config, nameServers: [] },
      { ...config, nameServers: ["bad name"] },
      { ...config, nameServers: "ns-1" },
    ]) {
      const z = await zone(a);
      await t.pool.query("update resources set config = $2::jsonb where id = $1", [
        z.resourceId,
        JSON.stringify(bad),
      ]);
      expect(await t.db.transaction((tx) => recordDnsZoneCreated(tx, z.resourceId))).toBe(false);
      const row = await t.pool.query("select status, hosted_zone_id from dns_zones where id = $1", [
        z.id,
      ]);
      expect(row.rows[0]).toEqual({ status: "pending", hosted_zone_id: null });
    }
  });

  it("marks a zone failed or removed once, and never touches a resource that is no zone", async () => {
    const a = await newCustomer(t.pool);
    const z = await zone(a);
    expect(await t.db.transaction((tx) => markDnsZone(tx, z.resourceId, "removing"))).toBe(true);
    expect(await t.db.transaction((tx) => markDnsZone(tx, z.resourceId, "removed"))).toBe(true);
    expect(await t.db.transaction((tx) => markDnsZone(tx, z.resourceId, "failed"))).toBe(false);
    const server = await newResource(t.pool, a, {});
    expect(await t.db.transaction((tx) => markDnsZone(tx, server, "failed"))).toBe(false);
    await expect(t.db.transaction((tx) => markDnsZone(tx, "nope", "failed"))).rejects.toThrow(
      TypeError,
    );
    await expect(
      t.db.transaction((tx) => markDnsZone(tx, z.resourceId, "delegated" as never)),
    ).rejects.toThrow(TypeError);
  });
});
