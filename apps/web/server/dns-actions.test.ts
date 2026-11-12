import type { CustomerSession } from "@tc/auth";
import type { CustomerOperation, ResourceSummary } from "@tc/db";
import { describe, expect, it } from "vitest";
import { changeRecordCore, type DnsOpsDeps, type DnsOpsRepos } from "./dns-actions.ts";

// WPU-G4: the Server Action core of the DNS record editor. R9 order, R8 (cross-tenant), R12 (flag), R7
// (idempotency key), R11 (no customer text in a name other than the validated record), R16.

const NOW = new Date("2026-11-12T10:00:00Z");
const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const ZONE = "0190aaaa-0000-7000-8000-0000000000d1";
const REQ = "0190aaaa-0000-7000-8000-0000000000f1";

const session = (customerId = ALICE): CustomerSession => ({
  customerId,
  kycStatus: "verified",
  riskTier: "new",
  locale: "bn",
  signedInAt: NOW,
});

const zoneRow = (over: Partial<ResourceSummary> = {}): ResourceSummary => ({
  id: ZONE,
  family: "dns_zone",
  productId: null,
  region: "us-east-1",
  state: "active",
  parentResourceId: null,
  config: {
    zoneName: "example.com",
    hostedZoneId: "Z000001",
    records: [
      { name: "example.com", type: "NS", ttl: 172800, values: ["ns-1.example."], readOnly: true },
      { name: "www.example.com", type: "A", ttl: 300, values: ["203.0.113.10"] },
    ],
  },
  createdAt: NOW,
  deletedAt: null,
  ...over,
});

const operation = (over: Partial<CustomerOperation>): CustomerOperation => ({
  id: "op-1",
  resourceId: ZONE,
  kind: "change_dns_record",
  state: "queued",
  step: null,
  needsApproval: false,
  createdAt: NOW,
  ...over,
});

function world(
  over: {
    owner?: string;
    row?: ResourceSummary;
    flag?: boolean;
    allowed?: boolean;
    auditOk?: boolean;
    inFlight?: CustomerOperation[];
    requestError?: "not_found" | "validation";
  } = {},
) {
  const calls: string[] = [];
  const owner = over.owner ?? ALICE;
  const row = over.row ?? zoneRow();
  let current: CustomerSession | null = session();
  const repos = (customerId: string): DnsOpsRepos => ({
    dnsOn: async () => {
      calls.push("flag");
      return over.flag !== false;
    },
    resources: {
      list: async () => [],
      // The repository answers only for the customer's own row (R8).
      get: async (id) => (customerId === owner && id === row.id ? row : null),
      countLive: async () => 0,
      listChildren: async () => [],
      createBackupRow: async () => ({ ok: false, error: "validation" }),
    },
    operations: {
      get: async () => null,
      listRecent: async () => [],
      listForResource: async () => {
        calls.push("ops:list");
        return over.inFlight ?? [];
      },
      request: async (input) => {
        calls.push(
          `op:${input.kind}:${JSON.stringify(input.payload ?? null)}:${input.idempotencyKey}`,
        );
        if (over.requestError) return { ok: false, error: over.requestError };
        return { ok: true, replayed: false, value: operation({ kind: input.kind }) };
      },
    },
    audit: {
      record: async (input) => {
        calls.push(`audit:${input.action}:${input.targetType}:${input.targetId}`);
        return over.auditOk === false
          ? { ok: false, error: "validation" }
          : { ok: true, replayed: false, value: { id: "a" } };
      },
    },
    rateLimits: {
      consume: async () => {
        calls.push("rateLimit");
        return over.allowed === false
          ? { allowed: false, action: "x", retryAfterSeconds: 5 }
          : { allowed: true };
      },
    },
  });
  const deps: DnsOpsDeps = {
    authenticate: async () => {
      calls.push("authenticate");
      return current;
    },
    now: () => NOW,
    store: async (customerId, fn) => {
      calls.push("store");
      return fn(repos(customerId));
    },
  };
  return { deps, calls, setSession: (s: CustomerSession | null) => (current = s) };
}

