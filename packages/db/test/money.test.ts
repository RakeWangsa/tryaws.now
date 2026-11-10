import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { LEDGER_ACCOUNT_TYPES, payments } from "../schema/index";
import { useTempDatabase } from "./temp-db";
import { expectSqlError, inTransaction, insertRow } from "./sql";
import {
  newAdmin,
  newCustomer,
  newLedgerAccount,
  postLedger,
  systemAccount,
  uniqueSuffix,
} from "./fixtures";
import { columnTests } from "./expected-columns";

const t = useTempDatabase();
columnTests(
  () => t.pool,
  [
    "wallets",
    "ledger_accounts",
    "ledger_transactions",
    "ledger_entries",
    "wallet_adjustments",
    "payments",
    "orders",
    "invoices",
  ],
);

it("a wallet balance cannot go below 0, and a customer has one wallet", async () => {
  const customer_id = await newCustomer(t.pool);
  await expectSqlError(
    insertRow(t.pool, "wallets", { customer_id, currency: "BDT", balance_minor: -1 }),
    "23514",
    { constraint: "wallets_balance_minor_check" },
  );
  await insertRow(t.pool, "wallets", { customer_id, currency: "BDT" });
  await expectSqlError(insertRow(t.pool, "wallets", { customer_id, currency: "BDT" }), "23505", {
    constraint: "wallets_customer_id_unique",
  });
});

it("only customer wallets have an owner, and each account exists once", async () => {
  const c = await newCustomer(t.pool);
  await expectSqlError(newLedgerAccount(t.pool, "customer_wallet", null), "23514", {
    constraint: "ledger_accounts_owner_check",
  });
  await expectSqlError(newLedgerAccount(t.pool, "gateway_clearing", c), "23514", {
    constraint: "ledger_accounts_owner_check",
  });
  await expectSqlError(newLedgerAccount(t.pool, "cash", null), "23514", {
    constraint: "ledger_accounts_type_check",
  });
  // `refunds` is used by no other test of this file
  await newLedgerAccount(t.pool, "refunds", null, "BDT");
  await newLedgerAccount(t.pool, "refunds", null, "USD");
  await expectSqlError(newLedgerAccount(t.pool, "refunds", null, "BDT"), "23505", {
    constraint: "ledger_accounts_customer_id_type_currency_unique",
  });
});

it("an entry amount must be above 0 and a direction must be debit or credit", async () => {
  const wallet = await newLedgerAccount(t.pool, "customer_wallet", await newCustomer(t.pool));
  const clearing = await systemAccount(t.pool, "gateway_clearing");
  await expectSqlError(
    inTransaction(t.pool, (c) =>
      postLedger(c, "k-zero", [
        [clearing, "debit", 0],
        [wallet, "credit", 0],
      ]),
    ),
    "23514",
    { constraint: "ledger_entries_amount_minor_check" },
  );
  await expectSqlError(
    inTransaction(t.pool, (c) =>
      postLedger(c, "k-neg", [
        [clearing, "debit", -5],
        [wallet, "credit", -5],
      ]),
    ),
    "23514",
    { constraint: "ledger_entries_amount_minor_check" },
  );
  await expectSqlError(
    t.pool.query(
      "insert into ledger_entries (id, transaction_id, account_id, direction, amount_minor) values (gen_random_uuid(), gen_random_uuid(), $1, 'dr', 1)",
      [wallet],
    ),
    "23514",
    { constraint: "ledger_entries_direction_check" },
  );
});

it("one ledger transaction per idempotency key: one draft gives one order", async () => {
  const c = await newCustomer(t.pool);
  const wallet = await newLedgerAccount(t.pool, "customer_wallet", c);
  const revenue = await systemAccount(t.pool, "revenue_aws_base");
  const txId = await inTransaction(t.pool, (k) =>
    postLedger(k, "order:3f2a9c", [
      [wallet, "debit", 63500],
      [revenue, "credit", 63500],
    ]),
  );
  await expectSqlError(
    inTransaction(t.pool, (k) =>
      postLedger(k, "order:3f2a9c", [
        [wallet, "debit", 63500],
        [revenue, "credit", 63500],
      ]),
    ),
    "23505",
    { constraint: "ledger_transactions_idempotency_key_unique" },
  );
  const order = {
    customer_id: c,
    kind: "new",
    items: "[]",
    price_snapshot: "{}",
    total_minor: 63500,
    ledger_transaction_id: txId,
  };
  await insertRow(t.pool, "orders", { ...order, idempotency_key: "client-1" });
  await expectSqlError(
    insertRow(t.pool, "orders", { ...order, idempotency_key: "client-2" }),
    "23505",
    { constraint: "orders_ledger_transaction_id_unique" },
  );
});

