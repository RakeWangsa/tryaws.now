import { v7 as uuidv7 } from "uuid";
import { describe, expect, it } from "vitest";
import type { CustomerRepos } from "../repositories/customer/index";
import { applyDomainFacts, readDomainSyncView } from "../repositories/domain-sync";
import { withCustomerRepos } from "../testing/repos";
import { newCustomer, newResource, uniqueSuffix } from "./fixtures";
import { expectSqlError, insertRow } from "./sql";
import { useTempDatabase } from "./temp-db";

// WPU-B2: the unique active name of migration 0024, the closed status words, and what the provisioner
// reads and writes on the `domains` row. The cross-tenant cases of the repository are in
// cross-tenant-cases/domains.ts (unchanged: the repository did not gain a method).

const t = useTempDatabase();
const as = <T>(c: string, fn: (r: CustomerRepos) => Promise<T>) => withCustomerRepos(t.db, c, fn);
const label = () =>
  "d" +
  uniqueSuffix()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

async function tld(): Promise<void> {
  await t.pool.query(
    "insert into tlds (id, tld, synced_at) values ($1, 'com', now()) on conflict do nothing",
    [uuidv7()],
  );
}

async function domain(
  customerId: string,
  name: string,
  status = "pending",
  config: Record<string, unknown> = {},
) {
  await tld();
  const resourceId = await newResource(t.pool, customerId, {
    family: "domain",
    region: "us-east-1",
    config: JSON.stringify(config),
  });
  const id = await insertRow(t.pool, "domains", {
    customer_id: customerId,
    resource_id: resourceId,
    name,
    tld: "com",
    status,
  });
  return { id, resourceId };
}

describe("domains_name_active_unique (migration 0024)", () => {
  it("holds a name once on the platform, whoever asks, in every status but failed", async () => {
    const a = await newCustomer(t.pool);
    const b = await newCustomer(t.pool);
    for (const status of ["pending", "review", "awaiting_verification", "registered", "expired"]) {
      const name = `${label()}.com`;
      await domain(a, name, status);
      await expectSqlError(domain(a, name), "23505", { constraint: "domains_name_active_unique" });
      await expectSqlError(domain(b, name), "23505", { constraint: "domains_name_active_unique" });
    }
  });

  it("gives the name back when the order failed, and a failed row never blocks a new order", async () => {
    const a = await newCustomer(t.pool);
    const b = await newCustomer(t.pool);
    const name = `${label()}.com`;
    await domain(a, name, "failed");
    await domain(b, name, "pending");
    // A second failed row for one name is fine too.
    await domain(a, name, "failed");
    await expectSqlError(domain(a, name, "pending"), "23505", {
      constraint: "domains_name_active_unique",
    });
  });

  it("refuses a status word that is not in the closed list", async () => {
    const a = await newCustomer(t.pool);
    await expectSqlError(domain(a, `${label()}.com`, "registering"), "23514", {
      constraint: "domains_status_check",
    });
  });

  it("the repository insert of the purchase raises the unique violation that the savepoint of the purchase turns into a conflict", async () => {
    const a = await newCustomer(t.pool);
    const b = await newCustomer(t.pool);
    const name = `${label()}.com`;
    await domain(a, name, "pending");
    await tld();
    const resourceId = await newResource(t.pool, b, { family: "domain", region: "us-east-1" });
    await expectSqlError(
      as(b, (r) =>
        r.domains.create({
          id: uuidv7(),
          resourceId,
          name,
          tld: "com",
          status: "pending",
          contactEncrypted: new Uint8Array([1, 2, 3]),
        }),
      ),
      "23505",
      { constraint: "domains_name_active_unique" },
    );
  });
});

describe("domain-sync (worker side)", () => {
  it("reads the status and the config of a domain resource, and nothing for another family", async () => {
    const a = await newCustomer(t.pool);
    const d = await domain(a, `${label()}.com`, "pending", { domainStatus: "registered" });
    const view = await t.db.transaction((tx) => readDomainSyncView(tx, d.resourceId));
    expect(view?.status).toBe("pending");
    expect(view?.config).toMatchObject({ domainStatus: "registered" });
    const other = await newResource(t.pool, a, { family: "linux_instance" });
    expect(await t.db.transaction((tx) => readDomainSyncView(tx, other))).toBeNull();
    await expect(t.db.transaction((tx) => readDomainSyncView(tx, "nope"))).rejects.toThrow(
      TypeError,
    );
  });

  it("moves the row from the status that was read, saves the facts, and does nothing when the status moved on", async () => {
    const a = await newCustomer(t.pool);
    const d = await domain(a, `${label()}.com`, "pending");
    const expiresAt = new Date("2031-01-01T00:00:00.000Z");
    expect(
      await t.db.transaction((tx) =>
        applyDomainFacts(tx, d.resourceId, {
          from: "pending",
          to: "awaiting_verification",
          expiresAt,
          hostedZoneId: "Z0123456789",
          route53OperationId: "op-1",
        }),
      ),
    ).toBe(true);
    const row = await t.pool.query(
      "select status, expires_at, hosted_zone_id, route53_operation_id from domains where id = $1",
      [d.id],
    );
    expect(row.rows[0]).toMatchObject({
      status: "awaiting_verification",
      hosted_zone_id: "Z0123456789",
      route53_operation_id: "op-1",
    });
    expect(new Date(row.rows[0].expires_at as string).toISOString()).toBe(expiresAt.toISOString());
    // The same call again: the row is no longer `pending`, nothing changes (R16, R7).
    expect(
      await t.db.transaction((tx) =>
        applyDomainFacts(tx, d.resourceId, { from: "pending", to: "failed" }),
      ),
    ).toBe(false);
    // A fact left out keeps the column.
    expect(
      await t.db.transaction((tx) =>
        applyDomainFacts(tx, d.resourceId, { from: "awaiting_verification", to: "registered" }),
      ),
    ).toBe(true);
    const kept = await t.pool.query("select hosted_zone_id from domains where id = $1", [d.id]);
    expect(kept.rows[0]).toMatchObject({ hosted_zone_id: "Z0123456789" });
  });

  it("throws on a word outside the lists and on a malformed id, and writes nothing", async () => {
    const a = await newCustomer(t.pool);
    const d = await domain(a, `${label()}.com`, "pending");
    const bad = [
      { from: "pending", to: "registering" },
      { from: "gone", to: "failed" },
      { from: "pending", to: "failed", hostedZoneId: "z-1; drop" },
      { from: "pending", to: "failed", route53OperationId: "a b" },
      { from: "pending", to: "failed", expiresAt: new Date(Number.NaN) },
    ];
    for (const facts of bad) {
      await expect(
        t.db.transaction((tx) => applyDomainFacts(tx, d.resourceId, facts)),
      ).rejects.toThrow(TypeError);
    }
    const row = await t.pool.query("select status from domains where id = $1", [d.id]);
    expect(row.rows[0]).toMatchObject({ status: "pending" });
  });

  it("matches no row for a resource that is no domain", async () => {
    const a = await newCustomer(t.pool);
    const other = await newResource(t.pool, a, { family: "linux_instance" });
    expect(
      await t.db.transaction((tx) =>
        applyDomainFacts(tx, other, { from: "pending", to: "failed" }),
      ),
    ).toBe(false);
  });
});
