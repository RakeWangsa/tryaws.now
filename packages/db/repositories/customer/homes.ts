import { sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import { REGION_PATTERN } from "../../capacity-keys";
import { created, refused, replayed, type Written } from "../result";
import { isUuid, type TenantScope } from "../scope";

// The home of a customer in one Region (3.1): the pool account that holds all of its resources there.
// poolAccountId is server only: the pool account is internal (16.13), so a caller never returns this
// row to a client.
export interface CustomerHome {
  id: string;
  region: string;
  poolAccountId: string;
  createdAt: Date;
}

export interface HomesRepo {
  get(region: string): Promise<CustomerHome | null>;
  assign(region: string, poolAccountId: string): Promise<Written<CustomerHome>>;
}

// A raw tx.execute gives created_at as text: new Date maps it.
type RawHome = { id: string; region: string; poolAccountId: string; createdAt: string };

const toHome = (row: RawHome): CustomerHome => ({ ...row, createdAt: new Date(row.createdAt) });

export function homesRepo(scope: TenantScope): HomesRepo {
  const lookup = async (region: string): Promise<CustomerHome | null> => {
    const { rows } = await scope.tx.execute<RawHome>(sql`
      select h.id, h.region, h.pool_account_id as "poolAccountId", h.created_at as "createdAt"
        from customer_homes h
       where h.customer_id = ${scope.customerId} and h.region = ${region}`);
    const [row] = rows;
    return row === undefined ? null : toHome(row);
  };

  return {
    get: async (region) => (REGION_PATTERN.test(region) ? lookup(region) : null),

    assign: async (region, poolAccountId) => {
      if (!REGION_PATTERN.test(region)) return refused("validation");
      if (!isUuid(poolAccountId)) return refused("not_found");
      // The row is written only for an active account of the tier of the customer, read under the
      // session's customer id: a home never changes, so a wrong tier would be permanent. ON CONFLICT
      // DO NOTHING, never a caught 23505 (it would abort the caller's transaction).
      const { rows } = await scope.tx.execute<RawHome>(sql`
        insert into customer_homes (id, customer_id, region, pool_account_id)
        select ${uuidv7()}, ${scope.customerId}, ${region}, a.id
          from pool_accounts a
         where a.id = ${poolAccountId} and a.status = 'active'
           and a.tier = (select c.risk_tier from customers c where c.id = ${scope.customerId})
        on conflict (customer_id, region) do nothing
        returning id, region, pool_account_id as "poolAccountId", created_at as "createdAt"`);
      const [row] = rows;
      if (row !== undefined) return created(toHome(row));

      const own = await lookup(region);
      if (own === null) return refused("not_found");
      return own.poolAccountId === poolAccountId ? replayed(own) : refused("conflict");
    },
  };
}
