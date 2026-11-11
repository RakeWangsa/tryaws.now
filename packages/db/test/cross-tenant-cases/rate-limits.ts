import { defineCaseSet, type CaseSet } from "./define";

const NOW = new Date("2026-11-11T10:00:00.000Z");

export const rateLimitsCases: CaseSet = defineCaseSet<{ customerId: string }>({
  repo: "rateLimits",
  seed: async (_pool, customerId) => ({ customerId }),
  cases: ({ asCustomer }) => ({
    "rateLimits.consume": {
      kind: "self-write",
      run: (c) =>
        asCustomer(c, (r) =>
          r.rateLimits.consume([{ action: "topup.start", limit: 5, windowSeconds: 3600 }], NOW),
        ),
    },
  }),
});
