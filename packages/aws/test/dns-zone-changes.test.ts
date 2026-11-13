import { describe, expect, it } from "vitest";
import { createDnsZoneAdapter, type DnsZoneConfig } from "../adapters/dns-zone";
import type { OpCtx } from "../adapters/types";
import { createFakeRoute53 } from "./fake-route53";

// WPU-G4: the record editor's operation, `change_dns_record`, run by the zone adapter. The payload is
// written by the web tier, so it is input: the adapter validates it again (R9) with the rules of the
// core, and builds the Route 53 batch only from what passed.

const NOW = new Date("2030-01-01T00:00:00.000Z");
const ZONE_ID = "Z000001";

function ctx(
  payload: unknown,
  resourceConfig: unknown = { hostedZoneId: ZONE_ID },
  zoneName = "example.com",
): OpCtx<DnsZoneConfig> {
  return {
    operation: {
      id: "0190a000-0000-7000-8000-000000000001",
      kind: "change_dns_record",
      step: null,
      attempt: 1,
      createdAt: NOW,
      payload,
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
      config: resourceConfig,
    },
    config: { zoneName },
    account: { awsAccountId: "tc-dns", externalId: "tc-dns" },
    region: "us-east-1",
    access: {} as never,
    env: {} as never,
    clock: { now: () => NOW },
    owned: async () => null,
  } as OpCtx<DnsZoneConfig>;
}

async function zone() {
  const fake = createFakeRoute53();
  const adapter = createDnsZoneAdapter({ route53: () => fake.port });
  await adapter.aws.create({
    ...ctx({}),
    // WPU-Y5 (c): CreateHostedZone runs at create_zone (step null only moves there)
    operation: { ...ctx({}).operation, kind: "create", step: "create_zone" },
    resource: { ...ctx({}).resource, config: {} },
  });
  return { fake, adapter };
}

type Merge = { configMerge?: { records?: unknown; recordsStale?: boolean } };
const merged = (result: { patch?: unknown }): Merge["configMerge"] =>
  (result.patch as Merge | undefined)?.configMerge;

