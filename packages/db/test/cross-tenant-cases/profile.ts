import { defineCaseSet, type CaseSet } from "./define";

export const profileCases: CaseSet = defineCaseSet<{ customerId: string }>({
  repo: "profile",
  seed: async (_pool, customerId) => ({ customerId }),
  cases: ({ asCustomer }) => ({
    "profile.get": { kind: "read", run: (c) => asCustomer(c, (r) => r.profile.get()) },
    "profile.update": {
      kind: "self-write",
      run: (c) => asCustomer(c, (r) => r.profile.update({ name: "Rahim" })),
    },
  }),
});
