import { randomInt } from "node:crypto";
import type { RunTx } from "@tc/core";
import { APPROVAL_SETTING, APPROVAL_UNTIL, type Database } from "@tc/db";
import {
  ensureMarket,
  insertRow,
  newAdmin,
  newCustomer,
  newOrder,
  newResource,
  runTransaction,
  uniqueSuffix,
  type TempDatabaseHandle,
} from "@tc/db/testing";

type Pool = TempDatabaseHandle["pool"];

export interface World {
  readonly customerId: string;
  readonly poolAccountId: string;
  readonly resourceId: string;
  readonly adminId: string;
  readonly orderId: string;
}

// Deletes the settings row if there is one and writes it again, so it can run twice in one database.
export async function putApprovalUntil(pool: Pool): Promise<void> {
  await ensureMarket(pool, "BD");
  await pool.query("delete from settings where key = $1", [APPROVAL_SETTING.key]);
  await pool.query(
    "insert into settings (id, key, market, scope, scope_id, value) values (gen_random_uuid(), $1, $2, $3, null, $4::jsonb)",
    [
      APPROVAL_SETTING.key,
      APPROVAL_SETTING.market,
      APPROVAL_SETTING.scope,
      JSON.stringify(APPROVAL_UNTIL),
    ],
  );
}

export async function seedWorld(pool: Pool): Promise<World> {
  await putApprovalUntil(pool);
  const customerId = await newCustomer(pool);
  const awsAccountId = Array.from({ length: 12 }, () => randomInt(10)).join("");
  const poolAccountId = await insertRow(pool, "pool_accounts", {
    aws_account_id: awsAccountId,
    name: "tc-pool-" + uniqueSuffix(),
    tier: "dev",
    role_arn: `arn:aws:iam::${awsAccountId}:role/TcProvisioner`,
    external_id: "ext-" + uniqueSuffix(),
    status: "active",
  });
  const resourceId = await newResource(pool, customerId, {
    pool_account_id: poolAccountId,
    region: "ap-southeast-1",
  });
  const adminId = await newAdmin(pool, "ops");
  const orderId = await newOrder(pool, customerId);
  return { customerId, poolAccountId, resourceId, adminId, orderId };
}

// Another placed resource of the same customer.
export function seedResource(
  pool: Pool,
  world: World,
  over: Record<string, unknown> = {},
): Promise<string> {
  return newResource(pool, world.customerId, {
    pool_account_id: world.poolAccountId,
    region: "ap-southeast-1",
    ...over,
  });
}

// State queued, kind reboot, a unique key; `over` uses SQL column names. No payload.
export function seedOperation(
  pool: Pool,
  resourceId: string,
  over: Record<string, unknown> = {},
): Promise<string> {
  return insertRow(pool, "operations", {
    resource_id: resourceId,
    kind: "reboot",
    state: "queued",
    idempotency_key: "seed:" + uniqueSuffix(),
    ...over,
  });
}

// A create of the order of the customer of the world, so the claim lets it run.
export function seedCreate(
  pool: Pool,
  world: World,
  resourceId: string,
  over: Record<string, unknown> = {},
): Promise<string> {
  return seedOperation(pool, resourceId, {
    kind: "create",
    payload: { orderId: world.orderId },
    ...over,
  });
}

export async function operationRow(pool: Pool, id: string): Promise<Record<string, unknown>> {
  const { rows } = await pool.query("select * from operations where id = $1", [id]);
  const row = rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) throw new Error("operation row not found");
  return row;
}

export const workerTx =
  (db: Database): RunTx =>
  (fn) =>
    runTransaction(db, fn, { role: "worker_rw" });