it("a system actor has no id, a person actor has one", async () => {
  await expectSqlError(
    t.pool.query(
      "insert into ledger_transactions (id, kind, reference_type, reference_id, idempotency_key, actor_type, actor_id) values (gen_random_uuid(), 'x', 'x', gen_random_uuid(), 'actor-1', 'system', gen_random_uuid())",
    ),
    "23514",
    { constraint: "ledger_transactions_actor_check" },
  );
  await expectSqlError(
    t.pool.query(
      "insert into ledger_transactions (id, kind, reference_type, reference_id, idempotency_key, actor_type) values (gen_random_uuid(), 'x', 'x', gen_random_uuid(), 'actor-2', 'admin')",
    ),
    "23514",
    { constraint: "ledger_transactions_actor_check" },
  );
});

const payment = (customer_id: string, over: Record<string, unknown> = {}) => ({
  customer_id,
  gateway: "eps",
  merchant_transaction_id: "TC" + uniqueSuffix(),
  idempotency_key: "k1",
  amount_minor: 150000,
  currency: "BDT",
  ...over,
});
it("payments: a merchant transaction id of at least 10 characters, unique", async () => {
  const c = await newCustomer(t.pool);
  await insertRow(
    t.pool,
    "payments",
    payment(c, { merchant_transaction_id: "TC12345678", idempotency_key: "a" }),
  );
  await expectSqlError(
    insertRow(
      t.pool,
      "payments",
      payment(c, { merchant_transaction_id: "TC12345678", idempotency_key: "b" }),
    ),
    "23505",
    { constraint: "payments_merchant_transaction_id_unique" },
  );
  await expectSqlError(
    insertRow(
      t.pool,
      "payments",
      payment(c, { merchant_transaction_id: "TC1234567", idempotency_key: "c" }),
    ),
    "23514",
    { constraint: "payments_merchant_transaction_id_check" },
  );
});

it("payments: one idempotency key per customer, the same key for two customers", async () => {
  const a = await newCustomer(t.pool);
  const b = await newCustomer(t.pool);
  const id = await insertRow(t.pool, "payments", payment(a));
  await insertRow(t.pool, "payments", payment(b));
  await expectSqlError(insertRow(t.pool, "payments", payment(a)), "23505", {
    constraint: "payments_customer_id_idempotency_key_unique",
  });
  expect(
    (await t.pool.query("select status from payments where id = $1", [id])).rows[0].status,
  ).toBe("initiated");
});

it.each<[string, Record<string, unknown>, string]>([
  ["the display state pending", { status: "pending" }, "payments_status_check"],
  ["credited without a ledger transaction", { status: "credited" }, "payments_credit_check"],
  ["an amount of 0", { amount_minor: 0 }, "payments_amount_minor_check"],
  ["a lowercase currency", { currency: "bdt" }, "payments_currency_check"],
])("payments refuse %s", async (_, over, constraint) => {
  await expectSqlError(
    insertRow(t.pool, "payments", payment(await newCustomer(t.pool), over)),
    "23514",
    { constraint },
  );
});

it("money above 2^53 makes the round trip through Drizzle exactly", async () => {
  const customerId = await newCustomer(t.pool);
  const [p] = await t.db
    .insert(payments)
    .values({
      customerId,
      gateway: "eps",
      merchantTransactionId: "TC9007199254740993",
      idempotencyKey: "big",
      amountMinor: 9007199254740993n,
      currency: "BDT",
    })
    .returning();
  expect(p!.amountMinor).toBe(9007199254740993n);
  const [back] = await t.db.select().from(payments).where(eq(payments.id, p!.id));
  expect(back!.amountMinor).toBe(9007199254740993n);
});

it("orders: the three states of section 7, four kinds, one key per customer", async () => {
  const c = await newCustomer(t.pool);
  const wallet = await newLedgerAccount(t.pool, "customer_wallet", c);
  const revenue = await systemAccount(t.pool, "revenue_aws_base");
  const tx = (key: string) =>
    inTransaction(t.pool, (k) =>
      postLedger(k, key, [
        [wallet, "debit", 100],
        [revenue, "credit", 100],
      ]),
    );
  const order = async (over: Record<string, unknown>) =>
    insertRow(t.pool, "orders", {
      customer_id: c,
      kind: "new",
      items: "[]",
      price_snapshot: "{}",
      total_minor: 100,
      ledger_transaction_id: await tx("o-" + uniqueSuffix()),
      idempotency_key: "o-" + uniqueSuffix(),
      ...over,
    });
  const id = await order({});
  expect((await t.pool.query("select status from orders where id = $1", [id])).rows[0].status).toBe(
    "paid",
  );
  await expectSqlError(order({ status: "cancelled" }), "23514", {
    constraint: "orders_status_check",
  });
  await expectSqlError(order({ kind: "upgrade" }), "23514", { constraint: "orders_kind_check" });
  await order({ idempotency_key: "same" });
  await expectSqlError(order({ idempotency_key: "same" }), "23505", {
    constraint: "orders_customer_id_idempotency_key_unique",
  });
});

