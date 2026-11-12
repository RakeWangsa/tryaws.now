import { describe, expect, it } from "vitest";
import type { QueueMessage } from "../operations/queue";
import {
  runDnsDelegation,
  type DelegationStore,
  type DelegationZone,
  type NsLookup,
} from "./delegation-run";

// WPU-D4 (audit C.24): the delegation job against in-memory ports. No DNS lookup, no database.

const DAY = 86_400_000;
const NOW = new Date("2026-11-20T06:00:00.000Z");
const NS = [
  "ns-1.awsdns-01.org",
  "ns-2.awsdns-02.com",
  "ns-3.awsdns-03.net",
  "ns-4.awsdns-04.co.uk",
];

let counter = 0;
function zone(over: Partial<DelegationZone> & { ageDays?: number } = {}): DelegationZone {
  counter += 1;
  const { ageDays = 1, ...rest } = over;
  return {
    id: `0193f7c2-5b8a-7c3e-9a1b-${String(counter).padStart(12, "0")}`,
    resourceId: `0193f7c3-5b8a-7c3e-9a1b-${String(counter).padStart(12, "0")}`,
    customerId: "0193f7c4-5b8a-7c3e-9a1b-123456789012",
    name: `shop${counter}.example`,
    nameServers: NS,
    createdAt: new Date(NOW.getTime() - ageDays * DAY),
    noticesSentAt: [],
    ...rest,
  };
}

function harness(zones: DelegationZone[], answer: (name: string) => NsLookup | Error) {
  const calls: string[] = [];
  const looked: string[] = [];
  const sent: QueueMessage[] = [];
  const logs: Record<string, unknown>[] = [];
  const store: DelegationStore = {
    pending: async (limit) => zones.slice(0, limit),
    markDelegated: async (z) => {
      calls.push(`delegated:${z.id}`);
      return true;
    },
    recordNotice: async (z, step) => {
      calls.push(`notice${step.notice}:${z.id}`);
      return true;
    },
    retire: async (z) => {
      calls.push(`retire:${z.id}`);
      return { message: { operationId: `op-${z.id}`, resourceId: z.resourceId, enqueueSeq: 0 } };
    },
  };
  const deps = {
    store,
    lookup: async (name: string) => {
      looked.push(name);
      const a = answer(name);
      if (a instanceof Error) throw a;
      return a;
    },
    clock: { now: () => NOW },
    log: (e: Record<string, unknown>) => logs.push(e),
    queue: { send: async (m: QueueMessage) => void sent.push(m) },
  };
  return { deps: deps as never, calls, looked, sent, logs };
}

const matching: NsLookup = { kind: "ns", names: NS.map((n) => `${n.toUpperCase()}.`) };
const elsewhere: NsLookup = {
  kind: "ns",
  names: ["ns1.registrar.example", "ns2.registrar.example"],
};

