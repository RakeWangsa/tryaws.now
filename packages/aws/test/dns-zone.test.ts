import { validateRecord, type ValidRecord } from "@tc/core";
import { describe, expect, it } from "vitest";
import {
  applyRecordChange,
  createDnsZoneAdapter,
  listZoneRecords,
  type DnsZoneConfig,
} from "../adapters/dns-zone";
import type { OpCtx } from "../adapters/types";
import { createFakeRoute53 } from "./fake-route53";

const NOW = new Date("2030-01-01T00:00:00.000Z");

function ctxFor(
  config: DnsZoneConfig,
  extra: { step?: string | null; resourceConfig?: unknown; opId?: string } = {},
): OpCtx<DnsZoneConfig> {
  return {
    operation: {
      id: extra.opId ?? "0190a000-0000-7000-8000-000000000001",
      kind: "create",
      step: extra.step ?? null,
      attempt: 1,
      createdAt: NOW,
      payload: {},
    },
    stepKey: "k",
    resource: {
      id: "0190a000-0000-7000-8000-0000000000aa",
      customerId: "0190a000-0000-7000-8000-0000000000bb",
      family: "dns_zone",
      productId: null,
      parentResourceId: null,
      awsName: null,
      state: "active",
      config: extra.resourceConfig ?? {},
    },
    config,
    account: { awsAccountId: "123456789012", externalId: "ext-1" },
    region: "us-east-1",
    access: {} as never,
    env: {} as never,
    clock: { now: () => NOW },
    owned: async () => null,
  } as OpCtx<DnsZoneConfig>;
}

function record(name: string, type: string, values: string[], ttl = 300): ValidRecord {
  const r = validateRecord("example.com", { name, type, ttl, values });
  if (!r.ok) throw new Error("fixture");
  return r.value;
}

