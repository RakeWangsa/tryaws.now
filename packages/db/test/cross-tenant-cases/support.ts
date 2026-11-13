import { newResource, uniqueSuffix } from "../fixtures";
import { insertRow } from "../sql";
import { defineCaseSet, type CaseSet } from "./define";

// A request of customer A with one reply in its thread, and a resource of A. B's list never shows A's
// request. B's create with A's resource as the related resource is not_found, the same answer as for a
// resource that does not exist ("write": it names a target row, so it also runs on the ghost).
// WPU-Z5: B's thread, addMessage and close on A's request answer not_found like a missing request and
// change nothing of A; A's own runs read its thread, add a reply (a new row of support_messages and a new
// last activity) and close its open request.
export const supportCases: CaseSet = defineCaseSet<{
  customerId: string;
  supportRequestId: string;
  supportMessageId: string;
  resourceId: string;
}>({
  repo: "support",
  seed: async (pool, customerId) => {
    const supportRequestId = await insertRow(pool, "support_requests", {
      customer_id: customerId,
      category: "billing",
      subject: "seed",
      message: "seed",
    });
    return {
      customerId,
      supportRequestId,
      supportMessageId: await insertRow(pool, "support_messages", {
        request_id: supportRequestId,
        author_type: "customer",
        body: "seed reply",
      }),
      resourceId: await newResource(pool, customerId),
    };
  },
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
    "support.thread": {
      kind: "read",
      run: (c, s) => asCustomer(c, (r) => r.support.thread(s.supportRequestId)),
    },
    "support.addMessage": {
      kind: "write",
      run: (c, s) =>
        asCustomer(c, (r) =>
          r.support.addMessage({
            requestId: s.supportRequestId,
            idempotencyKey: "key-" + uniqueSuffix() + uniqueSuffix(),
            body: "Any news?",
          }),
        ),
    },
    "support.close": {
      kind: "write",
      run: (c, s) => asCustomer(c, (r) => r.support.close(s.supportRequestId)),
    },
  }),
});
