import { newResource, uniqueSuffix } from "../fixtures";
import { insertRow } from "../sql";
import { defineCaseSet, type CaseSet } from "./define";

// A request and a resource of customer A. B's list never shows A's request. B's create with A's
// resource as the related resource is not_found, the same answer as for a resource that does not
// exist ("write": it names a target row, so it also runs on the ghost).
export const supportCases: CaseSet = defineCaseSet<{
  customerId: string;
  supportRequestId: string;
  resourceId: string;
}>({
  repo: "support",
  seed: async (pool, customerId) => ({
    customerId,
    supportRequestId: await insertRow(pool, "support_requests", {
      customer_id: customerId,
      category: "billing",
      subject: "seed",
      message: "seed",
    }),
    resourceId: await newResource(pool, customerId),
  }),
  cases: ({ asCustomer }) => ({
    "support.list": { kind: "read", run: (c) => asCustomer(c, (r) => r.support.list()) },
    "support.create": {
      kind: "write",
      run: (c, s) =>
        asCustomer(c, (r) =>
          r.support.create({
            category: "technical",
            subject: "Server is slow",
            message: "It was fine yesterday.",
            relatedResourceId: s.resourceId,
            idempotencyKey: "key-" + uniqueSuffix() + uniqueSuffix(),
          }),
        ),
    },
  }),
});
