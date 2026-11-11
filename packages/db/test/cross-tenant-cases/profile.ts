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
    "profile.setEmail": {
      kind: "self-write",
      run: (c) => asCustomer(c, (r) => r.profile.setEmail("changed@example.test")),
    },
    "profile.setVerifiedPhone": {
      kind: "self-write",
      run: (c) =>
        asCustomer(c, (r) =>
          r.profile.setVerifiedPhone({
            phone: "+8801712345678",
            verifiedAt: new Date("2026-11-11T10:00:00.000Z"),
          }),
        ),
    },
  }),
});
