import { defineCaseSet, type CaseSet } from "./define";

export const auditCases: CaseSet = defineCaseSet<{ customerId: string }>({
  repo: "audit",
  seed: async (_pool, customerId) => ({ customerId }),
  cases: ({ asCustomer }) => ({
    "audit.record": {
      kind: "self-write",
      run: (c) => asCustomer(c, (r) => r.audit.record({ action: "test.cross_tenant" })),
    },
  }),
});