const add = {
  zoneId: ZONE,
  requestId: REQ,
  mode: "create",
  name: "api",
  type: "A",
  ttl: "300",
  values: "203.0.113.20",
};
const wrote = (calls: string[]) => calls.some((c) => c.startsWith("op:") || c.startsWith("audit:"));

describe("R9 order: authenticate, authorize, validate, rate limit, execute, audit", () => {
  it("adds a record in that order and queues one change_dns_record operation", async () => {
    const w = world();
    expect(await changeRecordCore(w.deps, add)).toEqual({ ok: true, done: "added" });
    expect(w.calls).toEqual([
      "authenticate",
      "store",
      "flag",
      "rateLimit",
      "ops:list",
      expect.stringMatching(/^op:change_dns_record:/),
      "ops:list",
      `audit:dns.change_record:resource:${ZONE}`,
    ]);
    const op = w.calls.find((c) => c.startsWith("op:")) as string;
    expect(op).toContain(
      JSON.stringify({
        change: "create",
        name: "api.example.com",
        type: "A",
        ttl: 300,
        values: ["203.0.113.20"],
      }),
    );
    expect(op).toMatch(/:dns\.change:0190aaaa-0000-7000-8000-0000000000f1:[0-9a-f]{8}$/);
  });

  it("refuses without a session and does nothing else", async () => {
    const w = world();
    w.setSession(null);
    expect(await changeRecordCore(w.deps, add)).toEqual({ ok: false, error: "unauthenticated" });
    expect(w.calls).toEqual(["authenticate"]);
  });

  it("refuses a bad form before it reads anything (zod)", async () => {
    for (const bad of [
      null,
      "x",
      { ...add, zoneId: "not-a-uuid" },
      { ...add, requestId: "" },
      { ...add, mode: "drop" },
      { ...add, zoneId: undefined },
      { ...add, ttl: "3e2" },
      { ...add, ttl: "-5" },
    ]) {
      const w = world();
      const out = await changeRecordCore(w.deps, bad);
      expect(out.ok, JSON.stringify(bad)).toBe(false);
      expect(wrote(w.calls)).toBe(false);
      expect(w.calls).not.toContain("store");
    }
  });

  it("returns the field codes of the core for a bad record, writes nothing and counts no rate limit", async () => {
    const w = world();
    const out = await changeRecordCore(w.deps, { ...add, values: "999.1.1.1" });
    expect(out).toEqual({ ok: false, error: "validation", fields: { "values.0": "invalid_ipv4" } });
    expect(w.calls).not.toContain("rateLimit");
    expect(wrote(w.calls)).toBe(false);
  });

  it("rate limits after the checks and before it writes", async () => {
    const w = world({ allowed: false });
    expect(await changeRecordCore(w.deps, add)).toEqual({ ok: false, error: "rate_limited" });
    expect(wrote(w.calls)).toBe(false);
  });

  it("rolls back when the audit entry is refused (R9, R16)", async () => {
    const w = world({ auditOk: false });
    expect(await changeRecordCore(w.deps, add)).toEqual({ ok: false, error: "unavailable" });
  });
});

describe("cross-tenant (R8)", () => {
  it("another customer's zone answers like a missing zone and writes nothing", async () => {
    const other = world({ owner: BOB });
    const missing = world({ row: zoneRow({ id: "0190aaaa-0000-7000-8000-0000000000ee" }) });
    const a = await changeRecordCore(other.deps, add);
    const b = await changeRecordCore(missing.deps, add);
    expect(a).toEqual({ ok: false, error: "not_found" });
    expect(b).toEqual(a);
    expect(wrote(other.calls)).toBe(false);
  });

  it("a row that is not a DNS zone is not found, even for its owner", async () => {
    const w = world({ row: zoneRow({ family: "linux_instance" }) });
    expect(await changeRecordCore(w.deps, add)).toEqual({ ok: false, error: "not_found" });
  });

  it("ignores a customerId in the form: the store gets the session's customer", async () => {
    const w = world({ owner: ALICE });
    const out = await changeRecordCore(w.deps, { ...add, customerId: BOB });
    expect(out).toEqual({ ok: true, done: "added" });
  });
});

