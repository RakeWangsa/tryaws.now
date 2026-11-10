import { v7 as uuidv7 } from "uuid";
import { beforeAll, describe, expect, it } from "vitest";
import { useTempDatabase } from "./temp-db";
import { expectSqlError, inTransaction, insertRow } from "./sql";
import {
  APPEND_ONLY_TABLES,
  type AppendOnlyTable,
  appendOnlyRow,
  newCustomer,
  newLedgerAccount,
  newResource,
  postLedger,
  systemAccount,
  uniqueSuffix,
} from "./fixtures";

const t = useTempDatabase();

it.each(APPEND_ONLY_TABLES)("R5: even the owner cannot UPDATE or DELETE %s", async (table) => {
  const id = await appendOnlyRow(t.pool, table);
  await expectSqlError(
    t.pool.query(`update ${table} set created_at = created_at where id = $1`, [id]),
    "23001",
    { message: new RegExp(`^R5: ${table} is append-only$`) },
  );
  await expectSqlError(t.pool.query(`delete from ${table} where id = $1`, [id]), "23001", {
    message: new RegExp(`^R5: ${table} is append-only$`),
  });
  expect(
    (await t.pool.query(`select count(*)::int as n from ${table} where id = $1`, [id])).rows[0].n,
  ).toBe(1);
});

it.each(["ledger_entries", "audit_log", "legal_acceptances", "fx_rates", "pricing_rules"])(
  "R5: even the owner cannot TRUNCATE %s",
  async (table) => {
    await appendOnlyRow(t.pool, table as AppendOnlyTable);
    await expectSqlError(t.pool.query(`truncate ${table}`), "23001", {
      message: /^R5: .* is append-only$/,
    });
  },
);

it("R5: TRUNCATE ledger_transactions CASCADE is refused too", async () => {
  await appendOnlyRow(t.pool, "ledger_transactions");
  await expectSqlError(t.pool.query("truncate ledger_transactions cascade"), "23001", {
    message: /^R5: .* is append-only$/,
  });
});

it("R13: needs_approval never changes after the row is created, not even for the owner (ruling 6)", async () => {
  const resource_id = await newResource(t.pool, await newCustomer(t.pool));
  const flagged = await insertRow(t.pool, "operations", {
    resource_id,
    kind: "destroy",
    state: "failed", // the table CHECKs of Task 6 allow both flag values here, so only the trigger can refuse
    needs_approval: true,
    idempotency_key: uniqueSuffix(),
  });
  const plain = await insertRow(t.pool, "operations", {
    resource_id,
    kind: "reboot",
    state: "failed",
    idempotency_key: uniqueSuffix(),
  });
  const fixed = { message: /^R13: operations\.needs_approval cannot change$/ };
  await expectSqlError(
    t.pool.query("update operations set needs_approval = false where id = $1", [flagged]),
    "23001",
    fixed,
  );
  await expectSqlError(
    t.pool.query("update operations set needs_approval = true where id = $1", [plain]),
    "23001",
    fixed,
  );
  await expectSqlError(
    t.pool.query("update operations set needs_approval = false, state = 'queued' where id = $1", [
      flagged,
    ]),
    "23001",
    fixed,
  );
  const same = await t.pool.query(
    "update operations set needs_approval = needs_approval, attempts = 1 where id = $1",
    [flagged],
  );
  expect(same.rowCount).toBe(1);
  const { rows } = await t.pool.query(
    "select needs_approval from operations where id = any($1) order by needs_approval",
    [[plain, flagged]],
  );
  expect(rows.map((r) => r.needs_approval)).toEqual([false, true]);
});