describe("the zone adapter", () => {
  it("parses the config with the zone name rules and refuses anything else", () => {
    const { port } = createFakeRoute53();
    const adapter = createDnsZoneAdapter({ route53: () => port });
    expect(adapter.family).toBe("dns_zone");
    expect(adapter.parseConfig({ zoneName: "Example.COM." })).toEqual({ zoneName: "example.com" });
    for (const bad of [
      null,
      {},
      { zoneName: "com" },
      { zoneName: 5 },
      { zoneName: "a b.com" },
      "example.com",
    ]) {
      expect(() => adapter.parseConfig(bad)).toThrow();
    }
  });

  it("creates the zone with the operation id as caller reference, and a retry makes no second zone", async () => {
    const fake = createFakeRoute53();
    const adapter = createDnsZoneAdapter({ route53: () => fake.port });
    const ctx = ctxFor({ zoneName: "example.com" });
    const first = await adapter.aws.create(ctx);
    const second = await adapter.aws.create(ctx);
    expect(fake.zones.size).toBe(1);
    expect(fake.calls.filter((c) => c.op === "createHostedZone").map((c) => c.detail)).toEqual([
      { callerReference: ctx.operation.id },
      { callerReference: ctx.operation.id },
    ]);
    expect(first).toEqual(second);
    expect(first.kind).toBe("done");
    const patch = (first as { patch?: { configMerge?: Record<string, unknown> } }).patch;
    expect(patch?.configMerge).toMatchObject({ hostedZoneId: "Z000001" });
    expect(patch?.configMerge?.nameServers).toHaveLength(4);
  });

  it("describe answers active for a live zone and missing otherwise", async () => {
    const fake = createFakeRoute53();
    const adapter = createDnsZoneAdapter({ route53: () => fake.port });
    await adapter.aws.create(ctxFor({ zoneName: "example.com" }));
    const live = ctxFor(
      { zoneName: "example.com" },
      { resourceConfig: { hostedZoneId: "Z000001" } },
    );
    expect(await adapter.aws.describe(live)).toEqual({ state: "active" });
    const gone = ctxFor(
      { zoneName: "example.com" },
      { resourceConfig: { hostedZoneId: "Z999999" } },
    );
    expect(await adapter.aws.describe(gone)).toEqual({ state: "missing" });
    expect(await adapter.aws.describe(ctxFor({ zoneName: "example.com" }))).toEqual({
      state: "missing",
    });
  });

  it("suspend, resume, final snapshot and purge keep the zone and do nothing", async () => {
    const fake = createFakeRoute53();
    const adapter = createDnsZoneAdapter({ route53: () => fake.port });
    const ctx = ctxFor({ zoneName: "example.com" });
    for (const method of ["suspend", "resume", "finalSnapshot", "purgeSnapshots"] as const) {
      expect((await adapter.aws[method](ctx)).kind).toBe("done");
    }
    expect(fake.calls).toEqual([]);
  });

  it("destroy removes the customer's records and the zone, never touches the apex NS and SOA, and a repeat is done", async () => {
    const fake = createFakeRoute53();
    const adapter = createDnsZoneAdapter({ route53: () => fake.port });
    await adapter.aws.create(ctxFor({ zoneName: "example.com" }));
    fake.seed("Z000001", { name: "www.example.com.", type: "A", ttl: 300, values: ["1.2.3.4"] });
    const ctx = ctxFor(
      { zoneName: "example.com" },
      { resourceConfig: { hostedZoneId: "Z000001" } },
    );
    expect((await adapter.aws.destroy(ctx)).kind).toBe("done");
    expect(fake.zones.size).toBe(0);
    const batch = fake.calls.find((c) => c.op === "changeRecordSets")?.detail as {
      set: { type: string };
    }[];
    expect(batch.map((c) => c.set.type)).toEqual(["A"]);
    expect((await adapter.aws.destroy(ctx)).kind).toBe("done");
  });

  it("destroy without a hosted zone id is done (nothing was made)", async () => {
    const adapter = createDnsZoneAdapter({ route53: () => createFakeRoute53().port });
    expect((await adapter.aws.destroy(ctxFor({ zoneName: "example.com" }))).kind).toBe("done");
  });

  it("refuses an action kind it does not know", async () => {
    const adapter = createDnsZoneAdapter({ route53: () => createFakeRoute53().port });
    await expect(
      adapter.aws.action("reboot", ctxFor({ zoneName: "example.com" })),
    ).rejects.toThrow();
  });
});

