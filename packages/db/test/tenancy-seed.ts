import type pg from "pg";
import { v7 as uuidv7 } from "uuid";
import { inTransaction, insertRow } from "./sql";
import { newAdmin, newPoolAccount, systemAccount, uniqueSuffix } from "./fixtures";

// Seeds for test/tenancy*.test.ts: a row in every one of the 26 tenant tables for a customer, and the
// rows of one customer that point at the rows of another. The seed reads like the Ownership map: a
// new tenant table has no seed, and the test that compares the seeded table names with the map fails
// until this file has one.

// The ids of the seeded rows, by table.
export type RowIds = Record<string, string[]>;

// 2^53 + 1: a JavaScript number cannot hold it, so only text keeps it exact.
export const BIG_AMOUNT = "9007199254740993";

// Rows that no customer owns and that every seeded customer needs.
export interface SeedShared {
  readonly admins: readonly [string, string];
  readonly poolAccount: string;
  readonly clearing: string;
}

export interface Seeded {
  readonly customerId: string;
  // Every row of the customer, by table.
  readonly rows: RowIds;
  // The resource that carries the subscription, the domain, the zone, an operation, a usage record and
  // an abuse case.
  readonly resource: string;
  // A resource that carries no subscription, domain or zone (each is unique per resource), so that the
  // rows of another customer can point at it.
  readonly spare: string;
  // The order of the customer. The own invoice of the customer has no order (an invoice is unique per
  // order), so that the invoice of another customer can point at this one.
  readonly order: string;
  // A ledger transaction that credits the wallet of the customer and that no order of the customer
  // uses (an order is unique per ledger transaction).
  readonly linkedTransaction: string;
}

export interface SeedOptions {
  // A destroyed resource with an operation: the snapshot must not drop destroyed resources.
  readonly destroyed?: boolean;
  // The credit of the linked transaction is BIG_AMOUNT minor units instead of 20.
  readonly bigEntry?: boolean;
}

// Invoice numbers are unique per fiscal year over all customers of the database.
let invoiceNumber = 0;

// Admins, the pool account, the TLD and the clearing account that the seeded rows refer to. Once per
// database.
export async function seedShared(pool: pg.Pool): Promise<SeedShared> {
  await insertRow(pool, "tlds", { tld: "com", synced_at: new Date().toISOString() });
  return {
    admins: [await newAdmin(pool), await newAdmin(pool)],
    poolAccount: await newPoolAccount(pool),
    clearing: await systemAccount(pool, "gateway_clearing"),
  };
}

// One row in each of the 26 tenant tables for the customer, which must exist. Every row is the
// customer's own (customer_id, or the resource, account or actor that the owner predicate follows).
export async function seedCustomer(
  pool: pg.Pool,
  shared: SeedShared,
  customerId: string,
  options: SeedOptions = {},
): Promise<Seeded> {
  const rows: RowIds = { customers: [customerId] };
  const add = async (table: string, values: Record<string, unknown>): Promise<string> => {
    const id = await insertRow(pool, table, values);
    (rows[table] ??= []).push(id);
    return id;
  };

  await add("kyc_submissions", {
    customer_id: customerId,
    document_type: "nid",
    document_number_encrypted: Buffer.from("x"),
    s3_keys: ["k"],
  });
  await add("ssh_keys", {
    customer_id: customerId,
    name: "k",
    public_key: "ssh-ed25519 AAAA",
    fingerprint: "SHA256:" + uniqueSuffix(),
  });
  await add("otp_challenges", {
    customer_id: customerId,
    phone: "+8801700000000",
    code_hash: "h",
    expires_at: "2030-01-01T00:00:00Z",
  });
  await add("legal_acceptances", {
    customer_id: customerId,
    document: "terms",
    version: "1",
    ip: "203.0.113.7",
  });
  await add("wallets", { customer_id: customerId, currency: "BDT" });

  // The ledger. The clearing entry belongs to an account without an owner, so it is in no snapshot.
  const wallet = await add("ledger_accounts", {
    type: "customer_wallet",
    customer_id: customerId,
    currency: "BDT",
  });
  const post = (amount: string) =>
    inTransaction(pool, async (c) => {
      const transaction = await insertRow(c, "ledger_transactions", {
        kind: "test",
        reference_type: "test",
        reference_id: uuidv7(),
        idempotency_key: "seed-" + uuidv7(),
        actor_type: "system",
      });
      await insertRow(c, "ledger_entries", {
        transaction_id: transaction,
        account_id: shared.clearing,
        direction: "debit",
        amount_minor: amount,
      });
      const entry = await insertRow(c, "ledger_entries", {
        transaction_id: transaction,
        account_id: wallet,
        direction: "credit",
        amount_minor: amount,
      });
      return { transaction, entry };
    });
  const forOrder = await post("10");
  const forLink = await post(options.bigEntry ? BIG_AMOUNT : "20");
  for (const { transaction, entry } of [forOrder, forLink]) {
    (rows.ledger_transactions ??= []).push(transaction);
    (rows.ledger_entries ??= []).push(entry);
  }

  await add("wallet_adjustments", {
    customer_id: customerId,
    direction: "credit",
    amount_minor: 1,
    kind: "goodwill",
    reason: "r",
    requested_by: shared.admins[0],
  });
  await add("payments", {
    customer_id: customerId,
    gateway: "eps",
    merchant_transaction_id: "mtx-" + uniqueSuffix() + uniqueSuffix(),
    idempotency_key: uniqueSuffix(),
    amount_minor: 1,
    currency: "BDT",
  });
  const order = await add("orders", {
    customer_id: customerId,
    kind: "new",
    items: "[]",
    price_snapshot: "{}",
    total_minor: 0,
    ledger_transaction_id: forOrder.transaction,
    idempotency_key: uniqueSuffix(),
  });
  // An invoice without an order: see Seeded.order.
  await add("invoices", {
    fiscal_year: 2026,
    number: ++invoiceNumber,
    customer_id: customerId,
    lines: "[]",
    total_minor: 0,
  });
  await add("customer_homes", {
    customer_id: customerId,
    region: "ap-south-1",
    pool_account_id: shared.poolAccount,
  });

  // The resources. Each customer has its own resource with its operation, usage record and abuse case.
  const resource = await add("resources", { customer_id: customerId, family: "linux_instance" });
  const spare = await add("resources", { customer_id: customerId, family: "linux_instance" });
  await add("subscriptions", {
    resource_id: resource,
    customer_id: customerId,
    term_days: 30,
    price_snapshot: "{}",
    period_start: "2026-11-01",
    period_end: "2026-12-01",
  });
  await add("operations", {
    resource_id: resource,
    kind: "reboot",
    idempotency_key: uniqueSuffix(),
  });
  await add("usage_records", {
    resource_id: resource,
    metric: "gb",
    period: "2026-11",
    quantity: "1",
  });
  await add("abuse_cases", { resource_id: resource, source: "manual" });
  await add("domains", {
    customer_id: customerId,
    resource_id: resource,
    name: "d" + uniqueSuffix() + ".com",
    tld: "com",
    status: "pending",
  });
  await add("dns_zones", {
    customer_id: customerId,
    resource_id: resource,
    name: "z" + uniqueSuffix() + ".com",
    status: "pending",
  });
  if (options.destroyed) {
    const destroyed = await add("resources", {
      customer_id: customerId,
      family: "linux_instance",
      state: "destroyed",
      deleted_at: new Date().toISOString(),
    });
    await add("operations", {
      resource_id: destroyed,
      kind: "destroy",
      idempotency_key: uniqueSuffix(),
    });
  }

  await add("notifications", {
    customer_id: customerId,
    channel: "in_app",
    template: "t",
    dedupe_key: uniqueSuffix(),
  });
  await add("waitlist_entries", {
    customer_id: customerId,
    product_family: "linux_instance",
    region: "ap-south-1",
    reason: "capacity",
  });
  await add("support_requests", {
    customer_id: customerId,
    category: "general",
    subject: "s",
    message: "m",
  });
  await add("audit_log", { actor_type: "customer", actor_id: customerId, action: "x" });
  await add("settings", {
    key: "limit." + uniqueSuffix(),
    market: "BD",
    scope: "customer",
    scope_id: customerId,
    value: "1",
  });

  return {
    customerId,
    rows,
    resource,
    spare,
    order,
    linkedTransaction: forLink.transaction,
  };
}