describe("ledger balance", () => {
  let wallet: string,
    clearing: string,
    revenue: string,
    korea: string,
    bd: string,
    fee: string,
    usd: string;
  beforeAll(async () => {
    const c = await newCustomer(t.pool);
    wallet = await newLedgerAccount(t.pool, "customer_wallet", c);
    clearing = await systemAccount(t.pool, "gateway_clearing");
    revenue = await systemAccount(t.pool, "revenue_aws_base");
    korea = await systemAccount(t.pool, "vat_korea_payable");
    bd = await systemAccount(t.pool, "vat_bd_payable");
    fee = await systemAccount(t.pool, "processing_fee_income");
    usd = await systemAccount(t.pool, "gateway_clearing", "USD");
  });
  const count = async (id: string) =>
    (await t.pool.query("select count(*)::int as n from ledger_transactions where id = $1", [id]))
      .rows[0].n;

  it("commits a balanced top-up whose lines arrive in two statements", async () => {
    const id = await inTransaction(t.pool, (c) =>
      postLedger(c, "topup:p1", [
        [clearing, "debit", 150000],
        [wallet, "credit", 150000],
      ]),
    );
    expect(await count(id)).toBe(1);
  });

  it("commits the section 8 purchase of 5 USD at FX 127", async () => {
    const id = await inTransaction(t.pool, (c) =>
      postLedger(c, "order:v5", [
        [wallet, "debit", 74295],
        [revenue, "credit", 63500],
        [korea, "credit", 6350],
        [bd, "credit", 3175],
        [fee, "credit", 1270],
      ]),
    );
    expect(await count(id)).toBe(1);
    const { rows } = await t.pool.query(
      "select count(*)::int as n, sum(amount_minor) filter (where direction = 'credit')::int8::text as credits from ledger_entries where transaction_id = $1",
      [id],
    );
    expect(rows[0]).toEqual({ n: 5, credits: "74295" });
  });

  it.each<
    [
      string,
      [string, "debit" | "credit", number][] | (() => [string, "debit" | "credit", number][]),
    ]
  >([
    [
      "debits above credits by one paisa",
      () => [
        [clearing, "debit", 150000],
        [wallet, "credit", 149999],
      ],
    ],
    ["a debit only", () => [[clearing, "debit", 150000]]],
    ["no lines at all", []],
    [
      "lines that balance only across currencies",
      () => [
        [usd, "debit", 100],
        [wallet, "credit", 100],
      ],
    ],
  ])("refuses at commit: %s, and nothing stays", async (_, lines) => {
    const key = "bad:" + uniqueSuffix();
    await expectSqlError(
      inTransaction(t.pool, (c) =>
        postLedger(c, key, typeof lines === "function" ? lines() : lines),
      ),
      "23514",
      { message: /^ledger transaction [0-9a-f-]{36} is not balanced$/ },
    );
    expect(
      (
        await t.pool.query(
          "select count(*)::int as n from ledger_transactions where idempotency_key = $1",
          [key],
        )
      ).rows[0].n,
    ).toBe(0);
  });

  it("a committed ledger transaction is closed: a later database transaction adds no line, not even a balanced pair", async () => {
    const id = await inTransaction(t.pool, (c) =>
      postLedger(c, "topup:p2", [
        [clearing, "debit", 1000],
        [wallet, "credit", 1000],
      ]),
    );
    const add = (lines: [string, "debit" | "credit", number][]) =>
      inTransaction(t.pool, async (c) => {
        for (const [account, direction, amount] of lines)
          await c.query(
            "insert into ledger_entries (id, transaction_id, account_id, direction, amount_minor) values ($1, $2, $3, $4, $5)",
            [uuidv7(), id, account, direction, amount],
          );
      });
    const closed = { message: /^R5: ledger transaction [0-9a-f-]{36} is closed$/ };
    await expectSqlError(add([[clearing, "debit", 1]]), "23001", closed);
    await expectSqlError(
      add([
        [clearing, "debit", 5],
        [wallet, "credit", 5],
      ]),
      "23001",
      closed,
    );
    await expectSqlError(
      add([
        [usd, "debit", 9],
        [usd, "credit", 9],
      ]),
      "23001",
      closed,
    );
    // a created_at copied from the old transaction does not help: the database overwrites it
    await expectSqlError(
      inTransaction(t.pool, (c) =>
        c.query(
          `insert into ledger_entries (id, created_at, transaction_id, account_id, direction, amount_minor)
           select $1::uuid, t.created_at, t.id, $2::uuid, 'debit', 5 from ledger_transactions t where t.id = $3
           union all
           select $4::uuid, t.created_at, t.id, $5::uuid, 'credit', 5 from ledger_transactions t where t.id = $3`,
          [uuidv7(), clearing, id, uuidv7(), wallet],
        ),
      ),
      "23001",
      closed,
    );
    expect(
      (
        await t.pool.query(
          "select count(*)::int as n from ledger_entries where transaction_id = $1",
          [id],
        )
      ).rows[0].n,
    ).toBe(2);
  });
});

