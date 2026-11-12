import { describe, expect, it } from "vitest";
import {
  listDnsZonesPendingDelegation,
  markDnsZoneDelegated,
  recordDnsZoneNotices,
  retireUndelegatedDnsZone,
} from "../repositories/dns-zone-sync";
import { newCustomer, newResource, uniqueSuffix } from "./fixtures";
import { insertRow } from "./sql";
import { useTempDatabase } from "./temp-db";

// WPU-D4 (audit C.24): what the delegation job reads and writes on `dns_zones`, as the worker role does
// it. The zone name is the only key to a hostname; every write is compare-and-set and idempotent (R7).

const t = useTempDatabase();
const NOW = new Date("2026-11-20T06:00:00.000Z");
const NS = [
  "ns-1.awsdns-01.org",
  "ns-2.awsdns-02.com",
  "ns-3.awsdns-03.net",
  "ns-4.awsdns-04.co.uk",
];
const tx = <T>(fn: Parameters<typeof t.db.transaction>[0]) => t.db.transaction(fn) as Promise<T>;

async function zone(
  customerId: string,
  over: Record<string, unknown> = {},
  opts: { subscription?: "active" | "none"; createdAt?: string } = {},
) {
  const resourceId = await newResource(t.pool, customerId, {
    family: "dns_zone",
    region: "us-east-1",
    state: "active",
  });
  const name =
    "z" +
    uniqueSuffix()
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "") +
    ".example";
  const id = await insertRow(t.pool, "dns_zones", {
    customer_id: customerId,
    resource_id: resourceId,
    name,
    status: "pending_delegation",
    hosted_zone_id:
      "Z" +
      uniqueSuffix()
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "")
        .slice(0, 12),
    name_servers: NS,
    ...(opts.createdAt === undefined ? {} : { created_at: opts.createdAt }),
    ...over,
  });
  if (opts.subscription !== "none") {
    await insertRow(t.pool, "subscriptions", {
      resource_id: resourceId,
      customer_id: customerId,
      term_days: 30,
      price_snapshot: "{}",
      period_start: "2026-11-10",
      period_end: "2026-12-10",
      status: "active",
    });
  }
  return { id, resourceId, name };
}

const row = async (id: string) =>
  (await t.pool.query("select * from dns_zones where id = $1", [id])).rows[0];

describe("listDnsZonesPendingDelegation", () => {
  it("lists only zones in pending_delegation, oldest first, with their notices", async () => {
    const c = await newCustomer(t.pool);
    const older = await zone(c, {}, { createdAt: "2026-10-01T00:00:00Z" });
    const newer = await zone(c, {}, { createdAt: "2026-10-05T00:00:00Z" });
    await zone(c, { status: "delegated" });
    await zone(c, { status: "pending" });
    await zone(c, { status: "removing" });
    await t.pool.query("update dns_zones set notices_sent_at = $2 where id = $1", [
      older.id,
      ["2026-10-08T00:00:00Z"],
    ]);
    const mine = (
      await tx<Awaited<ReturnType<typeof listDnsZonesPendingDelegation>>>((q) =>
        listDnsZonesPendingDelegation(q, 100),
      )
    ).filter((z) => [older.id, newer.id].includes(z.id));
    expect(mine.map((z) => z.id)).toEqual([older.id, newer.id]);
    expect(mine[0]).toMatchObject({
      resourceId: older.resourceId,
      customerId: c,
      name: older.name,
      nameServers: NS,
    });
    expect(mine[0]?.createdAt).toEqual(new Date("2026-10-01T00:00:00Z"));
    expect(mine[0]?.noticesSentAt).toEqual([new Date("2026-10-08T00:00:00Z")]);
    expect(mine[1]?.noticesSentAt).toEqual([]);
  });

  it("honours the limit and refuses a limit that is not a small positive integer", async () => {
    await expect(tx((q) => listDnsZonesPendingDelegation(q, 0))).rejects.toThrow(RangeError);
    await expect(tx((q) => listDnsZonesPendingDelegation(q, 1.5))).rejects.toThrow(RangeError);
    await expect(tx((q) => listDnsZonesPendingDelegation(q, 1001))).rejects.toThrow(RangeError);
    expect(await tx<unknown[]>((q) => listDnsZonesPendingDelegation(q, 1))).toHaveLength(1);
  });
});

describe("markDnsZoneDelegated", () => {
  it("moves pending_delegation to delegated with the time, once", async () => {
    const c = await newCustomer(t.pool);
    const z = await zone(c);
    expect(await tx((q) => markDnsZoneDelegated(q, z.id, NOW))).toBe(true);
    expect(await row(z.id)).toMatchObject({ status: "delegated", delegated_at: NOW });
    expect(await tx((q) => markDnsZoneDelegated(q, z.id, new Date(NOW.getTime() + 1000)))).toBe(
      false,
    );
    expect((await row(z.id)).delegated_at).toEqual(NOW);
  });

  it("changes nothing for a zone in another state", async () => {
    const c = await newCustomer(t.pool);
    for (const status of ["pending", "removing", "removed", "failed"]) {
      const z = await zone(c, { status });
      expect(await tx((q) => markDnsZoneDelegated(q, z.id, NOW))).toBe(false);
      expect((await row(z.id)).status).toBe(status);
    }
  });

  it("leaves a zone pending when another customer's zone already holds the name delegated (WPU-S1)", async () => {
    const a = await newCustomer(t.pool);
    const b = await newCustomer(t.pool);
    const held = await zone(a, { status: "delegated" });
    const late = await zone(b, { name: held.name });
    expect(await tx((q) => markDnsZoneDelegated(q, late.id, NOW))).toBe(false);
    expect((await row(late.id)).status).toBe("pending_delegation");
  });

  it("refuses an id that is not a UUID", async () => {
    await expect(tx((q) => markDnsZoneDelegated(q, "nope", NOW))).rejects.toThrow(TypeError);
  });
});

