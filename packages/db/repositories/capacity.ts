import { sql, type SQL } from "drizzle-orm";
import type { Tx } from "../client";
import { isCellKey, RESERVE_KEY_PREFIX, type QuotaCode } from "../capacity-keys";
import { QUOTA_CODES } from "../schema/provisioning";
import { isUuid } from "./scope";

// Job and purchase-support paths over non-tenant tables (pool_capacity, pool_accounts, market rows
// of settings): they take a pool account id from the caller, never a customer id from a request.

export interface CellKey {
  readonly region: string;
  readonly quotaCode: QuotaCode;
}

export type CellSelector =
  | { readonly accountId: string; readonly cells: readonly CellKey[] }
  | { readonly tiers: readonly string[]; readonly cells: readonly CellKey[] };

export interface CapacityCellRow {
  rowId: string;
  poolAccountId: string;
  region: string;
  quotaCode: QuotaCode;
  limit: number;
  used: number;
  status: string;
}

export interface UsedChange {
  readonly rowId: string;
  readonly used: number;
  readonly expectedUsed: number;
}

export interface CapacityRepo {
  // The asked cells, ordered by row id and locked FOR UPDATE OF pc. With accountId: that account,
  // whatever its status. With tiers: active accounts of those tiers only.
  lockCells(selector: CellSelector): Promise<CapacityCellRow[]>;
  // The same rows in the same order, with no lock.
  readCells(selector: CellSelector): Promise<CapacityCellRow[]>;
  readReserves(market: string): Promise<ReadonlyMap<QuotaCode, number>>;
  // Compare-and-set of used; throws when a row is not as it was read.
  setUsed(changes: readonly UsedChange[]): Promise<void>;
}

const MAX_CELLS = 20;

function checkSelector(selector: CellSelector): void {
  const cells = (selector as { cells?: unknown }).cells;
  if (
    !Array.isArray(cells) ||
    cells.length < 1 ||
    cells.length > MAX_CELLS ||
    !cells.every(
      (c: unknown) =>
        typeof c === "object" &&
        c !== null &&
        isCellKey(
          String((c as Record<string, unknown>).quotaCode),
          String((c as Record<string, unknown>).region),
        ),
    )
  ) {
    throw new TypeError("capacity: the cells to lock are not valid");
  }
  if ("accountId" in selector) {
    if (typeof selector.accountId !== "string" || !isUuid(selector.accountId)) {
      throw new TypeError("capacity: the pool account id is not a UUID");
    }
    return;
  }
  const tiers = (selector as { tiers?: unknown }).tiers;
  if (
    !Array.isArray(tiers) ||
    tiers.length < 1 ||
    !tiers.every((tier: unknown) => typeof tier === "string")
  ) {
    throw new TypeError("capacity: the cells to lock are not valid");
  }
}

function scopeFragment(selector: CellSelector): SQL {
  if ("accountId" in selector) {
    return sql`where pc.pool_account_id = ${selector.accountId}::uuid`;
  }
  return sql`where a.status = 'active'
       and a.tier in (select jsonb_array_elements_text(${JSON.stringify(selector.tiers)}::jsonb))`;
}

// One statement for both, so that lockCells and readCells cannot drift apart. The select list
// names a.status and not a.tier: worker_rw may not read pool_accounts.tier.
function cellsStatement(selector: CellSelector, lock: boolean): SQL {
  const cells = selector.cells.map((c) => ({ region: c.region, quotaCode: c.quotaCode }));
  const lockFragment = lock ? sql`for update of pc` : sql``;
  return sql`select pc.id as "rowId", pc.pool_account_id as "poolAccountId", pc.region,
           pc.quota_code as "quotaCode", pc.quota_limit as "limit", pc.used, a.status
      from pool_capacity pc
      join pool_accounts a on a.id = pc.pool_account_id
     ${scopeFragment(selector)}
       and (pc.region, pc.quota_code) in
           (select n.region, n."quotaCode"
              from jsonb_to_recordset(${JSON.stringify(cells)}::jsonb)
                   as n(region text, "quotaCode" text))
     order by pc.id
     ${lockFragment}`;
}

function isQuotaCode(value: string): value is QuotaCode {
  return (QUOTA_CODES as readonly string[]).includes(value);
}

export function capacityRepo(tx: Tx): CapacityRepo {
  const run = async (selector: CellSelector, lock: boolean): Promise<CapacityCellRow[]> => {
    checkSelector(selector);
    const { rows } = await tx.execute<CapacityCellRow & Record<string, unknown>>(
      cellsStatement(selector, lock),
    );
    return rows;
  };
  return {
    lockCells: (selector) => run(selector, true),
    readCells: (selector) => run(selector, false),

    readReserves: async (market) => {
      const { rows } = await tx.execute<{ key: string; value: unknown }>(sql`
        select s.key, s.value from settings s
         where s.market = ${market} and s.scope = 'market'
           and s.key like ${RESERVE_KEY_PREFIX + "%"}`);
      const reserves = new Map<QuotaCode, number>();
      for (const row of rows) {
        const code = row.key.slice(RESERVE_KEY_PREFIX.length);
        if (!isQuotaCode(code)) throw new Error("capacity: a reserve setting names no quota code");
        if (typeof row.value !== "number" || !Number.isInteger(row.value) || row.value < 0) {
          throw new Error("capacity: a reserve setting is not a whole number of units");
        }
        reserves.set(code, row.value);
      }
      return reserves;
    },

    setUsed: async (changes) => {
      if (changes.length === 0) return;
      const { rows } = await tx.execute<{ id: string }>(sql`
        update pool_capacity pc set used = v.used
          from jsonb_to_recordset(${JSON.stringify(changes)}::jsonb)
               as v("rowId" uuid, used int, "expectedUsed" int)
         where pc.id = v."rowId" and pc.used = v."expectedUsed"
        returning pc.id`);
      if (rows.length !== changes.length) throw new Error("capacity: a locked row changed");
    },
  };
}
