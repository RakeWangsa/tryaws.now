import { sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Tx } from "../../client";
import { isUuid } from "../scope";

// The statements of metering (WP7-T5), run as worker_rw. System code only: no customer id comes from a
// session, and every statement names columns that worker_rw may read or write (grants.expected.json:
// usage_records SELECT, INSERT of id/resource_id/metric/period/quantity, UPDATE of quantity). They log
// nothing. The quantities are text (numeric(20,6)): the decimal math stays in packages/core/pricing.

export interface UsageRow {
  readonly id: string;
  readonly resourceId: string;
  readonly customerId: string;
  /** Plain decimal text, GB. */
  readonly quantity: string;
}

export interface TransferRow {
  readonly resourceId: string;
  readonly customerId: string;
  /** Sum of the hourly rows of the month, plain decimal text, GB. */
  readonly usedGb: string;
  /** From `resources.config.transferAllowanceGb`; rows without one are not listed. */
  readonly allowanceGb: string;
}

const METRIC = /^[a-z][a-z0-9_]{0,39}$/;
const PERIOD = /^\d{4}-\d{2}(-\d{2}(T\d{2})?)?$/;
const PLAIN = /^\d+(\.\d+)?$/;

function checkLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new RangeError("metering: limit must be from 1 to 1000");
  }
}

export function meteringRepo(tx: Tx) {
  return {
    // The usage rows of one metric and period (a day), in id order, after `afterId`.
    async listUsage(
      metric: string,
      period: string,
      afterId: string | null,
      limit: number,
    ): Promise<UsageRow[]> {
      if (!METRIC.test(metric) || !PERIOD.test(period)) {
        throw new TypeError("metering: metric or period has the wrong form");
      }
      if (afterId !== null && !isUuid(afterId))
        throw new TypeError("metering: afterId is not a UUID");
      checkLimit(limit);
      const { rows } = await tx.execute<{
        id: string;
        resource_id: string;
        customer_id: string;
        quantity: string;
      }>(sql`
        select u.id, u.resource_id, r.customer_id, u.quantity::text as quantity
        from usage_records u join resources r on r.id = u.resource_id
        where u.metric = ${metric} and u.period = ${period}
          and (${afterId}::uuid is null or u.id > ${afterId}::uuid)
        order by u.id limit ${limit}`);
      return rows.map((r) => ({
        id: r.id,
        resourceId: r.resource_id,
        customerId: r.customer_id,
        quantity: r.quantity,
      }));
    },

    // Hourly `transfer_gb` rows of a month summed per resource, for the resources that have an allowance.
    async listTransfer(
      month: string,
      afterResourceId: string | null,
      limit: number,
    ): Promise<TransferRow[]> {
      if (!/^\d{4}-\d{2}$/.test(month)) throw new TypeError("metering: month has the wrong form");
      if (afterResourceId !== null && !isUuid(afterResourceId)) {
        throw new TypeError("metering: afterResourceId is not a UUID");
      }
      checkLimit(limit);
      const { rows } = await tx.execute<{
        resource_id: string;
        customer_id: string;
        used: string;
        allowance: string;
      }>(sql`
        select r.id as resource_id, r.customer_id, sum(u.quantity)::text as used,
          r.config ->> 'transferAllowanceGb' as allowance
        from usage_records u join resources r on r.id = u.resource_id
        where u.metric = 'transfer_gb' and u.period like ${`${month}-%`}
          and (r.config ->> 'transferAllowanceGb') is not null
          and (${afterResourceId}::uuid is null or r.id > ${afterResourceId}::uuid)
        group by r.id
        order by r.id limit ${limit}`);
      // A config value that is not plain decimal text is dropped: no allowance, no notice (R16).
      return rows
        .filter((r) => PLAIN.test(r.used) && PLAIN.test(r.allowance))
        .map((r) => ({
          resourceId: r.resource_id,
          customerId: r.customer_id,
          usedGb: r.used,
          allowanceGb: r.allowance,
        }));
    },

    // The one writer of usage_records (the reconciler and the reader call it): one row per resource,
    // metric and period (R7), the quantity is replaced by the newer measurement.
    async upsertUsage(
      resourceId: string,
      metric: string,
      period: string,
      quantity: string,
    ): Promise<void> {
      if (!isUuid(resourceId)) throw new TypeError("metering: resourceId is not a UUID");
      if (!METRIC.test(metric) || !PERIOD.test(period) || !PLAIN.test(quantity)) {
        throw new TypeError("metering: metric, period or quantity has the wrong form");
      }
      await tx.execute(sql`
        insert into usage_records (id, resource_id, metric, period, quantity)
        values (${uuidv7()}, ${resourceId}, ${metric}, ${period}, ${quantity}::numeric)
        on conflict (resource_id, metric, period) do update set quantity = excluded.quantity`);
    },
  };
}

export type MeteringRepo = ReturnType<typeof meteringRepo>;