describe("runDnsDelegation", () => {
  it("marks a zone delegated when the domain's NS records are the zone's name servers", async () => {
    const z = zone({ ageDays: 3 });
    const h = harness([z], () => matching);
    const report = await runDnsDelegation(h.deps);
    expect(h.calls).toEqual([`delegated:${z.id}`]);
    expect(report).toMatchObject({ examined: 1, delegated: 1, noticed: 0, removed: 0, failed: 0 });
  });

  it("keeps a zone pending while the NS records are elsewhere, early in its life", async () => {
    const h = harness([zone({ ageDays: 3 })], () => elsewhere);
    expect(await runDnsDelegation(h.deps)).toMatchObject({ examined: 1, delegated: 0, noticed: 0 });
    expect(h.calls).toEqual([]);
  });

  it("treats a lookup that failed as unknown: no change, no notice, no removal, no error", async () => {
    const old = zone({
      ageDays: 30,
      noticesSentAt: [new Date(NOW.getTime() - 10 * DAY), new Date(NOW.getTime() - 5 * DAY)],
    });
    const h = harness([old, zone({ ageDays: 8 })], (name) =>
      name === old.name ? { kind: "failed" } : new Error("ETIMEOUT"),
    );
    const report = await runDnsDelegation(h.deps);
    expect(h.calls).toEqual([]);
    expect(report).toMatchObject({ examined: 2, unchecked: 2, failed: 0, removed: 0, noticed: 0 });
  });

  it("an answer with no NS records is a definite 'not delegated' and the notices follow", async () => {
    const day7 = zone({ ageDays: 7 });
    const day12 = zone({ ageDays: 12, noticesSentAt: [new Date(NOW.getTime() - 5 * DAY)] });
    const h = harness([day7, day12], () => ({ kind: "none" }));
    const report = await runDnsDelegation(h.deps);
    expect(h.calls.sort()).toEqual([`notice1:${day7.id}`, `notice2:${day12.id}`].sort());
    expect(report).toMatchObject({ noticed: 2, removed: 0 });
  });

  it("removes a zone after day 14 and both notices, and sends the queue message after the commit", async () => {
    const z = zone({
      ageDays: 15,
      noticesSentAt: [new Date(NOW.getTime() - 8 * DAY), new Date(NOW.getTime() - 3 * DAY)],
    });
    const h = harness([z], () => elsewhere);
    const report = await runDnsDelegation(h.deps);
    expect(h.calls).toEqual([`retire:${z.id}`]);
    expect(h.sent).toEqual([
      { operationId: `op-${z.id}`, resourceId: z.resourceId, enqueueSeq: 0 },
    ]);
    expect(report).toMatchObject({ removed: 1, failed: 0 });
  });

  it("does not remove a zone that became delegated on the last day", async () => {
    const z = zone({
      ageDays: 15,
      noticesSentAt: [new Date(NOW.getTime() - 8 * DAY), new Date(NOW.getTime() - 3 * DAY)],
    });
    const h = harness([z], () => matching);
    await runDnsDelegation(h.deps);
    expect(h.calls).toEqual([`delegated:${z.id}`]);
    expect(h.sent).toEqual([]);
  });

  it("looks up only the stored zone name, and skips a stored name that is not a valid zone name", async () => {
    const good = zone({ ageDays: 1 });
    const bad = [
      zone({ name: "evil.example\n" }),
      zone({ name: "a b.example" }),
      zone({ name: "localhost" }),
    ];
    const h = harness([good, ...bad], () => elsewhere);
    const report = await runDnsDelegation(h.deps);
    expect(h.looked).toEqual([good.name]);
    expect(report).toMatchObject({ examined: 4, skipped: 3 });
  });

  it("counts a zone that cannot be marked (its name is held by a delegated zone) as skipped", async () => {
    const z = zone({ ageDays: 2 });
    const h = harness([z], () => matching);
    (h.deps as { store: DelegationStore }).store.markDelegated = async () => false;
    expect(await runDnsDelegation(h.deps)).toMatchObject({ delegated: 0, skipped: 1, failed: 0 });
  });

  it("a failing write fails that zone only, and the report says so", async () => {
    const a = zone({ ageDays: 1 });
    const b = zone({ ageDays: 1 });
    const h = harness([a, b], () => matching);
    const store = (h.deps as { store: DelegationStore }).store;
    const original = store.markDelegated;
    store.markDelegated = async (z, now) => {
      if (z.id === a.id) throw new Error(`boom ${a.name}`);
      return original(z, now);
    };
    const report = await runDnsDelegation(h.deps);
    expect(report).toMatchObject({ delegated: 1, failed: 1 });
    expect(h.calls).toEqual([`delegated:${b.id}`]);
  });

  it("writes no domain name and no name server to the log (R14)", async () => {
    const z = zone({ ageDays: 7 });
    const h = harness([z], () => ({ kind: "none" }));
    await runDnsDelegation(h.deps);
    const text = JSON.stringify(h.logs);
    expect(text).not.toContain(z.name);
    expect(text).not.toContain("awsdns");
  });

  it("handles a batch with a bounded number of lookups at a time", async () => {
    let live = 0;
    let peak = 0;
    const zones = Array.from({ length: 12 }, () => zone({ ageDays: 1 }));
    const h = harness(zones, () => elsewhere);
    const deps = h.deps as { lookup: (n: string) => Promise<NsLookup> };
    const inner = deps.lookup;
    deps.lookup = async (n) => {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 2));
      const out = await inner(n);
      live -= 1;
      return out;
    };
    await runDnsDelegation(h.deps);
    expect(h.looked).toHaveLength(12);
    expect(peak).toBeLessThanOrEqual(5);
  });
});
