import { newResource } from "../fixtures";
import { defineCaseSet, type CaseSet } from "./define";

export const resourcesCases: CaseSet = defineCaseSet<{ resourceId: string }>({
  repo: "resources",
  seed: async (pool, customerId) => ({ resourceId: await newResource(pool, customerId) }),
  cases: ({ asCustomer }) => ({
    "resources.list": { kind: "read", run: (c) => asCustomer(c, (r) => r.resources.list()) },
    "resources.get": {
      kind: "read",
      run: (c, s) => asCustomer(c, (r) => r.resources.get(s.resourceId)),
    },
  }),
});
