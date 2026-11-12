import { AwsError, type Route53Port } from "@tc/aws";
import { composeHooks } from "./hooks";
import { insertRow } from "@tc/db/testing";
import { describe, expect, it } from "vitest";
import { createAdapterRegistry } from "./adapters";
import { dnsZoneAdapter, dnsZoneHooks } from "./dns-zone";
import { orderHooks } from "./order-hooks";
import { runStep } from "./step";
import { operationRow, seedOperation, seedWorld } from "./test/seed";
import { useHarness } from "./test/harness";

// WPU-G6: a DNS zone is poolless (it lives in tc-dns), its adapter is registered, the unconfigured port
// fails closed, and the hooks keep the dns_zones row in step with the create and the destroy.

const { t, world, setup, message } = useHarness();

const NS = [
  "ns-1.awsdns-01.org.",
  "ns-2.awsdns-02.com.",
  "ns-3.awsdns-03.net.",
  "ns-4.awsdns-04.co.uk.",
];

function fakePort(over: Partial<Route53Port> = {}): Route53Port {
  return {
    createHostedZone: async ({ name }) => ({
      zone: { id: "Z0TESTZONE1", name: `${name}.`, nameServers: NS },
      created: true,
    }),
    getHostedZone: async () => ({ id: "Z0TESTZONE1", name: "x.", nameServers: NS }),
    findHostedZonesByName: async () => [],
    listRecordSets: async () => [
      { name: "shop.example.", type: "NS", ttl: 172800, values: NS },
      {
        name: "shop.example.",
        type: "SOA",
        ttl: 900,
        values: ["ns-1.awsdns-01.org. h. 1 7200 900 1209600 86400"],
      },
    ],
    changeRecordSets: async () => {},
    deleteHostedZone: async () => {},
    ...over,
  };
}

async function seedZone(over: { state?: string; config?: Record<string, unknown> } = {}) {
  const resourceId = (
    await t.pool.query(
      `insert into resources (id, customer_id, family, region, state, config)
       values (gen_random_uuid(), $1, 'dns_zone', 'us-east-1', $2, $3::jsonb) returning id`,
      [
        world.customerId,
        over.state ?? "creating",
        JSON.stringify(over.config ?? { zoneName: "shop.example" }),
      ],
    )
  ).rows[0] as { id: string };
  const name = `shop${Math.random().toString(36).slice(2, 10)}.example`;
  await insertRow(t.pool, "dns_zones", {
    customer_id: world.customerId,
    resource_id: resourceId.id,
    name,
    status: "pending",
  });
  return { resourceId: resourceId.id, name };
}

