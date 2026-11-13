import { sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Tx } from "../../client";
import { isUuid } from "../scope";

// The statements of the lifecycle engine (WP5-T4), run as worker_rw. System code only: they take
// no customer id from a session and filter by the ids of the rows the engine itself read. They
// name only columns that worker_rw may read or write (grants.expected.json) and log nothing.

export type SubscriptionStatus = "active" | "grace" | "retained" | "ended";

export interface LifecycleRow {
  readonly id: string;
  readonly resourceId: string;
  readonly customerId: string;
  readonly market: string;
  readonly termDays: number;
  readonly priceSnapshot: unknown;
  readonly periodStart: Date;
  readonly periodEnd: Date;
  readonly autoRenew: boolean;
  readonly status: SubscriptionStatus;
  readonly resource: {
    readonly family: string;
    readonly state: string;
    readonly config: Record<string, unknown>;
    readonly deletedAt: Date | null;
  };
}

export interface GuardFacts {
  readonly subscriptionStatus: SubscriptionStatus | null;
  readonly family: string;
  readonly hasFinalSnapshot: boolean;
  // true when the row itself is a final backup (config.final = true). The guard never lets a
  // customer's delete_backup remove it: the destroy guard relies on it (R13).
  readonly isFinalBackup: boolean;
  // WPU-B3: `resources.state`. Optional so a caller that builds facts by hand need not know it; the
  // guard refuses cleanup_failed_create without it (R16).
  readonly resourceState?: string;
}

export interface NewLifecycleNotification {
  readonly customerId: string;
  readonly channel: "email" | "sms" | "in_app";
  readonly template: string;
  readonly payload: Record<string, unknown>;
  readonly dedupeKey: string;
}

/**
 * WPU-Z12. One row of the candidate list of the lifecycle pass, and the keyset cursor of the next page: the list is
 * ordered by (period_end, id) and a page holds the rows strictly after its cursor. `periodEnd` is the stored period
 * end to the microsecond, in UTC, at a fixed width (`2026-11-10T06:00:00.123456Z`): a JavaScript Date keeps only
 * milliseconds, so a cursor built from one could read a row twice or skip one. Two keys of this form compare as text
 * in the order of the list (the id is lower-case hex, whose text order is PostgreSQL's uuid order).
 */
export interface CandidateKey {
  readonly id: string;
  readonly periodEnd: string;
}

const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PERIOD_END_KEY = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

/** True for a key in the exact form that listCandidates returns: the only form that is a cursor (R16). */
export function isCandidateKey(value: unknown): value is CandidateKey {
  if (typeof value !== "object" || value === null) return false;
  const { id, periodEnd } = value as Record<string, unknown>;
  return (
    typeof id === "string" &&
    LOWER_UUID.test(id) &&
    typeof periodEnd === "string" &&
    PERIOD_END_KEY.test(periodEnd)
  );
}

type Raw = Record<string, unknown>;

function toRow(r: Raw): LifecycleRow {
  const asDate = (v: unknown): Date => (v instanceof Date ? v : new Date(String(v)));
  const config = r.config;
  return {
    id: String(r.id),
    resourceId: String(r.resource_id),
    customerId: String(r.customer_id),
    market: String(r.market),
    termDays: Number(r.term_days),
    priceSnapshot: r.price_snapshot,
    periodStart: asDate(r.period_start),
    periodEnd: asDate(r.period_end),
    autoRenew: r.auto_renew === true,
    status: r.status as SubscriptionStatus,
    resource: {
      family: String(r.family),
      state: String(r.state),
      config:
        typeof config === "object" && config !== null && !Array.isArray(config)
          ? (config as Record<string, unknown>)
          : {},
      deletedAt: r.deleted_at === null || r.deleted_at === undefined ? null : asDate(r.deleted_at),
    },
  };
}

const COLUMNS = sql`s.id, s.resource_id, s.customer_id, s.term_days, s.price_snapshot, s.period_start,
  s.period_end, s.auto_renew, s.status, r.family, r.state, r.config, r.deleted_at, c.market`;

/** A family name as the catalog writes it (WPU-Y2: a key of the lead times of listCandidates). */
const FAMILY = /^[a-z][a-z0-9_]{0,39}$/;

