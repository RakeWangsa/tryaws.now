import { newResource } from "../fixtures";
import { insertRow } from "../sql";
import { defineCaseSet, type CaseSet } from "./define";

export const subscriptionsCases: CaseSet = defineCaseSet<{ resourceId: string }>({
  repo: "subscriptions",
  seed: async (pool, customerId) => {
    const resourceId = await newResource(pool, customerId);
    await insertRow(pool, "subscriptions", {
      resource_id: resourceId,
      customer_id: customerId,
      term_days: 30,
      price_snapshot: "{}",
      period_start: "2026-01-01T00:00:00Z",
      period_end: "2026-01-31T00:00:00Z",
    });
    // WPU-X23 (R8): A has a LIVE destroy, so B's request must still be not_found and must not learn its id.
    await insertRow(pool, "operations", {
      resource_id: resourceId,
      kind: "destroy",
      state: "needs_approval",
      needs_approval: true,
      idempotency_key: "customer:" + customerId + ":destroy:seed-live",
    });
    return { resourceId };
  },
  cases: ({ asCustomer }) => ({
    "subscriptions.get": {
      kind: "read",
      run: (c, s) => asCustomer(c, (r) => r.subscriptions.get(s.resourceId)),
    },
    "subscriptions.list": {
      kind: "read",
      run: (c) => asCustomer(c, (r) => r.subscriptions.list()),
    },
    "subscriptions.setAutoRenew": {
      kind: "write",
      run: (c, s) =>
        asCustomer(c, (r) => r.subscriptions.setAutoRenew(s.resourceId, true)).then((w) =>
          w.ok ? { ok: true as const } : w,
        ),
    },
    // B's attempt on A's resource is not_found, like an attempt on a missing resource, and A's
    // subscription stays `active`.
    "subscriptions.requestDestroy": {
      kind: "write",
      run: (c, s) =>
        asCustomer(c, (r) =>
          r.subscriptions.requestDestroy({
            resourceId: s.resourceId,
            idempotencyKey: "destroy-seed",
            withFinalSnapshot: true,
          }),
        ).then((w) => (w.ok ? { ok: true as const } : w)),
    },
  }),
});