describe("dns_zone in the provisioner", () => {
  it("is registered by family", () => {
    expect(createAdapterRegistry([dnsZoneAdapter()]).get("dns_zone")?.family).toBe("dns_zone");
  });

  it("fails closed while the Route 53 client is not built: no AWS call, a fixed local error", async () => {
    const adapter = dnsZoneAdapter();
    const ctx = {
      operation: {
        id: "op",
        kind: "create",
        step: null,
        attempt: 1,
        createdAt: new Date(),
        payload: {},
      },
      stepKey: "op:start",
      resource: {
        id: "r",
        customerId: "c",
        family: "dns_zone",
        productId: null,
        parentResourceId: null,
        awsName: null,
        state: "creating",
        config: {},
      },
      config: adapter.parseConfig({ zoneName: "shop.example" }),
      account: { awsAccountId: "tc-dns", externalId: "tc-dns" },
      region: "us-east-1",
      access: {},
      env: "staging",
      clock: { now: () => new Date() },
      owned: async () => null,
    } as never;
    await expect(adapter.aws.create(ctx)).rejects.toMatchObject({
      code: "internal",
      retryable: false,
      reason: "not_configured",
    });
  });

  it("runs a create for a resource with no pool account (poolless) and moves the zone to the row", async () => {
    const zone = await seedZone();
    const id = await seedOperation(t.pool, zone.resourceId, {
      kind: "create",
      payload: { orderId: world.orderId },
    });
    const { deps } = setup({
      adapters: createAdapterRegistry([dnsZoneAdapter({ route53: () => fakePort() })]),
      hooks: composeHooks(orderHooks({ clock: { now: () => new Date() } }), dnsZoneHooks()),
    });
    // The resource has no pool account and no product: the claim and the step still run it.
    expect(
      (
        await t.pool.query("select pool_account_id, product_id from resources where id = $1", [
          zone.resourceId,
        ])
      ).rows[0],
    ).toEqual({ pool_account_id: null, product_id: null });
    const out = await runStep(deps, message(id, zone.resourceId));
    expect(out).toMatchObject({ outcome: "advanced", to: "succeeded" });
    expect(await operationRow(t.pool, id)).toMatchObject({ state: "succeeded" });

    const resource = (
      await t.pool.query("select state, config from resources where id = $1", [zone.resourceId])
    ).rows[0] as {
      state: string;
      config: Record<string, unknown>;
    };
    expect(resource.state).toBe("active");
    expect(resource.config).toMatchObject({ hostedZoneId: "Z0TESTZONE1", recordsStale: false });
    expect((resource.config["records"] as unknown[]).length).toBe(2);

    const row = (
      await t.pool.query(
        "select hosted_zone_id, name_servers, status from dns_zones where resource_id = $1",
        [zone.resourceId],
      )
    ).rows[0];
    expect(row).toEqual({
      hosted_zone_id: "Z0TESTZONE1",
      name_servers: NS.map((n) => n.replace(/\.$/, "")),
      status: "pending_delegation",
    });
  });

  it("marks the zone row failed when the create fails for good, so the name is free again", async () => {
    const zone = await seedZone();
    const id = await seedOperation(t.pool, zone.resourceId, {
      kind: "create",
      payload: { orderId: world.orderId },
    });
    const port = fakePort({
      createHostedZone: async () => {
        throw new AwsError({ code: "validation", retryable: false });
      },
    });
    const { deps } = setup({
      adapters: createAdapterRegistry([dnsZoneAdapter({ route53: () => port })]),
      // The reversal of the money is the orderHooks and has its own tests; this one is the row.
      hooks: dnsZoneHooks(),
    });
    const out = await runStep(deps, message(id, zone.resourceId));
    expect(out).toMatchObject({ outcome: "advanced", to: "failed" });
    expect(
      (await t.pool.query("select status from dns_zones where resource_id = $1", [zone.resourceId]))
        .rows[0],
    ).toEqual({ status: "failed" });
  });
});

describe("dnsZoneHooks", () => {
  it("marks the row removed after a destroy and ignores every other kind", async () => {
    const zone = await seedZone({ state: "active" });
    const hooks = dnsZoneHooks();
    const event = { operationId: "o", resourceId: zone.resourceId, customerId: world.customerId };
    await t.db.transaction(async (tx) => {
      await hooks.succeeded?.(tx, { ...event, kind: "reboot" } as never);
    });
    expect(
      (await t.pool.query("select status from dns_zones where resource_id = $1", [zone.resourceId]))
        .rows[0],
    ).toEqual({ status: "pending" });
    await t.db.transaction(async (tx) => {
      await hooks.succeeded?.(tx, { ...event, kind: "destroy" } as never);
    });
    expect(
      (await t.pool.query("select status from dns_zones where resource_id = $1", [zone.resourceId]))
        .rows[0],
    ).toEqual({ status: "removed" });
  });

  it("is harmless for a resource that is no zone", async () => {
    const hooks = dnsZoneHooks();
    await t.db.transaction(async (tx) => {
      await hooks.succeeded?.(tx, {
        operationId: "o",
        resourceId: world.resourceId,
        customerId: world.customerId,
        kind: "create",
      } as never);
      await hooks.failed?.(tx, {
        operationId: "o",
        resourceId: world.resourceId,
        customerId: world.customerId,
        kind: "create",
        code: "x",
      } as never);
    });
  });
});

void seedWorld;
