import { v7 as uuidv7 } from "uuid";
import { uniqueSuffix } from "../fixtures";
import { insertRow } from "../sql";
import { defineCaseSet, type CaseSet } from "./define";

export const notificationsCases: CaseSet = defineCaseSet<{ notificationId: string }>({
  repo: "notifications",
  seed: async (pool, customerId) => ({
    notificationId: await insertRow(pool, "notifications", {
      customer_id: customerId,
      channel: "in_app",
      template: "seed",
      payload: "{}",
      dedupe_key: "seed:" + uniqueSuffix() + ":" + uuidv7(),
    }),
  }),
  cases: ({ asCustomer }) => ({
    // Names no row: the list and the count of B hold B's own notifications only.
    "notifications.list": {
      kind: "read",
      run: (c) => asCustomer(c, (r) => r.notifications.list()),
    },
    "notifications.unreadCount": {
      kind: "read",
      // The count alone names no row, so the answer carries the ids it counts.
      run: (c) =>
        asCustomer(c, async (r) => ({
          unread: await r.notifications.unreadCount(),
          ids: (await r.notifications.list()).map((n) => n.id),
        })),
    },
    // B marks the id of A: nothing changes and the answer is zero, as for a missing id.
    "notifications.markRead": {
      kind: "write",
      run: (c, s) => asCustomer(c, (r) => r.notifications.markRead([s.notificationId])),
    },
  }),
});
