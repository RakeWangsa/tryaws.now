import { sql } from "drizzle-orm";
import { REGION_PATTERN } from "../../capacity-keys";
import { WAITLIST_REASONS } from "../../schema/service";
import { refused, type Written } from "../result";
import { isUuid } from "../scope";
import { audited, isActiveAdmin } from "./audited";
import type { AdminScope } from "./index";

export type WaitlistReason = (typeof WAITLIST_REASONS)[number];

export interface NotifiedEntry {
  id: string;
  customerId: string | null;
  email: string | null;
  productFamily: string;
  region: string;
  reason: WaitlistReason;
  createdAt: Date;
  notifiedAt: Date;
}

// served: the customer bought the same family in the same Region after joining. position: the place
// among the entries that are neither notified nor served, counted from 1; null for the others.
export interface WaitlistEntry extends Omit<NotifiedEntry, "notifiedAt"> {
  notifiedAt: Date | null;
  served: boolean;
  position: number | null;
}

export interface NotifyNextInput {
  productFamily: string;
  region: string;
  reason: WaitlistReason;
  count: number;
}

export interface WaitlistListFilter {
  productFamily?: string;
  region?: string;
  reason?: WaitlistReason;
  limit?: number;
  after?: string;
}

// The open entries of one family, Region and reason: not notified and not served.
export interface WaitlistCount {
  productFamily: string;
  region: string;
  reason: WaitlistReason;
  open: number;
}

export interface WaitlistAdminRepo {
  counts(): Promise<Written<WaitlistCount[]>>;
  list(filter?: WaitlistListFilter): Promise<WaitlistEntry[]>;
  notifyNext(input: NotifyNextInput, why: string): Promise<Written<NotifiedEntry[]>>;
}

const FAMILY_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;
const MAX_COUNT = 100;

// The one test "the customer bought the family in that Region after joining", on the alias e of
// waitlist_entries. list shows it as served and notifyNext skips it, so they cannot drift apart.
const SERVED_EXISTS = sql`exists (select 1 from resources r
                      where r.customer_id = e.customer_id and r.family = e.product_family
                        and r.region = e.region and r.created_at > e.created_at)`;

interface ListRow {
  id: string;
  customerId: string | null;
  email: string | null;
  productFamily: string;
  region: string;
  reason: WaitlistReason;
  createdAt: string | Date;
  notifiedAt: string | Date | null;
  served: boolean;
  position: number | null;
}

interface NotifiedRow extends Omit<ListRow, "notifiedAt" | "served" | "position"> {
  notifiedAt: string | Date;
}

const asDate = (value: string | Date): Date => new Date(value);

export function waitlistAdminRepo(scope: AdminScope): WaitlistAdminRepo {
  const { tx } = scope;
  return {
    async counts() {
      if (!["ops", "superadmin"].includes(scope.actor.role) || !(await isActiveAdmin(scope))) {
        return refused("forbidden");
      }
      const { rows } = await tx.execute<WaitlistCount & Record<string, unknown>>(
        sql`select e.product_family as "productFamily", e.region, e.reason, count(*)::int as open
              from waitlist_entries e
             where e.notified_at is null and (e.customer_id is null or not ${SERVED_EXISTS})
             group by e.product_family, e.region, e.reason
             order by e.product_family, e.region, e.reason`,
      );
      return {
        ok: true,
        replayed: false,
        value: rows.map(({ productFamily, region, reason, open }) => ({
          productFamily,
          region,
          reason,
          open,
        })),
      };
    },

    async list(filter = {}) {
      const { productFamily, region, reason, limit = DEFAULT_LIMIT, after } = filter;
      if (
        (productFamily !== undefined && typeof productFamily !== "string") ||
        (region !== undefined && typeof region !== "string") ||
        (reason !== undefined && !(WAITLIST_REASONS as readonly unknown[]).includes(reason)) ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > MAX_LIMIT ||
        (after !== undefined && (typeof after !== "string" || !isUuid(after)))
      ) {
        throw new TypeError("waitlist: the list filter is not valid");
      }
      const family = productFamily ?? null;
      const regionFilter = region ?? null;
      const reasonFilter = reason ?? null;
      const cursor = after ?? null;
      const { rows } = await tx.execute<ListRow & Record<string, unknown>>(
        sql`select x.* from (
      select q.id, q.customer_id as "customerId", q.email, q.product_family as "productFamily", q.region, q.reason,
             q.created_at as "createdAt", q.notified_at as "notifiedAt", q.served,
             (case when q.notified_at is null and not q.served
                   then row_number() over (partition by q.product_family, q.region, q.reason, (q.notified_at is null and not q.served)
                                           order by q.created_at, q.id) end)::int as position
        from (select e.*, (e.customer_id is not null and ${SERVED_EXISTS}) as served
                from waitlist_entries e
               where (${family}::text is null or e.product_family = ${family})
                 and (${regionFilter}::text is null or e.region = ${regionFilter})
                 and (${reasonFilter}::text is null or e.reason = ${reasonFilter})) q) x
     where (${cursor}::uuid is null
            or (x."createdAt", x.id) > (select c.created_at, c.id from waitlist_entries c where c.id = ${cursor}::uuid))
     order by x."createdAt", x.id
     limit ${limit}`,
      );
      return rows.map((row) => ({
        ...row,
        createdAt: asDate(row.createdAt),
        notifiedAt: row.notifiedAt === null ? null : asDate(row.notifiedAt),
      }));
    },

    async notifyNext(input, why) {
      const { productFamily, region, reason, count } = input;
      if (!(await isActiveAdmin(scope))) return refused("forbidden");
      if (
        typeof productFamily !== "string" ||
        !FAMILY_PATTERN.test(productFamily) ||
        typeof region !== "string" ||
        !REGION_PATTERN.test(region) ||
        !(WAITLIST_REASONS as readonly unknown[]).includes(reason) ||
        !Number.isInteger(count) ||
        count < 1 ||
        count > MAX_COUNT
      ) {
        return refused("validation");
      }
      return audited(
        scope,
        {
          action: "waitlist.notify",
          targetType: "waitlist",
          targetId: `${productFamily}:${region}:${reason}`,
          reason: why,
        },
        async () => {
          const { rows } = await tx.execute<NotifiedRow & Record<string, unknown>>(
            sql`update waitlist_entries w set notified_at = now()
     where w.id in (
       select e.id from waitlist_entries e
        where e.product_family = ${productFamily} and e.region = ${region} and e.reason = ${reason}
          and e.notified_at is null
          and (e.customer_id is null or not ${SERVED_EXISTS})
        order by e.created_at, e.id
        limit ${count}
          for update skip locked)
    returning w.id, w.customer_id as "customerId", w.email, w.product_family as "productFamily", w.region, w.reason,
              w.created_at as "createdAt", w.notified_at as "notifiedAt"`,
          );
          // RETURNING has no order.
          const value: NotifiedEntry[] = rows
            .map((row) => ({
              ...row,
              createdAt: asDate(row.createdAt),
              notifiedAt: asDate(row.notifiedAt),
            }))
            .sort(
              (a, b) =>
                a.createdAt.getTime() - b.createdAt.getTime() ||
                (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
            );
          const ids = value.map((entry) => entry.id);
          return { value, replayed: ids.length === 0, before: null, after: { notified: ids } };
        },
      );
    },
  };
}
