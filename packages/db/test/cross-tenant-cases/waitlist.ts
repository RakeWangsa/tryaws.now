import { randomUUID } from "node:crypto";
import { defineCaseSet, type CaseSet } from "./define";

export const waitlistCases: CaseSet = defineCaseSet<{ customerId: string }>({
  repo: "waitlist",
  seed: async (_pool, customerId) => ({ customerId }),
  cases: ({ asCustomer }) => ({
    "waitlist.join": {
      kind: "self-write",
      run: (c) =>
        asCustomer(c, (r) =>
          r.waitlist.join({
            productFamily: "linux_instance",
            region: "ap-southeast-1",
            reason: "capacity",
            idempotencyKey: randomUUID(),
          }),
        ),
    },
  }),
});
