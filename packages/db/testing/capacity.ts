// Test helpers for the capacity tables. Only test code imports this (through @tc/db/testing).
import { randomInt } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import type { Tx } from "../client";
import type { QuotaCode } from "../capacity-keys";
import { uniqueSuffix } from "../test/fixtures";
import { insertRow, type Queryable } from "../test/sql";
import { sql } from "drizzle-orm";

export interface PoolSeed {
  readonly id?: string;
  readonly tier?: string;
  readonly status?: string;
  readonly cells?: readonly {
    readonly region: string;
    readonly quotaCode: QuotaCode;
    readonly limit: number;
    readonly used?: number;
  }[];
}

export interface SeededPool {
  readonly poolAccountId: string;
  // `<region>/<quotaCode>` to the id of the pool_capacity row
  readonly rows: Readonly<Record<string, string>>;
}

// Inserts a pool account (tier new and status active unless given) and its cells, one after the
// other in the given order, so their ids rise in that order.
export async function seedPool(q: Queryable, seed: PoolSeed = {}): Promise<SeededPool> {
  const awsAccountId = Array.from({ length: 12 }, () => randomInt(10)).join("");
  const poolAccountId = await insertRow(q, "pool_accounts", {
    id: seed.id ?? uuidv7(),
    aws_account_id: awsAccountId,
    name: "tc-pool-" + uniqueSuffix(),
    tier: seed.tier ?? "new",
    role_arn: `arn:aws:iam::${awsAccountId}:role/TcProvisioner`,
    external_id: uniqueSuffix(),
    status: seed.status ?? "active",
  });
  const rows: Record<string, string> = {};
  for (const cell of seed.cells ?? []) {
    rows[`${cell.region}/${cell.quotaCode}`] = await insertRow(q, "pool_capacity", {
      pool_account_id: poolAccountId,
      region: cell.region,
      quota_code: cell.quotaCode,
      quota_limit: cell.limit,
      used: cell.used ?? 0,
    });
  }
  return { poolAccountId, rows };
}

export async function readUsed(
  q: Queryable,
  poolAccountId: string,
): Promise<Record<string, number>> {
  const { rows } = await q.query<{ region: string; quota_code: string; used: number }>(
    "select region, quota_code, used from pool_capacity where pool_account_id = $1",
    [poolAccountId],
  );
  return Object.fromEntries(rows.map((r) => [`${r.region}/${r.quota_code}`, r.used]));
}

// As the owner, deletes everything the capacity tests seed, children first.
export async function resetCapacity(q: Queryable): Promise<void> {
  for (const table of [
    "waitlist_entries",
    "customer_homes",
    "operations",
    "resources",
    "pool_capacity",
    "pool_accounts",
  ]) {
    await q.query(`delete from ${table}`);
  }
  await q.query("delete from settings where key like 'capacity.%'");
}

// Inside the transaction, waits until another transaction really waits for a lock (no fixed
// sleep), at most maxSeconds. pg_locks.database is null for a row-lock wait, hence the join.
export async function holdUntilWaiter(tx: Tx, maxSeconds: number): Promise<boolean> {
  const deadline = Date.now() + maxSeconds * 1000;
  while (Date.now() < deadline) {
    const { rows } = await tx.execute<{ n: number }>(sql`
      select count(*)::int as n from pg_locks l join pg_stat_activity a on a.pid = l.pid
       where not l.granted and a.datname = current_database()`);
    if ((rows[0]?.n ?? 0) > 0) return true;
    await tx.execute(sql`select pg_sleep(0.02)`);
  }
  return false;
}

// What the failure step and the destroy step do before they release. Run it as worker_rw.
export async function setResourceState(
  tx: Tx,
  resourceId: string,
  state: "active" | "failed" | "destroyed",
): Promise<void> {
  await tx.execute(sql`update resources
       set state = ${state}, deleted_at = case when ${state}::text = 'destroyed' then now() else null end
     where id = ${resourceId}`);
}
