// Shared by the database tests of packages/core/capacity. It needs only the tables and the
// Queryable type of @tc/db/testing, which a file outside *.test.ts may import from this folder only.
import type { QuotaCode } from "@tc/db";
import type { Queryable } from "@tc/db/testing";

export const REGION = "ap-southeast-1";
export const OTHER_REGION = "ap-south-1";
export const P1 = "00000000-0000-7000-8000-000000000001";
export const P2 = "00000000-0000-7000-8000-000000000002";

// An instance of 2 vCPUs with one static IP.
export const INSTANCE = [
  { quotaCode: "instance_vcpu", amount: 2 },
  { quotaCode: "static_ip", amount: 1 },
] as const;

interface SeedCell {
  readonly region: string;
  readonly quotaCode: QuotaCode;
  readonly limit: number;
  readonly used: number;
}

// The two seed cells of REGION for seedPool.
export function cells(
  vcpuLimit: number,
  vcpuUsed: number,
  ipLimit: number,
  ipUsed: number,
): SeedCell[] {
  return [
    { region: REGION, quotaCode: "instance_vcpu", limit: vcpuLimit, used: vcpuUsed },
    { region: REGION, quotaCode: "static_ip", limit: ipLimit, used: ipUsed },
  ];
}

// The expected result of readUsed for those two cells.
export function used(vcpu: number, ip: number): Record<string, number> {
  return { [`${REGION}/instance_vcpu`]: vcpu, [`${REGION}/static_ip`]: ip };
}

const COUNTABLE = [
  "pool_capacity",
  "pool_accounts",
  "customer_homes",
  "waitlist_entries",
  "resources",
  "operations",
  "orders",
] as const;

export async function count(q: Queryable, table: (typeof COUNTABLE)[number]): Promise<number> {
  if (!COUNTABLE.includes(table)) throw new Error("count: not a table of the capacity tests");
  const { rows } = await q.query<{ n: number }>(`select count(*)::int as n from ${table}`);
  return rows[0]?.n ?? 0;
}

export async function homesOf(
  q: Queryable,
  customerId: string,
): Promise<{ region: string; pool_account_id: string }[]> {
  const { rows } = await q.query<{ region: string; pool_account_id: string }>(
    "select region, pool_account_id from customer_homes where customer_id = $1 order by region",
    [customerId],
  );
  return rows;
}

export async function waitlistOf(q: Queryable): Promise<
  {
    customer_id: string | null;
    product_family: string;
    region: string;
    reason: string;
  }[]
> {
  const { rows } = await q.query<{
    customer_id: string | null;
    product_family: string;
    region: string;
    reason: string;
  }>(
    "select customer_id, product_family, region, reason from waitlist_entries order by created_at, id",
  );
  return rows;
}
