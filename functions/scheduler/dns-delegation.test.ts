import { createManualClock, createMemoryQueue, runDnsDelegation, type LogEvent } from "@tc/core";
import {
  ensureMarket,
  insertRow,
  newCustomer,
  newResource,
  runTransaction,
  uniqueSuffix,
  useTempDatabase,
} from "@tc/db/testing";
import { describe, expect, it } from "vitest";
import {
  DNS_DELEGATION_EVERY_MINUTES,
  createDelegationStore,
  createNsLookup,
  dnsDelegationDue,
} from "./dns-delegation";
import { createHandler } from "./index";

// WPU-D4 (audit C.24): the scheduler job that watches the zones in pending_delegation. The DNS lookup is
// a fake resolver; the store runs against the real database as worker_rw (the grants are the proof).

const t = useTempDatabase();
const DAY = 86_400_000;
const NS = [
  "ns-1.awsdns-01.org",
  "ns-2.awsdns-02.com",
  "ns-3.awsdns-03.net",
  "ns-4.awsdns-04.co.uk",
];
const NOW = new Date("2026-11-20T06:00:00.000Z");
const runTx = <T>(fn: Parameters<typeof runTransaction<T>>[1]) =>
  runTransaction(t.db, fn, { role: "worker_rw" });

async function zone(over: Record<string, unknown> = {}, ageDays = 1) {
  const customerId = await newCustomer(t.pool);
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
    created_at: new Date(NOW.getTime() - ageDays * DAY).toISOString(),
    ...over,
  });
  await insertRow(t.pool, "subscriptions", {
    resource_id: resourceId,
    customer_id: customerId,
    term_days: 30,
    price_snapshot: "{}",
    period_start: "2026-11-10",
    period_end: "2026-12-10",
    status: "active",
  });
  return { id, resourceId, customerId, name };
}

const zoneRow = async (id: string) =>
  (await t.pool.query("select * from dns_zones where id = $1", [id])).rows[0];
const notices = async (customerId: string) =>
  (
    await t.pool.query(
      "select channel, template, payload, dedupe_key from notifications where customer_id = $1 order by channel",
      [customerId],
    )
  ).rows;

function job(answer: (name: string) => string[] | Error) {
  const looked: string[] = [];
  const queue = createMemoryQueue({ clock: { now: () => NOW } });
  const lookup = createNsLookup({
    resolveNs: async (host) => {
      looked.push(host);
      const a = answer(host);
      if (a instanceof Error) throw a;
      return a;
    },
  });
  const logs: LogEvent[] = [];
  return {
    looked,
    queue,
    logs,
    run: () =>
      runDnsDelegation({
        store: createDelegationStore(runTx),
        lookup,
        clock: { now: () => NOW },
        log: (e) => logs.push(e),
        queue,
      }),
  };
}

const dnsError = (code: string) =>
  Object.assign(new Error(`queryNs ${code} secret.example`), { code });

describe("createNsLookup", () => {
  it("returns the NS names of the answer", async () => {
    const lookup = createNsLookup({ resolveNs: async () => ["NS1.Registrar.example"] });
    expect(await lookup("shop.example")).toEqual({ kind: "ns", names: ["NS1.Registrar.example"] });
  });
  it("maps 'no such name' and 'no NS records' to a definite none", async () => {
    for (const code of ["ENODATA", "ENOTFOUND"]) {
      const lookup = createNsLookup({
        resolveNs: async () => {
          throw dnsError(code);
        },
      });
      expect(await lookup("shop.example")).toEqual({ kind: "none" });
    }
    expect(await createNsLookup({ resolveNs: async () => [] })("shop.example")).toEqual({
      kind: "none",
    });
  });
  it("maps a time-out, SERVFAIL, a refusal and anything else to failed, never to none (R16)", async () => {
    for (const code of [
      "ETIMEOUT",
      "ESERVFAIL",
      "EREFUSED",
      "ECONNREFUSED",
      "EAI_AGAIN",
      "EWHATEVER",
    ]) {
      const lookup = createNsLookup({
        resolveNs: async () => {
          throw dnsError(code);
        },
      });
      expect(await lookup("shop.example")).toEqual({ kind: "failed" });
    }
    expect(await createNsLookup({ resolveNs: async () => "x" as never })("a.example")).toEqual({
      kind: "failed",
    });
  });
  it("refuses to look up a name that is not a valid zone name", async () => {
    let called = false;
    const lookup = createNsLookup({
      resolveNs: async () => {
        called = true;
        return [];
      },
    });
    expect(await lookup("evil.example\nx")).toEqual({ kind: "failed" });
    expect(called).toBe(false);
  });
});

describe("dnsDelegationDue", () => {
  it("runs once in every window of the minutes", () => {
    expect(DNS_DELEGATION_EVERY_MINUTES).toBe(10);
    const at = (m: number) => new Date(Date.UTC(2026, 10, 20, 6, m, 30));
    expect([0, 1, 9, 10, 19, 20, 30, 59].filter((m) => dnsDelegationDue(at(m)))).toEqual([
      0, 10, 20, 30,
    ]);
  });
});