// Nine rows of the customer `from` that point at rows of the customer `to`, one per table whose owner
// predicate has a second path. Nothing in the database ties the owner of such a row to the owner of
// the row it points at (the foreign keys are single-column), so the database accepts every insert.
// The rows have customer_id = from: they are the rows of `from`, and the snapshot of `to` must see
// them too. Returns the ids by table.
export async function seedCrossLinks(
  pool: pg.Pool,
  shared: SeedShared,
  from: string,
  to: Seeded,
): Promise<RowIds> {
  const rows: RowIds = {};
  const add = async (table: string, values: Record<string, unknown>): Promise<void> => {
    (rows[table] ??= []).push(await insertRow(pool, table, values));
  };

  await add("subscriptions", {
    resource_id: to.spare,
    customer_id: from,
    term_days: 30,
    price_snapshot: "{}",
    period_start: "2026-11-01",
    period_end: "2026-12-01",
  });
  await add("domains", {
    customer_id: from,
    resource_id: to.spare,
    name: "d" + uniqueSuffix() + ".com",
    tld: "com",
    status: "pending",
  });
  await add("dns_zones", {
    customer_id: from,
    resource_id: to.spare,
    name: "z" + uniqueSuffix() + ".com",
    status: "pending",
  });
  await add("support_requests", {
    customer_id: from,
    category: "general",
    related_resource_id: to.resource,
    subject: "s",
    message: "m",
  });
  await add("resources", {
    customer_id: from,
    family: "linux_instance",
    parent_resource_id: to.resource,
  });
  await add("invoices", {
    fiscal_year: 2026,
    number: ++invoiceNumber,
    customer_id: from,
    order_id: to.order,
    lines: "[]",
    total_minor: 0,
  });
  await add("orders", {
    customer_id: from,
    kind: "new",
    items: "[]",
    price_snapshot: "{}",
    total_minor: 0,
    ledger_transaction_id: to.linkedTransaction,
    idempotency_key: uniqueSuffix(),
  });
  await add("payments", {
    customer_id: from,
    gateway: "eps",
    merchant_transaction_id: "mtx-" + uniqueSuffix() + uniqueSuffix(),
    idempotency_key: uniqueSuffix(),
    amount_minor: 1,
    currency: "BDT",
    status: "credited",
    ledger_transaction_id: to.linkedTransaction,
  });
  await add("wallet_adjustments", {
    customer_id: from,
    direction: "credit",
    amount_minor: 1,
    kind: "goodwill",
    reason: "r",
    requested_by: shared.admins[0],
    approved_by: shared.admins[1],
    status: "approved",
    ledger_transaction_id: to.linkedTransaction,
  });
  return rows;
}
