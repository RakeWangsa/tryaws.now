import { ghostOf } from "../../testing/cross-tenant";
import { newResource, uniqueSuffix } from "../fixtures";
import { defineCaseSet, type CaseSet } from "./define";

export const resourcesCases: CaseSet = defineCaseSet<{ resourceId: string; family: string }>({
  repo: "resources",
  // Each customer gets a family of its own: customer B is seeded too, and a shared family would
  // make B's count of its own resource look like a leak of A's.
  seed: async (pool, customerId) => {
    const family = "fam_" + uniqueSuffix();
    return { resourceId: await newResource(pool, customerId, { family }), family };
  },
  cases: ({ asCustomer }) => ({
    "resources.list": { kind: "read", run: (c) => asCustomer(c, (r) => r.resources.list()) },
    "resources.get": {
      kind: "read",
      run: (c, s) => asCustomer(c, (r) => r.resources.get(s.resourceId)),
    },
    // The answer is a number, which names no id; the ghost names another family, so that the run of
    // customer A on its own resources (1) differs from the run on a family it has none of (0).
    "resources.countLive": {
      kind: "read",
      run: (c, s) => asCustomer(c, (r) => r.resources.countLive(s.family)),
      ghost: (s) => ({ ...ghostOf(s), family: "ghost_family" }),
    },
  }),
});
