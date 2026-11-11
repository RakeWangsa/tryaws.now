import { sql } from "drizzle-orm";
import type { Tx } from "../client";
import type { CellKey } from "./capacity";

// A job path (the hourly inventory run, as worker_rw), not a customer repository: it takes a pool
// account id from the job and never a customer id from a request.

export interface CapacityInventoryRepo {
  // Units of the unreleased records on resources of the account that are still `creating`.
  pendingFor(poolAccountId: string, cell: CellKey): Promise<number>;
  // Units of certificate_365d in the records of resources of the account created since `since`,
  // in any state but `creating`, released or not.
  certificatesSince(poolAccountId: string, region: string, since: Date): Promise<number>;
  // Compare-and-set of used and checked_at; throws when the row is not as it was read.
  setInventory(rowId: string, expectedUsed: number, used: number, checkedAt: Date): Promise<void>;
}

// Every cell of the reservation record of every resource r, as c (empty when the record has no
// array of cells). Both counts read the records through this one fragment.
const RECORD_CELLS = sql`from resources r
      cross join lateral jsonb_array_elements(
        case when jsonb_typeof(r.config #> '{capacityReservation,cells}') = 'array'
             then r.config #> '{capacityReservation,cells}' else '[]'::jsonb end) as c`;

export function capacityInventoryRepo(tx: Tx): CapacityInventoryRepo {
  return {
    pendingFor: async (poolAccountId, cell) => {
      const { rows } = await tx.execute<{ pending: number }>(sql`
        select coalesce(sum((c ->> 'amount')::int), 0)::int as pending
          ${RECORD_CELLS}
         where r.pool_account_id = ${poolAccountId}
           and r.state = 'creating'
           and jsonb_typeof(r.config -> 'capacityReservation') = 'object'
           and r.config #>> '{capacityReservation,releasedAt}' is null
           and c ->> 'region' = ${cell.region} and c ->> 'quotaCode' = ${cell.quotaCode}`);
      return rows[0]?.pending ?? 0;
    },

    certificatesSince: async (poolAccountId, region, since) => {
      const { rows } = await tx.execute<{ n: number }>(sql`
        select coalesce(sum((c ->> 'amount')::int), 0)::int as n
          ${RECORD_CELLS}
         where r.pool_account_id = ${poolAccountId} and r.created_at >= ${since.toISOString()}::timestamptz
           and r.state <> 'creating'
           and jsonb_typeof(r.config -> 'capacityReservation') = 'object'
           and c ->> 'quotaCode' = 'certificate_365d' and c ->> 'region' = ${region}`);
      return rows[0]?.n ?? 0;
    },

    setInventory: async (rowId, expectedUsed, used, checkedAt) => {
      const { rows } = await tx.execute<{ id: string }>(sql`
        update pool_capacity set used = ${used}, checked_at = ${checkedAt.toISOString()}::timestamptz
         where id = ${rowId} and used = ${expectedUsed} returning id`);
      if (rows.length !== 1) throw new Error("capacity: a locked row changed");
    },
  };
}
