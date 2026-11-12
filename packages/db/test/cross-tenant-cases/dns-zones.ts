import { v7 as uuidv7 } from "uuid";
import { ghostOf } from "../../testing/cross-tenant";
import { newResource, uniqueSuffix } from "../fixtures";
import { insertRow } from "../sql";
import { defineCaseSet, type CaseSet } from "./define";

interface Seed {
  zoneId: string;
  customerId: string;
  resourceId: string;
  spareResourceId: string;
}

const zoneName = (prefix: string): string =>
  prefix +
  uniqueSuffix()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "") +
  ".example";

// WPU-G6: the DNS zone repository. The zone name is unique among live zones, so every name is made here.
export const dnsZonesCases: CaseSet = defineCaseSet<Seed>({
  repo: "dnsZones",
  seed: async (pool, customerId) => {
    const resourceId = await newResource(pool, customerId, {
      family: "dns_zone",
      region: "us-east-1",
    });
    return {
      customerId,
      resourceId,
      zoneId: await insertRow(pool, "dns_zones", {
        customer_id: customerId,
        resource_id: resourceId,
        name: zoneName("seed"),
        status: "pending",
      }),
      spareResourceId: await newResource(pool, customerId, {
        family: "dns_zone",
        region: "us-east-1",
      }),
    };
  },
  cases: ({ asCustomer }) => ({
    "dnsZones.list": { kind: "read", run: (c) => asCustomer(c, (r) => r.dnsZones.list()) },
    "dnsZones.get": {
      kind: "read",
      run: (c, s) => asCustomer(c, (r) => r.dnsZones.get(s.zoneId)),
    },
    "dnsZones.getByResource": {
      kind: "read",
      run: (c, s) => asCustomer(c, (r) => r.dnsZones.getByResource(s.resourceId)),
      ghost: (s) => ({ ...ghostOf(s), resourceId: uuidv7() }),
    },
    // The insert selects the resource by id and customer in one statement: B's attempt on A's spare
    // resource is not_found, like an attempt on a missing resource, and writes nothing.
    "dnsZones.create": {
      kind: "write",
      run: (c, s) =>
        asCustomer(c, (r) =>
          r.dnsZones.create({
            id: uuidv7(),
            resourceId: s.spareResourceId,
            name: zoneName("w"),
            status: "pending",
          }),
        ).then((w) => (w.ok ? { ok: true as const } : w)),
    },
  }),
});