it("R5: a ledger account never changes and is never removed", async () => {
  const account = await newLedgerAccount(t.pool, "customer_wallet", await newCustomer(t.pool));
  const other = await newCustomer(t.pool);
  const fixed = { message: /^R5: ledger_accounts is append-only$/ };
  await expectSqlError(
    t.pool.query("update ledger_accounts set customer_id = $1 where id = $2", [other, account]),
    "23001",
    fixed,
  );
  await expectSqlError(
    t.pool.query("update ledger_accounts set currency = 'USD' where id = $1", [account]),
    "23001",
    fixed,
  );
  await expectSqlError(
    t.pool.query("update ledger_accounts set type = 'refunds', customer_id = null where id = $1", [
      account,
    ]),
    "23001",
    fixed,
  );
  await expectSqlError(
    t.pool.query("delete from ledger_accounts where id = $1", [account]),
    "23001",
    fixed,
  );
  await expectSqlError(t.pool.query("truncate ledger_accounts cascade"), "23001", {
    message: /^R5: .* is append-only$/,
  });
  const { rows } = await t.pool.query(
    "select customer_id is not null as owned, currency, type from ledger_accounts where id = $1",
    [account],
  );
  expect(rows[0]).toEqual({ owned: true, currency: "BDT", type: "customer_wallet" });
});

it("R5: the database stamps created_at of ledger rows with the start of the database transaction", async () => {
  const wallet = await newLedgerAccount(t.pool, "customer_wallet", await newCustomer(t.pool));
  const clearing = await systemAccount(t.pool, "gateway_clearing");
  const id = await inTransaction(t.pool, async (c) => {
    const txId = uuidv7();
    await c.query(
      "insert into ledger_transactions (id, created_at, kind, reference_type, reference_id, idempotency_key, actor_type) values ($1, '2000-01-01T00:00:00Z', 'test', 'test', $2, $3, 'system')",
      [txId, uuidv7(), "stamp:" + uniqueSuffix()],
    );
    await c.query(
      "insert into ledger_entries (id, created_at, transaction_id, account_id, direction, amount_minor) values ($1, '2000-01-01T00:00:00Z', $2, $3, 'debit', 10), ($4, '1999-01-01T00:00:00Z', $2, $5, 'credit', 10)",
      [uuidv7(), txId, clearing, uuidv7(), wallet],
    );
    return txId;
  });
  const { rows } = await t.pool.query(
    `select t.created_at > now() - interval '1 minute' as recent,
            (select count(*)::int from ledger_entries e where e.transaction_id = t.id and e.created_at = t.created_at) as same
       from ledger_transactions t where t.id = $1`,
    [id],
  );
  expect(rows[0]).toEqual({ recent: true, same: 2 });
});

it("R13: a trigger that runs later cannot flip the flag either", async () => {
  const resource_id = await newResource(t.pool, await newCustomer(t.pool));
  const flagged = await insertRow(t.pool, "operations", {
    resource_id,
    kind: "destroy",
    state: "failed", // with state needs_approval the CHECK of Task 6 would refuse the flip first
    needs_approval: true,
    idempotency_key: uniqueSuffix(),
  });
  await t.pool.query(
    "create function test_flip() returns trigger language plpgsql as $$ begin new.needs_approval := false; return new; end $$",
  );
  await t.pool.query(
    "create trigger z_flip before update on operations for each row execute function test_flip()",
  );
  try {
    await expectSqlError(
      t.pool.query("update operations set attempts = attempts + 1 where id = $1", [flagged]),
      "23001",
      { message: /^R13: operations\.needs_approval cannot change$/ },
    );
  } finally {
    await t.pool.query("drop trigger z_flip on operations");
    await t.pool.query("drop function test_flip()");
  }
  expect(
    (await t.pool.query("select needs_approval from operations where id = $1", [flagged])).rows[0]
      .needs_approval,
  ).toBe(true);
});
