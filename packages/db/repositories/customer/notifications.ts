import { sql } from "drizzle-orm";
import { isUuid, type TenantScope } from "../scope";

// An in-app notification of the customer (the bell and /notifications, 16.10). Only the columns
// that web_rw may SELECT (migration 0006): no email, dedupe_key, attempts or sent_at. The payload
// holds the platform words of the template (ids, dates, amounts as text), never a secret (R14).
export interface NotificationRow {
  id: string;
  template: string;
  payload: unknown;
  readAt: Date | null;
  createdAt: Date;
}

export const NOTIFICATIONS_SHOWN = 50;

export interface NotificationsRepo {
  // The newest in-app notifications, at most NOTIFICATIONS_SHOWN, newest first.
  list(limit?: number): Promise<NotificationRow[]>;
  // The number of unread in-app notifications (the badge of the bell).
  unreadCount(): Promise<number>;
  // Marks the given notifications of this customer as read, or all of them without ids. Returns
  // how many rows changed; a row of another customer, a missing row and a read one count as zero.
  markRead(ids?: readonly string[]): Promise<number>;
}

type Row = {
  id: string;
  template: string;
  payload: unknown;
  readAt: string | null;
  createdAt: string;
};

const toRow = (row: Row): NotificationRow => ({
  id: row.id,
  template: row.template,
  payload: row.payload,
  readAt: row.readAt === null ? null : new Date(row.readAt),
  createdAt: new Date(row.createdAt),
});

export function notificationsRepo(scope: TenantScope): NotificationsRepo {
  const { tx, customerId } = scope;
  return {
    list: async (limit = NOTIFICATIONS_SHOWN) => {
      const bounded = Number.isSafeInteger(limit)
        ? Math.min(Math.max(limit, 1), NOTIFICATIONS_SHOWN)
        : NOTIFICATIONS_SHOWN;
      const { rows } = await tx.execute<Row>(sql`
        select id, template, payload, read_at as "readAt", created_at as "createdAt"
        from notifications
        where customer_id = ${customerId} and channel = 'in_app'
        order by created_at desc, id desc
        limit ${bounded}`);
      return rows.map(toRow);
    },

    unreadCount: async () => {
      const { rows } = await tx.execute<{ n: number }>(sql`
        select count(*)::int as n from notifications
        where customer_id = ${customerId} and channel = 'in_app' and read_at is null`);
      return rows[0]?.n ?? 0;
    },

    markRead: async (ids) => {
      if (ids !== undefined) {
        const valid = ids.filter((id) => typeof id === "string" && isUuid(id)).slice(0, 100);
        if (valid.length === 0) return 0;
        const result = await tx.execute(sql`
          update notifications set read_at = now()
          where customer_id = ${customerId} and channel = 'in_app' and read_at is null
            and id in (${sql.join(
              valid.map((id) => sql`${id}::uuid`),
              sql`, `,
            )})`);
        return result.rowCount ?? 0;
      }
      const result = await tx.execute(sql`
        update notifications set read_at = now()
        where customer_id = ${customerId} and channel = 'in_app' and read_at is null`);
      return result.rowCount ?? 0;
    },
  };
}
