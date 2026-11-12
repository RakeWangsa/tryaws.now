import type pg from "pg";
import { v7 as uuidv7 } from "uuid";
import { ghostOf } from "../../testing/cross-tenant";
import { newResource, uniqueSuffix } from "../fixtures";
import { insertRow } from "../sql";
import { defineCaseSet, type CaseSet } from "./define";

interface Seed {
  domainId: string;
  customerId: string;
  name: string;
  tld: string;
  spareResourceId: string;
}

// The `tlds` row is global; the name and the TLD are unique to this seed (unique keys are global per table).
let seedPool: pg.Pool | undefined;

export const domainsCases: CaseSet = defineCaseSet<Seed>({
  repo: "domains",
  seed: async (pool, customerId) => {
    seedPool = pool;
    const tld =
      "t" +
      uniqueSuffix()
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "");
    await insertRow(pool, "tlds", { tld, synced_at: "2026-11-11T00:00:00Z" });
    const name =
      "seed" +
      uniqueSuffix()
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "") +
      "." +
      tld;
    const domainId = await insertRow(pool, "domains", {
      customer_id: customerId,
      resource_id: await newResource(pool, customerId, { family: "domain" }),
      name,
      tld,
      status: "pending",
    });
    return {
      domainId,
      customerId,
      name,
      tld,
      spareResourceId: await newResource(pool, customerId, { family: "domain" }),
    };
  },
  cases: ({ asCustomer }) => ({
    "domains.list": { kind: "read", run: (c) => asCustomer(c, (r) => r.domains.list()) },
    "domains.getByName": {
      kind: "read",
      run: (c, s) => asCustomer(c, (r) => r.domains.getByName(s.name)),
      ghost: (s) => ({
        ...ghostOf(s),
        name:
          "ghost" +
          uniqueSuffix()
            .toLowerCase()
            .replace(/[^a-z0-9]/g, "") +
          "." +
          s.tld,
      }),
    },
    // The insert selects the resource by id and customer in one statement: B's attempt on A's spare
    // resource is not_found, like an attempt on a missing resource, and writes nothing.
    "domains.create": {
      kind: "write",
      run: (c, s) => {
        if (seedPool === undefined) throw new Error("the case set has not been seeded");
        return asCustomer(c, (r) =>
          r.domains.create({
            id: uuidv7(),
            resourceId: s.spareResourceId,
            name:
              "w" +
              uniqueSuffix()
                .toLowerCase()
                .replace(/[^a-z0-9]/g, "") +
              "." +
              s.tld,
            tld: s.tld,
            status: "pending",
            contactEncrypted: new Uint8Array([1, 2, 3]),
          }),
        ).then((w) => (w.ok ? { ok: true as const } : w));
      },
    },
  }),
});