describe("the job against the database", () => {
  it("marks a zone delegated when its domain points to the zone's name servers", async () => {
    const z = await zone();
    const j = job(() => NS.map((n) => `${n}.`));
    const report = await j.run();
    expect(j.looked).toContain(z.name);
    expect(report.delegated).toBeGreaterThanOrEqual(1);
    expect(await zoneRow(z.id)).toMatchObject({ status: "delegated", delegated_at: NOW });
  });

  it("does nothing while the NS records are elsewhere, and nothing when the lookup fails", async () => {
    const elsewhere = await zone();
    const unknown = await zone({}, 20);
    const j = job((name) =>
      name === unknown.name ? dnsError("ETIMEOUT") : ["ns1.registrar.example"],
    );
    await j.run();
    expect((await zoneRow(elsewhere.id)).status).toBe("pending_delegation");
    // 20 days old, no notice yet, but the lookup failed: no notice, no removal
    expect(await zoneRow(unknown.id)).toMatchObject({
      status: "pending_delegation",
      notices_sent_at: [],
    });
    expect(await notices(unknown.customerId)).toEqual([]);
  });

  it("sends the day-7 notice once, as an email and a bell item, and records it", async () => {
    const z = await zone({}, 7);
    const j = job(() => ["ns1.registrar.example"]);
    await j.run();
    await j.run();
    expect((await zoneRow(z.id)).notices_sent_at).toEqual([NOW]);
    const sent = await notices(z.customerId);
    expect(sent.map((n) => [n.channel, n.template])).toEqual([
      ["email", "dns_delegation_notice"],
      ["in_app", "dns_delegation_notice"],
    ]);
    expect(sent[0]?.payload).toEqual({
      domain: z.name,
      day: 7,
      removeAt: new Date(NOW.getTime() + 7 * DAY).toISOString(),
    });
    expect(sent[0]?.dedupe_key).toContain(`dns-delegation:${z.id}:1`);
  });

  it("sends the day-12 notice, then removes the zone from day 14: a destroy that waits for approval", async () => {
    const day12 = await zone({}, 12);
    const j = job(() => ["ns1.registrar.example"]);
    await j.run();
    // told once, for day 12; the day-7 notice it missed is counted in the same record
    expect((await zoneRow(day12.id)).notices_sent_at).toHaveLength(2);
    expect(await notices(day12.customerId)).toHaveLength(2);

    const old = await zone(
      {
        notices_sent_at: [
          new Date(NOW.getTime() - 7 * DAY).toISOString(),
          new Date(NOW.getTime() - 2 * DAY).toISOString(),
        ],
      },
      14,
    );
    await j.run();
    await j.run();
    expect((await zoneRow(old.id)).status).toBe("removing");
    const ops = (
      await t.pool.query("select kind, state, payload from operations where resource_id = $1", [
        old.resourceId,
      ])
    ).rows;
    expect(ops).toEqual([
      { kind: "destroy", state: "needs_approval", payload: { reason: "undelegated" } },
    ]);
    expect(
      (
        await t.pool.query("select status from subscriptions where resource_id = $1", [
          old.resourceId,
        ])
      ).rows[0],
    ).toEqual({ status: "retained" });
    // no wallet effect, no message on the queue while the destroy waits for an admin
    expect(j.queue.receive()).toEqual([]);
  });

  it("sends the queue message after the commit when no approval is needed any more", async () => {
    // The end date of R13 is in the past: a destroy no longer waits for an admin. (Without the row, as
    // in the tests above, approval is required: fail closed.)
    await ensureMarket(t.pool, "BD");
    await t.pool.query("delete from settings where key = 'r13_approval_until'");
    await t.pool.query(
      `insert into settings (id, key, market, scope, scope_id, value)
       values (gen_random_uuid(), 'r13_approval_until', 'BD', 'market', null, '"2026-01-01T00:00:00.000Z"'::jsonb)`,
    );
    const old = await zone(
      {
        notices_sent_at: [
          new Date(NOW.getTime() - 7 * DAY).toISOString(),
          new Date(NOW.getTime() - 2 * DAY).toISOString(),
        ],
      },
      15,
    );
    const j = job(() => ["ns1.registrar.example"]);
    await j.run();
    const op = (
      await t.pool.query("select id, state from operations where resource_id = $1", [
        old.resourceId,
      ])
    ).rows[0];
    expect(op.state).toBe("queued");
    const received = j.queue.receive().map((m) => JSON.parse(m.body));
    expect(received).toContainEqual(
      expect.objectContaining({ operationId: op.id, resourceId: old.resourceId }),
    );
  });

  it("looks up only the stored names and logs no domain name (R14)", async () => {
    const z = await zone({}, 7);
    const j = job(() => ["ns1.registrar.example"]);
    await j.run();
    expect(j.looked.every((n) => /^[a-z0-9.-]+$/.test(n))).toBe(true);
    expect(JSON.stringify(j.logs)).not.toContain(z.name);
  });
});

describe("the scheduler handler", () => {
  it("runs the job only in its window, when a lookup is wired, and logs counts", async () => {
    const logged: LogEvent[] = [];
    const clockAt = (iso: string) => createManualClock(new Date(iso));
    const make = (iso: string) => {
      const clock = clockAt(iso);
      return createHandler({
        runTx: (fn) => runTransaction(t.db, fn, { role: "worker_rw" }),
        clock,
        queue: createMemoryQueue({ clock }),
        log: (e) => logged.push(e),
        dnsLookup: createNsLookup({ resolveNs: async () => ["ns1.registrar.example"] }),
      });
    };
    const quiet = await make("2026-11-20T06:03:00Z")();
    expect(quiet.dnsDelegation).toBeNull();
    const due = await make("2026-11-20T06:10:00Z")();
    expect(due.dnsDelegation).toMatchObject({ failed: 0 });
    expect(logged.map((e) => e.event)).toContain("dns_delegation_run");
  });

  it("is off when no lookup is wired (existing deployments and tests)", async () => {
    const clock = createManualClock(new Date("2026-11-20T06:10:00Z"));
    const handler = createHandler({
      runTx: (fn) => runTransaction(t.db, fn, { role: "worker_rw" }),
      clock,
      queue: createMemoryQueue({ clock }),
      log: () => {},
    });
    expect((await handler()).dnsDelegation).toBeNull();
  });
});
