import { sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { Tx } from "../client";

// A job path (the failure step and the destroy step, as worker_rw), not a customer repository:
// it takes a resource id from the job and never a customer id from a request.

export type ReservationState =
  | { kind: "none"; reason: "not_found" | "no_reservation" | "already_released" }
  | { kind: "record"; state: string; poolAccountId: string | null; record: unknown };

export interface CapacityReleaseRepo {
  // Reads the state and the record of the resource and locks its row (lock order: wallet,
  // resource, cells), so that a second release waits here and then sees the mark.
  inspect(resourceId: string): Promise<ReservationState>;
  // Sets releasedAt once; false when the record is missing or was already marked.
  mark(resourceId: string, releasedAt: string): Promise<boolean>;
  recordProblem(resourceId: string, reason: "malformed_record" | "row_missing"): Promise<void>;
}

export function capacityReleaseRepo(tx: Tx): CapacityReleaseRepo {
  return {
    inspect: async (resourceId) => {
      const { rows } = await tx.execute<{
        state: string;
        poolAccountId: string | null;
        rec: unknown;
      }>(sql`select r.state, r.pool_account_id as "poolAccountId", r.config -> 'capacityReservation' as rec
               from resources r where r.id = ${resourceId}
                for update of r`);
      const found = rows[0];
      if (!found) return { kind: "none", reason: "not_found" };
      const rec = found.rec;
      if (rec === null || rec === undefined) return { kind: "none", reason: "no_reservation" };
      if (
        typeof rec === "object" &&
        !Array.isArray(rec) &&
        typeof (rec as Record<string, unknown>).releasedAt === "string"
      ) {
        return { kind: "none", reason: "already_released" };
      }
      return {
        kind: "record",
        state: found.state,
        poolAccountId: found.poolAccountId,
        record: rec,
      };
    },

    mark: async (resourceId, releasedAt) => {
      const { rows } = await tx.execute<{ id: string }>(sql`update resources r
           set config = jsonb_set(r.config, '{capacityReservation,releasedAt}', to_jsonb(${releasedAt}::text), true)
         where r.id = ${resourceId}
           and jsonb_typeof(r.config -> 'capacityReservation') = 'object'
           and r.config #>> '{capacityReservation,releasedAt}' is null
        returning r.id`);
      return rows.length === 1;
    },

    recordProblem: async (resourceId, reason) => {
      await tx.execute(sql`insert into discrepancies (id, kind, details)
        values (${uuidv7()}, 'missing', ${JSON.stringify({ resourceId, reason, source: "capacity_release" })}::jsonb)`);
    },
  };
}
