import { randomBytes, randomInt } from "node:crypto";
import type pg from "pg";
import { v7 as uuidv7 } from "uuid";
import { insertRow, type Queryable } from "./sql";

export function uniqueSuffix(): string {
  return randomBytes(4).toString("hex");
}

// Inserts a market once; a second call with the same code does nothing. Returns the code.
export async function ensureMarket(q: Queryable, code = "BD"): Promise<string> {
  await q.query(
    `insert into markets
       (id, code, currency, gateway, locales, numerals, topup_min_minor, topup_max_minor)
     values ($1, $2, 'BDT', 'eps', '{bn,en}', 'beng', 10000, 5000000)
     on conflict (code) do nothing`,
    [uuidv7(), code],
  );
  return code;
}

// Inserts an admin user with a cognito_sub that no other call shares. Returns the id.
export async function newAdmin(q: Queryable, role = "finance"): Promise<string> {
  return insertRow(q, "admin_users", { cognito_sub: "admin-" + uniqueSuffix(), role });
}

// Inserts a customer with a cognito_sub and an email that no other call shares. Returns the id.
export async function newCustomer(
  q: Queryable,
  over: Record<string, unknown> = {},
): Promise<string> {
  const market = await ensureMarket(q);
  const suffix = uniqueSuffix();
  return insertRow(q, "customers", {
    cognito_sub: "sub-" + suffix,
    email: suffix + "@example.test",
    market,
    ...over,
  });
}

// Plain INSERT: a second call with the same type, owner and currency fails on the unique key.
export async function newLedgerAccount(
  q: Queryable,
  type: string,
  customerId: string | null,
  currency = "BDT",
): Promise<string> {
  return insertRow(q, "ledger_accounts", { type, customer_id: customerId, currency });
}

// Returns the account of that type and currency with no owner, or creates it.
export async function systemAccount(q: Queryable, type: string, currency = "BDT"): Promise<string> {
  const find = () =>
    q.query<{ id: string }>(
      "select id from ledger_accounts where type = $1 and currency = $2 and customer_id is null",
      [type, currency],
    );
  const found = await find();
  if (found.rows[0] !== undefined) return found.rows[0].id;
  try {
    return await newLedgerAccount(q, type, null, currency);
  } catch (err) {
    // Another call created it between the SELECT and the INSERT.
    const again = await find();
    if (again.rows[0] !== undefined) return again.rows[0].id;
    throw err;
  }
}

// One transaction row, then one INSERT per line in the given order (never a multi-row INSERT).
// Call it inside inTransaction, with balanced lines.
export async function postLedger(
  c: pg.PoolClient,
  key: string,
  lines: [accountId: string, direction: "debit" | "credit", amountMinor: number][],
): Promise<string> {
  const txId = await insertRow(c, "ledger_transactions", {
    kind: "test",
    reference_type: "test",
    reference_id: uuidv7(),
    idempotency_key: key,
    actor_type: "system",
  });
  for (const [account_id, direction, amount_minor] of lines) {
    await insertRow(c, "ledger_entries", {
      transaction_id: txId,
      account_id,
      direction,
      amount_minor,
    });
  }
  return txId;
}

// Inserts a pool account with an AWS account id that no other call shares. Returns the id.
export async function newPoolAccount(q: Queryable): Promise<string> {
  const aws_account_id = Array.from({ length: 12 }, () => randomInt(10)).join("");
  return insertRow(q, "pool_accounts", {
    aws_account_id,
    name: "tc-pool-" + uniqueSuffix(),
    tier: "dev",
    role_arn: `arn:aws:iam::${aws_account_id}:role/TcProvisioner`,
    external_id: uniqueSuffix(),
    status: "active",
  });
}

// Inserts a Linux instance resource with no pool account. Returns the id.
export async function newResource(
  q: Queryable,
  customerId: string,
  over: Record<string, unknown> = {},
): Promise<string> {
  return insertRow(q, "resources", { customer_id: customerId, family: "linux_instance", ...over });
}