describe("recordDnsZoneNotices", () => {
  it("appends the time once for the notice, as a compare-and-set on the count", async () => {
    const c = await newCustomer(t.pool);
    const z = await zone(c);
    expect(await tx((q) => recordDnsZoneNotices(q, z.id, 0, 1, NOW))).toBe(true);
    // the same notice again (a replay of the job) changes nothing
    expect(await tx((q) => recordDnsZoneNotices(q, z.id, 0, 1, NOW))).toBe(false);
    expect((await row(z.id)).notices_sent_at).toEqual([NOW]);
    expect(await tx((q) => recordDnsZoneNotices(q, z.id, 1, 1, new Date(NOW.getTime() + 5)))).toBe(
      true,
    );
    expect((await row(z.id)).notices_sent_at).toHaveLength(2);
  });

  it("fills the slots of notices that were missed", async () => {
    const c = await newCustomer(t.pool);
    const z = await zone(c);
    expect(await tx((q) => recordDnsZoneNotices(q, z.id, 0, 2, NOW))).toBe(true);
    expect((await row(z.id)).notices_sent_at).toEqual([NOW, NOW]);
  });

  it("does not touch a zone that is no longer waiting for delegation, and refuses bad counts", async () => {
    const c = await newCustomer(t.pool);
    const z = await zone(c, { status: "delegated" });
    expect(await tx((q) => recordDnsZoneNotices(q, z.id, 0, 1, NOW))).toBe(false);
    await expect(tx((q) => recordDnsZoneNotices(q, z.id, 0, 3, NOW))).rejects.toThrow(RangeError);
    await expect(tx((q) => recordDnsZoneNotices(q, z.id, -1, 1, NOW))).rejects.toThrow(RangeError);
  });
});

describe("retireUndelegatedDnsZone", () => {
  const lastOperation = async (resourceId: string) =>
    (
      await t.pool.query(
        "select kind, state, needs_approval, idempotency_key, payload from operations where resource_id = $1 order by created_at desc",
        [resourceId],
      )
    ).rows;

  it("retains the subscription, marks the zone removing and queues ONE destroy (waiting for approval before the end date of R13)", async () => {
    const c = await newCustomer(t.pool);
    const z = await zone(c);
    const out = await tx<Awaited<ReturnType<typeof retireUndelegatedDnsZone>>>((q) =>
      retireUndelegatedDnsZone(q, z.id, NOW),
    );
    expect(out).toMatchObject({ resourceId: z.resourceId, created: true });
    expect((await row(z.id)).status).toBe("removing");
    expect(
      (
        await t.pool.query("select status from subscriptions where resource_id = $1", [
          z.resourceId,
        ])
      ).rows[0],
    ).toEqual({ status: "retained" });
    const ops = await lastOperation(z.resourceId);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      kind: "destroy",
      idempotency_key: `dns-undelegated:${z.id}`,
      payload: { reason: "undelegated" },
    });
    // the platform setting r13_approval_until decides: the row is either waiting or queued, never lost
    expect(["needs_approval", "queued"]).toContain(ops[0].state);
  });

  it("is idempotent: a second call is a replay (the zone is no longer pending_delegation)", async () => {
    const c = await newCustomer(t.pool);
    const z = await zone(c);
    await tx((q) => retireUndelegatedDnsZone(q, z.id, NOW));
    expect(await tx((q) => retireUndelegatedDnsZone(q, z.id, NOW))).toBeNull();
    expect(await lastOperation(z.resourceId)).toHaveLength(1);
  });

  it("does nothing for a zone that was delegated meanwhile, or that has no subscription (R16)", async () => {
    const c = await newCustomer(t.pool);
    const delegated = await zone(c, { status: "delegated" });
    expect(await tx((q) => retireUndelegatedDnsZone(q, delegated.id, NOW))).toBeNull();
    expect(await lastOperation(delegated.resourceId)).toHaveLength(0);
    const bare = await zone(c, {}, { subscription: "none" });
    expect(await tx((q) => retireUndelegatedDnsZone(q, bare.id, NOW))).toBeNull();
    expect((await row(bare.id)).status).toBe("pending_delegation");
    expect(await lastOperation(bare.resourceId)).toHaveLength(0);
  });

  it("writes no wallet entry: the removal has no ledger effect", async () => {
    const c = await newCustomer(t.pool);
    const z = await zone(c);
    const before = await t.pool.query("select count(*)::int as n from ledger_transactions");
    await tx((q) => retireUndelegatedDnsZone(q, z.id, NOW));
    const after = await t.pool.query("select count(*)::int as n from ledger_transactions");
    expect(after.rows[0]).toEqual(before.rows[0]);
  });
});