describe("the record editor against the zone", () => {
  async function zone() {
    const fake = createFakeRoute53();
    const adapter = createDnsZoneAdapter({ route53: () => fake.port });
    await adapter.aws.create(ctxFor({ zoneName: "example.com" }));
    return { fake, id: "Z000001" };
  }

  it("lists the sets without the trailing dot and marks the apex NS and SOA read-only", async () => {
    const { fake, id } = await zone();
    fake.seed(id, { name: "\\052.example.com.", type: "A", ttl: 300, values: ["1.2.3.4"] });
    const list = await listZoneRecords(fake.port, id, "example.com");
    const byKey = Object.fromEntries(list.map((s) => [`${s.fqdn}|${s.type}`, s]));
    expect(byKey["example.com|NS"]?.readOnly).toBe(true);
    expect(byKey["example.com|SOA"]?.readOnly).toBe(true);
    expect(byKey["*.example.com|A"]?.readOnly).toBe(false);
  });

  it("creates, replaces and deletes a record through one batch each", async () => {
    const { fake, id } = await zone();
    const create = await applyRecordChange(fake.port, {
      hostedZoneId: id,
      zoneName: "example.com",
      action: "create",
      record: record("www", "A", ["1.2.3.4"]),
    });
    expect(create).toEqual({ ok: true, value: undefined });
    const again = await applyRecordChange(fake.port, {
      hostedZoneId: id,
      zoneName: "example.com",
      action: "create",
      record: record("www", "A", ["1.2.3.4"]),
    });
    expect(again).toMatchObject({ ok: false, error: "conflict" });
    const upsert = await applyRecordChange(fake.port, {
      hostedZoneId: id,
      zoneName: "example.com",
      action: "upsert",
      record: record("www", "A", ["5.6.7.8"], 600),
    });
    expect(upsert.ok).toBe(true);
    const sent = fake.calls
      .filter((c) => c.op === "changeRecordSets")
      .map(
        (c) =>
          (
            c.detail as { action: string; set: { name: string; ttl: number; values: string[] } }[]
          )[0],
      );
    expect(sent[0]).toMatchObject({
      action: "CREATE",
      set: { name: "www.example.com.", ttl: 300, values: ["1.2.3.4"] },
    });
    expect(sent[1]).toMatchObject({ action: "UPSERT", set: { ttl: 600, values: ["5.6.7.8"] } });
    const del = await applyRecordChange(fake.port, {
      hostedZoneId: id,
      zoneName: "example.com",
      action: "delete",
      record: record("www", "A", ["5.6.7.8"], 600),
    });
    expect(del.ok).toBe(true);
    const missing = await applyRecordChange(fake.port, {
      hostedZoneId: id,
      zoneName: "example.com",
      action: "delete",
      record: record("www", "A", ["5.6.7.8"]),
    });
    expect(missing).toMatchObject({ ok: false, error: "not_found" });
  });

  it("refuses every change to the apex NS and SOA before any call to Route 53 writes", async () => {
    const { fake, id } = await zone();
    const before = fake.calls.length;
    for (const action of ["create", "upsert", "delete"] as const) {
      for (const type of ["NS", "SOA"]) {
        const record = {
          fqdn: "example.com",
          type,
          ttl: 300,
          values: ["x"],
          isApex: true,
        } as unknown as ValidRecord;
        const r = await applyRecordChange(fake.port, {
          hostedZoneId: id,
          zoneName: "example.com",
          action,
          record,
        });
        expect(r).toMatchObject({ ok: false, error: "forbidden" });
      }
    }
    expect(fake.calls.slice(before).filter((c) => c.op === "changeRecordSets")).toEqual([]);
  });

  it("refuses a CNAME next to data and enforces the record limit", async () => {
    const { fake, id } = await zone();
    await applyRecordChange(fake.port, {
      hostedZoneId: id,
      zoneName: "example.com",
      action: "create",
      record: record("www", "A", ["1.2.3.4"]),
    });
    const cname = await applyRecordChange(fake.port, {
      hostedZoneId: id,
      zoneName: "example.com",
      action: "create",
      record: record("www", "CNAME", ["t.example.net"]),
    });
    expect(cname).toMatchObject({ ok: false, error: "conflict" });
    const full = await applyRecordChange(fake.port, {
      hostedZoneId: id,
      zoneName: "example.com",
      action: "create",
      record: record("api", "A", ["1.2.3.4"]),
      maxRecordSets: 1,
    });
    expect(full).toMatchObject({ ok: false, error: "limit_reached" });
  });

  it("a record whose type is not allowed never reaches Route 53", async () => {
    const { fake, id } = await zone();
    const bad = {
      fqdn: "x.example.com",
      type: "PTR",
      ttl: 300,
      values: ["x"],
      isApex: false,
    } as unknown as ValidRecord;
    const r = await applyRecordChange(fake.port, {
      hostedZoneId: id,
      zoneName: "example.com",
      action: "create",
      record: bad,
    });
    expect(r).toMatchObject({ ok: false, error: "validation" });
    expect(fake.calls.filter((c) => c.op === "changeRecordSets")).toEqual([]);
  });

  it("maps a zone that is gone to not_found", async () => {
    const fake = createFakeRoute53();
    const r = await applyRecordChange(fake.port, {
      hostedZoneId: "Z404",
      zoneName: "example.com",
      action: "create",
      record: record("www", "A", ["1.2.3.4"]),
    });
    expect(r).toMatchObject({ ok: false, error: "not_found" });
  });
});
