import { decideFailure, MAX_ATTEMPTS, validateRecord, type ValidRecord } from "@tc/core";
import { describe, expect, it } from "vitest";
import {
  applyRecordChange,
  createDnsZoneAdapter,
  listZoneRecords,
  type DnsZoneConfig,
} from "../adapters/dns-zone";
import type { OpCtx } from "../adapters/types";
import { AwsError } from "../errors";
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
      // WPU-Y5 (c): CreateHostedZone runs at create_zone; step null only moves there.
      step: "step" in extra ? (extra.step ?? null) : "create_zone",
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

/**
 * WPU-Z19: a zone create is two steps: CreateHostedZone, then GetChange until INSYNC. Runs both, as step.ts would:
 * the wait's configMerge is in the resource config of the next run.
 */
async function createZone(
  adapter: ReturnType<typeof createDnsZoneAdapter>,
  ctx: OpCtx<DnsZoneConfig>,
) {
  const first = await adapter.aws.create(ctx);
  if (first.kind !== "wait") return first;
  const merge = (first.patch?.configMerge ?? {}) as Record<string, unknown>;
  return adapter.aws.create({
    ...ctx,
    operation: { ...ctx.operation, step: first.step },
    resource: {
      ...ctx.resource,
      config: { ...(ctx.resource.config as Record<string, unknown>), ...merge },
    },
  });
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
    const first = await createZone(adapter, ctx);
    const second = await createZone(adapter, ctx);
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

  it("saves the record list with the zone, so the editor of a fresh zone has its read-only apex records (WPU-G6)", async () => {
    const fake = createFakeRoute53();
    const adapter = createDnsZoneAdapter({ route53: () => fake.port });
    const result = await createZone(adapter, ctxFor({ zoneName: "example.com" }));
    const merge = (result as { patch?: { configMerge?: Record<string, unknown> } }).patch
      ?.configMerge;
    expect(merge?.recordsStale).toBe(false);
    const records = merge?.records as { name: string; type: string; readOnly?: true }[];
    expect(records.map((r) => `${r.type}:${r.name}`).sort()).toEqual([
      "NS:example.com",
      "SOA:example.com",
    ]);
    expect(records.every((r) => r.readOnly === true)).toBe(true);
    // The zone state is active, and nothing but the zone name of the customer was sent to Route 53.
    expect((result as { patch?: { state?: string } }).patch?.state).toBe("active");
    expect(fake.calls.filter((c) => c.op === "createHostedZone")).toHaveLength(1);
  });

  it("marks the list stale when it does not fit the step patch, instead of failing the create (R16)", async () => {
    const fake = createFakeRoute53();
    const adapter = createDnsZoneAdapter({ route53: () => fake.port });
    const created = await createZone(adapter, ctxFor({ zoneName: "example.com" }));
    const id = (created as { patch?: { configMerge?: { hostedZoneId?: string } } }).patch
      ?.configMerge?.hostedZoneId as string;
    const big = Array.from({ length: 400 }, (_, i) => `h${i}.example.com`);
    await fake.port.changeRecordSets(
      id,
      big.map((n) => ({
        action: "CREATE" as const,
        set: { name: `${n}.`, type: "A", ttl: 60, values: ["192.0.2.1"] },
      })),
    );
    const again = await createZone(adapter, ctxFor({ zoneName: "example.com" }));
    const merge = (again as { patch?: { configMerge?: Record<string, unknown> } }).patch
      ?.configMerge;
    expect(merge).toMatchObject({ records: null, recordsStale: true });
  });

  it("describe answers active for a live zone and missing otherwise", async () => {
    const fake = createFakeRoute53();
    const adapter = createDnsZoneAdapter({ route53: () => fake.port });
    await createZone(adapter, ctxFor({ zoneName: "example.com" }));
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
    await createZone(adapter, ctxFor({ zoneName: "example.com" }));
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

  it("WPU-Z19: destroy of a full zone (100 sets of 20 values) splits the DELETEs into batches under the limits", async () => {
    const fake = createFakeRoute53();
    const adapter = createDnsZoneAdapter({ route53: () => fake.port });
    await createZone(adapter, ctxFor({ zoneName: "example.com" }));
    for (let i = 0; i < 100; i += 1) {
      fake.seed("Z000001", {
        name: `h${i}.example.com.`,
        type: "A",
        ttl: 300,
        values: Array.from({ length: 20 }, (_, j) => `203.0.113.${j + 1}`),
      });
    }
    const ctx = ctxFor(
      { zoneName: "example.com" },
      { resourceConfig: { hostedZoneId: "Z000001" } },
    );
    expect((await adapter.aws.destroy(ctx)).kind).toBe("done");
    expect(fake.zones.size).toBe(0);
    const batches = fake.calls
      .filter((c) => c.op === "changeRecordSets")
      .map((c) => c.detail as { action: string; set: { values: string[] } }[]);
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      expect(batch.every((c) => c.action === "DELETE")).toBe(true);
      expect(batch.reduce((n, c) => n + c.set.values.length, 0)).toBeLessThanOrEqual(1000);
      expect(batch.reduce((n, c) => n + c.set.values.join("").length, 0)).toBeLessThanOrEqual(
        32_000,
      );
    }
    expect(batches.flat()).toHaveLength(100);
  });

  it("WPU-Z19: the zone is active only when GetChange says INSYNC; PENDING waits, and the wait is bounded", async () => {
    const fake = createFakeRoute53();
    const adapter = createDnsZoneAdapter({ route53: () => fake.port });
    const ctx = ctxFor({ zoneName: "example.com" });
    const first = await adapter.aws.create(ctx);
    expect(first).toMatchObject({ kind: "wait", step: "wait_insync" });
    const merge = (first as { patch?: { configMerge?: Record<string, unknown> } }).patch
      ?.configMerge;
    expect(merge).toMatchObject({ hostedZoneId: "Z000001", route53ChangeId: "CZ000001" });
    // Not active yet: the customer is not told to set the name servers before INSYNC.
    expect((first as { patch?: { state?: string } }).patch?.state).toBeUndefined();
    const waiting = { step: "wait_insync", resourceConfig: merge };
    fake.changes.set("CZ000001", "pending");
    expect(await adapter.aws.create(ctxFor({ zoneName: "example.com" }, waiting))).toMatchObject({
      kind: "wait",
      step: "wait_insync",
    });
    const late = ctxFor({ zoneName: "example.com" }, waiting);
    await expect(
      adapter.aws.create({
        ...late,
        operation: { ...late.operation, createdAt: new Date(NOW.getTime() - 21 * 60 * 1000) },
      }),
    ).rejects.toMatchObject({ code: "upstream_unavailable" });
    fake.changes.set("CZ000001", "insync");
    const done = await adapter.aws.create(ctxFor({ zoneName: "example.com" }, waiting));
    expect(done).toMatchObject({
      kind: "done",
      patch: { state: "active", configMerge: { hostedZoneId: "Z000001" } },
    });
    expect(fake.calls.filter((c) => c.op === "createHostedZone")).toHaveLength(1);
  });

  it("WPU-Y5: step null only moves to create_zone, with no AWS call; CreateHostedZone runs at create_zone", async () => {
    const fake = createFakeRoute53();
    const adapter = createDnsZoneAdapter({ route53: () => fake.port });
    expect(await adapter.aws.create(ctxFor({ zoneName: "example.com" }, { step: null }))).toEqual({
      kind: "next",
      step: "create_zone",
    });
    expect(fake.calls).toEqual([]);
    expect(
      await adapter.aws.create(ctxFor({ zoneName: "example.com" }, { step: "create_zone" })),
    ).toMatchObject({ kind: "wait", step: "wait_insync" });
    expect(fake.calls.filter((c) => c.op === "createHostedZone")).toHaveLength(1);
  });

  it("WPU-Z19: a step without a saved zone or with a foreign change id is refused (R16)", async () => {
    const fake = createFakeRoute53();
    const adapter = createDnsZoneAdapter({ route53: () => fake.port });
    await expect(
      adapter.aws.create(ctxFor({ zoneName: "example.com" }, { step: "wait_insync" })),
    ).rejects.toMatchObject({ code: "internal" });
    await expect(
      adapter.aws.create(
        ctxFor(
          { zoneName: "example.com" },
          {
            step: "wait_insync",
            resourceConfig: { hostedZoneId: "Z000001", route53ChangeId: "../x" },
          },
        ),
      ),
    ).rejects.toMatchObject({ code: "internal" });
    await expect(
      adapter.aws.create(ctxFor({ zoneName: "example.com" }, { step: "elsewhere" })),
    ).rejects.toMatchObject({ code: "internal" });
  });

  // Final review Z19 I-1: once CreateHostedZone ran, the hosted zone exists (and is billed). A create that cannot
  // finish its wait (PENDING past the budget, or a saved zone or change id that cannot be read) must never end
  // `failed`, whose hook refunds the order while the zone stays: it ends in needs_attention for an admin.
  const endOf = (error: unknown) => {
    const e = error as {
      code: never;
      retryable: boolean;
      poolFull: boolean;
      awsErrorName: string | null;
    };
    const facts = {
      code: e.code,
      retryable: e.retryable,
      poolFull: e.poolFull,
      awsErrorName: e.awsErrorName,
      mayHaveActed: true,
    };
    const decisions = Array.from({ length: MAX_ATTEMPTS }, (_, attempts) =>
      decideFailure({ kind: "create", step: "wait_insync", attempts, now: NOW, facts }),
    );
    return decisions;
  };
  const expectAttention = (error: unknown) => {
    const decisions = endOf(error);
    for (const d of decisions) expect(d.to).not.toBe("failed");
    expect(decisions.at(-1)?.to).toBe("needs_attention");
  };

  it("PENDING past budget ends needs_attention, no refund", async () => {
    const fake = createFakeRoute53();
    const adapter = createDnsZoneAdapter({ route53: () => fake.port });
    const first = await adapter.aws.create(ctxFor({ zoneName: "example.com" }));
    const merge = (first as { patch?: { configMerge?: Record<string, unknown> } }).patch
      ?.configMerge;
    fake.changes.set("CZ000001", "pending");
    const late = ctxFor(
      { zoneName: "example.com" },
      { step: "wait_insync", resourceConfig: merge },
    );
    const error = await adapter.aws
      .create({
        ...late,
        operation: { ...late.operation, createdAt: new Date(NOW.getTime() - 21 * 60 * 1000) },
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(error).toMatchObject({ code: "upstream_unavailable", retryable: true });
    expectAttention(error);
    // a later run that finds the change INSYNC still finishes the create
    fake.changes.set("CZ000001", "insync");
    expect(
      await adapter.aws.create({
        ...late,
        operation: { ...late.operation, createdAt: new Date(NOW.getTime() - 40 * 60 * 1000) },
      }),
    ).toMatchObject({ kind: "done", patch: { state: "active" } });
  });

  it("a bad saved zone or change id, or a step it does not know, ends needs_attention, no refund", async () => {
    const adapter = createDnsZoneAdapter({ route53: () => createFakeRoute53().port });
    for (const extra of [
      { step: "wait_insync" },
      { step: "wait_insync", resourceConfig: { hostedZoneId: "Z000001", route53ChangeId: "../x" } },
      { step: "wait_insync", resourceConfig: { hostedZoneId: "../z", route53ChangeId: null } },
      { step: "elsewhere" },
    ]) {
      const error = await adapter.aws.create(ctxFor({ zoneName: "example.com" }, extra)).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error, JSON.stringify(extra)).toMatchObject({ code: "internal", retryable: true });
      expectAttention(error);
    }
  });

  // WPU-Y5 (b): at wait_insync the hosted zone exists. A final (non-retryable) answer of GetChange, GetHostedZone or
  // ListResourceRecordSets (NoSuchChange or NoSuchHostedZone -> not_found, a validation, a conflict) must not end
  // the create `failed` (its hook refunds the order while the zone may stay): it becomes attention().
  it("a final error of GetChange, GetHostedZone or ListResourceRecordSets at wait_insync ends needs_attention", async () => {
    const finals = [
      new AwsError({ code: "not_found", retryable: false, awsErrorName: "NoSuchChange" }),
      new AwsError({ code: "not_found", retryable: false, awsErrorName: "NoSuchHostedZone" }),
      new AwsError({ code: "validation", retryable: false, awsErrorName: "InvalidInput" }),
      new AwsError({ code: "conflict", retryable: false, awsErrorName: "InvalidChangeBatch" }),
    ];
    for (const call of ["getChangeStatus", "getHostedZone", "listRecordSets"] as const) {
      for (const final of finals) {
        const fake = createFakeRoute53();
        const first = await createDnsZoneAdapter({ route53: () => fake.port }).aws.create(
          ctxFor({ zoneName: "example.com" }),
        );
        const merge = (first as { patch?: { configMerge?: Record<string, unknown> } }).patch
          ?.configMerge;
        fake.changes.set("CZ000001", "insync");
        const port = { ...fake.port, [call]: () => Promise.reject(final) };
        const error = await createDnsZoneAdapter({ route53: () => port })
          .aws.create(
            ctxFor({ zoneName: "example.com" }, { step: "wait_insync", resourceConfig: merge }),
          )
          .then(
            () => null,
            (e: unknown) => e,
          );
        const label = `${call} ${final.awsErrorName}`;
        expect(error, label).toBeInstanceOf(AwsError);
        expect(error, label).toMatchObject({
          code: "upstream_unavailable",
          retryable: true,
          awsErrorName: final.awsErrorName,
        });
        expectAttention(error);
      }
    }
  });

  it("a retryable error at wait_insync is passed on unchanged", async () => {
    const fake = createFakeRoute53();
    const first = await createDnsZoneAdapter({ route53: () => fake.port }).aws.create(
      ctxFor({ zoneName: "example.com" }),
    );
    const merge = (first as { patch?: { configMerge?: Record<string, unknown> } }).patch
      ?.configMerge;
    const throttled = new AwsError({
      code: "rate_limited",
      retryable: true,
      awsErrorName: "Throttling",
    });
    const port = { ...fake.port, getChangeStatus: () => Promise.reject(throttled) };
    await expect(
      createDnsZoneAdapter({ route53: () => port }).aws.create(
        ctxFor({ zoneName: "example.com" }, { step: "wait_insync", resourceConfig: merge }),
      ),
    ).rejects.toBe(throttled);
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
    await createZone(adapter, ctxFor({ zoneName: "example.com" }));
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