describe("flag, state and busy (R12, R16)", () => {
  it("with the flag off nothing is written", async () => {
    const w = world({ flag: false });
    expect(await changeRecordCore(w.deps, add)).toEqual({ ok: false, error: "flag_off" });
    expect(wrote(w.calls)).toBe(false);
  });

  it("a zone that is not active cannot be changed", async () => {
    const w = world({ row: zoneRow({ state: "creating" }) });
    expect(await changeRecordCore(w.deps, add)).toEqual({ ok: false, error: "not_allowed" });
  });

  it("a zone whose list is stale or whose hosted zone is not made yet cannot be changed (R16)", async () => {
    const stale = world({
      row: zoneRow({ config: { zoneName: "example.com", hostedZoneId: "Z1", recordsStale: true } }),
    });
    expect(await changeRecordCore(stale.deps, add)).toEqual({ ok: false, error: "not_allowed" });
    const none = world({ row: zoneRow({ config: { zoneName: "example.com" } }) });
    expect(await changeRecordCore(none.deps, add)).toEqual({ ok: false, error: "not_allowed" });
  });

  it("a change that is still on its way blocks the next one", async () => {
    const w = world({ inFlight: [operation({ id: "op-prev", state: "running" })] });
    expect(await changeRecordCore(w.deps, add)).toEqual({ ok: false, error: "busy" });
    expect(w.calls.some((c) => c.startsWith("audit:"))).toBe(false);
  });
});

describe("the rules that need the other records", () => {
  it("create of a name and type that exist is a conflict; upsert replaces", async () => {
    const w = world();
    const create = await changeRecordCore(w.deps, { ...add, name: "www" });
    expect(create).toEqual({ ok: false, error: "conflict", fields: { name: "exists" } });
    const upsert = await changeRecordCore(world().deps, { ...add, name: "www", mode: "upsert" });
    expect(upsert).toEqual({ ok: true, done: "changed" });
  });

  it("a CNAME next to another record at the name is refused", async () => {
    const out = await changeRecordCore(world().deps, {
      ...add,
      name: "www",
      type: "CNAME",
      values: "other.example.net",
      mode: "upsert",
    });
    expect(out).toMatchObject({ ok: false, error: "conflict", fields: { name: "cname_conflict" } });
  });

  it("the apex NS cannot be changed or deleted", async () => {
    for (const mode of ["create", "upsert", "delete"]) {
      const out = await changeRecordCore(world().deps, {
        ...add,
        mode,
        name: "@",
        type: "NS",
        values: "ns.example.net",
      });
      expect(out.ok, mode).toBe(false);
    }
  });

  it("delete needs an existing set and sends only the name and the type", async () => {
    const w = world();
    expect(
      await changeRecordCore(w.deps, { ...add, mode: "delete", name: "www", values: "" }),
    ).toEqual({
      ok: true,
      done: "removed",
    });
    const op = w.calls.find((c) => c.startsWith("op:")) as string;
    expect(op).toContain(JSON.stringify({ change: "delete", name: "www.example.com", type: "A" }));
    const missing = await changeRecordCore(world().deps, { ...add, mode: "delete", name: "nope" });
    expect(missing).toEqual({ ok: false, error: "not_found" });
  });

  it("a different payload with the same request id gets another idempotency key (R7)", async () => {
    const one = world();
    const two = world();
    await changeRecordCore(one.deps, add);
    await changeRecordCore(two.deps, { ...add, values: "203.0.113.21" });
    const key = (w: ReturnType<typeof world>) =>
      (w.calls.find((c) => c.startsWith("op:")) as string).split(":").slice(-1)[0];
    expect(key(one)).not.toBe(key(two));
    const again = world();
    await changeRecordCore(again.deps, add);
    expect(key(again)).toBe(key(one));
  });
});

describe("what leaves the core", () => {
  it("is a fixed key, never the text of an error (U6)", async () => {
    const w = world();
    w.deps.store = async () => {
      throw new Error("connect ECONNREFUSED arn:aws:rds:ap-south-1:123456789012:db:x");
    };
    const out = await changeRecordCore(w.deps, add);
    expect(out).toEqual({ ok: false, error: "unavailable" });
    expect(JSON.stringify(out)).not.toMatch(/arn:|ECONN|\d{12}/);
  });
});