describe("change_dns_record", () => {
  it("creates a record, and the result carries the live list for the screen", async () => {
    const { fake, adapter } = await zone();
    const out = await adapter.aws.action(
      "change_dns_record",
      ctx({ change: "create", name: "www", type: "A", ttl: 300, values: ["203.0.113.10"] }),
    );
    expect(out.kind).toBe("done");
    const sent = fake.calls.filter((c) => c.op === "changeRecordSets");
    expect(sent).toHaveLength(1);
    const records = merged(out)?.records as { name: string; type: string; values: string[] }[];
    expect(records.find((r) => r.name === "www.example.com" && r.type === "A")?.values).toEqual([
      "203.0.113.10",
    ]);
    // The apex NS and SOA are listed and marked read-only.
    expect(records.filter((r) => (r as { readOnly?: boolean }).readOnly)).toHaveLength(2);
  });

  it("converts a TXT value to its wire form from what the customer typed", async () => {
    const { adapter } = await zone();
    const out = await adapter.aws.action(
      "change_dns_record",
      ctx({ change: "create", name: "@", type: "TXT", ttl: 300, values: ["v=spf1 -all"] }),
    );
    const records = merged(out)?.records as { type: string; values: string[] }[];
    expect(records.find((r) => r.type === "TXT")?.values).toEqual(['"v=spf1 -all"']);
  });

  it("replaces a record with upsert and deletes by name and type", async () => {
    const { fake, adapter } = await zone();
    await adapter.aws.action(
      "change_dns_record",
      ctx({ change: "create", name: "www", type: "A", ttl: 300, values: ["1.2.3.4"] }),
    );
    await adapter.aws.action(
      "change_dns_record",
      ctx({ change: "upsert", name: "www", type: "A", ttl: 600, values: ["5.6.7.8"] }),
    );
    const out = await adapter.aws.action(
      "change_dns_record",
      ctx({ change: "delete", name: "www", type: "A" }),
    );
    const records = merged(out)?.records as { name: string }[];
    expect(records.some((r) => r.name === "www.example.com")).toBe(false);
    expect(fake.calls.filter((c) => c.op === "changeRecordSets")).toHaveLength(3);
  });

  it("is idempotent: the same create twice, and the same delete twice, end as done (R7)", async () => {
    const { adapter } = await zone();
    const make = ctx({ change: "create", name: "api", type: "A", ttl: 300, values: ["1.2.3.4"] });
    expect((await adapter.aws.action("change_dns_record", make)).kind).toBe("done");
    expect((await adapter.aws.action("change_dns_record", make)).kind).toBe("done");
    const del = ctx({ change: "delete", name: "api", type: "A" });
    expect((await adapter.aws.action("change_dns_record", del)).kind).toBe("done");
    expect((await adapter.aws.action("change_dns_record", del)).kind).toBe("done");
  });

  it("refuses a create that would replace a record with other values (the web screen decides replace)", async () => {
    const { adapter } = await zone();
    await adapter.aws.action(
      "change_dns_record",
      ctx({ change: "create", name: "api", type: "A", ttl: 300, values: ["1.2.3.4"] }),
    );
    await expect(
      adapter.aws.action(
        "change_dns_record",
        ctx({ change: "create", name: "api", type: "A", ttl: 300, values: ["9.9.9.9"] }),
      ),
    ).rejects.toMatchObject({ code: "validation" });
  });

  it("validates the payload again and calls Route 53 for nothing that failed", async () => {
    const { fake, adapter } = await zone();
    const before = fake.calls.length;
    const bad: unknown[] = [
      null,
      "x",
      {},
      { change: "drop", name: "www", type: "A", ttl: 300, values: ["1.2.3.4"] },
      { change: "create", name: "www", type: "A", ttl: 5, values: ["1.2.3.4"] },
      { change: "create", name: "www", type: "A", ttl: 300, values: ["999.1.1.1"] },
      { change: "create", name: "www", type: "A", ttl: 300, values: [] },
      { change: "create", name: "www.other.com", type: "A", ttl: 300, values: ["1.2.3.4"] },
      { change: "create", name: "@", type: "NS", ttl: 300, values: ["ns.example.net"] },
      { change: "create", name: "@", type: "CNAME", ttl: 300, values: ["a.example.net"] },
      { change: "create", name: "w", type: "SOA", ttl: 300, values: ["x"] },
      { change: "delete", name: "@", type: "NS" },
      { change: "delete", name: "www", type: "PTR" },
    ];
    for (const payload of bad) {
      await expect(
        adapter.aws.action("change_dns_record", ctx(payload)),
        JSON.stringify(payload),
      ).rejects.toThrow();
    }
    expect(fake.calls.length).toBe(before);
  });

  it("refuses a resource without a saved hosted zone id and never builds an id from the payload", async () => {
    const { fake, adapter } = await zone();
    const before = fake.calls.length;
    for (const config of [{}, { hostedZoneId: "z-lower" }, { hostedZoneId: "../x" }, null]) {
      await expect(
        adapter.aws.action(
          "change_dns_record",
          ctx(
            {
              change: "create",
              name: "www",
              type: "A",
              ttl: 300,
              values: ["1.2.3.4"],
              hostedZoneId: "Z9",
            },
            config,
          ),
        ),
      ).rejects.toThrow();
    }
    expect(fake.calls.length).toBe(before);
  });

  it("refuses a CNAME next to another record at the same name (the live list decides)", async () => {
    const { adapter } = await zone();
    await adapter.aws.action(
      "change_dns_record",
      ctx({ change: "create", name: "www", type: "A", ttl: 300, values: ["1.2.3.4"] }),
    );
    await expect(
      adapter.aws.action(
        "change_dns_record",
        ctx({ change: "create", name: "www", type: "CNAME", ttl: 300, values: ["a.example.net"] }),
      ),
    ).rejects.toThrow();
  });

  it("marks the mirror stale instead of failing when the list is too long to keep", async () => {
    const { fake, adapter } = await zone();
    for (let i = 0; i < 40; i++) {
      fake.seed(ZONE_ID, {
        name: `host-${i}.example.com.`,
        type: "TXT",
        ttl: 300,
        values: [`"${"x".repeat(600)}"`],
      });
    }
    const out = await adapter.aws.action(
      "change_dns_record",
      ctx({ change: "create", name: "www", type: "A", ttl: 300, values: ["1.2.3.4"] }),
    );
    expect(out.kind).toBe("done");
    expect(merged(out)?.recordsStale).toBe(true);
    expect(merged(out)?.records).toBeNull();
  });

  it("answers not found for a zone that is gone, as a failure the engine can record", async () => {
    const { adapter } = await zone();
    await expect(
      adapter.aws.action(
        "change_dns_record",
        ctx(
          { change: "create", name: "www", type: "A", ttl: 300, values: ["1.2.3.4"] },
          { hostedZoneId: "Z999999" },
        ),
      ),
    ).rejects.toThrow();
  });
});
