import { newResource, uniqueSuffix } from "../fixtures";
import { insertRow } from "../sql";
import { defineCaseSet, type CaseSet } from "./define";

export const operationsCases: CaseSet = defineCaseSet<{ resourceId: string; operationId: string }>({
  repo: "operations",
  seed: async (pool, customerId) => {
    const resourceId = await newResource(pool, customerId);
    const operationId = await insertRow(pool, "operations", {
      resource_id: resourceId,
      kind: "reboot",
      idempotency_key: "customer:" + customerId + ":seed-" + uniqueSuffix(),
    });
    return { resourceId, operationId };
  },
  cases: ({ asCustomer }) => ({
    "operations.get": {
      kind: "read",
      run: (c, s) => asCustomer(c, (r) => r.operations.get(s.operationId)),
    },
    "operations.listForResource": {
      kind: "read",
      run: (c, s) => asCustomer(c, (r) => r.operations.listForResource(s.resourceId)),
    },
    // A fresh idempotency key on every call, so that the run on the ghost is the same request.
    "operations.request": {
      kind: "write",
      run: (c, s) =>
        asCustomer(c, (r) =>
          r.operations.request({
            resourceId: s.resourceId,
            kind: "reboot",
            idempotencyKey: uniqueSuffix(),
          }),
        ),
    },
  }),
});
