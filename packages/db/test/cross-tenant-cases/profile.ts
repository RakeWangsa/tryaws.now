import { defineCaseSet, type CaseSet } from "./define";

export const profileCases: CaseSet = defineCaseSet<{ customerId: string }>({
  repo: "profile",
  seed: async (pool, customerId) => {
    await pool.query(
      "update customers set billing_name = 'Seed Traders', billing_address = 'Seed address, Dhaka', customer_bin = '9999999999999' where id = $1",
      [customerId],
    );
    return { customerId };
  },
  cases: ({ asCustomer }) => ({
    "profile.get": { kind: "read", run: (c) => asCustomer(c, (r) => r.profile.get()) },
    // The answer is the actor's own billing profile; it carries the actor's id so that the helper can
    // tell an answer about the actor's row from an empty one. The seed gives every customer a profile.
    "profile.getBilling": {
      kind: "read",
      run: (c) =>
        asCustomer(c, async (r) => ({ customerId: c, billing: await r.profile.getBilling() })),
    },
    // WPU-I4: the source of the buyer snapshot of an invoice: the actor's own name and billing profile.
    "profile.getBuyerSource": {
      kind: "read",
      run: (c) =>
        asCustomer(c, async (r) => ({ customerId: c, source: await r.profile.getBuyerSource() })),
    },
    "profile.setBilling": {
      kind: "self-write",
      run: (c) =>
        asCustomer(c, (r) =>
          r.profile.setBilling({
            billingName: "Rahim Traders",
            billingAddress: "House 5, Dhaka",
            customerBin: "1234567890123",
          }),
        ),
    },
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