it("invoices: one number per fiscal year, at most one invoice per order, none needed (ruling 9)", async () => {
  const c = await newCustomer(t.pool);
  const wallet = await newLedgerAccount(t.pool, "customer_wallet", c);
  const revenue = await systemAccount(t.pool, "revenue_aws_base");
  const newOrder = async () =>
    insertRow(t.pool, "orders", {
      customer_id: c,
      kind: "new",
      items: "[]",
      price_snapshot: "{}",
      total_minor: 74295,
      idempotency_key: uniqueSuffix(),
      ledger_transaction_id: await inTransaction(t.pool, (k) =>
        postLedger(k, uniqueSuffix(), [
          [wallet, "debit", 74295],
          [revenue, "credit", 74295],
        ]),
      ),
    });
  const o1 = await newOrder();
  const inv = {
    fiscal_year: 2026,
    number: 1,
    customer_id: c,
    order_id: o1,
    lines: "[]",
    total_minor: 74295,
  };
  await insertRow(t.pool, "invoices", inv);
  await expectSqlError(insertRow(t.pool, "invoices", { ...inv, number: 2 }), "23505", {
    constraint: "invoices_order_id_unique",
  });
  await expectSqlError(
    insertRow(t.pool, "invoices", { ...inv, order_id: await newOrder() }),
    "23505",
    { constraint: "invoices_fiscal_year_number_unique" },
  );
  await insertRow(t.pool, "invoices", { ...inv, fiscal_year: 2027, order_id: await newOrder() });
  // two invoices that come from no order: NULL values do not collide on invoices_order_id_unique
  await insertRow(t.pool, "invoices", { ...inv, number: 3, order_id: null });
  await insertRow(t.pool, "invoices", { ...inv, number: 4, order_id: null });
});

it("an adjustment is never approved by its requester and is posted exactly when approved", async () => {
  const customer_id = await newCustomer(t.pool);
  const a = await newAdmin(t.pool, "finance");
  const b = await newAdmin(t.pool, "finance");
  const adj = {
    customer_id,
    direction: "credit",
    amount_minor: 50000,
    kind: "goodwill",
    reason: "outage 2026-11-10",
    requested_by: a,
  };
  await insertRow(t.pool, "wallet_adjustments", adj);
  await expectSqlError(
    insertRow(t.pool, "wallet_adjustments", { ...adj, approved_by: a }),
    "23514",
    { constraint: "wallet_adjustments_approver_check" },
  );
  await expectSqlError(
    insertRow(t.pool, "wallet_adjustments", { ...adj, approved_by: b, status: "approved" }),
    "23514",
    { constraint: "wallet_adjustments_posting_check" },
  );
  await expectSqlError(insertRow(t.pool, "wallet_adjustments", { ...adj, reason: "  " }), "23514", {
    constraint: "wallet_adjustments_reason_check",
  });
  await expectSqlError(
    insertRow(t.pool, "wallet_adjustments", { ...adj, kind: "bonus" }),
    "23514",
    {
      constraint: "wallet_adjustments_kind_check",
    },
  );
});

it("ruling 4: an adjustment below the limit is approved with no approver; another admin may approve one", async () => {
  const customer_id = await newCustomer(t.pool);
  const a = await newAdmin(t.pool, "finance");
  const b = await newAdmin(t.pool, "finance");
  const wallet = await newLedgerAccount(t.pool, "customer_wallet", customer_id);
  const adjustments = await systemAccount(t.pool, "adjustments");
  const post = () =>
    inTransaction(t.pool, (k) =>
      postLedger(k, "adj:" + uniqueSuffix(), [
        [adjustments, "debit", 50000],
        [wallet, "credit", 50000],
      ]),
    );
  const adj = {
    customer_id,
    direction: "credit",
    amount_minor: 50000,
    kind: "goodwill",
    reason: "outage 2026-11-10",
    requested_by: a,
  };
  const tx = await post();
  const below = await insertRow(t.pool, "wallet_adjustments", {
    ...adj,
    status: "approved",
    ledger_transaction_id: tx,
  });
  expect(
    (await t.pool.query("select approved_by from wallet_adjustments where id = $1", [below]))
      .rows[0].approved_by,
  ).toBeNull();
  await insertRow(t.pool, "wallet_adjustments", {
    ...adj,
    approved_by: b,
    status: "approved",
    ledger_transaction_id: await post(),
  });
  await insertRow(t.pool, "wallet_adjustments", { ...adj, approved_by: b, status: "rejected" });
  await expectSqlError(
    insertRow(t.pool, "wallet_adjustments", {
      ...adj,
      status: "approved",
      ledger_transaction_id: tx,
    }),
    "23505",
    { constraint: "wallet_adjustments_ledger_transaction_id_unique" },
  );
});

it("the type check of ledger_accounts holds exactly the values of LEDGER_ACCOUNT_TYPES", async () => {
  const { rows } = await t.pool.query(
    "select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'ledger_accounts_type_check'",
  );
  const inSql = [...(rows[0].def as string).matchAll(/'([a-z_]+)'/g)]
    .map((match) => match[1])
    .sort();
  expect(inSql).toEqual([...LEDGER_ACCOUNT_TYPES].sort());
  expect(LEDGER_ACCOUNT_TYPES).toHaveLength(9);
});
