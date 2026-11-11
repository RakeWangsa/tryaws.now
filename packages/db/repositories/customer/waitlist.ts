import { sql } from "drizzle-orm";
import { v5 as uuidv5 } from "uuid";
import { REGION_PATTERN } from "../../capacity-keys";
import { WAITLIST_REASONS } from "../../schema/service";
import { created, refused, replayed, type Written } from "../result";
import type { TenantScope } from "../scope";

// Fixed namespace of the ids of waitlist entries: the id is the idempotency key (R7).
export const WAITLIST_NAMESPACE = "b5f0c4c1-2d0e-4a52-9d1c-7a9e3f6b8d10";

export interface WaitlistJoin {
  productFamily: string;
  region: string;
  reason: (typeof WAITLIST_REASONS)[number];
  idempotencyKey: string;
}

// web_rw may only insert here: no SELECT, no RETURNING, no conflict target. The caller bounds the
// number of entries (one signed draft makes at most one) and rate limits the customer (R9).
export interface WaitlistRepo {
  join(input: WaitlistJoin): Promise<Written<{ id: string }>>;
}

const FAMILY = /^[a-z][a-z0-9_]{0,39}$/;

export function waitlistRepo(scope: TenantScope): WaitlistRepo {
  return {
    join: async (input) => {
      const { productFamily, region, reason, idempotencyKey } = input;
      if (
        typeof productFamily !== "string" ||
        !FAMILY.test(productFamily) ||
        typeof region !== "string" ||
        !REGION_PATTERN.test(region) ||
        !(WAITLIST_REASONS as readonly string[]).includes(reason) ||
        typeof idempotencyKey !== "string" ||
        idempotencyKey.length < 1 ||
        idempotencyKey.length > 128
      ) {
        return refused("validation");
      }
      // The primary key is the unique constraint that makes the call idempotent.
      const id = uuidv5(
        JSON.stringify([scope.customerId, idempotencyKey, productFamily, region, reason]),
        WAITLIST_NAMESPACE,
      );
      const result = await scope.tx.execute(sql`
        insert into waitlist_entries (id, customer_id, product_family, region, reason)
        values (${id}, ${scope.customerId}, ${productFamily}, ${region}, ${reason})
        on conflict do nothing`);
      return result.rowCount === 1 ? created({ id }) : replayed({ id });
    },
  };
}
