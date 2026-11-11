import { randomBytes, randomInt } from "node:crypto";
import type pg from "pg";
import { v7 as uuidv7 } from "uuid";
import { inTransaction, insertRow, type Queryable } from "./sql";

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

// Inserts a balanced ledger transaction of 100 paisa (the customer's wallet debited, the system
// account revenue_aws_base credited). The wallet account is created once per customer. A pool runs
// it in its own transaction; a client joins its caller's. Returns the transaction id.
export async function newLedgerTransaction(q: Queryable, customerId: string): Promise<string> {
  const found = await q.query<{ id: string }>(
    "select id from ledger_accounts where type = 'customer_wallet' and customer_id = $1 and currency = 'BDT'",
    [customerId],
  );
  const wallet = found.rows[0]?.id ?? (await newLedgerAccount(q, "customer_wallet", customerId));
  const revenue = await systemAccount(q, "revenue_aws_base");
  const lines: [string, "debit" | "credit", number][] = [
    [wallet, "debit", 100],
    [revenue, "credit", 100],
  ];
  const key = "order-" + uniqueSuffix();
  return "totalCount" in q
    ? inTransaction(q, (c) => postLedger(c, key, lines))
    : postLedger(q, key, lines);
}

// Inserts a paid order of 100 paisa for the customer, with the balanced ledger transaction it needs.
// Returns the order id.
export async function newOrder(q: Queryable, customerId: string): Promise<string> {
  const ledgerTransactionId = await newLedgerTransaction(q, customerId);
  return insertRow(q, "orders", {
    customer_id: customerId,
    kind: "new",
    items: "[]",
    price_snapshot: "{}",
    total_minor: 100,
    ledger_transaction_id: ledgerTransactionId,
    idempotency_key: "o-" + uniqueSuffix(),
  });
}

export const APPEND_ONLY_TABLES = [
  "ledger_transactions",
  "ledger_entries",
  "audit_log",
  "legal_acceptances",
  "fx_rates",
  "pricing_rules",
] as const;
export type AppendOnlyTable = (typeof APPEND_ONLY_TABLES)[number];

let effectiveSeconds = 0;

// Inserts one valid row of an append-only table and returns its id. For ledger_entries it is the
// id of the debit entry of a new balanced transaction. fx_rates and pricing_rules get a new
// effective_from on every call, so the unique keys never collide in one database.
export async function appendOnlyRow(pool: pg.Pool, table: AppendOnlyTable): Promise<string> {
  const effectiveFrom = () =>
    new Date(Date.parse("2030-01-01T00:00:00Z") + ++effectiveSeconds * 1000).toISOString();
  switch (table) {
    case "ledger_transactions":
    case "ledger_entries": {
      const clearing = await systemAccount(pool, "gateway_clearing");
      const wallet = await newLedgerAccount(pool, "customer_wallet", await newCustomer(pool));
      const txId = await inTransaction(pool, (c) =>
        postLedger(c, "ao:" + uniqueSuffix(), [
          [clearing, "debit", 100],
          [wallet, "credit", 100],
        ]),
      );
      if (table === "ledger_transactions") return txId;
      const { rows } = await pool.query<{ id: string }>(
        "select id from ledger_entries where transaction_id = $1 and direction = 'debit'",
        [txId],
      );
      return rows[0]!.id;
    }
    case "audit_log":
      return insertRow(pool, "audit_log", { actor_type: "system", action: "test" });
    case "legal_acceptances":
      return insertRow(pool, "legal_acceptances", {
        customer_id: await newCustomer(pool),
        document: "terms",
        version: "1.0",
        ip: "203.0.113.7",
      });
    case "fx_rates":
      return insertRow(pool, "fx_rates", {
        market: await ensureMarket(pool),
        rate: "124.77",
        effective_from: effectiveFrom(),
      });
    case "pricing_rules":
      return insertRow(pool, "pricing_rules", {
        market: await ensureMarket(pool),
        steps: "[]",
        effective_from: effectiveFrom(),
      });
  }
}