function assertUuid(value: string, what: string): void {
  if (typeof value !== "string" || !isUuid(value)) {
    throw new TypeError(`lifecycle: ${what} is not a UUID`);
  }
}

export function lifecycleRepo(tx: Tx) {
  return {
    // Settings of market BD and scope market. A key with no row is absent from the map.
    async readSettings(keys: readonly string[]): Promise<Map<string, unknown>> {
      const out = new Map<string, unknown>();
      for (const key of keys) {
        const { rows } = await tx.execute<{ value: unknown }>(sql`
          select value from settings
          where key = ${key} and market = 'BD' and scope = 'market' and scope_id is null limit 1`);
        if (rows[0] !== undefined) out.set(key, rows[0].value);
      }
      return out;
    },

    // The subscriptions the clock may have something to do for, one page at a time (WPU-Z12): at most `limit` rows
    // in (period_end, id) order, strictly after the cursor `after` (the key of the last row of the page before; null
    // for the first page). Keys only; each row is then read again under its lock. `reminderHorizonDays` is the
    // largest reminder day. A cursor that is not a key of this list is refused before any statement (R16).
    // WPU-Y2: `leadDays` (family -> days) makes an active row of such a family a candidate that many days before the
    // reminder horizon (a domain is charged 30 days before its period end); every other family keeps the horizon.
    async listCandidates(
      now: Date,
      reminderHorizonDays: number,
      limit: number,
      after: CandidateKey | null = null,
      leadDays: Readonly<Record<string, number>> = {},
    ): Promise<CandidateKey[]> {
      if (!Number.isInteger(limit) || limit < 1 || limit > 5000) {
        throw new RangeError("lifecycle: limit must be from 1 to 5000");
      }
      const leads = Object.entries(leadDays);
      for (const [family, days] of leads) {
        if (!FAMILY.test(family) || !Number.isInteger(days) || days < 1 || days > 365) {
          throw new RangeError("lifecycle: a lead time of the candidate list is not valid");
        }
      }
      if (after !== null && !isCandidateKey(after)) {
        throw new TypeError("lifecycle: the cursor is not a key of the candidate list");
      }
      const horizon = new Date(now.getTime() + reminderHorizonDays * 86_400_000);
      const early = leads.map(
        ([family, days]) =>
          sql` or (s.status = 'active' and s.period_end <= ${new Date(horizon.getTime() + days * 86_400_000).toISOString()}::timestamptz and exists (select 1 from resources lr where lr.id = s.resource_id and lr.family = ${family}))`,
      );
      // The cursor holds the period end as it was read, never the row's period end now: a renewal of that row in the
      // same pass moves it forward, and a cursor that read it again would skip every row in between.
      const cursor =
        after === null
          ? sql``
          : sql`and (s.period_end, s.id) > (${after.periodEnd}::timestamptz, ${after.id}::uuid)`;
      // to_char gives no text for an infinite period end; it comes back as "", which is no cursor.
      const { rows } = await tx.execute<{ id: string; period_end: string | null }>(sql`
        select s.id,
          to_char(s.period_end at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as period_end
        from subscriptions s
        where ((s.status = 'active' and s.period_end <= ${horizon.toISOString()}::timestamptz)${sql.join(early, sql``)}
           or s.status in ('grace', 'retained'))
          ${cursor}
        order by s.period_end, s.id limit ${limit}`);
      return rows.map((r) => ({ id: String(r.id), periodEnd: r.period_end ?? "" }));
    },

    // The row, locked FOR UPDATE: two scheduler runs never act on one subscription together.
    async lock(subscriptionId: string): Promise<LifecycleRow | null> {
      assertUuid(subscriptionId, "subscription id");
      const { rows } = await tx.execute<Raw>(sql`
        select ${COLUMNS}
        from subscriptions s
        join resources r on r.id = s.resource_id
        join customers c on c.id = s.customer_id
        where s.id = ${subscriptionId}
        for update of s`);
      return rows[0] === undefined ? null : toRow(rows[0]);
    },

    // WPU-S7: the operations of one resource under one idempotency key (kind and state only; the
    // columns web_rw may read, so renewNow can ask too). The key holds the subscription and period.
    async operationsByKey(
      resourceId: string,
      idempotencyKey: string,
    ): Promise<{ id: string; kind: string; state: string }[]> {
      assertUuid(resourceId, "resource id");
      const { rows } = await tx.execute<{ id: string; kind: string; state: string }>(sql`
        select id, kind, state from operations
        where resource_id = ${resourceId} and idempotency_key = ${idempotencyKey}`);
      return rows.map((r) => ({ id: String(r.id), kind: String(r.kind), state: String(r.state) }));
    },

    // WPU-Z13: the payload of one operation of this resource (the failed hook of a domain renewal reads
    // which subscription and period the operation was queued for). null when the operation is not of
    // this resource. The payload is the stored jsonb: the caller reads it field by field.
    async operationPayload(resourceId: string, operationId: string): Promise<unknown> {
      assertUuid(resourceId, "resource id");
      assertUuid(operationId, "operation id");
      const { rows } = await tx.execute<{ payload: unknown }>(sql`
        select payload from operations where id = ${operationId} and resource_id = ${resourceId}`);
      return rows[0] === undefined ? null : rows[0].payload;
    },

    // WPU-S7: the period end the apply operation was queued for (its payload) and the one its
    // subscription has now. null when the operation is not of this resource.
    async planApplyPeriod(
      resourceId: string,
      operationId: string,
    ): Promise<{
      config: Record<string, unknown>;
      payload: unknown;
      currentPeriodEnd: Date | null;
    } | null> {
      assertUuid(resourceId, "resource id");
      assertUuid(operationId, "operation id");
      const { rows } = await tx.execute<{
        config: unknown;
        payload: unknown;
        period_end: unknown;
      }>(sql`
        select r.config as config, o.payload as payload, s.period_end as period_end
        from operations o join resources r on r.id = o.resource_id
          left join subscriptions s on s.resource_id = r.id
        where o.id = ${operationId} and o.resource_id = ${resourceId}
        limit 1`);
      const row = rows[0];
      if (row === undefined) return null;
      const end = row.period_end;
      return {
        config:
          typeof row.config === "object" && row.config !== null && !Array.isArray(row.config)
            ? (row.config as Record<string, unknown>)
            : {},
        payload: row.payload,
        currentPeriodEnd:
          end === null || end === undefined
            ? null
            : end instanceof Date
              ? end
              : new Date(String(end)),
      };
    },

    // WPU-S7: the period end a subscription has now, only when the subscription belongs to this
    // resource AND this customer (the adapters of the plan apply); null otherwise.
    async periodEndOf(input: {
      customerId: string;
      resourceId: string;
      subscriptionId: string;
    }): Promise<Date | null> {
      assertUuid(input.customerId, "customer id");
      assertUuid(input.resourceId, "resource id");
      assertUuid(input.subscriptionId, "subscription id");
      const { rows } = await tx.execute<{ period_end: unknown }>(sql`
        select period_end from subscriptions
        where id = ${input.subscriptionId} and resource_id = ${input.resourceId}
          and customer_id = ${input.customerId}`);
      const end = rows[0]?.period_end;
      if (end === undefined || end === null) return null;
      return end instanceof Date ? end : new Date(String(end));
    },

    async setStatus(subscriptionId: string, status: SubscriptionStatus): Promise<void> {
      assertUuid(subscriptionId, "subscription id");
      await tx.execute(
        sql`update subscriptions set status = ${status} where id = ${subscriptionId}`,
      );
    },

    async setPeriod(
      subscriptionId: string,
      change: { status: SubscriptionStatus; periodStart: Date; periodEnd: Date },
    ): Promise<void> {
      assertUuid(subscriptionId, "subscription id");
      await tx.execute(sql`
        update subscriptions
        set status = ${change.status}, period_start = ${change.periodStart.toISOString()}::timestamptz,
            period_end = ${change.periodEnd.toISOString()}::timestamptz
        where id = ${subscriptionId}`);
    },

    // resources_deleted_check: deleted_at is set exactly when the state is destroyed.
    async setResourceState(resourceId: string, state: string, at: Date): Promise<void> {
      assertUuid(resourceId, "resource id");
      await tx.execute(
        state === "destroyed"
          ? sql`update resources set state = 'destroyed', deleted_at = ${at.toISOString()}::timestamptz where id = ${resourceId}`
          : sql`update resources set state = ${state}, deleted_at = null where id = ${resourceId}`,
      );
    },

    // After a purge: the backups of a resource are gone, so their rows are destroyed too.
    async retireBackups(parentResourceId: string, at: Date): Promise<number> {
      assertUuid(parentResourceId, "resource id");
      const result = await tx.execute(sql`
        update resources set state = 'destroyed', deleted_at = ${at.toISOString()}::timestamptz
        where parent_resource_id = ${parentResourceId} and family = 'backup' and state <> 'destroyed'`);
      return result.rowCount ?? 0;
    },

    // A restore ends the retention: its final snapshots no longer count for a later destroy (R13).
    async supersedeFinalBackups(parentResourceId: string): Promise<number> {
      assertUuid(parentResourceId, "resource id");
      const result = await tx.execute(sql`
        update resources set config = config || '{"final": false}'::jsonb
        where parent_resource_id = ${parentResourceId} and family = 'backup' and config ->> 'final' = 'true'`);
      return result.rowCount ?? 0;
    },

    async resourceOfOperation(operationResourceId: string): Promise<GuardFacts | null> {
      assertUuid(operationResourceId, "resource id");
      const { rows } = await tx.execute<{
        status: SubscriptionStatus | null;
        family: string;
        resource_state: string;
        has_final: boolean;
        is_final: boolean;
      }>(sql`
        select s.status as status, r.family as family, r.state as resource_state,
          exists (select 1 from resources b
            where b.parent_resource_id = r.id and b.family = 'backup' and b.state = 'active'
              and b.deleted_at is null and b.config ->> 'final' = 'true'
              and b.created_at >= (select max(o.created_at) from operations o
                where o.resource_id = r.id and o.kind = 'final_snapshot')) as has_final,
          (r.config ->> 'final') is not distinct from 'true' as is_final
        from resources r left join subscriptions s on s.resource_id = r.id
        where r.id = ${operationResourceId}`);
      const row = rows[0];
      if (row === undefined) return null;
      return {
        subscriptionStatus: row.status,
        family: row.family,
        hasFinalSnapshot: row.has_final === true,
        isFinalBackup: row.is_final === true,
        resourceState: row.resource_state,
      };
    },

    // WPU-S3: the config of a resource and the start of the period its subscription is in, for the
    // mark of a failed plan apply. WPU-S4: and the product in the payload of the failed operation
    // (null when no operation id was given, the operation is not of this resource or has no product).
    // null when the resource is unknown.
    async planApplyFacts(
      resourceId: string,
      operationId?: string,
    ): Promise<{
      config: Record<string, unknown>;
      periodStart: Date | null;
      operationProductId: string | null;
    } | null> {
      assertUuid(resourceId, "resource id");
      if (operationId !== undefined) assertUuid(operationId, "operation id");
      const { rows } = await tx.execute<{
        config: unknown;
        period_start: unknown;
        product_id: unknown;
      }>(sql`
        select r.config as config, s.period_start as period_start,
          (select o.payload ->> 'productId' from operations o
            where o.id = ${operationId ?? null}::uuid and o.resource_id = r.id) as product_id
        from resources r left join subscriptions s on s.resource_id = r.id
        where r.id = ${resourceId}
        limit 1`);
      const row = rows[0];
      if (row === undefined) return null;
      const config =
        typeof row.config === "object" && row.config !== null && !Array.isArray(row.config)
          ? (row.config as Record<string, unknown>)
          : {};
      const start = row.period_start;
      return {
        config,
        periodStart:
          start === null || start === undefined
            ? null
            : start instanceof Date
              ? start
              : new Date(String(start)),
        operationProductId: typeof row.product_id === "string" ? row.product_id : null,
      };
    },

    // One row per dedupe key; a repeat answers false and writes nothing (R7). No conflict target: web_rw
    // (renewNow) has no SELECT on dedupe_key, which a target would need; the only unique key is that one.
    async insertNotification(n: NewLifecycleNotification): Promise<boolean> {
      assertUuid(n.customerId, "customer id");
      const { rows } = await tx.execute<{ id: string }>(sql`
        insert into notifications (id, customer_id, channel, template, payload, dedupe_key)
        values (${uuidv7()}, ${n.customerId}, ${n.channel}, ${n.template}, ${JSON.stringify(n.payload)}::jsonb, ${n.dedupeKey})
        on conflict do nothing
        returning id`);
      return rows.length === 1;
    },
  };
}

export type LifecycleRepo = ReturnType<typeof lifecycleRepo>;
