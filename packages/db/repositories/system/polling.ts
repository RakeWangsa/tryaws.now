import { sql } from "drizzle-orm";
import type { Tx } from "../../client";
import { isUuid } from "../scope";

// WPU-B3 (item 21). The statements of the scheduled polls, run as worker_rw. System code only: no customer
// id comes from a session; the caller takes the ids found here and writes an operation row for each (R1).
// They read only `resources` and log nothing. The config facts they look at are written by the adapters
// (`config.parameters.readAt` by read_db_parameters, `config.certificate` by request_ and
// refresh_certificate); a value that cannot be read counts as "not read yet" (R16: it is polled again).

export interface PollingRepo {
  /** Active databases whose parameter list was never read, or was last read before `staleBefore`. */
  databasesToRead(staleBefore: Date, afterId: string | null, limit: number): Promise<string[]>;
  /** Active load balancers, CDNs and container services whose certificate is waiting (validation or attach). */
  certificatesToRefresh(afterId: string | null, limit: number): Promise<string[]>;
}

function check(afterId: string | null, limit: number): void {
  if (afterId !== null && !isUuid(afterId)) throw new TypeError("polling: afterId is not a UUID");
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new RangeError("polling: limit must be from 1 to 1000");
  }
}

export function pollingRepo(tx: Tx): PollingRepo {
  return {
    async databasesToRead(staleBefore, afterId, limit) {
      check(afterId, limit);
      if (Number.isNaN(staleBefore.getTime())) throw new TypeError("polling: staleBefore");
      // ISO instants compare as text in time order; anything else sorts as a value that is not newer.
      const { rows } = await tx.execute<{ id: string }>(sql`
        select r.id::text as id from resources r
        where r.family = 'database' and r.state = 'active' and r.deleted_at is null
          and coalesce(r.config -> 'parameters' ->> 'readAt', '') < ${staleBefore.toISOString()}
          and (${afterId}::uuid is null or r.id > ${afterId}::uuid)
        order by r.id limit ${limit}`);
      return rows.map((r) => r.id);
    },

    async certificatesToRefresh(afterId, limit) {
      check(afterId, limit);
      const { rows } = await tx.execute<{ id: string }>(sql`
        select r.id::text as id from resources r
        where r.family in ('load_balancer', 'cdn', 'container_service')
          and r.state = 'active' and r.deleted_at is null
          and (
            r.config -> 'certificate' ->> 'status' = 'PENDING_VALIDATION'
            or (r.config -> 'certificate' ->> 'status' = 'ISSUED'
                and coalesce(r.config -> 'certificate' ->> 'attached', 'false') <> 'true')
          )
          and (${afterId}::uuid is null or r.id > ${afterId}::uuid)
        order by r.id limit ${limit}`);
      return rows.map((r) => r.id);
    },
  };
}
